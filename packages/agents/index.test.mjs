import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentAdapter } from './index.mjs';
const tool = { name: 'read', description: 'Read', inputSchema: { type: 'object' } };
const context = { project: { id: 'secret-project-id', goal: 'goal', constraints: [], stage: 'build' }, task: { id: 'secret-task-id', title: 'task', kind: 'build', dependencies: [], workspace: {} }, profile: { id: 'secret-profile-id', backend: 'b', model: 'p/m', tools: ['read'] }, plan: null, candidate: null, delivery: null };
const result = (stopReason, calls = [], text = '') => ({ model: 'p/m', stopReason, text, toolCalls: calls, usage: { source: 'provider', inputTokens: 0, outputTokens: 0, costUsd: 0 }, assistantMessage: { role: 'assistant', content: calls.map(c => ({ type: 'tool_call', id: c.id, name: c.name, input: c.input })) } });
const call = (id = 'model-id', name = 'read', input = { path: 'a' }) => ({ id, name, input });
const make = (complete, limits) => createAgentAdapter({ id: 'adapter', backend: 'b', model: 'p/m', client: { complete }, system: 'fixed', tools: [tool], limits });
const run = (adapter, callTool = async () => 'ok', signal = new AbortController().signal, ctx = context) => adapter.execute({ context: ctx, signal, callTool });
const rejects = (p, code) => assert.rejects(p, e => e.code === code && !e.message.includes('secret'));

test('neutral tool loop preserves model, signal, assistant message and tool result', async () => {
  const requests = []; const operations = []; const signal = new AbortController().signal;
  const first = result('tool_use', [call()]);
  const adapter = make(async req => { requests.push(req); return requests.length === 1 ? first : result('end', [], 'done'); });
  const output = await run(adapter, async op => { operations.push(op); return { text: 'data' }; }, signal);
  assert.deepEqual(output, { output: 'done', usage: { source: 'provider', inputTokens: 0, outputTokens: 0, costUsd: 0 } });
  assert.equal(requests[0].model, 'p/m'); assert.equal(requests[0].signal, signal); assert.equal(requests[0].system, 'fixed');
  assert.deepEqual(requests[1].messages[1], first.assistantMessage);
  assert.deepEqual(requests[1].messages[2], { role: 'user', content: [{ type: 'tool_result', toolCallId: 'model-id', content: '{"text":"data"}' }] });
  assert.deepEqual(operations, [{ callId: 'call-1', name: 'read', args: { path: 'a' } }]);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /secret-(project|task|profile)-id/);
});
test('unregistered tools are rejected without runtime access', async () => {
  let n = 0, calls = 0, feedback;
  const a = make(async req => { if (!n++) return result('tool_use', [call('x', 'shell')]); feedback = req.messages.at(-1).content[0]; return result('end', [], 'ok'); });
  await run(a, async () => calls++); assert.equal(calls, 0); assert.equal(feedback.content, 'TOOL_NOT_REGISTERED'); assert.equal(feedback.isError, true);
});
test('profile cannot change configured model or backend', async () => {
  let called = false; const a = make(async () => { called = true; return result('end'); });
  await rejects(run(a, undefined, undefined, { ...context, profile: { ...context.profile, model: 'evil/m' } }), 'PROFILE_MISMATCH'); assert.equal(called, false);
});
test('duplicate ids are idempotent and changed input conflicts', async () => {
  let n = 0, count = 0;
  const a = make(async () => n++ ? result('end', [], 'ok') : result('tool_use', [call('x'), call('x')]));
  await run(a, async () => { count++; return 'ok'; }); assert.equal(count, 1);
  const b = make(async () => result('tool_use', [call('x'), call('x', 'read', { path: 'b' })]));
  await rejects(run(b), 'TOOL_ID_CONFLICT');
});
test('truncated, refusal, and malformed final responses fail', async () => {
  for (const reason of ['max_tokens', 'refusal', 'other']) await rejects(run(make(async () => result(reason))), 'INCOMPLETE_RESPONSE');
  await rejects(run(make(async () => ({ stopReason: 'end', toolCalls: [], text: NaN }))), 'INVALID_RESPONSE');
});
test('turn, call, size and invalid JSON limits are enforced', async () => {
  await rejects(run(make(async () => result('tool_use', [call()]), { maxTurns: 1 })), 'TURN_LIMIT');
  await rejects(run(make(async () => result('tool_use', [call('x'), call('y')]), { maxToolCalls: 1 })), 'TOOL_LIMIT');
  await rejects(run(make(async () => result('end', [], 'large'), { maxOutputBytes: 3 })), 'SIZE_LIMIT');
  await rejects(run(make(async () => result('tool_use', [call('x', 'read', { n: NaN })]))), 'INVALID_JSON');
  assert.throws(() => make(async () => result('end'), { maxJsonBytes: 10 }), { code: 'SIZE_LIMIT' });
  await rejects(run(make(async () => result('end'), { maxHistoryBytes: 10 })), 'SIZE_LIMIT');
});
test('unknown usage stays unknown and estimated aggregates', async () => {
  const a = make(async () => ({ ...result('end', [], 'ok'), usage: null })); assert.deepEqual((await run(a)).usage, { source: 'unknown', inputTokens: null, outputTokens: null, costUsd: null });
  let n = 0; const b = make(async () => ({ ...(n++ ? result('end') : result('tool_use', [call()])), usage: { source: 'estimated', inputTokens: 1, outputTokens: 2, costUsd: 0.1 } }));
  assert.deepEqual((await run(b)).usage, { source: 'estimated', inputTokens: 2, outputTokens: 4, costUsd: 0.2 });
});
test('cancellation waits for pending provider and tool to settle', async () => {
  for (const pendingTool of [false, true]) {
    const controller = new AbortController(); let release, entered; const started = new Promise(r => entered = r); const pending = new Promise(r => release = r);
    const a = make(async () => { if (pendingTool) return result('tool_use', [call()]); entered(); await pending; return result('end'); });
    let settled = false; const p = run(a, async () => { entered(); await pending; return 'ok'; }, controller.signal).finally(() => { settled = true; });
    await started; controller.abort(); await Promise.resolve(); assert.equal(settled, false); release(); await rejects(p, 'CANCELLED');
  }
});
test('provider and tool errors do not leak details', async () => {
  await rejects(run(make(async () => { throw Error('secret-provider'); })), 'PROVIDER_FAILED');
  let n = 0, feedback; const a = make(async req => { if (!n++) return result('tool_use', [call()]); feedback = JSON.stringify(req.messages); return result('end'); });
  await run(a, async () => { throw Error('secret-tool'); }); assert.doesNotMatch(feedback, /secret-tool/); assert.match(feedback, /TOOL_REJECTED/);
});

test('model mismatch and incoherent assistant tool calls fail', async () => {
  await rejects(run(make(async () => ({ ...result('end'), model: 'other/model' }))), 'MODEL_MISMATCH');
  await rejects(run(make(async () => ({ ...result('tool_use', [call()]), assistantMessage: { role: 'assistant', content: [] } }))), 'INVALID_RESPONSE');
});
test('known tokens are preserved when pricing is unknown', async () => {
  const a = make(async () => ({ ...result('end'), usage: { source: 'provider', inputTokens: 0, outputTokens: 3, costUsd: null } }));
  assert.deepEqual((await run(a)).usage, { source: 'provider', inputTokens: 0, outputTokens: 3, costUsd: null });
});

test('inherited limit names are rejected', () => {
  assert.throws(() => make(async () => result('end'), { constructor: 1 }), { code: 'INVALID_CONFIG' });
});
