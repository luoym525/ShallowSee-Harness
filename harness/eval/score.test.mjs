import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace } from '../workers/sandbox/index.mjs';
import { runBench, WISHES } from './run-bench.mjs';
import { renderScore, scoreManifest, summarize } from './score.mjs';

const stamp = '2026-11-15T07:33:00.000Z';
const revision = { harnessCommit: 'a'.repeat(40), harnessTreeDirty: false };
const getWish = id => WISHES.find(sample => sample.id === id);
const oneRun = (id, k) => ({ schemaVersion: 1, k, ...revision, synthetic: false, wishIds: [id], trials: [] });

async function makeTemp(t) {
  const root = await mkdtemp(join(tmpdir(), 'shallowsee-eval-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function makeRun(dataDir, wish, runId, { path = 'different.mjs', code, badAfter = null, kind = 'command', minuteLimit = false }) {
  const runDir = join(dataDir, 'harness', 'runs', runId);
  const workspace = await createWorkspace({ dir: join(runDir, 'workspace') });
  await workspace.writeFile(path, code);
  const best = await workspace.git.commit('Synthetic candidate');
  if (badAfter !== null) {
    await workspace.writeFile(path, badAfter);
    await workspace.git.commit('Move away from recorded best.');
    await workspace.writeFile(path, 'uncommitted, should never be scored');
  }
  const entry = kind === 'open_html' ? { kind, path } : { kind, run: ['node', path, '--documented-example'] };
  const state = { synthetic: true, runId, status: 'delivered', startedAt: stamp, best: { commit: best }, iteration: 2,
    spend: { usd: 0.0065, usdSource: 'unknown' } };
  await writeFile(join(runDir, 'state.json'), JSON.stringify(state));
  await writeFile(join(runDir, 'spec.json'), JSON.stringify({ stack: kind === 'open_html' ? 'static-web' : 'node', entry }));
  const events = [
    ['room.created', { synthetic: true, goal: wish }],
    ['harness.plan.ready', { specVersion: 1 }],
    ['harness.plan.ready', { specVersion: 2 }],
    ['harness.route.selected', { escalated: true }],
    ['run.started', { role: 'builder', model: 'synthetic/builder' }],
    ['harness.candidate.best', { reverted: true }],
    ...(minuteLimit ? [['harness.budget.updated', { exceeded: 'minutes' }]] : []),
    ['harness.run.finished', { status: 'delivered', finalScore: 0.75, candidate: best, minutes: 4.25 }],
  ].map(([type, payload], index) => ({ seq: index + 1, roomId: runId, type, timestamp: stamp, payload }));
  const room = join(dataDir, 'rooms', runId);
  await mkdir(room, { recursive: true });
  await writeFile(join(room, 'events.jsonl'), events.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { workspace, best };
}

test('benchmark keeps held-out definitions away from the engine and counts an elapsed timeout', async t => {
  const dataDir = await makeTemp(t);
  const seen = [];
  const sample = getWish('times-table');
  const manifest = await runBench({
    samples: [sample], dataDir, outputPath: join(dataDir, 'eval.json'), config: {},
    k: 2, revision, synthetic: true, maxUsdPerRun: 1.5, maxMinutesPerRun: 0.0005,
    start(options) {
      seen.push(options);
      if (seen.length === 1) return { runId: 'hr-20261115-073300-done', done: Promise.resolve({ status: 'delivered' }) };
      let settle;
      return {
        runId: 'hr-20261115-073301-slow', done: new Promise(resolve => { settle = resolve; }),
        cancel: () => settle({ status: 'cancelled' }),
      };
    },
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { wish: sample.wish, config: {}, dataDir,
    overrides: { autonomy: 'full', budget: { maxUsdPerRun: 1.5, maxMinutesPerRun: 0.0005 } } });
  assert.equal(manifest.synthetic, true);
  assert.deepEqual(manifest.trials.map(row => row.status), ['delivered', 'timed_out']);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'eval.json'), 'utf8')), manifest);
});

