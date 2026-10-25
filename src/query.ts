// Entity filters shared by the CLI `query` command and the library entry point, so both
// answer the same question the same way.

import type { Entity } from "./types.ts";

export interface EntityFilter {
  /** DXF object names, case-insensitive: "TEXT", "LWPOLYLINE", "INSERT". */
  type?: string[];
  layer?: string[];
  /** Block name for INSERT entities, case-insensitive. */
  block?: string[];
  /** Entity handles, hex, case-insensitive. */
  handle?: string[];
  /** Case-insensitive expression tested against TEXT/MTEXT/ATTRIB content. */
  text?: string | RegExp;
  /** [x, y, radius] in world units: the entity's bbox must come within radius. */
  near?: [number, number, number];
}

const lower = (v: string) => v.toLowerCase();

/**
 * Compile a filter once, then reuse it per entity. `layerName` normally comes from the
 * drawing handle, because layer indexes are not names.
 */
export function entityMatcher(filter: EntityFilter, layerName: (e: Entity) => string): (e: Entity) => boolean {
  const types = filter.type?.map((t) => t.toUpperCase());
  const layers = filter.layer?.map(lower);
  const blocks = filter.block?.map(lower);
  const handles = filter.handle?.map((h) => h.toUpperCase());
  const text = typeof filter.text === "string" ? new RegExp(filter.text, "i") : filter.text;
  const near = filter.near;
  return (e) => {
    if (types && !types.includes(e.type.toUpperCase())) return false;
    if (layers && !layers.includes(lower(layerName(e)))) return false;
    if (blocks && !(e.block && blocks.includes(lower(e.block)))) return false;
    if (handles && !handles.includes(e.h.toUpperCase())) return false;
    if (text) {
      if (e.text === undefined) return false;
      text.lastIndex = 0; // a caller-supplied /g expression would otherwise skip matches
      if (!text.test(e.text)) return false;
    }
    if (near) {
      if (!e.bbox) return false;
      const [x, y, r] = near;
      const cx = Math.max(e.bbox[0], Math.min(x, e.bbox[2]));
      const cy = Math.max(e.bbox[1], Math.min(y, e.bbox[3]));
      if (Math.hypot(cx - x, cy - y) > r) return false;
    }
    return true;
  };
}

export function matchesEntity(e: Entity, filter: EntityFilter, layerName: (e: Entity) => string): boolean {
  return entityMatcher(filter, layerName)(e);
}
