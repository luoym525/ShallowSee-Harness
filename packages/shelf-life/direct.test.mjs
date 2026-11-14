import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createEventLog } from '../event-log/index.mjs';
import { parseEventLog } from '../../apps/server/log-reader.mjs';
import { buildAudit } from '../../apps/web/model.mjs';
import { assessment, cleanSources, documentLines, includesValue, makeDiff, normalizeClaims } from './checks.mjs';
import { createAnthropicProvider, createLinkupProvider, ProviderError } from './providers.mjs';
import { runDirect, timeBudgetSeconds } from './runner.mjs';
import { syntheticFixture } from './cli.mjs';

async function withDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'shelf-life-direct-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function logged(rootDir, options) {
  const writer = await createEventLog({ rootDir, roomId: 'test_direct' });
  let report;
  try { report = await runDirect({ ...syntheticFixture, writer, synthetic: true, ...options }); }
  finally { await writer.close(); }
  return { report, ...parseEventLog(await readFile(writer.logPath)) };
}

test('synthetic fixture persists a direct audit and produces an applicable local patch', async () => {
  await withDir(async root => {
    const { report, room, events, warnings } = await logged(root);
    assert.equal(room.synthetic, true);
    assert.equal(room.driver, 'direct');
    assert.deepEqual(warnings, []);
    assert.deepEqual(report.findings.map(f => f.verdict), ['stale', 'fresh', 'unsure']);
    assert.equal(events.filter(e => e.type === 'task.done').length, 0);
    assert.equal(events.at(-2).type, 'task.review');
    assert.equal(events.filter(e => e.type === 'shelflife.verdict.final').at(-1).payload.escalated, true);
    assert.equal(buildAudit(events).metrics.retries, 1);
    assert.equal(buildAudit(events).metrics.acceptedTasks, 0);
    const original = join(root, 'handbook/acme-example.md');
    await mkdir(join(root, 'handbook'));
    await writeFile(original, syntheticFixture.markdown);
    const patchPath = join(root, 'proposed.diff');
    await writeFile(patchPath, report.diff);
    execFileSync('git', ['apply', '--check', '--unidiff-zero', patchPath], { cwd: root });
    assert.match(report.diff, /^\+Acme Tools requires version 9\.2\.$/m);
    assert.equal(await readFile(original, 'utf8'), syntheticFixture.markdown);
  });
});

test('repeat search failures and invalid citations cannot propose an edit', async () => {
  await withDir(async root => {
    const { report, events } = await logged(root, {
      modelProvider: { ...syntheticFixture.modelProvider, async verify() {
        return { value: { verdict: 'stale', currentValue: '9.2', sourceIndexes: [400], rationale: 'bad cite' } };
      } },
      async searchProvider(input) {
        if (input.stage) throw new ProviderError('linkup_network', 'Search did not finish.', true);
        return syntheticFixture.searchProvider(input);
      },
    });
    assert.equal(report.diff, '');
    assert.equal(report.failedSearches, 6);
    assert.ok(report.findings.every(f => f.verdict === 'unsure'));
    assert.equal(events.filter(e => e.type === 'tool.result' && e.payload.status === 'error').length, 6);
    const failed = events.filter(e => e.type === 'run.failed');
    assert.ok(failed.some(e => e.payload.retryable));
    assert.ok(failed.every(e => e.payload.usage.costUsd === null));
  });
});

test('extraction failures produce no verdicts', async () => {
  await withDir(async root => {
    const { report, room, events } = await logged(root, {
      modelProvider: { ...syntheticFixture.modelProvider, async extract() { return { value: { claims: null } }; } },
    });
    assert.equal(report.status, 'failed');
    assert.equal(room.status, 'failed');
    assert.ok(events.some(e => e.type === 'run.failed'));
    assert.ok(events.some(e => e.type === 'task.failed'));
    assert.ok(!events.some(e => e.type === 'shelflife.verdict.final'));
  });
});

