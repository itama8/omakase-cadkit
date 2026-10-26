// OLE objects (OLE2FRAME): embedded Excel tables, logos and pictures.
//
// AutoCAD draws an OLE object from the picture its server cached in the object: an Enhanced
// Metafile (EMF), sometimes wrapped inside a Windows Metafile, or a device-independent bitmap.
// The picture is played here into ordinary primitives in the OLE frame: table rules and fills
// become lines and fills, cell text becomes text fitted to the widths the server laid out,
// and bitmaps become embedded images. Nothing outside the drawing file is needed.

using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using ACadSharp.Entities;

sealed partial class Payload
{
	void EmitOle(Ole2Frame ole, int layer, int rgb, Affine t)
	{
		var a = ole.UpperLeftCorner;
		var b = ole.LowerRightCorner;
		var frame = new List<(double x, double y)> { (a.X, a.Y), (b.X, a.Y), (b.X, b.Y), (a.X, b.Y) };
		OlePicture pic = null;
		string why;
		try { pic = OlePicture.From(ole.BinaryData, out why); }
		catch (Exception ex) { why = "unreadable: " + ex.GetType().Name; }
		if (pic == null)
		{
			PrimPolyline(layer, rgb, true, frame, t);
			Unrendered("OLE2FRAME (" + why + "; frame only)");
			return;
		}
		// AutoCAD does not plot the OLE frame; keep its area for picking.
		PrimFill(layer, rgb, 3, new() { frame }, t);
		double x0 = Math.Min(a.X, b.X), x1 = Math.Max(a.X, b.X), yTop = Math.Max(a.Y, b.Y), yBot = Math.Min(a.Y, b.Y);
		string handle = ole.Handle.ToString("X");
		if (pic.Image != null)
		{
			// a bitmap fills the frame
			AddPicture(pic.Image, pic.Mime, pic.Width, pic.Height, handle, layer,
				t.Apply(x0, yBot), t.ApplyVec((x1 - x0) / pic.Width, 0), t.ApplyVec(0, (yTop - yBot) / pic.Height));
			return;
		}
		var player = new EmfPlayer(pic.Emf);
		var (fx0, fy0, fx1, fy1) = player.FramePx;
		if (!(fx1 > fx0) || !(fy1 > fy0)) { Unrendered("OLE2FRAME (picture has no size; frame only)"); PrimPolyline(layer, rgb, true, frame, t); return; }
		// Picture device pixels (y down) into the frame: local points are (x, -y).
		double sx = (x1 - x0) / (fx1 - fx0), sy = (yTop - yBot) / (fy1 - fy0);
		var m = t.Then(new Affine(sx, 0, 0, sy, x0 - fx0 * sx, yTop + fy0 * sy));
		var sink = new EmfPlayer.Sink
		{
			Stroke = (pts, closed, color, width) =>
			{
				if (width > 0 && pts.Count >= 2)
				{
					var v = pts.Select(p => (p.x, p.y, 0.0, width, width)).ToList();
					if (EmitWide(layer, color, v, closed, m)) return;
				}
				PrimPolyline(layer, color, closed, pts, m);
			},
			Fill = (loops, color, winding) => PrimFill(layer, color, winding ? 2 : 1, loops, m),
			Text = (x, y, cap, rot, text, face, width, color, deco) =>
			{
				PrimText(layer, color, x, y, cap, rot, "lb", text, m, face, 1, width);
				double cs = Math.Cos(rot), sn = Math.Sin(rot);
				for (int bit = 1; bit <= 4; bit <<= 1)
					if ((deco & bit) != 0) Decoration(layer, color, x, y, cs, sn, 0, width, 0, cap, bit, m);
			},
			Image = (bytes, mime, w, h, bl, u, v) => AddPicture(bytes, mime, w, h, handle, layer, m.Apply(bl.x, bl.y), m.ApplyVec(u.x, u.y), m.ApplyVec(v.x, v.y)),
		};
		player.Play(sink);
		foreach (var kv in player.Skipped) _unrendered["OLE2FRAME picture: " + kv.Key] = _unrendered.GetValueOrDefault("OLE2FRAME picture: " + kv.Key) + kv.Value;
	}

	// An embedded picture placed in world space: bl is the bottom-left corner, u and v the
	// world vectors of one pixel along its rows and up its columns.
	void AddPicture(byte[] bytes, string mime, int w, int h, string handle, int layer, (double x, double y) bl, (double x, double y) u, (double x, double y) v)
	{
		var key = Convert.ToHexString(SHA1.HashData(bytes))[..16].ToLowerInvariant();
		if (!_images.ContainsKey(key)) _images[key] = "data:" + mime + ";base64," + Convert.ToBase64String(bytes);
		_rasters.Add((_ent, handle, layer, "OLE2FRAME " + handle + " (embedded picture)", new[] { bl.x, bl.y }, new[] { u.x, u.y }, new[] { v.x, v.y }, new double[] { w, h }, 0, null, key));
		foreach (var (cx, cy) in new[] { (0.0, 0.0), ((double)w, 0.0), (0.0, (double)h), ((double)w, (double)h) })
			Grow(bl.x + u.x * cx + v.x * cy, bl.y + u.y * cx + v.y * cy);
	}
}

/// <summary>The picture an OLE object displays: an EMF to play, or an encoded image.</summary>
sealed class OlePicture
{
	public byte[] Emf;
	public byte[] Image;
	public string Mime;
	public int Width, Height;

	static readonly byte[] CfbMagic = { 0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1 };

	public static OlePicture From(byte[] data, out string why)
	{
		why = null;
		if (data == null || data.Length == 0) { why = "no data"; return null; }
		int off = data.AsSpan().IndexOf(CfbMagic);
		if (off < 0) { why = "no OLE container"; return null; }
		var streams = Cfb.Streams(data.AsSpan(off).ToArray());
		// The server's own content first (a picture object keeps its EMF there), then the
		// cached presentations AutoCAD itself displays.
		if (streams.TryGetValue("CONTENTS", out var contents))
		{
			if (Bin.FindEmf(contents) is { } emfContents) return new OlePicture { Emf = emfContents };
			if (Encoded(contents) is { } img) return img;
		}
		bool wmfOnly = false;
		foreach (var name in streams.Keys.Where(k => k.StartsWith("\u0002OlePres")).OrderBy(k => k))
		{
			var pres = Presentation(streams[name], out var format);
			if (pres == null) continue;
			if (Bin.FindEmf(pres) is { } emfPres) return new OlePicture { Emf = emfPres };
			if (Bin.IsWmf(pres))
			{
				var emf = Bin.EmfInWmf(pres);
				if (emf != null && Bin.IsEmf(emf)) return new OlePicture { Emf = emf };
				wmfOnly = true;
				continue;
			}
			if (format == 8 && Bin.DibToImage(pres, 0, pres.Length, -1, 0) is { } dib)
				return new OlePicture { Image = dib.bytes, Mime = dib.mime, Width = dib.w, Height = dib.h };
		}
		foreach (var kv in streams)
			if (kv.Key.EndsWith("Ole10Native") && Encoded(kv.Value) is { } img) return img;
		why = wmfOnly ? "WMF picture not supported" : "no picture cached";
		return null;
	}

