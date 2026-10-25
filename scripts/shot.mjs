#!/usr/bin/env node
// Headless screenshot of the viewer after the drawing has loaded and drawn.
//   node scripts/shot.mjs <url> <out.png> [width height] [--eval "js run before the shot"]
// Uses the Chrome DevTools protocol over Node's built-in WebSocket; needs `chromium` on PATH.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [url, out, w = "1500", h = "900"] = process.argv.slice(2).filter((a, i, all) => a !== "--eval" && a !== "--check" && all[i - 1] !== "--eval");
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
const evaluate = async (expression) => {
  const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.error || response.result?.exceptionDetails) throw new Error(JSON.stringify(response.error ?? response.result.exceptionDetails));
  return response.result?.result?.value;
};
try {
  await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  let state = null;
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    state = await evaluate("window.drawkit && window.drawkit.state && window.drawkit.state()");
    if (state?.ready) break;
  }
  if (!state?.ready) throw new Error("drawing and lint did not become ready");
  await sleep(400);
  if (process.argv.includes("--check")) {
    console.log("checks:", JSON.stringify(await evaluate(readFileSync(new URL("./viewer-check.js", import.meta.url), "utf8"))));
    // Use real browser input to cover pointer capture, drag thresholds and release cleanup.
    const drag = await evaluate(`(() => { const v = drawkit.view; const r = v.canvas.getBoundingClientRect(); return { x: Math.round(r.left + r.width * .8), y: Math.round(r.top + r.height * .6), dx: -2 * Math.round(r.width * .3), dy: -2 * Math.round(r.height * .125), cx: v.cx, cy: v.cy, scale: v.scale, selected: v.selected.size }; })()`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: drag.x, y: drag.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: drag.x, y: drag.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 48; i++) {
      const t = i <= 24 ? i / 24 : 1 - (i - 24) / 48;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: drag.x + drag.dx * t, y: drag.y + drag.dy * t, button: "left", buttons: 1 });
      await sleep(16);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: drag.x + drag.dx / 2, y: drag.y + drag.dy / 2, button: "left", buttons: 0, clickCount: 1 });
    await sleep(50);
    const end = await evaluate("({cx: drawkit.view.cx, cy: drawkit.view.cy, panning: drawkit.view.canvas.classList.contains('panning'), selected: drawkit.view.selected.size, coordinates: document.querySelector('#coords').textContent})");
    if (end.panning || end.selected !== drag.selected || end.coordinates === '—' || Math.abs(end.cx - (drag.cx - drag.dx / (2 * drag.scale))) > 1e-6 || Math.abs(end.cy - (drag.cy + drag.dy / (2 * drag.scale))) > 1e-6) throw new Error(`pointer drag failed: ${JSON.stringify({ drag, end })}`);
    await evaluate("document.querySelector('#fit').click()");
    console.log("pointer drag: passed");
  }
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
  await new Promise((resolve) => chrome.once("exit", resolve));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
