// drawkit CLI. Text output by default, --json for machines. `lint` exits 1 when it finds errors.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { padBbox, unionBbox } from "./geometry.ts";
import { lintSet, makeContext, RULES, SET_RULES, type LintResult } from "./lint/engine.ts";
import { sewerNetwork } from "./lint/sewer.ts";
import { renderSvg } from "./render-svg.ts";
import { workingScale } from "./sheet.ts";
import { DrawingStore } from "./store.ts";
import type { Bbox, Entity, Finding } from "./types.ts";

const HELP = `drawkit — view, inspect and lint DWG/DXF drawings

usage:
  drawkit inspect <file>                       summary: units, sheet, scale, layers, blocks
  drawkit query <file> [filters]               entities as JSON lines
      --type T  --layer L  --block B  --text REGEX  --handle H  --near x,y,r  --limit N
  drawkit lint <file...> [--packs common,sewer] [--rule id,...] [--max N] [--json]
                                               exit 1 when any error is found
  drawkit network <file> [--json|--csv]        sewer network schedule (needs a sewer profile)
  drawkit render <file> --out a.svg|a.png [--handle H | --bbox x0,y0,x1,y1 | --finding N]
                [--width px] [--dark]          draw a region; PNG needs rsvg-convert or magick
  drawkit convert <in> <out.dwg|out.dxf>       DWG <-> DXF through ACadSharp, with a reread check
  drawkit view <file> [--handle H]             open in the browser viewer (starts the server)
  drawkit serve [--port 4280]                  run the viewer server
  drawkit rules                                list lint rules

options:
  --config path/to/drawkit.json   project profile (default: nearest drawkit.json above the file)
  --json                          machine output
`;

type Flags = Record<string, string | boolean>;

function parse(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["json", "csv", "dark", "help"].includes(k)) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const str = (f: Flags, k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
const fmtN = (n: number) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n * 1000) / 1000));

async function openWithCtx(store: DrawingStore, file: string, flags: Flags) {
  const { drawing } = await store.open(file);
  const cfg = loadConfig(file, str(flags, "config"));
  return makeContext(path.resolve(file), drawing, cfg);
}

