// Rules for any drafting sheet: units, scale, plotted text size, duplicates, dependencies.

import { existsSync } from "node:fs";
import path from "node:path";
import { padBbox, unionBbox } from "../geometry.ts";
import { shortUnit, workingScale } from "../sheet.ts";
import type { Entity, Finding } from "../types.ts";
import type { LintContext, Rule } from "./engine.ts";

const fmt = (n: number, d = 2) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(d));
const isText = (e: Entity) => (e.type === "TEXT" || e.type === "MTEXT" || e.type === "ATTRIB") && typeof e.text === "string";
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function bboxOf(ctx: LintContext, handles: string[], limit = 400) {
  return unionBbox(handles.slice(0, limit).map((h) => ctx.byHandle.get(h)?.bbox));
}

const unitsDeclared: Rule = {
  id: "units-declared",
  pack: "common",
  title: "Declared units disagree with the geometry",
  why: "Tools that trust $INSUNITS (insert, xref, plot, GIS export) rescale the whole drawing.",
  run(ctx) {
    const u = ctx.sheet.units;
    const out: Finding[] = [];
    const declaredM = /^meters$/i.test(u.declared);
    if (u.looksProjected && !declaredM) {
      out.push({
        rule: this.id,
        severity: "error",
        message: `$INSUNITS is ${u.declared}, but the coordinates are projected metres (eastings ${fmt(ctx.sheet.extents![0])}–${fmt(ctx.sheet.extents![2])}). Anything that trusts the header scales this drawing by ${u.declared === "Inches" ? "0.0254" : "the wrong factor"}.`,
        handles: [],
        bbox: ctx.sheet.extents ?? undefined,
        data: { declared: u.declared, used: u.used },
      });
    } else if (u.source === "config" && shortUnit(u.declared) !== u.used && !/unitless/i.test(u.declared)) {
      out.push({
        rule: this.id,
        severity: "warning",
        message: `$INSUNITS is ${u.declared}; the project profile says ${u.used}. The file still carries the wrong header.`,
        handles: [],
      });
    } else if (/unitless/i.test(u.declared) && u.source !== "config") {
      out.push({ rule: this.id, severity: "info", message: `No units declared; plotted sizes assume ${u.used}. Set "units" in omakase-cadkit.json.`, handles: [] });
    }
    return out;
  },
};

const sheetFrame: Rule = {
  id: "sheet-frame",
  pack: "common",
  title: "Sheet frame and title block",
  why: "Scale and plotted-size checks need a frame; a frame needs a drawing number.",
  run(ctx) {
    const out: Finding[] = [];
    if (ctx.sheet.frames.length === 0) {
      out.push({ rule: this.id, severity: "info", message: "No sheet frame with a title block was found; scale and text-size checks were skipped.", handles: [] });
      return out;
    }
    for (const f of ctx.sheet.frames) {
      if (!f.drawingNumber)
        out.push({ rule: this.id, severity: "warning", message: "Frame has a title block but no drawing number was found in it.", handles: [f.handle], bbox: f.bbox });
      if (!f.isoRatio)
        out.push({
          rule: this.id,
          severity: "info",
          message: `Frame is ${fmt(f.widthMm / 1000, 1)} × ${fmt(f.heightMm / 1000, 1)} m of drawing, not an ISO sheet ratio; scale is judged as fitted to ${f.paper}.`,
          handles: [f.handle],
          bbox: f.bbox,
        });
    }
    const nums = ctx.sheet.frames.map((f) => f.drawingNumber?.text).filter(Boolean) as string[];
    const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
    for (const n of new Set(dup))
      out.push({ rule: this.id, severity: "error", message: `Drawing number ${n} is used by more than one frame in this file.`, handles: ctx.sheet.frames.filter((f) => f.drawingNumber?.text === n).map((f) => f.drawingNumber!.handle) });
    return out;
  },
};

