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

	public static JsonObject Open(string path, string outPath)
	{
		var sw = Stopwatch.StartNew();
		var notes = new Dictionary<string, int>();
		var doc = Read(path, notes);
		var readMs = sw.ElapsedMilliseconds;
		sw.Restart();
		Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath)));
		var tmp = outPath + ".tmp";
		Payload.Stats stats;
		using (var fs = File.Create(tmp))
		using (var w = new Utf8JsonWriter(fs))
		{
			stats = new Payload(doc, w).Write(path, notes);
		}
		File.Move(tmp, outPath, true);
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
		var tmp = outPath + ".tmp" + ext;
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

sealed class Payload
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
	readonly Stats _stats = new();
	readonly List<string> _emitErrorSamples = new();
	// IMAGE placements in world space, top level and inside blocks, in draw order
	readonly List<(int ent, string h, int layer, string file, double[] ins, double[] u, double[] v, double[] size, double fade, List<XY> clip)> _rasters = new();

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
		w.WriteNumber("schema", 6);
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
				Emit(e, Affine.Identity, -1, ResolveColor(e, layer, _layerRgb[layer]));
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
			w.WriteEndObject();
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

	static string SafePlain(MText m)
	{
		try { return m.PlainText ?? ""; } catch { return m.Value ?? ""; }
	}

	// ---------------------------------------------------------------- render primitives

	void Grow(double x, double y)
	{
		if (!double.IsFinite(x) || !double.IsFinite(y)) return;
		if (x < _minX) _minX = x;
		if (y < _minY) _minY = y;
		if (x > _maxX) _maxX = x;
		if (y > _maxY) _maxY = y;
	}

	void Unrendered(string type) => _unrendered[type] = _unrendered.GetValueOrDefault(type) + 1;

	void PrimHead(string kind, int layer, int rgb)
	{
		_w.WriteStartArray();
		_w.WriteStringValue(kind);
		_w.WriteNumberValue(_ent);
		_w.WriteNumberValue(layer);
		_w.WriteNumberValue(rgb);
		_stats.Prims++;
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
		_w.WriteEndArray();
	}

	void PrimFill(int layer, int rgb, bool solid, List<List<(double x, double y)>> loops, Affine t)
	{
		loops = loops.Where(l => l.Count >= 3).ToList();
		if (loops.Count == 0) return;
		PrimHead("f", layer, rgb);
		_w.WriteNumberValue(solid ? 1 : 0);
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

	// align: horizontal l|c|r, vertical b|m|t (baseline is treated as bottom)
	void PrimText(int layer, int rgb, double x0, double y0, double height, double rot, string align, string text, Affine t)
	{
		if (string.IsNullOrWhiteSpace(text) || !(height > 0)) return;
		var (x, y) = t.Apply(x0, y0);
		var (ux, uy) = t.ApplyVec(Math.Cos(rot), Math.Sin(rot));
		var (vx, vy) = t.ApplyVec(-Math.Sin(rot) * height, Math.Cos(rot) * height);
		var h = Math.Sqrt(vx * vx + vy * vy);
		var r = Math.Atan2(uy, ux);
		// approximate extents for the bbox and hit testing: 0.6 h per character
		var wdt = 0.6 * h * text.Length;
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
		_w.WriteEndArray();
	}

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
			_w.WriteEndArray();
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
		_w.WriteEndArray();
	}

	// Tessellate vertices with bulges into points.
	static List<(double x, double y)> Tess(List<(double x, double y, double bulge)> v, bool closed)
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
					int k = Math.Clamp((int)Math.Ceiling(Math.Abs(theta) / (Math.PI / 18)), 2, 64);
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

	// Emit primitives for one entity under transform t.
	// inheritLayer: the insert's layer for block content (-1 at top level); blockRgb: ByBlock colour.
	void Emit(Entity e, Affine t, int inheritLayer, int blockRgb)
	{
		if (_depth > 16) return; // runaway nesting guard
		int layer = EffectiveLayer(e, inheritLayer);
		int rgb = ResolveColor(e, layer, blockRgb);
		if (e.IsInvisible) return;

		switch (e)
		{
			case Line l:
				PrimPolyline(layer, rgb, false, new() { (l.StartPoint.X, l.StartPoint.Y), (l.EndPoint.X, l.EndPoint.Y) }, t);
				break;
			case LwPolyline p:
				PrimPolyline(layer, rgb, p.IsClosed, Tess(p.Vertices.Select(v => (v.Location.X, v.Location.Y, v.Bulge)).ToList(), p.IsClosed), t.Then(Affine.Ocs(p.Normal)));
				break;
			case IPolyline p2:
				PrimPolyline(layer, rgb, p2.IsClosed, Tess(p2.Vertices.Select(v => (X(v.Location), Y(v.Location), v.Bulge)).ToList(), p2.IsClosed), t);
				break;
			case Arc a:
				PrimArc(layer, rgb, a.Center.X, a.Center.Y, a.Radius, a.StartAngle, a.EndAngle, t.Then(Affine.Ocs(a.Normal)));
				break;
			case Circle c:
				PrimArc(layer, rgb, c.Center.X, c.Center.Y, c.Radius, null, null, t.Then(Affine.Ocs(c.Normal)));
				break;
			case Ellipse el:
				PrimPolyline(layer, rgb, false, Xy(el.PolygonalVertexes(72)), t);
				break;
			case Spline sp:
				if (sp.TryPolygonalVertexes(64, out var spts)) PrimPolyline(layer, rgb, false, Xy(spts), t);
				else Unrendered("SPLINE");
				break;
			case Point pt:
				PrimDot(layer, rgb, pt.Location.X, pt.Location.Y, t);
				break;
			case Solid so:
				PrimFill(layer, rgb, true, new() { new() { (so.FirstCorner.X, so.FirstCorner.Y), (so.SecondCorner.X, so.SecondCorner.Y), (so.FourthCorner.X, so.FourthCorner.Y), (so.ThirdCorner.X, so.ThirdCorner.Y) } }, t.Then(Affine.Ocs(so.Normal)));
				break;
			case Hatch ht:
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
					PrimFill(layer, rgb, ht.IsSolid, loops, t.Then(Affine.Ocs(ht.Normal)));
					break;
				}
			case AttributeDefinition:
				break; // definitions are templates; the insert's attributes carry the values
			case TextEntity tx:
				{
					var useAlign = tx.HorizontalAlignment != TextHorizontalAlignment.Left || tx.VerticalAlignment != TextVerticalAlignmentType.Baseline;
					var p = useAlign ? tx.AlignmentPoint : tx.InsertPoint;
					char ha = tx.HorizontalAlignment switch
					{
						TextHorizontalAlignment.Center or TextHorizontalAlignment.Middle or TextHorizontalAlignment.Aligned or TextHorizontalAlignment.Fit => 'c',
						TextHorizontalAlignment.Right => 'r',
						_ => 'l',
					};
					if (tx.HorizontalAlignment == TextHorizontalAlignment.Middle) { PrimText(layer, rgb, p.X, p.Y, tx.Height, tx.Rotation, "cm", tx.Value, t.Then(Affine.Ocs(tx.Normal))); break; }
					char va = tx.VerticalAlignment switch
					{
						TextVerticalAlignmentType.Middle => 'm',
						TextVerticalAlignmentType.Top => 't',
						_ => 'b',
					};
					PrimText(layer, rgb, p.X, p.Y, tx.Height, tx.Rotation, $"{ha}{va}", tx.Value, t.Then(Affine.Ocs(tx.Normal)));
					break;
				}
			case MText m:
				EmitMText(m, layer, rgb, t);
				break;
			case Insert ins:
				EmitInsert(ins, t, layer, rgb);
				break;
			case Dimension d:
				if (d.Block != null)
				{
					_depth++;
					foreach (var be in d.Block.Entities) Emit(be, t, layer, rgb);
					_depth--;
				}
				else Unrendered("DIMENSION");
				break;
			case Leader ld:
				PrimPolyline(layer, rgb, false, Xy(ld.Vertices), t);
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
						_rasters.Add((_ent, img.Handle.ToString("X"), layer, file, new[] { wx, wy }, new[] { ux, uy }, new[] { vx, vy }, new[] { img.Size.X, img.Size.Y }, img.Fade, clip));
					}
					break;
				}
			case Ole2Frame ole:
				{
					var a = ole.UpperLeftCorner;
					var b = ole.LowerRightCorner;
					PrimPolyline(layer, rgb, true, new() { (a.X, a.Y), (b.X, a.Y), (b.X, b.Y), (a.X, b.Y) }, t);
					Unrendered("OLE2FRAME (frame only)");
					break;
				}
			default:
				Unrendered(e.ObjectName);
				break;
		}
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

	void EmitMText(MText m, int layer, int rgb, Affine t)
	{
		var text = SafePlain(m);
		if (string.IsNullOrWhiteSpace(text)) return;
		var lines = text.Replace("\r\n", "\n").Split('\n');
		double h = m.Height;
		double rot = Math.Atan2(m.AlignmentPoint.Y, m.AlignmentPoint.X);
		double step = h * 1.6667 * (m.LineSpacing > 0 ? m.LineSpacing : 1);
		var ap = m.AttachmentPoint.ToString(); // TopLeft, MiddleCenter, BottomRight, ...
		char ha = ap.EndsWith("Center") ? 'c' : ap.EndsWith("Right") ? 'r' : 'l';
		double total = step * (lines.Length - 1);
		// offset of the first line's top from the insert point, along the text's up axis
		double firstTop = ap.StartsWith("Top") ? 0 : ap.StartsWith("Middle") ? (total + h) / 2 : total + h;
		var o = t.Then(Affine.Ocs(m.Normal));
		for (int i = 0; i < lines.Length; i++)
		{
			double up = firstTop - i * step; // distance of this line's top above the insert point
			double ox = -Math.Sin(rot) * up, oy = Math.Cos(rot) * up;
			PrimText(layer, rgb, m.InsertPoint.X + ox, m.InsertPoint.Y + oy, h, rot, ha + "t", lines[i], o);
		}
	}

	void EmitInsert(Insert ins, Affine t, int layer, int rgb)
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
				foreach (var be in ins.Block.Entities) Emit(be, tt, layer, rgb);
			}
		_depth--;
		// Attributes are already in world (or parent-block) coordinates.
		foreach (var at in ins.Attributes) Emit(at, t, layer, rgb);
	}
}