	// An image file somewhere in a stream (Ole10Native wraps the original file with a header).
	static OlePicture Encoded(byte[] s)
	{
		int png = s.AsSpan().IndexOf(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });
		if (png >= 0 && png + 24 < s.Length)
			return new OlePicture { Image = s[png..], Mime = "image/png", Width = Bin.Be32(s, png + 16), Height = Bin.Be32(s, png + 20) };
		int jpg = s.AsSpan().IndexOf(new byte[] { 0xFF, 0xD8, 0xFF });
		if (jpg >= 0 && Bin.JpegSize(s, jpg) is var (w, h) && w > 0)
			return new OlePicture { Image = s[jpg..], Mime = "image/jpeg", Width = w, Height = h };
		int bm = s.AsSpan().IndexOf("BM"u8);
		if (bm >= 0 && bm + 54 < s.Length && Bin.U32(s, bm + 14) is 40 or 108 or 124
			&& Bin.DibToImage(s, bm + 14, s.Length - bm - 14, (int)Bin.U32(s, bm + 10) - 14, 0) is { } dib)
			return new OlePicture { Image = dib.bytes, Mime = dib.mime, Width = dib.w, Height = dib.h };
		return null;
	}

	// OLEPresentationStream (MS-OLEDS 2.3.4): clipboard format, target device, then the data.
	static byte[] Presentation(byte[] s, out int format)
	{
		format = -1;
		if (s.Length < 40) return null;
		int p = 0;
		uint marker = Bin.U32(s, p); p += 4;
		if (marker == 0xFFFFFFFF || marker == 0xFFFFFFFE) { format = (int)Bin.U32(s, p); p += 4; }
		else if (marker == 0) return null;
		else p += (int)marker; // a registered format named by string
		uint td = Bin.U32(s, p); p += 4;
		if (td > 4) p += (int)td - 4;
		p += 24; // aspect, lindex, advf, reserved, width, height
		if (p + 4 > s.Length) return null;
		int size = (int)Bin.U32(s, p); p += 4;
		if (size <= 0 || p + size > s.Length) size = s.Length - p;
		return s.AsSpan(p, size).ToArray();
	}
}

/// <summary>Minimal reader for OLE compound files (MS-CFB): stream name/path to bytes.</summary>
static class Cfb
{
	const uint End = 0xFFFFFFFE, Free = 0xFFFFFFFF;

	public static Dictionary<string, byte[]> Streams(byte[] d)
	{
		int shift = Bin.U16(d, 30), miniShift = Bin.U16(d, 32);
		if (shift is < 7 or > 16 || miniShift is < 1 or > 12) throw new InvalidDataException("bad compound file header");
		int ss = 1 << shift, mss = 1 << miniShift;
		uint cutoff = Bin.U32(d, 56);
		long Off(uint sector) => (long)(sector + 1) * ss;
		// FAT sectors from the header DIFAT, then the DIFAT chain
		var fatSectors = new List<uint>();
		for (int i = 0; i < 109; i++) { var s = Bin.U32(d, 76 + i * 4); if (s != Free && s != End) fatSectors.Add(s); }
		uint difat = Bin.U32(d, 68);
		for (int guard = 0; difat != End && difat != Free && guard < 10000; guard++)
		{
			long o = Off(difat);
			if (o + ss > d.Length) break;
			for (int i = 0; i < ss / 4 - 1; i++) { var s = Bin.U32(d, (int)(o + i * 4)); if (s != Free && s != End) fatSectors.Add(s); }
			difat = Bin.U32(d, (int)(o + ss - 4));
		}
		var fat = new List<uint>();
		foreach (var fs in fatSectors)
		{
			long o = Off(fs);
			if (o + ss > d.Length) break;
			for (int i = 0; i < ss / 4; i++) fat.Add(Bin.U32(d, (int)(o + i * 4)));
		}
		byte[] Chain(uint start, long size)
		{
			var ms = new MemoryStream();
			for (uint s = start; s != End && s < fat.Count && ms.Length < (size < 0 ? long.MaxValue : size); s = fat[(int)s])
			{
				long o = Off(s);
				if (o + ss > d.Length || ms.Length > d.Length) break;
				ms.Write(d, (int)o, ss);
			}
			var all = ms.ToArray();
			return size >= 0 && size < all.Length ? all[..(int)size] : all;
		}
		var dir = Chain(Bin.U32(d, 48), -1);
		var entries = new List<(string name, int type, uint left, uint right, uint child, uint start, long size)>();
		for (int o = 0; o + 128 <= dir.Length; o += 128)
		{
			int nameLen = Bin.U16(dir, o + 64);
			var name = nameLen >= 2 ? Encoding.Unicode.GetString(dir, o, Math.Min(64, nameLen) - 2) : "";
			entries.Add((name, dir[o + 66], Bin.U32(dir, o + 68), Bin.U32(dir, o + 72), Bin.U32(dir, o + 76), Bin.U32(dir, o + 116), (long)Bin.U32(dir, o + 120)));
		}
		var result = new Dictionary<string, byte[]>();
		if (entries.Count == 0) return result;
		var root = entries[0];
		var mini = Chain(root.start, root.size);
		var minifat = new List<uint>();
		var mf = Chain(Bin.U32(d, 60), -1);
		for (int i = 0; i + 4 <= mf.Length; i += 4) minifat.Add(Bin.U32(mf, i));
		byte[] Mini(uint start, long size)
		{
			var ms = new MemoryStream();
			for (uint s = start; s != End && s < minifat.Count && ms.Length < size; s = minifat[(int)s])
			{
				long o = (long)s * mss;
				if (o + mss > mini.Length) break;
				ms.Write(mini, (int)o, mss);
			}
			var all = ms.ToArray();
			return size < all.Length ? all[..(int)size] : all;
		}
		var seen = new HashSet<uint>();
		void Walk(uint id, string prefix)
		{
			if (id >= entries.Count || !seen.Add(id)) return;
			var e = entries[(int)id];
			Walk(e.left, prefix);
			Walk(e.right, prefix);
			var path = prefix + e.name;
			if (e.type == 2) result[path] = e.size < cutoff ? Mini(e.start, e.size) : Chain(e.start, e.size);
			else if (e.type == 1) Walk(e.child, path + "/");
		}
		Walk(root.child, "");
		return result;
	}
}

