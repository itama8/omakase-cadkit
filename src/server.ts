// Local viewer server, loopback only. Mirrors the Omakase split: this process owns files and
// the sidecar; the browser gets bounded JSON.

import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { loadConfig, saveUnits } from "./config.ts";
import { lintContext, makeContext, RULES } from "./lint/engine.ts";
import { sewerNetwork } from "./lint/sewer.ts";
import { buildStamp } from "./sidecar.ts";
import { CACHE_DIR, DrawingStore, expandHome } from "./store.ts";
import { resolveUnits } from "./sheet.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIEWER = path.join(ROOT, "viewer");
const RECENT = path.join(CACHE_DIR, "recent.json");

function json(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage) {
  const data = JSON.stringify(body);
  const gz = req?.headers["accept-encoding"]?.includes("gzip") && data.length > 4096;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(gz ? { "content-encoding": "gzip" } : {}) });
  if (gz) {
    const z = createGzip();
    z.pipe(res);
    z.end(data);
  } else res.end(data);
}

function recent(): string[] {
  try {
    return JSON.parse(readFileSync(RECENT, "utf8"));
  } catch {
    return [];
  }
}
function pushRecent(file: string) {
  const list = [file, ...recent().filter((f) => f !== file)].slice(0, 20);
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(RECENT, JSON.stringify(list));
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json", ".woff2": "font/woff2" };
const RASTER_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const RASTER_LIMIT = 64 * 1024 * 1024;

function resolveRaster(drawing: string, ref: string) {
  const dir = path.dirname(drawing);
  const normalized = ref.replace(/\\/g, "/");
  const base = path.basename(normalized);
  for (const candidate of [normalized, path.resolve(dir, normalized), path.join(dir, base)]) {
    const abs = path.resolve(candidate);
    const type = RASTER_TYPES[path.extname(abs).toLowerCase()];
    if (!type || !existsSync(abs)) continue;
    const stat = statSync(abs);
    if (stat.isFile() && stat.size <= RASTER_LIMIT) return { abs, type, size: stat.size };
  }
  return null;
}

const BUILD = buildStamp();
const fileParam = (url: URL) => {
  const f = url.searchParams.get("file");
  return f ? expandHome(f) : null;
};

export function startServer(port = 4280, host = "127.0.0.1") {
  const store = new DrawingStore(4);
  const ctxCache = new Map<string, { key: unknown; config: string; ctx: ReturnType<typeof makeContext> }>();

  async function ctxFor(file: string) {
    const { drawing } = await store.open(file);
    const cfg = loadConfig(file);
    const config = JSON.stringify(cfg);
    const hit = ctxCache.get(file);
    if (hit && hit.key === drawing && hit.config === config) return hit.ctx;
    const ctx = makeContext(path.resolve(file), drawing, cfg);
    ctxCache.set(file, { key: drawing, config, ctx });
    return ctx;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    try {
      if (url.pathname === "/api/health") return json(res, 200, { ok: true, app: "omakase-cadkit", build: BUILD, pid: process.pid });
      if (url.pathname === "/api/properties") {
        const file = fileParam(url);
        if (!file) return json(res, 400, { error: "file is required" });
        if (req.method === "POST") {
          // Only our own browser UI may write local profiles.
          if (req.headers.origin !== `http://${req.headers.host}` || req.headers["content-type"] !== "application/json")
            return json(res, 403, { error: "Properties must be saved from this viewer." });
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 1024) return json(res, 413, { error: "Properties request too large." });
          }
          let units: unknown;
          try { units = JSON.parse(body).units; } catch { return json(res, 400, { error: "Invalid properties JSON." }); }
          if (units !== null && !["mm", "cm", "m", "in", "ft"].includes(units as string))
            return json(res, 400, { error: "Invalid drawing units." });
          await store.open(file); // Validate the drawing before creating a profile.
          saveUnits(file, units);
        } else if (req.method !== "GET") return json(res, 405, { error: "Use GET or POST." });
        const ctx = await ctxFor(file);
        return json(res, 200, {
          units: ctx.sheet.units, override: ctx.cfg.units ?? null,
          automaticUnits: resolveUnits(ctx.drawing, { ...ctx.cfg, units: undefined }, ctx.sheet.extents),
          folder: path.dirname(path.resolve(file)),
        });
      }
      if (url.pathname === "/api/drawing") {
        const file = fileParam(url);
        if (!file) return json(res, 400, { error: "file is required" });
        const r = await store.open(file);
        pushRecent(DrawingStore.resolve(file));
        // Lets the viewer tell whether the file changed since it last saved view settings for it.
        const st = statSync(DrawingStore.resolve(file));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-encoding": "gzip", "x-omakase-cadkit-ms": String(r.ms), "x-omakase-cadkit-cached": String(r.cached), "x-omakase-cadkit-file-version": `${st.size}-${Math.floor(st.mtimeMs)}` });
        createReadStream(r.payloadPath).pipe(createGzip({ level: 4 })).pipe(res);
        return;
      }
      if (url.pathname === "/api/raster") {
        const file = fileParam(url);
        const handle = url.searchParams.get("handle");
        if (!file || !handle) return json(res, 400, { error: "file and handle are required" });
        const real = DrawingStore.resolve(file);
        const { drawing } = await store.open(real);
        const placed = drawing.rasters.find((r) => r.h.toUpperCase() === handle.toUpperCase());
        if (!placed) return json(res, 404, { error: "no raster on that entity" });
        const raster = resolveRaster(real, placed.file);
        if (!raster) return json(res, 404, { error: `raster ${placed.file} is missing or not a supported image` });
        res.writeHead(200, { "content-type": raster.type, "content-length": String(raster.size), "cache-control": "no-store" });
        createReadStream(raster.abs).pipe(res);
        return;
      }
      if (url.pathname === "/api/lint") {
        const file = fileParam(url);
        if (!file) return json(res, 400, { error: "file is required" });
        const ctx = await ctxFor(file);
        const packs = url.searchParams.get("packs")?.split(",").filter(Boolean);
        const result = lintContext(ctx, { packs });
        const rules = RULES.map((r) => ({ id: r.id, pack: r.pack, title: r.title, why: r.why }));
        return json(res, 200, { ...result, profile: ctx.cfg.source ?? null, availablePacks: [...new Set(RULES.map((r) => r.pack))], rules }, req);
      }
      if (url.pathname === "/api/network") {
        const file = fileParam(url);
        if (!file) return json(res, 400, { error: "file is required" });
        const ctx = await ctxFor(file);
        const n = sewerNetwork(ctx);
        return json(res, 200, n ?? { manholes: [], pipes: [] }, req);
      }
      if (url.pathname === "/api/recent") return json(res, 200, recent().filter((f) => existsSync(f)));
      if (url.pathname === "/api/files") {
        const dir = path.resolve(expandHome(url.searchParams.get("dir") || "~"));
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((d) => !d.name.startsWith("."))
          .map((d) => {
            const full = path.join(dir, d.name);
            const isDir = d.isDirectory();
            if (!isDir && !/\.(dwg|dxf)$/i.test(d.name)) return null;
            let size = 0;
            try {
              size = isDir ? 0 : statSync(full).size;
            } catch {}
            return { name: d.name, path: full, dir: isDir, size };
          })
          .filter(Boolean)
          .sort((a: any, b: any) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
        return json(res, 200, { dir, parent: path.dirname(dir), entries });
      }
      // static viewer
      let rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (rel === "viewer.js" || rel === "viewer.js.map") rel = "dist/" + rel;
      const full = path.join(VIEWER, rel);
      if (!full.startsWith(VIEWER) || !existsSync(full) || statSync(full).isDirectory()) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": TYPES[path.extname(full)] ?? "application/octet-stream", "cache-control": "no-store" });
      createReadStream(full).pipe(res);
    } catch (err: any) {
      json(res, 500, { error: String(err?.message ?? err) });
    }
  });
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`omakase-cadkit viewer on http://${host}:${typeof address === "object" && address ? address.port : port}/`);
  });
  const shutdown = () => {
    store.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf("--port");
  startServer(i > 0 ? Number(process.argv[i + 1]) : 4280);
}
