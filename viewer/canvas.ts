// Canvas renderer for a drawkit payload. Framework-free so it can move into another host
// (the Omakase renderer) unchanged: give it a canvas, a payload, and call draw().
//
// Strokes and fills are batched into Path2D objects per (tile, layer, colour) in drawing
// coordinates, so a frame is a few hundred stroke() calls whatever the entity count. Text is
// drawn per item in screen space and skipped once it is too small to read.

import type { Bbox, Drawing, Finding, Prim } from "../src/types.ts";

export interface Theme {
  bg: string;
  ink: string; // replaces ACI white/black
  grid: string;
  select: string;
  sev: Record<"error" | "warning" | "info", string>;
}

export const DARK: Theme = {
  bg: "#15171c",
  ink: "#e6e6e6",
  grid: "#22252c",
  select: "#00e5ff",
  sev: { error: "#ff453a", warning: "#ffb340", info: "#5ac8fa" },
};

interface Batch {
  layer: number;
  color: string;
  kind: "stroke" | "fillSolid" | "fillPattern" | "dot";
  path: Path2D;
  maxSize: number; // upper bound on primitive size in this batch; enables subpixel culling
  dots: number[];
}

interface Tile {
  bbox: Bbox;
  batches: Batch[];
  texts: number[]; // prim indexes
}

interface RasterTile {
  canvas: HTMLCanvasElement;
  labels: number;
}

const RASTER_SIZE = 256;
const RASTER_BLEED = 3;

type Rgb = number;

function cssColor(rgb: Rgb, theme: Theme): string {
  if (rgb === 0xffffff || rgb === 0) return theme.ink;
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  // lift colours that would vanish on a dark background
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum < 0.18) {
    const k = 0.18 / Math.max(lum, 0.02);
    return `rgb(${Math.min(255, r * k + 40)},${Math.min(255, g * k + 40)},${Math.min(255, b * k + 40)})`;
  }
  return `rgb(${r},${g},${b})`;
}

