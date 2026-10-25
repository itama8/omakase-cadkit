// omakase-cadkit viewer: file open, layers, text search, lint findings and entity inspection
// around the DrawingCanvas renderer.

import type { Drawing, Finding, Severity } from "../src/types.ts";
import { DrawingCanvas } from "./canvas.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (n: number, d = 3) => (Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(Math.round(n * 10 ** d) / 10 ** d));
const hexOf = (rgb: number) => "#" + rgb.toString(16).padStart(6, "0");

interface LintPayload {
  findings: Finding[];
  counts: Record<Severity, number>;
  packs: string[];
  availablePacks: string[];
  profile: string | null;
  sheet: any;
  rules: { id: string; pack: string; title: string; why: string }[];
  ruleErrors: { rule: string; error: string }[];
}

const view = new DrawingCanvas($<HTMLCanvasElement>("#canvas"));
let file: string | null = null;
let drawing: Drawing | null = null;
let byHandle = new Map<string, number>();
let lint: LintPayload | null = null;
let packs: string[] | null = null;
const sevOn: Record<Severity, boolean> = { error: true, warning: true, info: false };
let visibleFindings: Finding[] = [];
let activeIdx = -1;
let openRequest = 0;
let lintRequest = 0;
const previousViews: { cx: number; cy: number; scale: number }[] = [];
function rememberView() {
  previousViews.push({ cx: view.cx, cy: view.cy, scale: view.scale });
  if (previousViews.length > 40) previousViews.shift();
  $<HTMLButtonElement>("#view-back").disabled = false;
}
function backView() {
  view.cancelZoom();
  const camera = previousViews.pop();
  if (camera) { Object.assign(view, camera); view.viewRevision++; view.request(); }
  $<HTMLButtonElement>("#view-back").disabled = !previousViews.length;
}

// ------------------------------------------------------------------ tabs

for (const nav of document.querySelectorAll<HTMLElement>(".tabs")) {
  nav.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    showTab(nav, b.dataset.tab!);
  });
}
function showTab(nav: HTMLElement | string, tab: string) {
  const n = typeof nav === "string" ? document.querySelector<HTMLElement>(`.tabs[data-for="${nav}"]`)! : nav;
  const side = n.parentElement!;
  const id = side.id;
  document.body.classList.remove(`${id}-hidden`);
  $(`#toggle-${id}`).setAttribute("aria-expanded", "true");
  n.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.tab === tab));
  side.querySelectorAll<HTMLElement>(".pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === tab));
}

// ------------------------------------------------------------------ status

function overlay(msg: string | null, kind: "" | "error" = "") {
  const o = $("#overlay");
  o.textContent = msg ?? "";
  o.className = "overlay" + (msg ? "" : " hidden") + (kind ? " " + kind : "");
}

view.onView = () => {
  const px = 1 / view.scale;
  $("#zoom").textContent = `1 px = ${fmt(px, 4)} units`;
  $("#perf").textContent = drawing ? `${drawing.entities.length.toLocaleString()} entities · ${view.lastTextCount} labels` : "";
};

// ------------------------------------------------------------------ open

