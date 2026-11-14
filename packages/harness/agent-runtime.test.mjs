import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from './agent-runtime.mjs';

const tool = (name, args = {}) => ({ type: 'tool', content: '', name, argumentsJson: JSON.stringify(args) });
const final = content => ({ type: 'final', content, name: '', argumentsJson: '' });
const response = value => ({ value, model: 'actual-model', usage: null, stopReason: 'end' });

test('role restrictions deny search even when supplied for developer and tester', async () => {
  for (const role of ['developer', 'tester']) {
    let called = false, count = 0, feedback;
    const result = await runAgent({ role, task: 'test', tools: { search: async () => { called = true; } }, model: async ({ input, system }) => {
      assert.ok(!system.includes('Shelf Life research instructions'));
      if (count++ === 0) return response(tool('search'));
      feedback = JSON.parse(input).at(-1).content;
      return response(final('Denied'));
    }, skillText: 'private skill' });
    assert.equal(called, false);
    assert.match(feedback, /unauthorized/);
    assert.equal(result.status, 'completed');
  }
});

test('tool failures reach the model and are logged as errors', async () => {
  let count = 0, feedback;
  const events = [];
  const result = await runAgent({ role: 'developer', task: 'fix', taskId: 'task-1', modelId: 'configured-model', writer: { append: async event => events.push(event) },
    tools: { 'run-tests': async () => { throw new Error('Tests failed: 3'); } }, model: async ({ input }) => {
      if (count++ === 0) return response(tool('run-tests'));
      feedback = JSON.parse(input).at(-1).content;
      return response(final('Tests failed'));
    } });
  assert.match(feedback, /Tests failed: 3/);
  assert.equal(events.find(e => e.type === 'tool.result').payload.status, 'error');
  assert.equal(events[0].provenance.memberId, 'developer');
  assert.equal(events.at(-1).provenance.role, 'developer');
  assert.equal(events.at(-1).provenance.model, 'actual-model');
  assert.equal(events.at(-1).provenance.identitySource, 'provider_reported');
  assert.ok(events.every(e => e.taskId === 'task-1' && e.runId === events[0].runId));
  assert.equal(result.usage.inputTokens, null);
});

test('bounded execution reports step limit as failure', async () => {
  const events = [];
  const result = await runAgent({ role: 'support', task: 'help', maxSteps: 2, writer: { append: async e => events.push(e) }, tools: { 'read-file': async () => 'data' }, model: async () => response(tool('read-file')) });
  assert.equal(result.status, 'step_limit');
  assert.equal(result.steps, 2);
  assert.equal(events.at(-1).type, 'run.failed');
  assert.equal(events.at(-1).payload.error.code, 'step_limit');
});

test('malformed actions fail and are recorded', async () => {
  const events = [];
  await assert.rejects(runAgent({ role: 'planner', task: 'plan', writer: { append: async e => events.push(e) }, model: async () => response({ type: 'final', content: 'hi' }) }), /Invalid model action/);
  assert.equal(events.at(-1).type, 'run.failed');
});

test('research instructions and host-authorized tester tools are scoped', async () => {
  let invoked = false;
  await runAgent({ role: 'planner', task: 'plan', skillText: 'SHELF TEXT', model: async ({ system }) => { assert.match(system, /SHELF TEXT/); return response(final('plan')); } });
  let count = 0;
  await runAgent({ role: 'tester', task: 'test', tools: { 'write-test': async () => { invoked = true; } }, model: async () => response(count++ ? final('done') : tool('write-test')) });
  assert.equal(invoked, true);
});

test('multi-turn usage aggregates measured values and retains uncertainty', async () => {
  const events = []; let count = 0;
  const result = await runAgent({ role: 'support', task: 'help', writer: { append: async e => events.push(e) }, tools: { 'list-files': async () => [] }, model: async ({ system }) => {
    assert.match(system, /list-files \{\}/);
    return count++ === 0
      ? { value: tool('list-files'), usage: { inputTokens: 10, outputTokens: 4, costUsd: null, source: 'provider' } }
      : { value: final('done'), usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.2, source: 'estimated' } };
  } });
  assert.deepEqual(result.usage, { inputTokens: 18, outputTokens: 7, costUsd: null, source: 'estimated' });
  assert.deepEqual(events.at(-1).payload.usage, result.usage);
  const invalid = await runAgent({ role: 'support', task: 'help', model: async () => ({ value: final('done'), usage: { inputTokens: -1, outputTokens: Infinity, costUsd: 0, source: 'provider' } }) });
  assert.deepEqual(invalid.usage, { inputTokens: null, outputTokens: null, costUsd: 0, source: 'provider' });
});

test('oversized model output is rejected', async () => {
  await assert.rejects(runAgent({ role: 'support', task: 'help', model: async () => response(final('a'.repeat(48001))) }), /size limit/);
});

test('unknown usage sources cannot turn numeric zero into measured usage', async () => {
  let calls = 0;
  const result = await runAgent({ role: 'support', task: 'help', tools: { 'list-files': async () => [] }, model: async () => ++calls === 1
    ? { value: tool('list-files'), usage: { inputTokens: 5, outputTokens: 3, costUsd: 0.01, source: 'provider' } }
    : { value: final('done'), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, source: 'unknown' } } });
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, costUsd: null, source: 'unknown' });
  const allUnknown = await runAgent({ role: 'support', task: 'help', model: async () => ({ value: final('done'), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, source: 'other' } }) });
  assert.deepEqual(allUnknown.usage, { inputTokens: null, outputTokens: null, costUsd: null, source: 'unknown' });
  const fractional = await runAgent({ role: 'support', task: 'help', model: async () => ({ value: final('done'), usage: { inputTokens: 0.5, outputTokens: Number.MAX_SAFE_INTEGER + 1, costUsd: 0.25, source: 'provider' } }) });
  assert.deepEqual(fractional.usage, { inputTokens: null, outputTokens: null, costUsd: 0.25, source: 'provider' });
});
