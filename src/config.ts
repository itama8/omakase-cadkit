// Project profile: omakase-cadkit.json, found by walking up from the drawing's folder.
// It records what a drawing cannot say about itself (true units, paper, label conventions).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type FieldLayout = "below" | "above" | "column" | "any";

export interface SewerConfig {
  manhole: {
    layer?: string;
    blocks: string[];
    label: string; // regex, group 1 = id
    gl?: string; // regex, group 1 = ground level
    il?: string; // regex, group 1 = invert level
    depth?: string; // regex, group 1 = depth
    labelRadius: number; // symbol -> id label, drawing units
    fieldRadius: number; // id label -> its level/depth lines
    /** Where the level/depth lines sit relative to the id label, in the label's own frame. */
    fieldLayout: FieldLayout;
  };
  pipe: {
    layer: string;
    label?: string;
    length?: string;
    diameter?: string;
    labelRadius: number; // pipe -> id label
    fieldRadius: number; // id label -> its length/diameter lines
    fieldLayout: FieldLayout;
    flowArrowBlock?: string;
  };
  outfall?: { blocks: string[] };
  snapTolerance: number; // how far a pipe end may sit from a manhole centre
  minDepth?: number;
  maxDepth?: number;
  minSlope?: number; // fall per unit length, e.g. 0.002
  lengthTolerance: number; // fraction, labelled vs drawn pipe length
}

export interface Config {
  /** Override $INSUNITS: "mm" | "cm" | "m" | "in" | "ft". */
  units?: string;
  /** Paper the sheets are plotted on. When set it decides the measured scale; when not,
   *  ISO-ratio frames try every ISO sheet and other frames assume A0. */
  paper?: string;
  /** Minimum plotted text height in mm. */
  minTextMm: number;
  /** Regex a drawing number must match. */
  drawingNumber?: string;
  packs: string[];
  sewer?: SewerConfig;
  /** Where this config came from. */
  source?: string;
}

export const DEFAULTS: Config = {
  minTextMm: 1.8,
  packs: ["common"],
};

const SEWER_DEFAULTS: Omit<SewerConfig, "manhole" | "pipe"> & { manhole: Partial<SewerConfig["manhole"]>; pipe: Partial<SewerConfig["pipe"]> } = {
  manhole: { labelRadius: 16, fieldRadius: 7, fieldLayout: "column" },
  pipe: { labelRadius: 16, fieldRadius: 7, fieldLayout: "column" },
  snapTolerance: 0.5,
  lengthTolerance: 0.05,
};

export function findConfig(fromFile: string): string | null {
  let dir = path.dirname(path.resolve(fromFile));
  const stop = path.dirname(homedir());
  while (dir && dir !== stop && dir !== path.dirname(dir)) {
    for (const name of ["omakase-cadkit.json", "drawkit.json"]) {
      const p = path.join(dir, name);
      if (existsSync(p)) return p;
    }
    dir = path.dirname(dir);
  }
  return null;
}

export function loadConfig(forFile: string, explicit?: string): Config {
  const file = explicit ?? findConfig(forFile);
  if (!file) return { ...DEFAULTS };
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const cfg: Config = { ...DEFAULTS, ...raw, source: file };
  if (raw.sewer) {
    cfg.sewer = {
      ...SEWER_DEFAULTS,
      ...raw.sewer,
      manhole: { ...SEWER_DEFAULTS.manhole, ...raw.sewer.manhole },
      pipe: { ...SEWER_DEFAULTS.pipe, ...raw.sewer.pipe },
    } as SewerConfig;
  }
  return cfg;
}

/** Millimetres per drawing unit. */
export function unitToMm(units: string): number | null {
  switch (units.toLowerCase()) {
    case "mm":
    case "millimeters":
      return 1;
    case "cm":
    case "centimeters":
      return 10;
    case "m":
    case "meters":
      return 1000;
    case "km":
    case "kilometers":
      return 1_000_000;
    case "in":
    case "inches":
      return 25.4;
    case "ft":
    case "feet":
      return 304.8;
    default:
      return null;
  }
}
