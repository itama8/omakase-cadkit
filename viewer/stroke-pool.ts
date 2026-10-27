import type { Bbox, Drawing, Prim } from "../src/types.ts";
import type { Theme, RasterOverlay } from "./canvas.ts";

export interface StrokeJob {
  scale: number; left: number; top: number; width: number; height: number;
  dpr: number; hidden: number[];
  images?: number;
}
export interface StrokeResult { bitmap: ImageBitmap; background?: ImageBitmap }

/** Workers share the stroke batches of one drawing, retaining one job each.
 * One also resamples linked images. Fonts and inspection stay in the host. */
export class StrokePool {
  private slots: { worker: Worker; ready: boolean; resolve?: (bitmap: StrokeResult | null) => void }[] = [];
  private stopped = false;
  private imageVersion = 0;
  private imageSnapshot: { bitmap: CanvasImageSource; metadata: string }[] = [];
  private source: Drawing;
  private extents: Bbox;
  private theme: string;
  private dashes: string;
  private snapshot: { index: number; prim: Prim }[] = [];
  private origin: number[];

  constructor(drawing: Drawing, boxes: Float64Array, extents: Bbox, theme: Theme, groups: { sources: number[]; cost: number }[], wake: () => void) {
    this.source = drawing; this.extents = [...extents]; this.theme = JSON.stringify(theme);
    this.origin = [...drawing.origin];
    this.dashes = JSON.stringify(drawing.dashes);
    const count = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
    // Stroking one large union is more expensive than the same segment count in
    // small paths. Keep batches whole, while isolating the largest unions rather
    // than assigning all sheet-wide hatches to the final worker.
    const weights = groups.map(g => Math.pow(g.cost, 1.5));
    let low = weights.reduce((n, w) => Math.max(n, w), 0), high = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < 40; i++) {
      const limit = (low + high) / 2;
      let used = 1, sum = 0;
      for (const weight of weights) {
        if (sum + weight > limit) { used++; sum = 0; }
        sum += weight;
      }
      if (used > count) low = limit; else high = limit;
    }
    const chunks: number[][] = Array.from({ length: count }, () => []);
    let cost = 0, chunk = 0;
    for (let i = 0; i < groups.length; i++) {
      if (chunk < count - 1 && cost + weights[i] > high) { chunk++; cost = 0; }
      for (const source of groups[i].sources) chunks[chunk].push(source);
      cost += weights[i];
    }
    for (let i = 0; i < count; i++) {
      const prims: Prim[] = [], bounds: number[] = [];
      for (const index of chunks[i].sort((a, b) => a - b)) {
        const p = drawing.prims[index];
        const prim = (p[0] === "l" ? [...p.slice(0, 4), new Float64Array(p[4])] : p[0] === "p" ? [...p.slice(0, 5), p[5].slice(), ...p.slice(6)] : p.slice()) as unknown as Prim;
        prims.push(prim); this.snapshot.push({ index, prim });
        bounds.push(...boxes.subarray(index * 4, index * 4 + 4));
      }
      const scene = { drawing: { origin: drawing.origin, layers: drawing.layers, dashes: drawing.dashes, prims }, boxes: new Float64Array(bounds), extents, theme };
      let worker: Worker;
      try {
        worker = new Worker(new URL("dist/stroke-worker.js", document.baseURI), { type: "module" });
      } catch {
        this.dispose();
        return;
      }
      const slot = { worker, ready: false } as typeof this.slots[number];
      this.slots.push(slot);
      worker.onmessage = ({ data }) => {
        if (data.ready) slot.ready = true;
        else if (data.bitmap) {
          const resolve = slot.resolve;
          slot.resolve = undefined;
          if (resolve) resolve(data); else { data.bitmap.close(); data.background?.close(); }
        }
        wake();
      };
      worker.onerror = () => { this.dispose(); wake(); };
      // Send before the synchronous first frame: compilation then overlaps that
      // work instead of starting only after the first user gesture can arrive.
      try { worker.postMessage(scene); } catch { this.dispose(); return; }
    }
  }

  get failed() { return this.stopped; }
  get imageRevision() { return this.imageVersion; }

  matches(drawing: Drawing, extents: Bbox, theme: Theme) {
    if (this.stopped || drawing !== this.source || JSON.stringify(theme) !== this.theme || JSON.stringify(drawing.dashes) !== this.dashes || extents.some((n,i)=>n!==this.extents[i]) || drawing.origin.some((n,i)=>n!==this.origin[i])) return false;
    const equal = (a: unknown, b: unknown): boolean => {
      if (a === b) return true;
      if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
      const aa = a as ArrayLike<unknown>, bb = b as ArrayLike<unknown>;
      if (aa.length !== bb.length) return false;
      for(let i=0;i<aa.length;i++) if(!equal(aa[i],bb[i]))return false;
      return true;
    };
    const count = drawing.prims.reduce((n,p)=>n+(p[0]!=="t"&&p[0]!=="f"&&p[0]!=="d"?1:0),0);
    return count === this.snapshot.length && this.snapshot.every(({index,prim})=>equal(prim,drawing.prims[index]));
  }

  async setImages(images: RasterOverlay[]) {
    const snapshot = images.map(({ bitmap, ...metadata }) => ({ bitmap, metadata: JSON.stringify(metadata) }));
    // ImageBitmap is immutable. A host refresh of the same images does not need
    // another large bitmap copy; mutable canvas/video sources still copy anew.
    if (snapshot.length === this.imageSnapshot.length && snapshot.every((img, i) => img.bitmap instanceof ImageBitmap && img.bitmap === this.imageSnapshot[i].bitmap && img.metadata === this.imageSnapshot[i].metadata)) return;
    this.imageSnapshot = snapshot;
    const version = ++this.imageVersion;
    const copies: (RasterOverlay & { bitmap: ImageBitmap })[] = [];
    try {
      for (const img of images) copies.push({ ...img, bitmap: await createImageBitmap(img.bitmap as ImageBitmapSource) });
    } catch {
      for (const img of copies) img.bitmap.close();
      if (version === this.imageVersion) this.imageSnapshot = [];
      return; // Missing worker images use the host's existing image path.
    }
    if (!this.stopped && version === this.imageVersion) this.slots[this.slots.length - 1].worker.postMessage({ images: copies, version }, copies.map(img => img.bitmap));
    else for (const img of copies) img.bitmap.close();
  }

  render(job: StrokeJob): Promise<(StrokeResult | null)[]> | null {
    if (this.stopped || !this.slots.every(s => s.ready && !s.resolve)) return null;
    return Promise.all(this.slots.map((slot, i) => new Promise<StrokeResult | null>(resolve => {
      slot.resolve = resolve; slot.worker.postMessage({ ...job, images: i === this.slots.length - 1 && job.images ? this.imageVersion : undefined });
    })));
  }

  dispose() {
    this.stopped = true;
    for (const slot of this.slots) {
      slot.worker.terminate(); slot.resolve?.(null); slot.resolve = undefined;
    }
    this.slots = [];
    this.snapshot = []; this.imageSnapshot = [];
  }
}
