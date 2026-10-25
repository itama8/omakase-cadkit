// Keep the exact tool paths discovered by Setup, even in a fresh terminal.
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const config = path.join(root, '.tools', 'environment.json');
try {
  if (!existsSync(config)) throw new Error('Run Setup first.');
  const saved = JSON.parse(readFileSync(config, 'utf8'));
  if (!existsSync(saved.node)) throw new Error('The saved Node installation moved. Run Setup again.');
  const cli = path.join(root, 'bin', 'omakase-cadkit.mjs');
  const args = process.argv.slice(2);
  // Double-click launches have no terminal; explicitly request the browser.
  if (!args.includes('--no-open')) args.push('--open');
  const env = { ...process.env, DOTNET_ROOT: saved.dotnetRoot };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = [path.dirname(saved.node), ...saved.paths, process.env.PATH].join(path.delimiter);
  const child = spawn(saved.node, [cli, ...args], {
    cwd: root, stdio: 'inherit',
    env,
  });
  child.once('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code) => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(`Launch failed: ${error.message}`);
  process.exitCode = 1;
}
