// Launches the built download bundle the way a tester does, with no Node or .NET on PATH,
// then asks its private server for health and a lint result. Run after `npm run bundle`.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "dist-bundle");
const entry = existsSync(out) ? readdirSync(out, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.startsWith("omakase-cadkit-")) : null;
if (!entry) throw new Error("no bundle in dist-bundle/: run `npm run bundle` first");
const bundle = path.join(out, entry.name);
const win = process.platform === "win32";
const port = 4290;
const home = mkdtempSync(path.join(tmpdir(), "omakase-cadkit-bundle-"));
const fixture = path.join(bundle, "fixtures", "sewer_bad.dxf");
if (!existsSync(fixture)) throw new Error(`no ${path.relative(root, fixture)} in the bundle`);

// On Unix an empty PATH proves the bundle needs no installed tools. Windows always
// needs its own system directories (PowerShell, cmd), so only HOME is replaced there.
const env = win
  ? { ...process.env, HOME: home, USERPROFILE: home }
  : { HOME: home, PATH: "/usr/bin:/bin" };
const launcher = win
  ? spawn("cmd.exe", ["/c", "launch.cmd", "view", fixture, "--no-open", "--port", String(port)], { cwd: bundle, env, stdio: ["ignore", "pipe", "pipe"] })
  : spawn("bash", ["launch.command", "view", fixture, "--no-open", "--port", String(port)], { cwd: bundle, env, stdio: ["ignore", "pipe", "pipe"] });

let output = "";
for (const stream of [launcher.stdout, launcher.stderr]) stream.on("data", (chunk) => { output += chunk; });
const exitCode = await new Promise((resolve, reject) => {
  launcher.once("error", reject);
  launcher.once("exit", resolve);
});
if (exitCode !== 0) throw new Error(`bundle launcher exited ${exitCode}:\n${output}`);

const base = `http://127.0.0.1:${port}`;
let health;
for (let i = 0; i < 60 && !health; i++) {
  health = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).catch(() => null);
  if (!health) await new Promise((r) => setTimeout(r, 250));
}
if (!health?.ok) throw new Error(`no health answer from the bundled server:\n${output}`);

try {
  const lint = await fetch(`${base}/api/lint?file=${encodeURIComponent(fixture)}`, { signal: AbortSignal.timeout(60_000) }).then((r) => r.json());
  const findings = lint.findings ?? [];
  if (!findings.some((f) => f.rule === "sewer-levels")) throw new Error(`bundle lint returned no sewer-levels finding (${findings.length} findings)`);
  console.log(`Bundle ${entry.name}: launched with ${win ? "system" : "no"} PATH, ${findings.length} findings, sidecar ${health.build}.`);
} finally {
  try { process.kill(health.pid); } catch {}
  rmSync(home, { recursive: true, force: true });
}
