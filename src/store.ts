// Opens drawings through the sidecar and caches payloads on disk (keyed by path, size and
// mtime) and the most recent few in memory.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Sidecar } from "./sidecar.ts";
import type { Drawing } from "./types.ts";

export const CACHE_DIR = process.env.OMAKASE_CADKIT_CACHE ?? process.env.DRAWKIT_CACHE ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "omakase-cadkit");
const PAYLOAD_SCHEMA = 6;

function readPayload(file: string): Drawing | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Drawing;
  } catch {
    return null;
  }
}

/** Expand a leading `~` the way a shell would; a quoted path reaches us with it intact. */
export function expandHome(file: string): string {
  if (file === "~") return homedir();
  if (file.startsWith("~/") || file.startsWith("~\\")) return path.join(homedir(), file.slice(2));
  return file;
}

export interface OpenResult {
  drawing: Drawing;
  payloadPath: string;
  cached: boolean;
  ms: number;
}

export class DrawingStore {
  readonly sidecar = new Sidecar();
  private memory = new Map<string, { key: string; drawing: Drawing; payloadPath: string }>();
  private inflight = new Map<string, Promise<OpenResult>>();
  private readonly maxInMemory: number;

  constructor(maxInMemory = 3) {
    this.maxInMemory = maxInMemory;
  }

  static resolve(file: string): string {
    const abs = path.resolve(expandHome(file));
    if (!existsSync(abs)) throw new Error(`no file at ${abs}`);
    const ext = path.extname(abs).toLowerCase();
    if (ext !== ".dwg" && ext !== ".dxf") throw new Error(`not a .dwg or .dxf file: ${abs}`);
    return realpathSync(abs);
  }

  private static key(real: string): string {
    const st = statSync(real);
    return `${real}\0${st.size}\0${Math.floor(st.mtimeMs)}`;
  }

  async open(file: string): Promise<OpenResult> {
    const real = DrawingStore.resolve(file);
    const key = DrawingStore.key(real);
    const mem = this.memory.get(real);
    if (mem && mem.key === key) {
      this.memory.delete(real);
      this.memory.set(real, mem); // refresh LRU position
      return { drawing: mem.drawing, payloadPath: mem.payloadPath, cached: true, ms: 0 };
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const job = this.load(real, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async load(real: string, key: string): Promise<OpenResult> {
    const t0 = Date.now();
    mkdirSync(CACHE_DIR, { recursive: true });
    const payloadPath = path.join(CACHE_DIR, createHash("sha1").update(key).digest("hex").slice(0, 20) + ".json");
    let cached = true;
    let drawing = existsSync(payloadPath) ? readPayload(payloadPath) : null;
    if (!drawing || drawing.schema !== PAYLOAD_SCHEMA) {
      cached = false;
      rmSync(payloadPath, { force: true });
      await this.sidecar.request("open", { path: real, out: payloadPath }, 300_000);
      const fresh = readPayload(payloadPath);
      if (!fresh) throw new Error(`sidecar wrote no payload for ${real}`);
      if (fresh.schema !== PAYLOAD_SCHEMA) throw new Error(`unsupported payload schema ${fresh.schema}`);
      drawing = fresh;
    }
    this.memory.set(real, { key, drawing, payloadPath });
    while (this.memory.size > this.maxInMemory) this.memory.delete(this.memory.keys().next().value!);
    return { drawing, payloadPath, cached, ms: Date.now() - t0 };
  }

  convert(input: string, out: string) {
    const real = DrawingStore.resolve(input);
    return this.sidecar.request("convert", { path: real, out: path.resolve(out) }, 300_000);
  }

  close() {
    this.sidecar.stop();
  }
}
