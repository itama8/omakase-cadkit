// Text layout: faces, advance widths, TEXT decorations and MTEXT runs with word wrap.
//
// AutoCAD lays MTEXT out run by run: inline codes switch the font (\f, \F), height (\H),
// width factor (\W), tracking (\T), colour (\C, \c) and underline/overline/strike-through
// (\L, \O, \K). Wrapping and placement here follow those runs, so a title block cell that
// AutoCAD fills to the edge is filled to the same edge. Every text primitive carries the
// width it was laid out at; the viewer and SVG fit the drawn glyphs to that width, so a
// substituted font cannot push a line out of its box.

using System.Text;
using ACadSharp.Entities;
using ACadSharp.Tables;

/// <summary>A text face as drawn: family, weight, slant and a horizontal squeeze for narrow faces.</summary>
readonly record struct Face(bool Serif, bool Bold, bool Italic, double Squeeze)
{
	public static readonly Face Sans = new(false, false, false, 1);

	/// <summary>Font field of a text primitive: sans|serif, then |b, |i or |bi when styled.</summary>
	public string Code => (Serif ? "serif" : "sans") + (Bold || Italic ? "|" + (Bold ? "b" : "") + (Italic ? "i" : "") : "");

	/// <summary>A face from a font file or family name (arial.ttf, timesbd.ttf, Arial Narrow, romans.shx).</summary>
	public static Face FromName(string name, bool bold = false, bool italic = false)
	{
		var f = (name ?? "").ToLowerInvariant();
		bool serif = !f.Contains("sans") && (f.Contains("times") || f.Contains("georgia") || f.Contains("garamond")
			|| f.Contains("cambria") || f.Contains("palatino") || f.Contains("bookman") || f.Contains("book antiqua")
			|| f.Contains("century"));
		// arialbd.ttf, timesbd.ttf, ariblk.ttf, "Arial Black"; arialbi/timesbi carry both
		var stem = Path.GetFileNameWithoutExtension(f);
		bold |= f.Contains("bold") || f.Contains("black") || f.Contains("blk") || stem.EndsWith("bd") || stem.EndsWith("bi");
		italic |= f.Contains("italic") || f.Contains("oblique") || stem.EndsWith("bi") || (stem.Length > 4 && stem.EndsWith("i") && (stem.StartsWith("arial") || stem.StartsWith("times")));
		double squeeze = f.Contains("narrow") || f.Contains("condensed") || f.Contains("arialn") ? 0.82 : 1;
		return new Face(serif, bold, italic, squeeze);
	}

	public static Face Of(TextStyle st) => st == null ? Sans : FromName((st.Filename ?? "") + "|" + (st.Name ?? ""));
}

sealed partial class Payload
{
	// Advance widths, 1/1000 em, for ' '..'~', read from Liberation Sans and Liberation Serif
	// (metric-compatible with Arial and Times New Roman), regular and bold.
	static readonly short[] SansWidths = {
		278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
		556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
		1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
		667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
		333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
		556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
	};
	static readonly short[] SansBoldWidths = {
		278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
		556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
		975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
		667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
		333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
		611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
	};
	static readonly short[] SerifWidths = {
		250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
		500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
		921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
		556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
		333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
		500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
	};
	static readonly short[] SerifBoldWidths = {
		250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
		500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
		930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
		611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
		333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
		556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
	};
	// Em per capital height used for layout. AutoCAD draws a TrueType face so its capitals are
	// the text height: Arial's capitals are 1467/2048 em. Times was measured against an AutoCAD
	// plot (D1.1 title: h 26.81 drawn with a 39.5-unit em).
	const double SansEmPerCap = 2048.0 / 1467, SerifEmPerCap = 1.47;

	static double Advance(char c, Face f)
	{
		var tab = f.Serif ? (f.Bold ? SerifBoldWidths : SerifWidths) : (f.Bold ? SansBoldWidths : SansWidths);
		if (c >= ' ' && c <= '~') return tab[c - ' '];
		return c switch
		{
			' ' => tab[0],
			'°' => 400,
			'±' => f.Serif ? 564 : 584,
			'Ø' or 'ø' => f.Serif ? 722 : 778,
			'²' or '³' => f.Serif ? 300 : 333,
			_ => f.Serif ? 500 : 556,
		};
	}

