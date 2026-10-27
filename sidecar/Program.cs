// omakase-cadkit sidecar: reads DWG/DXF with ACadSharp and writes a flat drawing payload.
//
//   omakase-cadkit-sidecar serve                 JSON lines on stdin/stdout (used by the Node service)
//   omakase-cadkit-sidecar open <in> <out.json>  one-shot payload, for debugging
//   omakase-cadkit-sidecar convert <in> <out>    DWG <-> DXF by output extension
//
// Requests:  {"id":1,"method":"open","params":{"path":"/a.dwg","out":"/cache/a.json"}}
//            {"id":2,"method":"convert","params":{"path":"/a.dxf","out":"/b.dwg"}}
//            {"id":3,"method":"ping"}
// Responses: {"id":1,"ok":true,"result":{...}} or {"id":1,"ok":false,"error":"..."}
//
// The payload is written to a file, not stdout, so a 20 MB drawing never crosses the pipe.

using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.IO;
using ACadSharp.Objects;
using ACadSharp.Tables;
using CSMath;

static class Program
{
	static int Main(string[] args)
	{
		if (args.Length >= 1 && args[0] == "serve") return Serve();
		if (args.Length == 3 && args[0] == "open")
		{
			Console.WriteLine(Ops.Open(args[1], args[2]).ToJsonString());
			return 0;
		}
		if (args.Length == 3 && args[0] == "convert")
		{
			Console.WriteLine(Ops.Convert(args[1], args[2]).ToJsonString());
			return 0;
		}
		Console.Error.WriteLine("usage: omakase-cadkit-sidecar serve | open <in> <out.json> | convert <in> <out.dwg|out.dxf>");
		return 2;
	}

	static int Serve()
	{
		var stdout = Console.OpenStandardOutput();
		var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
		string line;
		while ((line = reader.ReadLine()) != null)
		{
			if (line.Trim().Length == 0) continue;
			JsonNode id = null;
			JsonObject response;
			try
			{
				var req = JsonNode.Parse(line).AsObject();
				id = req["id"]?.DeepClone();
				var method = (string)req["method"];
				var p = req["params"] as JsonObject ?? new JsonObject();
				JsonObject result = method switch
				{
					"ping" => new JsonObject { ["pong"] = true, ["engine"] = "ACadSharp " + typeof(CadDocument).Assembly.GetName().Version },
					"open" => Ops.Open((string)p["path"], (string)p["out"]),
					"convert" => Ops.Convert((string)p["path"], (string)p["out"]),
					_ => throw new ArgumentException("unknown method: " + method),
				};
				response = new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = result };
			}
			catch (Exception ex)
			{
				response = new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = ex.GetType().Name + ": " + ex.Message };
			}
			var bytes = Encoding.UTF8.GetBytes(response.ToJsonString() + "\n");
			stdout.Write(bytes);
			stdout.Flush();
		}
		return 0;
	}
}

static class Ops
{
	public static CadDocument Read(string path, Dictionary<string, int> notes)
	{
		if (!File.Exists(path)) throw new FileNotFoundException("no file at " + path);
		NotificationEventHandler onNote = (s, e) =>
		{
			var msg = e.Message ?? "";
			var key = e.NotificationType + ": " + (msg.Length > 100 ? msg[..100] : msg);
			notes[key] = notes.GetValueOrDefault(key) + 1;
		};
		var ext = Path.GetExtension(path).ToLowerInvariant();
		if (ext == ".dxf")
		{
			using var r = new DxfReader(path, onNote);
			return r.Read();
		}
		if (ext == ".dwg")
		{
			using var r = new DwgReader(path, onNote);
			return r.Read();
		}
		throw new ArgumentException("not a .dwg or .dxf file: " + path);
	}

	// Two viewers, or a viewer and a test run, can write the same payload at once. A unique
	// sibling avoids two writers sharing one temp file, which Windows rejects outright.
	static string TempFor(string outPath) => outPath + "." + Guid.NewGuid().ToString("N") + ".tmp";

	static void TryDelete(string path)
	{
		try { if (File.Exists(path)) File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
	}

	public static JsonObject Open(string path, string outPath)
	{
		var sw = Stopwatch.StartNew();
		var notes = new Dictionary<string, int>();
		var doc = Read(path, notes);
		var readMs = sw.ElapsedMilliseconds;
		sw.Restart();
		Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath)));
		var tmp = TempFor(outPath);
		Payload.Stats stats;
		try
		{
			using (var fs = File.Create(tmp))
			using (var w = new Utf8JsonWriter(fs))
			{
				stats = new Payload(doc, w).Write(path, notes);
			}
			File.Move(tmp, outPath, true);
		}
		finally { TryDelete(tmp); }
		return new JsonObject
		{
			["path"] = path,
			["out"] = outPath,
			["acadVersion"] = doc.Header.Version.ToString(),
			["insUnits"] = doc.Header.InsUnits.ToString(),
			["entities"] = stats.Entities,
			["prims"] = stats.Prims,
			["layers"] = doc.Layers.Count,
			["unrendered"] = stats.UnrenderedTotal,
			["emitErrors"] = stats.EmitErrors,
			["readMs"] = readMs,
			["writeMs"] = sw.ElapsedMilliseconds,
			["payloadBytes"] = new FileInfo(outPath).Length,
		};
	}

	public static JsonObject Convert(string path, string outPath)
	{
		var sw = Stopwatch.StartNew();
		var notes = new Dictionary<string, int>();
		var doc = Read(path, notes);
		var ext = Path.GetExtension(outPath).ToLowerInvariant();
		var tmp = TempFor(outPath) + ext;
		try
		{
			if (ext == ".dxf") DxfWriter.Write(tmp, doc, false);
			else if (ext == ".dwg")
			{
				// DwgWriter cannot write AC1021 (R2007); R2018 is the widest-read target.
				if (doc.Header.Version < ACadVersion.AC1014 || doc.Header.Version == ACadVersion.AC1021)
					doc.Header.Version = ACadVersion.AC1032;
				DwgWriter.Write(tmp, doc);
			}
			else throw new ArgumentException("output must end in .dwg or .dxf");
			File.Move(tmp, outPath, true);
		}
		finally { TryDelete(tmp); }
		// Read back what was written: a converter that cannot reread its own output has failed.
		var back = Read(outPath, new Dictionary<string, int>());
		int before = doc.Entities.Count(), after = back.Entities.Count();
		if (before != after) throw new InvalidDataException($"round trip changed the entity count: {before} -> {after}");
		return new JsonObject
		{
			["path"] = path,
			["out"] = outPath,
			["entities"] = after,
			["acadVersion"] = back.Header.Version.ToString(),
			["ms"] = sw.ElapsedMilliseconds,
		};
	}
}

// 2D affine transform: x' = a x + c y + e, y' = b x + d y + f
readonly record struct Affine(double A, double B, double C, double D, double E, double F)
{
	public static readonly Affine Identity = new(1, 0, 0, 1, 0, 0);
	public (double, double) Apply(double x, double y) => (A * x + C * y + E, B * x + D * y + F);
	public (double, double) ApplyVec(double x, double y) => (A * x + C * y, B * x + D * y);
	// this ∘ o  (apply o first)
	public Affine Then(Affine o) => new(
		A * o.A + C * o.B, B * o.A + D * o.B,
		A * o.C + C * o.D, B * o.C + D * o.D,
		A * o.E + C * o.F + E, B * o.E + D * o.F + F);
	public static Affine Translate(double x, double y) => new(1, 0, 0, 1, x, y);
	public static Affine Scale(double sx, double sy) => new(sx, 0, 0, sy, 0, 0);
	public static Affine Rotate(double r) => new(Math.Cos(r), Math.Sin(r), -Math.Sin(r), Math.Cos(r), 0, 0);
	// Arbitrary-axis rule, planar case: an extrusion of -Z mirrors X.
	public static Affine Ocs(XYZ normal) => normal.Z < 0 ? Scale(-1, 1) : Identity;
}

sealed partial class Payload
{
	public sealed class Stats
	{
		public int Entities, Prims, EmitErrors, UnrenderedTotal;
	}

