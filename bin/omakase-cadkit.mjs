#!/usr/bin/env node
// Runs the compiled CLI from dist/, which `npm run build` (and `npm run setup`) creates.
import { existsSync } from "node:fs";

const cli = new URL("../dist/cli.js", import.meta.url);
if (!existsSync(cli)) {
  process.stderr.write("omakase-cadkit: not built (dist/cli.js missing). Run `npm run build` in the package.\n");
  process.exit(2);
}
const { main } = await import(cli.href);

main(process.argv.slice(2)).then(
  // Set the exit code instead of calling process.exit(), which drops piped stdout that has
  // not been flushed yet. The sidecar handle is unref'd, so Node exits once output drains.
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`omakase-cadkit: ${err?.message ?? err}\n`);
    process.exitCode = 2;
  },
);