	/// <summary>Width of text drawn at capital height h in face f, before any width factor.</summary>
	static double TextWidth(string s, double h, Face f)
	{
		double u = 0;
		foreach (var c in s) u += Advance(c, f);
		return u / 1000 * h * (f.Serif ? SerifEmPerCap : SansEmPerCap) * f.Squeeze;
	}

	// ------------------------------------------------------------------ TEXT

	/// <summary>
	/// TEXT control codes: %%u/%%o/%%k toggle under/overline and strike-through; %%d %%p %%c are
	/// degree, plus-minus and diameter; %%nnn is a character code. Returns the plain text and,
	/// per character, which decorations are on (bit 1 under, 2 over, 4 strike).
	/// </summary>
	static string TextPlain(string s, out byte[] deco)
	{
		deco = null;
		if (string.IsNullOrEmpty(s) || !s.Contains("%%")) return s ?? "";
		var sb = new StringBuilder(s.Length);
		var flags = new List<byte>(s.Length);
		byte on = 0;
		for (int i = 0; i < s.Length; i++)
		{
			if (s[i] != '%' || i + 2 >= s.Length || s[i + 1] != '%') { sb.Append(s[i]); flags.Add(on); continue; }
			char k = char.ToLowerInvariant(s[i + 2]);
			int n = 0, j = i + 2;
			while (j < s.Length && j < i + 5 && char.IsAsciiDigit(s[j])) n = n * 10 + (s[j++] - '0');
			if (j == i + 5) { sb.Append((char)n); flags.Add(on); i = j - 1; continue; }
			switch (k)
			{
				case 'u': on ^= 1; break;
				case 'o': on ^= 2; break;
				case 'k': on ^= 4; break;
				case 'd': sb.Append('°'); flags.Add(on); break;
				case 'p': sb.Append('±'); flags.Add(on); break;
				case 'c': sb.Append('Ø'); flags.Add(on); break;
				case '%': sb.Append('%'); flags.Add(on); break;
				default: sb.Append("%%").Append(s[i + 2]); flags.Add(on); flags.Add(on); flags.Add(on); break;
			}
			i += 2;
		}
		if (flags.Any(f => f != 0)) deco = flags.ToArray();
		return sb.ToString();
	}

	static string TextPlain(string s) => TextPlain(s, out _);

	void EmitText(TextEntity tx, int layer, int rgb, Affine t)
	{
		var text = TextPlain(tx.Value, out var deco);
		if (string.IsNullOrWhiteSpace(text) || !(tx.Height > 0)) return;
		NoteFont(tx.Style);
		var face = Face.Of(tx.Style);
		double h = tx.Height, wf = tx.WidthFactor > 0 ? tx.WidthFactor : 1, rot = tx.Rotation;
		var ins = tx.InsertPoint;
		var o = t.Then(Affine.Ocs(tx.Normal));
		var natural = TextWidth(text, h, face);
		string align;
		double x, y;
		if (tx.HorizontalAlignment is TextHorizontalAlignment.Aligned or TextHorizontalAlignment.Fit)
		{
			// The text spans the insert and alignment points: Aligned keeps proportions and
			// scales the height, Fit keeps the height and stretches the width.
			var al = tx.AlignmentPoint;
			double dx = al.X - ins.X, dy = al.Y - ins.Y, span = Math.Sqrt(dx * dx + dy * dy);
			if (span > 0 && natural > 0)
			{
				rot = Math.Atan2(dy, dx);
				if (tx.HorizontalAlignment == TextHorizontalAlignment.Aligned) h *= span / (natural * wf);
				else wf = span / natural;
				natural = TextWidth(text, h, face);
			}
			(x, y, align) = (ins.X, ins.Y, "lb");
		}
		else
		{
			var useAlign = tx.HorizontalAlignment != TextHorizontalAlignment.Left || tx.VerticalAlignment != TextVerticalAlignmentType.Baseline;
			var p = useAlign ? tx.AlignmentPoint : tx.InsertPoint;
			char ha = tx.HorizontalAlignment switch
			{
				TextHorizontalAlignment.Center or TextHorizontalAlignment.Middle => 'c',
				TextHorizontalAlignment.Right => 'r',
				_ => 'l',
			};
			char va = tx.HorizontalAlignment == TextHorizontalAlignment.Middle ? 'm' : tx.VerticalAlignment switch
			{
				TextVerticalAlignmentType.Middle => 'm',
				TextVerticalAlignmentType.Top => 't',
				_ => 'b',
			};
			(x, y, align) = (p.X, p.Y, $"{ha}{va}");
		}
		double width = natural * wf;
		PrimText(layer, rgb, x, y, h, rot, align, text, o, face, wf, width);
		if (deco == null) return;
		// Decoration lines run under the flagged characters, measured from the text's left end.
		double left = align[0] == 'c' ? -width / 2 : align[0] == 'r' ? -width : 0;
		double baseline = align[1] == 'm' ? -h / 2 : align[1] == 't' ? -h : 0;
		double cs = Math.Cos(rot), sn = Math.Sin(rot);
		for (int bit = 1; bit <= 4; bit <<= 1)
		{
			int i = 0;
			while (i < text.Length)
			{
				if ((deco[i] & bit) == 0) { i++; continue; }
				int j = i;
				while (j < text.Length && (deco[j] & bit) != 0) j++;
				double a = left + TextWidth(text[..i], h, face) * wf, b = left + TextWidth(text[..j], h, face) * wf;
				Decoration(layer, rgb, x, y, cs, sn, a, b, baseline, h, bit, o);
				i = j;
			}
		}
	}

