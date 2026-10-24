#!/usr/bin/env node
// Node runs the TypeScript sources directly (type stripping, Node >= 23.6).
import { main } from "../src/cli.ts";

main(process.argv.slice(2)).then(
  // Set the exit code instead of calling process.exit(), which drops piped stdout that has
  // not been flushed yet. The sidecar handle is unref'd, so Node exits once output drains.
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`drawkit: ${err?.message ?? err}\n`);
    process.exitCode = 2;
  },
);
