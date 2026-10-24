import type { Config } from "../config.ts";
import { analyzeSheet, type SheetInfo } from "../sheet.ts";
import type { Drawing, Entity, Finding, Severity } from "../types.ts";
import { commonRules } from "./common.ts";
import { sewerRules } from "./sewer.ts";

export interface LintContext {
  file: string;
  drawing: Drawing;
  cfg: Config;
  sheet: SheetInfo;
  byHandle: Map<string, Entity>;
  layerName: (e: Entity) => string;
}

export interface Rule {
  id: string;
  pack: string;
  title: string;
  /** One line: what is checked and why it matters. */
  why: string;
  run(ctx: LintContext): Finding[];
}

export interface SetRule {
  id: string;
  pack: string;
  title: string;
  why: string;
  run(ctxs: LintContext[]): Finding[];
}

export const RULES: Rule[] = [...commonRules, ...sewerRules];

export function makeContext(file: string, drawing: Drawing, cfg: Config): LintContext {
  const byHandle = new Map<string, Entity>();
  for (const e of drawing.entities) byHandle.set(e.h, e);
  return {
    file,
    drawing,
    cfg,
    sheet: analyzeSheet(drawing, cfg),
    byHandle,
    layerName: (e) => drawing.layers[e.layer]?.name ?? "?",
  };
}

export interface LintResult {
  file: string;
  findings: Finding[];
  counts: Record<Severity, number>;
  sheet: SheetInfo;
  packs: string[];
  rulesRun: string[];
  ruleErrors: { rule: string; error: string }[];
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function cap(findings: Finding[], max: number, ruleId: string): Finding[] {
  if (findings.length <= max) return findings;
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const kept = sorted.slice(0, max);
  const rest = sorted.slice(max);
  kept.push({
    rule: ruleId,
    severity: "info",
    message: `${rest.length} more ${ruleId} findings not listed (limit ${max})`,
    handles: rest.flatMap((f) => f.handles).slice(0, 200),
  });
  return kept;
}

export function lintContext(ctx: LintContext, opts: { packs?: string[]; maxPerRule?: number; only?: string[] } = {}): LintResult {
  const packs = opts.packs ?? ctx.cfg.packs;
  const rules = RULES.filter((r) => packs.includes(r.pack) && (!opts.only || opts.only.includes(r.id)));
  const findings: Finding[] = [];
  const ruleErrors: { rule: string; error: string }[] = [];
  for (const r of rules) {
    try {
      const out = r.run(ctx).map((f) => ({ ...f, file: ctx.file }));
      findings.push(...cap(out, opts.maxPerRule ?? 200, r.id));
    } catch (err: any) {
      ruleErrors.push({ rule: r.id, error: String(err?.stack ?? err) });
    }
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.rule.localeCompare(b.rule));
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { file: ctx.file, findings, counts, sheet: ctx.sheet, packs, rulesRun: rules.map((r) => r.id), ruleErrors };
}

/** Rules that need every drawing in a set at once. */
export const SET_RULES: SetRule[] = [
  {
    id: "drawing-number-duplicate",
    pack: "common",
    title: "Drawing number used twice",
    why: "Two sheets with one number make revisions and transmittals ambiguous.",
    run(ctxs) {
      const seen = new Map<string, { file: string; handle: string }[]>();
      for (const c of ctxs)
        for (const f of c.sheet.frames) {
          if (!f.drawingNumber) continue;
          const key = f.drawingNumber.text.replace(/\s+/g, "").toUpperCase();
          const arr = seen.get(key) ?? [];
          arr.push({ file: c.file, handle: f.drawingNumber.handle });
          seen.set(key, arr);
        }
      const out: Finding[] = [];
      for (const [num, uses] of seen) {
        if (uses.length < 2) continue;
        for (const u of uses)
          out.push({
            rule: "drawing-number-duplicate",
            severity: "error",
            message: `Drawing number ${num} also appears in ${uses.filter((x) => x !== u).map((x) => x.file.split("/").pop()).join(", ")}`,
            handles: [u.handle],
            file: u.file,
          });
      }
      return out;
    },
  },
];

export function lintSet(ctxs: LintContext[], opts: { packs?: string[]; maxPerRule?: number } = {}): { results: LintResult[]; setFindings: Finding[] } {
  const results = ctxs.map((c) => lintContext(c, opts));
  const packs = opts.packs ?? ctxs[0]?.cfg.packs ?? ["common"];
  const setFindings = ctxs.length > 1 ? SET_RULES.filter((r) => packs.includes(r.pack)).flatMap((r) => r.run(ctxs)) : [];
  return { results, setFindings };
}
