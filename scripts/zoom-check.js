// Use with shot.mjs --eval. Covers active input, including extreme zoom-out, with a
// large selection: eventual completion alone does not prove an interactive gesture.
(async () => {
  const v = cadkit.view;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const camera = [v.cx, v.cy, v.scale];
  const selected = v.selected;
  const renderRaster = v.renderRaster;
  const results = [];
  try {
    // Bound work by the cache size even when the old grid covers a billion empty cells.
    v.selected = new Set(); v.draw();
    const layer = v.front, scale = v.scale;
    const has = layer.tiles.has, get = layer.tiles.get;
    let probes = 0;
    const guard = () => assert(++probes <= 5000, 'zoom-out must not walk empty tile positions');
    layer.tiles.has = function (key) { guard(); return has.call(this, key); };
    layer.tiles.get = function (key) { guard(); return get.call(this, key); };
    try {
      v.scale *= .0001;
      assert(v.gaps(layer) > 1e6, 'regression must expose a large empty tile grid');
      v.paintLayer(v.ctx, layer, 0);
    } finally {
      delete layer.tiles.has; delete layer.tiles.get;
      v.scale = scale; v.draw();
    }
    for (const many of [false, true]) {
      v.cancelZoom();
      [v.cx, v.cy, v.scale] = camera;
      v.selected = many ? new Set(v.drawing.entities.slice(0, 1024).map((e, i) => i)) : new Set();
      v.draw();
      await wait(300);
      let renders = 0;
      v.renderRaster = function (...args) { renders++; return renderRaster.apply(this, args); };
      const rect = v.canvas.getBoundingClientRect();
      const frames = [];
      let running = true, last = performance.now();
      const frame = now => { if (!running) return; frames.push(now - last); last = now; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      const begin = performance.now();
      for (let i = 0; i < 72; i++) {
        v.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: rect.left + v.width / 2, clientY: rect.top + v.height / 2, cancelable: true }));
        await wait(20);
      }
      running = false;
      const elapsed = performance.now() - begin;
      const samples = frames.slice(2).sort((a, b) => a - b);
      const result = { selected: v.selected.size, frames: samples.length, p95Ms: samples[Math.floor(samples.length * .95)], maxMs: samples.at(-1), framesOver50Ms: samples.filter(ms => ms > 50).length, elapsedMs: elapsed, rendersDuringGesture: renders, scaleRatio: v.scale / camera[2] };
      results.push(result);
      assert(renders === 0, 'active wheel input must never rebuild drawing tiles');
      assert(samples.length > 30 && result.maxMs < 150 && result.p95Ms < 34, `wheel gesture must remain responsive: ${JSON.stringify(result)}`);
      assert(result.scaleRatio < .001, 'zoom-out must exercise a mostly empty old tile grid');
      v.renderRaster = renderRaster;
      // Completion remains bounded separately from gesture responsiveness.
      await wait(1000);
      assert(!v.zoomMotion && !v.pending && v.front.scale === v.scale, `zoom must settle after input stops: ${JSON.stringify({result, motion:v.zoomMotion, pending:v.pending, front:v.front.scale, scale:v.scale})}`);
    }
    return results;
  } finally {
    v.renderRaster = renderRaster;
    v.selected = selected;
    v.cancelZoom();
    [v.cx, v.cy, v.scale] = camera;
    v.draw();
  }
})()
