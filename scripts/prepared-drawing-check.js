// Check repeat-open reuse plus colour and in-place edit correctness.
(async () => {
  const v = cadkit.view, drawing = v.drawing, images = v.images, findings = v.findings;
  const camera = [v.cx, v.cy, v.scale], theme = v.theme, hidden = v.hiddenLayers;
  const build = v.buildTiles;
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  let builds = 0;
  try {
    v.buildTiles = function (...args) { builds++; return build.apply(this, args); };
    await cadkit.open(cadkit.state().file);
    assert(builds === 0, 'revalidated repeat open must reuse prepared geometry');
    const line = ['p', 0, 0, 0xffffff, 0, [-100, 0, 100, 0]];
    const changed = { ...drawing, origin: [0, 0], layers: [{ name: '0' }], entities: [{ h: 'EDIT', type: 'LINE', layer: 0, color: 0xffffff, bbox: [-100, 0, 100, 40] }], prims: [line] };
    const centre = (y = 0) => [...v.canvas.getContext('2d').getImageData(Math.floor(v.canvas.width / 2), Math.floor((v.height / 2 - y) * v.dpr), 1, 1).data];
    const draw = () => { v.cx = v.cy = 0; v.scale = 1; v.draw(); };
    v.hiddenLayers = new Set();
    v.setDrawing(changed); draw();
    assert(centre()[0] > 100, 'initial editable geometry must be visible');
    line[5] = [-100, 40, 100, 40];
    v.setDrawing(changed); draw();
    assert(centre()[0] < 100 && centre(40)[0] > 100, 'default setDrawing must rebuild an object edited in place');
    v.theme = { ...theme, ink: '#ff0000' };
    const beforeThemeOpen = builds;
    v.setDrawing(changed, true); draw();
    const red = centre(40);
    assert(builds === beforeThemeOpen + 1 && red[0] > 100 && red[1] < 50, 'cached geometry must be rebuilt for a different theme');
    const beforeReplacement = builds;
    v.setDrawing({ ...changed }, true);
    assert(builds === beforeReplacement + 1, 'replacement payloads must compile their own geometry');
    assert(v.preparedDrawings.size <= 2, 'prepared drawing retention must stay bounded');
    return { repeatOpen: 'pass', inPlaceEdit: 'pass', theme: 'pass', replacement: 'pass', retainedDrawings: v.preparedDrawings.size };
  } finally {
    v.buildTiles = build; v.theme = theme;
    v.setDrawing(drawing); v.setImages(images); v.findings = findings; v.hiddenLayers = hidden;
    [v.cx, v.cy, v.scale] = camera; v.draw();
  }
})()
