import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readRun, startRun } from './index.mjs';
import { FAKE_KEY, REFS, fakeConfig, makeKit, makeSpec, readJson, readLog, readText } from './testkit.mjs';
import { SKILLS } from '../skills/index.mjs';
import * as quotaRouter from '../router/index.mjs';

const validator = fileURLToPath(new URL('../../samples/validate-events.mjs', import.meta.url));
const WISH = 'I want a page that tells me if I need an umbrella in London tomorrow';
const ok = item => ({ [`${item.id}.txt`]: 'ok' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ofType = (events, type) => events.filter(e => e.type === type);
const phases = events => events.filter(e => e.type === 'harness.phase.changed').map(e => e.payload.phase);
const validate = (dataDir, runId) => assert.match(execFileSync(process.execPath, [validator, join(dataDir, 'rooms', runId, 'events.jsonl')], { encoding: 'utf8', windowsHide: true }), /0 problem\(s\)/);

async function execute(t, opts = {}, run = {}) {
  const kit = await makeKit({ builder: ok, ...opts });
  t.after(kit.cleanup);
  const handle = startRun({ wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps, ...run });
  const summary = await handle.done;
  return { kit, handle, summary, events: await readLog(kit.dataDir, handle.runId), runId: handle.runId };
}

test('retry then pass: the builder gets the reflector\'s fix instructions and progress notes, the second attempt passes, spend is the sum of known costs', async t => {
  const { kit, summary, events, runId } = await execute(t, { builder: (item, attempt) => ({ [`${item.id}.txt`]: item.id === 'W1' && attempt === 1 ? 'bad' : 'ok' }) });
  assert.equal(summary.status, 'delivered');
  assert.deepEqual(kit.seen.builderCalls.map(c => `${c.itemId}#${c.attempt}`), ['W1#1', 'W1#2', 'W2#1']);
  assert.equal(kit.seen.builderCalls[0].fixInstructions, null);
  assert.equal(kit.seen.builderCalls[1].fixInstructions, 'Fix W1');
  assert.match(kit.seen.builderCalls[1].progress, /W1 .* attempt 1/);
  assert.deepEqual(ofType(events, 'harness.reflect.decided').map(e => e.payload.decision), ['retry', 'next', 'finish']);
  assert.equal(ofType(events, 'harness.candidate.best').filter(e => e.payload.reverted).length, 0);
  assert.equal(ofType(events, 'task.done').length, 2);
  assert.equal((await readRun(runId, { dataDir: kit.dataDir })).items.W1.attempts, 2);
  assert.ok(kit.seen.builderCalls.length === 3 && (await readText(kit.dataDir, runId, 'progress.md')).split('## Iteration').length === 4);
  validate(kit.dataDir, runId);
});

test('escalation: attempt 2 and 3 ask the router with the attempt number; the tester avoids the builder\'s model and vendor', async t => {
  const { kit, summary, events } = await execute(t, {
    builder: (item, attempt) => ({ [`${item.id}.txt`]: item.id === 'W2' && attempt < 3 ? 'bad' : 'ok' }),
    reflector: input => (input.testReport.results.some(r => r.status !== 'pass') ? 'escalate' : undefined),
  });
  assert.equal(summary.status, 'delivered');
  const builderReqs = kit.routerCalls.filter(c => c.role === 'builder');
  assert.deepEqual(builderReqs.map(c => c.attempt), [1, 1, 2, 3]);
  assert.equal(builderReqs[0].suggested, REFS.haiku);
  assert.equal(builderReqs[3].difficulty, 'medium');
  const routes = ofType(events, 'harness.route.selected').filter(e => e.payload.role === 'builder');
  assert.deepEqual(routes.map(e => e.payload.escalated), [false, false, true, true]);
  assert.deepEqual(ofType(events, 'harness.build.completed').map(e => e.payload.model), [REFS.haiku, REFS.sonnet, REFS.opus, REFS.opus]);
  const testerReqs = kit.routerCalls.filter(c => c.role === 'tester' && c.avoidModels?.length);
  assert.ok(testerReqs.length >= 4);
  assert.deepEqual(testerReqs[0].avoidModels, [REFS.haiku]);
  assert.deepEqual(testerReqs[0].avoidVendors, ['anthropic']);
  assert.ok(ofType(events, 'harness.test.completed').every(e => e.payload.testerModel !== null));
  const testerRoutes = ofType(events, 'harness.route.selected').filter(e => e.payload.role === 'tester' && e.payload.purpose.startsWith('test W1'));
  assert.equal(testerRoutes[0].payload.model, REFS.gpt, 'a different vendor than the Anthropic builder');
});

test('regression: a lower score resets the workspace to the best commit before the next attempt (no git while a worker is pending)', async t => {
  let w1AtAttempt2 = null;
  const { kit, summary, events, runId } = await execute(t, {
    builder: async (item, attempt, o) => {
      if (item.id === 'W2' && attempt === 1) return { 'W1.txt': 'bad', 'W2.txt': 'bad' };      // breaks the finished item and fails its own checks
      if (item.id === 'W2' && attempt === 2) { w1AtAttempt2 = await o.workspace.readFile('W1.txt'); }
      return ok(item);
    },
  });
  assert.equal(summary.status, 'delivered');
  const best = ofType(events, 'harness.candidate.best');
  const reverted = best.filter(e => e.payload.reverted);
  assert.equal(reverted.length, 1);
  assert.equal(reverted[0].payload.previousBest, 0.5);
  assert.equal(reverted[0].payload.score, 0.5);
  assert.equal(reverted[0].payload.rejected.score, 0);
  assert.equal(w1AtAttempt2, 'ok', 'the workspace was reset to the best commit before attempt 2');
  assert.deepEqual(kit.violations, []);
  assert.equal(ofType(events, 'task.done').length, 2);
  assert.equal((await readJson(kit.dataDir, runId, 'tests/final.json')).allPassed, true);
});

test('budget: when the USD limit is exceeded mid-build the run stops building, runs the final test, reports partial and never says delivered', async t => {
  const { kit, summary, events, runId } = await execute(t, { costPerCall: req => (req.messages[0].content.startsWith('build W2') ? 10 : 0.001) });
  assert.equal(summary.status, 'partial');
  assert.ok(summary.spentUsd > 5);
  assert.equal(kit.seen.builderCalls.length, 2);
  assert.ok(ofType(events, 'harness.budget.updated').some(e => e.payload.exceeded === 'usd'));
  assert.deepEqual(phases(events).slice(-4), ['build', 'final_test', 'report', 'done']);
  assert.equal(ofType(events, 'harness.test.completed').filter(e => e.payload.itemId === 'W2').length, 0, 'W2 was never tested as an item after the limit');
  assert.equal(ofType(events, 'harness.run.finished')[0].payload.status, 'partial');
  assert.equal(kit.seen.reporter.status, 'partial');
  const fact = await readJson(kit.dataDir, runId, 'fact-check.json');
  assert.equal(fact.status, 'skipped');
  assert.match(fact.reason, /budget/);
  assert.equal((await readRun(runId, { dataDir: kit.dataDir })).status, 'partial');
  validate(kit.dataDir, runId);
});

test('limits: the build-iteration limit and the minutes limit also stop the build and report partial', async t => {
  const iter = await execute(t, {}, { overrides: { budget: { maxBuildIterations: 1 } } });
  assert.equal(iter.summary.status, 'partial');
  assert.equal(iter.kit.seen.builderCalls.length, 1);
  assert.ok(ofType(iter.events, 'harness.budget.updated').some(e => e.payload.exceeded === 'iterations'));
  assert.equal(ofType(iter.events, 'harness.reflect.decided')[0].payload.overriddenBy, 'budget');

  let clock = Date.now();
  const minutes = await execute(t, { now: () => clock, blockBuilder: async o => { if (o.item.id === 'W2') clock += 3 * 60 * 60000; } });
  assert.equal(minutes.summary.status, 'partial');
  assert.ok(minutes.summary.minutes >= 180);
  assert.ok(ofType(minutes.events, 'harness.budget.updated').some(e => e.payload.exceeded === 'minutes'));
});

test('plan revision: spec-rule violations and a reviewer revise each cost one revision; the revised spec gets a new version and approval', async t => {
  const { kit, summary, events, runId } = await execute(t, {
    checkSpecRules: spec => (spec.specVersion === 1 ? ['Ports must be in 4400-4499'] : []),
    reviewPlan: (input, n) => (n === 2 ? { verdict: 'revise', requiredChanges: ['Add a README check'], issues: [{ severity: 'major', text: 'No README check' }] } : {}),
  });
  assert.equal(summary.status, 'delivered');
  const reviews = ofType(events, 'harness.plan.reviewed');
  assert.deepEqual(reviews.map(r => r.payload.verdict), ['revise', 'revise', 'approve']);
  assert.match(kit.seen.planner[1].revision.review.requiredChanges.join('|'), /Fix spec rule violation: Ports must be in 4400-4499/);
  assert.equal(kit.seen.planner[2].revision.review.requiredChanges[0], 'Add a README check');
  assert.equal(reviews[2].payload.approval.specVersion, 3);
  assert.equal(reviews[0].payload.approval, null);
  assert.equal((await readJson(kit.dataDir, runId, 'spec.json')).specVersion, 3);
  assert.equal(ofType(events, 'harness.plan.ready').length, 3);
});

test('plan approval hard rules: approve with a low score or a blocker is treated as revise', async t => {
  const { events } = await execute(t, { reviewPlan: (input, n) => (n === 1 ? { verdict: 'approve', scores: { coversWish: 1, feasible: 3, testable: 3, scoped: 3 } } : n === 2 ? { verdict: 'approve', issues: [{ severity: 'blocker', text: 'bad' }] } : {}) });
  assert.deepEqual(ofType(events, 'harness.plan.reviewed').map(r => r.payload.verdict), ['revise', 'revise', 'approve']);
});

test('plan not approved: after the third spec is still not approved the run fails with "plan not approved" and the report lists the blockers; no build starts', async t => {
  const { kit, summary, events, runId } = await execute(t, { reviewPlan: () => ({ verdict: 'revise', issues: [{ severity: 'blocker', text: 'The plan ignores the wish' }], requiredChanges: ['Cover the wish'] }) });
  assert.equal(summary.status, 'failed');
  assert.equal(kit.seen.planner.length, 3);
  assert.equal(ofType(events, 'task.created').length, 0);
  assert.ok(!phases(events).includes('scaffold') && !phases(events).includes('build'));
  assert.equal(ofType(events, 'harness.run.finished')[0].payload.status, 'failed');
  assert.match(ofType(events, 'harness.run.finished')[0].payload.summary, /plan not approved/);
  assert.equal(events.at(-1).payload.status, 'failed');
  const state = await readRun(runId, { dataDir: kit.dataDir });
  assert.equal(state.status, 'failed');
  assert.equal(state.error.code, 'plan_not_approved');
  assert.equal(state.approval, null);
  const report = await readText(kit.dataDir, runId, 'REPORT.md');
  assert.match(report, /plan not approved/);
  assert.match(report, /The plan ignores the wish/);
  validate(kit.dataDir, runId);
});

test('refused brief: the run stops with status failed and the reason is in the report', async t => {
  const { kit, summary, events, runId } = await execute(t, { refused: true });
  assert.equal(summary.status, 'failed');
  assert.deepEqual(phases(events), ['intake', 'report', 'done']);
  assert.ok(ofType(events, 'harness.brief.ready')[0].payload.refused.reason);
  assert.match(await readText(kit.dataDir, runId, 'REPORT.md'), /private account/);
  assert.equal(kit.seen.planner.length, 0);
});

test('cancel mid-build: done resolves "cancelled" only after the builder settled; no git runs while it is pending; the log closes cleanly', async t => {
  const entered = deferred();
  let seq = 0; let settledAt = null;
  const kit = await makeKit({ builder: ok, blockBuilder: async o => {
    entered.resolve();
    await new Promise(resolve => o.signal.addEventListener('abort', () => setTimeout(resolve, 60), { once: true }));
    settledAt = ++seq;
  } });
  t.after(kit.cleanup);
  const handle = startRun({ wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps });
  await entered.promise;
  handle.cancel('stop please');
  const summary = await handle.done;
  const doneAt = ++seq;
  assert.equal(summary.status, 'cancelled');
  assert.ok(settledAt !== null && settledAt < doneAt);
  assert.deepEqual(kit.violations, []);
  const events = await readLog(kit.dataDir, handle.runId);
  assert.equal(events.at(-1).type, 'room.closed');
  assert.equal(events.at(-1).payload.status, 'cancelled');
  assert.equal(ofType(events, 'harness.run.finished')[0].payload.status, 'cancelled');
  assert.ok(!ofType(events, 'harness.reflect.decided').length);
  const state = await readRun(handle.runId, { dataDir: kit.dataDir });
  assert.equal(state.status, 'cancelled');
  assert.ok(state.finishedAt);
  assert.equal(kit.seen.reporter, null, 'no model call after cancellation');
  assert.match(await readText(kit.dataDir, handle.runId, 'REPORT.md'), /cancel/i);
  validate(kit.dataDir, handle.runId);
});

test('confirm_plan: the run waits in awaiting_confirmation, records the user\'s confirmation separately from the model approval, then continues', async t => {
  const waiting = deferred();
  const kit = await makeKit({ builder: ok });
  t.after(kit.cleanup);
  const handle = startRun({ wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps, overrides: { autonomy: 'confirm_plan' },
    onEvent: e => { if (e.type === 'harness.phase.changed' && e.payload.phase === 'awaiting_confirmation') waiting.resolve(); } });
  assert.equal(handle.confirmPlan(), false, 'nothing to confirm yet');
  await waiting.promise;
  await new Promise(r => setTimeout(r, 80));
  const mid = await readLog(kit.dataDir, handle.runId);
  assert.ok(!phases(mid).includes('scaffold'), 'no scaffold before confirmation');
  const state = await readRun(handle.runId, { dataDir: kit.dataDir });
  assert.equal(state.status, 'awaiting_confirmation');
  assert.equal(state.phase, 'awaiting_confirmation');
  assert.equal(state.approval.by, 'model');
  assert.equal(handle.confirmPlan(), true);
  assert.equal(handle.confirmPlan(), false);
  const summary = await handle.done;
  assert.equal(summary.status, 'delivered');
  const events = await readLog(kit.dataDir, handle.runId);
  const confirmed = ofType(events, 'harness.plan.confirmed');
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].payload.by, 'user');
  const final = await readRun(handle.runId, { dataDir: kit.dataDir });
  assert.equal(final.approval.by, 'model', 'the model approval is never rewritten as a user confirmation');
  assert.equal(confirmed[0].payload.specSha256, final.approval.specSha256);
  assert.equal(events[0].payload.autonomy, 'confirm_plan');
});

