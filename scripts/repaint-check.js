// Run with shot.mjs --eval on a large drawing. Observe what is actually
// composited, not only whether the final screenshot eventually becomes sharp.
(async () => {
  const v = cadkit.view, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await wait(1000);
  v.draw();
  const draw = v.draw, image = v.ctx.drawImage, raster = v.renderRaster;
  let samples = [], presented = new Set(), builds = 0;
  v.ctx.drawImage = function(source, ...args) {
    presented.add(source);
    return image.call(this, source, ...args);
  };
  v.renderRaster = function(...args) { builds++; return raster.apply(this, args); };
  v.draw = function(...args) {
    presented.clear();
    const result = draw.apply(this, args);
    const front = this.front;
    samples.push({ at: performance.now(), moving: !!this.zoomMotion, pending: this.pending, scale: this.scale,
      frontScale: front?.scale, gaps: front ? this.gaps(front) : null, ms: this.lastDrawMs,
      presented: [...front?.tiles.values() ?? []].filter(tile => presented.has(tile.canvas)).length });
    return result;
  };
  const results = [];
  const zoom = async (factor, cached = false) => {
    samples = []; builds = 0;
    const start = performance.now(), target = v.scale * factor, previous = v.front;
    v.smoothZoomAt(130, 150, factor);
    let complete;
    while (performance.now() - start < 3000) {
      complete = samples.find(frame => !frame.moving && !frame.pending && frame.scale === target && frame.frontScale === target && frame.gaps === 0);
      if (complete) break;
      await wait(5);
    }
    const partial = samples.filter(frame => frame.frontScale === target && frame.gaps > 0 && frame.presented > 0);
    const result = { cached, completeMs: complete ? +(complete.at - start).toFixed(1) : null, partialFrames: partial.length,
      rasterBuilds: builds, maxDrawMs: +Math.max(...samples.map(s => s.ms)).toFixed(1) };
    results.push(result);
    assert(complete && result.completeMs <= (cached ? 250 : 500), `repaint missed deadline: ${JSON.stringify(results)}`);
    assert(!partial.length, `new scale appeared in patches: ${JSON.stringify(partial)}`);
    if (cached) assert(builds === 0, `returning to the cached viewport rebuilt ${builds} tiles`);
    assert(v.front !== previous, 'test must change scales');
    assert(v.recentLayers.length <= 2, 'recent scale cache must remain bounded');
    const pixels = v.recentLayers.flatMap(layer => [...layer.tiles.values()]).reduce((n, tile) => n + tile.canvas.width * tile.canvas.height, 0);
    assert(pixels <= 16_000_000, 'recent scales must not retain more than 64 MB of tile pixels');
  };
  try {
    await zoom(Math.exp(.6));
    await zoom(Math.exp(-.6), true);
    await zoom(Math.exp(.6), true);
    await zoom(Math.exp(.3));
    // A scene change must release old pixels even when the requested scale matches.
    const retired = v.recentLayers.flatMap(layer => [...layer.tiles.values()].map(tile => tile.canvas));
    v.refresh(); v.draw();
    assert(!v.recentLayers.length, 'refresh must invalidate every cached scale');
    assert(retired.every(canvas => canvas.width === 1), 'invalidated cached canvases must release their pixels');
    // A pan keeps the current scale's cache and still finishes at the new camera.
    v.panBy(96, -64); await wait(600);
    assert(!v.pending && !v.gaps(v.front), 'pan must finish the exposed region');
    // Abandon an in-flight replacement and return to the already complete scale.
    const home = v.scale;
    v.smoothZoomAt(130, 150, Math.exp(.6)); await wait(140);
    v.smoothZoomAt(130, 150, Math.exp(-.6)); await wait(600);
    assert(Math.abs(v.scale / home - 1) < 1e-12 && !v.pending && !v.gaps(v.front), 'interrupted replacement must recover');
    return results;
  } finally {
    v.draw = draw; v.ctx.drawImage = image; v.renderRaster = raster;
  }
})()
