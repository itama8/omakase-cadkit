import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { inflateSync } from "node:zlib";
import { missingRasters, resolveRaster } from "../src/rasters.ts";
import { renderSvg } from "../src/render-svg.ts";
import { DrawingStore } from "../src/store.ts";

const store = new DrawingStore();
after(() => store.close());
const open = async () => (await store.open(path.resolve("fixtures/fidelity.dxf"))).drawing;

test("MTEXT lays out styled runs inside its box; TEXT fit and underline keep measured width", async () => {
  const d = await open();
  const runs = d.prims.filter(p => p[0] === "t" && d.entities[p[1]].type === "MTEXT");
  assert.ok(runs.length >= 4, "paragraphs wrap onto multiple lines");
  for (const p of runs) {
    assert.equal(p[0], "t");
    if (p[0] !== "t") continue;
    assert.ok(p[12] > 0 && p[12] <= 30.001, `run fits its 30-unit box: ${p[9]}`);
    assert.ok(!/[{}\\]/.test(p[9]), "formatting codes are not printed");
  }
  assert.ok(runs.some(p => p[0] === "t" && p[10] === "serif|b"));
  assert.ok(runs.some(p => p[0] === "t" && p[6] === 2.1), "relative height applies to its own run");
  const fit = d.prims.find(p => p[0] === "t" && p[9] === "FITTED");
  assert.ok(fit && fit[0] === "t");
  assert.equal(fit[12], 30);
  const note = d.prims.find(p => p[0] === "t" && p[9] === "NOTE 90°");
  assert.ok(note);
  assert.ok(d.prims.some(p => p[0] === "p" && p[1] === note[1]), "underline is real geometry");
  assert.ok(Object.keys(d.approximated).some(k => k.includes("romans.shx")));
  const svg = renderSvg(d, { bbox: [-2, -2, 160, 70], width: 1600 });
  assert.ok(svg.includes('lengthAdjust="spacingAndGlyphs"'));
  assert.ok(svg.includes('font-weight="bold"'));
});

test("patterns retain holes; wide polylines, dashes and both leader types draw geometry", async () => {
  const d = await open();
  assert.deepEqual(d.emitErrors, []);
  assert.deepEqual(d.unrendered, {});
  const index = (type: string) => d.entities.findIndex(e => e.type === type);
  const hatch = d.prims.find(p => p[0] === "l" && p[1] === index("HATCH"));
  assert.ok(hatch && hatch[0] === "l" && hatch[4].length > 80, "pattern draws clipped segments");
  const [ox, oy] = d.origin;
  for (let i = 0; i < hatch[4].length; i += 4) {
    const x: number = (hatch[4][i] + hatch[4][i + 2]) / 2 + ox;
    const y: number = (hatch[4][i + 1] + hatch[4][i + 3]) / 2 + oy;
    assert.ok(!(x > 10.001 && x < 19.999 && y > 5.001 && y < 14.999), "island contains no pattern line");
  }
  assert.ok(d.prims.some(p => p[0] === "f" && p[1] === index("LWPOLYLINE") && p[4] === 2));
  const line = d.prims.find(p => p[0] === "p" && p[1] === index("LINE"));
  assert.ok(line && line[0] === "p" && line[6] !== undefined);
  assert.deepEqual(d.dashes[line[6]], [8, 4], "entity linetype scale is preserved");
  for (const type of ["LEADER", "MULTILEADER"]) {
    const ps = d.prims.filter(p => p[1] === index(type));
    assert.ok(ps.some(p => p[0] === "p"), `${type} has a connecting line`);
    assert.ok(ps.some(p => p[0] === "f" && p[4] === 1), `${type} has a filled arrowhead`);
  }
  const svg = renderSvg(d, { bbox: [-2, -2, 160, 70], width: 1600 });
  assert.ok(svg.includes('stroke-dasharray="79.01 39.51"'));
  assert.ok(svg.includes('fill-rule="nonzero"'));
});

test("OLE cached table yields text and rules; two-pass logo yields opaque colour and transparency", async () => {
  const d = await open();
  const table = d.prims.find(p => p[0] === "t" && p[9] === "A1 B2");
  assert.ok(table && table[0] === "t" && table[6] > 1);
  assert.equal(table[12], 8, "cached advances define cell text width");
  assert.ok(d.prims.filter(p => p[0] === "p" && p[1] === table[1]).length >= 3);
  const logo = d.rasters.find(r => r.src);
  assert.ok(logo?.src);
  assert.deepEqual(logo.ins, [110, 0]);
  assert.deepEqual(logo.u, [10, 0]);
  assert.deepEqual(logo.v, [0, 20]);
  const png = Buffer.from(d.images[logo.src].split(",")[1], "base64");
  const compressed: Buffer[] = [];
  for (let i = 8; i < png.length;) {
    const n = png.readUInt32BE(i);
    if (png.toString("ascii", i + 4, i + 8) === "IDAT") compressed.push(png.subarray(i + 8, i + 8 + n));
    i += n + 12;
  }
  assert.deepEqual([...inflateSync(Buffer.concat(compressed))], [0, 10, 70, 220, 255, 255, 255, 255, 0], "logo mask is composed, not displayed as a white square");
  assert.ok(renderSvg(d, { bbox: [109, -1, 131, 21], width: 220 }).includes('href="data:image/png;base64,'));
});

test("missing raster reports its reference, real handle and candidate paths; Windows basenames resolve", async () => {
  const d = await open();
  const missing = missingRasters(d);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].file, "missing-logo.png");
  assert.equal(missing[0].reason, "missing");
  assert.ok(missing[0].handles.every(h => d.entities.some(e => e.h === h && e.type === "IMAGE")));
  assert.ok(missing[0].tried.includes(path.resolve("fixtures/missing-logo.png")));
  const dir = mkdtempSync(path.join(tmpdir(), "cadkit-raster-"));
  try {
    writeFileSync(path.join(dir, "logo.png"), "synthetic");
    assert.equal(resolveRaster(path.join(dir, "drawing.dwg"), "C:\\old\\logo.png")?.abs, path.join(dir, "logo.png"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
