// omakase-cadkit viewer: file open, layers, text search, lint findings and entity inspection
// around the DrawingCanvas renderer.

import type { Drawing, Finding, Severity } from "../src/types.ts";
import { DARK, DrawingCanvas, LIGHT, type RasterOverlay, type Theme } from "./canvas.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (n: number, d = 3) => (Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(Math.round(n * 10 ** d) / 10 ** d));
const hexOf = (rgb: number) => "#" + rgb.toString(16).padStart(6, "0");
const parentDir = (p: string) => p.slice(0, Math.max(1, p.lastIndexOf("/")));

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

// ------------------------------------------------------------------ theme, help

const THEME_KEY = "omakase-cadkit-theme";
function applyTheme(name: "dark" | "light") {
  document.documentElement.dataset.theme = name;
  view.theme = (name === "light" ? LIGHT : DARK) as Theme;
  $("#theme-toggle").setAttribute("aria-pressed", String(name === "light"));
  $("#theme-toggle").title = name === "light" ? "Switch to the graphite theme" : "Switch to the paper theme";
  view.request();
}
const savedTheme = localStorage.getItem(THEME_KEY);
applyTheme(savedTheme === "light" ? "light" : "dark");
$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

const help = $<HTMLDialogElement>("#help-dialog");
$("#help-button").addEventListener("click", () => help.showModal());
$("#help-close").addEventListener("click", () => help.close());
help.addEventListener("click", (e) => { if (e.target === help) help.close(); });

// ------------------------------------------------------------------ tooltips

