// Run with shot.mjs --eval after loading a fixture. Loading must progress even
// when the browser suspends animation frames, and finish after rendering the canvas.
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const frame = window.requestAnimationFrame;
  const draw = cadkit.view.draw;
  const renderRaster = cadkit.view.renderRaster;
  const originalFetch = window.fetch;
  const file = cadkit.state().file;
  let renderedWhileLoading = false;
  try {
    window.requestAnimationFrame = () => 0;
    cadkit.view.draw = function (...args) {
      renderedWhileLoading ||= !document.querySelector('#overlay').classList.contains('hidden');
      return draw.apply(this, args);
    };
    const opening = cadkit.open(file);
    let timer;
    try {
      await Promise.race([opening, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('open stalled without animation frames')), 3000); })]);
    } finally { clearTimeout(timer); }
    assert(renderedWhileLoading, 'loading must cover the first canvas render');
    assert(document.querySelector('#overlay').classList.contains('hidden'), 'completed drawing must dismiss loading feedback');
    assert(cadkit.state().ready, 'drawing and checks must finish without animation frames');
    window.requestAnimationFrame = frame;
    const v = cadkit.view;
    // A slow check response used to change the sheet camera after "Opened".
    window.fetch = async (...args) => {
      if (String(args[0]).startsWith('/api/lint')) await new Promise(resolve => setTimeout(resolve, 1300));
      return originalFetch(...args);
    };
    const delayed = cadkit.open(file);
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert(!cadkit.state().ready, 'ready must wait for the sheet camera and completed frame');
    assert(/1s elapsed/.test(document.querySelector('#overlay').textContent), 'elapsed feedback must continue while checks choose the sheet frame');
    await delayed;
    assert(!v.pending && v.front.scale === v.scale, 'completion must cover the final sheet frame');
    window.fetch = originalFetch;
    // Preparing an uncached drawing is cancellable and cannot replace the live view.
    const current = v.drawing;
    const copy = structuredClone(current);
    const abort = new AbortController();
    abort.abort();
    let cancelled = false;
    try { await v.prepareDrawing(copy, abort.signal); } catch (err) { cancelled = err.name === 'AbortError'; }
    assert(cancelled && v.drawing === current, 'cancelled preparation must preserve the displayed drawing');
    await v.prepareDrawing(copy, new AbortController().signal);
    const prepared = v.preparedDrawings.get(copy);
    assert(prepared && prepared.primBox.every((n, i) => n === v.primBox[i]), 'async preparation must preserve exact primitive bounds');
    v.draw();
    let previewBuilds = 0;
    v.renderRaster = function (...args) { previewBuilds++; return renderRaster.apply(this, args); };
    if (v.overview) v.overview.canvas.width = 1;
    v.overview = null;
    v.scheduleOverview();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert(v.overview && previewBuilds === 0, 'idle zoom preview must reuse completed pixels without replaying drawing geometry');
    let renders = 0;
    v.renderRaster = function (...args) { renders++; return renderRaster.apply(this, args); };
    v.smoothZoomAt(v.width / 2, v.height / 2, 1.5);
    await new Promise(resolve => setTimeout(resolve, 40));
    v.setImages(v.images);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert(renders === 0, 'an image arriving during wheel motion must preserve cached frames');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert(!v.pending && !v.zoomMotion && v.front.scale === v.scale, 'image refresh must render at the settled scale');
    return { suspendedFrames: 'pass', firstRender: 'pass', finalSheetFrame: 'pass', preparation: 'pass', idlePreview: 'pass', imageDuringZoom: 'pass' };
  } finally {
    window.requestAnimationFrame = frame;
    window.fetch = originalFetch;
    cadkit.view.draw = draw;
    cadkit.view.renderRaster = renderRaster;
    cadkit.view.request();
  }
})()