test('authentication failures end the audit after the first provider error', async () => {
  await withDir(async root => {
    let calls = 0;
    const { report, room, events } = await logged(root, {
      async searchProvider() {
        calls++;
        throw new ProviderError('linkup_auth', 'linkup returned HTTP 401.');
      },
    });
    assert.equal(calls, 1);
    assert.equal(report.status, 'failed');
    assert.equal(room.status, 'failed');
    assert.ok(events.some(e => e.type === 'run.failed' && e.payload.error.code === 'linkup_auth'));
    assert.ok(!events.some(e => e.type === 'shelflife.verdict.final' || e.type === 'shelflife.patch.proposed'));
  });
});

test('wrong positions, non-unique quotes and fenced code cannot anchor edits', () => {
  const markdown = 'Acme 8.0 Acme 8.0\n```\nAcme 8.0\n```\nFinal doc 8.0';
  const lines = documentLines('handbook/a.md', markdown);
  const base = { quote: 'Acme 8.0', oldValue: '8.0', statement: 'Acme version is 8.0.', category: 'version' };
  const { claims, rejected } = normalizeClaims({ claims: [
    { ...base, line: 1 }, { ...base, line: 3 }, { ...base, line: 9 },
    { ...base, line: 5, quote: 'Final doc 8.0' },
  ] }, 'handbook/a.md', lines, 4);
  assert.equal(rejected, 3);
  assert.equal(claims[0].lineStart, 5);
  assert.throws(() => documentLines('a.md', 'first\r\nsecond\n'), /Mixed line endings/);
  const nestedFence = ['````text', '~~~', 'Acme 8.0', '```', 'Acme 8.0', '````', 'Acme 8.0'];
  const result = normalizeClaims({ claims: [3, 5, 7].map(line => ({ ...base, line })) }, 'a.md', nestedFence, 3);
  assert.deepEqual(result.claims.map(claim => claim.lineStart), [7]);
});

test('overlapping positions and mirrored excerpts are left unresolved', () => {
  assert.equal(includesValue('v110 v10.2', '10'), false);
  assert.equal(includesValue('Version 10. Update as needed.', '10'), true);
  const claim = { quote: 'Version 8.0.', oldValue: '8.0' };
  const sources = cleanSources([
    { url: 'https://docs.acme.example/a', snippet: 'Current version is 9.2.' },
    { url: 'https://another.example/a', snippet: 'Current version is 9.2.' },
    { url: 'https://sample.example/a?access_token=fixture', snippet: 'Version is 9.2.' },
  ]);
  assert.equal(sources.length, 2);
  const raw = { verdict: 'stale', currentValue: '9.2', sourceIndexes: [0, 1], rationale: 'Source test' };
  assert.equal(assessment(raw, claim, sources, sources.slice(0, 1), sources.slice(1), claim.quote, true).final.verdict, 'unsure');
  const distinct = [sources[0], { ...sources[1], snippet: 'This project now needs version 9.2.' }];
  const assess = (line, uniqueLine) => assessment(raw, claim, distinct, distinct.slice(0, 1), distinct.slice(1), line, uniqueLine);
  assert.equal(assess(claim.quote, false).final.verdict, 'unsure');
  assert.equal(assess(claim.quote, true).final.verdict, 'stale');
  assert.equal(assess('[Version 8.0.](https://something.example)', true).final.verdict, 'unsure');
  assert.equal(assessment(raw, claim, distinct, [], distinct, claim.quote, true).final.verdict, 'unsure');
  assert.throws(() => assessment({ ...raw, currentValue: '9.2\nline' }, claim, distinct, distinct.slice(0, 1), distinct.slice(1), claim.quote, true), /shape/);
});

