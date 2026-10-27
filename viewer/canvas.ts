// Canvas renderer for a omakase-cadkit payload. Framework-free so it can move into another host
// (the Omakase renderer) unchanged: give it a canvas, a payload, and call draw().
//
// Strokes and fills are batched into Path2D objects per (tile, layer, colour, dash) in drawing
// coordinates. Fills stay independent so even-odd holes do not cancel neighboring hatches.
// Text is drawn per item in screen space, fitted to the width the sidecar laid it out at,
// fading out below 3 px and skipped below 1.5 px.

import type { Bbox, Drawing, Finding, Prim, Raster } from "../src/types.ts";

export interface Theme {
  bg: string;
  ink: string; // replaces ACI white/black
  grid: string;
  select: string;
  sev: Record<"error" | "warning" | "info", string>;
  /** Light paper background: colours above mid luminance are darkened to stay legible. */
  light?: boolean;
}

export const DARK: Theme = {
  bg: "#0d0e11",
  ink: "#e8eaf0",
  grid: "#1b1e24",
  select: "#5b9dff",
  sev: { error: "#ff6f6f", warning: "#f0b64b", info: "#67c6e8" },
};

export const LIGHT: Theme = {
  bg: "#f7f3ea",
  ink: "#23201a",
  grid: "#dcd5c5",
  select: "#1c5fd6",
  sev: { error: "#c23a32", warning: "#9a6d12", info: "#216d8c" },
  light: true,
};

interface Batch {
  layer: number;
  color: string;
  /** fillSolid: even-odd; fillUnion: nonzero (wide polylines); fillPattern: tint for a hatch too dense to draw */
  kind: "stroke" | "fillSolid" | "fillUnion" | "fillPattern" | "dot";
  /** Index into the drawing's dash patterns, for dashed strokes. */
  dash?: number;
  path: Path2D;
  /** Spatial pieces of disconnected hatch strokes, kept inside the original batch order. */
  parts?: Map<number, { bbox: Bbox; path: Path2D }>;
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

interface PreparedDrawing {
  theme: string;
  tiles: Tile[];
  primBox: Float64Array;
  entPrims: number[][];
  hitGrid: Map<string, number[]>;
  hitCell: number;
  extents: Bbox;
}

/** Raster tiles rendered at one scale, in drawing pixels at that scale (x right, y down). */
interface RasterLayer {
  scale: number;
  originX: number;
  originY: number;
  tiles: Map<string, RasterTile>;
}

export interface RasterOverlay extends Raster {
  bitmap: CanvasImageSource;
}

const RASTER_SIZE = 256;
const RASTER_BLEED = 3;
/** Text fades out between these heights in screen pixels, so labels thin out over a few zoom steps rather than vanish at once. */
const TEXT_FULL_PX = 3;
const TEXT_MIN_PX = 1.5;
// AutoCAD text height is the capital height. Font size per capital height for the bundled
// faces (Arimo's capitals are 0.688 em, Tinos's 0.655; AutoCAD's Times capitals are 0.973 of
// the height). Widths come from the primitive, so these only set the glyph height.
const EM_PER_CAP = { sans: 1 / 0.688, serif: 0.973 / 0.655 };
const FONT = {
  sans: `"Cadkit Sans", Arimo, "Liberation Sans", Arial, sans-serif`,
  serif: `"Cadkit Serif", Tinos, "Liberation Serif", "Times New Roman", serif`,
};
/** Canvas font shorthand for a text primitive's font field (sans|serif, then |b, |i or |bi). */
function fontFor(font: string, px: number): string {
  const [family, style = ""] = font.split("|");
  const face = family === "serif" ? "serif" : "sans";
  return `${style.includes("i") ? "italic " : ""}${style.includes("b") ? "bold " : ""}${(px * EM_PER_CAP[face]).toFixed(1)}px ${FONT[face]}`;
}
/** Wheel zoom stretches cached tiles; linework is re-rendered once input has been quiet this long. */
const ZOOM_SETTLE_MS = 120;
/** Tile rendering per frame while a stretched stand-in covers the gaps. */
const RENDER_BUDGET_MS = 8;
/** Longest side, in device pixels, of the whole-drawing image shown where no tiles exist yet. */
const OVERVIEW_PX = 2048;

type Rgb = number;

function cssColor(rgb: Rgb, theme: Theme): string {
  if (rgb === 0xffffff || rgb === 0) return theme.ink;
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (theme.light) {
    // Darken colours that would wash out on paper; keep hue by scaling all channels.
    if (lum > 0.5) {
      const k = 0.5 / lum;
      return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
    }
    return `rgb(${r},${g},${b})`;
  }
  // Lift colours that would vanish on a dark background.
  if (lum < 0.18) {
    const k = 0.18 / Math.max(lum, 0.02);
    return `rgb(${Math.min(255, r * k + 40)},${Math.min(255, g * k + 40)},${Math.min(255, b * k + 40)})`;
  }
  return `rgb(${r},${g},${b})`;
}

export class DrawingCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private currentTheme: Theme = DARK;
  get theme(): Theme { return this.currentTheme; }
  set theme(theme: Theme) {
    this.currentTheme = theme;
    // Geometry batches cache resolved colours, while text resolves them at draw time.
    if (this.drawing) this.buildTiles();
    this.refresh();
  }
  drawing: Drawing | null = null;
  private tiles: Tile[] = [];
  private preparedDrawings = new Map<Drawing, PreparedDrawing>();
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
  /** Tiles being drawn at (or stretched towards) the current scale. */
  private front: RasterLayer | null = null;
  /** The previous front, stretched underneath while the new one fills in. */
  private back: RasterLayer | null = null;
  /** The whole drawing at low resolution, under both, so zooming out never shows blank. */
  private overview: { key: string; scale: number; left: number; top: number; canvas: HTMLCanvasElement } | null = null;
  private overviewIdle = 0;
  private sceneKey = "";
  private zoomInputAt = 0;
  private settleTimer = 0;
  private pending = false;
  private drawingVersion = 0;
  images: RasterOverlay[] = [];
  /** Raster images (aerial photos, scans) drawn behind the linework, independent of layers. */
  private imagesVisible = true;
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

