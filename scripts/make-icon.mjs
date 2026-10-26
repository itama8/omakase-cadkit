// Draws the app icon: Omakase's 任 tile in black and blue, set up as a CAD drawing (grid, centre lines, a
// hatched section with a crisp outline, dimensions, grips and a crosshair). Writes the SVGs,
// a 1024 px PNG, the Windows .ico and the viewer favicon. Needs rsvg-convert and ImageMagick
// (magick); the outputs are committed, so builds and CI do not need either.
//   node scripts/make-icon.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "assets");

// 任 from Noto Sans JP Medium (SIL OFL 1.1, licenses/Noto-Sans-JP-OFL.txt): font units, y up,
// 1000 per em, bounds x 18..962, y -83..843. Kept as an outline so no font is needed.
const GLYPH = "M859 824 929 744Q872 725 804.5 709.0Q737 693 663.5 679.0Q590 665 515.0 654.0Q440 643 370 635Q367 653 358.0 676.5Q349 700 342 716Q410 725 482.0 736.5Q554 748 622.5 762.0Q691 776 751.5 792.0Q812 808 859 824ZM310 421H962V329H310ZM350 43H948V-47H350ZM597 697H693V16H597ZM178 567 270 660 271 659V-83H178ZM282 843 375 813Q340 726 292.0 640.0Q244 554 189.0 479.0Q134 404 75 346Q70 357 60.0 375.5Q50 394 38.5 413.0Q27 432 18 443Q71 491 120.0 555.0Q169 619 211.0 692.5Q253 766 282 843Z";
const B = { x0: 18, y0: -83, x1: 962, y1: 843 };

const LINE = "#6f8fc2"; // dim blue linework, in place of Omakase's gold
const GRIP = "#5b9dff"; // the viewer's accent; AutoCAD draws unselected grips blue
const f = (n) => Number(n.toFixed(1));

// Omakase's tile, recoloured black and blue.
const shell = `  <defs>
    <radialGradient id="surface" cx="43%" cy="30%" r="82%">
      <stop offset="0" stop-color="#1a1e25"/>
      <stop offset="0.48" stop-color="#101216"/>
      <stop offset="1" stop-color="#090909"/>
    </radialGradient>
    <radialGradient id="aura" cx="50%" cy="48%" r="50%">
      <stop offset="0" stop-color="${LINE}" stop-opacity="0.13"/>
      <stop offset="0.48" stop-color="${LINE}" stop-opacity="0.045"/>
      <stop offset="1" stop-color="${LINE}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4c5f80" stop-opacity="0.52"/>
      <stop offset="0.42" stop-color="#29334a" stop-opacity="0.26"/>
      <stop offset="1" stop-color="#090909" stop-opacity="0.76"/>
    </linearGradient>
    <clipPath id="tile"><rect x="44" y="42" width="936" height="936" rx="224"/></clipPath>
DEFS  </defs>
  <rect x="44" y="54" width="936" height="936" rx="224" fill="#000000" opacity="0.42"/>
  <rect x="44" y="42" width="936" height="936" rx="224" fill="url(#surface)"/>
  <rect x="45.5" y="43.5" width="933" height="933" rx="222.5" fill="none" stroke="url(#edge)" stroke-width="3"/>
  <ellipse cx="512" cy="500" rx="346" ry="360" fill="url(#aura)"/>
`;