/// <summary>Little helpers for reading binary records and converting bitmaps.</summary>
static class Bin
{
	public static uint U32(byte[] b, int o) => o + 4 <= b.Length && o >= 0 ? BitConverter.ToUInt32(b, o) : 0;
	public static int I32(byte[] b, int o) => o + 4 <= b.Length && o >= 0 ? BitConverter.ToInt32(b, o) : 0;
	public static int U16(byte[] b, int o) => o + 2 <= b.Length && o >= 0 ? BitConverter.ToUInt16(b, o) : 0;
	public static int I16(byte[] b, int o) => o + 2 <= b.Length && o >= 0 ? BitConverter.ToInt16(b, o) : 0;
	public static float F32(byte[] b, int o) => o + 4 <= b.Length && o >= 0 ? BitConverter.ToSingle(b, o) : 0;
	public static int Be32(byte[] b, int o) => o + 4 <= b.Length ? (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3] : 0;

	public static bool IsEmf(byte[] b) => b != null && b.Length >= 88 && U32(b, 0) == 1 && b[40] == ' ' && b[41] == 'E' && b[42] == 'M' && b[43] == 'F';
	/// <summary>An EMF at the start of b or behind a short header (picture objects prefix its size).</summary>
	public static byte[] FindEmf(byte[] b)
	{
		if (IsEmf(b)) return b;
		for (int o = 4; o <= 16 && b != null && o + 88 <= b.Length; o += 4)
			if (U32(b, o) == 1 && b[o + 40] == ' ' && b[o + 41] == 'E' && b[o + 42] == 'M' && b[o + 43] == 'F') return b[o..];
		return null;
	}

	public static bool IsWmf(byte[] b) => b != null && b.Length >= 18 && ((U16(b, 0) is 1 or 2 && U16(b, 2) == 9) || U32(b, 0) == 0x9AC6CDD7);

	/// <summary>An EMF carried in a WMF as META_ESCAPE MFCOMMENT "WMFC" chunks, reassembled.</summary>
	public static byte[] EmfInWmf(byte[] w)
	{
		int p = U32(w, 0) == 0x9AC6CDD7 ? 22 : 0; // placeable header
		p += U16(w, p + 2) * 2;
		var ms = new MemoryStream();
		for (int guard = 0; p + 6 <= w.Length && guard < 1_000_000; guard++)
		{
			long size = U32(w, p) * 2L;
			int fn = U16(w, p + 4);
			if (size < 6 || p + size > w.Length) break;
			if (fn == 0x0626 && U16(w, p + 6) == 0x000F)
			{
				int n = U16(w, p + 8), body = p + 10;
				if (n >= 34 && U32(w, body) == 0x43464D57) // "WMFC"
				{
					int cur = (int)U32(w, body + 22);
					if (body + 34 + cur <= w.Length) ms.Write(w, body + 34, cur);
				}
			}
			if (fn == 0) break;
			p += (int)size;
		}
		return ms.Length > 0 ? ms.ToArray() : null;
	}

	public static (int w, int h)? JpegSize(byte[] b, int o)
	{
		int p = o + 2;
		while (p + 9 < b.Length)
		{
			if (b[p] != 0xFF) return null;
			int m = b[p + 1], len = (b[p + 2] << 8) | b[p + 3];
			if (m is >= 0xC0 and <= 0xCF and not 0xC4 and not 0xC8 and not 0xCC) return ((b[p + 7] << 8) | b[p + 8], (b[p + 5] << 8) | b[p + 6]);
			p += 2 + len;
		}
		return null;
	}

	/// <summary>
	/// A DIB (BITMAPINFO at bmi, pixel bits at bits, or right after the colour table when bits is -1)
	/// as a PNG, or the JPEG/PNG it already holds. transparent: a 0xRRGGBB colour to make clear, or -1.
	/// </summary>
	public static (byte[] bytes, string mime, int w, int h)? DibToImage(byte[] b, int bmi, int cbBmi, int bits, int transparent, bool alpha = false)
	{
		int comp = (int)U32(b, bmi + 16);
		if (U32(b, bmi) >= 40 && comp is 4 or 5)
		{
			if (bits < 0) bits = bmi + (int)U32(b, bmi);
			int len = (int)U32(b, bmi + 20);
			if (len <= 0 || bits + (long)len > b.Length) return null;
			return (b.AsSpan(bits, len).ToArray(), comp == 4 ? "image/jpeg" : "image/png", I32(b, bmi + 4), Math.Abs(I32(b, bmi + 8)));
		}
		var pixels = DibPixels(b, bmi, bits, transparent, alpha);
		return pixels is { } im ? (Png.Encode(im.w, im.h, im.rgba, true), "image/png", im.w, im.h) : null;
	}