	readonly CadDocument _doc;
	readonly Utf8JsonWriter _w;
	readonly Dictionary<string, int> _layerIndex = new(StringComparer.OrdinalIgnoreCase);
	readonly List<int> _layerRgb = new();
	readonly Dictionary<string, int> _unrendered = new();
	// Drawn, but not as the file specifies: substitute faces for SHX fonts, gradients in one colour.
	readonly Dictionary<string, int> _approximated = new();
	readonly Stats _stats = new();
	readonly List<string> _emitErrorSamples = new();
	readonly List<Layer> _layers = new();
	// IMAGE placements in world space, top level and inside blocks, in draw order. src names an
	// embedded picture in _images (OLE objects); file-based images leave it null.
	readonly List<(int ent, string h, int layer, string file, double[] ins, double[] u, double[] v, double[] size, double fade, List<XY> clip, string src)> _rasters = new();
	// Embedded pictures as data URLs, keyed by content hash so repeated logos are stored once.
	readonly Dictionary<string, string> _images = new();
	// Linetype dash patterns in world units, shared by index from stroke primitives.
	readonly List<double[]> _dashes = new();
	readonly Dictionary<string, int> _dashIndex = new();

	// state for the top-level entity being emitted
	int _ent;
	double _minX, _minY, _maxX, _maxY;
	// render coordinates are written relative to this origin, at 1/1000 unit
	double _ox, _oy;
	double Px(double x) => Math.Round(x - _ox, 3);
	double Py(double y) => Math.Round(y - _oy, 3);
	int _depth;

	public Payload(CadDocument doc, Utf8JsonWriter w)
	{
		_doc = doc;
		_w = w;
	}

	static int Rgb(ReadOnlySpan<byte> c) => (c[0] << 16) | (c[1] << 8) | c[2];

	int LayerIdx(Layer l)
	{
		if (l == null) return 0;
		return _layerIndex.TryGetValue(l.Name, out var i) ? i : 0;
	}

	// Colour resolution: ByLayer -> the effective layer, ByBlock -> the insert's colour.
	int ResolveColor(Entity e, int layer, int blockRgb)
	{
		var c = e.Color;
		if (c.IsByLayer) return _layerRgb[layer];
		if (c.IsByBlock) return blockRgb;
		try { return Rgb(c.GetRgb()); } catch { return _layerRgb[layer]; }
	}

	// Entities on layer 0 inside a block take the insert's layer.
	int EffectiveLayer(Entity e, int inheritLayer)
	{
		var own = LayerIdx(e.Layer);
		return (inheritLayer >= 0 && e.Layer != null && e.Layer.Name == "0") ? inheritLayer : own;
	}

	public Stats Write(string path, Dictionary<string, int> notes)
	{
		var w = _w;
		var h = _doc.Header;
		w.WriteStartObject();
		w.WriteNumber("schema", 8);
		w.WriteStartObject("source");
		w.WriteString("path", path);
		w.WriteString("format", Path.GetExtension(path).TrimStart('.').ToLowerInvariant());
		w.WriteNumber("bytes", new FileInfo(path).Length);
		w.WriteEndObject();
		w.WriteString("acadVersion", h.Version.ToString());

		w.WriteStartObject("header");
		w.WriteString("insUnits", h.InsUnits.ToString());
		w.WriteNumber("insUnitsCode", (int)h.InsUnits);
		WritePt("extMin", h.ModelSpaceExtMin);
		WritePt("extMax", h.ModelSpaceExtMax);
		w.WriteNumber("ltScale", h.LineTypeScale);
		w.WriteEndObject();

		w.WriteStartArray("layers");
		var counts = _doc.Entities.GroupBy(e => e.Layer?.Name ?? "0").ToDictionary(g => g.Key, g => g.Count(), StringComparer.OrdinalIgnoreCase);
		foreach (var l in _doc.Layers)
		{
			_layerIndex[l.Name] = _layerRgb.Count;
			_layers.Add(l);
			int rgb;
			try { rgb = Rgb(l.Color.GetRgb()); } catch { rgb = 0xFFFFFF; }
			_layerRgb.Add(rgb);
			w.WriteStartObject();
			w.WriteString("name", l.Name);
			w.WriteNumber("color", rgb);
			w.WriteBoolean("on", l.IsOn);
			w.WriteBoolean("frozen", (l.Flags & LayerFlags.Frozen) != 0);
			w.WriteBoolean("locked", (l.Flags & LayerFlags.Locked) != 0);
			w.WriteBoolean("plot", l.PlotFlag && !l.Name.Equals("Defpoints", StringComparison.OrdinalIgnoreCase));
			w.WriteString("lineType", l.LineType?.Name ?? "");
			w.WriteNumber("entities", counts.GetValueOrDefault(l.Name));
			w.WriteEndObject();
		}
		w.WriteEndArray();

		w.WriteStartArray("blocks");
		foreach (var b in _doc.BlockRecords)
		{
			if (b.Name.StartsWith("*Model_Space", StringComparison.OrdinalIgnoreCase) || b.Name.StartsWith("*Paper_Space", StringComparison.OrdinalIgnoreCase)) continue;
			var flags = b.Flags;
			w.WriteStartObject();
			w.WriteString("name", b.Name);
			w.WriteBoolean("anonymous", (flags & ACadSharp.Blocks.BlockTypeFlags.Anonymous) != 0);
			w.WriteBoolean("xref", (flags & (ACadSharp.Blocks.BlockTypeFlags.XRef | ACadSharp.Blocks.BlockTypeFlags.XRefOverlay)) != 0);
			string xp = null;
			try { xp = b.BlockEntity?.XRefPath; } catch { }
			if (!string.IsNullOrEmpty(xp)) w.WriteString("xrefPath", xp);
			w.WriteNumber("entities", b.Entities.Count());
			w.WriteEndObject();
		}
		w.WriteEndArray();

		w.WriteStartArray("layouts");
		foreach (var lo in _doc.Layouts)
		{
			w.WriteStartObject();
			w.WriteString("name", lo.Name);
			int n = 0;
			try { n = lo.AssociatedBlock?.Entities.Count() ?? 0; } catch { }
			w.WriteNumber("entities", n);
			w.WriteEndObject();
		}
		w.WriteEndArray();

		// Semantic entity list and render primitives are written in two passes over model space
		// so both stay addressable by the same index.
		var ents = _doc.Entities.ToList();
		PrepareHatches(ents);
		var bboxes = new double[ents.Count][];

		var em = h.ModelSpaceExtMin;
		_ox = double.IsFinite(em.X) && Math.Abs(em.X) < 1e12 ? Math.Floor(em.X) : 0;
		_oy = double.IsFinite(em.Y) && Math.Abs(em.Y) < 1e12 ? Math.Floor(em.Y) : 0;
		w.WriteStartArray("origin");
		w.WriteNumberValue(_ox);
		w.WriteNumberValue(_oy);
		w.WriteEndArray();

		w.WriteStartArray("prims");
		for (int i = 0; i < ents.Count; i++)
		{
			_ent = i;
			_minX = _minY = double.PositiveInfinity;
			_maxX = _maxY = double.NegativeInfinity;
			var e = ents[i];
			int layer = LayerIdx(e.Layer);
			try
			{
				Emit(e, Affine.Identity, -1, ResolveColor(e, layer, _layerRgb[layer]), null);
			}
			catch (Exception ex)
			{
				_stats.EmitErrors++;
				if (_emitErrorSamples.Count < 10) _emitErrorSamples.Add(e.ObjectName + " " + e.Handle.ToString("X") + ": " + ex.Message);
			}
			if (_minX <= _maxX) bboxes[i] = new[] { _minX, _minY, _maxX, _maxY };
		}
		w.WriteEndArray();

		w.WriteStartArray("rasters");
		foreach (var r in _rasters)
		{
			w.WriteStartObject();
			w.WriteNumber("ent", r.ent);
			w.WriteString("h", r.h);
			w.WriteNumber("layer", r.layer);
			w.WriteString("file", r.file);
			Arr("ins", r.ins);
			Arr("u", r.u);
			Arr("v", r.v);
			Arr("size", r.size);
			w.WriteNumber("fade", R(r.fade));
			if (r.clip != null)
			{
				w.WriteStartArray("clip");
				foreach (var cp in r.clip) { w.WriteStartArray(); w.WriteNumberValue(R(cp.X)); w.WriteNumberValue(R(cp.Y)); w.WriteEndArray(); }
				w.WriteEndArray();
			}
			if (r.src != null) w.WriteString("src", r.src);
			w.WriteEndObject();
		}
		w.WriteEndArray();

		w.WriteStartObject("images");
		foreach (var kv in _images) w.WriteString(kv.Key, kv.Value);
		w.WriteEndObject();

		w.WriteStartArray("dashes");
		foreach (var d in _dashes)
		{
			w.WriteStartArray();
			foreach (var v in d) w.WriteNumberValue(v);
			w.WriteEndArray();
		}
		w.WriteEndArray();

		w.WriteStartArray("entities");
		for (int i = 0; i < ents.Count; i++) WriteEntity(ents[i], bboxes[i]);
		w.WriteEndArray();
		_stats.Entities = ents.Count;

		w.WriteStartObject("unrendered");
		foreach (var kv in _unrendered.OrderByDescending(k => k.Value)) w.WriteNumber(kv.Key, kv.Value);
		w.WriteEndObject();
		_stats.UnrenderedTotal = _unrendered.Values.Sum();

		w.WriteStartObject("approximated");
		foreach (var kv in _approximated.OrderByDescending(k => k.Value)) w.WriteNumber(kv.Key, kv.Value);
		w.WriteEndObject();

		w.WriteStartObject("notes");
		foreach (var kv in notes.OrderByDescending(k => k.Value).Take(40)) w.WriteNumber(kv.Key, kv.Value);
		w.WriteEndObject();
		w.WriteStartArray("emitErrors");
		foreach (var s in _emitErrorSamples) w.WriteStringValue(s);
		w.WriteEndArray();

		w.WriteEndObject();
		return _stats;
	}

