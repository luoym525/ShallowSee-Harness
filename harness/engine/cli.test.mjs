import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { UsageError, formatEvent, parseArgs, runCli } from '../bin/cli-lib.mjs';
import { FAKE_KEY, fakeConfig, fakeRouter, makeKit } from './testkit.mjs';
import { readRun } from './index.mjs';

const WISH = 'I want a page that tells me if I need an umbrella in London tomorrow';
const cliPath = fileURLToPath(new URL('../bin/shallowsee.mjs', import.meta.url));

function capture(extra = {}) {
  const lines = { out: '', err: '' };
  return { lines, io: { out: s => { lines.out += s; }, err: s => { lines.err += s; }, ...extra } };
}
const fakeProviders = (path, config = fakeConfig(), extra = {}) => ({
  DEFAULT_CONFIG_PATH: path, loadApiConfig: async () => config, validateApiConfig: () => ({ ok: true, errors: [], warnings: [] }),
  createSearchClient: () => ({ available: true }),
  testProvider: async () => ({ ok: true, latencyMs: 42, detail: 'Connected, 4 models listed' }), ...extra,
});
const fakeRouterModule = () => {
  const r = fakeRouter();
  return { buildRoster: r.buildRoster, selectModel: r.selectModel,
    describeRouting: () => [{ role: 'planner', model: 'anthropic/claude-fable-5-2', tier: 3, reason: 'Planning needs the strongest model', pinned: false }, { role: 'builder', model: 'anthropic/claude-haiku-5-5', tier: 1, reason: 'Cheapest capable coder', pinned: true }] };
};

test('parseArgs: run, flags in both forms, and usage errors', () => {
  const a = parseArgs(['run', 'I want', 'a page', '--budget-usd', '2.5', '--minutes=10', '--autonomy', 'confirm_plan']);
  assert.equal(a.command, 'run');
  assert.equal(a.wish, 'I want a page');
  assert.deepEqual(a.flags, { 'budget-usd': 2.5, minutes: 10, autonomy: 'confirm_plan' });
  assert.equal(parseArgs(['config', 'check', '--offline']).command, 'config-check');
  assert.equal(parseArgs(['runs']).command, 'runs');
  assert.equal(parseArgs([]).command, 'help');
  for (const bad of [['run'], ['run', 'x', '--budget-usd', '0'], ['run', 'x', '--budget-usd'], ['run', 'x', '--minutes', 'abc'], ['run', 'x', '--autonomy', 'yolo'], ['run', 'x', '--nope'], ['frobnicate'], ['config'], ['run', 'x'.repeat(2001)]]) {
    assert.throws(() => parseArgs(bad), UsageError, JSON.stringify(bad).slice(0, 40));
  }
});

test('usage errors exit 2 and print the usage; --help exits 0', async () => {
  const bad = capture();
  assert.equal(await runCli(['run'], bad.io), 2);
  assert.match(bad.lines.err, /needs a wish/);
  assert.match(bad.lines.err, /Usage:/);
  const help = capture();
  assert.equal(await runCli(['--help'], help.io), 0);
  assert.match(help.lines.out, /config check/);
  const spawned = spawnSync(process.execPath, [cliPath, 'run'], { encoding: 'utf8', windowsHide: true });
  assert.equal(spawned.status, 2);
});

test('config check without apiConfig.json prints a helpful message; with one it validates, prints the routing table and tests providers, never printing a key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'shallowsee-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const none = capture({ modules: { providers: fakeProviders(join(dir, 'apiConfig.json')), router: fakeRouterModule() } });
  assert.equal(await runCli(['config', 'check'], none.io), 1);
  assert.match(none.lines.out, /No apiConfig\.json was found/);
  assert.match(none.lines.out, /apiConfig\.example\.json/);
  assert.match(none.lines.out, /Setup page/);

  const path = join(dir, 'apiConfig.json');
  await writeFile(path, '{}');
  const withCfg = capture({ modules: { providers: fakeProviders(path), router: fakeRouterModule() } });
  assert.equal(await runCli(['config', 'check'], withCfg.io), 0);
  const out = withCfg.lines.out;
  assert.match(out, /Configuration: valid/);
  assert.match(out, /anthropic {2}anthropic {2}enabled {2}key: set/);
  assert.match(out, /planner +anthropic\/claude-fable-5-2 \(tier 3\) - Planning needs the strongest model/);
  assert.match(out, /builder +anthropic\/claude-haiku-5-5 \(tier 1\) \[pinned\]/);
  assert.match(out, /Search \(Linkup\): configured/);
  assert.match(out, /anthropic: ok \(42 ms\) - Connected, 4 models listed/);
  assert.ok(!out.includes(FAKE_KEY) && !withCfg.lines.err.includes(FAKE_KEY));

  const failing = capture({ modules: { providers: fakeProviders(path, fakeConfig(), { testProvider: async () => ({ ok: false, latencyMs: null, detail: 'HTTP 401: key rejected' }) }), router: fakeRouterModule() } });
  assert.equal(await runCli(['config', 'check'], failing.io), 1);
  assert.match(failing.lines.out, /anthropic: FAILED - HTTP 401/);
  const offline = capture({ modules: { providers: fakeProviders(path, fakeConfig(), { testProvider: async () => { throw new Error('must not be called'); } }), router: fakeRouterModule() } });
  assert.equal(await runCli(['config', 'check', '--offline'], offline.io), 0);
  assert.match(offline.lines.out, /skipped \(--offline\)/);

  const noModels = capture({ modules: { providers: fakeProviders(path), router: { ...fakeRouterModule(), buildRoster: () => [] } } });
  assert.equal(await runCli(['config', 'check', '--offline'], noModels.io), 1);
  assert.match(noModels.lines.out, /No usable models/);
});

