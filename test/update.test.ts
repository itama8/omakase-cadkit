import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { checkForUpdate, compareVersions, downloadInstaller, installKind, pickUpdate, runInstaller } from "../src/update.ts";

const hash = "a".repeat(64);
const release = (tag = "v0.1.0-alpha.3", digest: string | null = `sha256:${hash}`) => ({
  tag_name: tag, draft: false, html_url: `https://github.com/itama8/omakase-cadkit/releases/tag/${tag}`,
  assets: [{ name: `omakase-cadkit-${tag.slice(1)}-win32-x64-setup.exe`, browser_download_url: "https://example.test/setup.exe", size: 7, digest }],
});

test("update versions order prereleases numerically and ignore build metadata", () => {
  const versions = ["0.1.0-alpha.2", "0.1.0-alpha.10", "0.1.0-alpha.10.1", "0.1.0-beta-a.1", "0.1.0", "0.2.0", "1.0.0"];
  for (let i = 1; i < versions.length; i++) {
    assert.ok(compareVersions(versions[i - 1], versions[i]) < 0);
    assert.ok(compareVersions(versions[i], versions[i - 1]) > 0);
  }
  assert.equal(compareVersions("v0.1.0+abc", "0.1.0+def"), 0);
  assert.throws(() => compareVersions("garbage", "0.1.0"));
});

test("only a newer published release with an exact installer and hash can install", () => {
  const releases = [release(), { ...release("v9.0.0"), draft: true }, release("v0.1.0-alpha.10"), release("v1.2.3oops")];
  const info = pickUpdate(releases, "0.1.0-alpha.2", "windows-installer", "win32", "x64");
  assert.equal(info.latest, "0.1.0-alpha.10");
  assert.equal(info.installer?.sha256, hash);
  assert.equal(pickUpdate(releases, info.latest, "windows-installer", "win32", "x64").available, false);
  assert.equal(pickUpdate(releases, "0.1.0-alpha.2", "download", "win32", "x64").installer, undefined);
  assert.equal(pickUpdate(releases, "0.1.0-alpha.2", "windows-installer", "win32", "arm64").installer, undefined);
  for (const digest of [null, "sha256:bad", "sha512:" + hash]) {
    assert.equal(pickUpdate([release(undefined, digest)], "0.1.0-alpha.2", "windows-installer", "win32", "x64").installer, undefined);
  }
  assert.equal(pickUpdate([release("v0.2.0-beta.1"), release("v0.1.0")], "0.1.0", "download").available, false, "stable copies stay on stable releases");
});

test("release check handles GitHub errors and passes the API response to selection", async () => {
  const mock: typeof fetch = async (_url, init) => {
    assert.ok(init?.signal);
    return Response.json([release()]);
  };
  assert.equal((await checkForUpdate(mock, "download", "0.1.0-alpha.2")).available, true);
  await assert.rejects(checkForUpdate(async () => new Response("", { status: 403 }), "download", "0.1.0"), /403/);
  assert.equal(installKind(), "source");
});

