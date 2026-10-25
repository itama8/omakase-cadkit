// Sewer network rules. The network is rebuilt from the drawing (symbols, pipe polylines and
// their label clusters) using the project's conventions in omakase-cadkit.json, then checked.

import type { FieldLayout, SewerConfig } from "../config.ts";
import { bboxAround, dist, Grid, greedyMatch, lineAngleDiff, nearestSegment, padBbox, pointAlong, polyDist, unionBbox, type Pt } from "../geometry.ts";
import type { Entity, Finding } from "../types.ts";
import type { LintContext, Rule } from "./engine.ts";

export interface Manhole {
  h: string;
  /** Distance from the symbol to its id label. */
  labelDist?: number;
  /** A different symbol that is nearer the id label than this one, if any. */
  nearerOther?: { h: string; id: string | null; d: number };
  /** Drawn far off the usual symbol scale (a legend key, not a network node). */
  key?: boolean;
  id: string | null;
  at: Pt;
  radius: number;
  outfall: boolean;
  gl?: number;
  il?: number;
  depth?: number;
  labels: string[]; // handles of matched label texts
}

export interface Pipe {
  h: string;
  id: string | null;
  verts: number[];
  len: number;
  labelLen?: number;
  dia?: number;
  /** Indexes into manholes for the polyline's first and last vertex. */
  start: number | null;
  end: number | null;
  /** +1 when flow runs start->end, -1 when end->start, 0 when unknown. */
  flow: 0 | 1 | -1;
  flowSource: "arrow" | "levels" | "none";
  labels: string[];
}

export interface Network {
  manholes: Manhole[];
  pipes: Pipe[];
  orphanLabels: { h: string; id: string; at: Pt }[];
  unlabelledPipeLabels: string[];
  keys: Manhole[];
}

const num = (rx: string | undefined, s: string): number | undefined => {
  if (!rx) return undefined;
  const m = s.trim().match(new RegExp(rx, "i"));
  return m ? Number(m[1]) : undefined;
};

function texts(ctx: LintContext, layer?: string): Entity[] {
  return ctx.drawing.entities.filter(
    (e) => (e.type === "TEXT" || e.type === "MTEXT") && e.text && e.ins && (!layer || ctx.layerName(e).toLowerCase() === layer.toLowerCase()),
  );
}

/**
 * Match each anchor label to one field text per field, one-to-one. Offsets are measured in the
 * anchor text's own rotated frame, so a label block keeps its layout when it runs along a pipe:
 * "below"/"above" keep fields on that side, "column" keeps them stacked in line, "any" is nearest.
 */
function fieldsNear(anchors: { key: number; at: Pt; rot: number }[], cands: Entity[], rx: string | undefined, r: number, layout: FieldLayout) {
  if (!rx) return new Map<number, { e: Entity; v: number }>();
  const re = new RegExp(rx, "i");
  const field = cands.filter((t) => re.test(t.text!.trim()));
  const grid = new Grid<Entity>(r * 2);
  for (const t of field) grid.insert(t, [t.ins![0], t.ins![1], t.ins![0], t.ins![1]]);
  const pairs: { a: number; b: Entity; d: number }[] = [];
  for (const a of anchors) {
    const c = Math.cos((-a.rot * Math.PI) / 180), s = Math.sin((-a.rot * Math.PI) / 180);
    for (const t of grid.query(bboxAround(a.at, r))) {
      const dx = t.ins![0] - a.at[0], dy = t.ins![1] - a.at[1];
      const lx = dx * c - dy * s, ly = dx * s + dy * c; // offset in the label's frame
      if (Math.hypot(lx, ly) > r) continue;
      if (layout === "below" && ly >= 0) continue;
      if (layout === "above" && ly <= 0) continue;
      if (layout !== "any" && Math.abs(lx) > r * 0.4) continue;
      pairs.push({ a: a.key, b: t, d: layout === "any" ? Math.hypot(lx, ly) : Math.abs(ly) + 2 * Math.abs(lx) });
    }
  }
  const m = greedyMatch(pairs);
  const out = new Map<number, { e: Entity; v: number }>();
  for (const [k, { b }] of m) {
    const v = num(rx, b.text!);
    if (v !== undefined && Number.isFinite(v)) out.set(k, { e: b, v });
  }
  return out;
}

