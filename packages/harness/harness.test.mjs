import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, authorizeTool, routeIntent } from './index.mjs';
import { runCodingAgent } from './coding-agent.mjs';

const memoryWriter = () => ({ events: [], async append(event) { this.events.push(structuredClone(event)); return event; } });

test('plan confirmation, version binding, documentation and failed-test handoff', async () => {
  const writer = memoryWriter();
  const h = createHarness({ writer });
  await h.start('Create a project');
  const plan = await h.proposePlan('Build the agreed application');
  await assert.rejects(h.confirmPlan(plan.digest), /research/);
  await assert.rejects(h.recordResearch({ planDigest: 'old', assessment: 'current_supported', sources: [] }), /current plan/);
  await assert.rejects(h.recordResearch({ planDigest: plan.digest, assessment: 'current_supported', sources: [] }), /dated source/);
  await h.recordResearch({ planDigest: plan.digest, assessment: 'current_supported', sources: [{ url: 'https://example.org/reference', retrievedAt: '2026-11-14T12:00:00Z' }] });
  await assert.rejects(h.confirmPlan('wrong'), /current plan/);
  await h.confirmPlan(plan.digest);
  await h.submitCode('commit-1');
  await h.submitManual('Run the application.');
  await assert.rejects(h.submitTest({ candidate: 'old', passed: true, evidence: 'test output' }), /candidate/);
  await h.submitTest({ candidate: 'commit-1', passed: false, evidence: 'failure output' });
  assert.equal(h.snapshot().phase, 'development');
  assert.equal(h.snapshot().tasks.at(-1).role, 'developer');
  assert.equal(writer.events[0].payload.driver, 'harness');
});

test('search access and explicit intent routing are role constrained', () => {
  for (const role of ['developer', 'tester', 'support']) assert.equal(authorizeTool(role, 'search'), false);
  for (const role of ['planner', 'project_manager', 'presales']) assert.equal(authorizeTool(role, 'shelf-life'), true);
  assert.equal(routeIntent('progress'), 'project_manager');
  assert.equal(routeIntent('unknown'), null);
});

test('coding agent uses tools, gets failures, and cannot invoke search', async () => {
  let calls = 0;
  const result = await runCodingAgent({ task: 'Implement a feature', tools: { 'run-tests': async () => { throw new Error('failed'); } }, model: async history => {
    calls++;
    return calls === 1 ? { type: 'tool', name: 'run-tests', arguments: {} } : { type: 'final', content: history.at(-1).content };
  } });
  assert.match(result.output, /failed/);
  await assert.rejects(runCodingAgent({ task: 'x', tools: { search: async () => '' }, model: async () => ({ type: 'tool', name: 'search' }) }), /unauthorized/);
});

async function plannedHarness() {
  const writer = memoryWriter();
  const harness = createHarness({ writer });
  await harness.start('Demo project');
  const plan = await harness.proposePlan('Plan one');
  await harness.recordResearch({ planDigest: plan.digest, assessment: 'current_supported', sources: [{ url: 'https://example.org/reference', retrievedAt: '2026-11-14T12:00:00Z' }] });
  return { harness, writer, plan };
}

test('concurrent repeated confirmation dispatches development once', async () => {
  const { harness, plan } = await plannedHarness();
  const results = await Promise.allSettled([harness.confirmPlan(plan.digest), harness.confirmPlan(plan.digest)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(harness.snapshot().tasks.filter(t => t.role === 'developer').length, 1);
});

test('replanning invalidates the candidate, manual, research and prior approval', async () => {
  const { harness, plan } = await plannedHarness();
  await harness.confirmPlan(plan.digest);
  await harness.submitCode('candidate-1');
  await harness.submitManual('Old manual');
  await harness.proposePlan('Revised plan');
  const state = harness.snapshot();
  assert.equal(state.candidate, null);
  assert.equal(state.manual, null);
  assert.equal(state.report, null);
  assert.equal(state.plan.confirmed, false);
  await assert.rejects(harness.submitCode('candidate-2'), /approved/);
});

test('research cannot change an approved execution or accept future-dated sources', async () => {
  const { harness, plan } = await plannedHarness();
  await harness.confirmPlan(plan.digest);
  await assert.rejects(harness.recordResearch({ planDigest: plan.digest, assessment: 'unresolved', sources: [] }), /planning/);
  await harness.proposePlan('Another proposal');
  await assert.rejects(harness.recordResearch({ planDigest: harness.snapshot().plan.digest, assessment: 'current_supported', sources: [{ url: 'https://example.org/', retrievedAt: '2999-01-01T00:00:00Z' }] }), /dated source/);
});

test('unrecognized intents cannot resolve through Object.prototype', () => {
  for (const intent of ['constructor', '__proto__', 'toString']) assert.equal(routeIntent(intent), null);
});

test('coding agent exhausts its step limit without claiming completion', async () => {
  let calls = 0;
  const result = await runCodingAgent({ task: 'Looping model', maxSteps: 2, tools: { 'read-file': async () => { calls++; return 'contents'; } }, model: async () => ({ type: 'tool', name: 'read-file', arguments: {} }) });
  assert.equal(result.status, 'step_limit');
  assert.equal(result.output, null);
  assert.equal(calls, 2);
});