async function cmdInspect(store: DrawingStore, file: string, flags: Flags) {
  const t0 = Date.now();
  const ctx = await openWithCtx(store, file, flags);
  const d = ctx.drawing;
  const types: Record<string, number> = {};
  for (const e of d.entities) types[e.type] = (types[e.type] ?? 0) + 1;
  const layers = d.layers.filter((l) => l.entities > 0).sort((a, b) => b.entities - a.entities);
  const blocks: Record<string, number> = {};
  for (const e of d.entities) if (e.type === "INSERT" && e.block) blocks[e.block] = (blocks[e.block] ?? 0) + 1;
  const summary = {
    file: ctx.file,
    acadVersion: d.acadVersion,
    format: d.source.format,
    bytes: d.source.bytes,
    profile: ctx.cfg.source ?? null,
    units: ctx.sheet.units,
    extents: ctx.sheet.extents,
    frames: ctx.sheet.frames.map((f) => ({
      handle: f.handle,
      bbox: f.bbox,
      paper: f.paper,
      isoRatio: f.isoRatio,
      measuredScale: f.measured,
      declaredScale: f.declared,
      drawingNumber: f.drawingNumber?.text ?? null,
      workingScale: workingScale(f),
    })),
    entities: d.entities.length,
    types,
    layers: layers.map((l) => ({ name: l.name, entities: l.entities, on: l.on, frozen: l.frozen })),
    blocks: Object.entries(blocks).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    layouts: d.layouts,
    unrendered: d.unrendered,
    ms: Date.now() - t0,
  };
  if (flags.json) return console.log(JSON.stringify(summary, null, 2));
  const u = summary.units;
  console.log(`${path.basename(ctx.file)}  ${d.acadVersion} ${d.source.format.toUpperCase()}  ${(d.source.bytes / 1e6).toFixed(1)} MB  ${d.entities.length.toLocaleString()} entities`);
  console.log(`profile   ${summary.profile ?? "none (defaults)"}`);
  console.log(`units     header ${u.declared}; using ${u.used} (${u.source})${u.looksProjected ? "; coordinates look like projected metres" : ""}`);
  if (summary.extents) console.log(`extents   ${summary.extents.map(fmtN).join(", ")}`);
  if (!summary.frames.length) console.log("frames    none found");
  for (const f of summary.frames)
    console.log(
      `frame     ${f.handle}  ${f.paper}${f.isoRatio ? "" : " (fitted, not ISO ratio)"}  measured 1:${f.measuredScale ?? "?"}  declared ${f.declaredScale ? (f.declaredScale.ratios.map((r) => "1:" + r).join(", ") || (f.declaredScale.nts ? "NTS" : "no ratio")) : "none"}  number ${f.drawingNumber ?? "?"}`,
    );
  console.log(`types     ${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`layers    ${layers.length} used of ${d.layers.length}: ${layers.slice(0, 15).map((l) => `${l.name} ${l.entities}${!l.on || l.frozen ? " (hidden)" : ""}`).join(", ")}${layers.length > 15 ? ", …" : ""}`);
  if (summary.blocks.length) console.log(`inserts   ${summary.blocks.slice(0, 12).map((b) => `${b.name} ${b.count}`).join(", ")}${summary.blocks.length > 12 ? ", …" : ""}`);
  if (Object.keys(d.unrendered).length) console.log(`not drawn ${Object.entries(d.unrendered).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

function matches(ctx: ReturnType<typeof makeContext>, e: Entity, flags: Flags): boolean {
  const t = str(flags, "type");
  if (t && !t.split(",").some((x) => x.toUpperCase() === e.type)) return false;
  const l = str(flags, "layer");
  if (l && !l.split(",").some((x) => x.toLowerCase() === ctx.layerName(e).toLowerCase())) return false;
  const b = str(flags, "block");
  if (b && !(e.block && b.split(",").some((x) => x.toLowerCase() === e.block!.toLowerCase()))) return false;
  const h = str(flags, "handle");
  if (h && !h.split(",").some((x) => x.toUpperCase() === e.h)) return false;
  const tx = str(flags, "text");
  if (tx && !(e.text !== undefined && new RegExp(tx, "i").test(e.text))) return false;
  const near = str(flags, "near");
  if (near) {
    const [x, y, r] = near.split(",").map(Number);
    if (!e.bbox) return false;
    const cx = Math.max(e.bbox[0], Math.min(x, e.bbox[2])), cy = Math.max(e.bbox[1], Math.min(y, e.bbox[3]));
    if (Math.hypot(cx - x, cy - y) > r) return false;
  }
  return true;
}

async function cmdQuery(store: DrawingStore, file: string, flags: Flags) {
  const ctx = await openWithCtx(store, file, flags);
  const limit = Number(str(flags, "limit") ?? 200);
  let n = 0, total = 0;
  for (const e of ctx.drawing.entities) {
    if (!matches(ctx, e, flags)) continue;
    total++;
    if (n < limit) {
      console.log(JSON.stringify({ ...e, layer: ctx.layerName(e) }));
      n++;
    }
  }
  if (total > n) console.error(`${total} matched; showing ${n} (--limit)`);
}

function printFinding(f: Finding, i: number) {
  const sev = f.severity === "error" ? "ERROR  " : f.severity === "warning" ? "WARN   " : "info   ";
  const hs = f.handles.length ? `  [${f.handles.slice(0, 6).join(" ")}${f.handles.length > 6 ? ` +${f.handles.length - 6}` : ""}]` : "";
  console.log(`${String(i).padStart(3)} ${sev}${f.rule}: ${f.message}${hs}`);
}

async function cmdLint(store: DrawingStore, files: string[], flags: Flags) {
  const ctxs = [];
  for (const f of files) ctxs.push(await openWithCtx(store, f, flags));
  const packs = str(flags, "packs")?.split(",");
  const only = str(flags, "rule")?.split(",");
  const maxPerRule = Number(str(flags, "max") ?? 200);
  const { results, setFindings } = lintSet(ctxs, { packs, maxPerRule });
  if (only)
    for (const r of results) {
      r.findings = r.findings.filter((f) => only.includes(f.rule));
      r.counts = { error: 0, warning: 0, info: 0 };
      for (const f of r.findings) r.counts[f.severity]++;
    }
  const errors = results.reduce((n, r) => n + r.counts.error, 0) + setFindings.filter((f) => f.severity === "error").length;
  if (flags.json) {
    console.log(JSON.stringify({ results: results.map(slimResult), setFindings, errors }, null, 2));
  } else {
    for (const r of results) {
      console.log(`\n${path.basename(r.file)}  —  ${r.counts.error} errors, ${r.counts.warning} warnings, ${r.counts.info} info  (packs: ${r.packs.join(", ")})`);
      r.findings.forEach((f, i) => printFinding(f, i + 1));
      for (const e of r.ruleErrors) console.log(`    rule ${e.rule} crashed: ${e.error.split("\n")[0]}`);
    }
    if (setFindings.length) {
      console.log(`\nacross the set`);
      setFindings.forEach((f, i) => printFinding({ ...f, message: `${path.basename(f.file ?? "")}: ${f.message}` }, i + 1));
    }
  }
  return errors > 0 ? 1 : 0;
}

function slimResult(r: LintResult) {
  return { file: r.file, counts: r.counts, packs: r.packs, findings: r.findings.map((f) => ({ ...f, handles: f.handles.slice(0, 100), handleCount: f.handles.length })), ruleErrors: r.ruleErrors };
}

async function cmdNetwork(store: DrawingStore, file: string, flags: Flags) {
  const ctx = await openWithCtx(store, file, flags);
  const n = sewerNetwork(ctx);
  if (!n) throw new Error('no "sewer" section in drawkit.json for this drawing');
  const mh = n.manholes.map((m) => ({ id: m.id, handle: m.h, outfall: m.outfall, x: m.at[0], y: m.at[1], gl: m.gl, il: m.il, depth: m.depth }));
  const pipes = n.pipes.map((p) => ({
    id: p.id,
    handle: p.h,
    from: p.start === null ? null : n.manholes[p.flow === -1 ? p.end! : p.start]?.id ?? null,
    to: p.end === null ? null : n.manholes[p.flow === -1 ? p.start! : p.end]?.id ?? null,
    flow: p.flowSource,
    drawnLength: Math.round(p.len * 100) / 100,
    labelLength: p.labelLen,
    diameter: p.dia,
  }));
  if (flags.csv) {
    console.log("kind,id,handle,x,y,gl,il,depth,from,to,drawn_length,label_length,diameter,flow");
    for (const m of mh) console.log(["manhole", m.id, m.handle, m.x.toFixed(3), m.y.toFixed(3), m.gl ?? "", m.il ?? "", m.depth ?? "", "", "", "", "", "", ""].join(","));
    for (const p of pipes) console.log(["pipe", p.id, p.handle, "", "", "", "", "", p.from ?? "", p.to ?? "", p.drawnLength, p.labelLength ?? "", p.diameter ?? "", p.flow].join(","));
    return;
  }
  if (flags.json) return console.log(JSON.stringify({ manholes: mh, pipes }, null, 2));
  const lab = mh.filter((m) => m.id).length;
  console.log(`${mh.length} manhole/outfall symbols (${lab} numbered), ${pipes.length} pipes (${pipes.filter((p) => p.id).length} numbered, ${pipes.filter((p) => p.flow !== "none").length} with a flow direction)`);
  console.log(`use --csv or --json for the schedule`);
}

function svgToPng(svg: string, out: string, width: number) {
  const tmp = out.replace(/\.png$/i, ".svg");
  writeFileSync(tmp, svg);
  const tryRun = (cmd: string, args: string[]) => {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (tryRun("rsvg-convert", ["-w", String(width), "-o", out, tmp])) return "rsvg-convert";
  if (tryRun("magick", [tmp, out])) return "magick";
  throw new Error(`no SVG rasteriser found (rsvg-convert or magick); the SVG is at ${tmp}`);
}

async function cmdRender(store: DrawingStore, file: string, flags: Flags) {
  const ctx = await openWithCtx(store, file, flags);
  const d = ctx.drawing;
  const out = str(flags, "out");
  if (!out) throw new Error("--out a.svg|a.png is required");
  let bbox: Bbox | undefined;
  const highlight = new Set<number>();
  let findings: Finding[] = [];
  const h = str(flags, "handle");
  if (h) {
    const hs = h.split(",").map((x) => x.toUpperCase());
    d.entities.forEach((e, i) => hs.includes(e.h) && highlight.add(i));
    bbox = unionBbox([...highlight].map((i) => d.entities[i].bbox));
    if (!bbox) throw new Error(`no drawn entity with handle ${h}`);
    bbox = padBbox(bbox, 1.5, 2);
  }
  const fnum = str(flags, "finding");
  if (fnum) {
    const { results } = lintSet([ctx], { packs: str(flags, "packs")?.split(",") });
    const f = results[0].findings[Number(fnum) - 1];
    if (!f) throw new Error(`no finding ${fnum}`);
    findings = [f];
    d.entities.forEach((e, i) => f.handles.includes(e.h) && highlight.add(i));
    bbox = f.bbox ? padBbox(f.bbox, 0.3, 2) : unionBbox([...highlight].map((i) => d.entities[i].bbox));
    if (!bbox) throw new Error(`finding ${fnum} has no location`);
  }
  const bb = str(flags, "bbox");
  if (bb) bbox = bb.split(",").map(Number) as Bbox;
  bbox ??= ctx.sheet.extents ?? undefined;
  if (!bbox) throw new Error("drawing has no extents");
  const width = Number(str(flags, "width") ?? 1600);
  const svg = renderSvg(d, { bbox, width, dark: !!flags.dark, highlight, findings });
  if (/\.png$/i.test(out)) {
    const via = svgToPng(svg, out, width);
    console.log(`${out}  (${via}; region ${bbox.map(fmtN).join(", ")})`);
  } else {
    writeFileSync(out, svg);
    console.log(`${out}  (region ${bbox.map(fmtN).join(", ")})`);
  }
}

async function serverUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function cmdView(file: string, flags: Flags) {
  const port = Number(str(flags, "port") ?? process.env.DRAWKIT_PORT ?? 4280);
  if (!(await serverUp(port))) {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "server.ts"), "--port", String(port)], { detached: true, stdio: "ignore" });
    child.unref();
    for (let i = 0; i < 50 && !(await serverUp(port)); i++) await new Promise((r) => setTimeout(r, 100));
  }
  const url = new URL(`http://127.0.0.1:${port}/`);
  url.searchParams.set("file", path.resolve(file));
  const h = str(flags, "handle");
  console.log(url.toString() + (h ? `#h=${h}` : ""));
}

function cmdRules(flags: Flags) {
  const all = [...RULES.map((r) => ({ id: r.id, pack: r.pack, title: r.title, why: r.why })), ...SET_RULES.map((r) => ({ id: r.id, pack: r.pack, title: r.title + " (across files)", why: r.why }))];
  if (flags.json) return console.log(JSON.stringify(all, null, 2));
  for (const r of all) console.log(`${r.pack.padEnd(7)} ${r.id.padEnd(26)} ${r.title}. ${r.why}`);
}

export async function main(argv: string[]): Promise<number> {
  const { pos, flags } = parse(argv);
  const [cmd, ...rest] = pos;
  if (!cmd || flags.help || cmd === "help") {
    process.stdout.write(HELP);
    return cmd ? 0 : 2;
  }
  if (cmd === "serve") {
    await import("./server.ts").then((m) => m.startServer(Number(str(flags, "port") ?? 4280)));
    return -1; // keep running
  }
  if (cmd === "rules") {
    cmdRules(flags);
    return 0;
  }
  if (cmd === "view") {
    if (!rest[0]) throw new Error("usage: drawkit view <file>");
    if (!existsSync(rest[0])) throw new Error(`no file at ${rest[0]}`);
    await cmdView(rest[0], flags);
    return 0;
  }
  const store = new DrawingStore();
  try {
    if (!rest[0]) throw new Error(`usage: see drawkit help`);
    switch (cmd) {
      case "inspect":
        await cmdInspect(store, rest[0], flags);
        return 0;
      case "query":
        await cmdQuery(store, rest[0], flags);
        return 0;
      case "lint":
        return await cmdLint(store, rest, flags);
      case "network":
        await cmdNetwork(store, rest[0], flags);
        return 0;
      case "render":
        await cmdRender(store, rest[0], flags);
        return 0;
      case "convert": {
        if (!rest[1]) throw new Error("usage: drawkit convert <in> <out.dwg|out.dxf>");
        const r = await store.convert(rest[0], rest[1]);
        console.log(flags.json ? JSON.stringify(r) : `${r.out}  ${r.entities} entities, ${r.acadVersion}, reread ok, ${r.ms} ms`);
        return 0;
      }
      default:
        process.stderr.write(`unknown command ${cmd}\n\n${HELP}`);
        return 2;
    }
  } finally {
    store.close();
  }
}
