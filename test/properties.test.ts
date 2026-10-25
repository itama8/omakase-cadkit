import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { saveUnits } from "../src/config.ts";

test("unit edits preserve inherited, legacy and unknown profile settings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cadkit-units-"));
  try {
    const folder = path.join(dir, "drawings");
    mkdirSync(folder);
    const parent = path.join(dir, "drawkit.json");
    const original = JSON.stringify({ units: "in", paper: "A2", sewer: { minDepth: 1.2 }, extension: { value: 42 } });
    writeFileSync(parent, original);
    const drawing = path.join(folder, "drawing.dxf");
    const target = saveUnits(drawing, "m");
    const saved = () => JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(saved(), { units: "m", paper: "A2", sewer: { minDepth: 1.2 }, extension: { value: 42 } });
    assert.equal(readFileSync(parent, "utf8"), original);
    // Merge from the latest on-disk profile, including edits made outside the viewer.
    writeFileSync(target, JSON.stringify({ ...saved(), paper: "A1" }));
    saveUnits(drawing, null);
    assert.equal(saved().units, undefined);
    assert.equal(saved().paper, "A1");
    assert.throws(() => saveUnits(drawing, "bogus"));
    assert.equal(saved().units, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("properties API persists units and refreshes cached lint without a server restart", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cadkit-properties-"));
  const drawing = path.join(dir, "drawing.dxf");
  copyFileSync(path.resolve("fixtures/sewer_bad.dxf"), drawing);
  const child = spawn(process.execPath, ["src/server.ts", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) resolve(match[0]);
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Server exited ${code}`)));
    });
    const query = `?file=${encodeURIComponent(drawing)}`;
    const getLint = async () => (await fetch(`${base}/api/lint${query}`)).json();
    await getLint(); // Prime context cache.
    const post = (units: unknown, origin = base) => fetch(`${base}/api/properties${query}`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ units }),
    });
    assert.equal((await post("m", "https://unrelated.example")).status, 403);
    assert.equal((await post("invalid")).status, 400);
    assert.equal(existsSync(path.join(dir, "omakase-cadkit.json")), false);
    const response = await post("m");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).units.used, "m");
    const lint = await getLint();
    assert.equal(lint.sheet.units.used, "m");
    assert.equal(lint.sheet.units.source, "config");
    assert.ok(lint.findings.some((f: { rule: string; message: string }) => f.rule === "dimension-override" && / m /.test(f.message)));
    // An external profile edit also invalidates the context cache.
    writeFileSync(path.join(dir, "omakase-cadkit.json"), '{"units":"cm"}');
    assert.equal((await getLint()).sheet.units.used, "cm");
    assert.equal((await post(null)).status, 200);
    assert.notEqual((await getLint()).sheet.units.source, "config");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
