// Clipping calculation adapted from ACadSharp 3.8.0 Hatch.ExplodePattern (MIT).
// Copyright (c) 2021 Albert Domenech; see licenses/ACadSharp-MIT.txt.
// Continuous hatches need segment coordinates, not a full CAD Line object per segment.
// Dashed hatches retain ACadSharp clipping and the existing dash phases, but share
// the same bounded preparation queue instead of blocking serial emission.
// Retain ACadSharp's intersections, parameter merging and midpoint parity calculation,
// including its tolerances, so this avoids allocation without changing clipping semantics.
using ACadSharp.Entities;
using CSMath;
using CSMath.Extensions;
using CSMath.Geometry;

sealed partial class Payload
{
	readonly List<Hatch> _hatchOrder = new();
	readonly Dictionary<Hatch, int> _hatchPosition = new();
	readonly Dictionary<Hatch, Task<List<(double, double, double, double)>>> _preparingHatches = new();
	readonly SemaphoreSlim _hatchWorkers = new(Math.Min(4, Environment.ProcessorCount));

	// Keep a small look-ahead window. Clipping is independent of drawing emission;
	// the drawing-wide budget is still applied in the original serial emission order.
	void PrepareHatches(IEnumerable<Entity> entities)
	{
		var blocks = new HashSet<ACadSharp.Tables.BlockRecord>();
		void Visit(IEnumerable<Entity> source, int depth) {
			if (depth > 16) return;
			foreach (var entity in source) {
				if (entity.IsInvisible) continue;
				if (entity is Insert insert && insert.Block != null && blocks.Add(insert.Block)) Visit(insert.Block.Entities, depth + 1);
				if (entity is not Hatch hatch || hatch.IsSolid || hatch.GradientColor?.Enabled == true || _hatchPosition.ContainsKey(hatch)) continue;
				var lines = hatch.Pattern?.Lines;
				if (lines == null || lines.Count == 0) continue;
				_hatchPosition.Add(hatch, _hatchOrder.Count);
				_hatchOrder.Add(hatch);
			}
		}
		Visit(entities, 0);
	}

	List<(double, double, double, double)> PreparedPattern(Hatch hatch)
	{
		if (!_hatchPosition.TryGetValue(hatch, out int position)) return ComputePattern(hatch, _patternBudget);
		// Cheap hatches between expensive ones must not leave workers idle. Queue
		// at most sixteen results; the semaphore still limits active work to four.
		int window = 4 * Math.Min(4, Environment.ProcessorCount);
		// An earlier look-ahead entry may have been rejected by the serial density
		// or remaining-budget guard. Do not retain its result for the rest of the file.
		foreach (var skipped in _preparingHatches.Keys.Where(h => _hatchPosition[h] < position).ToArray()) _preparingHatches.Remove(skipped);
		for (int i = position; i < Math.Min(_hatchOrder.Count, position + window); i++) {
			var next = _hatchOrder[i];
			if (_patterns.ContainsKey(next) || _preparingHatches.ContainsKey(next)) continue;
			_preparingHatches.Add(next, Task.Run(() => {
				_hatchWorkers.Wait();
				try {
					// Apply the same density guard as serial emission before clipping
					// a future hatch, including those the budget will later reject.
					var bb = next.GetBoundingBox();
					double diag = Math.Sqrt(Math.Pow(bb.Max.X - bb.Min.X, 2) + Math.Pow(bb.Max.Y - bb.Min.Y, 2));
					double estimate = 0;
					foreach (var line in next.Pattern.Lines) {
						double perp = Math.Abs(-Math.Sin(line.Angle) * line.Offset.X + Math.Cos(line.Angle) * line.Offset.Y);
						estimate += perp > 0 ? diag / perp : double.PositiveInfinity;
					}
					return estimate <= PatternLimit ? ComputePattern(next, PatternLimit) : null;
				}
				catch { return null; }
				finally { _hatchWorkers.Release(); }
			}));
		}
		var result = _preparingHatches[hatch].GetAwaiter().GetResult();
		_preparingHatches.Remove(hatch);
		return result;
	}

	static List<(double, double, double, double)> ComputePattern(Hatch hatch, int budget)
	{
		var lines = hatch.Pattern.Lines;
		if (lines.All(l => l.DashLengths == null || l.DashLengths.Count == 0)) return ContinuousPattern(hatch, budget);
		var result = new List<(double, double, double, double)>();
		foreach (var seg in hatch.ExplodePattern()) {
			if (seg is not Line l) continue;
			Dash(result, l.StartPoint.X, l.StartPoint.Y, l.EndPoint.X, l.EndPoint.Y, lines);
			if (result.Count > PatternLimit || result.Count > budget) return null;
		}
		return result;
	}

