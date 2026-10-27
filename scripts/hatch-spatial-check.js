// Compare all visible hatch strokes with an independent, unpartitioned canvas path.
// Short strokes must survive overview culling; selection and picking retain the entity.
(() => {
  const v = cadkit.view, drawing = v.drawing, images = v.images, findings = v.findings;
  const camera = [v.cx, v.cy, v.scale], hidden = v.hiddenLayers;
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const strokes = [];
  for (let y = -64; y <= 64; y += 2) for (let x = -64; x <= 64; x += 2) strokes.push(x, y, x + .1, y);
  strokes.push(-100, 70, 100, 70);
  try {
    v.hiddenLayers = new Set();
    v.setDrawing({ ...drawing, origin: [0, 0], layers: [{ name: '0' }], entities: [{ h: 'HATCH', type: 'HATCH', layer: 0, color: 0xffffff, bbox: [-100, -64, 100, 70] }], prims: [['l', 0, 0, 0xffffff, strokes]] });
    const reference = document.createElement('canvas');
    const cases = [];
    for (const [cx, cy, scale] of [[0, 0, 2], [31.95, 31, 12], [-63.95, -64, 80]]) {
      v.cx = cx; v.cy = cy; v.scale = scale;
      const left = cx * scale - v.width / 2, top = -cy * scale - v.height / 2;
      const actual = v.renderRaster(scale, left, top, v.width, v.height, false).canvas;
      reference.width = actual.width; reference.height = actual.height;
      const ctx = reference.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = v.theme.bg; ctx.fillRect(0, 0, reference.width, reference.height);
      ctx.setTransform(v.dpr * scale, 0, 0, -v.dpr * scale, v.dpr * (3 - left), v.dpr * (3 - top));
      const path = new Path2D();
      for (let i = 0; i < strokes.length; i += 4) { path.moveTo(strokes[i], strokes[i + 1]); path.lineTo(strokes[i + 2], strokes[i + 3]); }
      ctx.lineCap = 'butt'; ctx.lineJoin = 'bevel'; ctx.lineWidth = 1 / scale; ctx.strokeStyle = v.theme.ink; ctx.stroke(path);
      const expected = ctx.getImageData(0, 0, reference.width, reference.height).data;
      const pixels = actual.getContext('2d').getImageData(0, 0, actual.width, actual.height).data;
      let maxDelta = 0;
      for (let i = 0; i < pixels.length; i++) maxDelta = Math.max(maxDelta, Math.abs(pixels[i] - expected[i]));
      assert(maxDelta <= 1, `visible hatch strokes must match the full source path at scale ${scale}: delta ${maxDelta}`);
      cases.push({ scale, maxDelta });
    }
    v.cx = v.cy = 0; v.scale = 20;
    assert(v.pick(v.width / 2, v.height / 2) === 0, 'partitioned hatch must retain its original entity for inspection');
    return { cases, picking: 'pass' };
  } finally {
    v.setDrawing(drawing); v.setImages(images); v.findings = findings; v.hiddenLayers = hidden;
    [v.cx, v.cy, v.scale] = camera; v.draw();
  }
})()
