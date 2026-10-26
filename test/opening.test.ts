import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("drawing revalidation skips payload transfer, detects edits, and browses folders", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cadkit-opening-"));
  const drawing = path.join(dir, "drawing.dxf");
  copyFileSync(path.resolve("fixtures/sewer_bad.dxf"), drawing);
  const child = spawn(process.execPath, ["src/server.ts", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OMAKASE_CADKIT_CACHE: path.join(dir, "cache") },
  });
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
    const url = `${base}/api/drawing?file=${encodeURIComponent(drawing)}`;
    const first = await fetch(url);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-omakase-cadkit-cached"), "false");
    assert.match(first.headers.get("server-timing")!, /read;dur=\d+/);
    assert.ok((await first.json()).entities.length > 0);
    const etag = first.headers.get("etag")!;
    assert.ok(etag);
    const repeat = await fetch(url, { headers: { "If-None-Match": etag } });
    assert.equal(repeat.status, 304);
    assert.equal(await repeat.text(), "");
    // Changing the file must invalidate a browser's retained object.
    const st = statSync(drawing);
    utimesSync(drawing, st.atime, new Date(st.mtimeMs + 2000));
    const changed = await fetch(url, { headers: { "If-None-Match": etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), etag);
    await changed.arrayBuffer();
    const root = path.parse(dir).root;
    const listing = await (await fetch(`${base}/api/files?dir=${encodeURIComponent(root)}`)).json();
    assert.equal(listing.parent, root);
    const last = await (await fetch(`${base}/api/files`)).json();
    assert.equal(last.dir, dir);
    assert.equal((await fetch(`${base}/api/pick-folder`, { method: "POST", headers: { Origin: "https://unrelated.example" } })).status, 403);
    assert.equal((await fetch(`${base}/api/pick-folder`)).status, 405);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