// Titles show as themed tips: quicker than the browser's, with any shortcut as a key cap. On
// first hover a title moves to data-tip so the native tooltip does not show as well; code may
// set .title again later and the next hover picks it up. The tip is a popover so it also shows
// above modal dialogs.
const tip = document.createElement("div");
tip.id = "tip";
tip.popover = "manual";
tip.setAttribute("role", "tooltip");
document.body.append(tip);
let tipFor: HTMLElement | null = null;
let tipPending: HTMLElement | null = null;
let tipTimer = 0;
let tipWarmUntil = 0; // moving between controls right after a tip shows the next one at once
let keyboardNav = false;
function tipTarget(el: EventTarget | null): HTMLElement | null {
  const t = el instanceof Element ? el.closest<HTMLElement>("[title], [data-tip]") : null;
  if (!t) return null;
  if (t.hasAttribute("title")) {
    const text = t.title;
    t.removeAttribute("title");
    t.dataset.tip = text;
    // keep what the title gave assistive technology
    if (!t.hasAttribute("aria-label") && !t.textContent!.trim()) t.setAttribute("aria-label", text);
    else if (t.getAttribute("aria-label") !== text) t.setAttribute("aria-description", text);
  }
  return t.dataset.tip ? t : null;
}
function showTip(t: HTMLElement) {
  if (!t.isConnected) return;
  tipFor = t;
  const text = t.dataset.tip!;
  const key = text.match(/^([\s\S]*?) \(((?:Alt|Shift|Ctrl) \+ [^()]+|[A-Z/?]|Esc)\)$/);
  tip.innerHTML = key ? `${esc(key[1])}<kbd>${esc(key[2])}</kbd>` : esc(text);
  tip.showPopover();
  const r = t.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight, gap = 8;
  const side = t.closest<HTMLElement>("[data-tip-side]")?.dataset.tipSide;
  let x: number, y: number;
  if (side === "left" || side === "right") {
    x = side === "left" ? r.left - w - gap : r.right + gap;
    y = r.top + r.height / 2 - h / 2;
  } else {
    x = r.left + r.width / 2 - w / 2;
    // below, except for controls low on the screen (corner tools, status bar)
    y = r.top > innerHeight * 0.6 || r.bottom + gap + h > innerHeight - 4 ? r.top - gap - h : r.bottom + gap;
  }
  tip.style.left = `${Math.round(Math.max(4, Math.min(innerWidth - w - 4, x)))}px`;
  tip.style.top = `${Math.round(Math.max(4, Math.min(innerHeight - h - 4, y)))}px`;
}
function hideTip() {
  clearTimeout(tipTimer);
  tipPending = null;
  if (!tipFor) return;
  tipFor = null;
  tipWarmUntil = performance.now() + 400;
  tip.hidePopover();
}
document.addEventListener("pointerover", (e) => {
  if (e.pointerType === "touch" || document.body.classList.contains("resizing")) return;
  const t = tipTarget(e.target);
  if (t && (t === tipFor || t === tipPending)) return;
  hideTip();
  if (!t) return;
  tipPending = t;
  tipTimer = window.setTimeout(() => showTip(t), performance.now() < tipWarmUntil ? 0 : 450);
});
document.addEventListener("pointerout", (e) => { if (!e.relatedTarget) hideTip(); });
document.addEventListener("pointerdown", () => { keyboardNav = false; hideTip(); }, true);
document.addEventListener("keydown", () => { keyboardNav = true; hideTip(); }, true);
document.addEventListener("wheel", hideTip, { capture: true, passive: true });
document.addEventListener("scroll", hideTip, true);
document.addEventListener("focusin", (e) => {
  const t = keyboardNav ? tipTarget(e.target) : null;
  if (t) showTip(t);
});
document.addEventListener("focusout", hideTip);

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
const properties = $<HTMLDialogElement>("#properties-dialog");
const propertiesApply = $<HTMLButtonElement>("#properties-apply");
let propertiesFile: string | null = null;
let automaticUnit = "";
let savingProperties = false;
const unitMm: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
function previewUnits() {
  const selected = $<HTMLInputElement>('input[name="units"]:checked')?.value;
  $("#unit-preview").textContent = selected === "auto"
    ? `Auto · ${automaticUnit}` : `1 ${selected} = ${fmt(unitMm[selected])} mm`;
  $("#properties-message").textContent = "";
}
async function openProperties() {
  if (!file || !drawing) return;
  propertiesFile = file;
  const requested = file;
  properties.showModal();
  propertiesApply.disabled = true;
  $<HTMLFieldSetElement>(".unit-field").disabled = true;
  $("#properties-form").setAttribute("aria-busy", "true");
  $("#properties-message").textContent = "Loading…";
  $("#properties-message").classList.remove("error");
  try {
    const res = await fetch(`/api/properties?file=${encodeURIComponent(requested)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (file !== requested || !properties.open) return;
    automaticUnit = data.automaticUnits.used;
    const aliases: Record<string, string> = { millimeters: "mm", centimeters: "cm", meters: "m", inches: "in", feet: "ft" };
    const override = data.override?.toLowerCase();
    const selected = aliases[override] ?? override ?? "auto";
    const input = [...document.querySelectorAll<HTMLInputElement>('input[name="units"]')].find((i) => i.value === selected);
    // Preserve an existing override outside the compact selector (e.g. km) until a choice is made.
    document.querySelectorAll<HTMLInputElement>('input[name="units"]').forEach((i) => i.checked = i === input);
    $("#properties-header").textContent = data.units.declared;
    $("#properties-folder").textContent = data.folder;
    if (input) previewUnits();
    else $("#unit-preview").textContent = `Current · ${data.units.used}`;
    propertiesApply.disabled = !input;
    $<HTMLFieldSetElement>(".unit-field").disabled = false;
    $("#properties-message").textContent = "";
  } catch (err: any) {
    $("#properties-message").textContent = err.message ?? String(err);
    $("#properties-message").classList.add("error");
  } finally { $("#properties-form").removeAttribute("aria-busy"); }
}
$("#properties-button").addEventListener("click", () => void openProperties());
$("#meta").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest(".meta-units")) void openProperties();
});
$("#properties-close").addEventListener("click", () => { if (!savingProperties) properties.close(); });
properties.addEventListener("cancel", (e) => { if (savingProperties) e.preventDefault(); });
$("#properties-form").addEventListener("change", () => { previewUnits(); propertiesApply.disabled = false; });
$("#properties-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!propertiesFile || propertiesApply.disabled || savingProperties) return;
  const target = propertiesFile;
  const selected = $<HTMLInputElement>('input[name="units"]:checked').value;
  savingProperties = true;
  $<HTMLFieldSetElement>(".unit-field").disabled = true;
  propertiesApply.disabled = true;
  $("#properties-message").classList.remove("error");
  $("#properties-message").textContent = "Saving…";
  try {
    const res = await fetch(`/api/properties?file=${encodeURIComponent(target)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ units: selected === "auto" ? null : selected }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (file === target) await runLint();
    $("#properties-message").textContent = "Saved";
    properties.close();
  } catch (err: any) {
    $("#properties-message").textContent = err.message ?? String(err);
    $("#properties-message").classList.add("error");
  } finally {
    savingProperties = false;
    propertiesApply.disabled = false;
    $<HTMLFieldSetElement>(".unit-field").disabled = false;
  }
});
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

// ------------------------------------------------------------------ per-file view settings