	void WritePt(string name, XYZ p)
	{
		_w.WriteStartArray(name);
		_w.WriteNumberValue(R(p.X));
		_w.WriteNumberValue(R(p.Y));
		_w.WriteEndArray();
	}

	static double R(double v) => double.IsFinite(v) ? Math.Round(v, 4) : 0;

	// ---------------------------------------------------------------- semantic entities

	void WriteEntity(Entity e, double[] bb)
	{
		var w = _w;
		w.WriteStartObject();
		w.WriteString("h", e.Handle.ToString("X"));
		w.WriteString("type", e.ObjectName);
		w.WriteNumber("layer", LayerIdx(e.Layer));
		int layer = LayerIdx(e.Layer);
		w.WriteNumber("color", ResolveColor(e, layer, _layerRgb[layer]));
		if (bb != null)
		{
			w.WriteStartArray("bbox");
			foreach (var v in bb) w.WriteNumberValue(R(v));
			w.WriteEndArray();
		}
		try
		{
			switch (e)
			{
				case Line l:
					Arr("pts", l.StartPoint.X, l.StartPoint.Y, l.EndPoint.X, l.EndPoint.Y);
					w.WriteNumber("len", R(Math.Sqrt(Math.Pow(l.EndPoint.X - l.StartPoint.X, 2) + Math.Pow(l.EndPoint.Y - l.StartPoint.Y, 2))));
					break;
				case LwPolyline p:
					{
						var o = Affine.Ocs(p.Normal);
						var verts = new List<double>();
						foreach (var v in p.Vertices) { var (x, y) = o.Apply(v.Location.X, v.Location.Y); verts.Add(x); verts.Add(y); }
						Arr("verts", verts.ToArray());
						w.WriteBoolean("closed", p.IsClosed);
						w.WriteNumber("len", R(PolyLength(Tess(p.Vertices.Select(v => (v.Location.X, v.Location.Y, v.Bulge)).ToList(), p.IsClosed))));
						break;
					}
				case IPolyline p2:
					{
						var vs = p2.Vertices.Select(v => (X(v.Location), Y(v.Location), v.Bulge)).ToList();
						Arr("verts", vs.SelectMany(v => new[] { v.Item1, v.Item2 }).ToArray());
						w.WriteBoolean("closed", p2.IsClosed);
						w.WriteNumber("len", R(PolyLength(Tess(vs, p2.IsClosed))));
						break;
					}
				case Arc a:
					Arr("c", a.Center.X, a.Center.Y);
					w.WriteNumber("r", R(a.Radius));
					w.WriteNumber("a0", R(a.StartAngle * 180 / Math.PI));
					w.WriteNumber("a1", R(a.EndAngle * 180 / Math.PI));
					break;
				case Circle c:
					Arr("c", c.Center.X, c.Center.Y);
					w.WriteNumber("r", R(c.Radius));
					break;
				case TextEntity t:
					{
						var useAlign = t.HorizontalAlignment != TextHorizontalAlignment.Left || t.VerticalAlignment != TextVerticalAlignmentType.Baseline;
						var p = useAlign ? t.AlignmentPoint : t.InsertPoint;
						Arr("ins", p.X, p.Y);
						w.WriteString("text", t.Value ?? "");
						w.WriteNumber("height", R(t.Height));
						w.WriteNumber("rot", R(t.Rotation * 180 / Math.PI));
						w.WriteString("style", t.Style?.Name ?? "");
						if (t is AttributeEntity ae) w.WriteString("tag", ae.Tag ?? "");
						break;
					}
				case MText m:
					Arr("ins", m.InsertPoint.X, m.InsertPoint.Y);
					w.WriteString("text", SafePlain(m));
					w.WriteNumber("height", R(m.Height));
					w.WriteNumber("rot", R(Math.Atan2(m.AlignmentPoint.Y, m.AlignmentPoint.X) * 180 / Math.PI));
					w.WriteString("style", m.Style?.Name ?? "");
					break;
				case Insert ins:
					Arr("ins", ins.InsertPoint.X, ins.InsertPoint.Y);
					w.WriteString("block", ins.Block?.Name ?? "");
					w.WriteNumber("rot", R(ins.Rotation * 180 / Math.PI));
					w.WriteNumber("sx", R(ins.XScale));
					w.WriteNumber("sy", R(ins.YScale));
					if (ins.Attributes.Count > 0)
					{
						w.WriteStartArray("attrs");
						foreach (var at in ins.Attributes)
						{
							w.WriteStartObject();
							w.WriteString("tag", at.Tag ?? "");
							w.WriteString("value", at.Value ?? "");
							w.WriteEndObject();
						}
						w.WriteEndArray();
					}
					break;
				case Point pt:
					Arr("p", pt.Location.X, pt.Location.Y);
					break;
				case Hatch ht:
					w.WriteString("pattern", ht.Pattern?.Name ?? "");
					w.WriteBoolean("solid", ht.IsSolid);
					break;
				case RasterImage img:
					w.WriteString("file", img.Definition?.FileName ?? "");
					Arr("ins", img.InsertPoint.X, img.InsertPoint.Y);
					Arr("size", img.Size.X, img.Size.Y);
					Arr("u", img.UVector.X, img.UVector.Y);
					Arr("v", img.VVector.X, img.VVector.Y);
					w.WriteBoolean("show", img.ShowImage);
					w.WriteNumber("fade", R(img.Fade));
					if (img.ClippingState && img.ClipBoundaryVertices != null && img.ClipBoundaryVertices.Count > 0)
					{
						w.WriteStartArray("clip");
						foreach (var cp in img.ClipBoundaryVertices)
						{
							w.WriteStartArray();
							w.WriteNumberValue(R(cp.X));
							w.WriteNumberValue(R(cp.Y));
							w.WriteEndArray();
						}
						w.WriteEndArray();
					}
					break;
				case Dimension d:
					w.WriteString("text", d.Text ?? "");
					try { w.WriteNumber("measurement", R(d.Measurement)); } catch { }
					break;
			}
		}
		catch (Exception ex)
		{
			w.WriteString("propError", ex.Message);
		}
		w.WriteEndObject();
	}

	void Arr(string name, params double[] vals)
	{
		_w.WriteStartArray(name);
		foreach (var v in vals) _w.WriteNumberValue(R(v));
		_w.WriteEndArray();
	}

	static double X(IVector v) => v is XYZ a ? a.X : v is XY b ? b.X : v[0];
	static double Y(IVector v) => v is XYZ a ? a.Y : v is XY b ? b.Y : v[1];

	static string SafePlain(MText m) => MTextPlain(m.Value ?? "");