test('confirm_plan: the waiting event can be confirmed immediately and only once', async t => {
  const kit = await makeKit({ builder: ok });
  t.after(kit.cleanup);
  let responses;
  let actionsBeforeConfirmation;
  const handle = startRun({
    wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps, overrides: { autonomy: 'confirm_plan' },
    onEvent(event) {
      if (event.type !== 'harness.phase.changed' || event.payload.phase !== 'awaiting_confirmation') return;
      actionsBeforeConfirmation = kit.seen.builderCalls.length;
      responses = [handle.confirmPlan(), handle.confirmPlan()];
      if (!responses[0]) handle.cancel('The immediate confirmation was missed.');
    },
  });
  const summary = await handle.done;
  assert.equal(actionsBeforeConfirmation, 0);
  assert.deepEqual(responses, [true, false]);
  assert.equal(summary.status, 'delivered');
  const events = await readLog(kit.dataDir, handle.runId);
  assert.equal(ofType(events, 'harness.plan.confirmed').length, 1);
});

test('confirm_plan: cancelling while waiting ends the run as cancelled', async t => {
  const waiting = deferred();
  const kit = await makeKit({ builder: ok });
  t.after(kit.cleanup);
  const handle = startRun({ wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps, overrides: { autonomy: 'confirm_plan' },
    onEvent: e => { if (e.type === 'harness.phase.changed' && e.payload.phase === 'awaiting_confirmation') waiting.resolve(); } });
  await waiting.promise;
  handle.cancel();
  assert.equal((await handle.done).status, 'cancelled');
  assert.equal(handle.confirmPlan(), false);
});