const scaleMismatch: Rule = {
  id: "scale-mismatch",
  pack: "common",
  title: "Declared scale disagrees with the sheet",
  why: "A wrong scale label makes every measurement taken off the print wrong.",
  run(ctx) {
    const out: Finding[] = [];
    for (const f of ctx.sheet.frames) {
      const d = f.declared;
      if (!d) {
        out.push({ rule: this.id, severity: "warning", message: "Title block has no SCALE entry.", handles: [f.handle], bbox: f.bbox });
        continue;
      }
      if (d.nts && d.ratios.length === 0) continue;
      if (d.ratios.length === 0) {
        out.push({ rule: this.id, severity: "warning", message: "SCALE label has no ratio next to it.", handles: d.handles, bbox: bboxOf(ctx, d.handles) });
        continue;
      }
      if (!f.measured) continue;
      const ok = d.ratios.some((r) => Math.abs(r - f.measured!) / f.measured! <= 0.1);
      if (!ok) {
        out.push({
          rule: this.id,
          severity: "error",
          message: `Declares ${d.ratios.map((r) => "1:" + fmt(r, 0)).join(", ")} but the frame plots at ${f.snapped ? "1:" : "≈1:"}${fmt(f.measured, f.measured < 20 ? 1 : 0)} on ${f.paper}${f.paperSource === "profile" ? "" : f.paperSource === "iso-fit" ? " (paper guessed from the frame; set \"paper\" in omakase-cadkit.json)" : " (paper assumed; set \"paper\" in omakase-cadkit.json)"} — ${fmt(Math.max(f.widthMm, f.heightMm) / 1000, 1)} m of drawing across the sheet. Off by a factor of ${fmt(Math.max(d.ratios[0], f.measured) / Math.min(d.ratios[0], f.measured), 1)}.`,
          handles: [...d.handles, f.handle],
          bbox: bboxOf(ctx, d.handles) ? padBbox(bboxOf(ctx, d.handles)!, 2) : f.bbox,
          data: { declared: d.ratios, measured: f.measured, raw: f.rawRatio, paper: f.paper },
        });
      }
    }
    return out;
  },
};

const textHeightPaper: Rule = {
  id: "text-height-paper",
  pack: "common",
  title: "Text too small when plotted",
  why: "Text under ~1.8 mm on paper is unreadable on a site print (ISO 3098).",
  run(ctx) {
    const out: Finding[] = [];
    const min = ctx.cfg.minTextMm;
    const mm = ctx.sheet.units.mmPerUnit;
    for (const f of ctx.sheet.frames) {
      const scale = workingScale(f);
      if (!scale) continue;
      const groups = new Map<string, { hs: number[]; handles: string[] }>();
      for (const e of ctx.drawing.entities) {
        if (!isText(e) || !e.ins || !(e.height! > 0) || !e.text!.trim()) continue;
        if (e.ins[0] < f.bbox[0] || e.ins[0] > f.bbox[2] || e.ins[1] < f.bbox[1] || e.ins[1] > f.bbox[3]) continue;
        const paper = (e.height! * mm) / scale;
        if (paper >= min) continue;
        const key = ctx.layerName(e);
        const g = groups.get(key) ?? { hs: [], handles: [] };
        g.hs.push(paper);
        g.handles.push(e.h);
        groups.set(key, g);
      }
      for (const [layer, g] of groups) {
        const lo = Math.min(...g.hs), hi = Math.max(...g.hs);
        const range = Math.abs(hi - lo) < 0.005 ? `${lo.toFixed(2)} mm` : `${lo.toFixed(2)}–${hi.toFixed(2)} mm`;
        out.push({
          rule: this.id,
          severity: hi < min * 0.75 ? "error" : "warning",
          message: `${g.handles.length} text${g.handles.length > 1 ? "s" : ""} on layer ${layer} plot at ${range} (1:${fmt(scale, 0)}); minimum is ${min} mm. Needs height ≥ ${fmt((min * scale) / mm, 2)} ${ctx.sheet.units.used} or a larger scale.`,
          handles: g.handles,
          bbox: bboxOf(ctx, g.handles, 50),
          data: { layer, paperMm: [lo, hi], scale, count: g.handles.length },
        });
      }
    }
    return out;
  },
};

function geomKey(e: Entity, layer: string): string | null {
  const q = (n: number) => Math.round(n * 1000);
  switch (e.type) {
    case "INSERT":
      return e.ins ? `I|${layer}|${e.block}|${q(e.ins[0])},${q(e.ins[1])}|${q(e.rot ?? 0)}|${q(e.sx ?? 1)},${q(e.sy ?? 1)}` : null;
    case "TEXT":
    case "MTEXT":
      return e.ins ? `T|${layer}|${e.text}|${q(e.ins[0])},${q(e.ins[1])}|${q(e.height ?? 0)}` : null;
    case "LINE": {
      if (!e.pts) return null;
      const a = `${q(e.pts[0])},${q(e.pts[1])}`, b = `${q(e.pts[2])},${q(e.pts[3])}`;
      return `L|${layer}|${a < b ? a + b : b + a}`;
    }
    case "LWPOLYLINE":
    case "POLYLINE": {
      if (!e.verts || e.verts.length < 4) return null;
      const f = [];
      for (let i = 0; i < e.verts.length; i += 2) f.push(`${q(e.verts[i])},${q(e.verts[i + 1])}`);
      const fw = f.join(";"), bw = [...f].reverse().join(";");
      return `P|${layer}|${e.closed ? 1 : 0}|${fw < bw ? fw : bw}`;
    }
    case "CIRCLE":
      return e.c ? `C|${layer}|${q(e.c[0])},${q(e.c[1])}|${q(e.r ?? 0)}` : null;
    case "ARC":
      return e.c ? `A|${layer}|${q(e.c[0])},${q(e.c[1])}|${q(e.r ?? 0)}|${q(e.a0 ?? 0)}|${q(e.a1 ?? 0)}` : null;
    case "POINT":
      return e.p ? `O|${layer}|${q(e.p[0])},${q(e.p[1])}` : null;
    default:
      return null;
  }
}