  /** Reuse is opt-in for payload objects revalidated by the host. The default
   * rebuilds, including callers that edit a payload in place before setting it. */
  setDrawing(d: Drawing, reuse = false) {
    this.dropLayer(this.front);
    this.dropLayer(this.back);
    this.front = this.back = null;
    this.drawingVersion++;
    this.drawing = d;
    this.images = [];
    this.selected.clear();
    this.findings = [];
    this.activeFinding = null;
    const theme = JSON.stringify(this.theme);
    const prepared = reuse ? this.preparedDrawings.get(d) : undefined;
    if (prepared?.theme === theme) {
      this.tiles = prepared.tiles;
      this.primBox = prepared.primBox;
      this.entPrims = prepared.entPrims;
      this.hitGrid = prepared.hitGrid;
      this.hitCell = prepared.hitCell;
      this.extents = prepared.extents;
    } else {
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
    }
    this.preparedDrawings.delete(d);
    this.preparedDrawings.set(d, { theme, tiles: this.tiles, primBox: this.primBox, entPrims: this.entPrims, hitGrid: this.hitGrid, hitCell: this.hitCell, extents: this.extents });
    while (this.preparedDrawings.size > 2) this.preparedDrawings.delete(this.preparedDrawings.keys().next().value!);
    this.fit();
  }

  /** Redraw everything, e.g. once web fonts have loaded. */
  refresh() {
    this.drawingVersion++;
    this.request();
  }

  setImages(images: RasterOverlay[]) {
    this.images = images;
    this.drawingVersion++;
    this.request();
  }

  get showImages() {
    return this.imagesVisible;
  }