	// MTEXT inline codes reduced to plain text for query and lint; one space stays one space.
	// ACadSharp's PlainText leaves \W behind. Drawing goes through MTextRuns instead.
	static string MTextPlain(string s)
	{
		var sb = new StringBuilder(s.Length);
		string Arg(ref int i)
		{
			int end = s.IndexOf(';', i + 1);
			if (end < 0) end = s.Length;
			var a = s.Substring(i + 1, end - i - 1);
			i = end;
			return a;
		}
		for (int i = 0; i < s.Length; i++)
		{
			char c = s[i];
			if (c == '{' || c == '}') continue;
			if (c != '\\' || i + 1 >= s.Length) { sb.Append(c); continue; }
			char k = s[++i];
			switch (k)
			{
				case 'P': case 'X': sb.Append('\n'); break;
				case '~': sb.Append(' '); break;
				case '\\': case '{': case '}': sb.Append(k); break;
				case 'L': case 'l': case 'O': case 'o': case 'K': case 'k': case 'N': break;
				case 'S': sb.Append(Arg(ref i).Replace('^', '/').Replace('#', '/')); break;
				case 'A': case 'C': case 'c': case 'F': case 'f': case 'H': case 'Q': case 'T': case 'p': case 'W':
					Arg(ref i); break;
				case 'U' when i + 5 < s.Length && s[i + 1] == '+'
					&& int.TryParse(s.AsSpan(i + 2, 4), System.Globalization.NumberStyles.HexNumber, null, out var cp):
					sb.Append((char)cp); i += 5; break;
				default: sb.Append('\\').Append(k); break;
			}
		}
		return sb.ToString();
	}

	// ---------------------------------------------------------------- render primitives

	// Dash pattern of the stroke being written (index into _dashes), or -1 for continuous.
	int _lt = -1;
	// Hatch pattern lines, exploded once per hatch in its own coordinates (blocks repeat them).
	readonly Dictionary<Hatch, List<(double, double, double, double)>> _patterns = new();
	// Pattern lines left to draw in this drawing; past it, hatches fall back to a tint.
	int _patternBudget = 1_500_000;
	const int PatternLimit = 60_000;

	void Grow(double x, double y)
	{
		if (!double.IsFinite(x) || !double.IsFinite(y)) return;
		if (x < _minX) _minX = x;
		if (y < _minY) _minY = y;
		if (x > _maxX) _maxX = x;
		if (y > _maxY) _maxY = y;
	}

	void Unrendered(string type) => _unrendered[type] = _unrendered.GetValueOrDefault(type) + 1;
	void Approximated(string what) => _approximated[what] = _approximated.GetValueOrDefault(what) + 1;

	// SHX stroke fonts are AutoCAD's own; text in them is drawn in a TrueType stand-in.
	void NoteFont(ACadSharp.Tables.TextStyle st)
	{
		var file = st?.Filename ?? "";
		if (file.Length == 0) return;
		var ext = Path.GetExtension(file).ToLowerInvariant();
		if (ext == ".shx" || ext == "") Approximated("text in SHX font " + Path.GetFileName(file).ToLowerInvariant() + " (drawn in a substitute face)");
	}

	void PrimHead(string kind, int layer, int rgb)
	{
		_w.WriteStartArray();
		_w.WriteStringValue(kind);
		_w.WriteNumberValue(_ent);
		_w.WriteNumberValue(layer);
		_w.WriteNumberValue(rgb);
		_stats.Prims++;
	}

	// Strokes end with their dash pattern when they have one.
	void PrimTail()
	{
		if (_lt >= 0) _w.WriteNumberValue(_lt);
		_w.WriteEndArray();
	}

	void PrimPolyline(int layer, int rgb, bool closed, List<(double x, double y)> pts, Affine t)
	{
		if (pts.Count < 2) return;
		PrimHead("p", layer, rgb);
		_w.WriteNumberValue(closed ? 1 : 0);
		_w.WriteStartArray();
		foreach (var (x0, y0) in pts)
		{
			var (x, y) = t.Apply(x0, y0);
			Grow(x, y);
			_w.WriteNumberValue(Px(x));
			_w.WriteNumberValue(Py(y));
		}
		_w.WriteEndArray();
		PrimTail();
	}

	// Disjoint straight segments (hatch pattern lines): x0,y0,x1,y1 per segment.
	void PrimSegments(int layer, int rgb, List<(double, double, double, double)> segs, Affine t)
	{
		if (segs.Count == 0) return;
		PrimHead("l", layer, rgb);
		_w.WriteStartArray();
		foreach (var (ax, ay, bx, by) in segs)
		{
			var (x0, y0) = t.Apply(ax, ay);
			var (x1, y1) = t.Apply(bx, by);
			Grow(x0, y0);
			Grow(x1, y1);
			_w.WriteNumberValue(Px(x0));
			_w.WriteNumberValue(Py(y0));
			_w.WriteNumberValue(Px(x1));
			_w.WriteNumberValue(Py(y1));
		}
		_w.WriteEndArray();
		_w.WriteEndArray();
	}

	// Fill modes: 0 a pattern hatch that could not be drawn (shown as a tint), 1 solid with
	// even-odd islands, 2 solid union of overlapping pieces (nonzero, wide polylines), 3 an
	// area used only for picking (its pattern or picture is drawn by other primitives).
	void PrimFill(int layer, int rgb, int mode, List<List<(double x, double y)>> loops, Affine t)
	{
		loops = loops.Where(l => l.Count >= 3).ToList();
		if (loops.Count == 0) return;
		PrimHead("f", layer, rgb);
		_w.WriteNumberValue(mode);
		_w.WriteStartArray();
		foreach (var loop in loops)
		{
			_w.WriteStartArray();
			foreach (var (x0, y0) in loop)
			{
				var (x, y) = t.Apply(x0, y0);
				Grow(x, y);
				_w.WriteNumberValue(Px(x));
				_w.WriteNumberValue(Py(y));
			}
			_w.WriteEndArray();
		}
		_w.WriteEndArray();
		_w.WriteEndArray();
	}

	// align: horizontal l|c|r, vertical b|m|t (baseline is treated as bottom). width is the
	// laid-out advance in the text's own units (width factor included); the viewer fits the
	// drawn glyphs to it.
	void PrimText(int layer, int rgb, double x0, double y0, double height, double rot, string align, string text, Affine t, Face face, double wf, double width)
	{
		if (string.IsNullOrWhiteSpace(text) || !(height > 0)) return;
		var (x, y) = t.Apply(x0, y0);
		var (ux, uy) = t.ApplyVec(Math.Cos(rot), Math.Sin(rot));
		var (vx, vy) = t.ApplyVec(-Math.Sin(rot) * height, Math.Cos(rot) * height);
		var h = Math.Sqrt(vx * vx + vy * vy);
		var r = Math.Atan2(uy, ux);
		var along = Math.Sqrt(ux * ux + uy * uy);
		// a block scaled unevenly stretches its text like a width factor
		wf = (wf > 0 ? wf : 1) * along * height / h;
		if (!double.IsFinite(wf) || wf <= 0) wf = 1;
		var wdt = width * along;
		if (!double.IsFinite(wdt) || wdt <= 0) wdt = TextWidth(text, h, face) * wf;
		double ox = align[0] == 'c' ? -wdt / 2 : align[0] == 'r' ? -wdt : 0;
		double oy = align[1] == 'm' ? -h / 2 : align[1] == 't' ? -h : 0;
		double cs = Math.Cos(r), sn = Math.Sin(r);
		foreach (var (dx, dy) in new[] { (ox, oy), (ox + wdt, oy), (ox, oy + h), (ox + wdt, oy + h) })
			Grow(x + dx * cs - dy * sn, y + dx * sn + dy * cs);
		PrimHead("t", layer, rgb);
		_w.WriteNumberValue(Px(x));
		_w.WriteNumberValue(Py(y));
		_w.WriteNumberValue(Math.Round(h, 4));
		_w.WriteNumberValue(Math.Round(r, 5));
		_w.WriteStringValue(align);
		_w.WriteStringValue(text);
		_w.WriteStringValue(face.Code);
		_w.WriteNumberValue(Math.Round(wf, 4));
		_w.WriteNumberValue(Sig(wdt));
		_w.WriteEndArray();
	}

	static double Sig(double v) => v == 0 || !double.IsFinite(v) ? 0 : Math.Round(v, Math.Clamp(5 - (int)Math.Floor(Math.Log10(Math.Abs(v))), 0, 12));

