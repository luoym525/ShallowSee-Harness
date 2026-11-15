import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import * as providerApi from '../../providers/index.mjs';
import { listRuns, readRun } from '../../engine/index.mjs';
import { createConsoleServer } from './index.mjs';

const SAMPLE = 'hr-20261115-010203-abcd';
const STARTED = 'hr-20261115-010204-hijk';
const OTHER = 'hr-20261115-010205-wxyz';
const FAKE_KEY = 'fixture-private-key-whole-value';
const FAKE_HEADER = 'fixture-private-header-value';
const noFetch = () => Promise.reject(new Error('No external network in this fixture.'));

function envelope(id, seq, type, payload = {}) {
  return { schemaVersion: 1, roomId: id, eventId: 'evt-' + seq, seq, type, timestamp: '2026-11-15T01:02:03Z',
    provenance: { role: 'engine', mode: 'system', provider: null, model: null, memberId: null, identitySource: 'configured' },
    payload: type === 'room.created' ? { synthetic: true, ...payload } : payload };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'shallowsee-console-test-'));
  const dataDir = join(root, 'data');
  const webDir = join(root, 'web');
  const configPath = join(root, 'apiConfig.json');
  await Promise.all([mkdir(dataDir), mkdir(webDir)]);
  const safeSave = async (path, body) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  };
  const run = (id, ...parts) => join(dataDir, 'harness', 'runs', id, ...parts);
  const events = id => join(dataDir, 'rooms', id, 'events.jsonl');
  const writeState = (id, status) => safeSave(run(id, 'state.json'), JSON.stringify({
    runId: id, wish: 'fixture wish', status, phase: status === 'delivered' ? 'done' : 'build',
  }));
  await Promise.all([
    writeState(SAMPLE, 'delivered'),
    safeSave(run(SAMPLE, 'workspace', 'index.html'), '<h1>Synthetic product</h1>'),
    safeSave(run(SAMPLE, 'workspace', 'main.js'), "console.log('preview only');"),
    safeSave(run(SAMPLE, 'workspace', 'image.png'), Buffer.from([137, 80, 78, 71, 0])),
    safeSave(run(SAMPLE, 'workspace', 'overflow.txt'), Buffer.alloc(500 * 1024 + 1, 65)),
    safeSave(run(SAMPLE, 'workspace', '.git', 'config'), 'hidden fixture'),
    safeSave(run(SAMPLE, 'spec.json'), JSON.stringify({ entry: { kind: 'open_html', path: 'index.html' } })),
    safeSave(run(SAMPLE, 'REPORT.md'), '# Synthetic report'),
    safeSave(run(SAMPLE, 'plan-check-v1.json'), '{"status":"skipped"}'),
    safeSave(run(SAMPLE, 'plan-facts-v1.md'), 'Sourced plan facts'),
    safeSave(run(SAMPLE, 'fact-check.json'), '{"status":"skipped"}'),
    safeSave(run(SAMPLE, 'plan-check-v0.json'), 'private fixture'),
    safeSave(run(SAMPLE, 'tests', '001.json'), '{"summary":"fixture"}'),
    safeSave(run(SAMPLE, 'hidden-secret.txt'), 'run internals'),
    safeSave(join(webDir, 'index.html'), '<h1>Console fixture</h1>'),
    safeSave(join(webDir, 'styles.css'), 'body {}'),
    safeSave(join(webDir, 'ui', 'module.mjs'), 'export const fixture = true;'),
    safeSave(join(webDir, 'dev', 'private.mjs'), 'private fixture'),
    safeSave(events(SAMPLE), JSON.stringify(envelope(SAMPLE, 1, 'room.created')) + '\n'),
  ]);

  const calls = [];
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const engine = {
    readRun, listRuns,
    startRun(args) {
      calls.push({ action: 'start', args });
      void delay(80).then(() => options.failStart ? finish() : writeState(STARTED, 'awaiting_confirmation'));
      let confirmed = false;
      return {
        runId: STARTED, done,
        cancel(reason) { calls.push({ action: 'cancel', reason }); finish(); },
        confirmPlan() {
          calls.push({ action: 'confirm' });
          if (confirmed) return false;
          confirmed = true;
          return true;
        },
      };
    },
  };
  const providers = {
    ...providerApi,
    async testProvider(config, id) {
      if (options.failTest) throw Error('fixture rejection ' + config.providers[0].apiKey);
      return { ok: true, latencyMs: 2, detail: 'verified ' + id + ' ' + config.providers[0].apiKey };
    },
    async fetchRemoteModels(config) {
      if (options.failFetch) throw Object.assign(Error('fixture rejection ' + config.providers[0].apiKey), { status: 403, code: 'auth' });
      return ['fixture-model', config.providers[0].apiKey];
    },
    createModelClient: noFetch,
  };
  const router = {
    buildRoster(config) { return providerApi.listConfiguredModels(config); },
    describeRouting(roster, routing) {
      return [{ role: 'planner', model: roster[0]?.ref ?? null, tier: 3, reason: 'Synthetic selection', pinned: Boolean(routing.overrides.planner) }];
    },
  };

  const app = createConsoleServer({ port: 0, previewPort: 0, webDir, dataDir, configPath, engine, providers, router });
  t.after(async () => {
    finish();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const { url, previewUrl } = await app.listen();
  return { app, root, url, previewUrl, dataDir, configPath, calls, run, events, writeState, safeSave };
}

function mutate(url, method, body, headers = {}) {
  return fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: {
    'Content-Type': 'application/json', ...headers,
  } });
}

