import type { Bbox, Entity } from "./types.ts";

export type Pt = [number, number];

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function bboxOfPoints(pts: Pt[]): Bbox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export function unionBbox(boxes: (Bbox | undefined)[]): Bbox | undefined {
  let out: Bbox | undefined;
  for (const b of boxes) {
    if (!b) continue;
    if (!out) out = [...b] as Bbox;
    else out = [Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.max(out[2], b[2]), Math.max(out[3], b[3])];
  }
  return out;
}

export function padBbox(b: Bbox, frac = 0.15, min = 1): Bbox {
  const p = Math.max(min, Math.max(b[2] - b[0], b[3] - b[1]) * frac);
  return [b[0] - p, b[1] - p, b[2] + p, b[3] + p];
}

export function bboxAround(p: Pt, r: number): Bbox {
  return [p[0] - r, p[1] - r, p[0] + r, p[1] + r];
}

export function contains(outer: Bbox, inner: Bbox, tol = 0): boolean {
  return inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol && inner[2] <= outer[2] + tol && inner[3] <= outer[3] + tol;
}

export function pointIn(b: Bbox, p: Pt): boolean {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

export function intersects(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function polyDist(p: Pt, flat: number[]): number {
  let best = Infinity;
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const d = segDist(p, [flat[i], flat[i + 1]], [flat[i + 2], flat[i + 3]]);
    if (d < best) best = d;
  }
  if (flat.length === 2) best = dist(p, [flat[0], flat[1]]);
  return best;
}

/** Distance to the nearest segment of a polyline, with that segment's direction in degrees [0,180). */
export function nearestSegment(p: Pt, flat: number[]): { d: number; deg: number } {
  let best = Infinity, deg = 0;
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const d = segDist(p, [flat[i], flat[i + 1]], [flat[i + 2], flat[i + 3]]);
    if (d < best) {
      best = d;
      deg = ((Math.atan2(flat[i + 3] - flat[i + 1], flat[i + 2] - flat[i]) * 180) / Math.PI + 360) % 180;
    }
  }
  return { d: best, deg };
}

/** Difference between two line directions in degrees, ignoring which way they point (0..90). */
export function lineAngleDiff(a: number, b: number): number {
  const d = Math.abs((((a - b) % 180) + 180) % 180);
  return Math.min(d, 180 - d);
}

export function polyPoints(e: Entity): Pt[] {
  const f = e.verts ?? e.pts ?? [];
  const out: Pt[] = [];
  for (let i = 0; i + 1 < f.length; i += 2) out.push([f[i], f[i + 1]]);
  return out;
}

/** Point along a polyline at fraction t of its length, with the segment direction. */
export function pointAlong(flat: number[], t: number): { p: Pt; dir: Pt } {
  let total = 0;
  const seg: number[] = [];
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const l = Math.hypot(flat[i + 2] - flat[i], flat[i + 3] - flat[i + 1]);
    seg.push(l);
    total += l;
  }
  let target = total * t;
  for (let k = 0; k < seg.length; k++) {
    const i = k * 2;
    if (target <= seg[k] || k === seg.length - 1) {
      const f = seg[k] > 0 ? Math.min(1, target / seg[k]) : 0;
      const dx = flat[i + 2] - flat[i], dy = flat[i + 3] - flat[i + 1];
      const L = Math.hypot(dx, dy) || 1;
      return { p: [flat[i] + dx * f, flat[i + 1] + dy * f], dir: [dx / L, dy / L] };
    }
    target -= seg[k];
  }
  return { p: [flat[0], flat[1]], dir: [1, 0] };
}