test('a single successful search cannot produce a stale correction', async () => {
  await withDir(async root => {
    const { report, events } = await logged(root, {
      async searchProvider(input) {
        if (input.claim.category !== 'version') return syntheticFixture.searchProvider(input);
        if (input.stage !== 2) return { sources: [] };
        const first = await syntheticFixture.searchProvider({ ...input, stage: 0 });
        const second = await syntheticFixture.searchProvider({ ...input, stage: 1 });
        return { sources: [...first.sources, ...second.sources] };
      },
    });
    assert.equal(report.findings[0].verdict, 'unsure');
    assert.equal(report.diff, '');
    assert.ok(events.some(e => e.type === 'shelflife.check.result' && e.payload.check === 'independent_sources' && e.payload.passed === false));
  });
});

test('the patch preserves files without a trailing newline and files using CRLF', async () => {
  for (const originalText of ['heading\nold 8.0', 'heading\r\nold 8.0\r\n', 'heading\r\nold 8.0']) {
    await withDir(async root => {
      const path = join(root, 'actual.md');
      const diff = makeDiff('actual.md', documentLines('actual.md', originalText), [{ line: 2, quote: '8.0', correction: '9.2' }], originalText);
      const patchPath = join(root, 'patch.diff');
      await writeFile(path, originalText);
      await writeFile(patchPath, diff);
      execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--unidiff-zero', patchPath], { cwd: root });
      assert.equal(await readFile(path, 'utf8'), originalText.replace('8.0', '9.2'));
    });
  }
});

test('Anthropic requests strict output and preserves provider counters without private blocks', async () => {
  const api = createAnthropicProvider({ apiKey: 'fixture-key', model: 'fixture-model', async fetchImpl(url, init) {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['x-api-key'], 'fixture-key');
    const body = JSON.parse(init.body);
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.model, 'fixture-model');
    assert.equal(body.tools, undefined);
    return Response.json({ model: 'fixture-resolved', stop_reason: 'end_turn', usage: { input_tokens: 0, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 5 },
      content: [{ type: 'text', text: '{"claims":[]}' }, { type: 'thinking', thinking: 'private material' }] });
  } });
  assert.deepEqual(await api.extract({ lines: [], maxClaims: 1 }), {
    model: 'fixture-resolved', usage: { inputTokens: 5, outputTokens: 5, costUsd: null, source: 'provider' },
    stopReason: 'end_turn', value: { claims: [] },
  });
});

test('Linkup requests a sourced answer and does not log the private error body', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://api.linkup.so/v1/search');
    assert.equal(init.headers.Authorization, 'Bearer fixture-key');
    assert.deepEqual(JSON.parse(init.body), { q: 'scope', depth: 'standard', outputType: 'sourcedAnswer', maxResults: 8 });
    return new Response('provider secret details', { status: 429 });
  };
  const search = createLinkupProvider({ apiKey: 'fixture-key', fetchImpl });
  await assert.rejects(search({ query: 'scope', depth: 'standard' }), error =>
    error.code === 'linkup_http' && error.retryable && !error.message.includes('secret'));
});

test('provider response limits count streamed bytes and cancel before reading more', async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ answer: '界'.repeat(349526), sources: [] }));
  const bytesInMiB = 1024 * 1024;
  assert.ok(encoded.length > bytesInMiB);
  for (const contentLength of [undefined, '20']) {
    let cancelled = false;
    let reads = 0;
    const stream = new ReadableStream({
      pull(controller) {
        reads++;
        if (reads === 1) controller.enqueue(encoded.subarray(0, bytesInMiB - 1));
        else if (reads === 2) controller.enqueue(encoded.subarray(bytesInMiB - 1));
        else assert.fail('Oversized provider body was read after crossing the limit.');
      },
      cancel() { cancelled = true; return Promise.reject(new Error('private cleanup detail')); },
    }, { highWaterMark: 0 });
    const headers = contentLength === undefined ? {} : { 'Content-Length': contentLength };
    const linkup = createLinkupProvider({ apiKey: 'fixture-key', fetchImpl: async () => new Response(stream, { headers }) });
    await assert.rejects(linkup({ query: 'scope', depth: 'standard' }), {
      code: 'linkup_response_too_large', message: 'linkup response exceeded 1 MiB.', retryable: false,
    });
    assert.equal(reads, 2);
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
  }
});