	void PrimDot(int layer, int rgb, double x0, double y0, Affine t)
	{
		var (x, y) = t.Apply(x0, y0);
		Grow(x, y);
		PrimHead("d", layer, rgb);
		_w.WriteNumberValue(Px(x));
		_w.WriteNumberValue(Py(y));
		_w.WriteEndArray();
	}

	// A transform keeps circles circular when it is a rotation/uniform scale, possibly mirrored.
	static bool Similar(Affine t) =>
		Math.Abs(Math.Abs(t.A * t.D - t.B * t.C) - (t.A * t.A + t.B * t.B)) < 1e-9 * (1 + t.A * t.A + t.B * t.B)
		&& Math.Abs(t.A * t.A + t.B * t.B - (t.C * t.C + t.D * t.D)) < 1e-9 * (1 + t.A * t.A + t.B * t.B);

	// Circle (a0 == a1 == null) or counter-clockwise arc from a0 to a1, in world space.
	void PrimArc(int layer, int rgb, double cx, double cy, double r, double? a0, double? a1, Affine t)
	{
		if (!Similar(t))
		{
			var pts = a0 == null ? ArcPts(cx, cy, r, 0, 2 * Math.PI) : ArcPts(cx, cy, r, a0.Value, a1.Value);
			PrimPolyline(layer, rgb, a0 == null, pts, t);
			return;
		}
		var (wx, wy) = t.Apply(cx, cy);
		double det = t.A * t.D - t.B * t.C;
		double wr = r * Math.Sqrt(Math.Abs(det));
		if (a0 == null)
		{
			Grow(wx - wr, wy - wr);
			Grow(wx + wr, wy + wr);
			PrimHead("c", layer, rgb);
			_w.WriteNumberValue(Px(wx));
			_w.WriteNumberValue(Py(wy));
			_w.WriteNumberValue(Math.Round(wr, 4));
			PrimTail();
			return;
		}
		var (sx, sy) = t.Apply(cx + r * Math.Cos(a0.Value), cy + r * Math.Sin(a0.Value));
		var (ex, ey) = t.Apply(cx + r * Math.Cos(a1.Value), cy + r * Math.Sin(a1.Value));
		double s0 = Math.Atan2(sy - wy, sx - wx), s1 = Math.Atan2(ey - wy, ex - wx);
		if (det < 0) (s0, s1) = (s1, s0); // a mirror reverses the sweep
		foreach (var (px, py) in ArcPts(wx, wy, wr, s0, s1)) Grow(px, py);
		PrimHead("a", layer, rgb);
		_w.WriteNumberValue(Px(wx));
		_w.WriteNumberValue(Py(wy));
		_w.WriteNumberValue(Math.Round(wr, 4));
		_w.WriteNumberValue(Math.Round(s0, 5));
		_w.WriteNumberValue(Math.Round(s1, 5));
		PrimTail();
	}

	// Tessellate vertices with bulges into points; step is the largest angle per arc piece.
	static List<(double x, double y)> Tess(List<(double x, double y, double bulge)> v, bool closed, double step = Math.PI / 18)
	{
		var pts = new List<(double, double)>();
		int n = v.Count;
		if (n == 0) return pts;
		int segs = closed ? n : n - 1;
		pts.Add((v[0].x, v[0].y));
		for (int i = 0; i < segs; i++)
		{
			var a = v[i];
			var b = v[(i + 1) % n];
			if (Math.Abs(a.bulge) > 1e-9)
			{
				double dx = b.x - a.x, dy = b.y - a.y, c = Math.Sqrt(dx * dx + dy * dy);
				if (c > 0)
				{
					double theta = 4 * Math.Atan(a.bulge);
					double d = (c / 2) / Math.Tan(theta / 2);
					double mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
					double cx = mx - dy / c * d, cy = my + dx / c * d;
					double r = Math.Sqrt((a.x - cx) * (a.x - cx) + (a.y - cy) * (a.y - cy));
					double a0 = Math.Atan2(a.y - cy, a.x - cx);
					int k = Math.Clamp((int)Math.Ceiling(Math.Abs(theta) / step), 2, 128);
					for (int j = 1; j < k; j++)
					{
						double ang = a0 + theta * j / k;
						pts.Add((cx + r * Math.Cos(ang), cy + r * Math.Sin(ang)));
					}
				}
			}
			pts.Add((b.x, b.y));
		}
		return pts;
	}

	static double PolyLength(List<(double x, double y)> p)
	{
		double s = 0;
		for (int i = 1; i < p.Count; i++) s += Math.Sqrt(Math.Pow(p[i].x - p[i - 1].x, 2) + Math.Pow(p[i].y - p[i - 1].y, 2));
		return s;
	}

	static List<(double x, double y)> ArcPts(double cx, double cy, double r, double a0, double a1)
	{
		while (a1 <= a0) a1 += 2 * Math.PI;
		double sweep = a1 - a0;
		int k = Math.Clamp((int)Math.Ceiling(sweep / (Math.PI / 24)), 2, 96);
		var pts = new List<(double, double)>(k + 1);
		for (int j = 0; j <= k; j++)
		{
			double ang = a0 + sweep * j / k;
			pts.Add((cx + r * Math.Cos(ang), cy + r * Math.Sin(ang)));
		}
		return pts;
	}

	static List<(double x, double y)> Xy(IEnumerable<XYZ> pts) => pts.Select(p => (p.X, p.Y)).ToList();

	static List<(double x, double y)> Ccw(List<(double x, double y)> loop)
	{
		double a = 0;
		for (int i = 0, j = loop.Count - 1; i < loop.Count; j = i++) a += loop[j].x * loop[i].y - loop[i].x * loop[j].y;
		if (a < 0) loop.Reverse();
		return loop;
	}

	// ---------------------------------------------------------------- linetypes

	// The linetype an entity draws with: ByLayer takes its (effective) layer's, ByBlock the insert's.
	LineType ResolveLt(Entity e, int layer, LineType blockLt)
	{
		var lt = e.LineType;
		var name = lt?.Name ?? "ByLayer";
		if (name.Equals("ByLayer", StringComparison.OrdinalIgnoreCase)) return layer >= 0 && layer < _layers.Count ? _layers[layer].LineType : null;
		if (name.Equals("ByBlock", StringComparison.OrdinalIgnoreCase)) return blockLt;
		return lt;
	}

	/// <summary>
	/// Dash pattern of a stroke in world units: dash, gap, dash, gap ... starting with a dash; 0 is a
	/// dot. Shapes and text embedded in complex linetypes keep their spacing but are not drawn.
	/// Returns -1 for continuous lines.
	/// </summary>
	int DashFor(Entity e, int layer, LineType blockLt, Affine t)
	{
		var lt = ResolveLt(e, layer, blockLt);
		if (lt == null || lt.Segments == null || !lt.Segments.Any()) return -1;
		if (lt.Segments.Any(sg => sg.IsShape || sg.IsText))
			Approximated("complex linetype " + lt.Name + " (embedded text/shapes omitted)");
		double scale = (_doc.Header.LineTypeScale > 0 ? _doc.Header.LineTypeScale : 1)
			* (e.LineTypeScale > 0 ? e.LineTypeScale : 1)
			* Math.Sqrt(Math.Abs(t.A * t.D - t.B * t.C));
		if (!(scale > 0) || !double.IsFinite(scale)) return -1;
		var parts = new List<(bool on, double len)>();
		foreach (var sg in lt.Segments)
		{
			bool on = sg.Length >= 0;
			double len = Math.Abs(sg.Length) * scale;
			if (parts.Count > 0 && parts[^1].on == on) parts[^1] = (on, parts[^1].len + len);
			else parts.Add((on, len));
		}
		if (!parts.Any(p => !p.on && p.len > 0) || !parts.Any(p => p.on)) return -1;
		// canvas and SVG dash arrays start with a dash
		if (!parts[0].on) { parts.Add(parts[0]); parts.RemoveAt(0); }
		var merged = new List<(bool on, double len)>();
		foreach (var p in parts)
			if (merged.Count > 0 && merged[^1].on == p.on) merged[^1] = (p.on, merged[^1].len + p.len);
			else merged.Add(p);
		if (merged.Count % 2 == 1) { merged[0] = (true, merged[0].len + merged[^1].len); merged.RemoveAt(merged.Count - 1); }
		var dash = merged.Select(p => Sig(p.len)).ToArray();
		var key = string.Join(",", dash.Select(v => v.ToString("R", System.Globalization.CultureInfo.InvariantCulture)));
		if (!_dashIndex.TryGetValue(key, out var idx))
		{
			idx = _dashes.Count;
			_dashes.Add(dash);
			_dashIndex[key] = idx;
		}
		return idx;
	}