export class DrawingCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  theme: Theme = DARK;
  drawing: Drawing | null = null;
  private tiles: Tile[] = [];
  private primBox: Float64Array = new Float64Array(0); // 4 per prim, relative coords
  private entPrims: number[][] = [];
  private hitGrid = new Map<string, number[]>();
  private hitCell = 1;
  private extents: Bbox = [0, 0, 1, 1];
  hiddenLayers = new Set<number>();
  /** view: screen = (rel - centre) * scale + half size; y up */
  cx = 0;
  cy = 0;
  scale = 1;
  selected = new Set<number>(); // entity indexes
  findings: Finding[] = [];
  activeFinding: Finding | null = null;
  showAllFindings = false;
  onView: (() => void) | null = null;
  private dpr = 1;
  private raf = 0;
  private zoomMotion: { x: number; y: number; scale: number; time: number } | null = null;
  private rasters = new Map<string, RasterTile>();
  private sceneKey = "";
  private rasterOriginX = 0;
  private rasterOriginY = 0;
  private drawingVersion = 0;
  lastDrawMs = 0;
  lastTextCount = 0;
  viewRevision = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  private resize() {
    this.dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.request();
  }

  get width() {
    return this.canvas.width / this.dpr;
  }
  get height() {
    return this.canvas.height / this.dpr;
  }

  // ------------------------------------------------------------------ loading

  setDrawing(d: Drawing) {
    this.drawingVersion++;
    this.drawing = d;
    this.selected.clear();
    this.findings = [];
    this.activeFinding = null;
    const n = d.prims.length;
    const box = new Float64Array(n * 4);
    this.entPrims = d.entities.map(() => []);
    for (let i = 0; i < n; i++) {
      const b = primBbox(d.prims[i]);
      box.set(b, i * 4);
      this.entPrims[d.prims[i][1]]?.push(i);
    }
    this.primBox = box;
    this.extents = this.extentsRel();
    this.buildTiles();
    this.buildHitGrid();
    this.fit();
  }

  private extentsRel(): Bbox {
    // robust extents: 0.5..99.5 percentile of prim centres, so a stray entity far away
    // does not shrink the drawing to a dot
    const n = this.drawing!.prims.length;
    if (!n) return [0, 0, 1, 1];
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = (this.primBox[i * 4] + this.primBox[i * 4 + 2]) / 2;
      ys[i] = (this.primBox[i * 4 + 1] + this.primBox[i * 4 + 3]) / 2;
    }
    xs.sort();
    ys.sort();
    const q = (a: Float64Array, f: number) => a[Math.min(a.length - 1, Math.floor(f * (a.length - 1)))];
    return [q(xs, 0.005), q(ys, 0.005), q(xs, 0.995), q(ys, 0.995)];
  }

  private buildTiles() {
    const d = this.drawing!;
    const ext = this.extents;
    const N = 32;
    const w = Math.max(ext[2] - ext[0], 1e-9) / N, h = Math.max(ext[3] - ext[1], 1e-9) / N;
    const tileIdx = (i: number) => {
      const b = this.primBox.subarray(i * 4, i * 4 + 4);
      const big = b[2] - b[0] > w * 2 || b[3] - b[1] > h * 2;
      if (big) return N * N; // large prims share one tile
      const tx = Math.min(N - 1, Math.max(0, Math.floor(((b[0] + b[2]) / 2 - ext[0]) / w)));
      const ty = Math.min(N - 1, Math.max(0, Math.floor(((b[1] + b[3]) / 2 - ext[1]) / h)));
      return ty * N + tx;
    };
    const tiles: Tile[] = Array.from({ length: N * N + 1 }, () => ({ bbox: [Infinity, Infinity, -Infinity, -Infinity] as Bbox, batches: [], texts: [] }));
    const batchMaps: Map<string, Batch>[] = tiles.map(() => new Map());
    d.prims.forEach((p, i) => {
      if (this.isDefinitionPoint(p)) return;
      const t = tileIdx(i);
      const tile = tiles[t];
      const b = this.primBox.subarray(i * 4, i * 4 + 4);
      tile.bbox = [Math.min(tile.bbox[0], b[0]), Math.min(tile.bbox[1], b[1]), Math.max(tile.bbox[2], b[2]), Math.max(tile.bbox[3], b[3])];
      if (p[0] === "t") {
        tile.texts.push(i);
        return;
      }
      const kind: Batch["kind"] = p[0] === "f" ? (p[4] ? "fillSolid" : "fillPattern") : p[0] === "d" ? "dot" : "stroke";
      const color = cssColor(p[3], this.theme);
      const size = Math.max(b[2] - b[0], b[3] - b[1], 1e-12);
      const maxSize = p[0] === "d" ? Infinity : 2 ** Math.ceil(Math.log2(size));
      const key = `${p[2]}|${color}|${kind}|${maxSize}`;
      let batch = batchMaps[t].get(key);
      if (!batch) {
        batch = { layer: p[2], color, kind, maxSize, path: new Path2D(), dots: [] };
        batchMaps[t].set(key, batch);
        tile.batches.push(batch);
      }
      if (p[0] === "d") batch.dots.push(p[4], p[5]);
      else addPrimToPath(batch.path, p);
    });
    this.tiles = tiles.filter((t) => t.batches.length || t.texts.length);
  }

  private buildHitGrid() {
    const ext = this.extents;
    this.hitCell = Math.max(ext[2] - ext[0], ext[3] - ext[1], 1e-6) / 256;
    const g = new Map<string, number[]>();
    const n = this.drawing!.prims.length;
    for (let i = 0; i < n; i++) {
      if (this.isDefinitionPoint(this.drawing!.prims[i])) continue;
      const b = this.primBox.subarray(i * 4, i * 4 + 4);
      const x0 = Math.floor(b[0] / this.hitCell), x1 = Math.floor(b[2] / this.hitCell), y0 = Math.floor(b[1] / this.hitCell), y1 = Math.floor(b[3] / this.hitCell);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 2048) {
        const big = g.get("big") ?? [];
        big.push(i);
        g.set("big", big);
        continue;
      }
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          const k = x + "," + y;
          const arr = g.get(k);
          if (arr) arr.push(i);
          else g.set(k, [i]);
        }
    }
    this.hitGrid = g;
  }

  // ------------------------------------------------------------------ view

  fit(b?: Bbox, pad = 0.04) {
    this.cancelZoom();
    const r = b ? this.toRel(b) : this.extents;
    const w = Math.max(r[2] - r[0], 1e-9), h = Math.max(r[3] - r[1], 1e-9);
    this.cx = (r[0] + r[2]) / 2;
    this.cy = (r[1] + r[3]) / 2;
    this.scale = Math.min(this.width / (w * (1 + 2 * pad)), this.height / (h * (1 + 2 * pad)));
    this.viewRevision++;
    this.request();
  }

  /** world (absolute) bbox -> relative */
  toRel(b: Bbox): Bbox {
    const [ox, oy] = this.drawing!.origin;
    return [b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy];
  }

  screenToRel(sx: number, sy: number): [number, number] {
    return [(sx - this.width / 2) / this.scale + this.cx, -(sy - this.height / 2) / this.scale + this.cy];
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    const [x, y] = this.screenToRel(sx, sy);
    const [ox, oy] = this.drawing?.origin ?? [0, 0];
    return [x + ox, y + oy];
  }

  relToScreen(x: number, y: number): [number, number] {
    return [(x - this.cx) * this.scale + this.width / 2, -(y - this.cy) * this.scale + this.height / 2];
  }

  zoomAt(sx: number, sy: number, factor: number) {
    this.cancelZoom();
    this.applyZoom(sx, sy, factor);
    this.request();
  }

  /** Accumulate wheel input and ease towards it, preserving the cursor anchor. */
  smoothZoomAt(sx: number, sy: number, factor: number) {
    this.zoomMotion = {
      x: sx, y: sy,
      scale: Math.max(1e-7, Math.min(1e7, (this.zoomMotion?.scale ?? this.scale) * factor)),
      time: this.zoomMotion?.time ?? performance.now(),
    };
    this.request();
  }

  cancelZoom() {
    this.zoomMotion = null;
  }

  private applyZoom(sx: number, sy: number, factor: number) {
    const [x, y] = this.screenToRel(sx, sy);
    this.scale = Math.max(1e-7, Math.min(1e7, this.scale * factor));
    // keep the point under the cursor fixed
    this.cx = x - (sx - this.width / 2) / this.scale;
    this.cy = y + (sy - this.height / 2) / this.scale;
    this.viewRevision++;
  }

  panBy(dx: number, dy: number) {
    this.cancelZoom();
    this.cx -= dx / this.scale;
    this.cy += dy / this.scale;
    this.viewRevision++;
    this.request();
  }

  visibleRel(): Bbox {
    const [x0, y1] = this.screenToRel(0, 0);
    const [x1, y0] = this.screenToRel(this.width, this.height);
    return [x0, y0, x1, y1];
  }

  // ------------------------------------------------------------------ picking

  /** Nearest entity index to a screen point, within tolerance px. */
  pick(sx: number, sy: number, tolPx = 6): number | null {
    if (!this.drawing) return null;
    const [x, y] = this.screenToRel(sx, sy);
    const tol = tolPx / this.scale;
    const c = this.hitCell;
    const cand = new Set<number>(this.hitGrid.get("big") ?? []);
    const gx0 = Math.floor((x - tol) / c), gx1 = Math.floor((x + tol) / c);
    const gy0 = Math.floor((y - tol) / c), gy1 = Math.floor((y + tol) / c);
    // At extreme zoom-out, scanning empty grid cells can otherwise freeze the tab.
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 4096) {
      for (let i = 0; i < this.drawing.prims.length; i++) cand.add(i);
    } else {
      for (let gx = gx0; gx <= gx1; gx++)
        for (let gy = gy0; gy <= gy1; gy++) for (const i of this.hitGrid.get(gx + "," + gy) ?? []) cand.add(i);
    }
    let best: number | null = null, bd = Infinity, barea = Infinity;
    for (const i of cand) {
      const p = this.drawing.prims[i];
      if (this.hiddenLayers.has(p[2]) || this.isDefinitionPoint(p)) continue;
      const d = primDistance(p, x, y, this.primBox.subarray(i * 4, i * 4 + 4));
      if (d > tol) continue;
      const b = this.primBox.subarray(i * 4, i * 4 + 4);
      const area = (b[2] - b[0]) * (b[3] - b[1]);
      // prefer the closest; among ties (inside fills/texts) prefer the smallest
      if (d < bd - tol * 0.25 || (Math.abs(d - bd) <= tol * 0.25 && area < barea)) {
        bd = d;
        barea = area;
        best = p[1];
      }
    }
    return best;
  }

  entityBbox(ent: number): Bbox | undefined {
    return this.drawing?.entities[ent]?.bbox;
  }

  // ------------------------------------------------------------------ drawing

  request() {
    if (this.raf) return;
    // rAF does not fire in hidden tabs (and some automation hosts); fall back to a timer there
    const run = () => {
      this.raf = 0;
      const motion = this.zoomMotion;
      if (motion) {
        const now = performance.now();
        const remaining = Math.log(motion.scale / this.scale);
        const done = Math.abs(remaining) < 0.001;
        const fraction = 1 - Math.exp(-Math.max(1, now - motion.time) / 40);
        this.applyZoom(motion.x, motion.y, done ? motion.scale / this.scale : Math.exp(remaining * fraction));
        motion.time = now;
        if (done) this.zoomMotion = null;
      }
      this.draw();
      if (this.zoomMotion) this.request();
    };
    this.raf = document.hidden ? window.setTimeout(run, 16) : requestAnimationFrame(run);
  }

  draw() {
    const t0 = performance.now();
    const ctx = this.ctx;
    const { theme } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    const d = this.drawing;
    if (!d) return;
    const vis = this.visibleRel();
    const s = this.scale;
    const screen = () => ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const onScreen = (b: ArrayLike<number>) => b[0] <= vis[2] && b[2] >= vis[0] && b[1] <= vis[3] && b[3] >= vis[1];

    // Anchor raster tiles to drawing space at this scale. Long pans render only newly
    // exposed tiles; crossing a cache boundary never repaints the whole viewport.
    const left = this.cx * s - this.width / 2, top = -this.cy * s - this.height / 2;
    const key = `${this.drawingVersion}|${this.canvas.width}|${this.canvas.height}|${this.dpr}|${s}|${[...this.hiddenLayers].sort().join(",")}|${[...this.selected].join(",")}|${JSON.stringify(theme)}`;
    if (key !== this.sceneKey) {
      for (const tile of this.rasters.values()) tile.canvas.width = tile.canvas.height = 1;
      this.rasters.clear();
      this.sceneKey = key;
      // Align the initial grid to the viewport so a fresh fit/zoom keeps text sharp.
      this.rasterOriginX = left;
      this.rasterOriginY = top;
    }
    const x0 = Math.floor((left - this.rasterOriginX) / RASTER_SIZE), x1 = Math.ceil((left - this.rasterOriginX + this.width) / RASTER_SIZE) - 1;
    const y0 = Math.floor((top - this.rasterOriginY) / RASTER_SIZE), y1 = Math.ceil((top - this.rasterOriginY + this.height) / RASTER_SIZE) - 1;
    const visible = new Set<string>();
    let labels = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const id = `${x},${y}`;
        const tileLeft = this.rasterOriginX + x * RASTER_SIZE, tileTop = this.rasterOriginY + y * RASTER_SIZE;
        visible.add(id);
        let tile = this.rasters.get(id);
        if (!tile) tile = this.renderRaster(tileLeft, tileTop);
        // Refresh insertion order for bounded LRU eviction after compositing.
        this.rasters.delete(id);
        this.rasters.set(id, tile);
        labels += tile.labels;
        ctx.drawImage(tile.canvas, tileLeft - left - RASTER_BLEED, tileTop - top - RASTER_BLEED, tile.canvas.width / this.dpr, tile.canvas.height / this.dpr);
      }
    this.lastTextCount = labels;
    // About 64 MB of raster pixels, allowing at least the current viewport on large screens.
    const limit = Math.max(visible.size, Math.floor(16_000_000 / Math.ceil((RASTER_SIZE + 2 * RASTER_BLEED) * this.dpr) ** 2));
    for (const id of this.rasters.keys()) {
      if (this.rasters.size <= limit) break;
      if (!visible.has(id)) {
        const tile = this.rasters.get(id)!;
        tile.canvas.width = tile.canvas.height = 1;
        this.rasters.delete(id);
      }
    }

    this.drawOverlays(ctx, screen, onScreen);
    this.lastDrawMs = performance.now() - t0;
    this.onView?.();
  }

  private renderRaster(left: number, top: number): RasterTile {
    const margin = RASTER_BLEED;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.ceil((RASTER_SIZE + 2 * margin) * this.dpr);
    const ctx = canvas.getContext("2d")!;
    const { theme } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const d = this.drawing!;
    const s = this.scale;
    const vis = [(left - margin) / s, -(top + RASTER_SIZE + margin) / s, (left + RASTER_SIZE + margin) / s, -(top - margin) / s];
    const onScreen = (b: ArrayLike<number>) => b[0] <= vis[2] && b[2] >= vis[0] && b[1] <= vis[3] && b[3] >= vis[1];
    const world = () => ctx.setTransform(this.dpr * s, 0, 0, -this.dpr * s, this.dpr * (margin - left), this.dpr * (margin - top));
    const screen = () => ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * (this.cx * s - this.width / 2 - left + margin), this.dpr * (-this.cy * s - this.height / 2 - top + margin));

    world();
    ctx.lineJoin = "bevel";
    ctx.lineCap = "butt";
    const visTiles = this.tiles.filter((t) => onScreen(t.bbox));
    // fills first, then strokes, then dots
    for (const pass of ["fillPattern", "fillSolid", "stroke", "dot"] as const)
      for (const t of visTiles)
        for (const b of t.batches) {
          if (b.kind !== pass || this.hiddenLayers.has(b.layer) || b.maxSize * s < 0.75) continue;
          if (pass === "stroke") {
            ctx.strokeStyle = b.color;
            ctx.lineWidth = 1 / s;
            ctx.stroke(b.path);
          } else if (pass === "dot") {
            if (s < 0.5) continue; // dots are noise at overview scale
            ctx.fillStyle = b.color;
            // Points have no world radius. Draw a small mark in screen pixels.
            for (let i = 0; i < b.dots.length; i += 2) {
              const x = b.dots[i], y = b.dots[i + 1];
              if (x < vis[0] || x > vis[2] || y < vis[1] || y > vis[3]) continue;
              ctx.fillRect(x - 0.75 / s, y - 0.75 / s, 1.5 / s, 1.5 / s);
            }
          } else {
            ctx.globalAlpha = pass === "fillSolid" ? 0.85 : 0.16;
            ctx.fillStyle = b.color;
            ctx.fill(b.path, "evenodd");
            ctx.globalAlpha = 1;
          }
        }

    // text in screen space
    screen();
    let nText = 0;
    for (const t of visTiles)
      for (const i of t.texts) {
        const p = d.prims[i] as Extract<Prim, ["t", ...unknown[]]>;
        if (this.hiddenLayers.has(p[2])) continue;
        const px = p[6] * s;
        if (px < 3) continue;
        const b = this.primBox.subarray(i * 4, i * 4 + 4);
        if (b[0] > vis[2] || b[2] < vis[0] || b[1] > vis[3] || b[3] < vis[1]) continue;
        const [sx, sy] = this.relToScreen(p[4], p[5]);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(-p[7]);
        ctx.fillStyle = this.selected.has(p[1]) ? theme.select : cssColor(p[3], theme);
        ctx.font = `${px.toFixed(1)}px "Inter", "Helvetica Neue", Arial, sans-serif`;
        ctx.textAlign = p[8][0] === "c" ? "center" : p[8][0] === "r" ? "right" : "left";
        ctx.textBaseline = p[8][1] === "t" ? "top" : p[8][1] === "m" ? "middle" : "alphabetic";
        ctx.fillText(p[9], 0, 0);
        ctx.restore();
        nText++;
      }
    this.drawSelection(ctx, world, screen, onScreen);
    return { canvas, labels: nText };
  }

  private drawSelection(ctx: CanvasRenderingContext2D, world: () => void, screen: () => void, onScreen: (b: ArrayLike<number>) => boolean) {
    const d = this.drawing!;
    const { theme } = this;
    const s = this.scale;
    // selection
    if (this.selected.size) {
      world();
      const path = new Path2D();
      const fill = new Path2D();
      for (const e of this.selected)
        for (const i of this.entPrims[e] ?? []) {
          const p = d.prims[i];
          const b = this.primBox.subarray(i * 4, i * 4 + 4);
          if (this.hiddenLayers.has(p[2]) || this.isDefinitionPoint(p) || !onScreen(b)) continue;
          if (Math.max(b[2] - b[0], b[3] - b[1]) * s < 0.375 && p[0] !== "d") continue;
          if (p[0] === "f") addPrimToPath(fill, p);
          else if (p[0] !== "t") addPrimToPath(path, p, 0.75 / s);
        }
      ctx.strokeStyle = theme.select;
      ctx.lineWidth = 2.5 / s;
      ctx.stroke(path);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = theme.select;
      ctx.fill(fill, "evenodd");
      ctx.globalAlpha = 1;
      // a marker so a tiny selection can be found at any zoom
      screen();
      for (const e of this.selected) {
        const bb = d.entities[e]?.bbox;
        if (!bb) continue;
        const r = this.toRel(bb);
        const [ax, ay] = this.relToScreen(r[0], r[3]);
        const [bx, by] = this.relToScreen(r[2], r[1]);
        if (bx - ax < 10 && by - ay < 10) {
          ctx.strokeStyle = theme.select;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc((ax + bx) / 2, (ay + by) / 2, 9, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

  }

  private drawOverlays(ctx: CanvasRenderingContext2D, screen: () => void, onScreen: (b: ArrayLike<number>) => boolean) {
    const { theme } = this;
    // findings
    screen();
    for (const f of this.findings) {
      if (!f.bbox) continue;
      const active = f === this.activeFinding;
      if (!active && !this.showAllFindings) continue;
      if (!active && this.findings.length > 400) continue;
      const r = this.toRel(f.bbox);
      if (!onScreen(r)) continue;
      let [ax, ay] = this.relToScreen(r[0], r[3]);
      let [bx, by] = this.relToScreen(r[2], r[1]);
      const minPx = active ? 18 : 10;
      if (bx - ax < minPx) {
        const m = (ax + bx) / 2;
        ax = m - minPx / 2;
        bx = m + minPx / 2;
      }
      if (by - ay < minPx) {
        const m = (ay + by) / 2;
        ay = m - minPx / 2;
        by = m + minPx / 2;
      }
      ctx.strokeStyle = theme.sev[f.severity];
      ctx.globalAlpha = active ? 1 : f.severity === "error" ? 0.6 : 0.3;
      ctx.lineWidth = active ? 2 : 1;
      ctx.setLineDash(active ? [] : [4, 3]);
      ctx.strokeRect(ax, ay, bx - ax, by - ay);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  private isDefinitionPoint(p: Prim) {
    return p[0] === "d" && this.drawing?.layers[p[2]]?.name.toLowerCase() === "defpoints";
  }
}

// ------------------------------------------------------------------ prim helpers

function primBbox(p: Prim): [number, number, number, number] {
  switch (p[0]) {
    case "p": {
      const f = p[5];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < f.length; i += 2) {
        if (f[i] < x0) x0 = f[i];
        if (f[i] > x1) x1 = f[i];
        if (f[i + 1] < y0) y0 = f[i + 1];
        if (f[i + 1] > y1) y1 = f[i + 1];
      }
      return [x0, y0, x1, y1];
    }
    case "f": {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const f of p[5])
        for (let i = 0; i < f.length; i += 2) {
          if (f[i] < x0) x0 = f[i];
          if (f[i] > x1) x1 = f[i];
          if (f[i + 1] < y0) y0 = f[i + 1];
          if (f[i + 1] > y1) y1 = f[i + 1];
        }
      return [x0, y0, x1, y1];
    }
    case "c":
    case "a":
      return [p[4] - p[6], p[5] - p[6], p[4] + p[6], p[5] + p[6]];
    case "d":
      return [p[4], p[5], p[4], p[5]];
    case "t": {
      const [, , , , x, y, h, rot, align, text] = p;
      const w = 0.6 * h * text.length;
      const ox = align[0] === "c" ? -w / 2 : align[0] === "r" ? -w : 0;
      const oy = align[1] === "m" ? -h / 2 : align[1] === "t" ? -h : 0;
      const c = Math.cos(rot), s = Math.sin(rot);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [dx, dy] of [[ox, oy], [ox + w, oy], [ox, oy + h], [ox + w, oy + h]]) {
        const X = x + dx * c - dy * s, Y = y + dx * s + dy * c;
        x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
      }
      return [x0, y0, x1, y1];
    }
  }
}

function addPrimToPath(path: Path2D, p: Prim, pointRadius = 0.75) {
  switch (p[0]) {
    case "p": {
      const f = p[5];
      path.moveTo(f[0], f[1]);
      for (let i = 2; i < f.length; i += 2) path.lineTo(f[i], f[i + 1]);
      if (p[4]) path.closePath();
      break;
    }
    case "f":
      for (const f of p[5]) {
        path.moveTo(f[0], f[1]);
        for (let i = 2; i < f.length; i += 2) path.lineTo(f[i], f[i + 1]);
        path.closePath();
      }
      break;
    case "c":
      path.moveTo(p[4] + p[6], p[5]);
      path.arc(p[4], p[5], p[6], 0, Math.PI * 2);
      break;
    case "a":
      path.moveTo(p[4] + p[6] * Math.cos(p[7]), p[5] + p[6] * Math.sin(p[7]));
      path.arc(p[4], p[5], p[6], p[7], p[8], false);
      break;
    case "d": {
      const r = pointRadius;
      path.moveTo(p[4] + r, p[5]);
      path.arc(p[4], p[5], r, 0, Math.PI * 2);
      break;
    }
  }
}

function segD(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function primDistance(p: Prim, x: number, y: number, b: Float64Array): number {
  switch (p[0]) {
    case "p": {
      const f = p[5];
      let best = Infinity;
      for (let i = 0; i + 3 < f.length; i += 2) best = Math.min(best, segD(x, y, f[i], f[i + 1], f[i + 2], f[i + 3]));
      if (p[4] && f.length >= 4) best = Math.min(best, segD(x, y, f[f.length - 2], f[f.length - 1], f[0], f[1]));
      return best;
    }
    case "c":
      return Math.abs(Math.hypot(x - p[4], y - p[5]) - p[6]);
    case "a": {
      const r = Math.hypot(x - p[4], y - p[5]);
      let a = Math.atan2(y - p[5], x - p[4]);
      let a0 = p[7], a1 = p[8];
      while (a1 <= a0) a1 += Math.PI * 2;
      while (a < a0) a += Math.PI * 2;
      if (a <= a1) return Math.abs(r - p[6]);
      const ex = [p[4] + p[6] * Math.cos(p[7]), p[5] + p[6] * Math.sin(p[7])], ey = [p[4] + p[6] * Math.cos(p[8]), p[5] + p[6] * Math.sin(p[8])];
      return Math.min(Math.hypot(x - ex[0], y - ex[1]), Math.hypot(x - ey[0], y - ey[1]));
    }
    case "d":
      return Math.hypot(x - p[4], y - p[5]);
    case "t":
    case "f":
      // inside the box counts as a hit
      return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] ? 0 : Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));
  }
}
