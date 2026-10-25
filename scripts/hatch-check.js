// Run in the loaded hatch_text.dxf viewer, e.g. shot.mjs --eval "$(cat scripts/hatch-check.js)".
(() => {
  const v = cadkit.view;
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sample = (tile, x, y) => {
    const margin = (tile.canvas.width / v.dpr - 1250) / 2;
    return [...tile.canvas.getContext("2d").getImageData(Math.round((x * 10 + margin) * v.dpr), Math.round((-y * 10 + 700 + margin) * v.dpr), 1, 1).data].slice(0, 3);
  };
  const tile = v.renderRaster(10, 0, -700, 1250, 750, false);
  const bg = sample(tile, 35, 20);
  const clear = (t, x, y) => sample(t, x, y).every((c, i) => c === bg[i]);
  // The middle fixture is a frame, with two overlapping text boxes extending
  // past both its top and bottom. Check the whole frame, not just its end caps.
  for (let x = 40.5; x <= 69.5; x += 0.5) {
    assert(!clear(tile, x, 0.5), `bottom frame missing at ${x}`);
    assert(!clear(tile, x, 11.5), `top frame missing at ${x}`);
  }
  for (let y = 0.5; y <= 11.5; y += 0.5) {
    assert(!clear(tile, 40.5, y), `left frame missing at ${y}`);
    assert(!clear(tile, 69.5, y), `right frame missing at ${y}`);
  }
  for (const x of [50, 56, 60]) assert(clear(tile, x, 8), "frame interior must stay hollow");
  assert(clear(tile, 42, 6), "ordinary island must stay hollow");
  assert(!clear(tile, 6, 6), "nested island must remain filled");
  assert(!clear(tile, 96, 8), "text-box metadata must not punch holes into solid geometry");
  const red = sample(tile, 56, 2);
  assert(red[0] > red[1] * 2, "underlying line must survive inside the frame");
  const green = sample(tile, 12, 30);
  assert(green[1] > green[0] * 2, "independent hatch overlap must not cancel");
  v.selected.add(v.drawing.prims.filter(p => p[0] === "f")[1][1]);
  const selected = v.renderRaster(10, 0, -700, 1250, 750, true);
  assert(clear(selected, 56, 8), "selection must preserve hollow frame interior");
  for (let x = 40.5; x <= 69.5; x += 0.5) {
    assert(!clear(selected, x, 0.5), "selected bottom frame must stay continuous");
    assert(!clear(selected, x, 11.5), "selected top frame must stay continuous");
  }
  v.selected.clear();
  v.draw();
  return { continuousFrame: "pass", islands: "pass", underlyingLine: "pass", independentOverlap: "pass", selection: "pass" };
})()