const duplicates: Rule = {
  id: "duplicate-entities",
  pack: "common",
  title: "Identical entities stacked on each other",
  why: "Stacked copies double counts, quantities and plotted line weight, and hide edits made to only one copy.",
  run(ctx) {
    const groups = new Map<string, string[]>();
    for (const e of ctx.drawing.entities) {
      const k = geomKey(e, ctx.layerName(e));
      if (!k) continue;
      const arr = groups.get(k);
      if (arr) arr.push(e.h);
      else groups.set(k, [e.h]);
    }
    // One finding per (type, layer, block) family, listing every stacked set.
    const families = new Map<string, string[][]>();
    for (const hs of groups.values()) {
      if (hs.length < 2) continue;
      const e = ctx.byHandle.get(hs[0])!;
      const fam = `${e.type}${e.block ? " " + e.block : ""} on layer ${ctx.layerName(e)}`;
      const arr = families.get(fam) ?? [];
      arr.push(hs);
      families.set(fam, arr);
    }
    const out: Finding[] = [];
    for (const [fam, sets] of families) {
      const extra = sets.reduce((s, hs) => s + hs.length - 1, 0);
      const handles = sets.flatMap((hs) => hs.slice(1));
      out.push({
        rule: this.id,
        severity: "warning",
        message: `${extra} duplicate ${fam} (${sets.length} location${sets.length > 1 ? "s" : ""} with stacked copies).`,
        handles,
        bbox: bboxOf(ctx, handles, 200),
        data: { family: fam, locations: sets.length, extra, sets: sets.slice(0, 500) },
      });
    }
    return out;
  },
};

const externalDeps: Rule = {
  id: "external-dependencies",
  pack: "common",
  title: "Linked rasters, xrefs and OLE objects",
  why: "Linked files break when the drawing is copied or issued without them.",
  run(ctx) {
    const out: Finding[] = [];
    const dir = path.dirname(ctx.file);
    const images = new Map<string, string[]>();
    for (const e of ctx.drawing.entities) {
      if (e.type === "IMAGE") {
        const arr = images.get(e.file ?? "") ?? [];
        arr.push(e.h);
        images.set(e.file ?? "", arr);
      } else if (e.type === "OLE2FRAME") {
        out.push({ rule: this.id, severity: "info", message: "Embedded OLE object: most viewers and plot services show only its frame.", handles: [e.h], bbox: e.bbox });
      }
    }
    for (const [file, hs] of images) {
      const base = file.split(/[\\/]/).pop() ?? file;
      const found = [file, path.join(dir, file), path.join(dir, base)].find((p) => p && existsSync(p));
      out.push({
        rule: this.id,
        severity: found ? "warning" : "error",
        message: found
          ? `Raster ${base} is linked, not embedded (${hs.length} reference${hs.length > 1 ? "s" : ""}); the sheet breaks if it is issued without the file.`
          : `Raster ${base} is linked but missing (looked for ${file}); ${hs.length} reference${hs.length > 1 ? "s" : ""} will plot empty.`,
        handles: hs,
        bbox: bboxOf(ctx, hs),
        data: { file, resolved: found ?? null },
      });
    }
    for (const b of ctx.drawing.blocks) {
      if (!b.xref) continue;
      const p = b.xrefPath ?? "";
      const found = p && [p, path.join(dir, p), path.join(dir, p.split(/[\\/]/).pop()!)].find((x) => existsSync(x));
      out.push({
        rule: this.id,
        severity: found ? "warning" : "error",
        message: found ? `External reference ${b.name} (${p}).` : `External reference ${b.name} is missing (${p || "no path"}).`,
        handles: ctx.drawing.entities.filter((e) => e.type === "INSERT" && e.block === b.name).map((e) => e.h),
      });
    }
    return out;
  },
};

