// Run after high-dpi-check.js and hatch-spatial-check.js to cover a repeat zoom
// after inspection and drawing replacement, as well as a fresh viewer's zoom.
(async () => {
  const v = cadkit.view, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  await wait(1000);
  v.draw();
  let frames = [], running = true, last = performance.now();
  const frame = time => {
    if (!running) return;
    frames.push(time - last); last = time;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await wait(50);
  frames = [];
  const start = performance.now();
  const draw = v.draw, target = v.scale * Math.exp(.6);
  let completedAt = null;
  v.draw = function (...args) {
    const result = draw.apply(this, args);
    if (completedAt === null && !this.zoomMotion && !this.pending && this.scale === target && this.front?.scale === target) completedAt = performance.now();
    return result;
  };
  v.smoothZoomAt(130, 150, Math.exp(.6));
  try {
    await wait(40);
    while (completedAt === null && performance.now() - start < 3000) await wait(5);
    // Timestamp the completing draw itself; polling latency is not redraw time.
    const sharpMs = (completedAt ?? performance.now()) - start;
    const samples = frames.slice(2).sort((a, b) => a - b);
    const result = { sharpMs, frames: samples.length, p95Ms: samples[Math.floor(samples.length * .95)], maxMs: samples.at(-1) };
    if (sharpMs > 500) throw new Error(`sharp redraw missed 500 ms: ${JSON.stringify(result)}`);
    if (result.p95Ms > 34 || result.maxMs > 150) throw new Error(`redraw blocked interaction: ${JSON.stringify(result)}`);
    return result;
  } finally { running = false; v.draw = draw; }
})()