// Layer visibility and the background image are remembered per drawing. A saved entry is
// dropped once the file changes on disk (size or mtime), so a revision opens with defaults.
const VIEWS_KEY = "omakase-cadkit-views";
const VIEWS_LIMIT = 50;
interface SavedView {
  version: string;
  hidden: string[]; // layer names
  background: boolean;
}
let fileVersion = "";
function savedViews(): Record<string, SavedView> {
  try {
    return JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function saveViewSettings() {
  if (!drawing || !fileVersion) return;
  const all = savedViews();
  const key = drawing.source.path;
  delete all[key]; // re-insert last, so the oldest entries are dropped first
  all[key] = { version: fileVersion, hidden: [...view.hiddenLayers].map((i) => drawing!.layers[i].name), background: view.showImages };
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - VIEWS_LIMIT))) delete all[k];
  localStorage.setItem(VIEWS_KEY, JSON.stringify(all));
}
/** Applies saved settings for the open drawing, or the file's own defaults. */
function restoreViewSettings() {
  const d = drawing!;
  const all = savedViews();
  let saved: SavedView | undefined = all[d.source.path];
  if (saved && saved.version !== fileVersion) {
    delete all[d.source.path];
    localStorage.setItem(VIEWS_KEY, JSON.stringify(all));
    saved = undefined;
  }
  initialLayers();
  if (saved) {
    const hidden = new Set(saved.hidden);
    view.hiddenLayers = new Set(d.layers.map((l, i) => (hidden.has(l.name) ? i : -1)).filter((i) => i >= 0));
  }
  setBackgroundImage(saved?.background ?? true, false);
}

// ------------------------------------------------------------------ resizable panels

// Drag a panel edge or the Browse/Recent divider; double-click resets. Sizes are a layout
// preference, so they apply to every drawing.
const LAYOUT_KEY = "omakase-cadkit-layout";
interface Resizer {
  prop: string;
  axis: "x" | "y";
  sign: 1 | -1; // +1 when moving right/down grows the panel
  min: number;
  max: () => number;
  el: () => HTMLElement;
}
const resizers: Record<string, Resizer> = {
  left: { prop: "--left-size", axis: "x", sign: 1, min: 200, max: () => innerWidth * 0.45, el: () => $("#left") },
  right: { prop: "--right-size", axis: "x", sign: -1, min: 260, max: () => innerWidth * 0.5, el: () => $("#right") },
  recent: { prop: "--recent-size", axis: "y", sign: -1, min: 40, max: () => $('[data-pane="files"]').getBoundingClientRect().height - 160, el: () => $("#recent") },
};
const layoutSizes: Record<string, number> = (() => {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
  } catch {
    return {};
  }
})();
for (const [name, px] of Object.entries(layoutSizes)) if (resizers[name]) document.body.style.setProperty(resizers[name].prop, `${px}px`);
function setPanelSize(name: string, px: number | null) {
  const r = resizers[name];
  if (px === null) {
    document.body.style.removeProperty(r.prop);
    delete layoutSizes[name];
  } else {
    layoutSizes[name] = Math.round(Math.max(r.min, Math.min(r.max(), px)));
    document.body.style.setProperty(r.prop, `${layoutSizes[name]}px`);
  }
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutSizes));
}
const panelSize = (r: Resizer) => (r.axis === "x" ? r.el().getBoundingClientRect().width : r.el().getBoundingClientRect().height);
for (const handle of document.querySelectorAll<HTMLElement>(".resizer")) {
  const name = handle.dataset.resize!;
  const r = resizers[name];
  let start: { at: number; size: number; pointerId: number } | null = null;
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    start = { at: r.axis === "x" ? e.clientX : e.clientY, size: panelSize(r), pointerId: e.pointerId };
    handle.classList.add("dragging");
    document.body.classList.add("resizing", r.axis === "x" ? "col-resize" : "row-resize");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.pointerId) return;
    setPanelSize(name, start.size + r.sign * ((r.axis === "x" ? e.clientX : e.clientY) - start.at));
  });
  const end = () => {
    start = null;
    handle.classList.remove("dragging");
    document.body.classList.remove("resizing", "col-resize", "row-resize");
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("lostpointercapture", end);
  handle.addEventListener("dblclick", () => setPanelSize(name, null));
  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 64 : 16;
    const keys: Record<string, number> = r.axis === "x" ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
    const dir = keys[e.key];
    if (!dir) return;
    e.preventDefault();
    setPanelSize(name, panelSize(r) + r.sign * dir * step);
  });
}

// ------------------------------------------------------------------ tabs