const dimensionOverride: Rule = {
  id: "dimension-override",
  pack: "common",
  title: "Dimension text overridden with a different value",
  why: "An overridden dimension states a size the geometry does not have.",
  run(ctx) {
    const out: Finding[] = [];
    for (const e of ctx.drawing.entities) {
      if (e.type !== "DIMENSION" || !e.text || e.text.includes("<>") || e.measurement === undefined) continue;
      const m = e.text.replace(/\\[A-Za-z][^;]*;|[{}]/g, "").match(/-?\d+(?:\.\d+)?/);
      if (!m) continue;
      const v = Number(m[0]);
      const meas = e.measurement;
      if (!(meas > 0)) continue;
      const factors = [1, 10, 100, 1000, 0.1, 0.01, 0.001];
      const match = factors.find((k) => Math.abs(v - meas * k) <= Math.max(0.01 * meas * k, 0.0005));
      if (match === undefined)
        out.push({
          rule: this.id,
          severity: "error",
          message: `Dimension reads "${e.text}" but measures ${meas.toFixed(3)} ${ctx.sheet.units.used} (×${(v / meas).toFixed(3)}).`,
          handles: [e.h],
          bbox: e.bbox,
          data: { text: e.text, measurement: meas },
        });
    }
    return out;
  },
};

const hiddenLayers: Rule = {
  id: "hidden-layers",
  pack: "common",
  title: "Content on layers that are off or frozen",
  why: "Hidden content travels with the file and reappears when someone turns the layer on.",
  run(ctx) {
    return ctx.drawing.layers
      .filter((l) => (!l.on || l.frozen) && l.entities > 0)
      .map((l) => ({
        rule: this.id,
        severity: "info" as const,
        message: `${l.entities} entities on layer ${l.name}, which is ${l.frozen ? "frozen" : "off"}.`,
        handles: ctx.drawing.entities.filter((e) => ctx.layerName(e) === l.name).slice(0, 200).map((e) => e.h),
      }));
  },
};

const degenerate: Rule = {
  id: "degenerate-entities",
  pack: "common",
  title: "Empty text and zero-length geometry",
  why: "Invisible junk inflates the file and confuses selection and quantity take-off.",
  run(ctx) {
    const empty: string[] = [], zero: string[] = [];
    for (const e of ctx.drawing.entities) {
      if ((e.type === "TEXT" || e.type === "MTEXT") && !(e.text ?? "").trim()) empty.push(e.h);
      if ((e.type === "LINE" || e.type === "LWPOLYLINE" || e.type === "POLYLINE") && e.len !== undefined && e.len < 1e-6) zero.push(e.h);
    }
    const out: Finding[] = [];
    if (empty.length) out.push({ rule: this.id, severity: "info", message: `${empty.length} empty text entities.`, handles: empty, bbox: bboxOf(ctx, empty) });
    if (zero.length) out.push({ rule: this.id, severity: "info", message: `${zero.length} zero-length lines or polylines.`, handles: zero, bbox: bboxOf(ctx, zero) });
    return out;
  },
};

const outsideFrame: Rule = {
  id: "outside-frame",
  pack: "common",
  title: "Content outside the sheet frame",
  why: "Content outside the frame is either lost at plot time or plotted where it should not be.",
  run(ctx) {
    if (ctx.sheet.frames.length !== 1) return [];
    const f = ctx.sheet.frames[0].bbox;
    const tol = Math.max(f[2] - f[0], f[3] - f[1]) * 0.002;
    const byLayer = new Map<string, string[]>();
    for (const e of ctx.drawing.entities) {
      if (!e.bbox) continue;
      const cx = (e.bbox[0] + e.bbox[2]) / 2, cy = (e.bbox[1] + e.bbox[3]) / 2;
      if (cx >= f[0] - tol && cx <= f[2] + tol && cy >= f[1] - tol && cy <= f[3] + tol) continue;
      const l = ctx.layerName(e);
      const arr = byLayer.get(l) ?? [];
      arr.push(e.h);
      byLayer.set(l, arr);
    }
    return [...byLayer].map(([layer, hs]) => ({
      rule: this.id,
      severity: "warning" as const,
      message: `${hs.length} entities on layer ${layer} sit outside the sheet frame.`,
      handles: hs,
      bbox: bboxOf(ctx, hs),
    }));
  },
};

const unrendered: Rule = {
  id: "unrendered",
  pack: "common",
  title: "Entities omakase-cadkit could not draw",
  why: "Review covers what is drawn; these entity types are skipped by the viewer.",
  run(ctx) {
    const u = Object.entries(ctx.drawing.unrendered);
    if (!u.length) return [];
    return [{ rule: this.id, severity: "info", message: `Not drawn: ${u.map(([k, v]) => `${v} ${k}`).join(", ")}.`, handles: [] }];
  },
};

export const commonRules: Rule[] = [unitsDeclared, sheetFrame, scaleMismatch, textHeightPaper, duplicates, externalDeps, dimensionOverride, outsideFrame, hiddenLayers, degenerate, unrendered];