	public static (byte[] rgba, int w, int h)? DibPixels(byte[] b, int bmi, int bits, int transparent = -1, bool alpha = false)
	{
		int hs = (int)U32(b, bmi);
		int w, h, bpp, comp, used = 0;
		if (hs == 12) { w = U16(b, bmi + 4); h = I16(b, bmi + 6); bpp = U16(b, bmi + 10); comp = 0; }
		else if (hs >= 40) { w = I32(b, bmi + 4); h = I32(b, bmi + 8); bpp = U16(b, bmi + 14); comp = (int)U32(b, bmi + 16); used = (int)U32(b, bmi + 32); }
		else return null;
		bool topDown = h < 0;
		h = Math.Abs(h);
		if (w <= 0 || h <= 0 || (long)w * h > 64_000_000) return null;
		int masks = hs == 40 && comp == 3 ? 12 : 0;
		int colors = bpp <= 8 ? (used > 0 ? used : 1 << bpp) : (used > 0 ? used : 0);
		int entry = hs == 12 ? 3 : 4;
		int table = bmi + hs + masks;
		if (bits < 0) bits = table + colors * entry;
		if (comp is not (0 or 3)) return null;
		uint rm = 0x00FF0000, gm = 0x0000FF00, bm = 0x000000FF;
		if (comp == 3)
		{
			int mo = hs == 40 ? bmi + 40 : bmi + 40; // masks follow a 40-byte header, or sit inside V4/V5
			rm = U32(b, mo); gm = U32(b, mo + 4); bm = U32(b, mo + 8);
		}
		else if (bpp == 16) { rm = 0x7C00; gm = 0x03E0; bm = 0x001F; }
		int stride = ((w * bpp + 31) / 32) * 4;
		if (bits + (long)stride * h > b.Length) return null;
		var rgba = new byte[w * h * 4];
		static int Shift(uint m) { int s = 0; while (m != 0 && (m & 1) == 0) { m >>= 1; s++; } return s; }
		static int Max(uint m, int s) => (int)(m >> s);
		int rs = Shift(rm), gs = Shift(gm), bs = Shift(bm);
		int rx = Math.Max(1, Max(rm, rs)), gx = Math.Max(1, Max(gm, gs)), bx = Math.Max(1, Max(bm, bs));
		for (int y = 0; y < h; y++)
		{
			int row = bits + (topDown ? y : h - 1 - y) * stride;
			for (int x = 0; x < w; x++)
			{
				int r, g, bl, a = 255;
				switch (bpp)
				{
					case 1: case 4: case 8:
						{
							int idx = bpp == 8 ? b[row + x] : bpp == 4 ? (b[row + x / 2] >> (x % 2 == 0 ? 4 : 0)) & 15 : (b[row + x / 8] >> (7 - x % 8)) & 1;
							int c = table + Math.Min(idx, Math.Max(0, colors - 1)) * entry;
							bl = b[c]; g = b[c + 1]; r = b[c + 2];
							break;
						}
					case 16:
						{
							uint v = (uint)U16(b, row + x * 2);
							r = (int)(((v & rm) >> rs) * 255 / rx); g = (int)(((v & gm) >> gs) * 255 / gx); bl = (int)(((v & bm) >> bs) * 255 / bx);
							break;
						}
					case 24:
						bl = b[row + x * 3]; g = b[row + x * 3 + 1]; r = b[row + x * 3 + 2];
						break;
					case 32:
						{
							int o = row + x * 4;
							if (comp == 3)
							{
								uint v = U32(b, o);
								r = (int)(((v & rm) >> rs) * 255 / rx); g = (int)(((v & gm) >> gs) * 255 / gx); bl = (int)(((v & bm) >> bs) * 255 / bx);
							}
							else { bl = b[o]; g = b[o + 1]; r = b[o + 2]; }
							if (alpha)
							{
								a = b[o + 3];
								if (a > 0 && a < 255) { r = Math.Min(255, r * 255 / a); g = Math.Min(255, g * 255 / a); bl = Math.Min(255, bl * 255 / a); }
							}
							break;
						}
					default: return null;
				}
				if (transparent >= 0 && ((r << 16) | (g << 8) | bl) == transparent) a = 0;
				int p = (y * w + x) * 4;
				rgba[p] = (byte)r; rgba[p + 1] = (byte)g; rgba[p + 2] = (byte)bl; rgba[p + 3] = (byte)a;
			}
		}
		return (rgba, w, h);
	}
}

/// <summary>PNG writer for 8-bit RGB or RGBA pixels.</summary>
static class Png
{
	static readonly uint[] Crc = Enumerable.Range(0, 256).Select(n =>
	{
		uint c = (uint)n;
		for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
		return c;
	}).ToArray();

	public static byte[] Encode(int w, int h, byte[] rgba, bool alpha)
	{
		int px = alpha ? 4 : 3;
		var raw = new byte[(w * px + 1) * h];
		for (int y = 0, o = 0; y < h; y++)
		{
			raw[o++] = 0; // no filter
			for (int x = 0; x < w; x++)
			{
				int i = (y * w + x) * 4;
				raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2];
				if (alpha) raw[o++] = rgba[i + 3];
			}
		}
		var z = new MemoryStream();
		using (var zs = new ZLibStream(z, CompressionLevel.Optimal, true)) zs.Write(raw);
		var ms = new MemoryStream();
		ms.Write(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A });
		var ihdr = new byte[13];
		Be(ihdr, 0, (uint)w); Be(ihdr, 4, (uint)h);
		ihdr[8] = 8; ihdr[9] = (byte)(alpha ? 6 : 2);
		Chunk(ms, "IHDR", ihdr);
		Chunk(ms, "IDAT", z.ToArray());
		Chunk(ms, "IEND", Array.Empty<byte>());
		return ms.ToArray();
	}

	static void Be(byte[] b, int o, uint v) { b[o] = (byte)(v >> 24); b[o + 1] = (byte)(v >> 16); b[o + 2] = (byte)(v >> 8); b[o + 3] = (byte)v; }

	static void Chunk(Stream s, string type, byte[] data)
	{
		var len = new byte[4];
		Be(len, 0, (uint)data.Length);
		s.Write(len);
		var td = Encoding.ASCII.GetBytes(type).Concat(data).ToArray();
		s.Write(td);
		uint c = 0xFFFFFFFF;
		foreach (var x in td) c = Crc[(c ^ x) & 0xFF] ^ (c >> 8);
		var crc = new byte[4];
		Be(crc, 0, c ^ 0xFFFFFFFF);
		s.Write(crc);
	}
}

/// <summary>
/// Plays the GDI records of an EMF (EMF+ records are skipped: dual-mode files carry GDI
/// fallbacks) into lines, fills, text and images in device pixels with y up.
/// </summary>
sealed class EmfPlayer
{
	public sealed class Sink
	{
		/// <summary>points, closed, colour, width in local units (0 for a hairline)</summary>
		public Action<List<(double x, double y)>, bool, int, double> Stroke;
		/// <summary>loops, colour, nonzero</summary>
		public Action<List<List<(double x, double y)>>, int, bool> Fill;
		/// <summary>baseline-left x, y, capital height, rotation, text, face, width, colour, decorations</summary>
		public Action<double, double, double, double, string, Face, double, int, int> Text;
		/// <summary>bytes, mime, width px, height px, bottom-left, per-pixel u, per-pixel v</summary>
		public Action<byte[], string, int, int, (double x, double y), (double x, double y), (double x, double y)> Image;
	}

	sealed class Pen { public int Style, Rgb; public double Width; }
	sealed class Brush { public int Style, Rgb; }
	sealed class Font { public int Height, Weight, Escapement; public bool Italic, Underline, Strike; public string Face = "Arial"; }

	sealed class DC
	{
		public double WOx, WOy, WEx = 1, WEy = 1, VOx, VOy, VEx = 1, VEy = 1;
		public int MapMode = 1, TextAlign, TextColor, PolyFill = 1;
		public double M11 = 1, M12, M21, M22 = 1, Dx, Dy;
		public Pen Pen = new() { Style = 0, Rgb = 0, Width = 0 };
		public Brush Brush = new() { Style = 0, Rgb = 0xFFFFFF };
		public Font Font = new();
		public double CurX, CurY;
		public DC Clone() => (DC)MemberwiseClone();
	}

	readonly byte[] _b;
	readonly double _pxPerMmX = 1, _pxPerMmY = 1;
	public (double x0, double y0, double x1, double y1) FramePx { get; }
	public Dictionary<string, int> Skipped { get; } = new();