	// ---------------------------------------------------------------- entities

	int ColorOf(ACadSharp.Color c, int layer, int blockRgb)
	{
		if (c.IsByLayer) return _layerRgb[layer];
		if (c.IsByBlock) return blockRgb;
		try { return Rgb(c.GetRgb()); } catch { return blockRgb; }
	}

	// Emit primitives for one entity under transform t. inheritLayer: the insert's layer for
	// block content (-1 at top level); blockRgb and blockLt: the insert's colour and linetype
	// for ByBlock content.
	void Emit(Entity e, Affine t, int inheritLayer, int blockRgb, LineType blockLt)
	{
		if (_depth > 16) return; // runaway nesting guard
		int layer = EffectiveLayer(e, inheritLayer);
		int rgb = ResolveColor(e, layer, blockRgb);
		if (e.IsInvisible) return;

		switch (e)
		{
			case Line l:
				_lt = DashFor(e, layer, blockLt, t);
				PrimPolyline(layer, rgb, false, new() { (l.StartPoint.X, l.StartPoint.Y), (l.EndPoint.X, l.EndPoint.Y) }, t);
				break;
			case LwPolyline p:
				{
					var o = t.Then(Affine.Ocs(p.Normal));
					var v = p.Vertices.Select(x => (x.Location.X, x.Location.Y, x.Bulge,
						p.ConstantWidth > 0 ? p.ConstantWidth : x.StartWidth, p.ConstantWidth > 0 ? p.ConstantWidth : x.EndWidth)).ToList();
					if (EmitWide(layer, rgb, v, p.IsClosed, o)) break;
					_lt = DashFor(e, layer, blockLt, o);
					PrimPolyline(layer, rgb, p.IsClosed, Tess(v.Select(x => (x.Item1, x.Item2, x.Item3)).ToList(), p.IsClosed), o);
					break;
				}
			case IPolyline p2:
				{
					double w0 = 0, w1 = 0;
					if (p2 is Polyline2D pl) (w0, w1) = (pl.StartWidth, pl.EndWidth);
					var v = p2.Vertices.Select(x =>
					{
						var vx = x as Vertex;
						double sw = vx?.StartWidth ?? 0, ew = vx?.EndWidth ?? 0;
						if (sw == 0 && ew == 0) (sw, ew) = (w0, w1);
						return (X(x.Location), Y(x.Location), x.Bulge, sw, ew);
					}).ToList();
					if (EmitWide(layer, rgb, v, p2.IsClosed, t)) break;
					_lt = DashFor(e, layer, blockLt, t);
					PrimPolyline(layer, rgb, p2.IsClosed, Tess(v.Select(x => (x.Item1, x.Item2, x.Item3)).ToList(), p2.IsClosed), t);
					break;
				}
			case Arc a:
				_lt = DashFor(e, layer, blockLt, t);
				PrimArc(layer, rgb, a.Center.X, a.Center.Y, a.Radius, a.StartAngle, a.EndAngle, t.Then(Affine.Ocs(a.Normal)));
				break;
			case Circle c:
				_lt = DashFor(e, layer, blockLt, t);
				PrimArc(layer, rgb, c.Center.X, c.Center.Y, c.Radius, null, null, t.Then(Affine.Ocs(c.Normal)));
				break;
			case Ellipse el:
				_lt = DashFor(e, layer, blockLt, t);
				PrimPolyline(layer, rgb, false, Xy(el.PolygonalVertexes(72)), t);
				break;
			case Spline sp:
				_lt = DashFor(e, layer, blockLt, t);
				if (sp.TryPolygonalVertexes(64, out var spts)) PrimPolyline(layer, rgb, false, Xy(spts), t);
				else Unrendered("SPLINE");
				break;
			case Point pt:
				PrimDot(layer, rgb, pt.Location.X, pt.Location.Y, t);
				break;
			case Solid so:
				PrimFill(layer, rgb, 1, new() { new() { (so.FirstCorner.X, so.FirstCorner.Y), (so.SecondCorner.X, so.SecondCorner.Y), (so.FourthCorner.X, so.FourthCorner.Y), (so.ThirdCorner.X, so.ThirdCorner.Y) } }, t.Then(Affine.Ocs(so.Normal)));
				break;
			case Hatch ht:
				EmitHatch(ht, layer, rgb, t);
				break;
			case AttributeDefinition:
				break; // definitions are templates; the insert's attributes carry the values
			case TextEntity tx:
				EmitText(tx, layer, rgb, t);
				break;
			case MText m:
				EmitMText(m, layer, rgb, t);
				break;
			case Insert ins:
				EmitInsert(ins, t, layer, rgb, ResolveLt(ins, layer, blockLt));
				break;
			case Dimension d:
				if (d.Block != null)
				{
					_depth++;
					var dlt = ResolveLt(d, layer, blockLt);
					foreach (var be in d.Block.Entities) Emit(be, t, layer, rgb, dlt);
					_depth--;
				}
				else Unrendered("DIMENSION");
				break;
			case Leader ld:
				{
					var pts = Xy(ld.Vertices);
					PrimPolyline(layer, rgb, false, pts, t);
					if (ld.ArrowHeadEnabled && pts.Count >= 2)
					{
						var ds = ld.Style;
						double size = (ds?.ArrowSize > 0 ? ds.ArrowSize : 0.18) * (ds?.ScaleFactor > 0 ? ds.ScaleFactor : 1);
						EmitArrow(layer, rgb, pts[0], pts[1], size, ds?.LeaderArrow, t);
					}
					break;
				}
			case MultiLeader ml:
				EmitMLeader(ml, t, layer, rgb);
				break;
			case RasterImage img:
				{
					var o = img.InsertPoint;
					var u = img.UVector * img.Size.X;
					var v = img.VVector * img.Size.Y;
					PrimPolyline(layer, rgb, true, new() { (o.X, o.Y), (o.X + u.X, o.Y + u.Y), (o.X + u.X + v.X, o.Y + u.Y + v.Y), (o.X + v.X, o.Y + v.Y) }, t);
					var file = img.Definition?.FileName;
					if (img.ShowImage && !string.IsNullOrEmpty(file) && img.Size.X > 0 && img.Size.Y > 0)
					{
						var (wx, wy) = t.Apply(o.X, o.Y);
						var (ux, uy) = t.ApplyVec(img.UVector.X, img.UVector.Y);
						var (vx, vy) = t.ApplyVec(img.VVector.X, img.VVector.Y);
						var clip = img.ClippingState && img.ClipBoundaryVertices?.Count >= 2 ? img.ClipBoundaryVertices.ToList() : null;
						_rasters.Add((_ent, img.Handle.ToString("X"), layer, file, new[] { wx, wy }, new[] { ux, uy }, new[] { vx, vy }, new[] { img.Size.X, img.Size.Y }, img.Fade, clip, null));
					}
					break;
				}
			case Ole2Frame ole:
				EmitOle(ole, layer, rgb, t);
				break;
			default:
				Unrendered(e.ObjectName);
				break;
		}
		_lt = -1;
	}

	IEnumerable<(double, double)> EdgePoints(Entity ee) => ee switch
	{
		Line l => new[] { (l.StartPoint.X, l.StartPoint.Y), (l.EndPoint.X, l.EndPoint.Y) },
		Arc a => ArcPts(a.Center.X, a.Center.Y, a.Radius, a.StartAngle, a.EndAngle),
		Circle c => ArcPts(c.Center.X, c.Center.Y, c.Radius, 0, 2 * Math.PI),
		Ellipse el => Xy(el.PolygonalVertexes(48)),
		LwPolyline p => Tess(p.Vertices.Select(v => (v.Location.X, v.Location.Y, v.Bulge)).ToList(), p.IsClosed),
		IPolyline p2 => Tess(p2.Vertices.Select(v => (X(v.Location), Y(v.Location), v.Bulge)).ToList(), p2.IsClosed),
		Spline s => s.TryPolygonalVertexes(48, out var sp) ? Xy(sp) : Enumerable.Empty<(double, double)>(),
		_ => Enumerable.Empty<(double, double)>(),
	};