test('run streams one line per key event (phase, model and reason, test score, decision, auto-approval), prints the folder and report, and exits 0 when delivered', async t => {
  const kit = await makeKit({ builder: item => ({ [`${item.id}.txt`]: 'ok' }) });
  t.after(kit.cleanup);
  const providers = fakeProviders(join(kit.dataDir, 'apiConfig.json'), kit.config);
  const { lines, io } = capture({ modules: { providers, router: fakeRouterModule() }, defaultDataDir: kit.dataDir });
  const code = await runCli(['run', WISH, '--data-dir', kit.dataDir, '--budget-usd', '3'], io, kit.deps);
  assert.equal(code, 0);
  const out = lines.out;
  assert.match(out, /^Run hr-\d{8}-\d{6}-[a-z0-9]{4} started/m);
  assert.match(out, /^==> intake$/m);
  assert.match(out, /^==> build W1$/m);
  assert.match(out, /model for planner \(plan\): anthropic\/claude-fable-5-2 - Planning needs the strongest model/);
  assert.match(out, /model for builder \(build W1\): anthropic\/claude-haiku-5-5 - Chosen by the planner/);
  assert.match(out, /plan review v1: approve \(auto-approved by anthropic\/claude-opus-5-5\)/);
  assert.match(out, /skill shelf-life \(plan_check\): completed, 1 claim\(s\), 0 stale/);
  assert.match(out, /tests \(item W1 \+ regression\): 1\/1 passed, score 1\.00/);
  assert.match(out, /decision for W1: next - fake reflector: next/);
  assert.match(out, /tests \(all checks\): 2\/2 passed/);
  assert.match(out, /^Finished: delivered/m);
  assert.match(out, /^Status: delivered$/m);
  assert.match(out, /Report: .*REPORT\.md/);
  assert.match(out, /Run folder: .*harness[\\/]runs[\\/]hr-/);
  assert.ok(!out.includes(FAKE_KEY));
  const runId = /Run (hr-[a-z0-9-]+) started/.exec(out)[1];
  assert.equal((await readRun(runId, { dataDir: kit.dataDir })).limits.maxUsdPerRun, 3, '--budget-usd reached the engine');

  const listed = capture();
  assert.equal(await runCli(['runs', '--data-dir', kit.dataDir], listed.io), 0);
  assert.match(listed.lines.out, new RegExp(`${runId} +delivered +done`));
  const empty = capture();
  assert.equal(await runCli(['runs', '--data-dir', join(kit.dataDir, 'nothing-here')], empty.io), 0);
  assert.match(empty.lines.out, /No runs yet/);
});

test('run exits 1 when the run is not delivered, and 1 with a clear message when the configuration cannot be read', async t => {
  const kit = await makeKit({ builder: item => ({ [`${item.id}.txt`]: 'ok' }), costPerCall: 0.01 });
  t.after(kit.cleanup);
  const { lines, io } = capture({ modules: { providers: fakeProviders(join(kit.dataDir, 'x.json'), kit.config), router: fakeRouterModule() } });
  const code = await runCli(['run', WISH, '--data-dir', kit.dataDir, '--budget-usd', '0.005'], io, kit.deps);
  assert.equal(code, 1);
  assert.match(lines.out, /LIMIT REACHED: usd/);
  assert.match(lines.out, /^Status: (failed|partial)$/m);

  const broken = capture({ modules: { providers: fakeProviders('x', fakeConfig(), { loadApiConfig: async () => { throw new Error('invalid_json: unexpected token'); } }), router: fakeRouterModule() } });
  assert.equal(await runCli(['run', WISH], broken.io, kit.deps), 1);
  assert.match(broken.lines.err, /Could not read the configuration: invalid_json/);
});

test('formatEvent is silent for events it does not know and never throws on sparse payloads', () => {
  assert.equal(formatEvent({ type: 'artifact.registered', payload: {} }), null);
  assert.equal(formatEvent({ type: 'harness.budget.updated', payload: { exceeded: null } }), null);
  for (const type of ['harness.test.completed', 'harness.candidate.best', 'harness.plan.reviewed', 'harness.skill.completed', 'harness.phase.changed', 'harness.run.finished']) {
    assert.equal(typeof formatEvent({ type, payload: { score: 0, scope: { kind: 'all' } } }), 'string');
  }
});
