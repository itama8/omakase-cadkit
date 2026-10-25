// Public source-checkout smoke: no private drawings, global installs, or shared server.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), "omakase-cadkit-smoke-"));
const env = { ...process.env, OMAKASE_CADKIT_CACHE: path.join(temp, "cache") };
const cli = (...args) => {
  const r = spawnSync(process.execPath, ["bin/omakase-cadkit.mjs", ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.ifError(r.error);
  return r;
};
let child;
try {
  const inspected = cli("inspect", "fixtures/sewer_clean.dxf", "--json");
  assert.equal(inspected.status, 0, inspected.stderr);
  const info = JSON.parse(inspected.stdout);
  assert.ok(info.entities > 0);
  assert.equal(info.units.used, "m");
  const clean = cli("lint", "fixtures/sewer_clean.dxf");
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  const bad = cli("lint", "fixtures/sewer_bad.dxf");
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /sewer-levels/);
  const svg = path.join(temp, "review.svg");
  const rendered = cli("render", "fixtures/sewer_bad.dxf", "--finding", "1", "--out", svg);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(readFileSync(svg, "utf8"), /<svg/);

  child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { startServer } from './src/server.ts';
    const server = startServer(0);
    server.on('listening', () => console.log('READY:' + server.address().port));
  `], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("viewer startup timed out: " + diagnostics)), 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`viewer exited ${code}: ${diagnostics}`)); });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/READY:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const get = async (url) => {
    const response = await fetch(base + url, { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, url);
    return response;
  };
  assert.equal((await (await get("/api/health")).json()).ok, true);
  assert.match(await (await get("/")).text(), /omakase-cadkit/);
  assert.ok((await (await get("/viewer.js")).text()).length > 1000);
  const query = "?file=" + encodeURIComponent(path.join(root, "fixtures/sewer_bad.dxf"));
  const drawing = await (await get("/api/drawing" + query)).json();
  assert.ok(drawing.entities.length > 0 && drawing.prims.length > 0);
  const lint = await (await get("/api/lint" + query)).json();
  assert.ok(lint.findings.some((f) => f.rule === "sewer-levels"));
  console.log("Smoke passed: inspect, clean/bad lint exits, SVG export, viewer assets, drawing and lint endpoints.");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  rmSync(temp, { recursive: true, force: true });
}
