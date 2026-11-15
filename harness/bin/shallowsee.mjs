#!/usr/bin/env node
// ShallowSee Autopilot command line. See harness/engine/README.md and `node harness/bin/shallowsee.mjs --help`.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runCli } from './cli-lib.mjs';

let interrupts = 0;
const handlers = new Set();
process.on('SIGINT', () => {
  interrupts++;
  if (interrupts > 1 || handlers.size === 0) process.exit(130);   // a second Ctrl+C always exits
  for (const handler of handlers) handler();
});

const io = {
  out: text => process.stdout.write(text),
  err: text => process.stderr.write(text),
  onInterrupt: handler => handlers.add(handler),
  offInterrupt: handler => handlers.delete(handler),
  defaultDataDir: join(fileURLToPath(new URL('../../', import.meta.url)), 'data'),
};

process.exitCode = await runCli(process.argv.slice(2), io);
