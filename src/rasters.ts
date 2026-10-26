// Finds the image files a drawing's IMAGE entities refer to. Drawings store the path as it was
// on the author's machine (often a Windows path relative to a folder that no longer exists), so
// the stored path is tried as given, relative to the drawing, then by file name next to it.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Drawing } from "./types.ts";

export const RASTER_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };

/** Candidate locations for an image reference, in the order they are tried. */
export function rasterCandidates(drawingPath: string, ref: string): string[] {
  const dir = path.dirname(drawingPath);
  const normalized = ref.replace(/\\/g, "/");
  return [...new Set([normalized, path.resolve(dir, normalized), path.join(dir, path.basename(normalized))].map((c) => path.resolve(c)))];
}

/** The first readable, supported image file for a reference, or null. */
export function resolveRaster(drawingPath: string, ref: string, limit = 64 * 1024 * 1024): { abs: string; type: string; size: number } | null {
  for (const abs of rasterCandidates(drawingPath, ref)) {
    const type = RASTER_TYPES[path.extname(abs).toLowerCase()];
    if (!type || !existsSync(abs)) continue;
    const stat = statSync(abs);
    if (stat.isFile() && stat.size <= limit) return { abs, type, size: stat.size };
  }
  return null;
}

export interface MissingRaster {
  /** The reference as stored in the drawing. */
  file: string;
  /** IMAGE entity handles that use it. */
  handles: string[];
  /** Where it was looked for. */
  tried: string[];
  /** Why it was not drawn. */
  reason: "missing" | "unsupported" | "too large";
}

/** Image references a reviewer will not see: missing files, unsupported formats, oversized files. */
export function missingRasters(d: Drawing, limit = 64 * 1024 * 1024): MissingRaster[] {
  const byFile = new Map<string, MissingRaster>();
  for (const r of d.rasters ?? []) {
    if (r.src) continue; // embedded in the drawing
    let entry = byFile.get(r.file);
    if (entry) {
      if (!entry.handles.includes(r.h)) entry.handles.push(r.h);
      continue;
    }
    if (resolveRaster(d.source.path, r.file, limit)) continue;
    const tried = rasterCandidates(d.source.path, r.file);
    const found = tried.find((c) => existsSync(c));
    const reason = !found ? "missing" : RASTER_TYPES[path.extname(found).toLowerCase()] ? "too large" : "unsupported";
    entry = { file: r.file, handles: [r.h], tried, reason };
    byFile.set(r.file, entry);
  }
  return [...byFile.values()];
}
