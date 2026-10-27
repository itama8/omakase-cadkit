import assert from "node:assert/strict";
import path from "node:path";
import { after, test } from "node:test";
import { DrawingStore } from "../src/store.ts";
import { renderSvg } from "../src/render-svg.ts";
import type { Prim } from "../src/types.ts";

const store = new DrawingStore();
after(() => store.close());
type Fill = Extract<Prim, ["f", ...unknown[]]>;
function inside(loop: number[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) {
    if ((loop[i+1] > y) !== (loop[j+1] > y) && x < (loop[j]-loop[i]) * (y-loop[i+1]) / (loop[j+1]-loop[i+1]) + loop[i]) hit = !hit;
  }
  return hit;
}
function filled(p: Fill, x: number, y: number): boolean {
  return p[5].filter(l => inside(l, x, y)).length % 2 === 1;
}

test("hatch text-box metadata cannot refill islands or cut frame edges", async () => {
  const { drawing: d } = await store.open(path.resolve("fixtures/hatch_text.dxf"));
  const fills = d.prims.filter((p): p is Fill => p[0] === "f");
  assert.equal(fills.length, 6);
  for (let variant = 0; variant < 3; variant++) {
    const p = fills[variant];
    const x = variant * 40 - d.origin[0], y = -d.origin[1];
    assert.equal(p[5].length, [3, 2, 1][variant], "ordinary boundary paths remain intact");
    assert.equal(p.length, 6, "text boxes are omitted from geometric fill primitives");
    assert.equal(filled(p, x + 0.5, y + 6), true, "outside border is filled");
    assert.equal(filled(p, x + 2, y + 6), variant === 2, "ordinary island stays hollow");
    assert.equal(filled(p, x + 6, y + 6), variant !== 1, "nested island restores fill");
    for (const dx of [10, 16, 20]) {
      assert.equal(filled(p, x + dx, y + 6), variant !== 1, "text boxes do not alter geometric islands");
      assert.equal(filled(p, x + dx, y + 0.5), true, "bottom frame remains continuous");
      assert.equal(filled(p, x + dx, y + 11.5), true, "top frame remains continuous");
    }
  }
  // A transformed block retains its geometric fill without artificial text cutouts.
  const stamp = fills[5];
  const angle = Math.PI / 6;
  const at = (x: number, y: number): [number, number] => [80 + 1.5*(x*Math.cos(angle)-y*Math.sin(angle))-d.origin[0], 30 + 1.5*(x*Math.sin(angle)+y*Math.cos(angle))-d.origin[1]];
  assert.equal(filled(stamp, ...at(3, 6)), true);
  assert.equal(filled(stamp, ...at(15, 6)), true, "rotated fill does not acquire an artificial cutout");
  const svg = renderSvg(d, { bbox: [-5, -5, 115, 75], width: 1200, dark: true });
  assert.equal((svg.match(/<mask /g) ?? []).length, 0);
  assert.ok(!svg.includes("hatch-text-"));
});

test("continuous hatch families preserve nested islands at surveyed coordinates in both boundary encodings", async () => {
  const { drawing: d } = await store.open(path.resolve("fixtures/continuous_hatch.dxf"));
  assert.deepEqual(d.emitErrors, []);
  assert.deepEqual(d.unrendered, {});
  const hatches = d.entities.map((e, i) => e.type === "HATCH" ? i : -1).filter(i => i >= 0);
  assert.equal(hatches.length, 2);
  for (const [variant, entity] of hatches.entries()) {
    const prim = d.prims.find(p => p[0] === "l" && p[1] === entity);
    assert.ok(prim && prim[0] === "l");
    const lengths = new Map<string, number>();
    const x = 500000 + variant * 20 - d.origin[0], y = 2700000 - d.origin[1];
    for (let i = 0; i < prim[4].length; i += 4) {
      const [ax, ay, bx, by]: number[] = prim[4].slice(i, i + 4);
      const horizontal: boolean = Math.abs(by - ay) < 1e-7;
      assert.ok(horizontal || Math.abs(bx - ax) < 1e-7, "only the two specified families are drawn");
      const row: number = horizontal ? ay - y : ax - x;
      assert.ok(Math.abs(row % 1 - .5) < 1e-7, "family base point and offset are retained");
      const key = `${horizontal ? "h" : "v"}:${row.toFixed(1)}`;
      lengths.set(key, (lengths.get(key) ?? 0) + Math.hypot(bx - ax, by - ay));
    }
    assert.equal(lengths.size, 22);
    for (let row = .5; row < 10; row++) {
      const expected = row < 2 || row > 8 ? 12 : row > 4 && row < 6 ? 8 : 4;
      assert.ok(Math.abs(lengths.get(`h:${row.toFixed(1)}`)! - expected) < 1e-7, `horizontal row ${row} clips its islands`);
    }
    assert.ok(Math.abs([...lengths.values()].reduce((a, b) => a + b, 0) - 160) < 1e-7);
  }
});

test("pattern preparation retains shared blocks, dashed rows and dense-pattern rejection", { timeout: 5000 }, async () => {
  const { drawing: d } = await store.open(path.resolve("fixtures/pattern_pipeline.dxf"));
  assert.deepEqual(d.emitErrors, []);
  assert.equal(d.unrendered?.["HATCH pattern (too dense, drawn as a tint)"], 1);
  const lines = d.prims.filter((p): p is Extract<Prim, ["l", ...unknown[]]> => p[0] === "l");
  assert.equal(lines.length, 3, "both block placements and the dashed hatch remain drawn");
  assert.equal(lines[0][4].length, lines[1][4].length);
  for (let i = 0; i < lines[0][4].length; i++) {
    assert.ok(Math.abs(lines[1][4][i] - lines[0][4][i] - (i % 2 === 0 ? 20 : 0)) < 1e-7, "shared hatch geometry retains each insert transform");
  }
  for (const line of lines.slice(0, 2)) {
    let length = 0;
    for (let i = 0; i < line[4].length; i += 4) length += Math.hypot(line[4][i + 2] - line[4][i], line[4][i + 3] - line[4][i + 1]);
    assert.ok(Math.abs(length - 160) < 1e-7, "block hatch keeps both nested islands");
  }
  const dashed = lines[2][4];
  assert.equal(dashed.length / 4, 60, "each of ten rows retains six one-unit dashes");
  for (let i = 0; i < dashed.length; i += 4) assert.ok(Math.abs(Math.hypot(dashed[i + 2] - dashed[i], dashed[i + 3] - dashed[i + 1]) - 1) < 1e-7);
  assert.equal(d.prims.filter(p => p[0] === "f" && p[4] === 0).length, 1, "only the rejected dense pattern falls back to a tint");
});