test('permissions in code: only intake, researcher and planner get search; builder and tester contexts cannot reach skills or search', async t => {
  const { kit, events } = await execute(t);
  const ctxs = kit.seen.roleCtx;
  for (const name of ['intake', 'researcher', 'planner']) assert.equal(ctxs[name].search, true, name);
  for (const name of ['reviewPlan', 'reviewFinal', 'reflector', 'reporter']) assert.equal(ctxs[name].search, false, name);
  assert.ok([...Object.values(ctxs)].every(c => !c.hasSkills));
  for (const keys of kit.seen.builderKeys) {
    assert.deepEqual(keys, ['attempt', 'fixInstructions', 'item', 'llm', 'onTool', 'progress', 'signal', 'spec', 'workspace']);
    assert.ok(!keys.some(k => /search|skill|apiConfig|config/i.test(k)));
  }
  for (const keys of kit.seen.testerKeys) {
    assert.deepEqual(keys, ['acceptanceCommit', 'acceptanceTree', 'judge', 'scope', 'signal', 'spec', 'vision', 'workspace']);
    assert.ok(!keys.some(k => /search|skill|apiConfig|config/i.test(k)));
  }
  // linkup_search tool events exist, and only under calls of roles that have search permission.
  const searches = ofType(events, 'tool.called').filter(e => e.payload.name === 'linkup_search');
  assert.ok(searches.length >= 1);
  const roleOfCall = id => ofType(events, 'run.started').find(e => e.runId === id)?.payload.role;
  assert.ok(searches.every(e => ['intake', 'researcher', 'planner'].includes(roleOfCall(e.runId))));
  assert.ok(ofType(events, 'tool.result').some(e => e.payload.toolCallId === searches[0].payload.toolCallId));
  assert.equal(kit.seen.planner[0].roster.length, 5);
  assert.ok(kit.seen.planner[0].roster.every(m => m.ref && m.label && m.tier && Array.isArray(m.capabilities)));
  assert.ok(!JSON.stringify(kit.seen.planner[0]).includes(FAKE_KEY));
  assert.ok(kit.seen.testerKeys.length > 0 && kit.seen.builderKeys.length > 0);
});

