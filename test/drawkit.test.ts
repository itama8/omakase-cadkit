// End-to-end tests: sidecar -> payload -> sheet analysis -> lint -> SVG.
// Needs `npm run build:sidecar` and `npm run fixtures`. The private block runs only on a
// machine that has the project drawings.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { lintContext, lintSet, makeContext } from "../src/lint/engine.ts";
import { sewerNetwork } from "../src/lint/sewer.ts";
import { renderSvg } from "../src/render-svg.ts";
import { DrawingStore } from "../src/store.ts";
import type { Finding } from "../src/types.ts";

const FIX = path.resolve(import.meta.dirname, "../fixtures");
const store = new DrawingStore();
after(() => store.close());

async function lintFile(file: string, packs?: string[]) {
  const { drawing } = await store.open(file);
  const ctx = makeContext(file, drawing, loadConfig(file));
  return { ctx, result: lintContext(ctx, { packs }) };
}
const rules = (fs: Finding[], sev?: string) => fs.filter((f) => !sev || f.severity === sev).map((f) => f.rule).sort();

before(() => {
  for (const f of ["sewer_clean.dxf", "sewer_bad.dxf", "scale_wrong.dxf"])
    if (!existsSync(path.join(FIX, f))) throw new Error(`missing fixture ${f}: run \`npm run fixtures\``);
});

describe("payload", () => {
  test("sidecar reads a DXF into entities and render primitives", async () => {
    const { drawing: d } = await store.open(path.join(FIX, "sewer_clean.dxf"));
    assert.equal(d.schema, 1);
    assert.equal(d.header.insUnits, "Meters");
    const mh = d.entities.filter((e) => e.type === "INSERT" && e.block === "MH");
    assert.equal(mh.length, 5);
    assert.ok(d.prims.length > d.entities.length, "block content is expanded into primitives");
    // every primitive points back at a real entity
    for (const p of d.prims) assert.ok(d.entities[p[1]], `prim refers to entity ${p[1]}`);
    // circles inside blocks survive as true circles at world size
    const circles = d.prims.filter((p) => p[0] === "c");
    assert.ok(circles.some((c) => Math.abs((c as any)[6] - 0.6) < 1e-6));
  });

  test("text is plain text with height and position", async () => {
    const { drawing: d } = await store.open(path.join(FIX, "sewer_clean.dxf"));
    const t = d.entities.find((e) => e.text === "MH- 1");
    assert.ok(t);
    assert.equal(t!.height, 1);
    assert.deepEqual(t!.ins, [102, 156]);
  });
});

describe("sheet", () => {
  test("finds the frame, the declared scale and the drawing number", async () => {
    const { ctx } = await lintFile(path.join(FIX, "sewer_clean.dxf"));
    assert.equal(ctx.sheet.frames.length, 1);
    const f = ctx.sheet.frames[0];
    assert.equal(f.paper, "A1");
    assert.equal(f.measured, 500);
    assert.deepEqual(f.declared?.ratios, [500]);
    assert.equal(f.drawingNumber?.text, "TEST/SEWER/D1");
  });
});

describe("lint", () => {
  test("a clean drawing has no findings", async () => {
    const { result } = await lintFile(path.join(FIX, "sewer_clean.dxf"));
    assert.deepEqual(result.findings, [], JSON.stringify(result.findings, null, 1));
    assert.deepEqual(result.ruleErrors, []);
  });

  test("every planted defect is found, and nothing else", async () => {
    const { result } = await lintFile(path.join(FIX, "sewer_bad.dxf"));
    assert.deepEqual(rules(result.findings, "error"), [
      "dimension-override",
      "sewer-gradient",
      "sewer-levels",
      "sewer-pipe-label",
      "sewer-stacked-manholes",
      "text-height-paper",
    ]);
    assert.deepEqual(rules(result.findings, "warning"), ["duplicate-entities", "sewer-connectivity"]);
    const msg = (r: string) => result.findings.find((f) => f.rule === r)!.message;
    assert.match(msg("sewer-levels"), /MH 3: depth label 1\.00 m but GL 22\.20 − IL 20\.40 = 1\.80 m/);
    assert.match(msg("sewer-pipe-label"), /Pipe 4: labelled 25\.0 m, drawn 30\.0 m/);
    assert.match(msg("sewer-gradient"), /Pipe 3 \(3 → 4\): flow arrow points uphill/);
    assert.match(msg("sewer-connectivity"), /MH 9 has no pipe/);
    assert.match(msg("text-height-paper"), /0\.60 mm/);
  });

  test("findings carry handles of real entities and a box to show", async () => {
    const { ctx, result } = await lintFile(path.join(FIX, "sewer_bad.dxf"));
    for (const f of result.findings) {
      for (const h of f.handles) assert.ok(ctx.byHandle.has(h), `${f.rule} cites unknown handle ${h}`);
      if (f.rule !== "sewer-connectivity" || f.handles.length) assert.ok(f.bbox, `${f.rule} has no bbox`);
    }
  });

  test("a wrong scale label is an error", async () => {
    const { result } = await lintFile(path.join(FIX, "scale_wrong.dxf"));
    assert.deepEqual(rules(result.findings), ["scale-mismatch"]);
    assert.match(result.findings[0].message, /Declares 1:100 but the frame plots at 1:500 on A1/);
  });

  test("the same drawing number in two files is caught across the set", async () => {
    const files = ["sewer_clean.dxf", "scale_wrong.dxf"].map((f) => path.join(FIX, f));
    const ctxs = [];
    for (const f of files) ctxs.push(makeContext(f, (await store.open(f)).drawing, loadConfig(f)));
    const { setFindings } = lintSet(ctxs);
    assert.equal(setFindings.filter((f) => f.rule === "drawing-number-duplicate").length, 2);
  });
});