	/// <summary>
	/// A polyline with width is drawn as AutoCAD draws it: a filled band, not a centre line.
	/// Each piece is a quad with its start and end width; outer corners get a mitred wedge.
	/// All pieces wind the same way so a nonzero fill unions them without gaps.
	/// </summary>
	bool EmitWide(int layer, int rgb, List<(double x, double y, double bulge, double w0, double w1)> v, bool closed, Affine t)
	{
		int n = v.Count;
		if (n < 2 || !v.Any(p => p.w0 > 0 || p.w1 > 0)) return false;
		int segs = closed ? n : n - 1;
		var subs = new List<(double ax, double ay, double bx, double by, double wa, double wb)>();
		for (int i = 0; i < segs; i++)
		{
			var a = v[i];
			var b = v[(i + 1) % n];
			var p = Tess(new() { (a.x, a.y, a.bulge), (b.x, b.y, 0) }, false, Math.PI / 36);
			double total = PolyLength(p), acc = 0;
			for (int j = 0; j + 1 < p.Count; j++)
			{
				double sl = Math.Sqrt(Math.Pow(p[j + 1].x - p[j].x, 2) + Math.Pow(p[j + 1].y - p[j].y, 2));
				if (!(sl > 0)) continue;
				double fa = total > 0 ? acc / total : 0;
				acc += sl;
				double fb = total > 0 ? acc / total : 1;
				subs.Add((p[j].x, p[j].y, p[j + 1].x, p[j + 1].y, a.w0 + (a.w1 - a.w0) * fa, a.w0 + (a.w1 - a.w0) * fb));
			}
		}
		if (subs.Count == 0) return false;
		var loops = new List<List<(double x, double y)>>();
		foreach (var s in subs)
		{
			if (!(s.wa > 0) && !(s.wb > 0)) continue;
			double dx = s.bx - s.ax, dy = s.by - s.ay, len = Math.Sqrt(dx * dx + dy * dy);
			double nx = -dy / len, ny = dx / len;
			loops.Add(Ccw(new()
			{
				(s.ax + nx * s.wa / 2, s.ay + ny * s.wa / 2), (s.bx + nx * s.wb / 2, s.by + ny * s.wb / 2),
				(s.bx - nx * s.wb / 2, s.by - ny * s.wb / 2), (s.ax - nx * s.wa / 2, s.ay - ny * s.wa / 2),
			}));
		}
		int joints = closed ? subs.Count : subs.Count - 1;
		for (int k = 0; k < joints; k++)
		{
			var A = subs[k];
			var B = subs[(k + 1) % subs.Count];
			double wA = A.wb, wB = B.wa;
			if (!(wA > 0) && !(wB > 0)) continue;
			if (Math.Abs(A.bx - B.ax) + Math.Abs(A.by - B.ay) > 1e-9 * (1 + Math.Abs(A.bx) + Math.Abs(A.by))) continue;
			double lA = Math.Sqrt(Math.Pow(A.bx - A.ax, 2) + Math.Pow(A.by - A.ay, 2)), lB = Math.Sqrt(Math.Pow(B.bx - B.ax, 2) + Math.Pow(B.by - B.ay, 2));
			double dax = (A.bx - A.ax) / lA, day = (A.by - A.ay) / lA, dbx = (B.bx - B.ax) / lB, dby = (B.by - B.ay) / lB;
			double cross = dax * dby - day * dbx;
			if (Math.Abs(cross) < 1e-9) continue;
			double side = cross > 0 ? -1 : 1; // the outer side of the turn
			double px = A.bx, py = A.by;
			var pa = (x: px - side * day * wA / 2, y: py + side * dax * wA / 2);
			var pb = (x: px - side * dby * wB / 2, y: py + side * dbx * wB / 2);
			double s = ((pb.x - pa.x) * dby - (pb.y - pa.y) * dbx) / cross;
			var m = (x: pa.x + s * dax, y: pa.y + s * day);
			bool miter = Math.Abs(wA - wB) < 1e-9 * (1 + wA) && Math.Sqrt(Math.Pow(m.x - px, 2) + Math.Pow(m.y - py, 2)) <= 2 * wA;
			loops.Add(Ccw(miter ? new() { (px, py), pa, m, pb } : new() { (px, py), pa, pb }));
		}
		PrimFill(layer, rgb, 2, loops, t);
		return true;
	}

	void EmitHatch(Hatch ht, int layer, int rgb, Affine t)
	{
		var loops = new List<List<(double, double)>>();
		foreach (var path in ht.Paths)
		{
			// Text-box paths are annotation metadata, not geometric fill
			// boundaries. In particular they must not cut through a frame.
			if ((path.Flags & (BoundaryPathFlags.Textbox | BoundaryPathFlags.TextIsland)) != 0) continue;
			var loop = new List<(double, double)>();
			foreach (var edge in path.Edges)
			{
				Entity ee;
				try { ee = edge.ToEntity(); } catch { continue; }
				loop.AddRange(EdgePoints(ee));
			}
			if (loop.Count < 3) continue;
			loops.Add(loop);
		}
		var o = t.Then(Affine.Ocs(ht.Normal));
		bool gradient = ht.GradientColor?.Enabled == true;
		if (ht.IsSolid || gradient)
		{
			PrimFill(layer, rgb, 1, loops, o);
			if (gradient) Approximated("HATCH gradient (drawn in one colour)");
			return;
		}
		var segs = PatternLines(ht);
		if (segs == null)
		{
			PrimFill(layer, rgb, 0, loops, o);
			Unrendered("HATCH pattern (too dense, drawn as a tint)");
			return;
		}
		PrimFill(layer, rgb, 3, loops, o);
		PrimSegments(layer, rgb, segs, o);
	}

	/// <summary>
	/// Pattern lines clipped to the hatch boundary, with each pattern line's dashes applied.
	/// Null when the pattern is too dense to draw line by line.
	/// </summary>
	List<(double, double, double, double)> PatternLines(Hatch ht)
	{
		if (_patterns.TryGetValue(ht, out var cached)) return cached;
		List<(double, double, double, double)> result = null;
		try
		{
			var lines = ht.Pattern?.Lines;
			if (lines != null && lines.Count > 0)
			{
				var bb = ht.GetBoundingBox();
				double diag = Math.Sqrt(Math.Pow(bb.Max.X - bb.Min.X, 2) + Math.Pow(bb.Max.Y - bb.Min.Y, 2));
				double estimate = 0;
				foreach (var pl in lines)
				{
					double perp = Math.Abs(-Math.Sin(pl.Angle) * pl.Offset.X + Math.Cos(pl.Angle) * pl.Offset.Y);
					estimate += perp > 0 ? diag / perp : double.PositiveInfinity;
				}
				if (estimate <= PatternLimit && estimate <= _patternBudget)
				{
					if (lines.All(l => l.DashLengths == null || l.DashLengths.Count == 0))
					{
						result = PreparedPattern(ht);
						if (result?.Count > _patternBudget) result = null;
					}
					else
					{
						result = new();
						foreach (var seg in ht.ExplodePattern())
						{
							if (seg is not Line l) continue;
							Dash(result, l.StartPoint.X, l.StartPoint.Y, l.EndPoint.X, l.EndPoint.Y, lines);
							if (result.Count > PatternLimit || result.Count > _patternBudget) { result = null; break; }
						}
					}
					if (result != null) _patternBudget -= result.Count;
				}
			}
		}
		catch { result = null; }
		_patterns[ht] = result;
		return result;
	}