	static List<(double, double, double, double)> ContinuousPattern(Hatch hatch, int budget)
	{
		var result = new List<(double, double, double, double)>();
		var edges = hatch.Paths.SelectMany(p => p.Edges).ToArray();
		var segments = edges.OfType<Hatch.BoundaryPath.Line>().Select(e => (geometry: e.ToSegment2D(), a: e.Start, b: e.End)).ToArray();
		var other = edges.Where(e => e is not Hatch.BoundaryPath.Line).ToArray();
		// Reuse parameter buffers: midpoint parity is evaluated for every candidate
		// segment, so iterator chains and sorted-list allocations dominate on dense hatches.
		void Parameters(XY origin, XY direction, List<double> values, bool ray = false) {
			values.Clear();
			var line = new Line2D(origin, direction);
			void Add(XY hit) {
				if (ray) {
					if (hit.X >= origin.X - MathHelper.Epsilon) values.Add(hit.X);
				} else values.Add((hit.X - origin.X) * direction.X + (hit.Y - origin.Y) * direction.Y);
			}
			foreach (var segment in segments) {
				// Reject edges strictly on one side before invoking the general geometry
				// routine. A generous margin leaves all near-boundary decisions to it.
				double a = (segment.a.X - origin.X) * direction.Y - (segment.a.Y - origin.Y) * direction.X;
				double b = (segment.b.X - origin.X) * direction.Y - (segment.b.Y - origin.Y) * direction.X;
				if (a > .001 && b > .001 || a < -.001 && b < -.001) continue;
				if (segment.geometry.TryFindIntersection(line, out XY hit)) Add(hit);
			}
			foreach (var edge in other)
				foreach (var hit in edge.FindIntersections(line)) Add(hit);
			MergePatternParameters(values);
		}
		var hits = new List<double>();
		var crossings = new List<double>();
		var box = hatch.GetBoundingBox();
		XY[] corners = { new(box.Min.X, box.Min.Y), new(box.Min.X, box.Max.Y), new(box.Max.X, box.Min.Y), new(box.Max.X, box.Max.Y) };
		foreach (var family in hatch.Pattern.Lines)
		{
			var direction = family.Direction;
			if (direction.IsZero()) continue;
			var normal = new XY(-direction.Y, direction.X);
			var projections = corners.Select(p => p.X * normal.X + p.Y * normal.Y).ToArray();
			double origin = family.BasePoint.X * normal.X + family.BasePoint.Y * normal.Y;
			int first = 0, last = 0;
			if (Math.Abs(family.LineOffset) > MathHelper.Epsilon)
			{
				double a = (projections.Min() - origin) / family.LineOffset;
				double b = (projections.Max() - origin) / family.LineOffset;
				first = (int)Math.Floor(Math.Min(a, b)) - 1;
				last = (int)Math.Ceiling(Math.Max(a, b)) + 1;
			}
			for (int row = first; row <= last; row++)
			{
				var start = new XY(family.BasePoint.X + family.Offset.X * row, family.BasePoint.Y + family.Offset.Y * row);
				var line = new Line2D(start, direction);
				Parameters(start, direction, hits);
				for (int i = 0; i + 1 < hits.Count; i++)
				{
					double a = hits[i], b = hits[i + 1];
					if (b - a <= MathHelper.Epsilon) continue;
					var mid = line.PointInLine(0.5 * (a + b));
					var rayStart = new XY(mid.X, mid.Y + 1e-7);
					Parameters(rayStart, XY.AxisX, crossings, true);
					if (crossings.Count % 2 == 0) continue;
					var from = line.PointInLine(a); var to = line.PointInLine(b);
					result.Add((from.X, from.Y, to.X, to.Y));
					if (result.Count > PatternLimit || result.Count > budget) return null;
				}
			}
		}
		return result;
	}

	static void MergePatternParameters(List<double> values)
	{
		values.Sort();
		int count = 0;
		for (int i = 0; i < values.Count; i++)
		{
			double value = values[i];
			if (count > 0 && Math.Abs(value - values[count - 1]) <= MathHelper.Epsilon)
				values[count - 1] = 0.5 * (values[count - 1] + value);
			else values[count++] = value;
		}
		values.RemoveRange(count, values.Count - count);
	}
}