  set showImages(on: boolean) {
    if (on === this.imagesVisible) return;
    this.imagesVisible = on;
    this.drawingVersion++;
    this.request();
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
    const tileIdx = (b: ArrayLike<number>) => {
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
      const b = this.primBox.subarray(i * 4, i * 4 + 4);
      const t = tileIdx(b);
      const tile = tiles[t];
      tile.bbox = [Math.min(tile.bbox[0], b[0]), Math.min(tile.bbox[1], b[1]), Math.max(tile.bbox[2], b[2]), Math.max(tile.bbox[3], b[3])];
      if (p[0] === "t") {
        tile.texts.push(i);
        return;
      }
      // A fill only used for picking draws nothing: its pattern or picture is drawn by other primitives.
      if (p[0] === "f" && p[4] === 3) return;
      const kind: Batch["kind"] = p[0] === "f" ? (p[4] === 1 ? "fillSolid" : p[4] === 2 ? "fillUnion" : "fillPattern") : p[0] === "d" ? "dot" : "stroke";
      const dash = p[0] === "p" ? p[6] : p[0] === "c" ? p[7] : p[0] === "a" ? p[9] : undefined;
      const color = cssColor(p[3], this.theme);
      const size = Math.max(b[2] - b[0], b[3] - b[1], 1e-12);
      const maxSize = p[0] === "d" ? Infinity : 2 ** Math.ceil(Math.log2(size));
      // Independent fills must not cancel each other through even-odd batching.
      const key = `${p[2]}|${color}|${kind}|${maxSize}|${dash ?? ""}${p[0] === "f" ? `|${i}` : ""}`;
      let batch = batchMaps[t].get(key);
      if (!batch) {
        batch = { layer: p[2], color, kind, maxSize, path: new Path2D(), dots: [], dash };
        batchMaps[t].set(key, batch);
        tile.batches.push(batch);
      }
      if (p[0] === "l") {
        // A hatch can span the sheet with thousands of disconnected strokes. Replaying
        // its whole path for every raster tile makes both opening and sharpening stall.
        // Partition the strokes for culling while retaining batch order and maxSize.
        const parts = batch.parts ??= new Map();
        const f = p[4];
        for (let j = 0; j + 3 < f.length; j += 4) {
          const bbox: Bbox = [Math.min(f[j], f[j + 2]), Math.min(f[j + 1], f[j + 3]), Math.max(f[j], f[j + 2]), Math.max(f[j + 1], f[j + 3])];
          const id = tileIdx(bbox);
          let part = parts.get(id);
          if (!part) { part = { bbox, path: new Path2D() }; parts.set(id, part); }
          else for (let k = 0; k < 2; k++) {
            part.bbox[k] = Math.min(part.bbox[k], bbox[k]);
            part.bbox[k + 2] = Math.max(part.bbox[k + 2], bbox[k + 2]);
          }
          part.path.moveTo(f[j], f[j + 1]);
          part.path.lineTo(f[j + 2], f[j + 3]);
        }
      } else if (p[0] === "d") batch.dots.push(p[4], p[5]);
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
    this.zoomInputAt = performance.now();
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
        const fraction = 1 - Math.exp(-Math.max(1, now - motion.time) / 25);
        this.applyZoom(motion.x, motion.y, done ? motion.scale / this.scale : Math.exp(remaining * fraction));
        motion.time = now;
        if (done) this.zoomMotion = null;
      }
      this.draw(true);
      if (this.zoomMotion || this.pending) this.request();
    };
    this.raf = document.hidden ? window.setTimeout(run, 16) : requestAnimationFrame(run);
  }

  /** `progressive` spreads a re-render over frames when a stretched stand-in can cover the gaps. */
  draw(progressive = false) {
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

    // Raster tiles are anchored to drawing space at one scale, so pans render only newly
    // exposed tiles. While the wheel is moving, the cached tiles are stretched instead of
    // re-rendered; once it settles a new layer fills in over the stretched old one.
    const now = performance.now();
    const key = `${this.drawingVersion}|${this.dpr}|${[...this.hiddenLayers].sort().join(",")}|${[...this.selected].join(",")}|${JSON.stringify(theme)}`;
    if (key !== this.sceneKey) {
      // Images can finish loading during a wheel gesture. Keep the displayed
      // frame as a stand-in instead of forcing a synchronous full redraw then.
      if (this.front?.tiles.size) {
        this.dropLayer(this.back);
        this.back = this.front;
      } else this.dropLayer(this.front);
      this.front = null;
      this.sceneKey = key;
    }
    const zooming = this.zoomMotion !== null || now - this.zoomInputAt < ZOOM_SETTLE_MS;
    // Nothing is rendered at intermediate scales: tiles drawn mid-gesture are stale a few frames later.
    if (!this.front || (!zooming && s !== this.front.scale)) {
      // A front still filling in is a worse stand-in than the complete layer beneath it.
      if (this.front?.tiles.size && !(this.pending && this.back)) {
        this.dropLayer(this.back);
        this.back = this.front;
      } else this.dropLayer(this.front);
      // Align the new grid to the viewport so a fresh fit/zoom keeps text sharp.
      this.front = { scale: s, originX: this.cx * s - this.width / 2, originY: -this.cy * s - this.height / 2, tiles: new Map() };
    }
    const budget = zooming && (this.front.tiles.size || this.back?.tiles.size) ? 0 : progressive && this.back ? RENDER_BUDGET_MS : Infinity;
    if (budget !== Infinity && this.gaps(this.front)) {
      this.paintOverview(ctx);
      if (this.back) this.paintLayer(ctx, this.back, 0);
    }
    const missing = this.paintLayer(ctx, this.front, budget);
    this.pending = missing > 0 && budget > 0;
    if (!missing && !zooming) {
      this.dropLayer(this.back);
      this.back = null;
    }
    if (!zooming && !this.pending && this.overview?.key !== this.overviewKey()) this.scheduleOverview();
    window.clearTimeout(this.settleTimer);
    if (zooming && !this.zoomMotion) this.settleTimer = window.setTimeout(() => this.request(), ZOOM_SETTLE_MS - (now - this.zoomInputAt) + 1);

    this.drawOverlays(ctx, screen, onScreen);
    this.lastDrawMs = performance.now() - t0;
    this.onView?.();
  }

  /** Visible tiles the layer does not have. */
  private gaps(layer: RasterLayer): number {
    const k = this.scale / layer.scale;
    const left = this.cx * layer.scale - this.width / 2 / k, top = -this.cy * layer.scale - this.height / 2 / k;
    const x0 = Math.floor((left - layer.originX) / RASTER_SIZE), x1 = Math.ceil((left - layer.originX + this.width / k) / RASTER_SIZE) - 1;
    const y0 = Math.floor((top - layer.originY) / RASTER_SIZE), y1 = Math.ceil((top - layer.originY + this.height / k) / RASTER_SIZE) - 1;
    let cached = 0;
    for (const id of layer.tiles.keys()) {
      const [x, y] = id.split(",").map(Number);
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) cached++;
    }
    const missing = (x1 - x0 + 1) * (y1 - y0 + 1) - cached;
    return missing;
  }

  private overviewKey() {
    return `${this.drawingVersion}|${this.dpr}|${[...this.hiddenLayers].sort().join(",")}|${JSON.stringify(this.theme)}`;
  }

  /** Render the overview when the browser is idle, never during a gesture. */
  private scheduleOverview() {
    if (this.overviewIdle) return;
    const run = () => {
      this.overviewIdle = 0;
      if (!this.drawing || this.zoomMotion || performance.now() - this.zoomInputAt < ZOOM_SETTLE_MS) return;
      const key = this.overviewKey();
      if (this.overview?.key === key) return;
      if (this.overview) this.overview.canvas.width = 1;
      const [x0, y0, x1, y1] = this.extents;
      const scale = OVERVIEW_PX / this.dpr / Math.max(x1 - x0, y1 - y0, 1e-9);
      const left = x0 * scale, top = -y1 * scale;
      const { canvas } = this.renderRaster(scale, left, top, (x1 - x0) * scale, (y1 - y0) * scale, false);
      this.overview = { key, scale, left, top, canvas };
    };
    this.overviewIdle = typeof requestIdleCallback === "function" ? requestIdleCallback(run, { timeout: 1000 }) : window.setTimeout(run, 200);
  }

  private paintOverview(ctx: CanvasRenderingContext2D) {
    const o = this.overview;
    if (!o || o.key !== this.overviewKey()) return;
    const k = this.scale / o.scale;
    const left = this.cx * o.scale - this.width / 2 / k, top = -this.cy * o.scale - this.height / 2 / k;
    ctx.drawImage(o.canvas, (o.left - left - RASTER_BLEED) * k, (o.top - top - RASTER_BLEED) * k, (o.canvas.width / this.dpr) * k, (o.canvas.height / this.dpr) * k);
  }

  /** Composite a layer's tiles over the viewport, rendering missing ones for up to `budget` ms (at least one tile when positive). Returns how many are still missing. */
  private paintLayer(ctx: CanvasRenderingContext2D, layer: RasterLayer, budget: number): number {
    const deadline = performance.now() + budget;
    const k = this.scale / layer.scale;
    // viewport origin in the layer's pixel space
    const left = this.cx * layer.scale - this.width / 2 / k, top = -this.cy * layer.scale - this.height / 2 / k;
    const x0 = Math.floor((left - layer.originX) / RASTER_SIZE), x1 = Math.ceil((left - layer.originX + this.width / k) / RASTER_SIZE) - 1;
    const y0 = Math.floor((top - layer.originY) / RASTER_SIZE), y1 = Math.ceil((top - layer.originY + this.height / k) / RASTER_SIZE) - 1;
    // A zoom-out can expose millions of positions in the old tile grid. During
    // motion only existing tiles can be painted; visiting empty positions freezes input.
    if (budget === 0) {
      let cached = 0, labels = 0;
      for (const [id, tile] of layer.tiles) {
        const [x, y] = id.split(",").map(Number);
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const tileLeft = layer.originX + x * RASTER_SIZE, tileTop = layer.originY + y * RASTER_SIZE;
        const size = tile.canvas.width / this.dpr;
        if (k === 1) ctx.drawImage(tile.canvas, Math.round(tileLeft - left) - RASTER_BLEED, Math.round(tileTop - top) - RASTER_BLEED, size, size);
        else ctx.drawImage(tile.canvas, (tileLeft - left - RASTER_BLEED) * k, (tileTop - top - RASTER_BLEED) * k, size * k, size * k);
        cached++;
        labels += tile.labels;
      }
      if (layer === this.front) this.lastTextCount = labels;
      return (x1 - x0 + 1) * (y1 - y0 + 1) - cached;
    }
    const visible = new Set<string>();
    let labels = 0, missing = 0, rendered = false;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const id = `${x},${y}`;
        const tileLeft = layer.originX + x * RASTER_SIZE, tileTop = layer.originY + y * RASTER_SIZE;
        visible.add(id);
        let tile = layer.tiles.get(id);
        // Always make progress by at least one tile per frame.
        if (!tile && budget > 0 && (!rendered || performance.now() < deadline)) {
          tile = this.renderRaster(layer.scale, tileLeft, tileTop);
          rendered = true;
        }
        if (!tile) {
          missing++;
          continue;
        }
        // Refresh insertion order for bounded LRU eviction after compositing.
        layer.tiles.delete(id);
        layer.tiles.set(id, tile);
        labels += tile.labels;
        const size = tile.canvas.width / this.dpr;
        if (k === 1)
          // Whole pixels keep cached text sharp when a resize leaves the centre on a half pixel.
          ctx.drawImage(tile.canvas, Math.round(tileLeft - left) - RASTER_BLEED, Math.round(tileTop - top) - RASTER_BLEED, size, size);
        else ctx.drawImage(tile.canvas, (tileLeft - left - RASTER_BLEED) * k, (tileTop - top - RASTER_BLEED) * k, size * k, size * k);
      }
    if (layer === this.front) {
      this.lastTextCount = labels;
      // About 64 MB of raster pixels, allowing at least the current viewport on large screens.
      const limit = Math.max(visible.size, Math.floor(16_000_000 / Math.ceil((RASTER_SIZE + 2 * RASTER_BLEED) * this.dpr) ** 2));
      for (const id of layer.tiles.keys()) {
        if (layer.tiles.size <= limit) break;
        if (!visible.has(id)) {
          layer.tiles.get(id)!.canvas.width = 1;
          layer.tiles.delete(id);
        }
      }
    }
    return missing;
  }

  private dropLayer(layer: RasterLayer | null) {
    for (const tile of layer?.tiles.values() ?? []) tile.canvas.width = tile.canvas.height = 1;
  }

  private renderRaster(s: number, left: number, top: number, w = RASTER_SIZE, h = RASTER_SIZE, selection = true): RasterTile {
    const margin = RASTER_BLEED;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((w + 2 * margin) * this.dpr);
    canvas.height = Math.ceil((h + 2 * margin) * this.dpr);
    const ctx = canvas.getContext("2d")!;
    const { theme } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const d = this.drawing!;
    const vis = [(left - margin) / s, -(top + h + margin) / s, (left + w + margin) / s, -(top - margin) / s];
    const onScreen = (b: ArrayLike<number>) => b[0] <= vis[2] && b[2] >= vis[0] && b[1] <= vis[3] && b[3] >= vis[1];
    const world = () => ctx.setTransform(this.dpr * s, 0, 0, -this.dpr * s, this.dpr * (margin - left), this.dpr * (margin - top));
    // pixels at this scale, relative to the tile
    const screen = () => ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * (margin - left), this.dpr * (margin - top));
    const toPx = (x: number, y: number): [number, number] => [x * s, -y * s];

    world();
    this.drawImages(ctx, vis);
    ctx.lineJoin = "bevel";
    ctx.lineCap = "butt";
    const visTiles = this.tiles.filter((t) => onScreen(t.bbox));
    // fills first, then strokes, then dots
    for (const pass of ["fillPattern", "fillSolid", "fillUnion", "stroke", "dot"] as const)
      for (const t of visTiles)
        for (const b of t.batches) {
          if (b.kind !== pass || this.hiddenLayers.has(b.layer) || b.maxSize * s < 0.75) continue;
          if (pass === "stroke") {
            ctx.strokeStyle = b.color;
            ctx.lineWidth = 1 / s;
            // Dashes are in drawing units; a pattern finer than a few pixels reads as continuous, as in AutoCAD.
            const pattern = b.dash === undefined ? undefined : d.dashes?.[b.dash];
            const dashed = !!pattern && pattern.reduce((a, v) => a + v, 0) * s >= 3;
            if (dashed) ctx.setLineDash(pattern!.map((v) => (v > 0 ? v : 1 / s)));
            if (b.parts) {
              // Stroke once so overlaps retain the original antialiasing/opacity.
              const path = new Path2D(b.path);
              for (const part of b.parts.values()) if (onScreen(part.bbox)) path.addPath(part.path);
              ctx.stroke(path);
            } else ctx.stroke(b.path);
            if (dashed) ctx.setLineDash([]);
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
            ctx.globalAlpha = pass === "fillPattern" ? 0.16 : 1;
            ctx.fillStyle = b.color;
            ctx.fill(b.path, pass === "fillUnion" ? "nonzero" : "evenodd");
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
        if (px < TEXT_MIN_PX) continue;
        const b = this.primBox.subarray(i * 4, i * 4 + 4);
        if (b[0] > vis[2] || b[2] < vis[0] || b[1] > vis[3] || b[3] < vis[1]) continue;
        const [sx, sy] = toPx(p[4], p[5]);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(-p[7]);
        ctx.font = fontFor(p[10], px);
        // Fit the glyphs to the laid-out width, so a box AutoCAD filled is filled to the same edge.
        const natural = p[12] > 0 ? ctx.measureText(p[9]).width : 0;
        const stretch = natural > 0 ? (p[12] * s) / natural : p[11];
        if (stretch !== 1 && Number.isFinite(stretch) && stretch > 0) ctx.scale(stretch, 1);
        if (px < TEXT_FULL_PX) ctx.globalAlpha = (px - TEXT_MIN_PX) / (TEXT_FULL_PX - TEXT_MIN_PX);
        ctx.fillStyle = this.selected.has(p[1]) ? theme.select : cssColor(p[3], theme);
        ctx.textAlign = p[8][0] === "c" ? "center" : p[8][0] === "r" ? "right" : "left";
        ctx.textBaseline = "alphabetic";
        // top and middle refer to the capital height, as in AutoCAD
        ctx.fillText(p[9], 0, p[8][1] === "t" ? px : p[8][1] === "m" ? px / 2 : 0);
        ctx.restore();
        nText++;
      }
    if (selection) this.drawSelection(ctx, s, toPx, world, screen, onScreen);
    return { canvas, labels: nText };
  }

  private drawImages(ctx: CanvasRenderingContext2D, vis: number[]) {
    if (!this.images.length || !this.imagesVisible) return;
    const [ox, oy] = this.drawing!.origin;
    for (const img of this.images) {
      if (this.hiddenLayers.has(img.layer)) continue;
      const [px, py] = img.size;
      if (!(px > 0) || !(py > 0)) continue;
      const x = img.ins[0] - ox, y = img.ins[1] - oy;
      const [ux, uy] = img.u, [vx, vy] = img.v;
      const wx = [x, x + ux * px, x + ux * px + vx * py, x + vx * py];
      const wy = [y, y + uy * px, y + uy * px + vy * py, y + vy * py];
      if (Math.max(...wx) < vis[0] || Math.min(...wx) > vis[2] || Math.max(...wy) < vis[1] || Math.min(...wy) > vis[3]) continue;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - (img.fade ?? 0) / 100);
      ctx.transform(ux, uy, -vx, -vy, x + vx * py, y + vy * py);
      if (img.clip && img.clip.length >= 2) {
        const c = img.clip.length === 2
          ? [[img.clip[0][0], img.clip[0][1]], [img.clip[1][0], img.clip[0][1]], [img.clip[1][0], img.clip[1][1]], [img.clip[0][0], img.clip[1][1]]]
          : img.clip;
        ctx.beginPath();
        ctx.moveTo(c[0][0], c[0][1]);
        for (let i = 1; i < c.length; i++) ctx.lineTo(c[i][0], c[i][1]);
        ctx.closePath();
        ctx.clip();
      }
      ctx.drawImage(img.bitmap, 0, 0, px, py);
      ctx.restore();
    }
  }

  private drawSelection(ctx: CanvasRenderingContext2D, s: number, toPx: (x: number, y: number) => [number, number], world: () => void, screen: () => void, onScreen: (b: ArrayLike<number>) => boolean) {
    const d = this.drawing!;
    const { theme } = this;
    // selection
    if (this.selected.size) {
      world();
      const path = new Path2D();
      for (const e of this.selected)
        for (const i of this.entPrims[e] ?? []) {
          const p = d.prims[i];
          const b = this.primBox.subarray(i * 4, i * 4 + 4);
          if (this.hiddenLayers.has(p[2]) || this.isDefinitionPoint(p) || !onScreen(b)) continue;
          if (Math.max(b[2] - b[0], b[3] - b[1]) * s < 0.375 && p[0] !== "d") continue;
          if (p[0] === "f") {
            const fill = new Path2D();
            addPrimToPath(fill, p);
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = theme.select;
            ctx.fill(fill, p[4] === 2 ? "nonzero" : "evenodd");
            ctx.globalAlpha = 1;
          } else if (p[0] !== "t") addPrimToPath(path, p, 0.75 / s);
        }
      ctx.strokeStyle = theme.select;
      ctx.lineWidth = 2.5 / s;
      ctx.stroke(path);
      // a marker so a tiny selection can be found at any zoom
      screen();
      for (const e of this.selected) {
        const bb = d.entities[e]?.bbox;
        if (!bb) continue;
        const r = this.toRel(bb);
        const [ax, ay] = toPx(r[0], r[3]);
        const [bx, by] = toPx(r[2], r[1]);
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
    case "l": {
      const f = p[4];
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
      const [, , , , x, y, h, rot, align, , , , w] = p;
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
    case "l": {
      const f = p[4];
      for (let i = 0; i + 3 < f.length; i += 4) {
        path.moveTo(f[i], f[i + 1]);
        path.lineTo(f[i + 2], f[i + 3]);
      }
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
    case "l": {
      const f = p[4];
      let best = Infinity;
      for (let i = 0; i + 3 < f.length; i += 4) best = Math.min(best, segD(x, y, f[i], f[i + 1], f[i + 2], f[i + 3]));
      return best;
    }
    case "f": {
      // inside the filled area is a hit; otherwise the distance to its nearest edge
      const loops = p[5];
      let crossings = 0, winding = 0, best = Infinity;
      for (const f of loops)
        for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) {
          const [ax, ay, bx, by] = [f[j], f[j + 1], f[i], f[i + 1]];
          best = Math.min(best, segD(x, y, ax, ay, bx, by));
          if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
            crossings++;
            winding += by > ay ? 1 : -1;
          }
        }
      return (p[4] === 2 ? winding !== 0 : crossings % 2 === 1) ? 0 : best;
    }
    case "t":
      // inside the box counts as a hit
      return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] ? 0 : Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));
  }
}