test('no search provider: roles get no search, both skill checks are recorded as skipped ("not verified"), the run still delivers', async t => {
  const { kit, summary, events, runId } = await execute(t, { search: false });
  assert.equal(summary.status, 'delivered');
  for (const name of ['intake', 'researcher', 'planner']) assert.equal(kit.seen.roleCtx[name].search, false);
  assert.equal(kit.modelClient.calls.filter(c => c.schema?.startsWith('shelf_life_')).length, 0);
  const plan = await readJson(kit.dataDir, runId, 'plan-check-v1.json');
  assert.equal(plan.status, 'skipped');
  assert.equal(plan.reason, 'no search provider');
  assert.equal((await readJson(kit.dataDir, runId, 'fact-check.json')).status, 'skipped');
  assert.deepEqual(ofType(events, 'harness.skill.completed').map(e => e.payload.status), ['skipped', 'skipped']);
  assert.equal(kit.seen.reviewer[0].planCheck.status, 'skipped');
  assert.deepEqual(kit.searchClient.calls, []);
});

test('skills: a missing skill registry, a throwing skill, and no README never fail the run and are recorded', async t => {
  const missing = await execute(t, { skills: null });
  assert.equal(missing.summary.status, 'delivered');
  assert.match((await readJson(missing.kit.dataDir, missing.runId, 'plan-check-v1.json')).reason, /not merged/);

  const throwing = await execute(t, { skills: { 'shelf-life': { ...SKILLS['shelf-life'], run: async () => { throw new Error(`exploded with ${FAKE_KEY}`); } } } });
  assert.equal(throwing.summary.status, 'delivered');
  const failed = await readJson(throwing.kit.dataDir, throwing.runId, 'plan-check-v1.json');
  assert.equal(failed.status, 'failed');
  assert.ok(!JSON.stringify(failed).includes(FAKE_KEY));
  assert.equal(throwing.kit.seen.reviewer[0].planCheck.status, 'failed');

  const noReadme = await execute(t);
  assert.equal(noReadme.summary.status, 'delivered');
  const fact = await readJson(noReadme.kit.dataDir, noReadme.runId, 'fact-check.json');
  assert.equal(fact.status, 'skipped');
  assert.match(fact.reason, /no README/);
  assert.equal(ofType(noReadme.events, 'harness.skill.completed').at(-1).payload.reportPath, 'fact-check.json');
});

