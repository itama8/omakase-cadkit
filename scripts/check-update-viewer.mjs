// Deterministic browser checks without contacting GitHub or launching an installer.
//   node scripts/check-update-viewer.mjs [output folder, default /tmp]
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const output = path.resolve(process.argv[2] ?? tmpdir());
const child = spawn(process.execPath, ["src/server.ts", "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
let proxy;
const runShot = (url, name, expression, check = false) => new Promise((resolve, reject) => {
  const shot = spawn(process.execPath, ["scripts/shot.mjs", url, path.join(output, name), ...(check ? ["--check"] : []), "--eval", expression], { stdio: "inherit" });
  shot.once("error", reject);
  shot.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Screenshot check exited ${code}`)));
});
try {
  const base = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { const m = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (m) resolve(m[0]); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Server exited ${code}`)));
  });
  let installing = null, portable = false;
  proxy = createServer(async (req, res) => {
    try {
      if (req.url === "/api/update") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ enabled: true, available: true, current: "0.1.0-alpha.2", latest: "0.1.0-alpha.3", page: "https://github.com/itama8/omakase-cadkit/releases", installer: portable ? undefined : { name: "setup.exe" }, installing }));
      } else if (req.url === "/api/update/install") {
        installing = { state: "failed", error: "Test checksum mismatch; nothing was installed" };
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end("{}");
      } else {
        const upstream = await fetch(base + req.url);
        res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([k]) => !["content-length", "content-encoding", "transfer-encoding"].includes(k))));
        res.end(Buffer.from(await upstream.arrayBuffer()));
      }
    } catch (err) { res.writeHead(502); res.end(String(err)); }
  }).listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const url = `http://127.0.0.1:${proxy.address().port}/?file=${encodeURIComponent(path.resolve("fixtures/sewer_bad.dxf"))}`;
  const offer = `(async()=>{ await new Promise(r=>setTimeout(r,1800)); const box=document.querySelector('#update'); if(box.hidden || !box.textContent.includes('alpha.3')) throw Error('Missing update offer'); return {offer:true}; })()`;
  await runShot(url, "cadkit-update-available.png", offer, true);
  await runShot(url, "cadkit-update-recovery.png", readFileSync("scripts/update-check.js", "utf8"));
  portable = true;
  await runShot(url, "cadkit-update-download.png", `(async()=>{await new Promise(r=>setTimeout(r,1800)); const link=document.querySelector('#update-link'); if(link.hidden || !document.querySelector('#update-install').hidden || !link.href.startsWith('https://github.com/')) throw Error('Missing portable download link'); return {download:true};})()`);
} finally {
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); }
}
