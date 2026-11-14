import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeModel } from './claude.mjs';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const request = { system: 'Be concise', input: { task: 'check' }, schema };
const response = (body, init) => new Response(JSON.stringify(body), init);
const successful = { model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 5, output_tokens: 3 } };
const make = (fetchImpl, options = {}) => createClaudeModel({ apiKey: 'secret-key', model: 'claude-test', fetchImpl, ...options });

test('sends one structured messages request and returns only parsed answer and usage', async () => {
  let calls = 0;
  const model = make(async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(options.headers['x-api-key'], 'secret-key');
    const body = JSON.parse(options.body);
    assert.equal(body.max_tokens, 23000);
    assert.deepEqual(body.output_config, { format: { type: 'json_schema', schema } });
    assert.deepEqual(body.messages, [{ role: 'user', content: JSON.stringify(request.input) }]);
    return response(successful);
  }, { maxTokens: 23000 });
  assert.deepEqual(await model(request), { value: { ok: true }, model: 'claude-test', usage: { inputTokens: 5, outputTokens: 3, costUsd: null, source: 'provider' }, stopReason: 'end_turn' });
  assert.equal(calls, 1);
});

test('bounds delivered bytes and enforces timeout even if transport ignores abort', async () => {
  await assert.rejects(make(async () => response(successful), { maxResponseBytes: 8 })(request), /byte limit/);
  await assert.rejects(make(() => new Promise(() => {}), { timeoutMs: 5 })(request), /timed out/);
});

test('rejects incomplete, refusal and invalid answers', async () => {
  for (const raw of [ { ...successful, stop_reason: 'max_tokens' }, { ...successful, stop_reason: 'refusal' }, { ...successful, content: [{ type: 'refusal' }] }, { ...successful, content: [{ type: 'text', text: '{' }] } ]) {
    await assert.rejects(make(async () => response(raw))(request));
  }
});

test('sanitizes transport and HTTP errors and preserves unknown token counts', async () => {
  await assert.rejects(make(async () => { throw new Error('secret-key private body'); })(request), error => !error.message.includes('secret'));
  await assert.rejects(make(async () => new Response('secret-key private body', { status: 401 }))(request), error => error.message === 'Claude returned HTTP 401.');
  const result = await make(async () => response({ ...successful, usage: {} }))(request);
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, costUsd: null, source: 'unknown' });
});

test('validates configuration and request', async () => {
  assert.throws(() => make(null), /configuration/);
  assert.throws(() => make(async () => {}, { maxResponseBytes: 0 }), /configuration/);
  assert.throws(() => make(async () => {}, { maxTokens: 0 }), /configuration/);
  assert.throws(() => make(async () => {}, { maxTokens: Number.MAX_SAFE_INTEGER + 1 }), /configuration/);
  await assert.rejects(make(async () => {} )({ ...request, schema: null }), /request/);
});



