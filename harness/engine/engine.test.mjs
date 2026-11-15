import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { RUN_ID_PATTERN, listRuns, readRun, startRun } from './index.mjs';
import { REFS, makeKit, makeSpec, readJson, readLog, readText } from './testkit.mjs';

const validator = fileURLToPath(new URL('../../samples/validate-events.mjs', import.meta.url));
const WISH = 'I want a page that tells me if I need an umbrella in London tomorrow';
const README_OLD = '# Umbrella\nForecast data is free for 10,000 calls per day.\n';
const defaultBuilder = item => (item.id === 'W2' ? { 'W2.txt': 'ok', 'README.md': README_OLD } : { [`${item.id}.txt`]: 'ok' });

async function execute(t, opts = {}, run = {}) {
  const kit = await makeKit({ builder: defaultBuilder, ...opts });
  t.after(kit.cleanup);
  const handle = startRun({ wish: WISH, config: kit.config, dataDir: kit.dataDir, deps: kit.deps, ...run });
  const summary = await handle.done;
  const events = await readLog(kit.dataDir, handle.runId);
  return { kit, handle, summary, events, runId: handle.runId };
}
const types = events => events.map(e => e.type);
const phases = events => events.filter(e => e.type === 'harness.phase.changed').map(e => e.payload.phase);
const ofType = (events, type) => events.filter(e => e.type === type);
const validate = (dataDir, runId) => {
  const out = execFileSync(process.execPath, [validator, join(dataDir, 'rooms', runId, 'events.jsonl')], { encoding: 'utf8', windowsHide: true });
  assert.match(out, /0 problem\(s\)/);
  return out;
};