type Side = "left" | "right";
for (const nav of document.querySelectorAll<HTMLElement>(".tabs")) {
  nav.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b?.dataset.collapse) setPanel(b.dataset.collapse as Side, false);
    else if (b?.dataset.tab) showTab(nav.dataset.for as Side, b.dataset.tab);
  });
}
function showTab(side: Side, tab: string) {
  setPanel(side, true);
  for (const b of document.querySelectorAll<HTMLElement>(`.tabs[data-for="${side}"] button, #ribbon-${side} button`))
    b.classList.toggle("on", b.dataset.tab === tab);
  $(`#${side}`).querySelectorAll<HTMLElement>(".pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === tab));
}
// A closed panel leaves a ribbon of its tabs on the window edge; the open panel keeps its
// width and tab, and its collapse button stands where the ribbon was.
function setPanel(side: Side, open: boolean) {
  document.body.classList.toggle(`${side}-hidden`, !open);
}

// ------------------------------------------------------------------ edge ribbons

// Drag a ribbon along its edge; a press that does not move opens the tab under it. The
// position is a 0-1 fraction of the stage height so it survives window resizes.
for (const ribbon of document.querySelectorAll<HTMLElement>(".ribbon")) {
  const side = ribbon.dataset.side as Side;
  const key = `ribbon-${side}`;
  const place = (pos: number) => ribbon.style.setProperty("--pos", String(pos));
  place(layoutSizes[key] ?? 0.3);
  let start: { y: number; pos: number; range: number; pointerId: number; moved: boolean } | null = null;
  let dragged = false;
  ribbon.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragged = false;
    const range = $("#stage").clientHeight - 28 - ribbon.offsetHeight;
    start = { y: e.clientY, pos: Number(ribbon.style.getPropertyValue("--pos")), range, pointerId: e.pointerId, moved: false };
  });
  ribbon.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.pointerId) return;
    const dy = e.clientY - start.y;
    if (!start.moved && Math.abs(dy) < 4) return;
    if (!start.moved) {
      start.moved = true;
      ribbon.setPointerCapture(e.pointerId);
      ribbon.classList.add("dragging");
      document.body.classList.add("resizing", "row-resize");
    }
    layoutSizes[key] = start.range > 0 ? Math.max(0, Math.min(1, start.pos + dy / start.range)) : 0;
    place(layoutSizes[key]);
  });
  const end = () => {
    if (start?.moved) {
      dragged = true; // the click that ends a drag does not open a tab
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutSizes));
    }
    start = null;
    ribbon.classList.remove("dragging");
    document.body.classList.remove("resizing", "row-resize");
  };
  ribbon.addEventListener("pointerup", end);
  ribbon.addEventListener("pointercancel", end);
  ribbon.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b?.dataset.tab && !dragged) showTab(side, b.dataset.tab);
    dragged = false;
  });
}

// ------------------------------------------------------------------ status

function overlay(msg: string | null, kind: "" | "error" = "") {
  const o = $("#overlay");
  o.textContent = msg ?? "";
  o.className = "overlay" + (msg ? "" : " hidden") + (kind ? " " + kind : "");
}

view.onView = () => {
  const px = 1 / view.scale;
  $("#zoom").textContent = `${fmt(px, 4)} units`;
  $("#perf").textContent = drawing ? `${drawing.entities.length.toLocaleString()} entities · ${view.lastTextCount} labels` : "";
};

// ------------------------------------------------------------------ open

async function open(path: string, opts: { hash?: string } = {}) {
  properties.close();
  $<HTMLButtonElement>("#properties-button").disabled = true;
  const request = ++openRequest;
  ++lintRequest;
  packs = null;
  lint = null;
  visibleFindings = [];
  activeIdx = -1;
  previousViews.length = 0;
  $<HTMLButtonElement>("#view-back").disabled = true;
  file = path;
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
    const version = res.headers.get("x-omakase-cadkit-file-version") ?? "";
    const loaded = (await res.json()) as Drawing;
    if (request !== openRequest) return;
    drawing = loaded;
    $<HTMLButtonElement>("#properties-button").disabled = false;
    fileVersion = version;
    homeBox = null;
    byHandle = new Map(drawing.entities.map((e, i) => [e.h, i]));
    view.setDrawing(drawing);
    $("#background-tools").hidden = true;
    void loadImages(request, drawing, path);
    restoreViewSettings();
    renderLayers();
    renderMeta();
    overlay(null);
    $("#perf").title = `Entities in the drawing and labels drawn at this zoom\nOpened in ${(performance.now() - t0).toFixed(0)} ms (server ${serverMs} ms, ${cached ? "cached" : "converted"})`;
    document.title = `${path.split("/").pop()} — omakase-cadkit`;
    const revision = view.viewRevision;
    await runLint(revision);
    if (request !== openRequest) return;
    applyHash();
    loadRecent();
    void browse(parentDir(drawing.source.path));
  } catch (err: any) {
    if (request !== openRequest) return;
    overlay(`Could not open: ${err.message ?? err}`, "error");
    $("#empty").classList.remove("hidden");
  }
}

