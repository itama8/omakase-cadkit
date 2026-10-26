// Executed in the real browser by scripts/shot.mjs --check after a drawing loads.
(async () => {
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const v = cadkit.view;
  const camera = () => [v.cx, v.cy, v.scale];
  const same = (a, b) => a.every((n, i) => Math.abs(n - b[i]) < 1e-8);
  // A subpixel circle must return at readable scale, rather than being removed at load.
  const originalDrawing = v.drawing;
  const originalFindings = v.findings;
  const originalLayers = v.hiddenLayers;
  const originalImages = v.images;
  try {
    v.hiddenLayers = new Set();
    v.setDrawing({ ...originalDrawing, origin: [0, 0], prims: [['c', 0, 0, 0xffffff, 0, 0, .001]], entities: [{ h: 'TEST', type: 'CIRCLE', layer: 0, color: 0xffffff, bbox: [-.001, -.001, .001, .001] }] });
    v.cx = v.cy = 0; v.scale = 1; v.draw();
    const reader = document.createElement('canvas');
    reader.width = v.canvas.width; reader.height = v.canvas.height;
    const ctx = reader.getContext('2d', { willReadFrequently: true });
    const pixels = () => { ctx.drawImage(v.canvas, 0, 0); return ctx.getImageData(Math.floor(v.canvas.width / 2 - 20), Math.floor(v.canvas.height / 2 - 20), 40, 40).data; };
    const hasInk = () => { const p = pixels(); for (let i = 0; i < p.length; i += 4) if (p[i] > 100) return true; return false; };
    assert(!hasInk(), 'subpixel geometry must be culled at overview scale');
    v.zoomAt(v.width / 2, v.height / 2, 10000); v.draw();
    assert(hasInk(), 'geometry must reappear when zoomed in');
    const pointDrawing = { ...originalDrawing, origin: [0, 0], layers: [{ name: 'Defpoints' }], prims: [['d', 0, 0, 0xffffff, 0, 0]], entities: [{ h: 'POINT', type: 'POINT', layer: 0, color: 0xffffff, bbox: [0, 0, 0, 0] }] };
    v.setDrawing(pointDrawing);
    v.cx = v.cy = 0; v.scale = 100; v.draw();
    assert(!hasInk(), 'dimension definition points must not render');
    assert(v.pick(v.width / 2, v.height / 2) === null, 'invisible definition points must not intercept picking');
    v.setDrawing({ ...pointDrawing, layers: [{ name: 'Survey points' }] });
    for (const scale of [10, 1000]) {
      v.cx = v.cy = 0; v.scale = scale; v.draw();
      const p = pixels();
      let ink = 0;
      for (let i = 0; i < p.length; i += 4) if (p[i] > 100) ink++;
      assert(ink > 0 && ink <= Math.ceil(4 * devicePixelRatio) ** 2, 'ordinary points must remain small at every scale');
      assert(v.pick(v.width / 2, v.height / 2) === 0, 'ordinary points must remain inspectable');
    }
    // A linked raster draws beneath geometry at its world transform.
    const bitmap = document.createElement('canvas');
    bitmap.width = bitmap.height = 2;
    const bctx = bitmap.getContext('2d');
    bctx.fillStyle = '#ff0000';
    bctx.fillRect(0, 0, 2, 2);
    v.setDrawing({ ...originalDrawing, origin: [0, 0], layers: [{ name: '0' }], prims: [], entities: [{ h: 'IMG', type: 'IMAGE', layer: 0, color: 0xffffff, bbox: [0, 0, 2, 2] }] });
    v.setImages([{ ent: 0, h: 'IMG', layer: 0, file: 'x', ins: [0, 0], u: [1, 0], v: [0, 1], size: [2, 2], fade: 0, bitmap }]);
    v.cx = v.cy = 1; v.scale = 100; v.draw();
    ctx.drawImage(v.canvas, 0, 0);
    const middle = ctx.getImageData(Math.floor(v.canvas.width / 2), Math.floor(v.canvas.height / 2), 1, 1).data;
    assert(middle[0] > 200 && middle[1] < 40 && middle[2] < 40, 'raster images must draw at their world transform');
    // Crossing tile boundaries and reusing old tiles must preserve geometry and text.
    v.setDrawing({ ...originalDrawing, origin: [0, 0], entities: [{ h: 'TEST', type: 'LINE', layer: 0, color: 0xffffff }], prims: [
      ['p', 0, 0, 0xff0000, 0, [-2000, 0, 2000, 0]],
      ['p', 0, 0, 0x00ff00, 0, [0, -2000, 0, 2000]],
      ['t', 0, 0, 0xffffff, 256, -30, 14, 0, 'lb', 'Across a tile boundary', 'sans', 1, 200],
    ] });
    v.cx = v.cy = 0; v.scale = 1; v.draw();
    v.panBy(380, 170); v.draw();
    ctx.drawImage(v.canvas, 0, 0);
    const cached = ctx.getImageData(0, 0, reader.width, reader.height).data;
    v.front = null; v.draw();
    ctx.drawImage(v.canvas, 0, 0);
    const fresh = ctx.getImageData(0, 0, reader.width, reader.height).data;
    let maxDelta = 0;
    for (let i = 0; i < fresh.length; i++) maxDelta = Math.max(maxDelta, Math.abs(fresh[i] - cached[i]));
    assert(maxDelta <= 1, 'cached tile pixels must match a fresh render after a diagonal pan');
  } finally {
    v.setDrawing(originalDrawing); v.setImages(originalImages); v.findings = originalFindings; v.hiddenLayers = originalLayers;
  }
  document.querySelector('#fit').click();
  await wait(100);
  const home = camera();
  const rect = v.canvas.getBoundingClientRect();
  const wheelAnchor = v.screenToWorld(130, 150);
  let wheelRenders = 0;
  v.renderRaster = function (...args) { wheelRenders++; return Object.getPrototypeOf(v).renderRaster.apply(this, args); };
  for (let i = 0; i < 3; i++) v.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: rect.left + 130, clientY: rect.top + 150, cancelable: true }));
  assert(same(camera(), home), 'wheel input must animate instead of jumping immediately');
  await wait(40);
  assert(v.scale !== home[2] && wheelRenders === 0, 'wheel zoom must stretch cached tiles instead of re-rendering every frame');
  await wait(460);
  delete v.renderRaster;
  assert(wheelRenders > 0 && v.front.scale === v.scale && !v.pending, 'wheel zoom must re-render at the final scale once it settles');
  assert(Math.abs(v.scale / home[2] - Math.exp(.6)) < 1e-6, 'wheel animation must accumulate every wheel event and settle exactly');
  assert(same(v.screenToWorld(130, 150), wheelAnchor), 'animated zoom must preserve the cursor anchor');
  document.querySelector('#view-back').click();
  assert(same(camera(), home), 'Back must undo the complete wheel gesture');
  await wait(300);
  wheelRenders = 0;
  v.renderRaster = function (...args) { wheelRenders++; return Object.getPrototypeOf(v).renderRaster.apply(this, args); };
  for (let i = 0; i < 12; i++) { v.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: rect.left + 130, clientY: rect.top + 150, cancelable: true })); await wait(20); }
  assert(wheelRenders === 0 && v.scale > 4 * v.front.scale, 'a long wheel zoom must keep stretching, not render at intermediate scales');
  await wait(600);
  delete v.renderRaster;
  assert(v.front.scale === v.scale && !v.pending, 'a long wheel zoom must re-render once it settles');
  document.querySelector('#view-back').click();
  assert(same(camera(), home), 'Back must undo a long wheel gesture');
  v.smoothZoomAt(130, 150, 2);
  document.querySelector('#fit').click();
  const fitted = camera();
  await wait(150);
  assert(same(camera(), fitted), 'Fit must cancel an unfinished wheel animation');
  assert(!v.showAllFindings, 'overview must start with only the active finding marker');
  document.querySelector('#all-markers').click();
  assert(v.showAllFindings, 'all finding markers can be enabled');
  document.querySelector('#all-markers').click();
  document.querySelector('#zoom-in').click();
  assert(v.scale > home[2], 'zoom control must increase scale');
  document.querySelector('#view-back').click();
  assert(same(camera(), home), 'Back must restore camera');

  const anchor = v.screenToWorld(130, 150);
  v.zoomAt(130, 150, 1.4);
  assert(same(v.screenToWorld(130, 150), anchor), 'zoom must keep the cursor anchor');
  v.draw();
  const renderRaster = v.renderRaster;
  let renders = 0;
  v.renderRaster = function (...args) { renders++; return renderRaster.apply(this, args); };
  try {
    v.panBy(12, 8); v.draw();
    assert(renders <= Math.ceil(v.width / 256) + Math.ceil(v.height / 256) + 4, 'small pans may render only newly exposed edge tiles');
    renders = 0;
    v.panBy(400, 0); v.draw();
    assert(renders > 0 && renders < v.front.tiles.size, 'long pans must reuse overlapping tiles');
    renders = 0;
    v.panBy(-400, 0); v.draw();
    assert(renders === 0, 'reversing a long drag must reuse previously rendered tiles');
    const hidden = v.hiddenLayers;
    v.hiddenLayers = new Set(v.drawing.layers.map((_, i) => i)); v.draw();
    assert(renders > 0, 'layer visibility must invalidate raster tiles');
    renders = 0;
    v.hiddenLayers = hidden; v.draw();
    assert(renders > 0, 'restoring layers must invalidate raster tiles');
    renders = 0;
    v.zoomAt(130, 150, 1.4); v.draw();
    assert(renders > 0, 'zoom must rerender geometry at its new scale');
    // Retained tile pixels are bounded even when a drag covers many viewports.
    for (let i = 0; i < 80; i++) { v.panBy(256, 256); v.draw(); }
    assert((v.front.tiles.size + (v.back?.tiles.size ?? 0)) * Math.ceil(262 * devicePixelRatio) ** 2 <= Math.max(16_000_000, (Math.ceil(v.width / 256) + 1) * (Math.ceil(v.height / 256) + 1) * Math.ceil(262 * devicePixelRatio) ** 2), 'long drags must keep raster memory bounded');
  } finally { v.renderRaster = renderRaster; }

  for (const side of ['left', 'right']) {
    const ribbon = document.querySelector(`#ribbon-${side}`);
    document.querySelector(`[data-collapse="${side}"]`).click();
    assert(document.body.classList.contains(`${side}-hidden`) && getComputedStyle(ribbon).display !== 'none', 'collapse must leave the edge ribbon');
    const tab = ribbon.querySelector('button:not(.on)');
    tab.click();
    assert(!document.body.classList.contains(`${side}-hidden`) && getComputedStyle(ribbon).display === 'none', 'a ribbon tab must reopen the panel');
    assert(document.querySelector(`#${side} [data-pane="${tab.dataset.tab}"]`).classList.contains('on'), 'a ribbon tab must open its pane');
    document.querySelector(`#${side} .tabs button[data-tab]`).click();
  }
  if (document.querySelector('#findings li[data-i="0"]')) {
    const beforeFinding = camera();
    document.querySelector('#findings li[data-i="0"]').click();
    assert(document.querySelector('[data-pane="findings"]').classList.contains('on'), 'finding selection must keep the list open');
    assert(v.activeFinding, 'finding must be highlighted');
    document.querySelector('#view-back').click();
    assert(same(camera(), beforeFinding), 'Back must return from a finding');
  }
  v.selected.clear(); v.activeFinding = null;
  v.panBy(60, 20);
  const beforeLint = camera();
  document.querySelector('#relint').click();
  for (let i = 0; i < 100 && document.querySelector('#findings').textContent.includes('Linting…'); i++) await wait(50);
  assert(!document.querySelector('#findings').textContent.includes('Linting…'), 'lint must finish');
  assert(same(camera(), beforeLint), 're-lint must not reset navigation');
  document.querySelector('#fit').click();
  await wait(100);

  // Measure frames delivered by the browser, not the CPU time to enqueue canvas calls.
  async function benchmark() {
    const frames = [];
    let previous = performance.now();
    for (let i = 0; i < 150; i++) {
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      frames.push(now - previous); previous = now;
      const direction = i % 80 < 40 ? 1 : -1;
      v.panBy(24 * direction, 8 * direction);
    }
    const samples = frames.slice(10).sort((a, b) => a - b);
    return { medianMs: samples[70], p95Ms: samples[133], maxMs: samples.at(-1), framesOver25Ms: samples.filter((ms) => ms > 25).length };
  }
  const overviewPan = await benchmark();
  document.querySelector('#fit').click();
  v.zoomAt(v.width / 2, v.height / 2, 4);
  await wait(100);
  const detailPan = await benchmark();
  document.querySelector('#fit').click();
  return { passed: true, overviewPan, detailPan, entities: v.drawing.entities.length };
})()