test('pinned skill model: a non-retryable failure reruns the whole skill once with the next fallback in a NEW child room; no mid-call fallback', async t => {
  const failSonnet = req => (req.responseSchema?.name?.startsWith('shelf_life_') && req.model === REFS.sonnet ? 'provider rejected the request' : false);
  const { kit, summary, events, runId } = await execute(t, { failModel: failSonnet });
  assert.equal(summary.status, 'delivered');
  const started = ofType(events, 'harness.skill.started').filter(e => e.payload.phase === 'plan_check');
  assert.deepEqual(started.map(e => [e.payload.childRoomId, e.payload.model]), [[`${runId}-sl-01`, REFS.sonnet], [`${runId}-sl-02`, REFS.gpt]]);
  const completed = ofType(events, 'harness.skill.completed').filter(e => e.payload.phase === 'plan_check');
  assert.equal(completed[0].payload.status, 'failed');
  assert.equal(completed[0].payload.rerunWith, REFS.gpt);
  assert.equal(completed[1].payload.status, 'completed');
  assert.equal(completed[1].payload.reportPath, 'plan-check-v1.json');
  assert.equal((await readJson(kit.dataDir, runId, 'plan-check-v1.json')).childRoomId, `${runId}-sl-02`);
  // Inside each room every provider request used exactly that room's model.
  for (const [room, model] of [[`${runId}-sl-01`, REFS.sonnet], [`${runId}-sl-02`, REFS.gpt]]) {
    const child = await readLog(kit.dataDir, room);
    assert.ok(child.filter(e => e.type === 'run.started' && e.provenance.model).every(e => e.provenance.model === model), room);
  }
  const requested = kit.modelClient.calls.filter(c => c.schema?.startsWith('shelf_life_')).map(c => c.model);
  assert.equal(requested[0], REFS.sonnet);
  assert.ok(requested.slice(1, 5).every(m => m === REFS.gpt));
  const roomIds = ofType(events, 'harness.skill.started').map(e => e.payload.childRoomId);
  assert.equal(new Set(roomIds).size, roomIds.length, 'unique child rooms');
});

test('fallback: a non-retryable error from the routed model tries the router\'s next model; errors are redacted everywhere on disk', async t => {
  const kit = await makeKit({ builder: ok, failModel: req => (req.model === REFS.haiku && req.messages[0].content === 'build W1' ? true : false) });
  t.after(kit.cleanup);
  // A router whose fallbacks repeat the primary model must not make the engine retry the same failing model.
  const select = kit.deps.router.selectModel;
  kit.deps.router.selectModel = (...args) => { const d = select(...args); return { ...d, fallbacks: [d.model, ...d.fallbacks] }; };
  const handle = startRun({ wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps });
  const summary = await handle.done;
  const events = await readLog(kit.dataDir, handle.runId);
  assert.equal(summary.status, 'delivered');
  const failed = ofType(events, 'run.failed');
  assert.equal(failed.length, 1);
  assert.ok(!failed[0].payload.error.message.includes(FAKE_KEY));
  assert.equal(failed[0].payload.retryable, false);
  const built = ofType(events, 'harness.build.completed')[0];
  assert.notEqual(built.payload.model, REFS.haiku);
  assert.equal(ofType(events, 'run.started').filter(e => e.payload.fallbackFrom === REFS.haiku).length, 1);
  const scan = async dir => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '.git') await scan(p); } else assert.ok(!(await readFile(p, 'utf8')).includes(FAKE_KEY), `key leaked into ${p}`);
    }
  };
  await scan(kit.dataDir);
});

