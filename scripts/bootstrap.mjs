// Node is installed by setup.command / bootstrap.ps1 before this shared entry runs.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tools = path.join(root, '.tools');
const win = process.platform === 'win32';
const localOnly = process.argv.includes('--local-tools');
const executable = (name) => name + (win ? '.exe' : '');
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
// Windows may spell this key Path. Avoid passing two case variants to spawn.
for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
env.PATH = process.env.PATH ?? '';
function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '';
    if (capture) {
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
    }
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} ${args.join(' ')} failed (${code}). ${output.trim()}`)));
  });
}
function candidates(name, extra = []) {
  return [...new Set([...extra, ...(localOnly ? [] : (env.PATH ?? '').split(path.delimiter).map((p) => path.join(p, executable(name))))])].filter((p) => p && existsSync(p));
}
async function find(candidates, valid) {
  for (const command of candidates) {
    try { const result = await valid(command); if (result) return { command, ...result }; } catch { /* Try the next installed copy. */ }
  }
  return null;
}
const findDotnet = () => find(candidates('dotnet', [
  path.join(tools, 'dotnet', executable('dotnet')),
  !localOnly && env.DOTNET_ROOT && path.join(env.DOTNET_ROOT, executable('dotnet')),
  !localOnly && path.join(homedir(), '.dotnet', executable('dotnet')),
].filter(Boolean)), async (command) => {
  const sdks = await run(command, ['--list-sdks'], { capture: true });
  const runtimes = await run(command, ['--list-runtimes'], { capture: true });
  const match = sdks.match(/^8\.\S+\s+\[([^\]]+)\]/m);
  if (!match || !/^Microsoft\.NETCore\.App 8\./m.test(runtimes)) return null;
  return { root: path.dirname(match[1]) };
});
const findUv = () => find(candidates('uv', [path.join(tools, 'uv', executable('uv'))]), async (command) => {
  const version = await run(command, ['--version'], { capture: true });
  return /^uv \d+\./.test(version) ? { version } : null;
});
async function download(url, name) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const target = path.join(tools, name);
  writeFileSync(target, new Uint8Array(await response.arrayBuffer()));
  return target;
}
async function installDotnet() {
  const script = await download(`https://dot.net/v1/dotnet-install.${win ? 'ps1' : 'sh'}`, `dotnet-install.${win ? 'ps1' : 'sh'}`);
  const target = path.join(tools, 'dotnet');
  if (win) await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Channel', '8.0', '-InstallDir', target, '-NoPath', '-Architecture', process.arch]);
  else await run('bash', [script, '--channel', '8.0', '--install-dir', target, '--no-path', '--architecture', process.arch]);
}
async function installUv() {
  // Pin the same release as source CI; no shell-profile or persistent PATH edits.
  const script = await download(`https://astral.sh/uv/0.13.4/install.${win ? 'ps1' : 'sh'}`, `uv-install.${win ? 'ps1' : 'sh'}`);
  env.UV_INSTALL_DIR = path.join(tools, 'uv');
  env.UV_NO_MODIFY_PATH = '1';
  if (win) await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]);
  else await run('sh', [script]);
}
async function npm(args) {
  // npm.cmd is a batch file, not a directly spawnable Windows executable.
  // These arguments are fixed script names; no user input is interpolated into cmd.
  if (win) return run(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`]);
  return run('npm', args);
}

try {
  const check = process.argv.slice(2).includes('--check');
  const unknown = process.argv.slice(2).filter((a) => !['--check', '--local-tools'].includes(a));
  if (unknown.length) throw new Error(`Unknown setup option: ${unknown.join(' ')}`);
  if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch))
    throw new Error('Setup supports Windows, macOS and Linux on x64 or arm64.');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Run the platform Setup script to install Node 24+.');
  let dotnet = await findDotnet();
  let uv = await findUv();
  console.log(`Node ${process.versions.node}: ${process.execPath}`);
  console.log(`.NET 8 SDK + runtime: ${dotnet?.command ?? 'missing'}`);
  console.log(`uv: ${uv?.command ?? 'missing'}`);
  if (check) {
    if (!dotnet || !uv) process.exitCode = 1;
  } else {
    mkdirSync(tools, { recursive: true });
    if (!dotnet) { await installDotnet(); dotnet = await findDotnet(); }
    if (!uv) { await installUv(); uv = await findUv(); }
    if (!dotnet || !uv) throw new Error('A dependency still cannot run after installation. See docs/setup.md.');
    env.DOTNET_ROOT = dotnet.root;
    env.PATH = [path.dirname(process.execPath), path.dirname(dotnet.command), path.dirname(uv.command), env.PATH].join(path.delimiter);
    console.log('Installing project dependencies…');
    await npm(['ci']);
    console.log('Building the app, generating sample drawings, and running checks…');
    await npm(['run', 'setup']);
    // Only advertise a completed setup after every build and check succeeds.
    const target = path.join(tools, 'environment.json');
    const temp = target + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify({ node: process.execPath, dotnetRoot: dotnet.root, paths: [path.dirname(dotnet.command), path.dirname(uv.command)] }, null, 2) + '\n');
      writeFileSync(path.join(tools, 'node-path.txt'), process.execPath + '\n');
      renameSync(temp, target);
    } finally { rmSync(temp, { force: true }); }
    console.log(`\nReady. Next time, ${win ? 'double-click launch.cmd' : process.platform === 'darwin' ? 'double-click launch.command' : 'run bash launch.command'}.`);
  }
} catch (error) {
  console.error(`Setup failed: ${error.message}\nFix the reported issue and run Setup again.`);
  process.exitCode = 1;
}
