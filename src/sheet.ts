// What a drawing says about itself as a sheet: true units, frames, declared and measured scale.

import { unitToMm, type Config } from "./config.ts";
import { contains, pointIn } from "./geometry.ts";
import type { Bbox, Drawing, Entity } from "./types.ts";

export const PAPERS: Record<string, [number, number]> = {
  A0: [1189, 841],
  A1: [841, 594],
  A2: [594, 420],
  A3: [420, 297],
  A4: [297, 210],
};

export interface Units {
  declared: string;
  used: string;
  mmPerUnit: number;
  source: "config" | "header" | "inferred-projected" | "assumed";
  looksProjected: boolean;
}

export interface DeclaredScale {
  ratios: number[]; // denominators, e.g. [100] for 1:100, [1000, 100] for H/V
  nts: boolean;
  handles: string[];
}

export interface Frame {
  handle: string;
  bbox: Bbox;
  widthMm: number;
  heightMm: number;
  isoRatio: boolean;
  paper: string;
  /** Denominator from geometry: frame size over paper size, snapped to a standard scale. */
  measured: number | null;
  /** Unsnapped frame/paper ratio. */
  rawRatio: number;
  /** True when the measured scale is a standard scale, false when it is the raw fit. */
  snapped: boolean;
  /** Where the paper size came from. */
  paperSource: "profile" | "iso-fit" | "assumed";
  declared: DeclaredScale | null;
  drawingNumber: { text: string; handle: string } | null;
}

export interface SheetInfo {
  units: Units;
  extents: Bbox | null;
  frames: Frame[];
}

const TITLE_RX = /\b(SCALE|DRAWING\s*NO|DRG\.?\s*NO|DWG\.?\s*NO|TITLE)\b/i;
const RATIO_RX = /\b1\s*:\s*([\d,]+(?:\.\d+)?)\b/g;
const NTS_RX = /\bN\.?\s*T\.?\s*S\.?\b|NOT\s+TO\s+SCALE/i;
const DRG_LABEL_RX = /\b(DRAWING|DRG\.?|DWG\.?)\s*(NO|NUMBER)\.?\s*:?/i;

const STANDARD = (() => {
  const out: number[] = [];
  for (let k = 0; k <= 5; k++) for (const m of [1, 1.25, 2, 2.5, 5, 7.5]) out.push(m * 10 ** k);
  return out;
})();

export function snapScale(raw: number, tol = 0.06): number | null {
  let best: number | null = null;
  let bestErr = Infinity;
  for (const s of STANDARD) {
    const err = Math.abs(raw - s) / s;
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  return bestErr <= tol ? best : null;
}

function isText(e: Entity) {
  return (e.type === "TEXT" || e.type === "MTEXT" || e.type === "ATTRIB") && typeof e.text === "string";
}

/** Robust extents: 1st..99th percentile of entity centres, so one stray entity does not set the sheet. */
export function robustExtents(d: Drawing): Bbox | null {
  const xs: number[] = [], ys: number[] = [];
  for (const e of d.entities) {
    if (!e.bbox) continue;
    xs.push((e.bbox[0] + e.bbox[2]) / 2);
    ys.push((e.bbox[1] + e.bbox[3]) / 2);
  }
  if (xs.length === 0) return null;
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const q = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(f * (arr.length - 1))))];
  return [q(xs, 0.01), q(ys, 0.01), q(xs, 0.99), q(ys, 0.99)];
}

const SHORT: Record<string, string> = { millimeters: "mm", centimeters: "cm", meters: "m", kilometers: "km", inches: "in", feet: "ft" };
export function shortUnit(u: string): string {
  return SHORT[u.toLowerCase()] ?? u;
}

export function resolveUnits(d: Drawing, cfg: Config, ext: Bbox | null): Units {
  const declared = d.header.insUnits;
  // Projected coordinates (UTM and similar) in metres: eastings 100k-900k, northings 0-10M.
  const looksProjected =
    !!ext && ext[0] > 100_000 && ext[2] < 900_000 && ext[1] > 0 && ext[3] < 10_000_000 && ext[2] - ext[0] > 20;
  if (cfg.units && unitToMm(cfg.units)) return { declared, used: shortUnit(cfg.units), mmPerUnit: unitToMm(cfg.units)!, source: "config", looksProjected };
  if (looksProjected) return { declared, used: "m", mmPerUnit: 1000, source: "inferred-projected", looksProjected };
  const hdr = unitToMm(declared);
  if (hdr) return { declared, used: shortUnit(declared), mmPerUnit: hdr, source: "header", looksProjected };
  return { declared, used: "mm", mmPerUnit: 1, source: "assumed", looksProjected };
}

function rectOf(e: Entity): Bbox | null {
  if (e.type !== "LWPOLYLINE" && e.type !== "POLYLINE") return null;
  const v = e.verts ?? [];
  let n = v.length / 2;
  if (n === 5 && Math.abs(v[0] - v[8]) < 1e-6 && Math.abs(v[1] - v[9]) < 1e-6) n = 4;
  if (n !== 4 || !(e.closed || n === 4)) return null;
  // axis aligned: each edge is horizontal or vertical
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const dx = Math.abs(v[2 * j] - v[2 * i]), dy = Math.abs(v[2 * j + 1] - v[2 * i + 1]);
    if (Math.min(dx, dy) > 1e-6 * Math.max(dx, dy, 1)) return null;
  }
  const xs = [v[0], v[2], v[4], v[6]], ys = [v[1], v[3], v[5], v[7]];
  const b: Bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return b[2] - b[0] > 0 && b[3] - b[1] > 0 ? b : null;
}