async function loadImages(request: number, drawing: Drawing, path: string) {
  // One fetch per image entity: a block's image placed by many inserts shares the bitmap.
  const rasters = drawing.rasters ?? [];
  if (!rasters.length) return;
  const bitmaps = new Map<string, Promise<ImageBitmap | null>>();
  for (const r of rasters) {
    if (bitmaps.has(r.h)) continue;
    bitmaps.set(
      r.h,
      fetch(`/api/raster?file=${encodeURIComponent(path)}&handle=${encodeURIComponent(r.h)}`)
        .then(async (res) => (res.ok ? createImageBitmap(await res.blob()) : null))
        .catch(() => null),
    );
  }
  const loaded = await Promise.all(rasters.map(async (r) => {
    const bitmap = await bitmaps.get(r.h)!;
    return bitmap ? ({ ...r, bitmap } as RasterOverlay) : null;
  }));
  if (request !== openRequest) return;
  const images = loaded.filter((x): x is RasterOverlay => x !== null);
  view.setImages(images);
  $("#background-tools").hidden = !images.length;
  renderLayers();
}

function setBackgroundImage(on: boolean, save = true) {
  view.showImages = on;
  const button = $("#background-image");
  button.setAttribute("aria-pressed", String(on));
  button.title = `${on ? "Hide" : "Show"} background image (B)`;
  renderLayers();
  if (save) saveViewSettings();
}
$("#background-image").addEventListener("click", () => setBackgroundImage(!view.showImages));

$("#open-button").addEventListener("click", () => {
  showTab("left", "files");
  void browse(drawing ? parentDir(drawing.source.path) : undefined);
});
$("#path-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = $<HTMLInputElement>("#path").value.trim();
  if (!p) return;
  if (/\.(dwg|dxf)$/i.test(p)) open(p);
  else void browse(p);
});

