// Supervises the ACadSharp sidecar: started on first use, one JSON line per request,
// a deadline per request, and a fresh process after a crash or timeout.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function sidecarCommand(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const dir = process.env.OMAKASE_CADKIT_SIDECAR_DIR ?? process.env.DRAWKIT_SIDECAR_DIR ?? path.join(ROOT, "bin", "sidecar");
  const exeName = process.platform === "win32" ? "omakase-cadkit-sidecar.exe" : "omakase-cadkit-sidecar";
  const dotnetName = process.platform === "win32" ? "dotnet.exe" : "dotnet";
  const exe = path.join(dir, exeName);
  const dll = path.join(dir, "omakase-cadkit-sidecar.dll");
  const env: NodeJS.ProcessEnv = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" };
  const dotnetRoot = process.env.DOTNET_ROOT ?? path.join(homedir(), ".dotnet");
  if (existsSync(dotnetRoot)) env.DOTNET_ROOT = dotnetRoot;
  if (existsSync(exe)) return { cmd: exe, args: [], env };
  if (existsSync(dll)) {
    const local = path.join(dotnetRoot, dotnetName);
    return { cmd: existsSync(local) ? local : dotnetName, args: [dll], env };
  }
  throw new Error(`omakase-cadkit sidecar is not built: run \`npm run build:sidecar\` (looked in ${dir})`);
}

/**
 * Changes whenever the running code would: the newest mtime among this package's modules and
 * the sidecar build. A long-lived viewer server compares it with a fresh CLI to know it is stale.
 */
export function buildStamp(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let newest = 0;
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (/\.(js|ts)$/.test(d.name)) newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  walk(here);
  const dir = process.env.OMAKASE_CADKIT_SIDECAR_DIR ?? process.env.DRAWKIT_SIDECAR_DIR ?? path.join(ROOT, "bin", "sidecar");
  const dll = path.join(dir, "omakase-cadkit-sidecar.dll");
  if (existsSync(dll)) newest = Math.max(newest, statSync(dll).mtimeMs);
  return String(Math.floor(newest));
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class Sidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private stderrTail = "";

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const { cmd, args, env } = sidecarCommand();
    const proc = spawn(cmd, [...args, "serve"], { env, stdio: ["pipe", "pipe", "pipe"] });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    proc.on("exit", (code, signal) => {
      this.proc = null;
      const err = new Error(`sidecar exited (${signal ?? code})${this.stderrTail ? ": " + this.stderrTail.trim() : ""}`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });
    proc.on("error", (err) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.proc = null;
    });
    // Keep the parent free to exit when only the sidecar is left.
    proc.unref();
    (proc.stdin as any).unref?.();
    (proc.stdout as any).unref?.();
    (proc.stderr as any).unref?.();
    this.proc = proc;
    return proc;
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    }
  }

  /** True while a worker process exists. A stopped or crashed sidecar is false. */
  get alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  request<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    const proc = this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar ${method} timed out after ${timeoutMs} ms`));
        // A stuck parse holds the only worker; replace the process.
        this.stop();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
  }
}