test("installer download verifies actual bytes and removes failed and interrupted downloads", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cadkit-update-test-"));
  const bytes = Buffer.from("installer bytes");
  const server = createServer((_req, res) => res.end(bytes)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const installer = { name: "setup.exe", url: `http://127.0.0.1:${(server.address() as { port: number }).port}/setup.exe`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  try {
    const file = await downloadInstaller(installer, fetch, dir);
    assert.deepEqual(readFileSync(file), bytes);
    rmSync(path.dirname(file), { recursive: true });
    await assert.rejects(downloadInstaller({ ...installer, sha256: hash }, fetch, dir), /SHA-256/);
    await assert.rejects(downloadInstaller({ ...installer, size: 1 }, fetch, dir), /size/);
    await assert.rejects(downloadInstaller(installer, async () => new Response("", { status: 404 }), dir), /404/);
    const broken: typeof fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 2)); controller.error(new Error("connection lost")); } }));
    await assert.rejects(downloadInstaller(installer, broken, dir), /connection lost/);
    assert.deepEqual(readdirSync(dir), []);
    await assert.rejects(runInstaller(path.join(dir, "missing-setup.exe")), /ENOENT/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source viewer exposes its version and refuses install requests without launching anything", { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ["src/server.ts", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Server exited ${code}`)));
    });
    assert.equal((await (await fetch(`${base}/api/health`)).json()).version, JSON.parse(readFileSync("package.json", "utf8")).version);
    assert.deepEqual(await (await fetch(`${base}/api/update`)).json(), { enabled: false });
    assert.equal((await fetch(`${base}/api/update/install`)).status, 405);
    assert.equal((await fetch(`${base}/api/update/install`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${base}/api/update/install`, { method: "POST", headers: { Origin: "https://example.test" } })).status, 403);
    assert.equal((await fetch(`${base}/api/update/install`, { method: "POST", headers: { Origin: base } })).status, 409);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
  }
});

// Run the built server in a disposable installed-app layout. Mock the network and
// installer process in that child, so this test can never run a downloaded executable.
test("installed update endpoints share a check, reject duplicate installs and report launch failure", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cadkit-installed-update-"));
  cpSync("dist", path.join(dir, "dist"), { recursive: true });
  // The fake release is alpha.3; keep its installed predecessor independent of
  // the checkout version so cutting a new release does not change this scenario.
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ ...JSON.parse(readFileSync("package.json", "utf8")), version: "0.1.0-alpha.2" }));
  writeFileSync(path.join(dir, "unins000.exe"), "");
  mkdirSync(path.join(dir, "bin/sidecar"), { recursive: true });
  writeFileSync(path.join(dir, "bin/sidecar/omakase-cadkit-sidecar.exe"), "");
  writeFileSync(path.join(dir, "mock.mjs"), `
    import cp from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { EventEmitter } from "node:events";
    Object.defineProperty(process, "platform", { value: "win32" });
    Object.defineProperty(process, "arch", { value: "x64" });
    const originalSpawn = cp.spawn;
    cp.spawn = function(file, ...args) {
      if (!String(file).endsWith("-setup.exe")) return originalSpawn(process.execPath, ["-e", "process.stdin.resume()"], args[1]);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("Test installer launch refused")));
      return child;
    };
    syncBuiltinESMExports();
    let checks = 0;
    globalThis.fetch = async (url) => {
      await new Promise(r => setTimeout(r, 100));
      if (String(url).includes("api.github.com")) {
        if (++checks > 1) throw Error("Duplicate release request");
        return Response.json([${JSON.stringify(release()).replace(hash, createHash("sha256").update("payload").digest("hex"))}]);
      }
      return new Response("payload");
    };
  `);
  // Node imports need file URLs on Windows. Start the exported server explicitly:
  // macOS resolves /var to /private/var, so argv and import.meta paths can differ.
  const entry = `import(${JSON.stringify(pathToFileURL(path.join(dir, "dist/server.js")).href)}).then(m => m.startServer(0))`;
  const child = spawn(process.execPath, ["--import", pathToFileURL(path.join(dir, "mock.mjs")).href, "--input-type=module", "--eval", entry], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEMP: dir, TMP: dir, OMAKASE_CADKIT_UPDATE_CHECK: "1", OMAKASE_CADKIT_CACHE: path.join(dir, "cache") },
  });
  let errors = "";
  child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-4000); });
  try {
    const base = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk) => { const m = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (m) resolve(m[0]); });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Server exited ${code}: ${errors}`)));
    });
    const infos = await Promise.all(Array.from({ length: 4 }, async () => (await fetch(`${base}/api/update`)).json()));
    assert.ok(infos.every((info) => info.installer && !info.error), JSON.stringify(infos));
    const post = (headers = { Origin: base }) => fetch(`${base}/api/update/install`, { method: "POST", headers });
    assert.equal((await post({ Origin: "http://evil.example", Host: "evil.example" } as any)).status, 403);
    assert.equal((await post()).status, 202);
    assert.equal((await post()).status, 409);
    let state;
    for (let i = 0; i < 30; i++) {
      state = await (await fetch(`${base}/api/update`)).json();
      if (state.installing?.state === "failed") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(state.installing.error, /Test installer launch refused/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
    rmSync(dir, { recursive: true, force: true });
  }
});