test('happy path: two items pass first time, the run is delivered, the log validates and carries the key events in order', async t => {
  const { kit, summary, events, runId } = await execute(t);
  assert.match(runId, RUN_ID_PATTERN);
  assert.equal(summary.status, 'delivered');
  assert.equal(summary.finalScore, 1);
  assert.equal(summary.previewPath, 'index.html');
  assert.equal(summary.reportPath, join(kit.dataDir, 'harness', 'runs', runId, 'REPORT.md'));
  assert.deepEqual(phases(events), ['intake', 'research', 'plan', 'plan_check', 'plan_review', 'scaffold', 'build', 'test', 'reflect', 'build', 'test', 'reflect', 'final_test', 'final_review', 'fact_check', 'report', 'done']);
  assert.equal(events[0].type, 'room.created');
  assert.equal(events[0].payload.driver, 'harness');
  assert.equal(events.at(-1).type, 'room.closed');
  assert.equal(events.at(-1).payload.status, 'completed');
  assert.equal(events.at(-2).type, 'harness.run.finished');
  const finished = events.at(-2).payload;
  assert.equal(finished.status, 'delivered');
  assert.equal(finished.allPassed, true);
  assert.equal(finished.specVersion, 1);
  assert.equal(finished.reportPath, 'REPORT.md');
  assert.equal(finished.candidate, (await readJson(kit.dataDir, runId, 'tests/final.json')).candidate);
  // task.created for every item, after plan approval and before the scaffold phase change.
  const idx = type => events.findIndex(e => e.type === type);
  assert.ok(idx('harness.plan.reviewed') < idx('task.created') && idx('task.created') < events.findIndex(e => e.type === 'harness.phase.changed' && e.payload.phase === 'scaffold'));
  assert.deepEqual(ofType(events, 'task.created').map(e => e.taskId), ['W1', 'W2']);
  assert.deepEqual(ofType(events, 'task.done').map(e => e.taskId), ['W1', 'W2']);
  assert.ok(ofType(events, 'task.done').every(e => e.payload.verifiedBy === 'check' && e.payload.evidence.length === 1));
  // Every model call has run.started then run.completed under one call id, and the router reason is recorded.
  for (const started of ofType(events, 'run.started')) {
    const done = events.find(e => e.runId === started.runId && (e.type === 'run.completed' || e.type === 'run.failed'));
    assert.ok(done, `no terminal event for ${started.runId}`);
  }
  assert.ok(ofType(events, 'harness.route.selected').every(e => e.payload.reason && e.payload.model && e.payload.role));
  assert.ok(ofType(events, 'harness.budget.updated').length > 5);
  validate(kit.dataDir, runId);
  assert.deepEqual(kit.violations, []);

  // state.json, approval binding and artifacts.
  const state = await readRun(runId, { dataDir: kit.dataDir });
  assert.equal(state.status, 'delivered');
  assert.equal(state.phase, 'done');
  assert.equal(state.approval.by, 'model');
  assert.equal(state.approval.specVersion, 1);
  const specBytes = await readFile(join(kit.dataDir, 'harness', 'runs', runId, 'spec.json'));
  assert.equal(state.approval.specSha256, createHash('sha256').update(specBytes).digest('hex'));
  assert.equal(state.approval.reviewRef, 'plan-review.json');
  const review = await readJson(kit.dataDir, runId, 'plan-review.json');
  assert.equal(review.specSha256, state.approval.specSha256);
  assert.equal(review.reviewerCallId, state.approval.callId);
  assert.equal(state.approval.model, REFS.opus);
  assert.notEqual(review.reviewerModel, kit.seen.planner.length && REFS.fable);
  assert.equal(state.spend.usdSource, 'provider');
  assert.ok(state.spend.usd > 0);
  assert.equal(state.items.W1.status, 'passed');
  assert.deepEqual(Object.keys(state.limits), ['maxUsdPerRun', 'maxMinutesPerRun', 'maxBuildIterations']);
  const files = await readdir(join(kit.dataDir, 'harness', 'runs', runId));
  for (const f of ['wish.txt', 'brief.json', 'research.json', 'spec.json', 'plan-review.json', 'plan-facts-v1.md', 'plan-check-v1.json', 'fact-check.json', 'final-review.json', 'progress.md', 'REPORT.md', 'state.json']) assert.ok(files.includes(f), f);
  assert.match(await readText(kit.dataDir, runId, 'progress.md'), /## Iteration 2 — W2/);
  assert.deepEqual((await listRuns({ dataDir: kit.dataDir })).map(r => r.runId), [runId]);
  assert.equal(await readRun('../../etc', { dataDir: kit.dataDir }), null);
});

test('plan_check: a two-source stale fact forces a revision with the correction, then the corrected plan is approved', async t => {
  const { kit, summary, events, runId } = await execute(t, { shelf: { plan: 'stale' } });
  assert.equal(summary.status, 'delivered');
  const reviews = ofType(events, 'harness.plan.reviewed');
  assert.equal(reviews.length, 2, 'stale plan → one forced revision → approved');
  assert.equal(reviews[0].payload.verdict, 'revise');   // the fake reviewer said approve; the engine's hard rule overrode it
  assert.equal(reviews[0].payload.approval, null);
  assert.ok(reviews[0].payload.engineOverrides.some(o => o.startsWith('plan_check:')));
  assert.equal(reviews[1].payload.verdict, 'approve');
  assert.equal(reviews[1].payload.approval.specVersion, 2);
  const check1 = await readJson(kit.dataDir, runId, 'plan-check-v1.json');
  assert.equal(check1.status, 'completed');
  assert.equal(check1.findings[0].verdict, 'stale');
  assert.equal(check1.findings[0].currentValue, '5,000');
  assert.ok(check1.findings[0].checks.filter(c => ['independent_sources', 'correction_supported'].includes(c.check)).every(c => c.passed));
  assert.equal(check1.reviewStatus, 'unreviewed');
  // The reviewer got the check; the planner got the correction as a required change, with sources.
  assert.equal(kit.seen.reviewer[0].planCheck.status, 'completed');
  const required = kit.seen.planner[1].revision.review.requiredChanges.join('\n');
  assert.match(required, /^Update plan fact: the free API allows 10,000 calls per day to 5,000 \(sources: /);
  assert.ok(required.includes('https://docs.weather-api.example/limits') && required.includes('https://dev-forum.example.net/limits'));
  // v2 is rendered with the correction and verifies fresh; reports carry the spec version.
  const facts2 = await readText(kit.dataDir, runId, 'plan-facts-v2.md');
  assert.match(facts2, /^Open-Meteo free tier allows 5,000 calls per day\.\nSource: https:\/\/(?:docs\.weather-api|dev-forum)\./m);
  assert.ok(!facts2.includes('10,000'));
  assert.equal((await readJson(kit.dataDir, runId, 'plan-check-v2.json')).findings[0].verdict, 'fresh');
  assert.equal((await readJson(kit.dataDir, runId, 'plan-review.json')).specVersion, 2);
  // The plan-check approval is bound to spec v2 only.
  assert.equal((await readRun(runId, { dataDir: kit.dataDir })).approval.specVersion, 2);
  validate(kit.dataDir, runId);
});

test('plan_check: insufficient evidence stays unsure, is passed to the reviewer, and does not block approval', async t => {
  const { kit, summary, events, runId } = await execute(t, { shelf: { plan: 'insufficient' } });
  assert.equal(summary.status, 'delivered');
  const reviews = ofType(events, 'harness.plan.reviewed');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].payload.verdict, 'approve');
  assert.deepEqual(reviews[0].payload.engineOverrides, []);
  const check = await readJson(kit.dataDir, runId, 'plan-check-v1.json');
  assert.equal(check.status, 'completed');
  assert.equal(check.findings[0].verdict, 'unsure');
  assert.equal(check.diff, null);
  assert.equal(kit.seen.reviewer[0].planCheck.findings[0].verdict, 'unsure');
  const started = ofType(events, 'harness.skill.completed').find(e => e.payload.phase === 'plan_check');
  assert.equal(started.payload.status, 'completed');
  assert.equal(started.payload.staleCount, 0);
  assert.equal(started.payload.reportPath, 'plan-check-v1.json');
});