test('best committed product executes in isolation and a timeout lowers success rate', async t => {
  const dataDir = await makeTemp(t);
  const sample = getWish('times-table');
  const manifest = oneRun(sample.id, 2);
  const runId = 'hr-20261115-073300-wins';
  const { workspace, best } = await makeRun(dataDir, sample.wish, runId, {
    path: 'src/any-entry.mjs',
    code: 'const n = +process.argv[2]; for (let i = 1; i <= 12; i++) console.log(n + " x " + i + " = " + n * i);',
    badAfter: 'console.log("wrong");',
  });
  manifest.trials.push({ wishId: sample.id, trial: 1, runId, status: 'delivered', startedAt: stamp });
  manifest.trials.push({ wishId: sample.id, trial: 2, runId: null, status: 'timed_out', startedAt: stamp, wallMinutes: 3 });
  manifest.synthetic = true;
  const scored = await scoreManifest(manifest, { dataDir });
  assert.equal(scored.rows[0].heldOutStatus, 'pass');
  assert.equal(scored.rows[0].candidate, best);
  assert.equal(await workspace.readFile('src/any-entry.mjs'), 'uncommitted, should never be scored');
  assert.equal(scored.rows[0].engineScore, 0.75);
  assert.equal(scored.rows[0].planRevisions, 1);
  assert.equal(scored.rows[0].keepBestReverts, 1);
  assert.equal(scored.rows[0].escalations, 1);
  assert.equal(scored.rows[0].costUsd, null);
  assert.equal(scored.rows[0].knownSpendUsd, 0.0065);
  assert.equal(scored.rows[1].heldOutStatus, 'timed_out');
  assert.equal(scored.rows[1].costUsd, null);
  assert.equal(scored.rows[1].minutes, 3);
  assert.deepEqual(scored.groups[0], { wishId: sample.id, synthetic: true, sampleSize: 2, successes: 1,
    passRate: 0.5, passAtK: 1, passToK: 0 });
  const output = renderScore(scored);
  assert.match(output, /50\.0% \| 100\.0% \| 0\.0%/);
  assert.match(output, /known; total unknown/);
  assert.match(output, /synthetic\/builder/);
  assert.match(output, /\| synthetic \| times-table/);
  assert.match(output, new RegExp(revision.harnessCommit));
});

test('duration budget events and corrupted evidence cannot produce a pass', async t => {
  const dataDir = await makeTemp(t);
  const sample = getWish('times-table');
  const manifest = oneRun(sample.id, 2);
  const runId = 'hr-20261115-073300-late';
  await makeRun(dataDir, sample.wish, runId, { code: 'console.log("7 x 1 = 7");', minuteLimit: true });
  manifest.trials.push({ wishId: sample.id, trial: 1, runId, status: 'delivered', startedAt: stamp });
  manifest.trials.push({ wishId: sample.id, trial: 2, runId: 'hr-20261115-073301-miss', status: 'delivered', startedAt: stamp });
  const scored = await scoreManifest(manifest, { dataDir });
  assert.deepEqual(scored.rows.map(row => row.heldOutStatus), ['timed_out', 'error']);
  assert.equal(scored.rows[0].synthetic, true);
  assert.equal(scored.rows[1].engineScore, null);
  assert.equal(scored.rows[1].minutes, null);
  assert.equal(scored.groups.length, 2);
  assert.equal(scored.groups[0].passAtK, null);
});

test('HTML held-out probes read the chosen committed entry and ignore script, header and comment text', async t => {
  const dataDir = await makeTemp(t);
  const sample = getWish('tip-calculator');
  const manifest = oneRun(sample.id, 1);
  const runId = 'hr-20261115-073300-html';
  await makeRun(dataDir, sample.wish, runId, { kind: 'open_html', path: 'public/custom.html',
    code: '<head><title>Bill People Total</title></head><script>const hidden = "Bill People Total";</script><!-- Bill People Total --><h1>Bill</h1>' });
  manifest.trials.push({ wishId: sample.id, trial: 1, runId, status: 'delivered', startedAt: stamp });
  const [row] = (await scoreManifest(manifest, { dataDir })).rows;
  assert.equal(row.heldOutStatus, 'fail');
  assert.equal(row.passed, 1);
  assert.equal(row.total, 3);
});