test('the exact byte limit accepts a multibyte character split across chunks', async () => {
  const answer = '界';
  const json = JSON.stringify({ answer, sources: [] });
  const payload = new TextEncoder().encode(json + ' '.repeat(1024 * 1024 - Buffer.byteLength(json)));
  const split = Buffer.byteLength(json.slice(0, json.indexOf(answer))) + 1;
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(payload.subarray(0, split));
    controller.enqueue(payload.subarray(split));
    controller.close();
  } });
  const linkup = createLinkupProvider({ apiKey: 'fixture-key', fetchImpl: async () => new Response(stream, {
    headers: { 'Content-Length': String(payload.byteLength + 1) },
  }) });
  assert.deepEqual(await linkup({ query: 'scope', depth: 'standard' }), { answer, sources: [] });
  assert.equal(stream.locked, false);
});

test('model requests leave room for thinking and use an explicitly supported nullable type', async () => {
  const bodies = [];
  const api = createAnthropicProvider({ apiKey: 'fixture-key', model: 'fixture-model', async fetchImpl(url, init) {
    bodies.push(JSON.parse(init.body));
    const text = bodies.length === 1 ? '{"claims":[]}' : '{"verdict":"unsure","currentValue":null,"sourceIndexes":[],"rationale":"weak"}';
    return Response.json({ model: 'fixture-resolved', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text }] });
  } });
  await api.extract({ lines: [], maxClaims: 1 });
  const verdict = await api.verify({ claim: {}, sources: [], observedAt: '2026-11-14T00:00:00.000Z' });
  assert.equal(verdict.value.currentValue, null);
  assert.deepEqual(bodies.map(body => body.max_tokens), [16000, 16000]);
  assert.deepEqual(bodies[1].output_config.format.schema.properties.currentValue, { anyOf: [{ type: 'string' }, { type: 'null' }] });
  assert.ok(!JSON.stringify(bodies).includes('"type":["string","null"]'));
});

test('a reply cut off by the output cap is reported as incomplete, never parsed', async () => {
  const api = createAnthropicProvider({ apiKey: 'fixture-key', model: 'fixture-model', async fetchImpl() {
    return Response.json({ model: 'fixture-resolved', stop_reason: 'max_tokens', usage: { input_tokens: 9, output_tokens: 16000 }, content: [{ type: 'text', text: '{"claims":[' }] });
  } });
  await assert.rejects(api.extract({ lines: [], maxClaims: 1 }), error =>
    error.code === 'anthropic_incomplete' && error.result.stopReason === 'max_tokens' && error.result.usage.outputTokens === 16000);
});

test('standalone requests use their provider deadline and honor a shorter remaining budget', async t => {
  const timeouts = [];
  const makeSignal = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => {
    timeouts.push(ms);
    return makeSignal(ms);
  });
  const api = createAnthropicProvider({ apiKey: 'fixture-key', model: 'fixture-model', async fetchImpl() {
    return Response.json({ model: 'fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"claims":[]}' }] });
  } });
  const linkup = createLinkupProvider({ apiKey: 'fixture-key', fetchImpl: async () => Response.json({ sources: [] }) });
  await api.extract({ lines: [], maxClaims: 1 });
  await api.extract({ lines: [], maxClaims: 1, timeoutMs: 2500 });
  await linkup({ query: 'scope', depth: 'standard' });
  assert.deepEqual(timeouts, [120000, 2500, 45000]);
});

test('the time budget grows with the number of claims and is recorded in the room limits', async () => {
  assert.deepEqual([1, 4, 12].map(timeBudgetSeconds), [135, 360, 960]);
  await withDir(async root => {
    const { events } = await logged(root, { maxClaims: 8 });
    assert.equal(events[0].payload.limits.maxMinutes, 11);
    assert.equal(events[0].payload.limits.maxRuns, 41);
  });
});
