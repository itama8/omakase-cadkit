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
