// Drawing payload written by the sidecar (schema 8). See sidecar/Program.cs, Text.cs and Ole.cs.

export type Bbox = [number, number, number, number]; // minX, minY, maxX, maxY (world)

export interface Layer {
  name: string;
  color: number; // 0xRRGGBB
  on: boolean;
  frozen: boolean;
  locked: boolean;
  /** False for no-plot layers and Defpoints. */
  plot: boolean;
  lineType: string;
  entities: number;
}

export interface BlockInfo {
  name: string;
  anonymous: boolean;
  xref: boolean;
  xrefPath?: string;
  entities: number;
}

/** One top-level model-space entity. Coordinates are world coordinates. */
export interface Entity {
  h: string; // handle, hex
  type: string; // DXF object name: LINE, LWPOLYLINE, INSERT, TEXT, MTEXT, ...
  layer: number; // index into layers
  color: number;
  bbox?: Bbox; // from rendered primitives; absent when nothing rendered
  pts?: number[]; // LINE: x1,y1,x2,y2
  verts?: number[]; // polylines: x,y pairs (no bulge tessellation)
  closed?: boolean;
  len?: number; // drawn length, bulges included
  c?: [number, number];
  r?: number;
  a0?: number;
  a1?: number; // degrees
  ins?: [number, number];
  text?: string; // plain text for TEXT/MTEXT/ATTRIB, override text for DIMENSION
  height?: number;
  rot?: number; // degrees
  style?: string;
  tag?: string;
  block?: string;
  sx?: number;
  sy?: number;
  attrs?: { tag: string; value: string }[];
  p?: [number, number];
  pattern?: string;
  solid?: boolean;
  file?: string;
  /** IMAGE: per-pixel U and V vectors in world units. */
  u?: [number, number];
  v?: [number, number];
  /** IMAGE: size in pixels. */
  size?: [number, number];
  /** IMAGE: display flag and fade (0-100). */
  show?: boolean;
  fade?: number;
  /** IMAGE: clip boundary in image pixel coordinates, when clipping is on. */
  clip?: [number, number][];
  measurement?: number;
  propError?: string;
}

/**
 * Render primitives. Coordinates are relative to `origin`. Each carries the index of the
 * top-level entity it came from, so block content selects its insert.
 *   ["p", ent, layer, rgb, closed, [x,y,...], dash?]  polyline
 *   ["l", ent, layer, rgb, [x0,y0,x1,y1, ...]]        disjoint segments (hatch pattern lines)
 *   ["f", ent, layer, rgb, mode, [[x,y,...], ...]]    filled loops; text-box paths omitted. mode:
 *        0 pattern hatch too dense to draw (shown as a tint), 1 solid (even-odd islands),
 *        2 solid union of overlapping pieces (nonzero: wide polylines), 3 picking area only
 *        (its pattern or picture is drawn by other primitives)
 *   ["t", ent, layer, rgb, x, y, h, rotRad, align, text, font, wf, width]
 *        h = capital height (AutoCAD text height); align = l|c|r + b|m|t, top and middle
 *        refer to the capitals; font = sans|serif, then |b, |i or |bi; wf = width factor;
 *        width = laid-out advance in world units, which drawn glyphs are fitted to
 *   ["d", ent, layer, rgb, x, y]                       point
 *   ["c", ent, layer, rgb, x, y, r, dash?]             circle
 *   ["a", ent, layer, rgb, x, y, r, a0, a1, dash?]     ccw arc, radians
 * dash indexes `Drawing.dashes`; strokes without it are continuous.
 */
export type Prim =
  | ["p", number, number, number, 0 | 1, number[], number?]
  | ["l", number, number, number, number[]]
  | ["f", number, number, number, FillMode, number[][]]
  | ["t", number, number, number, number, number, number, number, string, string, string, number, number]
  | ["d", number, number, number, number, number]
  | ["c", number, number, number, number, number, number, number?]
  | ["a", number, number, number, number, number, number, number, number, number?];

export type FillMode = 0 | 1 | 2 | 3;

/** One drawn IMAGE in world space: a top-level image or one placed by an INSERT. */
export interface Raster {
  /** Index of the top-level entity that draws it (the image itself or its insert). */
  ent: number;
  /** Handle of the IMAGE entity. */
  h: string;
  layer: number;
  /** Image reference as stored in the drawing. */
  file: string;
  /** World position of pixel corner (0, 0), and world vectors per pixel. */
  ins: [number, number];
  u: [number, number];
  v: [number, number];
  /** Size in pixels. */
  size: [number, number];
  fade: number;
  /** Clip boundary in image pixel coordinates, when clipping is on. */
  clip?: [number, number][];
  /** Key into `Drawing.images` for a picture embedded in the drawing (OLE objects). */
  src?: string;
}

export interface Drawing {
  schema: 8;
  source: { path: string; format: string; bytes: number };
  acadVersion: string;
  header: { insUnits: string; insUnitsCode: number; extMin: [number, number]; extMax: [number, number]; ltScale: number };
  layers: Layer[];
  blocks: BlockInfo[];
  layouts: { name: string; entities: number }[];
  origin: [number, number];
  prims: Prim[];
  /** Images to draw beneath the primitives, in draw order. */
  rasters: Raster[];
  /** Pictures embedded in the drawing, as data URLs, keyed by content hash. */
  images: Record<string, string>;
  /** Linetype dash patterns in world units: dash, gap, dash, gap ...; 0 is a dot. */
  dashes: number[][];
  entities: Entity[];
  /** Entities, or parts of them, not drawn at all, with counts. */
  unrendered: Record<string, number>;
  /** Drawn, but not as the file specifies (substitute faces for SHX fonts, gradients in one colour), with counts. */
  approximated: Record<string, number>;
  notes: Record<string, number>;
  emitErrors: string[];
}

export type Severity = "error" | "warning" | "info";

/** One step of a fix: a CAD command (AutoCAD names) and what doing it achieves. */
export interface FixStep {
  command?: string;
  text: string;
}

export interface Finding {
  rule: string;
  severity: Severity;
  /** Plain-language headline: what is wrong and where. */
  title?: string;
  /** Evidence: the numbers that disagree. */
  message: string;
  /** How to fix it, in order. */
  fix?: FixStep[];
  /** Entity handles the finding is about, most relevant first. */
  handles: string[];
  /** World-space area to show. */
  bbox?: Bbox;
  /** Source file, set by the engine. */
  file?: string;
  data?: Record<string, unknown>;
}