test('spend: unknown costs mark usdSource "unknown" but known costs still count; a fully unknown run reports null, never 0', async t => {
  const mixed = await execute(t, { costPerCall: req => (req.messages[0].content === 'judge' ? null : 0.01) });
  const state = await readRun(mixed.runId, { dataDir: mixed.kit.dataDir });
  assert.equal(state.spend.usdSource, 'unknown');
  assert.ok(state.spend.usd > 0);
  const unknown = await execute(t, { unknownCost: true });
  assert.equal(unknown.summary.spentUsd, null);
  const s2 = await readRun(unknown.runId, { dataDir: unknown.kit.dataDir });
  assert.equal(s2.spend.usd, null);
  assert.equal(s2.spend.inputTokens, null);
  assert.equal(unknown.summary.status, 'delivered');
  assert.ok(ofType(unknown.events, 'harness.budget.updated').every(e => e.payload.spentUsd === null));
  validate(unknown.kit.dataDir, unknown.runId);
});

test('delivered needs real evidence: a tester that claims allPassed with a skipped check, or a tampered acceptance tree, cannot produce "delivered"', async t => {
  const lying = await execute(t, { mutateReport: r => (r.scope.kind === 'all' ? { ...r, allPassed: true, summary: { ...r.summary, skipped: 1 } } : r) });
  assert.equal(lying.summary.status, 'partial');
  assert.equal(ofType(lying.events, 'harness.run.finished')[0].payload.allPassed, false);
  const tampered = await execute(t, { acceptanceIntact: false });
  assert.equal(tampered.summary.status, 'partial');
  const unfit = await execute(t, { reviewFinal: () => ({ verdict: 'iterate', iterateItems: [], gaps: ['Missing polish'] }) });
  assert.equal(unfit.summary.status, 'partial');
  const { kit, runId } = lying;
  assert.ok((await readText(kit.dataDir, runId, 'REPORT.md')).length > 0);
});

test('scaffold passes the scaffold commit and acceptance tree to every runChecks call', async t => {
  const { kit } = await execute(t);
  assert.ok(kit.seen.testerCalls.length >= 3);
  assert.ok(kit.seen.testerCalls.every(c => c.acceptanceTree === 'tree-1' && /^[0-9a-f]{40}$/.test(c.acceptanceCommit)));
});

test('replan: a reflector replan returns to plan once (spec v2), voids the approval, re-scaffolds and still delivers; a second replan request is overridden', async t => {
  const { kit, summary, events, runId } = await execute(t, { reflector: input => (input.item.id === 'W2' && input.attempt === 1 ? 'replan' : undefined),
    builder: (item, attempt) => ({ [`${item.id}.txt`]: item.id === 'W2' && attempt === 1 ? 'bad' : 'ok' }) });
  assert.equal(summary.status, 'delivered');
  assert.equal(kit.seen.planner.length, 2);
  assert.match(kit.seen.planner[1].revision.replanReason, /fake reflector: replan/);
  assert.equal(ofType(events, 'harness.plan.reviewed').length, 2);
  assert.equal((await readJson(kit.dataDir, runId, 'spec.json')).specVersion, 2);
  assert.equal(ofType(events, 'task.created').length, 4);
  assert.equal(ofType(events, 'harness.run.finished')[0].payload.specVersion, 2);
  assert.equal((await readRun(runId, { dataDir: kit.dataDir })).approval.specVersion, 2);
  validate(kit.dataDir, runId);
});

test('final review iterate: one bounded iterate pass over the named items, then final_test again; an iterate that makes things worse is reverted to the best candidate', async t => {
  const better = await execute(t, { reviewFinal: (input, n) => (n === 1 ? { verdict: 'iterate', iterateItems: ['W2'], gaps: ['W2 is weak'] } : {}) });
  assert.equal(better.summary.status, 'delivered');
  assert.deepEqual(phases(better.events).filter(p => p === 'final_test' || p === 'final_review'), ['final_test', 'final_review', 'final_test', 'final_review']);
  const last = better.kit.seen.builderCalls.at(-1);
  assert.equal(last.itemId, 'W2');
  assert.match(last.fixInstructions, /W2 is weak/);

  const worse = await execute(t, { reviewFinal: () => ({ verdict: 'iterate', iterateItems: ['W2'], gaps: ['W2 is weak'] }),
    builder: (item, attempt) => ({ [`${item.id}.txt`]: item.id === 'W2' && attempt > 1 ? 'bad' : 'ok' }) });
  assert.equal(worse.summary.status, 'partial');
  assert.equal(phases(worse.events).filter(p => p === 'final_test').length, 2, 'at most one iterate pass');
  assert.equal(ofType(worse.events, 'harness.candidate.best').filter(e => e.payload.reverted && e.payload.itemId === null).length, 1);
  assert.equal((await readJson(worse.kit.dataDir, worse.runId, 'tests/final.json')).score, 1, 'the delivered product is the best candidate');
  assert.deepEqual(worse.kit.violations, []);
});

