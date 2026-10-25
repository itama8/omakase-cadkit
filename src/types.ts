// Drawing payload written by the sidecar (schema 5). See sidecar/Program.cs.

export type Bbox = [number, number, number, number]; // minX, minY, maxX, maxY (world)

export interface Layer {
  name: string;
  color: number; // 0xRRGGBB
  on: boolean;
  frozen: boolean;
  locked: boolean;
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
 *   ["p", ent, layer, rgb, closed, [x,y,...]]        polyline
 *   ["f", ent, layer, rgb, solid, [[x,y,...], ...]] filled geometric loops (even-odd); text-box paths omitted
 *   ["t", ent, layer, rgb, x, y, h, rotRad, align, text]  align = l|c|r + b|m|t
 *   ["d", ent, layer, rgb, x, y]                     point
 *   ["c", ent, layer, rgb, x, y, r]                  circle
 *   ["a", ent, layer, rgb, x, y, r, a0, a1]          ccw arc, radians
 */
export type Prim =
  | ["p", number, number, number, 0 | 1, number[]]
  | ["f", number, number, number, 0 | 1, number[][]]
  | ["t", number, number, number, number, number, number, number, string, string]
  | ["d", number, number, number, number, number]
  | ["c", number, number, number, number, number, number]
  | ["a", number, number, number, number, number, number, number, number];

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
}

export interface Drawing {
  schema: 5;
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
  entities: Entity[];
  unrendered: Record<string, number>;
  notes: Record<string, number>;
  emitErrors: string[];
}

export type Severity = "error" | "warning" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** Entity handles the finding is about, most relevant first. */
  handles: string[];
  /** World-space area to show. */
  bbox?: Bbox;
  /** Source file, set by the engine. */
  file?: string;
  data?: Record<string, unknown>;
}