describe("network", () => {
  test("rebuilds manholes, pipes, levels and flow", async () => {
    const { ctx } = await lintFile(path.join(FIX, "sewer_clean.dxf"));
    const n = sewerNetwork(ctx)!;
    const mh = n.manholes.filter((m) => !m.outfall);
    assert.equal(mh.length, 5);
    assert.deepEqual(mh.map((m) => m.id).sort(), ["1", "2", "3", "4", "5"]);
    const m3 = mh.find((m) => m.id === "3")!;
    assert.deepEqual([m3.gl, m3.il, m3.depth], [22.2, 20.4, 1.8]);
    assert.equal(n.pipes.length, 4);
    for (const p of n.pipes) {
      assert.equal(p.flowSource, "arrow");
      assert.equal(p.dia, 150);
      assert.equal(p.labelLen, 30);
    }
  });
});

describe("render", () => {
  test("SVG of a region contains its labels and highlights", async () => {
    const { drawing: d } = await store.open(path.join(FIX, "sewer_clean.dxf"));
    const i = d.entities.findIndex((e) => e.text === "MH- 2");
    const svg = renderSvg(d, { bbox: [120, 130, 150, 170], width: 600, highlight: new Set([i]) });
    assert.match(svg, /^<svg/);
    assert.match(svg, />MH- 2</);
    assert.match(svg, /#ff3b30/);
  });
});

describe("convert", () => {
  test("DXF -> DWG -> DXF keeps every entity", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "drawkit-test-"));
    try {
      const dwg = path.join(dir, "bad.dwg");
      const r = await store.convert(path.join(FIX, "sewer_bad.dxf"), dwg);
      const src = (await store.open(path.join(FIX, "sewer_bad.dxf"))).drawing;
      assert.equal(r.entities, src.entities.length);
      const back = (await store.open(dwg)).drawing;
      assert.equal(back.entities.length, src.entities.length);
      assert.deepEqual(back.entities.map((e) => e.text).filter(Boolean).sort(), src.entities.map((e) => e.text).filter(Boolean).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const PRIVATE_DWG = "/path/to/private-drawing.dwg";
describe("private D3 R5 (real drawing, local only)", { skip: !existsSync(PRIVATE_DWG) && "drawing not on this machine" }, () => {
  test("known findings", async () => {
    const { ctx, result } = await lintFile(PRIVATE_DWG);
    const f = (rule: string) => result.findings.filter((x) => x.rule === rule);
    assert.equal(ctx.sheet.units.used, "m");
    assert.match(f("scale-mismatch")[0].message, /Declares 1:100 but the frame plots at 1:2,000 on A0/);
    assert.match(f("units-declared")[0].message, /\$INSUNITS is Inches/);
    assert.equal(f("sewer-stacked-manholes").length, 3, "three stacked outfall flag groups");
    // crowded labels pair the way the hydraulic model does (checked against manholes.shp/pipes.shp):
    // the MH- 260 label sits nearer MH 256's symbol, and P- 174 is drawn 15° off its pipe
    const n0 = sewerNetwork(ctx)!;
    assert.equal(n0.manholes.find((m) => m.id === "256")?.h, "5DF85");
    assert.equal(n0.manholes.find((m) => m.id === "260")?.h, "5DF80");
    assert.equal(n0.pipes.find((p) => p.id === "173")?.h, "5DD0D");
    assert.equal(n0.pipes.find((p) => p.id === "174")?.h, "5DD0E");
    assert.equal(n0.pipes.find((p) => p.id === "299")?.labelLen, 29.1);
    // labels and levels pair up without false alarms
    assert.equal(f("sewer-pipe-label").filter((x) => x.severity === "error").length, 0);
    assert.equal(f("sewer-levels").filter((x) => x.severity === "error").length, 0);
    assert.equal(f("sewer-gradient").filter((x) => x.severity === "error").length, 0);
    const n = sewerNetwork(ctx)!;
    assert.equal(n.pipes.length, 589);
    assert.equal(n.manholes.filter((m) => m.id).length, 589);
  });
});
