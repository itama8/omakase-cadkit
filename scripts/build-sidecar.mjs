// Find an SDK on PATH, or in the standard per-user dotnet installation.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const exe = process.platform === "win32" ? "dotnet.exe" : "dotnet";
const candidates = [
  process.env.DOTNET_ROOT && path.join(process.env.DOTNET_ROOT, exe),
  path.join(homedir(), ".dotnet", exe),
  exe,
].filter(Boolean);
const sdk = candidates.find((candidate) => {
  const result = spawnSync(candidate, ["--list-sdks"], { encoding: "utf8" });
  return result.status === 0 && /^([89]|[1-9]\d+)\./m.test(result.stdout);
});
if (!sdk) {
  console.error("Install the .NET 8 SDK (not only the runtime), then retry npm run build:sidecar. See docs/setup.md.");
  process.exit(1);
}
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" };
if (path.isAbsolute(sdk)) env.DOTNET_ROOT = path.dirname(sdk);
// Let the apphost launched by Node find the same runtime as this SDK.
const result = spawnSync(sdk, ["build", "sidecar", "-c", "Release", "-o", "bin/sidecar"], { cwd: root, env, stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
