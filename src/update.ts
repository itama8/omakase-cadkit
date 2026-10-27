// Finds a newer release on GitHub and, for the Windows installer, downloads it, checks its
// SHA-256 against the one GitHub publishes, and runs it. The installer stops this server,
// replaces the app and starts it again; the open viewer tab reloads itself.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASES_API = "https://api.github.com/repos/itama8/omakase-cadkit/releases?per_page=20";

/** How this copy was installed: only an installed Windows app can update itself. */
export type InstallKind = "windows-installer" | "download" | "source";

export function installKind(root = ROOT): InstallKind {
  if (existsSync(path.join(root, ".git")) || existsSync(path.join(root, "src", "cli.ts"))) return "source";
  if (process.platform === "win32" && existsSync(path.join(root, "unins000.exe"))) return "windows-installer";
  return "download";
}

export function currentVersion(root = ROOT): string {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
}

const VERSION = /^v?(\d+\.\d+\.\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Semver order, prerelease included: 0.1.0-alpha.2 < 0.1.0-alpha.10 < 0.1.0-beta.1 < 0.1.0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const match = v.match(VERSION);
    if (!match) throw new Error(`Invalid version: ${v}`);
    const [, core, pre] = match;
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

interface Asset { name: string; browser_download_url: string; size: number; digest?: string | null }
interface Release { tag_name: string; draft: boolean; html_url: string; body?: string | null; assets: Asset[] }

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  /** Release page, for downloads that cannot install themselves. */
  page: string;
  /** Windows installer of the newer release, when this copy can install it. */
  installer?: { name: string; url: string; size: number; sha256: string };
}

/** Picks the newest published release and, when it is newer, the asset for this computer. */
export function pickUpdate(releases: Release[], current: string, kind: InstallKind, platform = process.platform, arch = process.arch): UpdateInfo {
  const newest = releases
    .filter((r) => !r.draft && VERSION.test(r.tag_name) && (current.split("+")[0].includes("-") || !r.tag_name.split("+")[0].includes("-")))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
  const latest = newest ? newest.tag_name.replace(/^v/, "") : current;
  const info: UpdateInfo = { current, latest, available: !!newest && compareVersions(latest, current) > 0, page: newest?.html_url ?? "https://github.com/itama8/omakase-cadkit/releases" };
  if (!info.available || kind !== "windows-installer") return info;
  const asset = newest!.assets.find((a) => a.name === `omakase-cadkit-${latest}-${platform}-${arch}-setup.exe`);
  const sha256 = asset?.digest && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.slice(7).toLowerCase() : null;
  // Without a published hash there is nothing to check the download against: link only.
  if (asset && sha256) info.installer = { name: asset.name, url: asset.browser_download_url, size: asset.size, sha256 };
  return info;
}

export async function checkForUpdate(fetcher: typeof fetch = fetch, kind = installKind(), current = currentVersion()): Promise<UpdateInfo> {
  const res = await fetcher(RELEASES_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": `omakase-cadkit/${current}`, "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the release list`);
  return pickUpdate((await res.json()) as Release[], current, kind);
}

/** Downloads the installer to a temporary folder and returns its path once the hash matches. */
export async function downloadInstaller(installer: NonNullable<UpdateInfo["installer"]>, fetcher: typeof fetch = fetch, parent = tmpdir()): Promise<string> {
  const dir = mkdtempSync(path.join(parent, "omakase-cadkit-update-"));
  const file = path.join(dir, path.basename(installer.name));
  try {
    const res = await fetcher(installer.url, { signal: AbortSignal.timeout(600_000) });
    if (!res.ok || !res.body) throw new Error(`download failed (${res.status})`);
    const hash = createHash("sha256");
    let size = 0;
    const inspect = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        hash.update(chunk);
        done(size > installer.size ? new Error("Installer exceeds its published size") : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as any), inspect, createWriteStream(file, { flags: "wx" }));
    if (size !== installer.size || hash.digest("hex") !== installer.sha256) {
      throw new Error("The downloaded installer does not match its published size or SHA-256; nothing was installed");
    }
    return file;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Starts the installer on its own, with a progress window and no questions. It stops this
 * server before replacing files, then starts the app again without opening a new tab.
 */
export async function runInstaller(file: string, port = 4280): Promise<void> {
  // Preserve a custom installation folder rather than installing a second copy elsewhere.
  const child = spawn(file, ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/RELAUNCH=1", `/VIEWERPORT=${port}`, `/DIR=${ROOT}`], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => child.unref());
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Installer exited ${code}; restart the app or download the update manually`)));
  });
}