	// Splits one pattern line into its dashes. Rows of a family repeat at Offset from BasePoint,
	// so a point's phase along the family is its distance from the row's own base point.
	static void Dash(List<(double, double, double, double)> into, double ax, double ay, double bx, double by, List<HatchPattern.Line> family)
	{
		double ang = Math.Atan2(by - ay, bx - ax);
		HatchPattern.Line pl = null;
		bool reversed = false;
		foreach (var f in family)
		{
			double d = Math.IEEERemainder(ang - f.Angle, 2 * Math.PI);
			if (Math.Abs(d) < 1e-6) { pl = f; break; }
			if (Math.Abs(Math.Abs(d) - Math.PI) < 1e-6) { pl = f; reversed = true; break; }
		}
		if (pl == null || pl.DashLengths == null || pl.DashLengths.Count == 0) { into.Add((ax, ay, bx, by)); return; }
		if (reversed) (ax, ay, bx, by) = (bx, by, ax, ay);
		double ux = Math.Cos(pl.Angle), uy = Math.Sin(pl.Angle), nx = -uy, ny = ux;
		double period = pl.DashLengths.Sum(Math.Abs);
		if (!(period > 0)) { into.Add((ax, ay, bx, by)); return; }
		double rowStep = pl.Offset.X * nx + pl.Offset.Y * ny;
		double row = Math.Abs(rowStep) > 0 ? Math.Round(((ax - pl.BasePoint.X) * nx + (ay - pl.BasePoint.Y) * ny) / rowStep) : 0;
		double baseX = pl.BasePoint.X + row * pl.Offset.X, baseY = pl.BasePoint.Y + row * pl.Offset.Y;
		double t0 = (ax - baseX) * ux + (ay - baseY) * uy, t1 = (bx - baseX) * ux + (by - baseY) * uy;
		double start = Math.Floor(t0 / period) * period;
		for (double p = start; p < t1; p += period)
		{
			if (into.Count > PatternLimit) return;
			double at = p;
			foreach (var dl in pl.DashLengths)
			{
				double len = Math.Abs(dl);
				if (dl >= 0)
				{
					double s = Math.Max(at, t0), e = Math.Min(at + len, t1);
					if (dl == 0 && at >= t0 && at <= t1) { s = at; e = at + period * 1e-3; }
					if (e > s) into.Add((baseX + ux * s, baseY + uy * s, baseX + ux * e, baseY + uy * e));
				}
				at += len;
			}
		}
	}

	/// <summary>
	/// An arrowhead with its tip at tip, pointing away from from. A named arrow block is placed
	/// like AutoCAD's: its +X axis along the arrow, scaled by size. Otherwise a closed filled arrow.
	/// </summary>
	void EmitArrow(int layer, int rgb, (double x, double y) tip, (double x, double y) from, double size, BlockRecord block, Affine t)
	{
		double dx = tip.x - from.x, dy = tip.y - from.y, len = Math.Sqrt(dx * dx + dy * dy);
		if (!(len > 0) || !(size > 0)) return;
		double ux = dx / len, uy = dy / len;
		if (block != null)
		{
			if (block.Name.Equals("_None", StringComparison.OrdinalIgnoreCase)) return;
			if (block.Entities.Any())
			{
				var bp = block.BlockEntity?.BasePoint ?? XYZ.Zero;
				var local = Affine.Translate(tip.x, tip.y).Then(Affine.Rotate(Math.Atan2(uy, ux))).Then(Affine.Scale(size, size)).Then(Affine.Translate(-bp.X, -bp.Y));
				_depth++;
				foreach (var be in block.Entities) Emit(be, t.Then(local), layer, rgb, null);
				_depth--;
				return;
			}
		}
		double tx = tip.x - ux * size, ty = tip.y - uy * size, hw = size / 6;
		PrimFill(layer, rgb, 1, new() { new() { tip, (tx - uy * hw, ty + ux * hw), (tx + uy * hw, ty - ux * hw) } }, t);
	}

	void EmitMLeader(MultiLeader m, Affine t, int layer, int rgb)
	{
		var c = m.ContextData;
		if (c == null) { Unrendered("MULTILEADER (no content data)"); return; }
		int lineRgb = ColorOf(m.LineColor, layer, rgb);
		bool lines = m.PathType != MultiLeaderPathType.Invisible;
		foreach (var root in c.LeaderRoots ?? (IList<MultiLeaderObjectContextData.LeaderRoot>)Array.Empty<MultiLeaderObjectContextData.LeaderRoot>())
		{
			var conn = (root.ConnectionPoint.X, root.ConnectionPoint.Y);
			foreach (var ln in root.Lines ?? (IList<MultiLeaderObjectContextData.LeaderLine>)Array.Empty<MultiLeaderObjectContextData.LeaderLine>())
			{
				var pts = (ln.Points ?? (IList<XYZ>)Array.Empty<XYZ>()).Select(p => (p.X, p.Y)).ToList();
				pts.Add(conn);
				if (lines) PrimPolyline(layer, lineRgb, false, pts, t);
				var size = ln.ArrowheadSize > 0 ? ln.ArrowheadSize : c.ArrowheadSize;
				if (lines && pts.Count >= 2) EmitArrow(layer, lineRgb, pts[0], pts[1], size, ln.Arrowhead ?? m.Arrowhead, t);
			}
			if (lines && m.EnableLanding && m.EnableDogleg && root.LandingDistance > 0)
				PrimPolyline(layer, lineRgb, false, new() { conn, (conn.X + root.Direction.X * root.LandingDistance, conn.Y + root.Direction.Y * root.LandingDistance) }, t);
		}
		if (c.HasTextContents && !string.IsNullOrWhiteSpace(c.TextLabel) && c.TextHeight > 0)
		{
			var mt = new MText
			{
				Value = c.TextLabel,
				InsertPoint = c.TextLocation,
				Height = c.TextHeight,
				RectangleWidth = c.BoundaryWidth,
				// MLEADER text hangs from its location; the attachment picks the side it aligns to
				AttachmentPoint = c.TextAttachmentPoint switch { TextAttachmentPointType.Center => AttachmentPointType.TopCenter, TextAttachmentPointType.Right => AttachmentPointType.TopRight, _ => AttachmentPointType.TopLeft },
				AlignmentPoint = c.Direction,
				Style = c.TextStyle ?? m.TextStyle,
				LineSpacing = c.LineSpacingFactor > 0 ? c.LineSpacingFactor : 1,
			};
			int textRgb = ColorOf(c.TextColor, layer, rgb);
			var ext = EmitMText(mt, layer, textRgb, t);
			if (m.TextFrame && ext is var (x0, y0, x1, y1))
			{
				double g = c.LandingGap, a = Math.Atan2(c.Direction.Y, c.Direction.X), cs = Math.Cos(a), sn = Math.Sin(a);
				var ins = c.TextLocation;
				(double, double) At(double x, double y) => (ins.X + x * cs - y * sn, ins.Y + x * sn + y * cs);
				PrimPolyline(layer, lineRgb, true, new() { At(x0 - g, y0 - g), At(x1 + g, y0 - g), At(x1 + g, y1 + g), At(x0 - g, y1 + g) }, t);
			}
		}
		if (c.HasContentsBlock && c.BlockContent != null)
		{
			var b = c.BlockContent;
			var bp = b.BlockEntity?.BasePoint ?? XYZ.Zero;
			var s = c.BlockContentScale;
			var local = Affine.Translate(c.BlockContentLocation.X, c.BlockContentLocation.Y)
				.Then(Affine.Rotate(c.BlockContentRotation))
				.Then(Affine.Scale(s.X != 0 ? s.X : 1, s.Y != 0 ? s.Y : 1))
				.Then(Affine.Translate(-bp.X, -bp.Y));
			int blockRgb = ColorOf(c.BlockContentColor, layer, rgb);
			_depth++;
			foreach (var be in b.Entities) Emit(be, t.Then(local), layer, blockRgb, null);
			_depth--;
		}
	}

	void EmitInsert(Insert ins, Affine t, int layer, int rgb, LineType lt)
	{
		if (ins.Block == null) { Unrendered("INSERT (no block)"); return; }
		var bp = ins.Block.BlockEntity?.BasePoint ?? XYZ.Zero;
		int cols = Math.Max(1, (int)ins.ColumnCount), rows = Math.Max(1, (int)ins.RowCount);
		_depth++;
		for (int r = 0; r < rows; r++)
			for (int c = 0; c < cols; c++)
			{
				var local = Affine.Ocs(ins.Normal)
					.Then(Affine.Translate(ins.InsertPoint.X, ins.InsertPoint.Y))
					.Then(Affine.Rotate(ins.Rotation))
					.Then(Affine.Translate(c * ins.ColumnSpacing, r * ins.RowSpacing))
					.Then(Affine.Scale(ins.XScale, ins.YScale))
					.Then(Affine.Translate(-bp.X, -bp.Y));
				var tt = t.Then(local);
				foreach (var be in ins.Block.Entities) Emit(be, tt, layer, rgb, lt);
			}
		_depth--;
		// Attributes are already in world (or parent-block) coordinates.
		foreach (var at in ins.Attributes) Emit(at, t, layer, rgb, lt);
	}
}