async function open(path: string, opts: { hash?: string } = {}) {
  const request = ++openRequest;
  ++lintRequest;
  packs = null;
  lint = null;
  visibleFindings = [];
  activeIdx = -1;
  previousViews.length = 0;
  $<HTMLButtonElement>("#view-back").disabled = true;
  file = path;
  $<HTMLInputElement>("#path").value = path;
  const url = new URL(location.href);
  url.searchParams.set("file", path);
  url.hash = opts.hash ?? "";
  history.replaceState(null, "", url);
  overlay("Opening… DWG is read by the sidecar on first open, then cached.");
  $("#empty").classList.add("hidden");
  const t0 = performance.now();
  try {
    const res = await fetch(`/api/drawing?file=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
    const serverMs = Number(res.headers.get("x-omakase-cadkit-ms") ?? res.headers.get("x-drawkit-ms") ?? 0);
    const cached = (res.headers.get("x-omakase-cadkit-cached") ?? res.headers.get("x-drawkit-cached")) === "true";
    const loaded = (await res.json()) as Drawing;
    if (request !== openRequest) return;
    drawing = loaded;
    homeBox = null;
    byHandle = new Map(drawing.entities.map((e, i) => [e.h, i]));
    view.setDrawing(drawing);
    initialLayers();
    renderLayers();
    renderMeta();
    overlay(null);
    $("#perf").title = `server ${serverMs} ms (${cached ? "cached" : "converted"}), total ${(performance.now() - t0).toFixed(0)} ms`;
    document.title = `${path.split("/").pop()} — omakase-cadkit`;
    const revision = view.viewRevision;
    await runLint(revision);
    if (request !== openRequest) return;
    applyHash();
    loadRecent();
  } catch (err: any) {
    if (request !== openRequest) return;
    overlay(`Could not open: ${err.message ?? err}`, "error");
    $("#empty").classList.remove("hidden");
  }
}

$("#open-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = $<HTMLInputElement>("#path").value.trim();
  if (p) open(p);
});

function renderMeta() {
  if (!drawing) return;
  const d = drawing;
  const name = d.source.path.split("/").pop();
  $("#meta").innerHTML = `<b>${esc(name!)}</b> · ${d.acadVersion} ${d.source.format.toUpperCase()} · ${d.entities.length.toLocaleString()} entities · header units ${esc(d.header.insUnits)}`;
}

// ------------------------------------------------------------------ layers

function initialLayers() {
  view.hiddenLayers.clear();
  drawing!.layers.forEach((l, i) => {
    if (!l.on || l.frozen) view.hiddenLayers.add(i);
  });
}

function renderLayers() {
  if (!drawing) return;
  const filter = $<HTMLInputElement>("#layer-filter").value.toLowerCase();
  const rows = drawing.layers
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.entities > 0 && l.name.toLowerCase().includes(filter))
    .sort((a, b) => b.l.entities - a.l.entities);
  $("#layers").innerHTML = rows
    .map(
      ({ l, i }) =>
        `<li data-i="${i}" class="${view.hiddenLayers.has(i) ? "off" : ""}" title="${esc(l.name)}${!l.on ? " (off in file)" : ""}${l.frozen ? " (frozen in file)" : ""}. Alt-click to show only this layer.">` +
        `<span class="swatch" style="background:${hexOf(l.color)}"></span><span class="name">${esc(l.name)}</span><span class="count">${l.entities}</span></li>`,
    )
    .join("");
}
$("#layers").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (!li || !drawing) return;
  const i = Number(li.dataset.i);
  if ((e as MouseEvent).altKey) {
    view.hiddenLayers = new Set(drawing.layers.map((_, j) => j).filter((j) => j !== i));
  } else if (view.hiddenLayers.has(i)) view.hiddenLayers.delete(i);
  else view.hiddenLayers.add(i);
  renderLayers();
  view.request();
});
$("#layer-filter").addEventListener("input", renderLayers);
$("#layers-all").addEventListener("click", () => {
  view.hiddenLayers.clear();
  renderLayers();
  view.request();
});
$("#layers-none").addEventListener("click", () => {
  if (!drawing) return;
  view.hiddenLayers = new Set(drawing.layers.map((_, i) => i));
  renderLayers();
  view.request();
});

// ------------------------------------------------------------------ text search

let searchTimer = 0;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 120);
});
function runSearch() {
  if (!drawing) return;
  const q = $<HTMLInputElement>("#search").value.trim();
  const list = $("#search-results");
  if (!q) {
    list.innerHTML = "";
    $("#search-count").textContent = "";
    return;
  }
  let rx: RegExp;
  try {
    rx = new RegExp(q, "i");
  } catch {
    rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const hits: number[] = [];
  drawing.entities.forEach((e, i) => {
    if (e.text && rx.test(e.text)) hits.push(i);
  });
  $("#search-count").textContent = `${hits.length} match${hits.length === 1 ? "" : "es"}${hits.length > 500 ? " (first 500 listed)" : ""}`;
  list.innerHTML = hits
    .slice(0, 500)
    .map((i) => `<li data-i="${i}" title="${esc(drawing!.entities[i].h)}">${esc(drawing!.entities[i].text!.slice(0, 80))}<span class="count">${esc(drawing!.layers[drawing!.entities[i].layer]?.name ?? "")}</span></li>`)
    .join("");
}
$("#search-results").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (!li) return;
  select([Number(li.dataset.i)], true);
});

// ------------------------------------------------------------------ files

async function loadRecent() {
  const r: string[] = await fetch("/api/recent").then((r) => r.json());
  $("#recent").innerHTML = r.map((p) => `<li data-p="${esc(p)}" title="${esc(p)}">${esc(p.split("/").pop()!)}</li>`).join("") || `<li class="hint">none yet</li>`;
}
async function browse(dir?: string) {
  const r = await fetch(`/api/files${dir ? "?dir=" + encodeURIComponent(dir) : ""}`).then((r) => r.json());
  if (r.error) return;
  $("#dir-label").textContent = r.dir;
  $("#dir").innerHTML =
    `<li class="dir" data-d="${esc(r.parent)}">..</li>` +
    r.entries.map((e: any) => (e.dir ? `<li class="dir" data-d="${esc(e.path)}">${esc(e.name)}</li>` : `<li data-p="${esc(e.path)}">${esc(e.name)}<span class="count">${(e.size / 1e6).toFixed(1)} MB</span></li>`)).join("");
}
for (const id of ["#recent", "#dir"])
  $(id).addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("li");
    if (!li) return;
    if (li.dataset.d) browse(li.dataset.d);
    else if (li.dataset.p) open(li.dataset.p);
  });

// ------------------------------------------------------------------ lint

async function runLint(initialRevision?: number) {
  if (!file) return;
  const request = ++lintRequest;
  $("#findings").innerHTML = `<li class="hint">Linting…</li>`;
  const q = packs ? `&packs=${packs.join(",")}` : "";
  const res = await fetch(`/api/lint?file=${encodeURIComponent(file)}${q}`);
  const result = await res.json();
  if (request !== lintRequest) return;
  lint = result;
  if (!res.ok) {
    $("#findings").innerHTML = `<li class="hint">Lint failed: ${esc((lint as any).error)}</li>`;
    return;
  }
  packs = lint!.packs;
  $("#packs").innerHTML = lint!.availablePacks.map((p) => `<label><input type="checkbox" data-pack="${p}" ${packs!.includes(p) ? "checked" : ""}/> ${p}</label>`).join("");
  $("#profile").innerHTML = lint!.profile ? `profile <code>${esc(lint!.profile)}</code>` : `no omakase-cadkit.json found; using defaults`;
  for (const s of ["error", "warning", "info"] as Severity[]) $(`#n-${s}`).textContent = String(lint!.counts[s]);
  $("#finding-badge").textContent = lint!.counts.error ? String(lint!.counts.error) : "";
  renderFindings();
  renderSheet();
  // a sheet frame is a better home view than percentile extents
  const frames = lint!.sheet.frames as { bbox: [number, number, number, number] }[];
  if (frames.length) {
    homeBox = [Math.min(...frames.map((f) => f.bbox[0])), Math.min(...frames.map((f) => f.bbox[1])), Math.max(...frames.map((f) => f.bbox[2])), Math.max(...frames.map((f) => f.bbox[3]))];
    if (initialRevision === view.viewRevision) view.fit(homeBox, 0.01);
  }
}
let homeBox: [number, number, number, number] | null = null;
const home = () => { if (!drawing) return; rememberView(); homeBox ? view.fit(homeBox, 0.01) : view.fit(); };
$("#packs").addEventListener("change", () => {
  packs = [...document.querySelectorAll<HTMLInputElement>("#packs input:checked")].map((i) => i.dataset.pack!);
  runLint();
});
$("#relint").addEventListener("click", () => runLint());
$("#all-markers").addEventListener("change", () => {
  view.showAllFindings = $<HTMLInputElement>("#all-markers").checked;
  view.request();
});
document.querySelectorAll<HTMLInputElement>(".sevs input").forEach((i) =>
  i.addEventListener("change", () => {
    sevOn[i.dataset.sev as Severity] = i.checked;
    renderFindings();
  }),
);

function renderFindings() {
  if (!lint) return;
  visibleFindings = lint.findings.filter((f) => sevOn[f.severity]);
  view.findings = visibleFindings;
  activeIdx = -1;
  view.activeFinding = null;
  const title = new Map(lint.rules.map((r) => [r.id, r]));
  const numbers = new Map(lint.findings.map((f, i) => [f, i + 1]));
  $("#findings").innerHTML =
    visibleFindings
      .map(
        (f, i) =>
          `<li data-i="${i}" title="${esc(title.get(f.rule)?.why ?? "")}"><span class="dot ${f.severity}"></span><span><span class="rule">${esc(f.rule)}</span> <span class="n">#${numbers.get(f)}</span><span class="msg">${esc(f.message)}</span>${
            f.handles.length > 1 ? `<span class="n">${f.handles.length} entities</span>` : ""
          }</span></li>`,
      )
      .join("") + (lint.ruleErrors.length ? lint.ruleErrors.map((e) => `<li class="hint">rule ${esc(e.rule)} crashed: ${esc(e.error.split("\n")[0])}</li>`).join("") : "");
  if (!visibleFindings.length) $("#findings").innerHTML = `<li class="hint">No findings at the selected severities.</li>`;
  view.request();
}
$("#findings").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (!li?.dataset.i) return;
  focusFinding(Number(li.dataset.i));
});

