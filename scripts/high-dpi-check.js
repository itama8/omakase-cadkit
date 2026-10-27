// Run on a large drawing with shot.mjs --dpr 2 --eval. Exercises the actual
// worker boundary, independent source strokes, cache invalidation and disposal.
(async () => {
  const v = cadkit.view, original = v.drawing, images = v.images, findings = v.findings;
  const camera = [v.cx, v.cy, v.scale], hidden = v.hiddenLayers;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  v.draw();
  assert(v.strokePool, 'run this check on a drawing with more than 100000 primitives at high display scale');
  const Pool = v.strokePool.constructor;
  let pool;
  const results = [];
  try {
    const strokes = [];
    for (let y = -80; y <= 80; y += .6) for (let x = -80; x <= 80; x += 5) strokes.push(x, y, x + 3, y + 2);
    // Include overlapping hatch strokes, a dashed path and curves across tile edges.
    const drawing = { ...original, origin: [0, 0], dashes: [[3, 2]], layers: [{ name: '0' }, { name: 'Hidden' }], entities: [], prims: [
      ['l', 0, 0, 0xffffff, strokes], ['l', 1, 0, 0xff0000, strokes.map((n, i) => n + (i % 2 ? .15 : .2))],
      ['p', 2, 0, 0x00ff00, 0, [-100, 0, 100, 0, 100, 30], 0],
      ['c', 3, 0, 0x0000ff, 0, 0, 24], ['a', 4, 1, 0xffff00, 0, 0, 40, .2, 4.8],
    ] };
    v.setDrawing(drawing); v.hiddenLayers = new Set();
    const groups = v.tiles.flatMap(t => t.batches.filter(b => b.kind === 'stroke').map(b => ({ sources: b.sources, cost: [...b.parts?.values() ?? []].reduce((n, p) => n + p.segments, b.sources.length) })));
    pool = new Pool(drawing, v.primBox, v.extents, v.theme, groups, () => {});
    const image = document.createElement('canvas'); image.width = image.height = 2;
    const imageCtx = image.getContext('2d'); imageCtx.fillStyle = '#ff0000'; imageCtx.fillRect(0, 0, 2, 2);
    imageCtx.fillStyle = '#00ff00'; imageCtx.fillRect(0, 0, 1, 1);
    const imageBitmap = await createImageBitmap(image);
    const overlays = [{ bitmap: imageBitmap, layer: 1, ins: [-80, -80], u: [60, 10], v: [-10, 60], size: [2, 2], fade: 35, clip: [[0, 0], [2, 1]] }];
    v.setImages(overlays);
    await pool.setImages(overlays);
    for (const hiddenLayers of [[], [], [1]]) {
      v.hiddenLayers = new Set(hiddenLayers);
      const scale = 2, left = -128, top = -128, size = 262;
      const expected = v.renderRaster(scale, left + 3, top + 3, 256, 256, false).canvas;
      let work;
      const start = performance.now();
      while (!(work = pool.render({ scale, left, top, width: size, height: size, dpr: v.dpr, hidden: hiddenLayers, images: 1 })) && performance.now() - start < 5000) await wait(10);
      assert(work, 'stroke workers must become ready');
      const parts = await work;
      assert(parts.every(Boolean), 'workers must return every batch partition');
      const canvas = document.createElement('canvas'); canvas.width = expected.width; canvas.height = expected.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = v.theme.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const background = parts.find(p => p.background)?.background;
      assert(background, 'the worker must return transformed images');
      ctx.drawImage(background, 0, 0);
      for (const part of parts) { ctx.drawImage(part.bitmap, 0, 0); part.bitmap.close(); part.background?.close(); }
      const a = expected.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const b = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let maxDelta = 0, interiorDelta = 0, edgePixels = 0;
      // CPU OffscreenCanvas and the host canvas use different clip-edge AA.
      // Permit that only within two device pixels of the explicit image clip;
      // source strokes and every image interior pixel retain the strict check.
      const clip = [[-100, 40], [20, 60], [30, 0], [-90, -20]].map(([x, y]) => [(x * scale - left) * v.dpr, (-y * scale - top) * v.dpr]);
      const edgeDistance = (x, y) => Math.min(...clip.map(([ax, ay], j) => {
        const [bx, by] = clip[(j + 1) % clip.length], dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        return Math.hypot(x - ax - t * dx, y - ay - t * dy);
      }));
      for (let i = 0; i < a.length; i += 4) {
        const pixel = i / 4, x = pixel % canvas.width, y = Math.floor(pixel / canvas.width);
        // renderRaster's three-CSS-pixel gutter is outside its displayed core.
        // Compare the visible area, including every internal worker boundary.
        if (x < 3 * v.dpr || y < 3 * v.dpr || x >= canvas.width - 3 * v.dpr || y >= canvas.height - 3 * v.dpr) continue;
        let delta = 0; for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(a[i + c] - b[i + c]));
        maxDelta = Math.max(maxDelta, delta);
        if (!hiddenLayers.includes(1) && delta > 2 && edgeDistance(pixel % canvas.width + .5, Math.floor(pixel / canvas.width) + .5) <= 2) edgePixels++;
        else interiorDelta = Math.max(interiorDelta, delta);
      }
      assert(interiorDelta <= 2, `worker source geometry and order must match the host away from image clip AA: ${JSON.stringify({ hiddenLayers, maxDelta, interiorDelta, edgePixels })}`);
      results.push({ hiddenLayers, maxDelta, interiorDelta, edgePixels });
    }
    assert(pool.matches(drawing, v.extents, v.theme), 'unchanged geometry can reuse workers');
    const imageVersion = pool.imageRevision;
    await pool.setImages(overlays);
    assert(pool.imageRevision === imageVersion, 'refreshing immutable images must reuse their worker copies');
    strokes[0] += 1;
    assert(!pool.matches(drawing, v.extents, v.theme), 'in-place hatch edits must invalidate workers');
    strokes[0] -= 1;
    drawing.prims[2][3] = 0xff0000;
    assert(!pool.matches(drawing, v.extents, v.theme), 'in-place ordinary stroke edits must invalidate workers');
    drawing.prims[2][3] = 0x00ff00;
    assert(pool.matches(drawing, v.extents, v.theme), 'restored geometry matches again');
    drawing.origin[0] = 1;
    assert(!pool.matches(drawing, v.extents, v.theme), 'image origin edits must invalidate workers');
    drawing.origin[0] = 0;
    const work = pool.render({ scale: 2, left: -128, top: -128, width: 262, height: 262, dpr: v.dpr, hidden: [] });
    assert(work, 'idle workers must accept another job');
    pool.dispose();
    for (const part of await work) { part?.bitmap.close(); part?.background?.close(); }
    assert(pool.failed && pool.render({}) === null, 'disposed workers must resolve outstanding jobs and reject new work');
    imageBitmap.close();
    return { pixels: results, invalidation: 'pass', disposal: 'pass' };
  } finally {
    pool?.dispose();
    v.setDrawing(original); v.setImages(images); v.findings = findings; v.hiddenLayers = hidden;
    [v.cx, v.cy, v.scale] = camera; v.draw();
  }
})()
