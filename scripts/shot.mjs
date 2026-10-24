#!/usr/bin/env node
// Headless screenshot of the viewer after the drawing has loaded and drawn.
//   node scripts/shot.mjs <url> <out.png> [width height] [--eval "js run before the shot"]
// Uses the Chrome DevTools protocol over Node's built-in WebSocket; needs `chromium` on PATH.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [url, out, w = "1500", h = "900"] = process.argv.slice(2).filter((a, i, all) => a !== "--eval" && all[i - 1] !== "--eval");
const evalIdx = process.argv.indexOf("--eval");
const pre = evalIdx > 0 ? process.argv[evalIdx + 1] : null;
if (!url || !out) {
  console.error("usage: shot.mjs <url> <out.png> [width height] [--eval js]");
  process.exit(2);
}
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(path.join(tmpdir(), "drawkit-shot-"));
const chrome = spawn(process.env.CHROMIUM ?? "chromium", ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${w},${h}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(150);
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
  } catch {}
}
if (!target) throw new Error("chromium did not start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
try {
  await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  let state = null;
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    state = await evaluate("window.drawkit && window.drawkit.state && window.drawkit.state()");
    if (state && state.entities && state.findings !== undefined) break;
  }
  await sleep(400);
  if (pre) console.log("eval:", JSON.stringify(await evaluate(pre)));
  await sleep(400);
  await evaluate("window.drawkit && window.drawkit.view.draw()");
  state = await evaluate("window.drawkit && window.drawkit.state()");
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log(out, JSON.stringify(state));
} finally {
  ws.close();
  chrome.kill();
}