function focusFinding(i: number) {
  if (!drawing || i < 0 || i >= visibleFindings.length) return;
  activeIdx = i;
  const f = visibleFindings[i];
  view.activeFinding = f;
  document.querySelectorAll("#findings li").forEach((li) => li.classList.toggle("on", Number((li as HTMLElement).dataset.i) === i));
  document.querySelector(`#findings li[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  const ents = f.handles.map((h) => byHandle.get(h)).filter((x): x is number => x !== undefined);
  select(ents, false, false);
  showTab("right", "findings");
  if (f.bbox) {
    const b = f.bbox;
    const w = b[2] - b[0], h = b[3] - b[1];
    const sheetSpan = homeBox ? Math.max(homeBox[2] - homeBox[0], homeBox[3] - homeBox[1]) : 0;
    const m = Math.max(Math.max(w, h) * 0.6 + 1, sheetSpan * 0.005);
    rememberView();
    view.fit([b[0] - m, b[1] - m, b[2] + m, b[3] + m], 0);
  }
  const url = new URL(location.href);
  url.hash = `f=${lint!.findings.indexOf(f) + 1}`;
  history.replaceState(null, "", url);
}

function renderSheet() {
  if (!lint) return;
  const s = lint.sheet;
  const u = s.units;
  const rows = (o: [string, string][]) => `<table>${o.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("")}</table>`;
  let html = `<h3>Units</h3>` + rows([["header ($INSUNITS)", esc(u.declared)], ["used", `${esc(u.used)} <span class="hint">(${esc(u.source)})</span>`], ["projected coords", u.looksProjected ? "yes" : "no"]]);
  if (s.extents) html += rows([["extents", s.extents.map((n: number) => fmt(n, 1)).join(", ")]]);
  html += `<div class="sub">Frames</div>`;
  if (!s.frames.length) html += `<p class="hint">No sheet frame with a title block found.</p>`;
  for (const f of s.frames)
    html +=
      rows([
        ["handle", `<a href="#" data-h="${f.handle}">${f.handle}</a>`],
        ["drawing number", esc(f.drawingNumber?.text ?? "—")],
        ["paper", `${f.paper}${f.isoRatio ? "" : " (fitted; frame is not an ISO ratio)"}`],
        ["measured scale", f.measured ? `1:${fmt(f.measured, 0)}` : "—"],
        ["declared scale", f.declared ? (f.declared.ratios.map((r: number) => "1:" + fmt(r, 0)).join(", ") || (f.declared.nts ? "NTS" : "label without ratio")) : "none"],
        ["frame size", `${fmt(f.widthMm / 1000, 2)} × ${fmt(f.heightMm / 1000, 2)} m`],
      ]) + "<br/>";
  $("#sheet").innerHTML = html;
}
$("#sheet").addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a[data-h]") as HTMLElement | null;
  if (!a) return;
  e.preventDefault();
  const i = byHandle.get(a.dataset.h!);
  if (i !== undefined) select([i], true);
});

// ------------------------------------------------------------------ selection + inspect

function select(ents: number[], zoom: boolean, revealInspector = true) {
  view.selected = new Set(ents);
  view.request();
  if (ents.length === 1 && revealInspector) inspect(ents[0]);
  if (zoom && ents.length) {
    const bs = ents.map((i) => drawing!.entities[i].bbox).filter(Boolean) as [number, number, number, number][];
    if (bs.length) {
      const b: [number, number, number, number] = [Math.min(...bs.map((x) => x[0])), Math.min(...bs.map((x) => x[1])), Math.max(...bs.map((x) => x[2])), Math.max(...bs.map((x) => x[3]))];
      // show the neighbourhood: at least 2% of the sheet across, or 6x the selection
      const ext = homeBox ?? drawing!.entities.reduce((acc, e) => e.bbox ? [Math.min(acc[0], e.bbox[0]), Math.min(acc[1], e.bbox[1]), Math.max(acc[2], e.bbox[2]), Math.max(acc[3], e.bbox[3])] as [number, number, number, number] : acc, [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number]);
      const span = Math.max(Math.max(b[2] - b[0], b[3] - b[1]) * 6, Math.max(ext[2] - ext[0], ext[3] - ext[1]) * 0.02);
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      rememberView();
      view.fit([cx - span / 2, cy - span / 2, cx + span / 2, cy + span / 2], 0);
    }
  }
}

function inspect(i: number) {
  if (!drawing) return;
  const e = drawing.entities[i];
  const layer = drawing.layers[e.layer];
  const rows: [string, string][] = [
    ["handle", esc(e.h)],
    ["type", esc(e.type)],
    ["layer", `<span class="swatch" style="display:inline-block;background:${hexOf(layer?.color ?? 0)}"></span> ${esc(layer?.name ?? "?")}`],
    ["colour", hexOf(e.color)],
  ];
  const skip = new Set(["h", "type", "layer", "color", "verts", "pts"]);
  for (const [k, v] of Object.entries(e)) {
    if (skip.has(k) || v === undefined) continue;
    rows.push([k, esc(Array.isArray(v) ? (typeof v[0] === "object" ? JSON.stringify(v) : (v as number[]).map((n) => (typeof n === "number" ? fmt(n) : String(n))).join(", ")) : typeof v === "number" ? fmt(v) : String(v))]);
  }
  if (e.verts) rows.push(["vertices", String(e.verts.length / 2)]);
  if (e.pts) rows.push(["points", e.pts.map((n) => fmt(n)).join(", ")]);
  const related = lint?.findings.filter((f) => f.handles.includes(e.h)) ?? [];
  $("#inspect").innerHTML =
    `<h3>${esc(e.type)} ${esc(e.h)}</h3>` +
    `<div class="actions"><button data-act="copy-h">Copy handle</button><button data-act="copy-link">Copy link</button><button data-act="zoom">Zoom to</button></div>` +
    `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("")}</table>` +
    (related.length ? `<div class="sub">Findings</div><ol class="list findings">${related.map((f) => `<li><span class="dot ${f.severity}"></span><span><span class="rule">${esc(f.rule)}</span><span class="msg">${esc(f.message)}</span></span></li>`).join("")}</ol>` : "");
  ($("#inspect") as any)._ent = i;
  showTab("right", "inspect");
  const url = new URL(location.href);
  url.hash = `h=${e.h}`;
  history.replaceState(null, "", url);
}
$("#inspect").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button");
  const i = ($("#inspect") as any)._ent as number | undefined;
  if (!b || i === undefined || !drawing) return;
  const e = drawing.entities[i];
  if (b.dataset.act === "copy-h") navigator.clipboard.writeText(e.h);
  if (b.dataset.act === "copy-link") navigator.clipboard.writeText(location.href);
  if (b.dataset.act === "zoom") select([i], true);
});

function applyHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const handle = h.get("h");
  const fnum = h.get("f");
  if (handle) {
    const i = byHandle.get(handle.toUpperCase());
    if (i !== undefined) select([i], true);
    else overlay(`No entity with handle ${handle}`, "error");
  } else if (fnum && lint) {
    const f = lint.findings[Number(fnum) - 1];
    if (f) {
      sevOn[f.severity] = true;
      document.querySelector<HTMLInputElement>(`.sevs input[data-sev="${f.severity}"]`)!.checked = true;
      renderFindings();
      focusFinding(visibleFindings.indexOf(f));
    }
  }
}

// ------------------------------------------------------------------ canvas interaction

const cv = view.canvas;
let drag: { x: number; y: number; moved: boolean; pointerId: number; button: number } | null = null;
let cursor: { x: number; y: number } | null = null;
let cursorFrame = 0;
function updateCoordinates() {
  if (cursorFrame) return;
  cursorFrame = requestAnimationFrame(() => {
    cursorFrame = 0;
    if (!drawing || !cursor) return;
    const r = cv.getBoundingClientRect();
    const [x, y] = view.screenToWorld(cursor.x - r.left, cursor.y - r.top);
    $("#coords").textContent = `x ${fmt(x, 3)}   y ${fmt(y, 3)}`;
  });
}
cv.addEventListener("pointerdown", (e) => {
  if (!drawing || (e.button !== 0 && e.button !== 1) || drag) return;
  view.cancelZoom();
  e.preventDefault();
  cv.focus({ preventScroll: true });
  cv.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, moved: false, pointerId: e.pointerId, button: e.button };
});
cv.addEventListener("pointermove", (e) => {
  cursor = { x: e.clientX, y: e.clientY };
  updateCoordinates();
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) {
    rememberView();
    cv.classList.add("panning");
  }
  drag.moved = true;
  view.panBy(dx, dy);
  drag.x = e.clientX;
  drag.y = e.clientY;
});
cv.addEventListener("pointerup", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  cv.classList.remove("panning");
  const wasDrag = drag?.moved;
  const button = drag.button;
  drag = null;
  if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
  if (wasDrag || button !== 0 || !drawing) return;
  const r = cv.getBoundingClientRect();
  const ent = view.pick(e.clientX - r.left, e.clientY - r.top);
  view.activeFinding = null;
  if (ent === null) {
    view.selected.clear();
    view.request();
    return;
  }
  select([ent], false);
});
const cancelDrag = () => { drag = null; cv.classList.remove("panning"); };
cv.addEventListener("pointercancel", cancelDrag);
cv.addEventListener("lostpointercapture", cancelDrag);
cv.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
let wheelUntil = 0;
cv.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (!drawing) return;
    if (performance.now() > wheelUntil) rememberView();
    wheelUntil = performance.now() + 250;
    const r = cv.getBoundingClientRect();
    const pixels = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.height : 1);
    const factor = Math.exp(-Math.max(-400, Math.min(400, pixels)) * 0.002);
    view.smoothZoomAt(e.clientX - r.left, e.clientY - r.top, factor);
  },
  { passive: false },
);
cv.addEventListener("dblclick", () => home());
$("#fit").addEventListener("click", home);
$("#view-back").addEventListener("click", backView);
for (const [id, factor] of [["#zoom-in", 1.5], ["#zoom-out", 1 / 1.5]] as const)
  $(id).addEventListener("click", () => {
    if (!drawing) return;
    rememberView();
    view.zoomAt(view.width / 2, view.height / 2, factor);
  });
for (const side of ["left", "right"] as const) {
  const button = $(`#toggle-${side}`);
  button.addEventListener("click", () => {
    const hidden = document.body.classList.toggle(`${side}-hidden`);
    button.setAttribute("aria-expanded", String(!hidden));
  });
}
if (innerWidth <= 820) {
  document.body.classList.add("left-hidden", "right-hidden");
  $("#toggle-left").setAttribute("aria-expanded", "false");
  $("#toggle-right").setAttribute("aria-expanded", "false");
}

