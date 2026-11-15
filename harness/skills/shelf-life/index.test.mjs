import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createEventLog } from '../../../packages/event-log/index.mjs';
import { SKILLS } from '../index.mjs';

const skill = SKILLS['shelf-life'];
const now = '2026-11-15T00:00:00.000Z';
const quote = 'Acme Tools requires version 8.0.';
const input = { doc: { label: 'README.md', markdown: '# Example\n' + quote + '\n' }, maxClaims: 1 };
const claims = [{ line: 2, quote, statement: 'Acme Tools minimum version is 8.0.', category: 'version', oldValue: '8.0' }];
const first = {
  name: 'Acme manual', url: 'https://acme.example/manual', domain: 'acme.example',
  snippet: 'The current minimum version for Acme Tools is 9.2.', retrievedAt: now,
};
const corroboration = {
  name: 'Acme package community', url: 'https://packages.example/acme', domain: 'packages.example',
  snippet: 'For all supported systems, installing Acme Tools requires at least 9.2.', retrievedAt: now,
};
const conflicting = {
  ...corroboration, snippet: 'For all supported systems, installing Acme Tools requires at least 10.0.',
};
const SYSTEM = { memberId: null, role: 'system', mode: 'system', provider: null, model: null, identitySource: 'configured' };
const validator = fileURLToPath(new URL('../../../samples/validate-events.mjs', import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, extra = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'shallowsee-skill-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const childRoom = { rootDir, roomId: 'parent-sl-01', parentRoomId: 'parent' };
  const requested = { models: [], searches: [] };
  const abort = new AbortController();
  const ctx = {
    childRoom, now: () => now, signal: abort.signal, synthetic: true,
    providerIdentity: { provider: 'fixture-provider', model: 'fixture-route/small-model' },
    note() {},
    async llm(request) {
      requested.models.push(request);
      assert.match(request.system, /untrusted data/);
      assert.equal(request.tools, undefined);
      assert.equal(request.signal, abort.signal);
      const content = JSON.parse(request.messages[0].content);
      const json = request.responseSchema.name === 'shelf_life_extract'
        ? { claims }
        : { verdict: 'stale', currentValue: '9.2', sourceIndexes: content.sources.map((_, i) => i), rationale: 'Fixture.' };
      return { json, toolCalls: [], stopReason: 'end', usage: { source: 'provider', inputTokens: 20, outputTokens: 8, costUsd: null } };
    },
    async search(request) {
      requested.searches.push(request);
      assert.match(request.query, /Acme Tools minimum version is 8\.0\./);
      const source = request.query.startsWith('Find ') ? first : extra.conflicting ? conflicting : corroboration;
      return { answer: null, sources: [source], durationMs: 1 };
    },
  };
  const childLog = join(rootDir, childRoom.roomId, 'events.jsonl');
  const events = async () => (await readFile(childLog, 'utf8')).trim().split('\n').map(JSON.parse);
  const verifyLog = () => {
    const output = execFileSync(process.execPath, [validator, childLog], { encoding: 'utf8', windowsHide: true });
    assert.match(output, /0 problem\(s\), 0 warning\(s\)/);
  };
  return { rootDir, ctx, requested, abort, childLog, events, verifyLog };
}

test('the built-in registry runs the existing audit in a separate child room with timestamped evidence and a valid proposed patch', async t => {
  const f = await fixture(t);
  assert.equal(skill.id, 'shelf-life');
  assert.deepEqual(skill.needs, { search: true, llm: true });
  assert.deepEqual(skill.allowedPhases, ['plan_check', 'fact_check']);
  const parent = await createEventLog({ rootDir: f.rootDir, roomId: f.ctx.childRoom.parentRoomId });
  await parent.append({ type: 'room.created', provenance: SYSTEM, payload: { goal: 'Parent', driver: 'harness' } });
  const originalParent = await readFile(parent.logPath, 'utf8');
  let report;
  try {
    report = await skill.run(input, f.ctx);
    assert.equal(await readFile(parent.logPath, 'utf8'), originalParent);
  } finally { await parent.close(); }

  assert.equal(report.status, 'completed');
  assert.equal(report.reason, null);
  assert.equal(report.childRoomId, f.ctx.childRoom.roomId);
  assert.equal(report.reviewStatus, 'unreviewed');
  assert.deepEqual(report.doc, { label: 'README.md', sha256: createHash('sha256').update(input.doc.markdown).digest('hex') });
  assert.equal(report.searchesUsed, 2);
  assert.equal(f.requested.models.length, 2);
  assert.equal(f.requested.searches.length, 2);
  const [finding] = report.findings;
  assert.equal(finding.line, 2);
  assert.equal(finding.quote, quote);
  assert.equal(finding.verdict, 'stale');
  assert.equal(finding.currentValue, '9.2');
  assert.equal(finding.checks.length, 4);
  assert.ok(finding.checks.every(check => check.passed));
  assert.deepEqual(finding.sources.map(source => source.retrievedAt), [now, now]);
  assert.equal(new Set(finding.sources.map(source => source.domain)).size, 2);

  const events = await f.events();
  assert.equal(events[0].type, 'room.created');
  assert.equal(events[0].payload.parentRoomId, 'parent');
  assert.equal(events[0].payload.synthetic, true);
  assert.equal(events.filter(event => event.type === 'room.created').length, 1);
  assert.equal(events.filter(event => event.type === 'shelflife.search.completed' && event.payload.provider === 'synthetic').length, 2);
  assert.ok(events.filter(event => event.type === 'run.completed').every(event => event.payload.usage.source === 'unknown'));
  assert.equal(events.at(-2).type, 'task.review');
  assert.ok(!events.some(event => event.type.includes('.pr.') || event.type === 'task.done' || event.payload.name === 'open_pull_request'));
  f.verifyLog();

  const markdown = join(f.rootDir, 'README.md');
  const patch = join(f.rootDir, 'proposed.diff');
  await writeFile(markdown, input.doc.markdown);
  await writeFile(patch, report.diff);
  execFileSync('git', ['apply', '--check', '--unidiff-zero', patch], { cwd: f.rootDir, windowsHide: true });
  assert.equal(await readFile(markdown, 'utf8'), input.doc.markdown);
  assert.match(report.diff, /^\+Acme Tools requires version 9\.2\.$/m);

  const repeat = await skill.run(input, f.ctx);
  assert.equal(repeat.status, 'failed');
  assert.equal(repeat.searchesUsed, 0);
  assert.equal(f.requested.models.length, 2);
  assert.deepEqual(await f.events(), events);
});

test('one run can invoke the same skill for its plan and README using disjoint child rooms', async t => {
  const f = await fixture(t);
  const plan = await skill.run({ ...input, doc: { ...input.doc, label: 'plan-facts-v2.md' } }, f.ctx);
  const secondRoom = { ...f.ctx.childRoom, roomId: 'parent-sl-02' };
  const readme = await skill.run(input, { ...f.ctx, childRoom: secondRoom });
  assert.equal(plan.status, 'completed');
  assert.equal(readme.status, 'completed');
  assert.equal(plan.doc.label, 'plan-facts-v2.md');
  assert.equal(readme.doc.label, 'README.md');
  assert.notEqual(plan.childRoomId, readme.childRoomId);

  const first = await f.events();
  const secondLog = join(f.rootDir, secondRoom.roomId, 'events.jsonl');
  const second = (await readFile(secondLog, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const events of [first, second]) {
    assert.equal(events[0].payload.parentRoomId, 'parent');
    assert.equal(events.filter(event => event.type === 'room.created').length, 1);
    assert.equal(events.at(-1).payload.status, 'completed');
  }
  const output = execFileSync(process.execPath, [validator, f.childLog, secondLog], { encoding: 'utf8', windowsHide: true });
  assert.equal(output.match(/0 problem\(s\), 0 warning\(s\)/g)?.length, 2);
});

test('conflicting source values stay unsure without a patch and keep checks from the final attempt', async t => {
  const f = await fixture(t, { conflicting: true });
  const report = await skill.run(input, f.ctx);
  assert.equal(report.status, 'completed');
  assert.equal(report.searchesUsed, 3);
  assert.equal(report.diff, null);
  const [finding] = report.findings;
  assert.equal(finding.verdict, 'unsure');
  assert.equal(finding.correction, null);
  assert.equal(finding.currentValue, null);
  assert.equal(finding.checks.length, 4);
  assert.equal(finding.checks.find(check => check.check === 'correction_supported').passed, false);
  assert.ok(!(await f.events()).some(event => event.type === 'shelflife.patch.proposed'));
  f.verifyLog();
});

test('search-disabled and malformed inputs cannot reach either provider or create evidence', async t => {
  const f = await fixture(t);
  const skipped = await skill.run(input, { ...f.ctx, search: null });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'no search provider');
  assert.equal(skipped.childRoomId, null);
  assert.equal(skipped.diff, null);
  assert.equal(skipped.searchesUsed, 0);
  for (const invalid of [
    { ...input, publisher: 'forged publisher' },
    { ...input, env: { token: 'forged' } },
    { ...input, doc: { ...input.doc, path: 'private.txt' } },
    { ...input, doc: { ...input.doc, label: '../private.md' } },
    { ...input, maxClaims: 13 },
  ]) {
    const result = await skill.run(invalid, f.ctx);
    assert.equal(result.status, 'failed');
    assert.equal(result.childRoomId, null);
  }
  const alias = await skill.run(input, { ...f.ctx, childRoom: { ...f.ctx.childRoom, roomId: 'PARENT' } });
  assert.equal(alias.status, 'failed');
  await assert.rejects(readFile(f.childLog), { code: 'ENOENT' });
  assert.deepEqual(f.requested, { models: [], searches: [] });
});

test('cancellation during an active search stops subsequent provider calls and closes after actual settlement', async t => {
  const f = await fixture(t);
  const started = deferred();
  const release = deferred();
  let settled = false;
  let searchCalls = 0;
  const originalSearch = f.ctx.search;
  f.ctx.search = async request => {
    searchCalls++;
    started.resolve(request.signal);
    await release.promise;
    return originalSearch(request);
  };

  const pending = skill.run(input, f.ctx).then(report => { settled = true; return report; });
  const signal = await started.promise;
  t.after(release.resolve);
  f.abort.abort();
  await nextTurn();
  assert.equal(signal.aborted, true);
  assert.equal(settled, false);
  assert.ok(!(await f.events()).some(event => event.type === 'room.closed'));
  release.resolve();
  const report = await pending;
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'Shelf Life audit cancelled.');
  assert.equal(report.searchesUsed, 1);
  assert.equal(report.diff, null);
  assert.equal(f.requested.models.length, 1);
  assert.equal(searchCalls, 1);
  const events = await f.events();
  assert.ok(events.some(event => event.type === 'run.cancelled'));
  assert.equal(events.at(-2).type, 'task.cancelled');
  assert.equal(events.at(-1).payload.status, 'cancelled');
  f.verifyLog();
});

