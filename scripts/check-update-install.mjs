// Windows CI: reinstall over a running installed copy and exercise /RELAUNCH=1.
// This checks the stop/replace/restart path with the same build, not a version upgrade.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

if (process.platform !== "win32") throw new Error("Run this check on Windows");
const [setup, folder] = process.argv.slice(2).map((value) => path.resolve(value));
if (!setup || !folder) throw new Error("usage: check-update-install.mjs <setup.exe> <installed folder>");
const exe = path.join(folder, "omakase-cadkit.exe");
const run = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: "inherit", env: { ...process.env, CI: "1" } });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`)));
});
const health = () => fetch("http://127.0.0.1:4280/api/health", { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
const waitForHealth = async (previousPid) => {
  for (let i = 0; i < 120; i++) {
    const info = await health();
    if (info?.ok && info.pid !== previousPid) return info;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Installed viewer did not restart on port 4280");
};
assert.equal(await health(), null, "port 4280 must be free before the upgrade check");
try {
  await run(exe, ["--no-open"]);
  const before = await waitForHealth();
  await run(setup, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/RELAUNCH=1", `/DIR=${folder}`]);
  const after = await waitForHealth(before.pid);
  assert.equal(after.version, before.version, "this rehearsal reinstalls the same build");
  const fixture = encodeURIComponent(path.join(folder, "fixtures", "sewer_bad.dxf"));
  const lint = await fetch(`http://127.0.0.1:4280/api/lint?file=${fixture}`, { signal: AbortSignal.timeout(60000) }).then((r) => r.json());
  assert.ok(lint.findings.some((f) => f.rule === "sewer-levels"));
  console.log(`Installer replacement restarted viewer ${before.pid} -> ${after.pid}; drawing lint passed.`);
} finally {
  await run(exe, ["stop"]);
}
