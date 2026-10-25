// The public entry point: a consumer opens, inspects, lints, renders, and closes through
// documented exports only. Needs `npm run build:sidecar` and `npm run fixtures`.

import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { Cadkit, CadkitError } from "../src/index.ts";

const FIX = path.resolve(import.meta.dirname, "../fixtures");
// A fresh copy has no cached payload, so opening it must reach the sidecar.
const TMP = mkdtempSync(path.join(tmpdir(), "cadkit-library-"));
const BAD = path.join(TMP, "sewer_bad.dxf");
copyFileSync(path.join(FIX, "sewer_bad.dxf"), BAD);
const kit = new Cadkit();
after(() => {
  kit.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("public library entry", () => {
  test("constructing a Cadkit starts no sidecar", () => {
    assert.equal(kit.closed, false);
    assert.equal(kit.running, false);
  });

  test("opens a drawing and inspects entities", async () => {
    const dwg = await kit.open(BAD);
    assert.equal(dwg.cached, false);
    assert.equal(kit.running, true);
    assert.ok(dwg.drawing.entities.length > 0);
    assert.ok(dwg.sheet.units.used.length > 0);

    const texts = dwg.entities({ type: ["TEXT", "MTEXT"] });
    assert.ok(texts.length > 0);
    const first = texts[0];
    assert.equal(dwg.entity(first.h)?.h, first.h);
    assert.ok(dwg.entities({ layer: [dwg.layerName(first)] }).some((e) => e.h === first.h));
  });

  test("lints and renders the same drawing", async () => {
    const dwg = await kit.open(BAD);
    const result = dwg.lint();
    assert.ok(result.findings.length > 0);
    assert.ok(result.ruleErrors.length === 0, JSON.stringify(result.ruleErrors));
    const svg = dwg.render({ findings: result.findings.slice(0, 1), width: 600 });
    assert.match(svg, /^<svg xmlns=/);
  });

  test("names the cause of an unknown handle", async () => {
    const dwg = await kit.open(path.join(FIX, "sewer_clean.dxf"));
    assert.throws(
      () => dwg.render({ handles: ["NOPE"] }),
      (e: unknown) => e instanceof CadkitError && /no entity with handle NOPE/.test(e.message),
    );
  });

  test("close stops the sidecar and rejects later opens", async () => {
    kit.close();
    assert.equal(kit.closed, true);
    assert.equal(kit.running, false);
    await assert.rejects(
      kit.open(path.join(FIX, "sewer_clean.dxf")),
      (e: unknown) => e instanceof CadkitError && /closed/.test(e.message),
    );
  });
});