	public EmfPlayer(byte[] emf)
	{
		_b = emf;
		int devX = Bin.I32(emf, 72), devY = Bin.I32(emf, 76), mmX = Bin.I32(emf, 80), mmY = Bin.I32(emf, 84);
		if (devX > 0 && mmX > 0) _pxPerMmX = (double)devX / mmX;
		if (devY > 0 && mmY > 0) _pxPerMmY = (double)devY / mmY;
		int fl = Bin.I32(emf, 24), ft = Bin.I32(emf, 28), fr = Bin.I32(emf, 32), fb = Bin.I32(emf, 36);
		if (fr > fl && fb > ft) FramePx = (fl / 100.0 * _pxPerMmX, ft / 100.0 * _pxPerMmY, fr / 100.0 * _pxPerMmX, fb / 100.0 * _pxPerMmY);
		else FramePx = (Bin.I32(emf, 8), Bin.I32(emf, 12), Bin.I32(emf, 16) + 1, Bin.I32(emf, 20) + 1);
	}

	DC _dc = new();
	readonly Stack<DC> _saved = new();
	readonly Dictionary<uint, object> _objects = new();
	// path bracket: figures collected between BEGINPATH and ENDPATH
	List<List<(double x, double y)>> _path;
	List<(double x, double y)> _figure;
	readonly List<bool> _closed = new();

	// Logical to device pixels (y down): world transform, then window to viewport.
	(double x, double y) Dev(double lx, double ly)
	{
		var d = _dc;
		double px = lx * d.M11 + ly * d.M21 + d.Dx, py = lx * d.M12 + ly * d.M22 + d.Dy;
		double sx = 1, sy = 1;
		switch (d.MapMode)
		{
			case 7: case 8: sx = d.WEx != 0 ? d.VEx / d.WEx : 1; sy = d.WEy != 0 ? d.VEy / d.WEy : 1; break;
			case 2: sx = 0.1 * _pxPerMmX; sy = -0.1 * _pxPerMmY; break;
			case 3: sx = 0.01 * _pxPerMmX; sy = -0.01 * _pxPerMmY; break;
			case 4: sx = 0.254 * _pxPerMmX; sy = -0.254 * _pxPerMmY; break;
			case 5: sx = 0.0254 * _pxPerMmX; sy = -0.0254 * _pxPerMmY; break;
			case 6: sx = 25.4 / 1440 * _pxPerMmX; sy = -25.4 / 1440 * _pxPerMmY; break;
		}
		return ((px - d.WOx) * sx + d.VOx, (py - d.WOy) * sy + d.VOy);
	}

	// Device pixels with y flipped up: the frame the sink receives.
	(double x, double y) Loc(double lx, double ly) { var (x, y) = Dev(lx, ly); return (x, -y); }

	// Length of a logical vector in device pixels, along x and along y.
	double ScaleX() { var a = Dev(0, 0); var b = Dev(1, 0); return Math.Sqrt(Math.Pow(b.x - a.x, 2) + Math.Pow(b.y - a.y, 2)); }
	double ScaleY() { var a = Dev(0, 0); var b = Dev(0, 1); return Math.Sqrt(Math.Pow(b.x - a.x, 2) + Math.Pow(b.y - a.y, 2)); }

