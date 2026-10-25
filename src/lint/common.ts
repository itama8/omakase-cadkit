// Rules for any drafting sheet: units, scale, plotted text size, duplicates, dependencies.

import { existsSync } from "node:fs";
import path from "node:path";
import { padBbox, unionBbox } from "../geometry.ts";
import { shortUnit, workingScale } from "../sheet.ts";
import type { Entity, Finding, FixStep } from "../types.ts";
import type { LintContext, Rule } from "./engine.ts";

const fmt = (n: number, d = 2) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(d));
const isText = (e: Entity) => (e.type === "TEXT" || e.type === "MTEXT" || e.type === "ATTRIB") && typeof e.text === "string";
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const count = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
/** A paper length in mm, as metres once it passes a metre. */
const paperLen = (mm: number) => (mm >= 1000 ? `${fmt(mm / 1000, 1)} m` : `${Math.round(mm)} mm`);
const INSUNITS: Record<string, number> = { in: 1, ft: 2, mm: 4, cm: 5, m: 6 };
const UNIT_WORD: Record<string, string> = { in: "inches", ft: "feet", mm: "millimetres", cm: "centimetres", m: "metres" };
/** What the entities are, for headlines: "polylines", "block hp references". */
function kindWord(type: string, n: number, block?: string): string {
  const one = n === 1;
  switch (type) {
    case "LINE": return one ? "line" : "lines";
    case "LWPOLYLINE":
    case "POLYLINE": return one ? "polyline" : "polylines";
    case "CIRCLE": return one ? "circle" : "circles";
    case "ARC": return one ? "arc" : "arcs";
    case "POINT": return one ? "point" : "points";
    case "TEXT":
    case "MTEXT": return one ? "text" : "texts";
    case "INSERT": return `block ${block ?? "?"} ${one ? "reference" : "references"}`;
    default: return type;
  }
}

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
        title: `Drawing units are set to ${UNIT_WORD[shortUnit(u.declared)] ?? u.declared.toLowerCase()}, but the coordinates are in metres`,
        message: `$INSUNITS is ${u.declared}; the coordinates are projected metres (eastings ${fmt(ctx.sheet.extents![0])}–${fmt(ctx.sheet.extents![2])}). Inserting, xref-ing or exporting this drawing scales it by the wrong factor.`,
        fix: [{ command: "INSUNITS", text: "Set it to 6 (metres). Only the declared unit changes; nothing moves." }],
        handles: [],
        bbox: ctx.sheet.extents ?? undefined,
        data: { declared: u.declared, used: u.used },
      });
    } else if (u.source === "config" && shortUnit(u.declared) !== u.used && !/unitless/i.test(u.declared)) {
      out.push({
        rule: this.id,
        severity: "warning",
        title: `Drawing units are set to ${UNIT_WORD[shortUnit(u.declared)] ?? u.declared.toLowerCase()}, but this project uses ${UNIT_WORD[u.used] ?? u.used}`,
        message: `$INSUNITS is ${u.declared}; the project profile says ${u.used}. This review uses ${u.used}, but the file still carries the wrong header.`,
        fix: [{ command: "INSUNITS", text: `Set it to ${INSUNITS[u.used] ?? "the code for " + u.used} (${UNIT_WORD[u.used] ?? u.used}). Only the declared unit changes; nothing moves.` }],
        handles: [],
      });
    } else if (/unitless/i.test(u.declared) && u.source !== "config") {
      out.push({
        rule: this.id,
        severity: "info",
        title: "The drawing does not say what unit it is in",
        message: `$INSUNITS is Unitless; this review assumes ${u.used} for plotted sizes.`,
        fix: [
          { command: "INSUNITS", text: "Set the real unit: 4 for millimetres, 6 for metres." },
          { text: "Or choose the unit in this viewer's Properties panel (sliders icon) so the review uses it." },
        ],
        handles: [],
      });
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
      out.push({ rule: this.id, severity: "info", title: "No sheet border with a title block found", message: "Scale and plotted text-size checks need a border with a title block, so they were skipped.", handles: [] });
      return out;
    }
    for (const f of ctx.sheet.frames) {
      if (!f.drawingNumber)
        out.push({
          rule: this.id,
          severity: "warning",
          title: "The title block has no drawing number",
          message: "No DRAWING NO / DRG NO label with a number was found inside the sheet border.",
          fix: [{ command: "TEXTEDIT", text: "Add the drawing number next to the DRAWING NO label in the title block." }],
          handles: [f.handle],
          bbox: f.bbox,
        });
      if (!f.isoRatio && f.paperSource !== "profile" && f.paperSource !== "declared")
        out.push({
          rule: this.id,
          severity: "info",
          title: `The sheet border is not a standard paper shape, so the scale assumes it fills ${f.paper}`,
          message: `Border is ${fmt(f.widthMm / 1000, 1)} × ${fmt(f.heightMm / 1000, 1)} m of drawing; ISO sheets are 1 : 1.41. Scale and text-size checks use 1:${fmt(f.measured ?? 0, 0)} on ${f.paper}.`,
          fix: [{ text: `If the sheet is not printed on ${f.paper}, set "paper" (A0–A4) in omakase-cadkit.json beside the drawing.` }],
          handles: [f.handle],
          bbox: f.bbox,
        });
    }
    const nums = ctx.sheet.frames.map((f) => f.drawingNumber?.text).filter(Boolean) as string[];
    const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
    for (const n of new Set(dup))
      out.push({
        rule: this.id,
        severity: "error",
        title: `Drawing number ${n} is on more than one sheet in this file`,
        message: `${ctx.sheet.frames.filter((f) => f.drawingNumber?.text === n).length} title blocks carry ${n}.`,
        fix: [{ command: "TEXTEDIT", text: "Give each sheet its own number." }],
        handles: ctx.sheet.frames.filter((f) => f.drawingNumber?.text === n).map((f) => f.drawingNumber!.handle),
      });
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
        out.push({
          rule: this.id,
          severity: "warning",
          title: "The title block does not state a scale",
          message: `No SCALE label was found inside the border. The border is drawn for 1:${fmt(f.measured ?? 0, 0)} on ${f.paper}.`,
          fix: [{ command: "TEXT", text: `Add "SCALE 1:${fmt(f.measured ?? 0, 0)}" (or NTS) to the title block.` }],
          handles: [f.handle],
          bbox: f.bbox,
        });
        continue;
      }
      if (d.nts && d.ratios.length === 0) continue;
      if (d.ratios.length === 0) {
        out.push({
          rule: this.id,
          severity: "warning",
          title: "The SCALE label in the title block has no ratio",
          message: `No 1:N value sits next to the SCALE label. The border is drawn for 1:${fmt(f.measured ?? 0, 0)} on ${f.paper}.`,
          fix: [{ command: "TEXTEDIT", text: `Write the ratio, e.g. 1:${fmt(f.measured ?? 0, 0)}, next to SCALE.` }],
          handles: d.handles,
          bbox: bboxOf(ctx, d.handles),
        });
        continue;
      }
      if (!f.measured) continue;
      const ok = d.ratios.some((r) => Math.abs(r - f.measured!) / f.measured! <= 0.1);
      if (!ok) {
        const said = d.ratios.map((r) => "1:" + fmt(r, 0)).join(", ");
        const real = `${f.snapped ? "1:" : "≈1:"}${fmt(f.measured, f.measured < 20 ? 1 : 0)}`;
        const guessed = f.paperSource === "profile" ? "" : f.paperSource === "iso-fit" ? " (paper guessed from the border's shape)" : " (paper assumed)";
        const fixes: FixStep[] = [
          { command: "TEXTEDIT", text: `If the sheet is printed at ${real}, correct the scale in the title block to ${real}.` },
          { text: `If ${"1:" + fmt(d.ratios[0], 0)} is intended, the content does not fit this sheet at that scale: split it across sheets, or print it through a layout viewport at that scale.` },
        ];
        if (f.paperSource !== "profile") fixes.push({ text: `If the sheet is not printed on ${f.paper}, set "paper" in omakase-cadkit.json beside the drawing; this check uses it.` });
        out.push({
          rule: this.id,
          severity: "error",
          title: `Title block says ${said}, but the border is drawn for ${real} on ${f.paper}${guessed}`,
          message: `At ${"1:" + fmt(d.ratios[0], 0)} this border would print ${paperLen(f.widthMm / d.ratios[0])} × ${paperLen(f.heightMm / d.ratios[0])}, ${f.paperSource === "profile" ? `not ${f.paper}` : "which is no standard sheet"}. At ${real} it prints ${paperLen(f.widthMm / f.measured)} × ${paperLen(f.heightMm / f.measured)}. Measurements scaled off the print at ${said} are off by a factor of ${fmt(Math.max(d.ratios[0], f.measured) / Math.min(d.ratios[0], f.measured), 1)}.`,
          fix: fixes,
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
    // text on layers that never print cannot be too small on paper
    const printing = ctx.drawing.layers.map((l) => l.on && !l.frozen && l.plot !== false);
    for (const f of ctx.sheet.frames) {
      const scale = workingScale(f);
      if (!scale) continue;
      // a scale resting on a guessed paper size is not firm enough to call an error
      const firm = f.paperSource === "profile" || f.paperSource === "declared";
      const groups = new Map<string, { hs: number[]; handles: string[] }>();
      for (const e of ctx.drawing.entities) {
        if (!isText(e) || !e.ins || !(e.height! > 0) || !e.text!.trim() || printing[e.layer] === false) continue;
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
        const need = `${fmt((min * scale) / mm, 2)} ${ctx.sheet.units.used}`;
        out.push({
          rule: this.id,
          severity: hi < min * 0.75 && firm ? "error" : "warning",
          title: `${count(g.handles.length, "text")} on layer ${layer} will print ${range} tall`,
          message: `At 1:${fmt(scale, 0)} on ${f.paper}${firm ? "" : " (paper not confirmed)"} these print at ${range}; readable site prints need at least ${min} mm, which is ${need} in the drawing.`,
          fix: [
            { command: "LAYER", text: `If these should not print, set layer ${layer} to No Plot (or freeze it).` },
            { command: "SCALETEXT", text: `If they should print, scale them to a height of at least ${need}.` },
          ],
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
      const fam = `${e.type}|${e.block ?? ""}|${ctx.layerName(e)}`;
      const arr = families.get(fam) ?? [];
      arr.push(hs);
      families.set(fam, arr);
    }
    const out: Finding[] = [];
    for (const [fam, sets] of families) {
      const extra = sets.reduce((s, hs) => s + hs.length - 1, 0);
      const handles = sets.flatMap((hs) => hs.slice(1));
      const [type, block, layer] = fam.split("|");
      out.push({
        rule: this.id,
        severity: "warning",
        title: `Layer ${layer} has ${extra.toLocaleString("en-US")} duplicate ${kindWord(type, extra, block)}`,
        message: `${extra === 1 ? "It sits" : "Each sits"} exactly on an identical ${type} (${count(sets.length, "place")}). Copies double quantities and plotted line weight, and an edit to one copy leaves the other behind.`,
        fix: [
          { command: "ERASE", text: "Erase the selected entities. The selection holds only the extra copies; one of each stays." },
          { command: "OVERKILL", text: `Or run OVERKILL on layer ${layer} to remove copies and overlapping segments together.` },
        ],
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
        out.push({
          rule: this.id,
          severity: "info",
          title: "Embedded OLE object (e.g. a pasted Excel table) may not print",
          message: "Most viewers, plot services and PDF exports outside AutoCAD show only its frame.",
          fix: [{ command: "TABLE", text: "If it must appear on the issued sheet, rebuild it as an AutoCAD table (or link the Excel range with DATALINK)." }],
          handles: [e.h],
          bbox: e.bbox,
        });
      }
    }
    for (const [file, hs] of images) {
      const base = file.split(/[\\/]/).pop() ?? file;
      const found = [file, path.join(dir, file), path.join(dir, base)].find((p) => p && existsSync(p));
      out.push({
        rule: this.id,
        severity: found ? "warning" : "error",
        title: found ? `Image ${base} is linked from a separate file` : `Linked image ${base} is missing`,
        message: found
          ? `${count(hs.length, "reference")} point at ${file}. The sheet loses the image if it is issued without that file.`
          : `${count(hs.length, "reference")} point at ${file}, which was not found; they plot empty.`,
        fix: found
          ? [{ command: "ETRANSMIT", text: "Issue the drawing as a transmittal package so the image travels with it." }]
          : [{ command: "EXTERNALREFERENCES", text: "Select the image, then set Found At to where it now lives, or Detach it if it is no longer needed." }],
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
        title: found ? `Drawing ${b.name} is attached as an external reference` : `External reference ${b.name} is missing`,
        message: found ? `Its content lives in ${p}; the sheet loses it if issued without that file.` : `Looked for ${p || "(no path)"}; its content does not appear on this sheet.`,
        fix: found
          ? [{ command: "EXTERNALREFERENCES", text: "Bind it (right-click → Bind) to make the sheet self-contained, or issue with ETRANSMIT." }]
          : [{ command: "EXTERNALREFERENCES", text: "Select it, then set Found At to where the file now lives, or Detach it." }],
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
          title: `Dimension says ${e.text.replace(/\\[A-Za-z][^;]*;|[{}]/g, "")} but the geometry measures ${meas.toFixed(3)} ${ctx.sheet.units.used}`,
          message: `Its text is typed over with "${e.text}"; the measured value is ${meas.toFixed(3)} ${ctx.sheet.units.used} (×${(v / meas).toFixed(3)}).`,
          fix: [
            { command: "PROPERTIES", text: "Clear Text override (or set it to <>) so the dimension shows what it measures." },
            { text: "If the typed value is the design value, change the geometry to match instead." },
          ],
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
        title: `Layer ${l.name} is ${l.frozen ? "frozen" : "off"} but holds ${count(l.entities, "entity", "entities")}`,
        message: "Hidden content travels with the file and reappears when someone turns the layer on.",
        fix: [
          { command: l.frozen ? "LAYTHW" : "LAYON", text: "Show it to see what is there." },
          { command: "LAYDEL", text: "Delete the layer and its content if it is obsolete; leave it if it is deliberate working data." },
        ],
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
    const erase = [{ command: "ERASE", text: "Erase the selected entities; nothing visible is lost." }];
    if (empty.length) out.push({ rule: this.id, severity: "info", title: `${count(empty.length, "empty text")} with nothing in them`, message: "Invisible text inflates the file and gets picked up by selections and take-offs.", fix: erase, handles: empty, bbox: bboxOf(ctx, empty) });
    if (zero.length) out.push({ rule: this.id, severity: "info", title: `${count(zero.length, "line or polyline", "lines or polylines")} with zero length`, message: "Zero-length geometry is invisible but snaps, counts in take-offs and confuses selection.", fix: erase, handles: zero, bbox: bboxOf(ctx, zero) });
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
      title: `${count(hs.length, "entity", "entities")} on layer ${layer} ${hs.length === 1 ? "lies" : "lie"} outside the sheet border`,
      message: `${hs.length === 1 ? "It does" : "They do"} not appear when the sheet is printed to its border, or ${hs.length === 1 ? "it prints" : "they print"} where nothing should be.`,
      fix: [{ command: "MOVE", text: "Move inside the border if it belongs on this sheet; ERASE leftovers." }],
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
    const n = u.reduce((s, [, v]) => s + v, 0);
    return [{ rule: this.id, severity: "info", title: `${count(n, "entity", "entities")} not shown in this viewer`, message: `Not drawn: ${u.map(([k, v]) => `${v} ${k}`).join(", ")}. Check them in AutoCAD; this review does not cover them.`, handles: [] }];
  },
};

export const commonRules: Rule[] = [unitsDeclared, sheetFrame, scaleMismatch, textHeightPaper, duplicates, externalDeps, dimensionOverride, outsideFrame, hiddenLayers, degenerate, unrendered];