test('cancellation waits for an active extraction and never starts search', async t => {
  const f = await fixture(t);
  const started = deferred();
  const release = deferred();
  let settled = false;
  const originalModel = f.ctx.llm;
  f.ctx.llm = async request => {
    started.resolve(request.signal);
    await release.promise;
    return originalModel(request);
  };
  const pending = skill.run(input, f.ctx).then(report => { settled = true; return report; });
  const signal = await started.promise;
  t.after(release.resolve);
  f.abort.abort();
  await nextTurn();
  assert.equal(signal.aborted, true);
  assert.equal(settled, false);
  release.resolve();
  const report = await pending;
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'Shelf Life audit cancelled.');
  assert.equal(report.searchesUsed, 0);
  assert.equal(f.requested.searches.length, 0);
  const events = await f.events();
  assert.ok(events.some(event => event.type === 'run.cancelled'));
  assert.ok(!events.some(event => event.type === 'run.completed'));
  f.verifyLog();
});

test('the configured model identity is reflected throughout live-shaped provider events and errors are redacted', async t => {
  const f = await fixture(t);
  f.ctx.synthetic = false;
  const report = await skill.run(input, f.ctx);
  assert.equal(report.status, 'completed');
  const events = await f.events();
  const members = events.filter(event => event.type === 'member.joined').map(event => event.payload);
  assert.equal(members[0].provider, f.ctx.providerIdentity.provider);
  assert.equal(members[0].model, f.ctx.providerIdentity.model);
  assert.match(members[0].displayName, /^fixture-provider /);
  const modelRuns = events.filter(event => event.type.startsWith('run.') && event.provenance.model !== null);
  assert.ok(modelRuns.length > 0);
  assert.ok(modelRuns.every(event => event.provenance.provider === f.ctx.providerIdentity.provider));
  assert.ok(modelRuns.every(event => event.provenance.identitySource === 'configured'));
  const searches = events.filter(event => event.type === 'shelflife.search.completed');
  assert.ok(searches.every(event => event.provenance.provider === 'linkup' && event.payload.provider === 'linkup'));
  assert.ok(!events.some(event => JSON.stringify(event).includes('anthropic')));
  f.verifyLog();

  const bad = await fixture(t);
  bad.ctx.llm = async () => { throw new Error('private provider detail'); };
  const failed = await skill.run(input, bad.ctx);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.searchesUsed, 0);
  assert.doesNotMatch(JSON.stringify(failed) + JSON.stringify(await bad.events()), /private provider detail/);
  bad.verifyLog();
});