	/// <summary>An underline (1), overline (2) or strike-through (4) from a to b along the text.</summary>
	void Decoration(int layer, int rgb, double x, double y, double cs, double sn, double a, double b, double baseline, double h, int kind, Affine t)
	{
		double off = baseline + (kind == 1 ? -0.2 * h : kind == 2 ? 1.25 * h : 0.5 * h);
		var pts = new List<(double, double)> { (x + a * cs - off * sn, y + a * sn + off * cs), (x + b * cs - off * sn, y + b * sn + off * cs) };
		var lt = _lt;
		_lt = -1;
		PrimPolyline(layer, rgb, false, pts, t);
		_lt = lt;
	}

	// ------------------------------------------------------------------ MTEXT

	sealed class Run
	{
		public Face Face;
		public double H, Wf = 1, Track = 1;
		public int Deco; // 1 under, 2 over, 4 strike
		public int Rgb;
		public Run Clone() => (Run)MemberwiseClone();
		public bool SameLook(Run o) => Face == o.Face && H == o.H && Wf == o.Wf && Track == o.Track && Deco == o.Deco && Rgb == o.Rgb;
	}

	/// <summary>MTEXT content as paragraphs of (character, run) pairs.</summary>
	static List<List<(char c, Run r)>> MTextRuns(string s, Run start, int entityRgb)
	{
		s = (s ?? "").Replace("%%d", "°").Replace("%%D", "°").Replace("%%p", "±").Replace("%%P", "±").Replace("%%c", "Ø").Replace("%%C", "Ø");
		var paras = new List<List<(char, Run)>> { new() };
		var stack = new Stack<Run>();
		var cur = start.Clone();
		string Arg(ref int i)
		{
			int end = s.IndexOf(';', i + 1);
			if (end < 0) end = s.Length;
			var a = s.Substring(i + 1, end - i - 1);
			i = end;
			return a;
		}
		static bool Num(string a, out double v, out bool rel)
		{
			rel = a.EndsWith('x') || a.EndsWith('X');
			if (rel) a = a[..^1];
			return double.TryParse(a, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v) && v > 0;
		}
		void Put(char c) => paras[^1].Add((c, cur));
		void Set(Action<Run> change) { cur = cur.Clone(); change(cur); }
		for (int i = 0; i < s.Length; i++)
		{
			char c = s[i];
			if (c == '{') { stack.Push(cur); continue; }
			if (c == '}') { if (stack.Count > 0) cur = stack.Pop(); continue; }
			if (c == '\r') continue;
			if (c == '\n') { paras.Add(new()); continue; }
			if (c != '\\' || i + 1 >= s.Length) { Put(c == '\t' ? ' ' : c); continue; }
			char k = s[++i];
			switch (k)
			{
				case 'P': case 'X': case 'N': paras.Add(new()); break;
				case '~': Put(' '); break;
				case '\\': case '{': case '}': Put(k); break;
				case 'L': Set(r => r.Deco |= 1); break;
				case 'l': Set(r => r.Deco &= ~1); break;
				case 'O': Set(r => r.Deco |= 2); break;
				case 'o': Set(r => r.Deco &= ~2); break;
				case 'K': Set(r => r.Deco |= 4); break;
				case 'k': Set(r => r.Deco &= ~4); break;
				case 'W': { if (Num(Arg(ref i), out var v, out var rel)) Set(r => r.Wf = rel ? r.Wf * v : v); break; }
				case 'T': { if (Num(Arg(ref i), out var v, out var rel)) Set(r => r.Track = rel ? r.Track * v : v); break; }
				case 'H': { if (Num(Arg(ref i), out var v, out var rel)) Set(r => r.H = rel ? r.H * v : v); break; }
				case 'f': case 'F':
					{
						// \fArial|b1|i0|c0|p34;  \Fromans.shx|c0;
						var parts = Arg(ref i).Split('|');
						bool bold = parts.Skip(1).Any(p => p == "b1"), italic = parts.Skip(1).Any(p => p == "i1");
						var face = Face.FromName(parts[0], bold, italic);
						Set(r => r.Face = face);
						break;
					}
				case 'C':
					{
						if (int.TryParse(Arg(ref i), out var aci))
						{
							int rgb = aci is <= 0 or >= 256 ? entityRgb : AciRgb(aci, entityRgb);
							Set(r => r.Rgb = rgb);
						}
						break;
					}
				case 'c': { if (int.TryParse(Arg(ref i), out var tc)) Set(r => r.Rgb = tc & 0xFFFFFF); break; }
				case 'S':
					{
						var a = Arg(ref i);
						foreach (var ch in a.Replace('^', '/').Replace('#', '/')) Put(ch);
						break;
					}
				case 'A': case 'Q': case 'p': Arg(ref i); break;
				case 'U' when i + 5 < s.Length && s[i + 1] == '+'
					&& int.TryParse(s.AsSpan(i + 2, 4), System.Globalization.NumberStyles.HexNumber, null, out var cp):
					Put((char)cp); i += 5; break;
				case 'M' when i + 6 < s.Length && s[i + 1] == '+': i += 6; break;
				default: Put('\\'); Put(k); break;
			}
		}
		return paras;
	}

