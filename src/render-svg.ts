// Region -> SVG, for agents and reports: the same primitives the viewer draws.

import { readFileSync } from "node:fs";
import { intersects } from "./geometry.ts";
import { resolveRaster } from "./rasters.ts";
import type { Bbox, Drawing, Finding } from "./types.ts";

export const RASTER_LIMIT = 6 * 1024 * 1024;

function rasterHref(d: Drawing, ref: string, src?: string): string | null {
  if (src) return d.images?.[src] ?? null;
  const found = resolveRaster(d.source.path, ref, RASTER_LIMIT);
  return found ? `data:${found.type};base64,${readFileSync(found.abs).toString("base64")}` : null;
}

const hex = (rgb: number, dark: boolean) => {
  // ACI 7 / white and black flip to the ink colour of the background
  if (rgb === 0xffffff || rgb === 0) return dark ? "#e8e8e8" : "#111111";
  return "#" + rgb.toString(16).padStart(6, "0");
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const SANS = "'Liberation Sans', Arimo, Arial, Helvetica, sans-serif";
const SERIF = "'Liberation Serif', Tinos, 'Times New Roman', Times, serif";
// Font size per capital height for the faces drawn (Liberation's capitals are 0.688 and 0.655
// em); widths are fitted separately, to the advance each text primitive carries.
const EM_PER_CAP = { sans: 1 / 0.688, serif: 0.973 / 0.655 };

// stroke-dasharray for a stroke's dash pattern at k px per unit; continuous when too fine to see.
function dashArray(d: Drawing, index: number | undefined, k: number): string {
  const pattern = index === undefined ? undefined : d.dashes?.[index];
  if (!pattern || pattern.reduce((a, b) => a + b, 0) * k < 3) return "";
  return ` stroke-dasharray="${pattern.map((v) => Math.max(v * k, 1).toFixed(2)).join(" ")}"`;
}

export interface SvgOptions {
  bbox: Bbox; // world
  width?: number; // px
  dark?: boolean;
  highlight?: Set<number>; // entity indexes
  findings?: Finding[];
  hiddenLayers?: Set<number>;
}

export function renderSvg(d: Drawing, o: SvgOptions): string {
  const [ox, oy] = d.origin;
  const [x0, y0, x1, y1] = o.bbox;
  const W = o.width ?? 1600;
  const span = Math.max(x1 - x0, 1e-9);
  const k = W / span;
  const H = Math.max(1, Math.round((y1 - y0) * k));
  const rel: Bbox = [x0 - ox, y0 - oy, x1 - ox, y1 - oy];
  const X = (x: number) => ((x - rel[0]) * k).toFixed(2);
  const Y = (y: number) => ((rel[3] - y) * k).toFixed(2);
  const bg = o.dark ? "#16181d" : "#ffffff";
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${SANS}">`);
  parts.push(`<rect width="100%" height="100%" fill="${bg}"/>`);
  const hl = o.highlight ?? new Set<number>();
  const hidden = o.hiddenLayers ?? new Set<number>();
  const rasters = new Map<string, string | null>();
  const skippedRasters = new Set<string>();
  for (const [ri, e] of (d.rasters ?? []).entries()) {
    if (hidden.has(e.layer)) continue;
    const key = e.src ? `embedded:${e.src}` : e.file;
    if (!rasters.has(key)) rasters.set(key, rasterHref(d, e.file, e.src));
    const href = rasters.get(key);
    if (!href) {
      skippedRasters.add(e.file);
      continue;
    }
    const [px, py] = e.size;
    if (!(px > 0) || !(py > 0)) continue;
    const [ux, uy] = e.u, [vx, vy] = e.v;
    const x = e.ins[0] - ox, y = e.ins[1] - oy;
    const corners = [
      [x, y],
      [x + ux * px, y + uy * px],
      [x + ux * px + vx * py, y + uy * px + vy * py],
      [x + vx * py, y + vy * py],
    ];
    const ix0 = Math.min(...corners.map((c) => c[0])), ix1 = Math.max(...corners.map((c) => c[0]));
    const iy0 = Math.min(...corners.map((c) => c[1])), iy1 = Math.max(...corners.map((c) => c[1]));
    if (!intersects(rel, [ix0, iy0, ix1, iy1])) continue;
    const a = (ux * k).toFixed(4), b = (-uy * k).toFixed(4);
    const c = (-vx * k).toFixed(4), dd = (vy * k).toFixed(4);
    const ex = ((x + vx * py - rel[0]) * k).toFixed(2);
    const ey = ((rel[3] - y - vy * py) * k).toFixed(2);
    let clipAttr = "";
    if (e.clip && e.clip.length >= 2) {
      const p = e.clip.length === 2
        ? [[e.clip[0][0], e.clip[0][1]], [e.clip[1][0], e.clip[0][1]], [e.clip[1][0], e.clip[1][1]], [e.clip[0][0], e.clip[1][1]]]
        : e.clip;
      parts.push(`<clipPath id="raster-${ri}" clipPathUnits="userSpaceOnUse"><polygon points="${p.map(([cx, cy]) => `${cx},${cy}`).join(" ")}"/></clipPath>`);
      clipAttr = ` clip-path="url(#raster-${ri})"`;
    }
    parts.push(`<image x="0" y="0" width="${px}" height="${py}" preserveAspectRatio="none" opacity="${(1 - e.fade / 100).toFixed(2)}" transform="matrix(${a} ${b} ${c} ${dd} ${ex} ${ey})" href="${href}"${clipAttr}/>`);
  }
  if (skippedRasters.size) parts.push(`<desc>Rasters not embedded (missing, unsupported, or larger than ${RASTER_LIMIT / 1024 / 1024} MB): ${esc([...skippedRasters].join(", "))}</desc>`);
  for (const p of d.prims) {
    if (hidden.has(p[2])) continue;
    const ent = p[1];
    const col = hl.has(ent) ? "#ff3b30" : hex(p[3], !!o.dark);
    const sw = hl.has(ent) ? 2.5 : 1;
    switch (p[0]) {
      case "p": {
        const f = p[5];
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (let i = 0; i < f.length; i += 2) {
          bx0 = Math.min(bx0, f[i]); bx1 = Math.max(bx1, f[i]); by0 = Math.min(by0, f[i + 1]); by1 = Math.max(by1, f[i + 1]);
        }
        if (!intersects(rel, [bx0, by0, bx1, by1])) continue;
        let dstr = "";
        for (let i = 0; i < f.length; i += 2) dstr += (i ? "L" : "M") + X(f[i]) + " " + Y(f[i + 1]);
        if (p[4]) dstr += "Z";
        parts.push(`<path d="${dstr}" fill="none" stroke="${col}" stroke-width="${sw}"${dashArray(d, p[6], k)}/>`);
        break;
      }
      case "l": {
        const f = p[4];
        let dstr = "";
        for (let i = 0; i + 3 < f.length; i += 4) {
          if (!intersects(rel, [Math.min(f[i], f[i + 2]), Math.min(f[i + 1], f[i + 3]), Math.max(f[i], f[i + 2]), Math.max(f[i + 1], f[i + 3])])) continue;
          dstr += `M${X(f[i])} ${Y(f[i + 1])}L${X(f[i + 2])} ${Y(f[i + 3])}`;
        }
        if (dstr) parts.push(`<path d="${dstr}" fill="none" stroke="${col}" stroke-width="${sw}"/>`);
        break;
      }
      case "f": {
        const mode = p[4];
        if (mode === 3 && !hl.has(ent)) continue; // picking area: its pattern or picture is drawn separately
        const loops = p[5];
        let dstr = "";
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const f of loops) {
          for (let i = 0; i < f.length; i += 2) {
            bx0 = Math.min(bx0, f[i]); bx1 = Math.max(bx1, f[i]); by0 = Math.min(by0, f[i + 1]); by1 = Math.max(by1, f[i + 1]);
            dstr += (i ? "L" : "M") + X(f[i]) + " " + Y(f[i + 1]);
          }
          dstr += "Z";
        }
        if (!intersects(rel, [bx0, by0, bx1, by1])) continue;
        const opacity = mode === 0 ? 0.18 : mode === 3 ? 0.3 : 1;
        parts.push(`<path d="${dstr}" fill="${col}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ""} fill-rule="${mode === 2 ? "nonzero" : "evenodd"}" stroke="none"/>`);
        break;
      }
      case "c": {
        const [, , , , x, y, r, dash] = p;
        if (!intersects(rel, [x - r, y - r, x + r, y + r])) continue;
        parts.push(`<circle cx="${X(x)}" cy="${Y(y)}" r="${(r * k).toFixed(2)}" fill="none" stroke="${col}" stroke-width="${sw}"${dashArray(d, dash, k)}/>`);
        break;
      }
      case "a": {
        const [, , , , x, y, r, a0, a1, dash] = p;
        if (!intersects(rel, [x - r, y - r, x + r, y + r])) continue;
        let sweep = a1 - a0;
        while (sweep <= 0) sweep += 2 * Math.PI;
        const sx = x + r * Math.cos(a0), sy = y + r * Math.sin(a0), ex = x + r * Math.cos(a1), ey = y + r * Math.sin(a1);
        parts.push(`<path d="M${X(sx)} ${Y(sy)}A${(r * k).toFixed(2)} ${(r * k).toFixed(2)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${X(ex)} ${Y(ey)}" fill="none" stroke="${col}" stroke-width="${sw}"${dashArray(d, dash, k)}/>`);
        break;
      }
      case "d": {
        const [, , , , x, y] = p;
        if (x < rel[0] || x > rel[2] || y < rel[1] || y > rel[3]) continue;
        parts.push(`<circle cx="${X(x)}" cy="${Y(y)}" r="1" fill="${col}"/>`);
        break;
      }
      case "t": {
        const [, , , , x, y, h, rot, align, text, font, , width] = p;
        const px = h * k;
        if (px < 2 || x < rel[0] - width - h || x > rel[2] + width + h || y < rel[1] - width - h * 2 || y > rel[3] + width + h * 2) continue;
        const [family, style = ""] = font.split("|");
        const serif = family === "serif";
        const anchor = align[0] === "c" ? "middle" : align[0] === "r" ? "end" : "start";
        // h is the capital height (AutoCAD's text height); top and middle refer to it
        const dy = align[1] === "t" ? px : align[1] === "m" ? px / 2 : 0;
        const fit = width > 0 ? ` textLength="${(width * k).toFixed(2)}" lengthAdjust="spacingAndGlyphs"` : "";
        parts.push(
          `<text xml:space="preserve" x="${X(x)}" y="${Y(y)}" dy="${dy.toFixed(2)}" font-size="${(px * EM_PER_CAP[serif ? "serif" : "sans"]).toFixed(2)}"${serif ? ` font-family="${SERIF}"` : ""}${style.includes("b") ? ` font-weight="bold"` : ""}${style.includes("i") ? ` font-style="italic"` : ""} fill="${col}" text-anchor="${anchor}"${fit} transform="rotate(${((-rot * 180) / Math.PI).toFixed(2)} ${X(x)} ${Y(y)})">${esc(text)}</text>`,
        );
        break;
      }
    }
  }
  for (const f of o.findings ?? []) {
    if (!f.bbox) continue;
    const b = f.bbox;
    const c = f.severity === "error" ? "#ff3b30" : f.severity === "warning" ? "#ff9f0a" : "#0a84ff";
    parts.push(`<rect x="${X(b[0] - ox)}" y="${Y(b[3] - oy)}" width="${((b[2] - b[0]) * k).toFixed(2)}" height="${((b[3] - b[1]) * k).toFixed(2)}" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="6 4"/>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}