const providerInput = {
  name: 'Synthetic fixture', preset: 'anthropic', apiKey: FAKE_KEY,
  headers: { 'X-Hidden': FAKE_HEADER }, models: [{ id: 'fixture-model', enabled: true }],
};

async function addProvider(url) {
  const res = await mutate(url + '/api/providers', 'POST', providerInput);
  assert.equal(res.status, 201);
  return (await res.json()).provider;
}

function rawRequest(url, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(url), { path, method, headers }, res => {
      const pieces = [];
      res.on('data', piece => pieces.push(piece));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, content: Buffer.concat(pieces).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('UI serves its entry, runtime modules and hash fallback with no development files', async t => {
  const { url } = await fixture(t);
  const home = await fetch(url);
  assert.match(await home.text(), /Console fixture/);
  const style = await fetch(url + '/styles.css');
  assert.match(style.headers.get('content-type'), /^text\/css/);
  assert.equal(await style.text(), 'body {}');
  assert.match(await (await fetch(url + '/ui/module.mjs')).text(), /export const/);
  assert.match(await (await fetch(url + '/unknown')).text(), /Console fixture/);
  assert.match(await (await fetch(url + '/dev/private.mjs')).text(), /Console fixture/);
  const headers = await fetch(url, { method: 'HEAD' });
  assert.equal(await headers.text(), '');
  assert.equal(headers.headers.get('x-content-type-options'), 'nosniff');
});

test('loopback Host and exact write Origin are enforced with no CORS or preflight', async t => {
  const { url, previewUrl } = await fixture(t);
  const invalidHost = await rawRequest(url, '/api/health', { headers: { Host: 'rebinding.example.test' } });
  assert.equal(invalidHost.status, 403);
  const hostAlias = await rawRequest(url, '/api/health', { headers: { Host: 'localhost:' + new URL(url).port } });
  assert.equal(hostAlias.status, 200);
  const strictType = await fetch(url + '/api/providers', { method: 'POST', body: '{}' });
  assert.equal(strictType.status, 415);
  const wrongType = await rawRequest(url, '/api/providers', { method: 'POST', body: '{}', headers: { 'content-type': 'application/jsonp' } });
  assert.equal(wrongType.status, 415);
  assert.equal((await mutate(url + '/api/runs', 'POST', { wish: 'start now' }, { Origin: previewUrl })).status, 403);
  const preflight = await fetch(url + '/api/runs', { method: 'OPTIONS', headers: { Origin: previewUrl, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  const readFromPreview = await fetch(url + '/api/config', { headers: { Origin: previewUrl } });
  assert.equal(readFromPreview.headers.get('access-control-allow-origin'), null);
  assert.throws(() => createConsoleServer({ host: '0.0.0.0' }), /127.0.0.1/);
});

test('config and provider endpoints persist changes but never disclose raw credentials', async t => {
  const { url, configPath } = await fixture(t);
  const before = await (await fetch(url + '/api/health')).json();
  assert.equal(before.hasConfig, false);
  assert.equal(before.configPath, configPath);
  assert.ok((await (await fetch(url + '/api/presets')).json()).presets.some(p => p.id === 'ollama'));
  const provider = await addProvider(url);
  assert.equal(provider.id, 'anthropic');
  assert.equal(provider.apiKey.hasKey, true);
  assert.equal(provider.headers['X-Hidden'], '•••');
  assert.equal((await (await fetch(url + '/api/health')).json()).hasConfig, true);
  const direct = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(direct.providers[0].apiKey, FAKE_KEY);

  const paths = ['/api/config', '/api/health', '/api/presets', '/api/routing/preview', '/api/runs'];
  for (const path of paths) {
    const result = await fetch(url + path);
    assert.equal(result.status, 200);
    const body = await result.text();
    assert(!body.includes(FAKE_KEY) && !body.includes(FAKE_HEADER));
  }
  for (const action of ['test', 'fetch-models']) {
    const result = await mutate(url + '/api/providers/' + provider.id + '/' + action, 'POST', {});
    assert.equal(result.status, 200);
    assert(!((await result.text()).includes(FAKE_KEY)));
  }
  const updated = await mutate(url + '/api/providers/' + provider.id, 'PUT', { notes: 'saving notes' });
  assert.equal((await updated.json()).provider.apiKey.hasKey, true);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).providers[0].apiKey, FAKE_KEY);
  const cleared = await mutate(url + '/api/providers/' + provider.id, 'PUT', { apiKey: null, headers: null });
  const clearedProvider = (await cleared.json()).provider;
  assert.equal(clearedProvider.apiKey.hasKey, false);
  assert.deepEqual(clearedProvider.headers, {});

  assert.deepEqual(await (await mutate(url + '/api/providers/' + provider.id, 'DELETE')).json(), { ok: true });
  assert.equal((await mutate(url + '/api/providers/' + provider.id, 'PUT', { enabled: false })).status, 404);
});

test('provider test failures stay 200 and model discovery preserves distinct redacted errors', async t => {
  const { url } = await fixture(t, { failTest: true, failFetch: true });
  const { id } = await addProvider(url);
  const testResult = await mutate(url + '/api/providers/' + id + '/test', 'POST', {});
  assert.equal(testResult.status, 200);
  const status = await testResult.json();
  assert.equal(status.ok, false);
  assert(!status.detail.includes(FAKE_KEY));
  const fetchResult = await mutate(url + '/api/providers/' + id + '/fetch-models', 'POST', {});
  assert.equal(fetchResult.status, 403);
  const body = await fetchResult.json();
  assert.equal(body.error.code, 'auth');
  assert(!body.error.message.includes(FAKE_KEY));
});

test('parallel config writes preserve both changes and subsequent valid writes survive rejection', async t => {
  const { url } = await fixture(t);
  const { id } = await addProvider(url);
  const bad = await mutate(url + '/api/providers/' + id, 'PUT', { models: [null] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'invalid_config');
  const edits = await Promise.all([
    mutate(url + '/api/providers/' + id, 'PUT', { notes: 'first' }),
    mutate(url + '/api/providers/' + id, 'PUT', { website: 'https://example.test' }),
    mutate(url + '/api/budget', 'PUT', { maxMinutesPerRun: 13 }),
    mutate(url + '/api/routing', 'PUT', { autonomy: 'confirm_plan', overrides: { planner: 'anthropic/fixture-model' } }),
  ]);
  assert(edits.every(r => r.status === 200));
  const configured = (await (await fetch(url + '/api/config')).json()).config;
  assert.equal(configured.providers[0].notes, 'first');
  assert.equal(configured.providers[0].website, 'https://example.test');
  assert.equal(configured.budget.maxMinutesPerRun, 13);
  assert.equal(configured.routing.autonomy, 'confirm_plan');
  assert.equal((await (await fetch(url + '/api/routing/preview')).json()).rows[0].pinned, true);
  const unpin = await mutate(url + '/api/routing', 'PUT', { overrides: {} });
  assert.deepEqual((await unpin.json()).routing.overrides, {});
  assert.equal((await mutate(url + '/api/budget', 'PUT', { maxBuildIterations: 2.5 })).status, 400);
});

test('invalid and oversized JSON requests fail with a bounded response', async t => {
  const { url } = await fixture(t);
  for (const body of ['{"bad":', '[]', '{"bad":true}']) {
    const result = await rawRequest(url, '/api/providers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(result.status, 400);
    assert.match(result.content, /"error"/);
  }
  const huge = JSON.stringify({ notes: 'x'.repeat(256 * 1024) });
  const length = await rawRequest(url, '/api/providers', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(huge) }, body: huge,
  });
  assert.equal(length.status, 413);
  const chunks = await rawRequest(url, '/api/providers', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, body: huge,
  });
  assert.equal(chunks.status, 413);
});

test('start requires a configured model, returns a readable ID and wires cancellation and confirmation', async t => {
  const { url, calls, writeState } = await fixture(t);
  assert.equal((await mutate(url + '/api/runs', 'POST', { wish: ' ' })).status, 400);
  assert.equal((await mutate(url + '/api/runs', 'POST', { wish: 'x'.repeat(2001) })).status, 400);
  assert.equal((await mutate(url + '/api/runs', 'POST', { wish: 'do work' })).status, 409);
  await addProvider(url);
  const started = await mutate(url + '/api/runs', 'POST', { wish: ' do work ', budget: { maxUsdPerRun: 2 }, autonomy: 'confirm_plan' });
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { runId: STARTED });
  assert.equal(calls[0].args.wish, 'do work');
  assert.deepEqual(calls[0].args.overrides, { autonomy: 'confirm_plan', budget: { maxUsdPerRun: 2 } });
  const prefix = url + '/api/runs/' + STARTED;
  assert.equal((await (await fetch(prefix)).json()).state.status, 'awaiting_confirmation');
  assert.deepEqual(await (await mutate(prefix + '/confirm', 'POST', {})).json(), { ok: true });
  assert.deepEqual(await (await mutate(prefix + '/confirm', 'POST', {})).json(), { ok: false });
  assert.deepEqual(await (await mutate(prefix + '/cancel', 'POST', {})).json(), { ok: true });
  assert.equal(calls.at(-1).action, 'cancel');
  await writeState(OTHER, 'running');
  assert.equal((await mutate(url + '/api/runs/' + OTHER + '/cancel', 'POST', {})).status, 409);
  assert.equal((await mutate(url + '/api/runs/hr-20261115-010200-nope/confirm', 'POST', {})).status, 404);
});

test('an initialization failure is cancelled and never reported as a successful start', async t => {
  const { url, calls } = await fixture(t, { failStart: true });
  await addProvider(url);
  const result = await mutate(url + '/api/runs', 'POST', { wish: 'start a fixture run' });
  assert.equal(result.status, 500);
  assert.equal((await result.json()).error.code, 'run_start_failed');
  assert.equal(calls.at(-1).action, 'cancel');
});

test('runs and artifacts expose a CLI run and allow only named report paths; file previews are text', async t => {
  const { url } = await fixture(t);
  const prefix = url + '/api/runs/' + SAMPLE;
  assert.equal((await (await fetch(url + '/api/runs')).json()).runs[0].runId, SAMPLE);
  const result = await (await fetch(prefix)).json();
  assert.equal(result.state.runId, SAMPLE);
  assert.deepEqual(result.artifacts, ['REPORT.md', 'fact-check.json', 'plan-check-v1.json', 'plan-facts-v1.md', 'spec.json', 'tests/001.json']);
  assert.equal(await (await fetch(prefix + '/artifacts/REPORT.md')).text(), '# Synthetic report');
  assert.deepEqual(await (await fetch(prefix + '/artifacts/tests/001.json')).json(), { summary: 'fixture' });
  assert.equal((await fetch(prefix + '/artifacts/hidden-secret.txt')).status, 404);
  assert.equal((await fetch(prefix + '/artifacts/state.json')).status, 404);
  assert.equal((await fetch(prefix + '/artifacts/plan-check-v0.json')).status, 404);
  assert.deepEqual(await (await fetch(prefix + '/artifacts/plan-check-v1.json')).json(), { status: 'skipped' });
  assert.deepEqual(await (await fetch(prefix + '/artifacts/fact-check.json')).json(), { status: 'skipped' });
  assert.equal(await (await fetch(prefix + '/artifacts/plan-facts-v1.md')).text(), 'Sourced plan facts');
  const items = (await (await fetch(prefix + '/files')).json()).files;
  assert.deepEqual(items, ['image.png', 'index.html', 'main.js', 'overflow.txt']);
  const view = await fetch(prefix + '/files/index.html');
  assert.match(view.headers.get('content-type'), /^text\/plain/);
  assert.equal(await view.text(), '<h1>Synthetic product</h1>');
  assert.equal((await fetch(prefix + '/files/image.png')).status, 415);
  assert.equal((await fetch(prefix + '/files/overflow.txt')).status, 413);
  assert.equal((await fetch(prefix + '/files/missing')).status, 404);
});

test('separate preview serves entry, nested asset redirects and security headers only from its own loopback host', async t => {
  const { url, previewUrl, run, safeSave } = await fixture(t);
  const prefix = previewUrl + '/' + SAMPLE;
  const entry = await fetch(prefix + '/');
  assert.equal(await entry.text(), '<h1>Synthetic product</h1>');
  assert.match(entry.headers.get('content-type'), /^text\/html/);
  assert.equal(entry.headers.get('cache-control'), 'no-store');
  assert.equal(entry.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(entry.headers.get('content-security-policy'), "frame-ancestors 'none'");
  const script = await fetch(prefix + '/main.js', { method: 'HEAD' });
  assert.match(script.headers.get('content-type'), /^text\/javascript/);
  assert.equal(await script.text(), '');
  assert.match(await (await fetch(url + '/' + SAMPLE + '/index.html')).text(), /Console fixture/);
  assert.equal((await fetch(previewUrl + '/api/config')).status, 404);
  assert.equal((await fetch(prefix + '/', { method: 'POST' })).status, 405);
  assert.equal((await rawRequest(previewUrl, '/' + SAMPLE + '/', { headers: { Host: 'foreign.example' } })).status, 403);
  await safeSave(run(SAMPLE, 'workspace', 'site', 'product.html'), 'nested product');
  await safeSave(run(SAMPLE, 'spec.json'), JSON.stringify({ entry: { kind: 'open_html', path: 'site/product.html' } }));
  const nested = await fetch(prefix + '/', { redirect: 'manual' });
  assert.equal(nested.status, 302);
  assert.equal(nested.headers.get('location'), '/' + SAMPLE + '/site/product.html');
  assert.equal(await (await fetch(prefix + '/')).text(), 'nested product');
});

test('traversal, junctions, paths with alternate streams and Git files are rejected', async t => {
  const { url, previewUrl, root, run, safeSave } = await fixture(t);
  await safeSave(join(root, 'outside', 'secret.txt'), 'no access');
  await symlink(join(root, 'outside'), run(SAMPLE, 'workspace', 'linked'), 'junction');
  await safeSave(join(root, 'outside', '001.json'), '{"secret":"no access"}');
  await rm(run(SAMPLE, 'tests', '001.json'));
  await rmdir(run(SAMPLE, 'tests'));
  await symlink(join(root, 'outside'), run(SAMPLE, 'tests'), 'junction');
  const artifacts = url + '/api/runs/' + SAMPLE + '/artifacts';
  assert.equal((await fetch(artifacts + '/tests/001.json')).status, 404);
  assert.equal((await rawRequest(url, '/api/runs/' + SAMPLE + '/artifacts/tests/%2E%2E/fact-check.json')).status, 400);
  for (const path of [
    '/%2e%2e/secret.txt', '/%2eGit/config', '/a%2fb', '/a%5cb', '/foo%3Astream', '/%00file',
  ]) {
    assert.equal((await rawRequest(previewUrl, '/' + SAMPLE + path)).status, 400, path);
    assert.equal((await rawRequest(url, '/api/runs/' + SAMPLE + '/files' + path)).status, 400, path);
  }
  assert.equal((await fetch(previewUrl + '/' + SAMPLE + '/linked/secret.txt')).status, 404);
  assert.equal((await fetch(url + '/api/runs/' + SAMPLE + '/files/linked/secret.txt')).status, 404);
  const listing = (await (await fetch(url + '/api/runs/' + SAMPLE + '/files')).json()).files;
  assert(!listing.some(name => name.startsWith('linked/')));
});

test('event reads page at 500, validate the cursor and leave an incomplete final line pending', async t => {
  const { url, events } = await fixture(t);
  const extra = Array.from({ length: 502 }, (_, index) => JSON.stringify(envelope(SAMPLE, index + 2, 'harness.note')) + '\n');
  await appendFile(events(SAMPLE), extra.join('') + '{"roomId":');
  const prefix = url + '/api/runs/' + SAMPLE + '/events';
  const first = await (await fetch(prefix)).json();
  assert.equal(first.events.length, 500);
  assert.equal(first.nextAfter, 500);
  const last = await (await fetch(prefix + '?after=500')).json();
  assert.deepEqual(last.events.map(e => e.seq), [501, 502, 503]);
  assert.equal(last.nextAfter, 503);
  assert.equal((await fetch(prefix + '?after=-1')).status, 400);
});

test('SSE resumes using the larger cursor, waits for a UTF-8 line and closes after room.closed', async t => {
  const { url, events } = await fixture(t);
  const res = await fetch(url + '/api/runs/' + SAMPLE + '/stream?after=0', { headers: { 'Last-Event-ID': '1' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const reader = res.body.getReader();
  const line = Buffer.from(JSON.stringify(envelope(SAMPLE, 2, 'harness.note', { text: 'Fixture résumé' })) + '\n');
  const cut = line.indexOf(0xc3) + 1;
  await appendFile(events(SAMPLE), line.subarray(0, cut));
  const pending = reader.read();
  assert.equal(await Promise.race([pending.then(() => 'event'), delay(620, 'waiting')]), 'waiting');
  await appendFile(events(SAMPLE), Buffer.concat([
    line.subarray(cut), Buffer.from(JSON.stringify(envelope(SAMPLE, 3, 'room.closed')) + '\n'),
  ]));
  let frames = Buffer.from((await pending).value).toString();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    frames += Buffer.from(next.value).toString();
  }
  assert(!frames.includes('id: 1\n'));
  assert.match(frames, /id: 2\nevent: harness\ndata:.*Fixture résumé/);
  assert.match(frames, /id: 3\nevent: harness\ndata:.*room.closed/);
  assert.match(frames, /event: end/);
  const alreadyClosed = await fetch(url + '/api/runs/' + SAMPLE + '/stream?after=3');
  assert.equal(await alreadyClosed.text(), 'event: end\ndata: {}\n\n');
});

test('close ends streams while an unfinished run is open', async t => {
  const { app, url } = await fixture(t);
  const stream = await fetch(url + '/api/runs/' + SAMPLE + '/stream');
  const reader = stream.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(), /room.created/);
  await app.close();
  assert.equal((await reader.read()).done, true);
});

test('without the UI files a placeholder and JSON health remain available', async t => {
  const webDir = join(tmpdir(), 'missing-web-fixture-' + process.pid);
  const app = createConsoleServer({ port: 0, previewPort: 0, webDir });
  t.after(() => app.close());
  const { url } = await app.listen();
  assert.match(await (await fetch(url)).text(), /console web files are unavailable/);
  assert.equal((await fetch(url + '/api/health')).status, 200);
});
