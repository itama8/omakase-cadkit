// Region -> SVG, for agents and reports: the same primitives the viewer draws.

import { intersects } from "./geometry.ts";
import type { Bbox, Drawing, Finding } from "./types.ts";

const hex = (rgb: number, dark: boolean) => {
  // ACI 7 / white and black flip to the ink colour of the background
  if (rgb === 0xffffff || rgb === 0) return dark ? "#e8e8e8" : "#111111";
  return "#" + rgb.toString(16).padStart(6, "0");
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

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
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Arial, Helvetica, sans-serif">`);
  parts.push(`<rect width="100%" height="100%" fill="${bg}"/>`);
  const hl = o.highlight ?? new Set<number>();
  const hidden = o.hiddenLayers ?? new Set<number>();
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
        parts.push(`<path d="${dstr}" fill="none" stroke="${col}" stroke-width="${sw}"/>`);
        break;
      }
      case "f": {
        const loops = p[5];
        let dstr = "", any = false;
        for (const f of loops) {
          for (let i = 0; i < f.length; i += 2) {
            if (f[i] >= rel[0] && f[i] <= rel[2] && f[i + 1] >= rel[1] && f[i + 1] <= rel[3]) any = true;
            dstr += (i ? "L" : "M") + X(f[i]) + " " + Y(f[i + 1]);
          }
          dstr += "Z";
        }
        if (!any) continue;
        parts.push(`<path d="${dstr}" fill="${col}" fill-opacity="${p[4] ? 0.85 : 0.18}" fill-rule="evenodd" stroke="none"/>`);
        break;
      }
      case "c": {
        const [, , , , x, y, r] = p;
        if (!intersects(rel, [x - r, y - r, x + r, y + r])) continue;
        parts.push(`<circle cx="${X(x)}" cy="${Y(y)}" r="${(r * k).toFixed(2)}" fill="none" stroke="${col}" stroke-width="${sw}"/>`);
        break;
      }
      case "a": {
        const [, , , , x, y, r, a0, a1] = p;
        if (!intersects(rel, [x - r, y - r, x + r, y + r])) continue;
        let sweep = a1 - a0;
        while (sweep <= 0) sweep += 2 * Math.PI;
        const sx = x + r * Math.cos(a0), sy = y + r * Math.sin(a0), ex = x + r * Math.cos(a1), ey = y + r * Math.sin(a1);
        parts.push(`<path d="M${X(sx)} ${Y(sy)}A${(r * k).toFixed(2)} ${(r * k).toFixed(2)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${X(ex)} ${Y(ey)}" fill="none" stroke="${col}" stroke-width="${sw}"/>`);
        break;
      }
      case "d": {
        const [, , , , x, y] = p;
        if (x < rel[0] || x > rel[2] || y < rel[1] || y > rel[3]) continue;
        parts.push(`<circle cx="${X(x)}" cy="${Y(y)}" r="1" fill="${col}"/>`);
        break;
      }
      case "t": {
        const [, , , , x, y, h, rot, align, text] = p;
        const px = h * k;
        if (px < 2 || x < rel[0] - h * text.length || x > rel[2] + h || y < rel[1] - h * 2 || y > rel[3] + h * 2) continue;
        const anchor = align[0] === "c" ? "middle" : align[0] === "r" ? "end" : "start";
        const base = align[1] === "t" ? "hanging" : align[1] === "m" ? "middle" : "alphabetic";
        parts.push(
          `<text x="${X(x)}" y="${Y(y)}" font-size="${px.toFixed(2)}" fill="${col}" text-anchor="${anchor}" dominant-baseline="${base}" transform="rotate(${((-rot * 180) / Math.PI).toFixed(2)} ${X(x)} ${Y(y)})">${esc(text)}</text>`,
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