window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
  if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); backView(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "f" || e.key === "F") home();
  else if (e.key === "Escape") {
    view.selected.clear();
    view.activeFinding = null;
    view.request();
  } else if (e.key === "j" || e.key === "n") focusFinding(Math.min(visibleFindings.length - 1, activeIdx + 1));
  else if (e.key === "k" || e.key === "p") focusFinding(Math.max(0, activeIdx - 1));
  else if (e.key === "/") {
    e.preventDefault();
    document.body.classList.remove("left-hidden");
    $("#toggle-left").setAttribute("aria-expanded", "true");
    showTab("left", "search");
    $<HTMLInputElement>("#search").focus();
  }
});

// ------------------------------------------------------------------ boot

// automation handle: agents and tests can drive the view without synthesising pointer events
(window as any).cadkit = {
  view,
  open,
  select: (handles: string[]) => select(handles.map((h) => byHandle.get(h.toUpperCase())).filter((x): x is number => x !== undefined), true),
  focusFinding: (n: number) => {
    const f = lint?.findings[n - 1];
    if (!f) return false;
    sevOn[f.severity] = true;
    renderFindings();
    focusFinding(visibleFindings.indexOf(f));
    return true;
  },
  state: () => ({ file, ready: Boolean(lint?.findings), entities: drawing?.entities.length ?? 0, findings: lint?.findings.length ?? 0, drawMs: view.lastDrawMs, labels: view.lastTextCount }),
};

// Compatibility for existing browser automation.
(window as any).drawkit = (window as any).cadkit;

const initial = new URL(location.href).searchParams.get("file");
loadRecent();
browse();
if (initial) open(initial, { hash: location.hash.slice(1) });
