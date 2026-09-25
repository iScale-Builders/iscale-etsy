#!/usr/bin/env node
import { runWorkerCli } from "../src/core/worker-cli.js";

const code = await runWorkerCli(process.argv.slice(2), process.env, globalThis.fetch, {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});
process.exit(code);
