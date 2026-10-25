// Public library entry point. Import from the package name, not from deep paths:
//
//   import { Cadkit } from "omakase-cadkit";
//
//   const kit = new Cadkit();
//   try {
//     const dwg = await kit.open("drawing.dwg");
//     const result = dwg.lint();
//     const svg = dwg.render({ width: 1200 });
//   } finally {
//     kit.close();
//   }
//
// Everything else under src/ is internal and may change between versions.
//
// Process ownership: constructing a Cadkit starts nothing. The first `open()` that is not
// satisfied from the payload cache spawns one sidecar process, which later opens reuse.
// `close()` kills it and refuses further opens; drawings already returned stay usable
// because they hold parsed data, not a process. `running` reports whether the sidecar is
// alive. The payload cache directory is process-wide and read at import time from
// OMAKASE_CADKIT_CACHE (DRAWKIT_CACHE also accepted), so set it before importing.
//
// Errors: `open()` throws for a missing file, a file that is not .dwg/.dxf, a sidecar that
// is not built, a crashed sidecar, or a request timeout; its message names the cause.
// `lint()` never throws for one broken rule; it reports the rule in `ruleErrors` instead.
// Calling `open()` after `close()` throws `CadkitError`.

import { loadConfig, type Config } from "./config.ts";
import { padBbox, unionBbox } from "./geometry.ts";
import { lintContext, makeContext, type LintContext, type LintResult } from "./lint/engine.ts";
import { entityMatcher, type EntityFilter } from "./query.ts";
import { renderSvg } from "./render-svg.ts";
import type { SheetInfo } from "./sheet.ts";
import { DrawingStore } from "./store.ts";
import type { Bbox, Drawing, Entity, Finding } from "./types.ts";

export class CadkitError extends Error {
  override name = "CadkitError";
}

export interface CadkitOptions {
  /** Parsed drawings kept in memory, most recent first. Default 3. */
  maxCachedDrawings?: number;
}

export interface OpenOptions {
  /** Project profile path. Default: nearest omakase-cadkit.json above the drawing. */
  config?: string;
}

export interface LintOptions {
  /** Rule packs to run. Default: the profile's packs, else all packs. */
  packs?: string[];
  /** Run only these rule ids. Default: every rule in the selected packs. */
  rules?: string[];
  /** Per-rule cap before a summarizing finding replaces the rest. Default 200. */
  maxPerRule?: number;
}

export interface RenderOptions {
  /** World-space bbox to draw. Default: the drawing's sheet extents, or the highlighted entities. */
  bbox?: Bbox;
  /** Output width in px; height follows the bbox aspect ratio. Default 1600. */
  width?: number;
  /** Dark background, for screenshots and slide decks. */
  dark?: boolean;
  /** Entity handles to highlight. */
  handles?: string[];
  /** Findings to outline. Their boxes draw on top of the geometry. */
  findings?: Finding[];
}

/** One opened drawing. Its methods are synchronous: the file is already parsed. */
export interface DrawingHandle {
  readonly file: string; // absolute, symlinks resolved
  readonly drawing: Drawing;
  readonly config: Config;
  readonly sheet: SheetInfo;
  /** True when this open came from the on-disk payload cache. */
  readonly cached: boolean;
  /** Milliseconds spent opening; 0 when served from the in-memory cache. */
  readonly loadMs: number;
  layerName(entity: Entity): string;
  entity(handle: string): Entity | undefined;
  entities(filter?: EntityFilter): Entity[];
  /** Runs every selected rule. One rule that throws lands in `ruleErrors`. */
  lint(options?: LintOptions): LintResult;
  /** SVG for a region, drawn from the same primitives the viewer draws. */
  render(options?: RenderOptions): string;
}

class OpenedDrawing implements DrawingHandle {
  readonly file: string;
  readonly cached: boolean;
  readonly loadMs: number;
  private readonly ctx: LintContext;

  constructor(file: string, drawing: Drawing, cfg: Config, cached: boolean, loadMs: number) {
    this.file = file;
    this.cached = cached;
    this.loadMs = loadMs;
    this.ctx = makeContext(file, drawing, cfg);
  }

  get drawing(): Drawing {
    return this.ctx.drawing;
  }
  get config(): Config {
    return this.ctx.cfg;
  }
  get sheet(): SheetInfo {
    return this.ctx.sheet;
  }
  layerName(entity: Entity): string {
    return this.ctx.layerName(entity);
  }
  entity(handle: string): Entity | undefined {
    return this.ctx.byHandle.get(handle.toUpperCase());
  }
  entities(filter: EntityFilter = {}): Entity[] {
    const match = entityMatcher(filter, this.ctx.layerName);
    return this.ctx.drawing.entities.filter(match);
  }
  lint(options: LintOptions = {}): LintResult {
    return lintContext(this.ctx, { packs: options.packs, only: options.rules, maxPerRule: options.maxPerRule });
  }
  render(options: RenderOptions = {}): string {
    const highlight = new Set<number>();
    if (options.handles?.length) {
      const wanted = new Set(options.handles.map((h) => h.toUpperCase()));
      this.ctx.drawing.entities.forEach((e, i) => {
        if (wanted.has(e.h.toUpperCase())) highlight.add(i);
      });
      if (highlight.size === 0) throw new CadkitError(`no entity with handle ${options.handles.join(", ")}`);
    }
    let bbox = options.bbox;
    if (!bbox && highlight.size) bbox = unionBbox([...highlight].map((i) => this.ctx.drawing.entities[i].bbox));
    if (!bbox) bbox = this.ctx.sheet.extents ?? undefined;
    if (!bbox) throw new CadkitError("drawing has no extents; pass render({ bbox })");
    if (highlight.size) bbox = padBbox(bbox, 0.3, 2);
    return renderSvg(this.ctx.drawing, {
      bbox,
      width: options.width,
      dark: options.dark,
      highlight,
      findings: options.findings,
    });
  }
}

export class Cadkit {
  private readonly store: DrawingStore;
  private shut = false;

  constructor(options: CadkitOptions = {}) {
    this.store = new DrawingStore(options.maxCachedDrawings);
  }

  /** True after `close()`. Drawings opened before it stay usable. */
  get closed(): boolean {
    return this.shut;
  }

  /** True while a sidecar process is alive for this instance. */
  get running(): boolean {
    return this.store.sidecar.alive;
  }

  async open(file: string, options: OpenOptions = {}): Promise<DrawingHandle> {
    if (this.shut) throw new CadkitError("Cadkit is closed; use a new instance to open drawings");
    const abs = DrawingStore.resolve(file);
    const { drawing, cached, ms } = await this.store.open(abs);
    return new OpenedDrawing(abs, drawing, loadConfig(abs, options.config), cached, ms);
  }

  /** Stops the sidecar. Idempotent; does not wait because the process dies with the call. */
  close(): void {
    if (this.shut) return;
    this.shut = true;
    this.store.close();
  }
}

export { entityMatcher, matchesEntity, type EntityFilter } from "./query.ts";
export type { Bbox, BlockInfo, Drawing, Entity, Finding, Layer, Severity } from "./types.ts";
export type { Config, FieldLayout, SewerConfig } from "./config.ts";
export type { LintResult, Rule, SetRule } from "./lint/engine.ts";
export type { DeclaredScale, Frame, SheetInfo, Units } from "./sheet.ts";
export type { SvgOptions } from "./render-svg.ts";
