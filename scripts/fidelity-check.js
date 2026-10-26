// Run in fidelity.dxf with scripts/shot.mjs --eval "$(cat scripts/fidelity-check.js)".
(async () => {
  const v = cadkit.view;
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await document.fonts.ready;
  for (let i = 0; i < 100 && (!v.images.length || !document.querySelector('.meta-fidelity')); i++)
    await new Promise(r => setTimeout(r, 50));
  let tile = v.renderRaster(10, 0, -700, 1600, 750, false);
  const margin = (tile.canvas.width / v.dpr - 1600) / 2;
  const sample = (x, y) => [...tile.canvas.getContext('2d').getImageData(Math.round((x * 10 + margin) * v.dpr), Math.round((-y * 10 + 700 + margin) * v.dpr), 1, 1).data].slice(0, 3);
  const bg = sample(150, 60);
  const clear = (x, y) => sample(x, y).every((c, i) => c === bg[i]);
  const inkNear = (x, y, radius = .2) => {
    for (let dx = -radius; dx <= radius; dx += .1)
      for (let dy = -radius; dy <= radius; dy += .1)
        if (!clear(x + dx, y + dy)) return true;
    return false;
  };
  assert(sample(10, 30)[0] > 180 && sample(10, 30)[1] < 80, 'wide polyline has an opaque red interior');
  assert(clear(15, 10), 'hatch island stays hollow');
  assert(inkNear(5, 5, .6), 'hatch texture contains diagonal lines');
  assert(inkNear(4, 25), 'dash paints its on segment');
  assert(clear(10, 25), 'dash leaves its off segment clear');
  assert(inkNear(90, 10), 'cached table has a vertical grid line');
  assert(inkNear(43, 4.8), 'ordinary leader draws a connector');
  assert(inkNear(40.5, .8), 'ordinary leader draws an arrowhead');
  assert(inkNear(40.5, 20.8), 'multileader draws an arrowhead');
  const blue = sample(112, 10);
  assert(blue[2] > blue[0] * 3 && blue[2] > blue[1] * 2, 'embedded logo paints the source colour');
  assert(clear(128, 10), 'embedded logo mask preserves the background');
  document.querySelector('.meta-fidelity').click();
  const notice = document.querySelector('#fidelity-list').textContent;
  assert(notice.includes('missing-logo.png') && notice.includes('Looked in:'), 'notice identifies missing image and search locations');
  assert(notice.includes('romans.shx'), 'notice identifies font substitution');
  document.querySelector('#fidelity-close').click();
  const originalTheme = document.documentElement.dataset.theme;
  if (originalTheme !== 'light') document.querySelector('#theme-toggle').click();
  tile = v.renderRaster(10, 0, -700, 1600, 750, false);
  const line = sample(4, 25);
  assert(line.every(c => c < 180), 'paper theme rebuilds cached vector colours to dark ink');
  if (originalTheme !== 'light') document.querySelector('#theme-toggle').click();
  v.fit([-5,-5,160,70], 0);
  return { wideFill: 'pass', hatchIslandAndPattern: 'pass', dashGaps: 'pass', tableGrid: 'pass', leaders: 'pass', embeddedLogo: 'pass', missingImageNotice: 'pass', fontNotice: 'pass', themeColours: 'pass' };
})()