test('setup failures: no models and an unavailable sandbox fail fast with a clear message and write a state and report', async t => {
  const none = await makeKit({ builder: ok });
  t.after(none.cleanup);
  none.deps.router = { ...none.deps.router, buildRoster: () => [] };
  const h1 = startRun({ wish: WISH, config: fakeConfig(), dataDir: none.dataDir, deps: none.deps });
  assert.equal((await h1.done).status, 'failed');
  const s1 = await readRun(h1.runId, { dataDir: none.dataDir });
  assert.equal(s1.error.code, 'no_models');
  assert.match(s1.error.message, /Add a provider/);
  assert.ok(!phases(await readLog(none.dataDir, h1.runId)).includes('intake'));

  const bad = await execute(t, { sandboxOk: false });
  assert.equal(bad.summary.status, 'failed');
  assert.equal((await readRun(bad.runId, { dataDir: bad.kit.dataDir })).error.code, 'sandbox_unavailable');
  assert.match(await readText(bad.kit.dataDir, bad.runId, 'REPORT.md'), /permission model/);
  assert.equal(bad.kit.modelClient.calls.length, 0, 'no model call before the sandbox check passes');

  assert.throws(() => startRun({ wish: '', config: fakeConfig(), dataDir: none.dataDir, deps: none.deps }), /wish/);
});

test('a fatal engine error is recorded redacted in state.error and the run ends failed with a report (never swallowed)', async t => {
  const kit = await makeKit({ builder: ok });
  t.after(kit.cleanup);
  kit.deps.tester = { ...kit.deps.tester, materializeAcceptance: async () => { throw Object.assign(new Error(`disk exploded ${FAKE_KEY}`), { code: 'disk_error' }); } };
  const handle = startRun({ wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps });
  assert.equal((await handle.done).status, 'failed');
  const state = await readRun(handle.runId, { dataDir: kit.dataDir });
  assert.equal(state.error.code, 'disk_error');
  assert.ok(!state.error.message.includes(FAKE_KEY));
  assert.match(state.error.message, /disk exploded/);
});

function quotaFixture(providerIds) {
  const base = fakeConfig();
  const models = [REFS.fable, REFS.opus, REFS.sonnet, REFS.haiku].map(ref => ({
    id: ref.split('/')[1], enabled: true,
  }));
  return { ...base, providers: providerIds.map(id => ({ ...base.providers[0], id, models })) };
}

const QUOTA_RESET = '2099-12-12T15:20:00.000Z';
function providerLimit(code = 'quota_exhausted', extra = {}) {
  return Object.assign(new Error('Provider diagnostic with ' + FAKE_KEY), {
    code, retryable: code === 'rate_limit', resetAt: QUOTA_RESET, ...extra,
  });
}

test('API quota pauses with a durable partial result, reset time and completed work', async t => {
  const { kit, summary, events, runId } = await execute(t, {
    search: false, config: quotaFixture(['anthropic']), depsOverride: { router: quotaRouter },
    onComplete: (_req, call) => { if (call.content === 'build W2') throw providerLimit(); },
  });
  assert.equal(summary.status, 'partial');
  assert.equal(summary.pausedReason, 'api_quota');
  assert.equal(summary.resumeAt, QUOTA_RESET);
  assert.equal(kit.modelClient.calls.at(-1).content, 'build W2');
  assert.equal(kit.modelClient.calls.filter(call => call.content === 'build W2').length, 1);
  const state = await readRun(runId, { dataDir: kit.dataDir });
  assert.equal(state.pausedReason, 'api_quota');
  assert.equal(state.resumeAt, QUOTA_RESET);
  assert.equal(state.items.W1.status, 'passed');
  assert.match(state.best.commit, /^[a-f0-9]{40}$/);
  assert.equal(await readText(kit.dataDir, runId, 'workspace/W1.txt'), 'ok');
  assert.equal((await readJson(kit.dataDir, runId, 'spec.json')).specVersion, 1);
  assert.match(await readText(kit.dataDir, runId, 'progress.md'), /Paused for API quota/);
  const report = await readText(kit.dataDir, runId, 'REPORT.md');
  assert.match(report, /Completed work items: W1/);
  assert.ok(report.includes(QUOTA_RESET) && report.includes(state.best.commit));
  assert.match(report, /Start a fresh run after the quota resets/);
  assert.equal(ofType(events, 'harness.run.finished')[0].payload.pausedReason, 'api_quota');
  assert.deepEqual(ofType(events, 'harness.provider.limited').map(e => e.payload), [{
    provider: 'anthropic', kind: 'quota_exhausted', resetAt: QUOTA_RESET,
    reason: 'anthropic API quota reached until ' + QUOTA_RESET + ', no fallback is available.',
  }]);
  assert.ok(!JSON.stringify(events).includes(FAKE_KEY) && !report.includes(FAKE_KEY));
});

