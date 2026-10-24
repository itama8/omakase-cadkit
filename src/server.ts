// Local viewer server, loopback only. Mirrors the Omakase split: this process owns files and
// the sidecar; the browser gets bounded JSON.

import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { loadConfig } from "./config.ts";
import { lintContext, makeContext, RULES } from "./lint/engine.ts";
import { sewerNetwork } from "./lint/sewer.ts";
import { CACHE_DIR, DrawingStore } from "./store.ts";

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

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json" };

export function startServer(port = 4280, host = "127.0.0.1") {
  const store = new DrawingStore(4);
  const ctxCache = new Map<string, { key: unknown; ctx: ReturnType<typeof makeContext> }>();

  async function ctxFor(file: string) {
    const { drawing } = await store.open(file);
    const hit = ctxCache.get(file);
    if (hit && hit.key === drawing) return hit.ctx;
    const ctx = makeContext(path.resolve(file), drawing, loadConfig(file));
    ctxCache.set(file, { key: drawing, ctx });
    return ctx;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    try {
      if (url.pathname === "/api/health") return json(res, 200, { ok: true });
      if (url.pathname === "/api/drawing") {
        const file = url.searchParams.get("file");
        if (!file) return json(res, 400, { error: "file is required" });
        const r = await store.open(file);
        pushRecent(DrawingStore.resolve(file));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "content-encoding": "gzip", "x-drawkit-ms": String(r.ms), "x-drawkit-cached": String(r.cached) });
        createReadStream(r.payloadPath).pipe(createGzip({ level: 4 })).pipe(res);
        return;
      }
      if (url.pathname === "/api/lint") {
        const file = url.searchParams.get("file");
        if (!file) return json(res, 400, { error: "file is required" });
        const ctx = await ctxFor(file);
        const packs = url.searchParams.get("packs")?.split(",").filter(Boolean);
        const result = lintContext(ctx, { packs });
        const rules = RULES.map((r) => ({ id: r.id, pack: r.pack, title: r.title, why: r.why }));
        return json(res, 200, { ...result, profile: ctx.cfg.source ?? null, availablePacks: [...new Set(RULES.map((r) => r.pack))], rules }, req);
      }
      if (url.pathname === "/api/network") {
        const file = url.searchParams.get("file");
        if (!file) return json(res, 400, { error: "file is required" });
        const ctx = await ctxFor(file);
        const n = sewerNetwork(ctx);
        return json(res, 200, n ?? { manholes: [], pipes: [] }, req);
      }
      if (url.pathname === "/api/recent") return json(res, 200, recent().filter((f) => existsSync(f)));
      if (url.pathname === "/api/files") {
        const dir = path.resolve(url.searchParams.get("dir") || process.env.HOME || "/");
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
    console.log(`drawkit viewer on http://${host}:${port}/`);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--port");
  startServer(i > 0 ? Number(process.argv[i + 1]) : 4280);
}
