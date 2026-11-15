import { setTimeout as delay } from 'node:timers/promises';
import { autonomyInput, budgetInput } from './config.mjs';
import { eventStream, pageEvents } from './events.mjs';
import { artifactAllowed, locate, mimeType, readSmallFile, runFiles, serveFile } from './files.mjs';
import { badInput, badMethod, HttpError, integerCursor, notFound, readJson, sendJson } from './http.mjs';

// Preview can still serve files when the engine module is absent.
const RUN_ID = /^hr-\d{8}-\d{6}-[a-z0-9]{4}$/;
const workspaceParts = id => ['harness', 'runs', id, 'workspace'];
const stateParts = id => ['harness', 'runs', id, 'state.json'];

const sourceHeaders = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function createRunApi({ getProviders, getRouter, getEngine, loadConfig, dataDir, streams }) {
  const handles = new Map();

  async function state(engine, id) {
    if (!await locate(dataDir, stateParts(id))) return null;
    const diskState = await engine.readRun(id, { dataDir });
    return diskState?.runId === id ? diskState : null;
  }

  async function waitForState(engine, id, handle) {
    let ready = await state(engine, id);
    // A startRun handle is allocated before the first atomic state write.
    const expires = Date.now() + 1500;
    while (!ready && handles.get(id) === handle && Date.now() < expires) {
      await delay(20);
      ready = await state(engine, id);
    }
    return ready;
  }

  async function start(req, res, engine) {
    const input = await readJson(req);
    if (typeof input.wish !== 'string' || !input.wish.trim() || input.wish.length > 2000) {
      throw badInput('Describe what you want in 1 to 2000 characters.', 'invalid_wish');
    }
    const budget = input.budget === undefined ? undefined : budgetInput(input.budget);
    const autonomy = autonomyInput(input.autonomy);
    const providers = await getProviders();
    const config = await loadConfig(providers);
    const router = await getRouter();
    if (!router.buildRoster(config).length) {
      throw new HttpError(409, 'no_models', 'Add a model provider on the Setup page before starting a run.');
    }
    const handle = engine.startRun({ wish: input.wish.trim(), config, overrides: { budget, autonomy }, dataDir });
    if (!RUN_ID.test(handle.runId)) throw new Error('Invalid run ID');
    handles.set(handle.runId, handle);
    function forget() {
      if (handles.get(handle.runId) === handle) handles.delete(handle.runId);
    }
    Promise.resolve(handle.done).then(forget, forget);
    if (!await waitForState(engine, handle.runId, handle)) {
      handle.cancel('Run state unavailable.');
      throw new HttpError(500, 'run_start_failed', 'The run could not initialize its state.');
    }
    return sendJson(res, 202, { runId: handle.runId });
  }

  return async function runApi(req, res, parts, query) {
    const [id, field, ...name] = parts;
    const engine = await getEngine();
    if (!id) {
      if (req.method === 'POST') return start(req, res, engine);
      if (req.method !== 'GET') throw badMethod();
      const all = await engine.listRuns({ dataDir });
      const checked = await Promise.all(all.map(run =>
        RUN_ID.test(run?.runId ?? '') ? locate(dataDir, stateParts(run.runId)) : null));
      return sendJson(res, 200, { runs: all.filter((_, index) => checked[index]) });
    }
    if (!RUN_ID.test(id)) throw notFound('No such run.');
    const handle = handles.get(id);
    if (['cancel', 'confirm'].includes(field) && name.length === 0) {
      if (req.method !== 'POST') throw badMethod();
      await readJson(req);
      if (field === 'confirm' && handle) return sendJson(res, 200, { ok: handle.confirmPlan() });
      if (field === 'cancel' && handle) {
        handle.cancel('Cancelled by the user.');
        return sendJson(res, 200, { ok: true });
      }
      const current = await state(engine, id);
      if (!current) throw notFound('No such run.');
      if (field === 'cancel' && ['running', 'awaiting_confirmation'].includes(current.status)) {
        throw new HttpError(409, 'not_console_run', 'This run is controlled by a different process.');
      }
      return sendJson(res, 200, { ok: field === 'cancel' });
    }
    if (req.method !== 'GET') throw badMethod();
    const current = handle ? await waitForState(engine, id, handle) : await state(engine, id);
    if (!current) throw notFound('No such run.');
    if (!field) {
      const artifacts = await runFiles(dataDir, ['harness', 'runs', id], { artifact: true });
      return sendJson(res, 200, { state: current, artifacts });
    }
    if (field === 'events' && name.length === 0) {
      return sendJson(res, 200, await pageEvents(dataDir, id, integerCursor(query.get('after'))));
    }
    if (field === 'stream' && name.length === 0) {
      return eventStream(req, res, { dataDir, runId: id, query, streams });
    }
    if (field === 'artifacts' && artifactAllowed(name)) {
      const file = await locate(dataDir, ['harness', 'runs', id, ...name]);
      return serveFile(req, res, file, mimeType(name.at(-1)));
    }
    if (field === 'files') {
      if (!name.length) return sendJson(res, 200, { files: await runFiles(dataDir, workspaceParts(id)) });
      const content = await readSmallFile(await locate(dataDir, [...workspaceParts(id), ...name]));
      res.writeHead(200, { ...sourceHeaders, 'Content-Length': Buffer.byteLength(content) });
      res.end(content);
      return;
    }
    throw notFound('No such endpoint.');
  };
}

export async function servePreview(req, res, { parts, trailingSlash, dataDir }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw badMethod();
  const [id, ...relative] = parts;
  if (!RUN_ID.test(id ?? '')) throw notFound('No such product preview.');
  const headers = { 'Content-Security-Policy': "frame-ancestors 'none'" };
  let name = relative;
  if (name.length === 0) {
    const specFile = await locate(dataDir, ['harness', 'runs', id, 'spec.json']);
    const spec = JSON.parse(await readSmallFile(specFile));
    if (spec?.entry?.kind !== 'open_html' || typeof spec.entry.path !== 'string') {
      throw notFound('This run has no static product preview.');
    }
    name = spec.entry.path.split('/');
    const file = await locate(dataDir, [...workspaceParts(id), ...name]);
    if (!file) throw notFound('No such product preview.');
    if (name.length > 1 || !trailingSlash) {
      res.writeHead(302, {
        ...headers,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        Location: '/' + id + '/' + name.map(encodeURIComponent).join('/'),
      });
      res.end();
      return;
    }
    return serveFile(req, res, file, mimeType(name.at(-1)), headers);
  }
  return serveFile(req, res, await locate(dataDir, [...workspaceParts(id), ...name]), mimeType(name.at(-1)), headers);
}
