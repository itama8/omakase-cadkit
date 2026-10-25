// Builds a runnable folder and ZIP for the current platform: prebuilt sidecar, the Node
// runtime, the compiled CLI and the viewer. A tester unzips it and double-clicks Launch;
// nothing is downloaded, installed or built on their machine.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const outDir = path.join(root, "dist-bundle");
const win = process.platform === "win32";

// .NET runtime identifiers for the three supported systems.
const rids = { "linux-x64": "linux-x64", "linux-arm64": "linux-arm64", "darwin-x64": "osx-x64", "darwin-arm64": "osx-arm64", "win32-x64": "win-x64", "win32-arm64": "win-arm64" };
const rid = rids[`${process.platform}-${process.arch}`];
if (!rid) {
  console.error(`No bundle for ${process.platform}-${process.arch}. Supported: ${Object.keys(rids).join(", ")}`);
  process.exit(1);
}
const name = `omakase-cadkit-${pkg.version}-${process.platform}-${process.arch}`;
const stage = path.join(outDir, name);

const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", ...options });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
};
const copy = (from, to) => {
  const abs = path.join(root, from);
  if (!existsSync(abs)) throw new Error(`missing ${from}: run npm run build first`);
  cpSync(abs, path.join(stage, to ?? from), { recursive: true });
};

// The sidecar is published self-contained, so the tester needs no .NET at all.
const dotnet = [process.env.DOTNET_ROOT && path.join(process.env.DOTNET_ROOT, win ? "dotnet.exe" : "dotnet"), path.join(homedir(), ".dotnet", win ? "dotnet.exe" : "dotnet"), win ? "dotnet.exe" : "dotnet"].filter(Boolean).find((candidate) => {
  const r = spawnSync(candidate, ["--list-sdks"], { encoding: "utf8" });
  return r.status === 0 && /^([89]|[1-9]\d+)\./m.test(r.stdout);
});
if (!dotnet) {
  console.error("Bundle needs the .NET 8 SDK to publish the sidecar. See docs/setup.md.");
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// Build what goes inside, so a stale dist/ cannot ship.
run(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"]);
const { build } = await import("esbuild");
await build({ entryPoints: [path.join(root, "viewer/main.ts")], bundle: true, format: "esm", target: "es2022", outfile: path.join(root, "viewer/dist/viewer.js") });
run(dotnet, ["publish", "sidecar", "-c", "Release", "-r", rid, "--self-contained", "true", "-p:PublishSingleFile=true", "-p:EnableCompressionInSingleFile=true", "-o", path.join(stage, "bin", "sidecar")]);

// The Node runtime: the one Setup downloaded, or this dev machine's as a fallback.
const savedNode = path.join(root, ".tools", "node", "bin", win ? "node.exe" : "node");
const nodeSource = existsSync(savedNode) ? savedNode : process.execPath;
if (nodeSource === process.execPath) console.warn(`warning: bundling this machine's Node (${process.version}), not the Node 24 that Setup installs`);
mkdirSync(path.join(stage, ".tools", "node", "bin"), { recursive: true });
cpSync(nodeSource, path.join(stage, ".tools", "node", "bin", win ? "node.exe" : "node"));
writeFileSync(path.join(stage, ".tools", "node-path.txt"), `.tools/node/bin/${win ? "node.exe" : "node"}\n`);
// Relative paths keep the folder runnable after it is moved; nothing here needs .NET.
writeFileSync(path.join(stage, ".tools", "environment.json"), `${JSON.stringify({ node: `.tools/node/bin/${win ? "node.exe" : "node"}`, dotnetRoot: "", paths: [] }, null, 2)}\n`);

copy("bin/omakase-cadkit.mjs");
copy("bin/drawkit.mjs");
copy("dist");
copy("viewer/index.html");
copy("viewer/style.css");
if (existsSync(path.join(root, "viewer/fonts"))) copy("viewer/fonts");
copy("viewer/dist");
copy("fixtures/omakase-cadkit.json");
for (const file of readdirSync(path.join(root, "fixtures")).filter((f) => /\.(dxf|dwg)$/i.test(f))) copy(path.join("fixtures", file));
for (const file of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "package.json"]) copy(file);
copy("docs");
copy("licenses");
copy("skills");
copy("launch.command");
copy("launch.cmd");
copy("scripts/launch.mjs");
copy("scripts/launch.ps1");

// Downloading an unsigned ZIP can add a quarantine flag on macOS; say so before it bites.
writeFileSync(path.join(stage, "START-HERE.txt"), `omakase-cadkit ${pkg.version} — alpha

1. Keep this folder where you unzipped it. It contains everything the app needs.
2. Launch: double-click ${win ? "launch.cmd" : "launch.command"}
   (macOS: if the system refuses to run it, right-click it and choose Open, or run
   "xattr -dr com.apple.quarantine ." once in this folder.)
3. The viewer opens at http://127.0.0.1:4280/ — open a drawing with the folder icon,
   or launch straight onto one:
   ${win ? "launch.cmd" : "bash launch.command"} view "C:\\path\\to\\drawing.dwg"
4. Sample drawings are in fixtures/. Try ${win ? "launch.cmd" : "bash launch.command"} lint fixtures${win ? "\\" : "/"}sewer_bad.dxf

What is not drawn yet: paper-space layouts, OLE table contents, hatch textures,
linetypes. Report problems at https://github.com/itama8/omakase-cadkit/issues with
your OS, the commands you ran and the exit code. Keep private drawings local.
`);

// Zip with whatever the platform has; testers expect a double-clickable archive.
const zipPath = path.join(outDir, `${name}.zip`);
rmSync(zipPath, { force: true });
if (win) {
  run("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${stage}' -DestinationPath '${zipPath}' -CompressionLevel Optimal`]);
} else if (spawnSync("zip", ["-v"], { stdio: "ignore" }).status === 0) {
  run("zip", ["-qr", zipPath, name], { cwd: outDir });
} else {
  run("tar", ["-czf", zipPath.replace(/\.zip$/, ".tar.gz"), name], { cwd: outDir });
}

const mb = (file) => `${(statSync(file).size / 1e6).toFixed(0)} MB`;
console.log(`bundle: ${path.relative(root, stage)}`);
console.log(`archive: ${path.relative(root, zipPath)} (${mb(zipPath)})`);