	static int AciRgb(int aci, int fallback)
	{
		try
		{
			var c = new ACadSharp.Color((short)aci).GetRgb();
			return (c[0] << 16) | (c[1] << 8) | c[2];
		}
		catch { return fallback; }
	}

	static double Adv(char c, Run r) => TextWidth(c.ToString(), r.H, r.Face) * r.Wf * r.Track;

	/// <summary>Greedy word wrap, as AutoCAD does: break at spaces, never inside a word; spaces at a break are dropped.</summary>
	static List<List<(char c, Run r)>> WrapRuns(List<(char c, Run r)> para, double width)
	{
		var lines = new List<List<(char, Run)>>();
		var line = new List<(char, Run)>();
		double lineW = 0;
		int i = 0;
		while (i < para.Count)
		{
			int ws = i;
			while (i < para.Count && para[i].c == ' ') i++;
			int we = i;
			while (i < para.Count && para[i].c != ' ') i++;
			if (we == i) { line.AddRange(para.GetRange(ws, i - ws)); break; } // trailing spaces
			double spaces = 0, word = 0;
			for (int j = ws; j < we; j++) spaces += Adv(para[j].c, para[j].r);
			for (int j = we; j < i; j++) word += Adv(para[j].c, para[j].r);
			if (width > 0 && line.Count > 0 && lineW + spaces + word > width)
			{
				lines.Add(line);
				line = para.GetRange(we, i - we);
				lineW = word;
			}
			else
			{
				line.AddRange(para.GetRange(ws, i - ws));
				lineW += spaces + word;
			}
		}
		lines.Add(line);
		return lines;
	}