/** Uniform grid over items with a point or box. Query by box. */
export class Grid<T> {
  private cells = new Map<string, T[]>();
  private readonly size: number;
  constructor(cellSize: number) {
    this.size = cellSize > 0 && Number.isFinite(cellSize) ? cellSize : 1;
  }
  private k(ix: number, iy: number) {
    return ix + "," + iy;
  }
  insert(item: T, b: Bbox) {
    const s = this.size;
    const x0 = Math.floor(b[0] / s), x1 = Math.floor(b[2] / s), y0 = Math.floor(b[1] / s), y1 = Math.floor(b[3] / s);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) {
      // very large items go in a shared bucket rather than thousands of cells
      const big = this.cells.get("big") ?? [];
      big.push(item);
      this.cells.set("big", big);
      return;
    }
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++) {
        const key = this.k(ix, iy);
        const arr = this.cells.get(key);
        if (arr) arr.push(item);
        else this.cells.set(key, [item]);
      }
  }
  query(b: Bbox): T[] {
    const s = this.size;
    const out = new Set<T>(this.cells.get("big") ?? []);
    const x0 = Math.floor(b[0] / s), x1 = Math.floor(b[2] / s), y0 = Math.floor(b[1] / s), y1 = Math.floor(b[3] / s);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 1_000_000) {
      for (const arr of this.cells.values()) for (const it of arr) out.add(it);
      return [...out];
    }
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++) {
        const arr = this.cells.get(this.k(ix, iy));
        if (arr) for (const it of arr) out.add(it);
      }
    return [...out];
  }
}

/**
 * One-to-one matching that keeps the total cost low: greedy by ascending cost, then pairwise
 * swaps while a swap lowers the sum. Nearest-first alone mislabels crowded spots, where one
 * label sits nearer a neighbour's symbol than its own.
 */
export function greedyMatch<A, B>(pairs: { a: A; b: B; d: number }[]): Map<A, { b: B; d: number }> {
  pairs.sort((x, y) => x.d - y.d);
  const cost = new Map<A, Map<B, number>>();
  for (const p of pairs) {
    const m = cost.get(p.a) ?? new Map<B, number>();
    if (!m.has(p.b)) m.set(p.b, p.d);
    cost.set(p.a, m);
  }
  const usedB = new Map<B, A>();
  const out = new Map<A, { b: B; d: number }>();
  for (const p of pairs) {
    if (out.has(p.a) || usedB.has(p.b)) continue;
    out.set(p.a, { b: p.b, d: p.d });
    usedB.set(p.b, p.a);
  }
  // Augment: an unmatched a takes b from its holder when the holder can move to a free b'.
  for (const [a0, opts] of cost) {
    if (out.has(a0)) continue;
    let best: { b: B; a1: A; b1: B; d0: number; d1: number; extra: number } | null = null;
    for (const [b, d0] of opts) {
      const a1 = usedB.get(b);
      if (a1 === undefined) continue; // a free b would have been taken by the greedy pass
      for (const [b1, d1] of cost.get(a1)!) {
        if (usedB.has(b1)) continue;
        const extra = d0 + d1 - out.get(a1)!.d;
        if (!best || extra < best.extra) best = { b, a1, b1, d0, d1, extra };
      }
    }
    if (best) {
      out.set(best.a1, { b: best.b1, d: best.d1 });
      usedB.set(best.b1, best.a1);
      out.set(a0, { b: best.b, d: best.d0 });
      usedB.set(best.b, a0);
    }
  }
  // 2-opt: for a1->b1, try every b2 a1 could take; if b2 is held by a2 and a2 can take b1,
  // swap when that is cheaper. If b2 is free, move a1 there when cheaper.
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const [a1, m1] of out) {
      const opts = cost.get(a1)!;
      for (const [b2, d12] of opts) {
        if (b2 === m1.b) continue;
        const a2 = usedB.get(b2);
        if (a2 === undefined) {
          if (d12 < m1.d - 1e-9) {
            usedB.delete(m1.b);
            out.set(a1, { b: b2, d: d12 });
            usedB.set(b2, a1);
            changed = true;
            break;
          }
          continue;
        }
        const d21 = cost.get(a2)?.get(m1.b);
        if (d21 === undefined) continue;
        const m2 = out.get(a2)!;
        if (d12 + d21 < m1.d + m2.d - 1e-9) {
          const b1 = m1.b;
          out.set(a1, { b: b2, d: d12 });
          out.set(a2, { b: b1, d: d21 });
          usedB.set(b2, a1);
          usedB.set(b1, a2);
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  return out;
}