test('fact_check: audits workspace/README.md in its own child room; stale findings go in fact-check.json and never change the status', async t => {
  const { kit, summary, events, runId } = await execute(t, { shelf: { plan: 'stale' } });
  assert.equal(summary.status, 'delivered');
  const started = ofType(events, 'harness.skill.started');
  const completed = ofType(events, 'harness.skill.completed');
  assert.deepEqual(started.map(e => e.payload.phase), ['plan_check', 'plan_check', 'fact_check']);
  assert.deepEqual(started.map(e => e.payload.childRoomId), [`${runId}-sl-01`, `${runId}-sl-02`, `${runId}-sl-03`]);
  assert.ok(started.every(e => e.payload.role === 'researcher' && e.payload.skillId === 'shelf-life' && e.payload.version === '1.0.0'));
  assert.equal(completed.at(-1).payload.reportPath, 'fact-check.json');
  assert.equal(completed.at(-1).payload.childRoomId, `${runId}-sl-03`);
  assert.equal(completed.at(-1).payload.staleCount, 1);
  const fact = await readJson(kit.dataDir, runId, 'fact-check.json');
  assert.equal(fact.status, 'completed');
  assert.equal(fact.childRoomId, `${runId}-sl-03`);
  assert.equal(fact.doc.label, 'README.md');
  assert.equal(fact.findings[0].verdict, 'stale');
  assert.match(fact.diff, /\+Forecast data is free for 5,000 calls per day\./);
  assert.equal(kit.seen.reporter.factCheck.status, 'completed');
  assert.equal(kit.seen.reporter.planCheck?.status, 'completed');
  // The skill wrote its audit into its OWN child room, never into the parent log.
  const child = await readLog(kit.dataDir, `${runId}-sl-03`);
  assert.equal(child[0].payload.parentRoomId, runId);
  assert.ok(child.some(e => e.type.startsWith('shelflife.')));
  assert.ok(!events.some(e => e.type.startsWith('shelflife.')));
  assert.equal(events.filter(e => e.type === 'room.created').length, 1);
  for (const n of ['01', '02', '03']) validate(kit.dataDir, `${runId}-sl-${n}`);
  validate(kit.dataDir, runId);
});

test('pinned skill model: every provider request of one skill call goes to exactly providerIdentity.model, equal to the child room provenance', async t => {
  const { kit, events, runId } = await execute(t);
  const skillCalls = kit.modelClient.calls.filter(c => c.schema?.startsWith('shelf_life_'));
  assert.ok(skillCalls.length >= 4);
  const started = ofType(events, 'harness.skill.started');
  const byRoom = new Map();
  for (const s of started) byRoom.set(s.payload.childRoomId, s.payload.model);
  assert.equal(new Set(byRoom.values()).size, 1);
  const routed = [...byRoom.values()][0];
  assert.ok(skillCalls.every(c => c.model === routed), 'the client only ever received the pinned model');
  for (const roomId of byRoom.keys()) {
    const child = await readLog(kit.dataDir, roomId);
    const recorded = child.filter(e => e.type === 'run.started' && e.provenance.model).map(e => e.provenance.model);
    assert.ok(recorded.length > 0);
    assert.ok(recorded.every(m => m === routed), `child room ${roomId} recorded ${recorded}`);
    assert.ok(child.filter(e => e.type === 'run.started' && e.provenance.model).every(e => e.provenance.provider === 'anthropic'));
  }
});
