import { DrawingCanvas } from "./canvas.ts";
import type { RasterOverlay } from "./canvas.ts";
import type { StrokeJob } from "./stroke-pool.ts";

let renderer: ReturnType<typeof DrawingCanvas.strokeRenderer>;
let images: RasterOverlay[] = [], imageVersion = 0;
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = ({ data }) => {
  if (Array.isArray(data.images)) {
    for (const image of images) (image.bitmap as ImageBitmap).close();
    images = data.images; imageVersion = data.version;
    return;
  }
  if (data.drawing) {
    renderer = DrawingCanvas.strokeRenderer(data.drawing, data.boxes, data.extents, data.theme);
    scope.postMessage({ ready: true });
    return;
  }
  const job = data as StrokeJob;
  const canvas = new OffscreenCanvas(Math.ceil(job.width * job.dpr), Math.ceil(job.height * job.dpr));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  renderer.strokes(ctx as unknown as CanvasRenderingContext2D, job);
  // Flush here: deferred stroke replay must not return to the UI thread.
  ctx.getImageData(0, 0, 1, 1);
  const bitmap = canvas.transferToImageBitmap();
  let background: ImageBitmap | undefined;
  if (job.images && job.images === imageVersion) {
    renderer.images(ctx as unknown as CanvasRenderingContext2D, job, images);
    ctx.getImageData(0, 0, 1, 1);
    background = canvas.transferToImageBitmap();
  }
  scope.postMessage({ bitmap, background }, background ? [bitmap, background] : [bitmap]);
};