function renderMeta() {
  if (!drawing) return;
  const d = drawing;
  const title = $("#doc-name");
  title.textContent = d.source.path.split("/").pop()!.replace(/\.(dwg|dxf)$/i, "");
  title.title = d.source.path;
  title.classList.remove("empty");
  const errors = lint?.counts.error ?? 0;
  const warnings = lint?.counts.warning ?? 0;
  const issue = errors || warnings
    ? `<span class="chip alert" title="Errors and warnings in this drawing"><strong>${errors}</strong> err <strong>${warnings}</strong> warn</span>`
    : `<span class="chip" title="No errors or warnings"><strong>clean</strong></span>`;
  $("#meta").innerHTML =
    `<span class="chip" title="AutoCAD file version and format">${esc(d.acadVersion)} ${esc(d.source.format.toUpperCase())}</span>` +
    `<button class="chip meta-units" title="Units used to read sizes (file header: ${esc(d.header.insUnits)}). Click to change them." aria-label="Edit drawing units">units ${esc(lint?.sheet?.units.used ?? d.header.insUnits)}</button>` +
    issue;
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
  // Images are not a layer, but reviewers look for them here; pin a row above the layers.
  const images = view.images.length;
  const background = images && !filter
    ? `<li data-background class="layer background ${view.showImages ? "" : "off"}" title="Aerial photos and scans drawn behind the linework. Hides independently of layers (B).">` +
      `<svg class="layer-icon" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-image" /></svg><span class="name">Background image</span><span class="count">${images}</span></li>`
    : "";
  $("#layers").innerHTML = background + rows
    .map(
      ({ l, i }) =>
        `<li data-i="${i}" class="layer ${view.hiddenLayers.has(i) ? "off" : ""}" title="${esc(l.name)}${!l.on ? " (off in file)" : ""}${l.frozen ? " (frozen in file)" : ""}\nClick to show or hide; Alt-click to show only this layer">` +
        `<span class="swatch" style="background:${hexOf(l.color)}"></span><span class="name">${esc(l.name)}</span><span class="count">${l.entities}</span></li>`,
    )
    .join("");
  const shown = rows.filter(({ i }) => !view.hiddenLayers.has(i));
  const total = shown.reduce((n, { l }) => n + l.entities, 0);
  $("#layer-summary").textContent = `${shown.length}/${rows.length} shown · ${total.toLocaleString()} entities`;
}
$("#layers").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest("li");
  if (!li || !drawing) return;
  if ("background" in li.dataset) return setBackgroundImage(!view.showImages);
  const i = Number(li.dataset.i);
  if ((e as MouseEvent).altKey) {
    // Alt-click the isolated layer again to show every layer.
    const isolated = !view.hiddenLayers.has(i) && view.hiddenLayers.size === drawing.layers.length - 1;
    view.hiddenLayers = isolated ? new Set() : new Set(drawing.layers.map((_, j) => j).filter((j) => j !== i));
  } else if (view.hiddenLayers.has(i)) view.hiddenLayers.delete(i);
  else view.hiddenLayers.add(i);
  renderLayers();
  saveViewSettings();
  view.request();
});
$("#layer-filter").addEventListener("input", renderLayers);
$("#layers-all").addEventListener("click", () => {
  view.hiddenLayers.clear();
  renderLayers();
  saveViewSettings();
  view.request();
});
$("#layers-none").addEventListener("click", () => {
  if (!drawing) return;
  view.hiddenLayers = new Set(drawing.layers.map((_, i) => i));
  renderLayers();
  saveViewSettings();
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
    .map((i) => `<li data-i="${i}" title="Zoom to this text (handle ${esc(drawing!.entities[i].h)})"><span class="search-text">${esc(drawing!.entities[i].text!.slice(0, 80))}</span><span class="tag">${esc(drawing!.layers[drawing!.entities[i].layer]?.name ?? "")}</span></li>`)
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
  $("#recent").innerHTML = r.map((p) => `<li data-p="${esc(p)}" title="Open ${esc(p)}"><span class="name">${esc(p.split("/").pop()!)}</span></li>`).join("") || `<li class="hint">No drawings opened yet.</li>`;
}
async function browse(dir?: string) {
  const r = await fetch(`/api/files${dir ? "?dir=" + encodeURIComponent(dir) : ""}`).then((r) => r.json());
  if (r.error) {
    $("#dir").innerHTML = `<li class="hint">${esc(r.error)}</li>`;
    return;
  }
  const field = $<HTMLInputElement>("#path");
  field.value = r.dir;
  field.title = r.dir;
  field.scrollLeft = field.scrollWidth; // keep the folder name, not the root, in view
  $("#dir").innerHTML =
    `<li class="dir" data-d="${esc(r.parent)}" title="Up to ${esc(r.parent)}"><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron-left" /></svg><span class="name">..</span></li>` +
    r.entries.map((e: any) => (e.dir ? `<li class="dir" data-d="${esc(e.path)}" title="Open folder ${esc(e.path)}"><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-folder" /></svg><span class="name">${esc(e.name)}</span></li>` : `<li data-p="${esc(e.path)}" title="Open ${esc(e.path)}"><span class="name">${esc(e.name)}</span><span class="size">${(e.size / 1e6).toFixed(1)} MB</span></li>`)).join("");
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
  const packRules = (p: string) => lint!.rules.filter((r) => r.pack === p).map((r) => r.id).join(", ");
  $("#packs").innerHTML = lint!.availablePacks.map((p) => `<label title="Rule pack ${p}; tick to include its rules in lint: ${esc(packRules(p))}"><input type="checkbox" data-pack="${p}" ${packs!.includes(p) ? "checked" : ""}/> ${p}</label>`).join("");
  $("#profile").innerHTML = lint!.profile ? `profile <code>${esc(lint!.profile)}</code>` : `no profile · built-in defaults`;
  $("#profile").title = lint!.profile
    ? `Project settings (units, engineering limits) read from ${lint!.profile}`
    : "No omakase-cadkit.json found for this drawing, so checks use built-in defaults";
  for (const s of ["error", "warning", "info"] as Severity[]) $(`#n-${s}`).textContent = String(lint!.counts[s]);
  const measured = lint!.sheet.frames.find((f: any) => f.measured)?.measured;
  $("#sheet-scale").textContent = measured ? `1:${fmt(measured, 0)}` : "—";
  $("#finding-badge").textContent = $("#ribbon-badge").textContent = lint!.counts.error ? String(lint!.counts.error) : "";
  renderMeta();
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

function updateFindingNav() {
  const nav = $("#finding-nav");
  nav.classList.toggle("hidden", visibleFindings.length === 0);
  $("#fnav-count").textContent = `${activeIdx >= 0 ? activeIdx + 1 : "–"} / ${visibleFindings.length}`;
  $<HTMLButtonElement>("#fnav-prev").disabled = activeIdx <= 0;
  $<HTMLButtonElement>("#fnav-next").disabled = activeIdx >= visibleFindings.length - 1;
}

const SEV_NAME: Record<Severity, string> = { error: "Error", warning: "Warning", info: "Info" };
const sevDot = (sev: Severity) => `<span class="dot ${sev}" role="img" title="${SEV_NAME[sev]}" aria-label="${SEV_NAME[sev]}"></span>`;

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
      .map((f, i) => {
        const n = String(numbers.get(f) ?? i + 1).padStart(2, "0");
        const count = f.handles.length;
        const ents = `${count.toLocaleString()} ${count === 1 ? "entity" : "entities"}`;
        const copyButtons = count
          ? `<span class="fix-copy">` +
            `<button class="icon-btn" data-act="copy-sel" title="Copy AutoCAD selection: paste at the AutoCAD command line to select ${count > SELECTION_LIMIT ? `the first ${SELECTION_LIMIT.toLocaleString()} of ` : ""}these ${ents} (needs AutoLISP: full AutoCAD, or LT 2024 and later)" aria-label="Copy AutoCAD selection"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-select" /></svg></button>` +
            `<button class="icon-btn" data-act="copy-hs" title="Copy handles: the IDs of these ${ents}, space-separated" aria-label="Copy handles"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-copy" /></svg></button>` +
            `</span>`
          : "";
        const fix = f.fix?.length
          ? `<div class="finding-fix"><div class="fix-head"><span class="sub">How to fix</span>${copyButtons}</div><ol>${f.fix
              .map((s) => `<li>${s.command ? `<code class="cmd" title="AutoCAD command: type it at the command line">${esc(s.command)}</code>` : ""}<span>${esc(s.text)}</span></li>`)
              .join("")}</ol></div>`
          : "";
        return (
          `<li data-i="${i}" class="finding sev-${f.severity}">` +
          `<span class="finding-num">${n}</span>` +
          `<div class="finding-main"><div class="finding-top">` +
          `${sevDot(f.severity)}<span class="rule" title="${esc(title.get(f.rule)?.why ?? "")}">${esc(f.rule)}</span>` +
          (f.handles.length > 1 ? `<span class="finding-meta">${f.handles.length.toLocaleString()} entities</span>` : "") +
          `</div>` +
          (f.title ? `<p class="finding-title">${esc(f.title)}</p>` : "") +
          `<p class="finding-msg">${esc(f.message)}</p>${fix}</div></li>`
        );
      })
      .join("") +
    (lint.ruleErrors.length ? lint.ruleErrors.map((e) => `<li class="hint">rule ${esc(e.rule)} crashed: ${esc(e.error.split("\n")[0])}</li>`).join("") : "");
  if (!visibleFindings.length) $("#findings").innerHTML = `<li class="hint">No findings at the selected severities.</li>`;
  updateFindingNav();
  view.request();
}
/** AutoLISP that makes these handles the current selection, for pasting at the AutoCAD command line. */
const SELECTION_LIMIT = 2000;
function autocadSelection(handles: string[]): string {
  const hs = handles.slice(0, SELECTION_LIMIT).map((h) => `"${h}"`).join(" ");
  return `(progn (setq ck:ss (ssadd)) (foreach h '(${hs}) (if (handent h) (ssadd (handent h) ck:ss))) (sssetfirst nil ck:ss) (princ))`;
}
/** Copies text and keeps a popup showing exactly what is on the clipboard until it is closed. */
function copyText(what: string, text: string, note = "") {
  const show = (ok: boolean) => {
    $("#clipboard-title").textContent = ok ? `Copied ${what}` : `Could not copy ${what}`;
    $("#clipboard-note").textContent = ok ? note : "select the text below and copy it";
    $("#clipboard-text").textContent = text;
    $("#clipboard-pop").classList.toggle("failed", !ok);
    $("#clipboard-pop").classList.remove("hidden");
  };
  (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(() => show(true), () => show(false));
}
$("#clipboard-close").addEventListener("click", () => $("#clipboard-pop").classList.add("hidden"));
$("#findings").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (b) {
    const li = b.closest("li.finding") as HTMLElement | null;
    const f = li?.dataset.i ? visibleFindings[Number(li.dataset.i)] : undefined;
    if (!f) return;
    const n = f.handles.length;
    if (b.dataset.act === "copy-sel")
      copyText("AutoCAD selection", autocadSelection(f.handles), n > SELECTION_LIMIT ? `first ${SELECTION_LIMIT.toLocaleString()} of ${n.toLocaleString()} entities · paste at the command line` : `${n.toLocaleString()} ${n === 1 ? "entity" : "entities"} · paste at the command line`);
    if (b.dataset.act === "copy-hs") copyText("handles", f.handles.join(" "), `${n.toLocaleString()} ${n === 1 ? "handle" : "handles"}`);
    return;
  }
  const li = (e.target as HTMLElement).closest("li.finding") as HTMLElement | null;
  if (!li?.dataset.i) return;
  focusFinding(Number(li.dataset.i), { zoom: !(e as MouseEvent).shiftKey });
});