test('API quota excludes all models of that configured provider only for the current run', async t => {
  const { kit, summary, events } = await execute(t, {
    search: false, config: quotaFixture(['anthropic', 'backup']), depsOverride: { router: quotaRouter },
    onComplete: (_req, call) => {
      if (call.model === REFS.haiku && call.content === 'build W1') throw providerLimit();
    },
  });
  assert.equal(summary.status, 'delivered');
  assert.equal(summary.pausedReason, undefined);
  const calls = kit.modelClient.calls;
  const limited = calls.findIndex(call => call.model === REFS.haiku && call.content === 'build W1');
  assert.ok(limited >= 0);
  assert.equal(calls[limited + 1].model, 'backup/' + REFS.haiku.split('/')[1]);
  assert.ok(calls.slice(limited + 1).every(call => call.model.startsWith('backup/')));
  assert.deepEqual(ofType(events, 'harness.provider.limited').map(({ payload }) => payload.kind), ['quota_exhausted']);
  assert.match(ofType(events, 'harness.provider.limited')[0].payload.reason, /continuing with backup/);
  const nextRun = startRun({ wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps });
  const firstCallIndex = calls.length;
  await nextRun.done;
  assert.match(calls[firstCallIndex].model, /^anthropic\//, 'a separate run may use the provider again');
});

test('a short rate limit uses a same-tier fallback and keeps the original provider available', async t => {
  const { kit, events, summary } = await execute(t, {
    search: false, config: quotaFixture(['anthropic', 'backup']), depsOverride: { router: quotaRouter },
    onComplete: (_req, call) => {
      if (call.model === REFS.haiku && call.content === 'build W1') throw providerLimit('rate_limit', { resetAt: null });
    },
  });
  assert.equal(summary.status, 'delivered');
  assert.equal(summary.pausedReason, undefined);
  const calls = kit.modelClient.calls;
  const limited = calls.findIndex(call => call.model === REFS.haiku && call.content === 'build W1');
  assert.ok(limited >= 0);
  assert.equal(calls[limited + 1].model, 'backup/' + REFS.haiku.split('/')[1]);
  assert.ok(calls.slice(limited + 2).some(call => call.model.startsWith('anthropic/')));
  const [event] = ofType(events, 'harness.provider.limited');
  assert.equal(event.payload.kind, 'rate_limit');
  assert.equal(event.payload.resetAt, null);
});

test('a quota error that reaches the configured USD limit keeps the budget outcome separate', async t => {
  const { kit, summary, events, runId } = await execute(t, {
    search: false, config: quotaFixture(['anthropic']), depsOverride: { router: quotaRouter },
    onComplete: (_req, call) => {
      if (call.content === 'build W2') throw providerLimit('quota_exhausted', {
        usage: { inputTokens: 2, outputTokens: 2, costUsd: 5, source: 'provider' },
      });
    },
  });
  assert.equal(summary.status, 'partial');
  assert.equal(summary.pausedReason, undefined);
  assert.equal(summary.resumeAt, undefined);
  assert.ok(ofType(events, 'harness.budget.updated').some(e => e.payload.exceeded === 'usd'));
  assert.equal(kit.modelClient.calls.at(-1).content, 'build W2');
  assert.match(await readText(kit.dataDir, runId, 'REPORT.md'), /the usd limit was reached/);
});

test('cancellation wins over a concurrent quota error', async t => {
  const kit = await makeKit({
    builder: ok, search: false, config: quotaFixture(['anthropic', 'backup']), depsOverride: { router: quotaRouter },
    onComplete: (_req, call) => {
      if (call.content === 'build W2') {
        handle.cancel('stop requested');
        throw providerLimit();
      }
    },
  });
  t.after(kit.cleanup);
  const handle = startRun({ wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps });
  const summary = await handle.done;
  const events = await readLog(kit.dataDir, handle.runId);
  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.pausedReason, undefined);
  assert.equal(ofType(events, 'harness.provider.limited').length, 0);
  assert.equal(kit.modelClient.calls.at(-1).content, 'build W2');
});

test('API quota during intake saves an honest report with an unknown reset and no product', async t => {
  const { kit, summary, events, runId } = await execute(t, {
    search: false, config: quotaFixture(['anthropic']), depsOverride: { router: quotaRouter },
    onComplete: () => { throw providerLimit('quota_exhausted', { resetAt: null }); },
  });
  assert.equal(summary.status, 'partial');
  assert.equal(summary.resumeAt, null);
  assert.equal(summary.workspaceDir, null);
  assert.equal(kit.modelClient.calls.length, 1);
  const report = await readText(kit.dataDir, runId, 'REPORT.md');
  assert.match(report, /provider did not supply a reset time/);
  assert.match(report, /Nothing to run yet/);
  assert.match(report, /No checks were run/);
  assert.equal(ofType(events, 'harness.run.finished')[0].payload.resumeAt, null);
});

test('when every configured provider is exhausted the earliest future reset is reported', async t => {
  const { kit, summary, events } = await execute(t, {
    search: false, config: quotaFixture(['anthropic', 'backup']), depsOverride: { router: quotaRouter },
    onComplete: (_req, call) => {
      if (call.content === 'build W1') throw providerLimit('quota_exhausted', {
        resetAt: call.model.startsWith('anthropic/') ? QUOTA_RESET : '2099-12-12T12:00:00.000Z',
      });
    },
  });
  assert.equal(summary.status, 'partial');
  assert.equal(summary.resumeAt, '2099-12-12T12:00:00.000Z');
  assert.deepEqual(kit.modelClient.calls.filter(call => call.content === 'build W1').map(call => call.model.split('/')[0]), ['anthropic', 'backup']);
  assert.deepEqual(ofType(events, 'harness.provider.limited').map(e => e.payload.provider), ['anthropic', 'backup']);
});