test('a wrong Fahrenheit number containing the expected digits does not pass', async t => {
  const dataDir = await makeTemp(t);
  const sample = getWish('unit-converter');
  const manifest = oneRun(sample.id, 1);
  const runId = 'hr-20261115-073300-unit';
  await makeRun(dataDir, sample.wish, runId, {
    code: 'if (process.argv[3] === "oops") process.exit(1); console.log(process.argv[2] === "c-to-f" ? "140" : "15.53");',
  });
  manifest.trials.push({ wishId: sample.id, trial: 1, runId, status: 'delivered', startedAt: stamp });
  const [row] = (await scoreManifest(manifest, { dataDir })).rows;
  assert.equal(row.heldOutStatus, 'fail');
  assert.equal(row.passed, 2);
});

test('a tenfold error in every multiplication result cannot pass the held-out rows', async t => {
  const dataDir = await makeTemp(t);
  const sample = getWish('times-table');
  const manifest = oneRun(sample.id, 1);
  const runId = 'hr-20261115-073305-wrng';
  await makeRun(dataDir, sample.wish, runId, {
    code: 'const factor = +process.argv[2]; for (let i = 1; i <= 12; i++) console.log(factor + " x " + i + " = " + factor * i * 10);',
  });
  manifest.trials.push({ wishId: sample.id, trial: 1, runId, status: 'delivered', startedAt: stamp });
  const [row] = (await scoreManifest(manifest, { dataDir })).rows;
  assert.equal(row.heldOutStatus, 'fail');
  assert.equal(row.passed, 0);
});

test('digits in a scientific exponent do not equal the expected numeric output', async t => {
  const dataDir = await makeTemp(t);
  const sample = getWish('unit-converter');
  const manifest = oneRun(sample.id, 1);
  const runId = 'hr-20261115-073306-expt';
  await makeRun(dataDir, sample.wish, runId, {
    code: 'if (process.argv[3] === "oops") process.exit(1); console.log(process.argv[2] === "c-to-f" ? "1e14" : "15.53");',
  });
  manifest.trials.push({ wishId: sample.id, trial: 1, runId, status: 'delivered', startedAt: stamp });
  const [row] = (await scoreManifest(manifest, { dataDir })).rows;
  assert.equal(row.heldOutStatus, 'fail');
  assert.equal(row.passed, 2);
});

test('pass@k and pass^k keep failures and errors in the denominator', () => {
  const rows = ['pass', 'pass', 'fail', 'error', 'timed_out'].map(heldOutStatus => ({ wishId: 'wish', heldOutStatus }));
  const [group] = summarize(rows, 2);
  assert.equal(group.sampleSize, 5);
  assert.equal(group.passRate, 0.4);
  assert.equal(group.passAtK, 0.7);
  assert.equal(group.passToK, 0.1);
});

test('an interrupted run is recorded as a miss and the manifest is visibly incomplete', async t => {
  const dataDir = await makeTemp(t);
  const manifest = oneRun('times-table', 2);
  manifest.synthetic = true;
  manifest.trials.push({ wishId: 'times-table', trial: 1, runId: null, status: 'interrupted', startedAt: stamp });
  const result = await scoreManifest(manifest, { dataDir });
  assert.equal(result.complete, false);
  assert.equal(result.groups[0].sampleSize, 1);
  assert.equal(result.groups[0].passRate, 0);
  assert.equal(result.groups[0].passAtK, null);
  assert.match(renderScore(result), /Incomplete benchmark\. 1 of 2 scheduled attempts/);
});
