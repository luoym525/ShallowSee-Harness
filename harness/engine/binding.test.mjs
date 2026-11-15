// Regression tests for the P1 found in review (room #351): "delivered" must be bound to a real, valid commit that is the
// workspace's actual clean HEAD. A null final candidate on both the report and the review used to pass (null === null).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRun, startRun } from './index.mjs';
import { FAKE_KEY, makeKit, readJson, readLog, readText } from './testkit.mjs';

const WISH = 'I want a page that tells me if I need an umbrella in London tomorrow';
const ok = item => ({ [`${item.id}.txt`]: 'ok' });
const ofType = (events, type) => events.filter(e => e.type === type);
const finishedOf = events => ofType(events, 'harness.run.finished')[0].payload;
const forAll = fn => async (report, o) => (report.scope.kind === 'all' ? fn(report, o) : report);

async function execute(t, opts = {}) {
  const kit = await makeKit({ builder: ok, ...opts });
  t.after(kit.cleanup);
  const handle = startRun({ wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps });
  const summary = await handle.done;
  return { kit, summary, events: await readLog(kit.dataDir, handle.runId), runId: handle.runId };
}

test('a null final candidate with every check passing and a ship review is NOT delivered (null === null must not bind)', async t => {
  const run = await execute(t, { mutateReport: forAll(r => ({ ...r, candidate: null })) });
  assert.equal(run.summary.status, 'partial');
  const finished = finishedOf(run.events);
  assert.equal(finished.allPassed, true, 'the checks themselves passed');
  assert.equal(finished.candidateCheck.ok, false);
  assert.match(finished.candidateCheck.reason, /no valid candidate commit/);
  assert.match(finished.summary, /not delivered because/);
  const report = await readText(run.kit.dataDir, run.runId, 'REPORT.md');
  assert.match(report, /Engine note: every check passed, but this run is not marked delivered because the final test report names no valid candidate commit/);
  assert.equal((await readJson(run.kit.dataDir, run.runId, 'final-review.json')).candidate, null);
  assert.equal((await readRun(run.runId, { dataDir: run.kit.dataDir })).status, 'partial');
});

test('a malformed, uppercase or foreign candidate SHA is not delivered; neither is a report that is not the scope-all report', async t => {
  for (const candidate of ['not-a-sha', 'A'.repeat(40), 'abc123', 'a'.repeat(40), 'a'.repeat(39), 7]) {
    const run = await execute(t, { mutateReport: forAll(r => ({ ...r, candidate })) });
    assert.equal(run.summary.status, 'partial', `candidate ${String(candidate)}`);
    assert.ok(finishedOf(run.events).candidateCheck.reason);
  }
  const foreign = await execute(t, { mutateReport: forAll(r => ({ ...r, candidate: 'a'.repeat(40) })) });
  assert.match(finishedOf(foreign.events).candidateCheck.reason, /HEAD \(.{7}\) is not the tested candidate \(aaaaaaa\)/);
  const wrongScope = await execute(t, { mutateReport: forAll(r => ({ ...r, scope: { kind: 'item', itemId: 'W2', includeRegression: true } })) });
  assert.equal(wrongScope.summary.status, 'partial');
  assert.match(await readText(wrongScope.kit.dataDir, wrongScope.runId, 'REPORT.md'), /does not cover all checks/);
});

test('a dirty workspace (untracked file, or a tracked file changed after the test) is not delivered, and the tree is never auto-committed', async t => {
  const untracked = await execute(t, { mutateReport: forAll(async (r, o) => { await o.workspace.writeFile('stray.txt', 'left over'); return r; }) });
  assert.equal(untracked.summary.status, 'partial');
  assert.match(finishedOf(untracked.events).candidateCheck.reason, /uncommitted changes after the final test \(\?\? stray\.txt\)/);

  const tracked = await execute(t, { mutateReport: forAll(async (r, o) => { await o.workspace.writeFile('W1.txt', 'edited after the test'); return r; }) });
  assert.equal(tracked.summary.status, 'partial');
  assert.match(finishedOf(tracked.events).candidateCheck.reason, /M W1\.txt/);
  const tested = (await readJson(tracked.kit.dataDir, tracked.runId, 'tests/final.json')).candidate;
  assert.equal(finishedOf(tracked.events).candidate, tested, 'the reported candidate is still the tested commit: nothing was committed on top');

  // A workspace whose git has no status() falls back to the contracted changedFiles(candidate): tracked changes are still caught.
  const noStatusDirty = await execute(t, { workspaceNoStatus: true, mutateReport: forAll(async (r, o) => { await o.workspace.writeFile('W1.txt', 'edited'); return r; }) });
  assert.equal(noStatusDirty.summary.status, 'partial');
  assert.match(finishedOf(noStatusDirty.events).candidateCheck.reason, /W1\.txt/);
  const noStatusClean = await execute(t, { workspaceNoStatus: true });
  assert.equal(noStatusClean.summary.status, 'delivered');
});

test('when the workspace cannot be verified the run fails closed; a clean matching candidate still delivers and records the check', async t => {
  const kit = await makeKit({ builder: ok });
  t.after(kit.cleanup);
  const create = kit.deps.sandbox.createWorkspace;
  kit.deps.sandbox.createWorkspace = async o => { const ws = await create(o); ws.git.status = async () => { throw new Error(`git exploded ${FAKE_KEY}`); }; return ws; };
  const handle = startRun({ wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps });
  assert.equal((await handle.done).status, 'partial');
  const finished = finishedOf(await readLog(kit.dataDir, handle.runId));
  assert.match(finished.candidateCheck.reason, /could not be verified: git exploded/);
  assert.ok(!finished.candidateCheck.reason.includes(FAKE_KEY));

  const good = await execute(t);
  assert.equal(good.summary.status, 'delivered');
  const g = finishedOf(good.events);
  assert.deepEqual(g.candidateCheck, { ok: true, reason: null });
  assert.match(g.candidate, /^[0-9a-f]{40}$/);
  assert.equal(g.candidate, (await readJson(good.kit.dataDir, good.runId, 'tests/final.json')).candidate);
  assert.equal(g.candidate, (await readJson(good.kit.dataDir, good.runId, 'final-review.json')).candidate);
});