export function buildNetwork(ctx: LintContext, cfg: SewerConfig): Network {
  const mhBlocks = new Set(cfg.manhole.blocks.map((b) => b.toUpperCase()));
  const ofBlocks = new Set((cfg.outfall?.blocks ?? []).map((b) => b.toUpperCase()));
  const manholes: Manhole[] = [];
  for (const e of ctx.drawing.entities) {
    if (e.type !== "INSERT" || !e.ins || !e.block) continue;
    const b = e.block.toUpperCase();
    const isMh = mhBlocks.has(b) && (!cfg.manhole.layer || ctx.layerName(e).toLowerCase() === cfg.manhole.layer.toLowerCase());
    const isOf = ofBlocks.has(b);
    if (!isMh && !isOf) continue;
    const radius = e.bbox ? Math.max(e.bbox[2] - e.bbox[0], e.bbox[3] - e.bbox[1]) / 2 : 0;
    manholes.push({ h: e.h, id: null, at: e.ins, radius, outfall: isOf, labels: [] });
  }

  // A symbol drawn at several times the usual scale is a legend key, not a node.
  const scales = manholes.map((m) => ctx.byHandle.get(m.h)!.sx ?? 1).sort((a, b) => a - b);
  const median = scales[Math.floor(scales.length / 2)] ?? 1;
  const keys: Manhole[] = [];
  for (let i = manholes.length - 1; i >= 0; i--) {
    const sx = Math.abs(ctx.byHandle.get(manholes[i].h)!.sx ?? 1);
    if (median > 0 && (sx > median * 3 || sx < median / 3)) keys.push({ ...manholes.splice(i, 1)[0], key: true });
  }

  // Manhole labels: id text, then GL / IL / depth near the id text.
  const nodeTexts = texts(ctx, cfg.manhole.layer);
  const idRx = new RegExp(cfg.manhole.label, "i");
  const idTexts = nodeTexts.filter((t) => idRx.test(t.text!.trim()));
  const R = cfg.manhole.labelRadius;
  const grid = new Grid<number>(R * 2);
  manholes.forEach((m, i) => grid.insert(i, [m.at[0], m.at[1], m.at[0], m.at[1]]));
  const pairs: { a: number; b: Entity; d: number }[] = [];
  for (const t of idTexts)
    for (const i of grid.query(bboxAround(t.ins!, R))) {
      if (manholes[i].outfall) continue;
      const d = dist(manholes[i].at, t.ins!);
      if (d <= R) pairs.push({ a: i, b: t, d });
    }
  const idMatch = greedyMatch(pairs);
  const usedId = new Set<Entity>();
  for (const [i, { b, d }] of idMatch) {
    manholes[i].id = b.text!.trim().match(idRx)![1] ?? b.text!.trim();
    manholes[i].labels.push(b.h);
    manholes[i].labelDist = d;
    usedId.add(b);
  }
  // a label that sits nearer another symbol than its own reads as that symbol's label
  for (const [i, { b, d }] of idMatch) {
    let best: number | null = null, bd = d;
    for (const j of grid.query(bboxAround(b.ins!, d))) {
      if (j === i || manholes[j].outfall) continue;
      const dj = dist(manholes[j].at, b.ins!);
      if (dj < bd * 0.8) {
        bd = dj;
        best = j;
      }
    }
    if (best !== null) manholes[i].nearerOther = { h: manholes[best].h, id: null, d: bd };
  }
  for (const m of manholes) if (m.nearerOther) m.nearerOther.id = manholes.find((x) => x.h === m.nearerOther!.h)?.id ?? null;
  const orphanLabels = idTexts.filter((t) => !usedId.has(t)).map((t) => ({ h: t.h, id: t.text!.trim().match(idRx)![1] ?? t.text!.trim(), at: t.ins! }));

  const anchors = [...idMatch].map(([i, { b }]) => ({ key: i, at: b.ins!, rot: b.rot ?? 0 }));
  for (const [field, rx] of [["gl", cfg.manhole.gl], ["il", cfg.manhole.il], ["depth", cfg.manhole.depth]] as const) {
    for (const [i, { e, v }] of fieldsNear(anchors, nodeTexts, rx, cfg.manhole.fieldRadius, cfg.manhole.fieldLayout)) {
      manholes[i][field] = v;
      manholes[i].labels.push(e.h);
    }
  }

  // Pipes and their ends.
  const nodeGrid = new Grid<number>(Math.max(cfg.snapTolerance * 4, 1));
  manholes.forEach((m, i) => nodeGrid.insert(i, [m.at[0], m.at[1], m.at[0], m.at[1]]));
  const nearestNode = (p: Pt): number | null => {
    let best: number | null = null, bd = Infinity;
    for (const i of nodeGrid.query(bboxAround(p, cfg.snapTolerance + 5))) {
      const m = manholes[i];
      const d = dist(m.at, p);
      const tol = Math.max(cfg.snapTolerance, m.radius * 1.25);
      if (d <= tol && d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const pipes: Pipe[] = [];
  for (const e of ctx.drawing.entities) {
    if (ctx.layerName(e).toLowerCase() !== cfg.pipe.layer.toLowerCase()) continue;
    const v = e.type === "LINE" ? e.pts : e.type === "LWPOLYLINE" || e.type === "POLYLINE" ? e.verts : undefined;
    if (!v || v.length < 4) continue;
    const n = v.length;
    pipes.push({
      h: e.h,
      id: null,
      verts: v,
      len: e.len ?? 0,
      start: nearestNode([v[0], v[1]]),
      end: nearestNode([v[n - 2], v[n - 1]]),
      flow: 0,
      flowSource: "none",
      labels: [],
    });
  }

  // Pipe labels: id text nearest the pipe, then length and diameter near the id text.
  const pipeTexts = texts(ctx, cfg.pipe.layer);
  const PR = cfg.pipe.labelRadius;
  const pipeGrid = new Grid<number>(PR * 2);
  pipes.forEach((p, i) => {
    const b = unionBbox([ctx.byHandle.get(p.h)?.bbox]);
    if (b) pipeGrid.insert(i, b);
  });
  let unlabelledPipeLabels: string[] = [];
  if (cfg.pipe.label) {
    const prx = new RegExp(cfg.pipe.label, "i");
    const pIds = pipeTexts.filter((t) => prx.test(t.text!.trim()));
    const pp: { a: number; b: Entity; d: number }[] = [];
    // Labels run along their pipe: a label whose angle disagrees with the segment it sits by
    // only takes that pipe when nothing else fits.
    for (const t of pIds)
      for (const i of pipeGrid.query(bboxAround(t.ins!, PR))) {
        const seg = nearestSegment(t.ins!, pipes[i].verts);
        if (seg.d > PR) continue;
        const skew = lineAngleDiff(seg.deg, t.rot ?? 0);
        pp.push({ a: i, b: t, d: seg.d + skew * (PR / 60) });
      }
    const pm = greedyMatch(pp);
    const used = new Set<Entity>();
    for (const [i, { b }] of pm) {
      pipes[i].id = b.text!.trim().match(prx)![1] ?? b.text!.trim();
      pipes[i].labels.push(b.h);
      used.add(b);
    }
    unlabelledPipeLabels = pIds.filter((t) => !used.has(t)).map((t) => t.h);
    const panchors = [...pm].map(([i, { b }]) => ({ key: i, at: b.ins!, rot: b.rot ?? 0 }));
    for (const [i, { e, v }] of fieldsNear(panchors, pipeTexts, cfg.pipe.length, cfg.pipe.fieldRadius, cfg.pipe.fieldLayout)) {
      pipes[i].labelLen = v;
      pipes[i].labels.push(e.h);
    }
    for (const [i, { e, v }] of fieldsNear(panchors, pipeTexts, cfg.pipe.diameter, cfg.pipe.fieldRadius, cfg.pipe.fieldLayout)) {
      pipes[i].dia = v;
      pipes[i].labels.push(e.h);
    }
  }

  // Flow direction: a flow arrow on the pipe wins; otherwise invert levels decide.
  if (cfg.pipe.flowArrowBlock) {
    const ab = cfg.pipe.flowArrowBlock.toUpperCase();
    const arrows = ctx.drawing.entities.filter((e) => e.type === "INSERT" && e.block?.toUpperCase() === ab && e.ins);
    const ap: { a: number; b: Entity; d: number }[] = [];
    for (const a of arrows)
      for (const i of pipeGrid.query(bboxAround(a.ins!, PR))) {
        const d = polyDist(a.ins!, pipes[i].verts);
        if (d <= Math.max(cfg.snapTolerance, 1)) ap.push({ a: i, b: a, d });
      }
    for (const [i, { b }] of greedyMatch(ap)) {
      const p = pipes[i];
      // direction of the pipe segment nearest the arrow
      let best = Infinity, dir: Pt = [1, 0];
      for (let k = 0; k + 3 < p.verts.length; k += 2) {
        const d = polyDist(b.ins!, p.verts.slice(k, k + 4));
        if (d < best) {
          best = d;
          const dx = p.verts[k + 2] - p.verts[k], dy = p.verts[k + 3] - p.verts[k + 1];
          const L = Math.hypot(dx, dy) || 1;
          dir = [dx / L, dy / L];
        }
      }
      const r = ((b.rot ?? 0) * Math.PI) / 180;
      const dot = Math.cos(r) * dir[0] + Math.sin(r) * dir[1];
      if (Math.abs(dot) > 0.5) {
        p.flow = dot > 0 ? 1 : -1;
        p.flowSource = "arrow";
      }
    }
  }
  for (const p of pipes) {
    if (p.flow !== 0 || p.start === null || p.end === null) continue;
    const a = manholes[p.start].il, b = manholes[p.end].il;
    if (a === undefined || b === undefined || a === b) continue;
    p.flow = a > b ? 1 : -1;
    p.flowSource = "levels";
  }
  return { manholes, pipes, orphanLabels, unlabelledPipeLabels, keys };
}

function cfgOf(ctx: LintContext): SewerConfig | null {
  return ctx.cfg.sewer ?? null;
}

const cache = new WeakMap<LintContext, Network>();
function net(ctx: LintContext): Network | null {
  const cfg = cfgOf(ctx);
  if (!cfg) return null;
  let n = cache.get(ctx);
  if (!n) {
    n = buildNetwork(ctx, cfg);
    cache.set(ctx, n);
  }
  return n;
}

const around = (p: Pt, r = 6) => padBbox([p[0] - r, p[1] - r, p[0] + r, p[1] + r], 0);
const f2 = (n: number | undefined) => (n === undefined ? "?" : n.toFixed(2));

const config: Rule = {
  id: "sewer-config",
  pack: "sewer",
  title: "Sewer conventions are configured",
  why: "The sewer rules need to know which symbols and labels mean manholes and pipes.",
  run(ctx) {
    const n = net(ctx);
    if (!n) return [{ rule: this.id, severity: "warning", message: 'The sewer pack is on but omakase-cadkit.json has no "sewer" section; sewer rules were skipped.', handles: [] }];
    if (n.manholes.length === 0)
      return [{ rule: this.id, severity: "warning", message: `No manhole symbols found (blocks ${ctx.cfg.sewer!.manhole.blocks.join(", ")}). Check the sewer section of omakase-cadkit.json.`, handles: [] }];
    return [];
  },
};

const manholeLabels: Rule = {
  id: "sewer-manhole-label",
  pack: "sewer",
  title: "Every manhole has one label and one number",
  why: "An unlabelled or doubly-numbered manhole cannot be tied to the schedule or the hydraulic model.",
  run(ctx) {
    const n = net(ctx);
    if (!n) return [];
    const out: Finding[] = [];
    const R = ctx.cfg.sewer!.manhole.labelRadius;
    // An unmatched symbol and an unmatched label close together are one label placed too far away.
    const unlabelled = n.manholes.filter((m) => !m.outfall && m.id === null);
    const pairs: { a: Manhole; b: (typeof n.orphanLabels)[number]; d: number }[] = [];
    for (const m of unlabelled) for (const o of n.orphanLabels) { const d = dist(m.at, o.at); if (d <= R * 3) pairs.push({ a: m, b: o, d }); }
    const far = greedyMatch(pairs);
    const farLabels = new Set([...far.values()].map((x) => x.b));
    for (const [m, { b: o, d }] of far)
      out.push({ rule: this.id, severity: "warning", message: `MH ${o.id}: label is ${d.toFixed(1)} ${ctx.sheet.units.used} from its symbol; readers will tie it to a neighbour.`, handles: [m.h, o.h], bbox: padBbox([Math.min(m.at[0], o.at[0]), Math.min(m.at[1], o.at[1]), Math.max(m.at[0], o.at[0]), Math.max(m.at[1], o.at[1])], 0.3) });
    // a stacked copy of a labelled symbol is reported by sewer-stacked-manholes instead
    const tol = Math.max(0.05, ctx.cfg.sewer!.snapTolerance * 0.2);
    const stackedOnLabelled = (m: Manhole) => n.manholes.some((o) => o !== m && o.id !== null && dist(o.at, m.at) <= tol);
    for (const m of unlabelled)
      if (!far.has(m) && !stackedOnLabelled(m)) out.push({ rule: this.id, severity: "error", message: "Manhole symbol has no number label nearby.", handles: [m.h], bbox: around(m.at) });
    for (const o of n.orphanLabels)
      if (!farLabels.has(o)) out.push({ rule: this.id, severity: "warning", message: `Label MH ${o.id} has no manhole symbol within ${R * 3} ${ctx.sheet.units.used}.`, handles: [o.h], bbox: around(o.at) });
    for (const m of n.manholes)
      if (m.nearerOther)
        out.push({
          rule: this.id,
          severity: "warning",
          message: `Label MH ${m.id} is ${m.nearerOther.d.toFixed(1)} ${ctx.sheet.units.used} from ${m.nearerOther.id ? "MH " + m.nearerOther.id + "'s" : "another"} symbol but ${m.labelDist!.toFixed(1)} ${ctx.sheet.units.used} from its own; readers will tie it to the wrong manhole.`,
          handles: [m.h, m.labels[0], m.nearerOther.h],
          bbox: unionBbox([around(m.at, 3), ctx.byHandle.get(m.labels[0])?.bbox, ctx.byHandle.get(m.nearerOther.h)?.bbox]),
          data: { own: m.labelDist, other: m.nearerOther.d },
        });
    for (const k of n.keys)
      out.push({ rule: this.id, severity: "info", message: `Manhole symbol at ${(ctx.byHandle.get(k.h)!.sx ?? 1).toFixed(2)}× scale treated as a legend key, not a node.`, handles: [k.h], bbox: ctx.byHandle.get(k.h)!.bbox });
    const byId = new Map<string, Manhole[]>();
    for (const m of n.manholes) if (m.id) byId.set(m.id, [...(byId.get(m.id) ?? []), m]);
    for (const [id, ms] of byId)
      if (ms.length > 1)
        out.push({
          rule: this.id,
          severity: "error",
          message: `Manhole number ${id} is used ${ms.length} times.`,
          handles: ms.map((m) => m.h),
          bbox: unionBbox(ms.map((m) => around(m.at))),
        });
    return out;
  },
};

const stacked: Rule = {
  id: "sewer-stacked-manholes",
  pack: "sewer",
  title: "Manhole symbols on top of each other",
  why: "Two symbols at one point double the manhole count and hide which one carries the data.",
  run(ctx) {
    const n = net(ctx);
    if (!n) return [];
    const tol = Math.max(0.05, ctx.cfg.sewer!.snapTolerance * 0.2);
    const g = new Grid<number>(tol * 4);
    n.manholes.forEach((m, i) => g.insert(i, [m.at[0], m.at[1], m.at[0], m.at[1]]));
    const seen = new Set<number>();
    const out: Finding[] = [];
    n.manholes.forEach((m, i) => {
      if (seen.has(i)) return;
      // an outfall flag on its final manhole is a convention, not a duplicate
      const near = g
        .query(bboxAround(m.at, tol))
        .filter((j) => j !== i && !seen.has(j) && dist(n.manholes[j].at, m.at) <= tol && n.manholes[j].outfall === m.outfall);
      if (!near.length) return;
      near.forEach((j) => seen.add(j));
      seen.add(i);
      out.push({
        rule: this.id,
        severity: "error",
        message: `${near.length + 1} ${m.outfall ? "outfall" : "manhole"} symbols stacked at one point${m.id ? ` (MH ${m.id})` : ""}.`,
        handles: [m.h, ...near.map((j) => n.manholes[j].h)],
        bbox: around(m.at),
      });
    });
    return out;
  },
};

const levels: Rule = {
  id: "sewer-levels",
  pack: "sewer",
  title: "Manhole levels add up and depths are in range",
  why: "Depth must equal ground level minus invert level; out-of-range depths are design or drafting errors.",
  run(ctx) {
    const n = net(ctx);
    if (!n) return [];
    const c = ctx.cfg.sewer!;
    const out: Finding[] = [];
    for (const m of n.manholes) {
      if (m.outfall) continue;
      const tag = m.id ? `MH ${m.id}` : "Manhole";
      if (m.gl !== undefined && m.il !== undefined && m.il > m.gl)
        out.push({ rule: this.id, severity: "error", message: `${tag}: invert ${f2(m.il)} is above ground ${f2(m.gl)}.`, handles: [m.h, ...m.labels], bbox: around(m.at) });
      if (m.gl !== undefined && m.il !== undefined && m.depth !== undefined) {
        const calc = m.gl - m.il;
        if (Math.abs(calc - m.depth) > 0.015)
          out.push({
            rule: this.id,
            severity: "error",
            message: `${tag}: depth label ${f2(m.depth)} m but GL ${f2(m.gl)} − IL ${f2(m.il)} = ${f2(calc)} m.`,
            handles: [m.h, ...m.labels],
            bbox: around(m.at),
            data: { gl: m.gl, il: m.il, depth: m.depth, calc },
          });
      }
      const d = m.depth ?? (m.gl !== undefined && m.il !== undefined ? m.gl - m.il : undefined);
      if (d !== undefined && c.minDepth !== undefined && d < c.minDepth)
        out.push({ rule: this.id, severity: "warning", message: `${tag}: depth ${f2(d)} m is below the ${c.minDepth} m minimum.`, handles: [m.h, ...m.labels], bbox: around(m.at), data: { depth: d } });
      if (d !== undefined && c.maxDepth !== undefined && d > c.maxDepth)
        out.push({ rule: this.id, severity: "warning", message: `${tag}: depth ${f2(d)} m is above the ${c.maxDepth} m maximum.`, handles: [m.h, ...m.labels], bbox: around(m.at), data: { depth: d } });
    }
    return out;
  },
};

const pipeLabels: Rule = {
  id: "sewer-pipe-label",
  pack: "sewer",
  title: "Pipe labels match the drawn pipe",
  why: "A labelled length that differs from the drawn length means the label or the alignment is stale.",
  run(ctx) {
    const n = net(ctx);
    if (!n || !ctx.cfg.sewer!.pipe.label) return [];
    const tolF = ctx.cfg.sewer!.lengthTolerance;
    const out: Finding[] = [];
    for (const p of n.pipes) {
      const e = ctx.byHandle.get(p.h)!;
      const mid = pointAlong(p.verts, 0.5).p;
      if (p.id === null) {
        out.push({ rule: this.id, severity: "warning", message: "Pipe has no number label nearby.", handles: [p.h], bbox: e.bbox ? padBbox(e.bbox, 0.1) : around(mid) });
        continue;
      }
      if (p.labelLen !== undefined && Math.abs(p.labelLen - p.len) > Math.max(0.5, tolF * p.len))
        out.push({
          rule: this.id,
          severity: "error",
          message: `Pipe ${p.id}: labelled ${p.labelLen.toFixed(1)} m, drawn ${p.len.toFixed(1)} m.`,
          handles: [p.h, ...p.labels],
          bbox: e.bbox ? padBbox(e.bbox, 0.1) : around(mid),
          data: { label: p.labelLen, drawn: p.len },
        });
    }
    for (const h of n.unlabelledPipeLabels) {
      const t = ctx.byHandle.get(h)!;
      out.push({ rule: this.id, severity: "warning", message: `Pipe label "${t.text}" is not next to any pipe.`, handles: [h], bbox: t.bbox });
    }
    return out;
  },
};

const connectivity: Rule = {
  id: "sewer-connectivity",
  pack: "sewer",
  title: "Pipes end at manholes and the network is connected",
  why: "A pipe that stops short of a manhole is a gap in the drawing or in the design.",
  run(ctx) {
    const n = net(ctx);
    if (!n) return [];
    const out: Finding[] = [];
    const touched = new Set<number>();
    for (const p of n.pipes) {
      const e = ctx.byHandle.get(p.h)!;
      const L = p.verts.length;
      if (p.start !== null) touched.add(p.start);
      if (p.end !== null) touched.add(p.end);
      const ends: [string, Pt, number | null][] = [["start", [p.verts[0], p.verts[1]], p.start], ["end", [p.verts[L - 2], p.verts[L - 1]], p.end]];
      for (const [which, at, node] of ends)
        if (node === null)
          out.push({
            rule: this.id,
            severity: "warning",
            message: `Pipe ${p.id ?? e.h} ${which} is not at a manhole (no symbol within ${ctx.cfg.sewer!.snapTolerance} ${ctx.sheet.units.used}).`,
            handles: [p.h],
            bbox: around(at, 4),
          });
      if (p.start !== null && p.start === p.end)
        out.push({ rule: this.id, severity: "warning", message: `Pipe ${p.id ?? e.h} starts and ends at the same manhole.`, handles: [p.h], bbox: e.bbox });
    }
    // symbols stacked at one point share whatever connects there
    const tol = ctx.cfg.sewer!.snapTolerance;
    for (const i of [...touched])
      n.manholes.forEach((m, j) => {
        if (!touched.has(j) && dist(m.at, n.manholes[i].at) <= tol) touched.add(j);
      });
    n.manholes.forEach((m, i) => {
      if (!touched.has(i))
        out.push({ rule: this.id, severity: "warning", message: `${m.outfall ? "Outfall" : m.id ? "MH " + m.id : "Manhole"} has no pipe connected.`, handles: [m.h], bbox: around(m.at) });
    });
    // components
    const parent = n.manholes.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const p of n.pipes) if (p.start !== null && p.end !== null) parent[find(p.start)] = find(p.end);
    // symbols stacked at one point are one node (an outfall flag on its last manhole)
    n.manholes.forEach((a, i) => n.manholes.forEach((b, j) => { if (j > i && dist(a.at, b.at) <= tol) parent[find(i)] = find(j); }));
    const comps = new Map<number, number[]>();
    n.manholes.forEach((_, i) => {
      if (!touched.has(i)) return;
      const r = find(i);
      comps.set(r, [...(comps.get(r) ?? []), i]);
    });
    const outfalls = n.manholes.filter((m) => m.outfall).length;
    if (comps.size > Math.max(1, outfalls)) {
      const sizes = [...comps.values()].map((c) => c.length).sort((a, b) => b - a);
      out.push({
        rule: this.id,
        severity: "info",
        message: `Network splits into ${comps.size} connected parts (sizes ${sizes.slice(0, 8).join(", ")}${sizes.length > 8 ? ", …" : ""}) for ${outfalls} outfall${outfalls === 1 ? "" : "s"}.`,
        handles: [],
        data: { parts: comps.size, sizes },
      });
    }
    return out;
  },
};

const hydraulics: Rule = {
  id: "sewer-gradient",
  pack: "sewer",
  title: "Pipes fall in the flow direction; diameters do not shrink downstream",
  why: "An adverse grade or a smaller pipe downstream is a design error that blocks flow.",
  run(ctx) {
    const n = net(ctx);
    if (!n) return [];
    const c = ctx.cfg.sewer!;
    const out: Finding[] = [];
    for (const p of n.pipes) {
      if (p.start === null || p.end === null || p.flow === 0) continue;
      const up = n.manholes[p.flow === 1 ? p.start : p.end], dn = n.manholes[p.flow === 1 ? p.end : p.start];
      if (up.il === undefined || dn.il === undefined || !(p.len > 0)) continue;
      const fall = up.il - dn.il;
      const slope = fall / p.len;
      const e = ctx.byHandle.get(p.h)!;
      const name = `Pipe ${p.id ?? p.h} (${up.id ?? "?"} → ${dn.id ?? "?"})`;
      if (p.flowSource === "arrow" && fall < 0)
        out.push({
          rule: this.id,
          severity: "error",
          message: `${name}: flow arrow points uphill, IL ${f2(up.il)} → ${f2(dn.il)} (rise ${f2(-fall)} m over ${p.len.toFixed(1)} m).`,
          handles: [p.h, up.h, dn.h],
          bbox: e.bbox ? padBbox(e.bbox, 0.15) : undefined,
          data: { fall, slope },
        });
      else if (fall === 0)
        out.push({ rule: this.id, severity: "warning", message: `${name}: flat, both inverts ${f2(up.il)}.`, handles: [p.h, up.h, dn.h], bbox: e.bbox });
      else if (c.minSlope !== undefined && slope > 0 && slope < c.minSlope)
        out.push({
          rule: this.id,
          severity: "warning",
          message: `${name}: grade 1 in ${Math.round(1 / slope)} is flatter than the 1 in ${Math.round(1 / c.minSlope)} minimum.`,
          handles: [p.h, up.h, dn.h],
          bbox: e.bbox,
          data: { slope },
        });
    }
    // diameter must not shrink downstream
    const inflow = new Map<number, Pipe[]>(), outflow = new Map<number, Pipe[]>();
    for (const p of n.pipes) {
      if (p.flow === 0 || p.start === null || p.end === null || p.dia === undefined) continue;
      const up = p.flow === 1 ? p.start : p.end, dn = p.flow === 1 ? p.end : p.start;
      outflow.set(up, [...(outflow.get(up) ?? []), p]);
      inflow.set(dn, [...(inflow.get(dn) ?? []), p]);
    }
    for (const [node, ins] of inflow) {
      const outs = outflow.get(node);
      if (!outs?.length) continue;
      const maxIn = Math.max(...ins.map((p) => p.dia!));
      const smallOut = outs.filter((p) => p.dia! < maxIn);
      if (!smallOut.length) continue;
      const m = n.manholes[node];
      out.push({
        rule: this.id,
        severity: "warning",
        message: `${m.id ? "MH " + m.id : "Manhole"}: ${maxIn} mm comes in, ${smallOut.map((p) => p.dia).join("/")} mm goes out.`,
        handles: [m.h, ...ins.map((p) => p.h), ...smallOut.map((p) => p.h)],
        bbox: around(m.at, 10),
      });
    }
    return out;
  },
};

export const sewerRules: Rule[] = [config, manholeLabels, stacked, levels, pipeLabels, connectivity, hydraulics];
export { net as sewerNetwork };
