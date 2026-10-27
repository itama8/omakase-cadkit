// Run with shot.mjs --eval after loading a fixture. Loading must progress even
// when the browser suspends animation frames, and finish after rendering the canvas.
(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const frame = window.requestAnimationFrame;
  const draw = cadkit.view.draw;
  const renderRaster = cadkit.view.renderRaster;
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
    v.draw();
    let renders = 0;
    v.renderRaster = function (...args) { renders++; return renderRaster.apply(this, args); };
    v.smoothZoomAt(v.width / 2, v.height / 2, 1.5);
    await new Promise(resolve => setTimeout(resolve, 40));
    v.setImages(v.images);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert(renders === 0, 'an image arriving during wheel motion must preserve cached frames');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert(!v.pending && !v.zoomMotion && v.front.scale === v.scale, 'image refresh must render at the settled scale');
    return { suspendedFrames: 'pass', firstRender: 'pass', imageDuringZoom: 'pass' };
  } finally {
    window.requestAnimationFrame = frame;
    cadkit.view.draw = draw;
    cadkit.view.renderRaster = renderRaster;
    cadkit.view.request();
  }
})()
