import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createEventLog } from '../event-log/index.mjs';
import { createHarness } from './index.mjs';
import { runCodingAgent } from './coding-agent.mjs';

// This demonstration uses fixed simulated decisions. It performs no model or
// search request; all generated project files stay under data/harness-demo.
const id = 'demo_' + randomUUID();
const projectDir = resolve('data/harness-demo', id);
await mkdir(projectDir, { recursive: true });
const writer = await createEventLog({ rootDir: resolve('data/rooms'), roomId: id });
try {
  const harness = createHarness({ writer });
  await harness.start('Build a hello world program', { synthetic: true });
  const plan = await harness.proposePlan('Build a Node.js program that prints Hello, world!');
  await harness.recordResearch({ planDigest: plan.digest, assessment: 'current_supported', sources: [{ url: 'https://example.org/synthetic-source', retrievedAt: new Date().toISOString() }] });
  await harness.confirmPlan(plan.digest);
  let turn = 0;
  const tools = {
    'write-code': async ({ content }) => { await writeFile(join(projectDir, 'app.mjs'), content); return 'Wrote app.mjs'; },
    'read-file': async () => readFile(join(projectDir, 'app.mjs'), 'utf8'),
    'run-tests': async () => {
      const output = execFileSync(process.execPath, [join(projectDir, 'app.mjs')], { encoding: 'utf8', timeout: 5000 });
      if (output.trim() !== 'Hello, world!') throw new Error('Unexpected output');
      return 'Output matches Hello, world!';
    },
  };
  const model = async () => [
    { type: 'tool', name: 'write-code', arguments: { content: "console.log('Hello, world!');\n" } },
    { type: 'tool', name: 'run-tests', arguments: {} },
    { type: 'final', content: 'Created app.mjs and ran the demo check.' },
  ][turn++];
  const run = await runCodingAgent({ model, tools, task: plan.text });
  if (run.status !== 'completed') throw new Error('Coding agent did not finish');
  await harness.submitCode(join(projectDir, 'app.mjs'));
  await harness.submitManual('Run: node app.mjs');
  // The tester independently executes the produced program.
  const evidence = await tools['run-tests']();
  await harness.submitTest({ candidate: join(projectDir, 'app.mjs'), passed: true, evidence });
  console.log(JSON.stringify({ synthetic: true, note: 'Model, research and user confirmation are simulated.', projectDir, logPath: writer.logPath, codingResult: run.output, test: evidence, phase: harness.snapshot().phase }, null, 2));
} finally { await writer.close(); }