function declaredScaleIn(texts: Entity[]): DeclaredScale | null {
  const scaleLabels = texts.filter((t) => /\bSCALE\b/i.test(t.text!));
  if (scaleLabels.length === 0) return null;
  const ratios: number[] = [];
  const handles: string[] = [];
  let nts = false;
  for (const lab of scaleLabels) {
    const h = lab.height ?? 1;
    const near = texts.filter((t) => {
      if (t === lab || !t.ins || !lab.ins) return false;
      const dx = t.ins[0] - lab.ins[0], dy = Math.abs(t.ins[1] - lab.ins[1]);
      return dx > 0 && dx < 40 * h && dy < 1.5 * h;
    });
    for (const t of [lab, ...near]) {
      const s = t.text!;
      let got = false;
      for (const m of s.matchAll(RATIO_RX)) {
        const v = Number(m[1].replace(/,/g, ""));
        if (v > 0) {
          ratios.push(v);
          got = true;
        }
      }
      if (NTS_RX.test(s)) {
        nts = true;
        got = true;
      }
      if (got && !handles.includes(t.h)) handles.push(t.h);
    }
  }
  if (ratios.length === 0 && !nts) return { ratios: [], nts: false, handles: scaleLabels.map((t) => t.h) };
  return { ratios: [...new Set(ratios)], nts, handles };
}

function drawingNumberIn(texts: Entity[], cfg: Config): { text: string; handle: string } | null {
  if (cfg.drawingNumber) {
    const rx = new RegExp(cfg.drawingNumber);
    const t = texts.find((t) => rx.test(t.text!.trim()));
    if (t) return { text: t.text!.trim(), handle: t.h };
  }
  for (const lab of texts.filter((t) => DRG_LABEL_RX.test(t.text!))) {
    const inline = lab.text!.replace(DRG_LABEL_RX, "").trim();
    if (inline.length >= 2) return { text: inline, handle: lab.h };
    const h = lab.height ?? 1;
    const next = texts
      .filter((t) => t !== lab && t.ins && lab.ins && t.ins[0] > lab.ins[0] && t.ins[0] - lab.ins[0] < 60 * h && Math.abs(t.ins[1] - lab.ins[1]) < 1.5 * h)
      .sort((a, b) => a.ins![0] - b.ins![0])[0];
    if (next) return { text: next.text!.trim(), handle: next.h };
  }
  return null;
}

export function analyzeSheet(d: Drawing, cfg: Config): SheetInfo {
  const ext = robustExtents(d);
  const units = resolveUnits(d, cfg, ext);
  const texts = d.entities.filter(isText);
  const titleTexts = texts.filter((t) => TITLE_RX.test(t.text!) && t.ins);

  const rects: { e: Entity; b: Bbox }[] = [];
  for (const e of d.entities) {
    const b = rectOf(e);
    if (b) rects.push({ e, b });
  }
  // A frame is a rectangle holding title-block text that no larger such rectangle holds.
  let cands = rects.filter((r) => titleTexts.some((t) => pointIn(r.b, t.ins!)));
  cands.sort((a, b) => (b.b[2] - b.b[0]) * (b.b[3] - b.b[1]) - (a.b[2] - a.b[0]) * (a.b[3] - a.b[1]));
  const kept: typeof cands = [];
  for (const c of cands) if (!kept.some((k) => contains(k.b, c.b, 1e-6))) kept.push(c);
  cands = kept;

  const frames: Frame[] = cands.map(({ e, b }) => {
    const wMm = (b[2] - b[0]) * units.mmPerUnit;
    const hMm = (b[3] - b[1]) * units.mmPerUnit;
    const long = Math.max(wMm, hMm), short = Math.min(wMm, hMm);
    const isoRatio = Math.abs(long / short - Math.SQRT2) / Math.SQRT2 < 0.03;
    let paper = cfg.paper ?? "A0";
    let paperSource: Frame["paperSource"] = cfg.paper ? "profile" : "assumed";
    let raw: number;
    let measured: number | null = null;
    if (cfg.paper && PAPERS[cfg.paper]) {
      const [pw, ph] = PAPERS[cfg.paper];
      raw = Math.max(long / pw, short / ph);
      measured = snapScale(raw, 0.08);
    } else if (isoRatio) {
      paperSource = "iso-fit";
      // try each ISO sheet; keep the one that lands nearest a standard scale
      let best: { p: string; raw: number; snap: number | null; err: number } | null = null;
      for (const [p, [pw]] of Object.entries(PAPERS)) {
        const r = long / pw;
        const snap = snapScale(r);
        const err = snap ? Math.abs(r - snap) / snap : Infinity;
        if (!best || err < best.err || (err === best.err && p === cfg.paper)) best = { p, raw: r, snap, err };
      }
      paper = best!.p;
      raw = best!.raw;
      measured = best!.snap;
    } else {
      const [pw, ph] = PAPERS.A0;
      raw = Math.max(long / pw, short / ph);
      measured = snapScale(raw, 0.08);
    }
    const snapped = measured !== null;
    // an unsnapped fit is still a measurement: keep two significant figures
    if (measured === null) measured = Number(raw.toPrecision(2));
    const inside = texts.filter((t) => t.ins && pointIn(b, t.ins));
    return {
      handle: e.h,
      bbox: b,
      widthMm: wMm,
      heightMm: hMm,
      isoRatio,
      paper,
      measured,
      rawRatio: raw,
      snapped,
      paperSource,
      declared: declaredScaleIn(inside),
      drawingNumber: drawingNumberIn(inside, cfg),
    };
  });
  return { units, extents: ext, frames };
}

/** The scale to judge plotted sizes by: the measured one, else the declared one. */
export function workingScale(f: Frame | undefined): number | null {
  if (!f) return null;
  return f.measured ?? f.declared?.ratios[0] ?? null;
}
