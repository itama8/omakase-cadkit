// A repeatable source-checkout setup. Does not install system tools or start a server.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const uv = spawnSync("uv", ["--version"], { stdio: "ignore" });
if (uv.status !== 0) {
  console.error("Install uv to generate the synthetic drawings, then retry npm run setup. See docs/setup.md.");
  process.exit(1);
}
// npm_execpath avoids platform-specific npm.cmd invocation on Windows.
const npm = process.env.npm_execpath;
if (!npm) {
  console.error("Run this helper with npm run setup.");
  process.exit(1);
}
for (const script of ["build", "fixtures", "typecheck", "test"]) {
  const result = spawnSync(process.execPath, [npm, "run", script], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log("Source checkout ready. Try: node bin/omakase-cadkit.mjs inspect fixtures/sewer_clean.dxf");