	/// <summary>
	/// Draws MTEXT run by run. Returns the laid-out extents in the text's own frame (x along the
	/// text direction from the insert point, y up), for frames drawn around it.
	/// </summary>
	(double x0, double y0, double x1, double y1)? EmitMText(MText m, int layer, int rgb, Affine t)
	{
		if (!(m.Height > 0)) return null;
		if ((m.Value ?? "").Contains("\\S")) Approximated("MTEXT stacked fractions (drawn inline)");
		if ((m.Value ?? "").Contains("\\Q")) Approximated("MTEXT oblique angle (not applied)");
		if ((m.Value ?? "").Contains("\\p")) Approximated("MTEXT paragraph formatting (basic word wrap)");
		var face = Face.Of(m.Style);
		var start = new Run { Face = face, H = m.Height, Wf = m.Style?.Width > 0 ? m.Style.Width : 1, Rgb = rgb };
		var lines = new List<List<(char c, Run r)>>();
		foreach (var para in MTextRuns(m.Value, start, rgb)) lines.AddRange(WrapRuns(para, m.RectangleWidth));
		// drop trailing spaces; an all-blank MTEXT draws nothing
		foreach (var l in lines) while (l.Count > 0 && l[^1].c == ' ') l.RemoveAt(l.Count - 1);
		if (lines.All(l => l.All(x => char.IsWhiteSpace(x.c)))) return null;
		// inline \f/\F switches usually replace the style's SHX font with a TrueType one
		if (!(m.Value ?? "").Contains("\\f") && !(m.Value ?? "").Contains("\\F")) NoteFont(m.Style);

		double rot = Math.Atan2(m.AlignmentPoint.Y, m.AlignmentPoint.X);
		double factor = m.LineSpacing > 0 ? m.LineSpacing : 1;
		var heights = lines.Select(l => l.Count > 0 ? l.Max(x => x.r.H) : m.Height).ToArray();
		// baselines below the top of the first line's capitals; AutoCAD spaces lines at 5/3 of the text height
		var baselines = new double[lines.Count];
		baselines[0] = heights[0];
		for (int i = 1; i < lines.Count; i++)
			baselines[i] = baselines[i - 1] + 1.6667 * factor * (m.LineSpacingStyle == LineSpacingStyleType.Exact ? m.Height : heights[i]);
		double total = baselines[^1];
		var ap = m.AttachmentPoint.ToString(); // TopLeft, MiddleCenter, BottomRight, ...
		char ha = ap.EndsWith("Center") ? 'c' : ap.EndsWith("Right") ? 'r' : 'l';
		double top = ap.StartsWith("Top") ? 0 : ap.StartsWith("Middle") ? total / 2 : total; // top of the block above the insert point
		var o = t.Then(Affine.Ocs(m.Normal));
		double cs = Math.Cos(rot), sn = Math.Sin(rot);
		double ex0 = double.PositiveInfinity, ey0 = double.PositiveInfinity, ex1 = double.NegativeInfinity, ey1 = double.NegativeInfinity;
		for (int li = 0; li < lines.Count; li++)
		{
			var line = lines[li];
			double lineW = line.Sum(x => Adv(x.c, x.r));
			double x = ha == 'c' ? -lineW / 2 : ha == 'r' ? -lineW : 0;
			double y = top - baselines[li];
			if (line.Count > 0)
			{
				ex0 = Math.Min(ex0, x); ex1 = Math.Max(ex1, x + lineW);
				ey0 = Math.Min(ey0, y); ey1 = Math.Max(ey1, y + heights[li]);
			}
			int i = 0;
			while (i < line.Count)
			{
				var r = line[i].r;
				int j = i;
				var sb = new StringBuilder();
				double w = 0;
				while (j < line.Count && line[j].r.SameLook(r)) { sb.Append(line[j].c == ' ' ? ' ' : line[j].c); w += Adv(line[j].c, r); j++; }
				var px = m.InsertPoint.X + x * cs - y * sn;
				var py = m.InsertPoint.Y + x * sn + y * cs;
				PrimText(layer, r.Rgb, px, py, r.H, rot, "lb", sb.ToString(), o, r.Face, r.Wf * r.Track, w);
				for (int bit = 1; bit <= 4; bit <<= 1)
					if ((r.Deco & bit) != 0) Decoration(layer, r.Rgb, px, py, cs, sn, 0, w, 0, r.H, bit, o);
				x += w;
				i = j;
			}
		}
		return ex0 <= ex1 ? (ex0, ey0, ex1, ey1) : null;
	}
}