function focusFinding(i: number, opts: { zoom?: boolean } = {}) {
  if (!drawing || i < 0 || i >= visibleFindings.length) return;
  activeIdx = i;
  const f = visibleFindings[i];
  view.activeFinding = f;
  document.querySelectorAll("#findings li").forEach((li) => li.classList.toggle("on", Number((li as HTMLElement).dataset.i) === i));
  document.querySelector(`#findings li[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  const ents = f.handles.map((h) => byHandle.get(h)).filter((x): x is number => x !== undefined);
  select(ents, false, false);
  showTab("right", "findings");
  if (f.bbox && opts.zoom !== false) {
    const b = f.bbox;
    const w = b[2] - b[0], h = b[3] - b[1];
    const sheetSpan = homeBox ? Math.max(homeBox[2] - homeBox[0], homeBox[3] - homeBox[1]) : 0;
    const m = Math.max(Math.max(w, h) * 0.6 + 1, sheetSpan * 0.005);
    rememberView();
    view.fit([b[0] - m, b[1] - m, b[2] + m, b[3] + m], 0);
  }
  updateFindingNav();
  const url = new URL(location.href);
  url.hash = `f=${lint!.findings.indexOf(f) + 1}`;
  history.replaceState(null, "", url);
}

$("#fnav-prev").addEventListener("click", () => focusFinding(Math.max(0, activeIdx - 1)));
$("#fnav-next").addEventListener("click", () => focusFinding(activeIdx + 1));

function renderSheet() {
  if (!lint) return;
  const s = lint.sheet;
  const u = s.units;
  const row = ([k, v]: string[]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`;
  const group = (title: string, body: string) => `<div class="spec-group"><h4>${esc(title)}</h4><table>${body}</table></div>`;
  let html = group(
    "Drawing units",
    [
      ["header ($INSUNITS)", esc(u.declared)],
      ["used", `${esc(u.used)} <span class="micro-value">(${esc(u.source)})</span>`],
      ["projected coords", u.looksProjected ? "yes" : "no"],
      ...(s.extents ? [["extents", s.extents.map((n: number) => fmt(n, 1)).join(", ")]] : []),
    ]
      .map(row)
      .join(""),
  );
  if (!s.frames.length) {
    html += `<div class="spec-group"><h4>Sheet frames</h4><table><tr><td>frame</td><td>none with a title block</td></tr></table></div>`;
  }
  s.frames.forEach((f: any, i: number) => {
    html +=
      `<div class="frame-head"><span class="frame-idx">F${String(i + 1).padStart(2, "0")}</span><span class="micro-label">sheet frame</span></div>` +
      group(
        f.paper + (f.isoRatio ? "" : " · fitted"),
        [
          ["handle", `<a href="#" data-h="${f.handle}" title="Select and zoom to this frame">${f.handle}</a>`],
          ["drawing number", esc(f.drawingNumber?.text ?? "—")],
          ["paper", `${f.paper}${f.isoRatio ? "" : " (frame is not an ISO ratio)"}`],
          ["measured scale", f.measured ? `1:${fmt(f.measured, 0)}` : "—"],
          ["declared scale", f.declared ? f.declared.ratios.map((r: number) => "1:" + fmt(r, 0)).join(", ") || (f.declared.nts ? "NTS" : "label without ratio") : "none"],
          ["frame size", `${fmt(f.widthMm / 1000, 2)} × ${fmt(f.heightMm / 1000, 2)} m`],
        ]
          .map(row)
          .join(""),
      );
  });
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
    `<h3>${esc(e.type)} <span class="handle">${esc(e.h)}</span></h3>` +
    `<div class="actions">` +
    `<button data-act="copy-h" title="Copy the handle: the entity's permanent ID in the drawing">Copy handle</button>` +
    `<button data-act="copy-link" title="Copy a viewer link that opens this entity">Copy link</button>` +
    `<button data-act="zoom" title="Zoom the drawing to this entity">Zoom to entity</button></div>` +
    `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("")}</table>` +
    (related.length
      ? `<div class="sub">Findings on this entity</div><ol class="list findings">${related
          .map((f) => `<li class="finding sev-${f.severity}"><span class="finding-num">${String(lint!.findings.indexOf(f) + 1).padStart(2, "0")}</span><div class="finding-main"><div class="finding-top">${sevDot(f.severity)}<span class="rule">${esc(f.rule)}</span></div><p class="finding-msg">${esc(f.title ?? f.message)}</p></div></li>`)
          .join("")}</ol>`
      : "");
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
  if (b.dataset.act === "copy-h") copyText("handle", e.h, e.type);
  if (b.dataset.act === "copy-link") copyText("link", location.href, "opens this entity while the viewer server runs");
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
if (innerWidth <= 860) {
  setPanel("left", false);
  setPanel("right", false);
}

window.addEventListener("keydown", (e) => {
  if (help.open || properties.open) return;
  if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
  if (e.key === "?") { e.preventDefault(); help.showModal(); return; }
  if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); backView(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "f" || e.key === "F") home();
  else if ((e.key === "b" || e.key === "B") && view.images.length) setBackgroundImage(!view.showImages);
  else if (e.key === "Escape") {
    view.selected.clear();
    view.activeFinding = null;
    view.request();
  } else if (e.key === "j" || e.key === "n") focusFinding(Math.min(visibleFindings.length - 1, activeIdx + 1));
  else if (e.key === "k" || e.key === "p") focusFinding(Math.max(0, activeIdx - 1));
  else if (e.key === "/") {
    e.preventDefault();
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
