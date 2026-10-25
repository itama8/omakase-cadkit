// A separate package that uses omakase-cadkit only through its documented exports.
// Run from the repository root with `npm run consumer`.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DrawingHandle, Entity } from "omakase-cadkit";

// The payload cache directory is read when the package is imported, so choose it first.
const cacheDir = process.env.OMAKASE_CADKIT_CACHE ?? mkdtempSync(path.join(tmpdir(), "cadkit-consumer-"));
process.env.OMAKASE_CADKIT_CACHE = cacheDir;
const { Cadkit, CadkitError } = await import("omakase-cadkit");

const FIXTURE = path.resolve(import.meta.dirname, "../../fixtures/sewer_bad.dxf");
const kit = new Cadkit();
assert.equal(kit.running, false, "constructing a Cadkit must not start the sidecar");
let opened: DrawingHandle | undefined;

try {
  // Open: one sidecar per instance, spawned by the first uncached open.
  const dwg = await kit.open(FIXTURE);
  opened = dwg;
  assert.equal(kit.running, true, "the first uncached open starts the sidecar");
  console.log(
    `open      ${path.basename(dwg.file)}: ${dwg.drawing.entities.length} entities, ` +
      `${dwg.drawing.layers.length} layers, ${dwg.loadMs} ms, cached=${dwg.cached}`,
  );

  // Inspect entities through the documented filters.
  const texts: Entity[] = dwg.entities({ type: ["TEXT", "MTEXT"] });
  assert.ok(texts.length > 0, "the fixture has text entities");
  const first = texts[0];
  assert.equal(dwg.entity(first.h)?.h, first.h, "handle lookup returns the same entity");
  const onLayer = dwg.entities({ layer: [dwg.layerName(first)] });
  assert.ok(onLayer.some((e) => e.h === first.h), "layer filter finds the same entity");
  console.log(`inspect   ${texts.length} text entities; ${dwg.layerName(first)} holds ${onLayer.length}`);

  // Lint, then render one finding to SVG.
  const result = dwg.lint();
  assert.ok(result.findings.length > 0, "the bad fixture has findings");
  assert.ok(result.counts.error > 0, "the bad fixture has errors");
  const svg = dwg.render({ findings: result.findings.slice(0, 1), width: 900 });
  assert.match(svg, /^<svg xmlns=/);
  writeFileSync(path.join(cacheDir, "consumer.svg"), svg);
  console.log(
    `lint      ${result.findings.length} findings, ${result.counts.error} errors, ` +
      `${result.rulesRun.length} rules from ${result.packs.join(",")}`,
  );
  console.log(`render    ${svg.length} bytes of SVG, written to ${path.join(cacheDir, "consumer.svg")}`);

  // Errors are explicit and name the cause.
  assert.throws(
    () => dwg.render({ handles: ["NOPE"] }),
    (e: unknown) => e instanceof CadkitError && /no entity with handle NOPE/.test(e.message),
  );
  await assert.rejects(kit.open("/nonexistent/missing.dwg"), /no file at/);
  console.log("errors    unknown handle -> CadkitError; missing file -> Error naming the path");
} finally {
  kit.close();
}

assert.equal(kit.closed, true);
assert.equal(kit.running, false, "close stops the sidecar");
await assert.rejects(
  kit.open(FIXTURE),
  (e: unknown) => e instanceof CadkitError && /closed/.test(e.message),
);
console.log("close     sidecar stopped; later opens rejected with CadkitError");

// A drawing that was already returned still works without the sidecar: it owns data,
// not a process.
assert.ok(opened, "a drawing was opened");
assert.match(opened.render({ width: 200 }), /^<svg xmlns=/);
console.log("close     sidecar stopped; later opens rejected; opened drawings still render");
console.log("ok        library consumer finished");