	static int Colorref(uint c) => (int)(((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF));

	static readonly HashSet<int> Ignored = new()
	{
		13, 16, 18, 20, 21, 25, 28, 29, 30, 31, 32, 48, 49, 58, 65, 66, 67, 70, 75, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 109, 110, 111, 112, 113, 115, 117, 119, 120, 121, 122,
	};

	public void Play(Sink sink)
	{
		var b = _b;
		int p = 0;
		for (int guard = 0; p + 8 <= b.Length && guard < 2_000_000; guard++)
		{
			int type = (int)Bin.U32(b, p);
			int size = (int)Bin.U32(b, p + 4);
			if (size < 8 || p + size > b.Length) break;
			try { Record(sink, type, p, size); }
			catch (Exception) { Skip("record " + type + " (unreadable)"); }
			if (type == 14) break;
			p += size;
		}
		if (_sink != null) FlushLine();
		if (_paintMask != null) { Skip("unpaired bitmap mask"); _paintMask = null; }
	}

	void Skip(string what) => Skipped[what] = Skipped.GetValueOrDefault(what) + 1;

	List<(double x, double y)> Points(int o, int n, bool small)
	{
		var pts = new List<(double, double)>(n);
		for (int i = 0; i < n; i++)
			pts.Add(small ? Loc(Bin.I16(_b, o + i * 4), Bin.I16(_b, o + i * 4 + 2)) : Loc(Bin.I32(_b, o + i * 8), Bin.I32(_b, o + i * 8 + 4)));
		return pts;
	}

	static List<(double x, double y)> Bezier((double x, double y) start, List<(double x, double y)> ctl)
	{
		var pts = new List<(double, double)> { start };
		var p0 = start;
		for (int i = 0; i + 2 < ctl.Count; i += 3)
		{
			var (c1, c2, p3) = (ctl[i], ctl[i + 1], ctl[i + 2]);
			for (int k = 1; k <= 12; k++)
			{
				double t = k / 12.0, u = 1 - t;
				pts.Add((u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x, u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y));
			}
			p0 = p3;
		}
		return pts;
	}

	bool PenOn => (_dc.Pen.Style & 0xF) != 5;
	bool BrushOn => _dc.Brush.Style != 1;
	double PenWidth { get { double w = _dc.Pen.Width * ScaleX(); return w > 1.5 ? w : 0; } }

	void Stroke(Sink s, List<(double x, double y)> pts, bool closed)
	{
		if (_path != null) { AddFigure(pts, closed); return; }
		if (PenOn && pts.Count >= 2) s.Stroke(pts, closed, _dc.Pen.Rgb, PenWidth);
	}

	void Shape(Sink s, List<List<(double x, double y)>> loops)
	{
		if (_path != null) { foreach (var l in loops) AddFigure(l, true); return; }
		// White fills are the paper the picture was drawn on; they would hide the drawing.
		if (BrushOn && _dc.Brush.Rgb != 0xFFFFFF) s.Fill(loops, _dc.Brush.Rgb, _dc.PolyFill == 2);
		if (PenOn) foreach (var l in loops) if (l.Count >= 2) s.Stroke(l, true, _dc.Pen.Rgb, PenWidth);
	}

	void AddFigure(List<(double x, double y)> pts, bool closed)
	{
		_path.Add(pts);
		_closed.Add(closed);
		_figure = null;
	}

	void LineTo(double lx, double ly)
	{
		var a = Loc(_dc.CurX, _dc.CurY);
		var b = Loc(lx, ly);
		_dc.CurX = lx; _dc.CurY = ly;
		if (_path != null)
		{
			if (_figure == null) { _figure = new() { a }; _path.Add(_figure); _closed.Add(false); }
			_figure.Add(b);
			return;
		}
		_pending ??= new() { a };
		if (_pending.Count > 0 && (_pending[^1].x != a.x || _pending[^1].y != a.y)) { FlushLine(); _pending = new() { a }; }
		_pending.Add(b);
	}

	// Consecutive LINETOs from the same pen become one polyline.
	List<(double x, double y)> _pending;
	Sink _sink;
	(byte[] rgba, int w, int h, int x, int y, int cx, int cy)? _paintMask;
	void FlushLine()
	{
		if (_pending != null && _pending.Count >= 2 && PenOn) _sink.Stroke(_pending, false, _dc.Pen.Rgb, PenWidth);
		_pending = null;
	}

	void Record(Sink s, int type, int p, int size)
	{
		_sink = s;
		var b = _b;
		if (type != 54 && _pending != null) FlushLine();
		switch (type)
		{
			case 1: break; // header
			case 14: break; // end
			case 2: case 85: // POLYBEZIER
				{
					bool sm = type == 85;
					var pts = Points(p + 28, (int)Bin.U32(b, p + 24), sm);
					if (pts.Count >= 4) Stroke(s, Bezier(pts[0], pts.Skip(1).ToList()), false);
					break;
				}
			case 5: case 88: // POLYBEZIERTO
				{
					var pts = Points(p + 28, (int)Bin.U32(b, p + 24), type == 88);
					var start = Loc(_dc.CurX, _dc.CurY);
					var curve = Bezier(start, pts);
					if (_path != null) { if (_figure == null) { _figure = new() { start }; _path.Add(_figure); _closed.Add(false); } _figure.AddRange(curve.Skip(1)); }
					else Stroke(s, curve, false);
					SetCurFromLast(p + 28, (int)Bin.U32(b, p + 24), type == 88);
					break;
				}
			case 3: case 86: // POLYGON
				Shape(s, new() { Points(p + 28, (int)Bin.U32(b, p + 24), type == 86) });
				break;
			case 4: case 87: // POLYLINE
				Stroke(s, Points(p + 28, (int)Bin.U32(b, p + 24), type == 87), false);
				break;
			case 6: case 89: // POLYLINETO
				{
					int n = (int)Bin.U32(b, p + 24);
					bool sm = type == 89;
					for (int i = 0; i < n; i++)
					{
						double x = sm ? Bin.I16(b, p + 28 + i * 4) : Bin.I32(b, p + 28 + i * 8);
						double y = sm ? Bin.I16(b, p + 30 + i * 4) : Bin.I32(b, p + 32 + i * 8);
						LineTo(x, y);
					}
					FlushLine();
					break;
				}
			case 7: case 90: case 8: case 91: // POLYPOLYLINE, POLYPOLYGON
				{
					bool sm = type is 90 or 91, polygon = type is 8 or 91;
					int polys = (int)Bin.U32(b, p + 24);
					int at = p + 32 + polys * 4;
					var loops = new List<List<(double x, double y)>>();
					for (int i = 0; i < polys; i++)
					{
						int n = (int)Bin.U32(b, p + 32 + i * 4);
						loops.Add(Points(at, n, sm));
						at += n * (sm ? 4 : 8);
					}
					if (polygon) Shape(s, loops);
					else foreach (var l in loops) Stroke(s, l, false);
					break;
				}
			case 9: _dc.WEx = Bin.I32(b, p + 8); _dc.WEy = Bin.I32(b, p + 12); break;
			case 10: _dc.WOx = Bin.I32(b, p + 8); _dc.WOy = Bin.I32(b, p + 12); break;
			case 11: _dc.VEx = Bin.I32(b, p + 8); _dc.VEy = Bin.I32(b, p + 12); break;
			case 12: _dc.VOx = Bin.I32(b, p + 8); _dc.VOy = Bin.I32(b, p + 12); break;
			case 17: _dc.MapMode = (int)Bin.U32(b, p + 8); break;
			case 19: _dc.PolyFill = (int)Bin.U32(b, p + 8); break;
			case 22: _dc.TextAlign = (int)Bin.U32(b, p + 8); break;
			case 24: _dc.TextColor = Colorref(Bin.U32(b, p + 8)); break;
			case 27: _dc.CurX = Bin.I32(b, p + 8); _dc.CurY = Bin.I32(b, p + 12); if (_path != null) _figure = null; break;
			case 54: LineTo(Bin.I32(b, p + 8), Bin.I32(b, p + 12)); break;
			case 33: _saved.Push(_dc.Clone()); break;
			case 34:
				{
					int n = Bin.I32(b, p + 8);
					for (int i = 0; i < Math.Max(1, -n) && _saved.Count > 0; i++) _dc = _saved.Pop();
					break;
				}
			case 35:
				_dc.M11 = Bin.F32(b, p + 8); _dc.M12 = Bin.F32(b, p + 12); _dc.M21 = Bin.F32(b, p + 16);
				_dc.M22 = Bin.F32(b, p + 20); _dc.Dx = Bin.F32(b, p + 24); _dc.Dy = Bin.F32(b, p + 28);
				break;
			case 36:
				{
					double a11 = Bin.F32(b, p + 8), a12 = Bin.F32(b, p + 12), a21 = Bin.F32(b, p + 16), a22 = Bin.F32(b, p + 20), adx = Bin.F32(b, p + 24), ady = Bin.F32(b, p + 28);
					int mode = (int)Bin.U32(b, p + 32);
					var d = _dc;
					if (mode == 1) { d.M11 = 1; d.M12 = 0; d.M21 = 0; d.M22 = 1; d.Dx = 0; d.Dy = 0; }
					else if (mode == 4) { d.M11 = a11; d.M12 = a12; d.M21 = a21; d.M22 = a22; d.Dx = adx; d.Dy = ady; }
					else if (mode == 2) // left multiply: new = A * M
					{
						(d.M11, d.M12, d.M21, d.M22, d.Dx, d.Dy) = (a11 * d.M11 + a12 * d.M21, a11 * d.M12 + a12 * d.M22, a21 * d.M11 + a22 * d.M21, a21 * d.M12 + a22 * d.M22, adx * d.M11 + ady * d.M21 + d.Dx, adx * d.M12 + ady * d.M22 + d.Dy);
					}
					else if (mode == 3) // right multiply: new = M * A
					{
						(d.M11, d.M12, d.M21, d.M22, d.Dx, d.Dy) = (d.M11 * a11 + d.M12 * a21, d.M11 * a12 + d.M12 * a22, d.M21 * a11 + d.M22 * a21, d.M21 * a12 + d.M22 * a22, d.Dx * a11 + d.Dy * a21 + adx, d.Dx * a12 + d.Dy * a22 + ady);
					}
					break;
				}
			case 37: Select(Bin.U32(b, p + 8)); break;
			case 38:
				_objects[Bin.U32(b, p + 8)] = new Pen { Style = (int)Bin.U32(b, p + 12), Width = Bin.I32(b, p + 16), Rgb = Colorref(Bin.U32(b, p + 24)) };
				break;
			case 95:
				_objects[Bin.U32(b, p + 8)] = new Pen { Style = (int)Bin.U32(b, p + 28), Width = Bin.U32(b, p + 32), Rgb = Colorref(Bin.U32(b, p + 40)) };
				break;
			case 39:
				_objects[Bin.U32(b, p + 8)] = new Brush { Style = (int)Bin.U32(b, p + 12), Rgb = Colorref(Bin.U32(b, p + 16)) };
				break;
			case 40: _objects.Remove(Bin.U32(b, p + 8)); break;
			case 82:
				{
					var f = new Font
					{
						Height = Bin.I32(b, p + 12),
						Escapement = Bin.I32(b, p + 20),
						Weight = Bin.I32(b, p + 28),
						Italic = b[p + 32] != 0,
						Underline = b[p + 33] != 0,
						Strike = b[p + 34] != 0,
					};
					var name = Encoding.Unicode.GetString(b, p + 40, 64);
					int z = name.IndexOf('\0');
					f.Face = z >= 0 ? name[..z] : name;
					_objects[Bin.U32(b, p + 8)] = f;
					break;
				}
			case 42: case 43: case 44: // ELLIPSE, RECTANGLE, ROUNDRECT
				{
					int l = Bin.I32(b, p + 8), t = Bin.I32(b, p + 12), r = Bin.I32(b, p + 16), bo = Bin.I32(b, p + 20);
					List<(double x, double y)> loop;
					if (type == 42)
					{
						loop = new();
						double cx = (l + r) / 2.0, cy = (t + bo) / 2.0, rx = (r - l) / 2.0, ry = (bo - t) / 2.0;
						for (int k = 0; k < 72; k++) loop.Add(Loc(cx + rx * Math.Cos(k * Math.PI / 36), cy + ry * Math.Sin(k * Math.PI / 36)));
					}
					else loop = new() { Loc(l, t), Loc(r, t), Loc(r, bo), Loc(l, bo) };
					Shape(s, new() { loop });
					break;
				}
			case 59: _path = new(); _closed.Clear(); _figure = null; break;
			case 68: _path = null; _closed.Clear(); _figure = null; break;
			case 60: _figure = null; break;
			case 61: if (_path != null && _path.Count > 0) _closed[^1] = true; _figure = null; break;
			case 62: case 63: case 64: // FILLPATH, STROKEANDFILLPATH, STROKEPATH
				{
					var figs = _path ?? new();
					var closed = _closed.ToList();
					_path = null;
					_figure = null;
					if (type != 64 && BrushOn && _dc.Brush.Rgb != 0xFFFFFF) s.Fill(figs.Where(f => f.Count >= 3).ToList(), _dc.Brush.Rgb, _dc.PolyFill == 2);
					if (type != 62 && PenOn) for (int i = 0; i < figs.Count; i++) if (figs[i].Count >= 2) s.Stroke(figs[i], closed[i], _dc.Pen.Rgb, PenWidth);
					break;
				}
			case 76: case 77: case 114: case 116: // BITBLT, STRETCHBLT, ALPHABLEND, TRANSPARENTBLT
				{
					int xd = Bin.I32(b, p + 24), yd = Bin.I32(b, p + 28), cxd = Bin.I32(b, p + 32), cyd = Bin.I32(b, p + 36);
					uint rop = Bin.U32(b, p + 40);
					int offBmi = (int)Bin.U32(b, p + 84), cbBmi = (int)Bin.U32(b, p + 88), offBits = (int)Bin.U32(b, p + 92);
					if (cbBmi == 0 || offBmi == 0)
					{
						// no source: a rectangle filled by the brush (or black/white by ROP)
						int rgb = rop == 0x00000042 ? 0 : rop == 0x00FF0062 ? 0xFFFFFF : _dc.Brush.Rgb;
						if ((rop == 0x00F00021 || rop == 0x00000042 || rop == 0x005A0049) && rgb != 0xFFFFFF && (BrushOn || rop == 0x00000042))
							s.Fill(new() { new() { Loc(xd, yd), Loc(xd + cxd, yd), Loc(xd + cxd, yd + cyd), Loc(xd, yd + cyd) } }, rgb, false);
						break;
					}
					int transparent = type == 116 ? Colorref(rop) : -1;
					var img = Bin.DibToImage(b, p + offBmi, cbBmi, p + offBits, transparent, alpha: type == 114);
					if (img is { } im) Picture(s, im, xd, yd, cxd, cyd);
					else Skip("bitmap format");
					break;
				}
			case 80: case 81: // SETDIBITSTODEVICE, STRETCHDIBITS
				{
					int xd = Bin.I32(b, p + 24), yd = Bin.I32(b, p + 28);
					int cxs = Bin.I32(b, p + 40), cys = Bin.I32(b, p + 44);
					int offBmi = (int)Bin.U32(b, p + 48), cbBmi = (int)Bin.U32(b, p + 52), offBits = (int)Bin.U32(b, p + 56);
					int cxd = type == 81 ? Bin.I32(b, p + 72) : cxs, cyd = type == 81 ? Bin.I32(b, p + 76) : cys;
					uint rop = type == 81 ? Bin.U32(b, p + 68) : 0x00CC0020;
					if (cbBmi == 0) break;
					if (rop == 0x00EE0086) // SRCPAINT: first half of (destination OR mask) AND picture
					{
						if (_paintMask != null) Skip("unpaired bitmap mask");
						var mask = Bin.DibPixels(b, p + offBmi, p + offBits);
						_paintMask = mask is { } pm ? (pm.rgba, pm.w, pm.h, xd, yd, cxd, cyd) : null;
						if (_paintMask == null) Skip("bitmap mask format");
						break;
					}
					if (rop == 0x008800C6) // SRCAND: compose both passes before emitting any image
					{
						var source = Bin.DibPixels(b, p + offBmi, p + offBits);
						var mask = _paintMask;
						_paintMask = null;
						if (source is not { } src || mask is not { } pm || src.w != pm.w || src.h != pm.h
							|| (xd, yd, cxd, cyd) != (pm.x, pm.y, pm.cx, pm.cy)) { Skip("unpaired bitmap mask"); break; }
						bool supported = true;
						for (int i = 0; i < src.rgba.Length; i += 4)
						{
							bool opaque = true, clear = true;
							for (int c = 0; c < 3; c++)
							{
								int a = pm.rgba[i + c], v = src.rgba[i + c];
								opaque &= (a & v) == v;
								clear &= (a & v) == 0 && v == 255;
							}
							if (!opaque && !clear) { supported = false; break; }
							src.rgba[i + 3] = (byte)(clear ? 0 : 255);
						}
						if (supported) Picture(s, (Png.Encode(src.w, src.h, src.rgba, true), "image/png", src.w, src.h), xd, yd, cxd, cyd);
						else Skip("bitmap raster operation");
						break;
					}
					if (rop != 0x00CC0020) { Skip("bitmap raster operation"); break; }
					var img = Bin.DibToImage(b, p + offBmi, cbBmi, p + offBits, -1);
					if (img is { } im) Picture(s, im, xd, yd, cxd, cyd);
					else Skip("bitmap format");
					break;
				}
			case 83: case 84: Text(s, p, type == 84); break;
			default:
				if (!Ignored.Contains(type)) Skip(Name(type));
				break;
		}
	}

	void SetCurFromLast(int o, int n, bool small)
	{
		if (n <= 0) return;
		int i = n - 1;
		_dc.CurX = small ? Bin.I16(_b, o + i * 4) : Bin.I32(_b, o + i * 8);
		_dc.CurY = small ? Bin.I16(_b, o + i * 4 + 2) : Bin.I32(_b, o + i * 8 + 4);
	}

	void Picture(Sink s, (byte[] bytes, string mime, int w, int h) im, int xd, int yd, int cxd, int cyd)
	{
		var tl = Loc(xd, yd);
		var tr = Loc(xd + cxd, yd);
		var bl = Loc(xd, yd + cyd);
		s.Image(im.bytes, im.mime, im.w, im.h, bl, ((tr.x - tl.x) / im.w, (tr.y - tl.y) / im.w), ((tl.x - bl.x) / im.h, (tl.y - bl.y) / im.h));
	}

	void Select(uint ih)
	{
		if ((ih & 0x80000000) != 0)
		{
			switch (ih & 0x7FFFFFFF)
			{
				case 0: _dc.Brush = new Brush { Style = 0, Rgb = 0xFFFFFF }; break;
				case 1: _dc.Brush = new Brush { Style = 0, Rgb = 0xC0C0C0 }; break;
				case 2: _dc.Brush = new Brush { Style = 0, Rgb = 0x808080 }; break;
				case 3: _dc.Brush = new Brush { Style = 0, Rgb = 0x404040 }; break;
				case 4: _dc.Brush = new Brush { Style = 0, Rgb = 0 }; break;
				case 5: _dc.Brush = new Brush { Style = 1 }; break;
				case 6: _dc.Pen = new Pen { Rgb = 0xFFFFFF }; break;
				case 7: _dc.Pen = new Pen { Rgb = 0 }; break;
				case 8: _dc.Pen = new Pen { Style = 5 }; break;
				case 10: case 11: case 12: case 13: case 14: case 16: case 17: _dc.Font = new Font { Height = -12 }; break;
			}
			return;
		}
		if (!_objects.TryGetValue(ih, out var o)) return;
		switch (o)
		{
			case Pen pen: _dc.Pen = pen; break;
			case Brush br: _dc.Brush = br; break;
			case Font f: _dc.Font = f; break;
		}
	}

	// Font metrics by family: capital height, ascent and ascent+descent, in em.
	static (double cap, double asc, double cell) Metrics(string face)
	{
		var f = face.ToLowerInvariant();
		if (f.Contains("calibri")) return (0.644, 0.75, 1.221);
		if (f.Contains("cambria")) return (0.667, 0.95, 1.172);
		if (f.Contains("times")) return (0.662, 0.891, 1.107);
		if (f.Contains("tahoma") || f.Contains("verdana")) return (0.727, 1.0, 1.207);
		if (f.Contains("segoe")) return (0.7, 1.079, 1.33);
		return (0.716, 0.905, 1.117);
	}

	void Text(Sink s, int p, bool wide)
	{
		var b = _b;
		int rx = Bin.I32(b, p + 36), ry = Bin.I32(b, p + 40);
		int n = (int)Bin.U32(b, p + 44), offStr = (int)Bin.U32(b, p + 48), options = (int)Bin.U32(b, p + 52), offDx = (int)Bin.U32(b, p + 72);
		if (n <= 0 || n > 100_000) return;
		string text = wide ? Encoding.Unicode.GetString(b, p + offStr, n * 2) : Encoding.Latin1.GetString(b, p + offStr, n);
		if (string.IsNullOrWhiteSpace(text)) return;
		var font = _dc.Font;
		var (cap, asc, cell) = Metrics(font.Face);
		double em = font.Height < 0 ? -font.Height : font.Height > 0 ? font.Height / cell : 12;
		double sy = ScaleY(), sx = ScaleX();
		double emDev = em * sy, capDev = emDev * cap;
		var face = Face.FromName(font.Face, font.Weight >= 600, font.Italic);
		// advances as the server laid them out, else the face's own widths
		double width;
		int step = (options & 0x2000) != 0 ? 8 : 4; // ETO_PDY: dx, dy pairs
		if (offDx > 0 && p + offDx + (long)n * step <= b.Length)
		{
			long sum = 0;
			for (int i = 0; i < n; i++) sum += Bin.I32(b, p + offDx + i * step);
			width = sum * sx;
		}
		else width = TextWidthEm(text, face) * emDev;
		double rot = font.Escapement / 1800.0 * Math.PI;
		double cs = Math.Cos(rot), sn = Math.Sin(rot);
		var (x, y) = Loc(rx, ry);
		int ta = _dc.TextAlign;
		double along = (ta & 6) == 6 ? -width / 2 : (ta & 2) != 0 ? -width : 0;
		double up = (ta & 24) == 24 ? 0 : (ta & 8) != 0 ? (cell - asc) * emDev : -asc * emDev;
		x += along * cs - up * sn;
		y += along * sn + up * cs;
		int deco = (font.Underline ? 1 : 0) | (font.Strike ? 4 : 0);
		s.Text(x, y, capDev, rot, text, face, width, _dc.TextColor, deco);
	}

	static double TextWidthEm(string text, Face face) => text.Sum(c => c >= ' ' && c <= '~' ? (face.Serif ? 0.5 : 0.556) : 0.556) * face.Squeeze;

	static string Name(int type) => type switch
	{
		45 => "ARC", 46 => "CHORD", 47 => "PIE", 55 => "ARCTO", 56 => "POLYDRAW", 57 => "SETARCDIRECTION",
		69 => "SETCOLORADJUSTMENT", 71 => "FILLRGN", 72 => "FRAMERGN", 73 => "INVERTRGN", 74 => "PAINTRGN",
		78 => "MASKBLT", 79 => "PLGBLT", 96 => "POLYTEXTOUTA", 97 => "POLYTEXTOUTW", 108 => "SMALLTEXTOUT",
		118 => "GRADIENTFILL", 53 => "EXTFLOODFILL", 50 => "SETPALETTEENTRIES", 51 => "RESIZEPALETTE",
		_ => "record " + type,
	};
}