function full() {
  const s = 0.5, cx = 512, cy = 492;
  const tx = cx - ((B.x0 + B.x1) / 2) * s, ty = cy + ((B.y0 + B.y1) / 2) * s;
  const X = (x) => f(tx + x * s), Y = (y) => f(ty - y * s);
  const L = X(B.x0), R = X(B.x1), T = Y(B.y1), Bo = Y(B.y0);
  const glyph = `<path d="${GLYPH}" transform="translate(${f(tx)} ${f(ty)}) scale(${s} ${-s})"/>`;

  const grid = [];
  for (let v = 64; v < 1024; v += 32) {
    const major = v % 128 === 0;
    grid.push(`<path d="M${v} 0V1024M0 ${v}H1024" stroke-opacity="${major ? 0.085 : 0.04}"/>`);
  }
  // Architectural dimension: extension lines, 45° ticks, value in font units.
  const tick = (x, y) => `M${f(x - 11)} ${f(y + 11)}L${f(x + 11)} ${f(y - 11)}`;
  const dimY = Bo + 70, dimX = L - 64;
  const dims = `
    <path d="M${L} ${Bo + 18}V${dimY + 18}M${R} ${Bo + 18}V${dimY + 18}M${L - 18} ${dimY}H${R + 18}${tick(L, dimY)}${tick(R, dimY)}"/>
    <path d="M${L - 18} ${T}H${dimX - 18}M${L - 18} ${Bo}H${dimX - 18}M${dimX} ${T - 18}V${Bo + 18}${tick(dimX, T)}${tick(dimX, Bo)}"/>`;
  const label = (x, y, text, rotate = 0) =>
    `<text x="${f(x)}" y="${f(y)}"${rotate ? ` transform="rotate(${rotate} ${f(x)} ${f(y)})"` : ""}>${text}</text>`;

  // Grips on real outline vertices; the crosshair holds the hot one.
  const grips = [[859, 824], [962, 329], [178, -83], [18, 443], [948, -47]];
  const [hx, hy] = [X(929), Y(744)];
  const g = 26;
  const gripRects = grips.map(([x, y]) => `<rect x="${f(X(x) - g / 2)}" y="${f(Y(y) - g / 2)}" width="${g}" height="${g}"/>`).join("");

  return shell.replace("DEFS", `    <clipPath id="glyph">${glyph}</clipPath>
    <pattern id="ansi31" width="22" height="22" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <path d="M0 0V22" stroke="${LINE}" stroke-width="3"/>
    </pattern>
`) + `  <g clip-path="url(#tile)" fill="none" stroke="${LINE}" stroke-width="2">${grid.join("")}</g>
  <g fill="none" stroke="${LINE}" stroke-opacity="0.4" stroke-width="3" stroke-dasharray="56 12 10 12">
    <path d="M${f(L - 110)} ${cy}H${f(R + 110)}M${cx} ${f(T - 96)}V${f(Bo + 40)}"/>
  </g>
  <g clip-path="url(#glyph)">
    <rect x="0" y="0" width="1024" height="1024" fill="${LINE}" fill-opacity="0.1"/>
    <rect x="0" y="0" width="1024" height="1024" fill="url(#ansi31)" opacity="0.45"/>
  </g>
  <g fill="none" stroke="${LINE}" stroke-width="7" stroke-linejoin="miter">${glyph}</g>
  <g fill="none" stroke="${LINE}" stroke-opacity="0.7" stroke-width="3">${dims}
  </g>
  <g fill="${LINE}" fill-opacity="0.8" font-family="DejaVu Sans Mono, Menlo, Consolas, monospace" font-size="34" text-anchor="middle">
    ${label((L + R) / 2, dimY - 14, String(B.x1 - B.x0))}
    ${label(dimX - 14, (T + Bo) / 2, String(B.y1 - B.y0), -90)}
  </g>
  <g fill="${GRIP}" stroke="#08111f" stroke-width="3">${gripRects}</g>
  <g fill="none" stroke="#dbe6f7" stroke-width="3">
    <path d="M${hx - 92} ${hy}H${hx - 18}M${hx + 18} ${hy}H${hx + 92}M${hx} ${hy - 92}V${hy - 18}M${hx} ${hy + 18}V${hy + 92}"/>
    <rect x="${hx - 15}" y="${hy - 15}" width="30" height="30"/>
  </g>
</svg>
`;
}

// 16-64 px: tile, a solid glyph with one centre line and one grip, still legible.
function small() {
  const s = 0.62, cx = 512, cy = 506;
  const tx = cx - ((B.x0 + B.x1) / 2) * s, ty = cy + ((B.y0 + B.y1) / 2) * s;
  return shell.replace("DEFS", "") + `  <g clip-path="url(#tile)" fill="none" stroke="${LINE}" stroke-opacity="0.12" stroke-width="16">
    <path d="M128 0V1024M384 0V1024M640 0V1024M896 0V1024M0 128H1024M0 384H1024M0 640H1024M0 896H1024"/>
  </g>
  <path d="${GLYPH}" transform="translate(${f(tx)} ${f(ty)}) scale(${s} ${-s})" fill="${LINE}"/>
  <rect x="${f(tx + 929 * s - 44)}" y="${f(ty - 744 * s - 44)}" width="88" height="88" fill="${GRIP}" stroke="#08111f" stroke-width="10"/>
</svg>
`;
}

const head = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="omakase-cadkit icon">
`;
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})`);
};

mkdirSync(out, { recursive: true });
const fullSvg = path.join(out, "icon.svg"), smallSvg = path.join(out, "icon-small.svg");
writeFileSync(fullSvg, head + full());
writeFileSync(smallSvg, head + small());
writeFileSync(path.join(root, "viewer", "favicon.svg"), head + small());

const tmp = mkdtempSync(path.join(tmpdir(), "cadkit-icon-"));
try {
  run("rsvg-convert", ["-w", "1024", "-h", "1024", "-o", path.join(out, "icon.png"), fullSvg]);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  for (const size of sizes)
    run("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", path.join(tmp, `${size}.png`), size <= 64 ? smallSvg : fullSvg]);
  run("magick", [...sizes.map((size) => path.join(tmp, `${size}.png`)), path.join(out, "omakase-cadkit.ico")]);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("wrote assets/icon.svg, assets/icon-small.svg, assets/icon.png, assets/omakase-cadkit.ico, viewer/favicon.svg");
