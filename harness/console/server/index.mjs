import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConfigApi } from './config.mjs';
import { locate, mimeType, serveFile, webAsset } from './files.mjs';
import { badMethod, checkHost, checkMutation, HttpError, parseTarget, sendError } from './http.mjs';
import { createRunApi, servePreview } from './runs.mjs';

const LOOPBACK = '127.0.0.1';
const defaultDataDir = fileURLToPath(new URL('../../../data', import.meta.url));
const defaultWebDir = fileURLToPath(new URL('../web', import.meta.url));
const placeholder = '<!doctype html><html lang="en"><meta charset="utf-8"><title>ShallowSee Autopilot</title><main><h1>ShallowSee Autopilot</h1><p>The console API is ready. The console web files are unavailable in this checkout.</p></main></html>';

function lazyModule(value, area) {
  const url = new URL('../../' + area + '/index.mjs', import.meta.url);
  let loading = value ? Promise.resolve(value) : null;
  return () => {
    if (!loading && !existsSync(fileURLToPath(url))) {
      throw new HttpError(503, 'module_not_merged', 'The harness ' + area + ' module is unavailable in this checkout.');
    }
    loading ??= import(url.href);
    return loading;
  };
}

async function serveUi(req, res, { webDir, parts }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw badMethod();
  const asset = webAsset(parts) ? await locate(webDir, parts) : null;
  if (asset) return serveFile(req, res, asset, mimeType(parts.at(-1)));
  const index = await locate(webDir, ['index.html']);
  if (index) return serveFile(req, res, index, mimeType('index.html'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(placeholder),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : placeholder);
}

function start(server, port) {
  return new Promise((resolveListen, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, LOOPBACK, () => {
      server.off('error', onError);
      resolveListen('http://' + LOOPBACK + ':' + server.address().port);
    });
  });
}

function stop(server) {
  return new Promise((resolveClose, reject) => {
    // An idle speculative socket may never send a request for Node to mark as idle.
    const deadline = setTimeout(() => server.closeAllConnections(), 1000).unref();
    server.close(error => {
      clearTimeout(deadline);
      if (!error || error.code === 'ERR_SERVER_NOT_RUNNING') resolveClose();
      else reject(error);
    });
    server.closeIdleConnections();
  });
}

export function createConsoleServer({
  port = 4320, previewPort = 4321, host = LOOPBACK, dataDir = defaultDataDir, webDir = defaultWebDir, configPath,
  engine, providers, router,
} = {}) {
  if (host !== LOOPBACK) throw new TypeError('The console must bind to 127.0.0.1.');
  dataDir = resolve(dataDir);
  webDir = resolve(webDir);

  const getProviders = lazyModule(providers, 'providers');
  const getRouter = lazyModule(router, 'router');
  const getEngine = lazyModule(engine, 'engine');
  const streams = new Set();
  const config = createConfigApi({ getProviders, getRouter, configPath });
  const runs = createRunApi({ getProviders, getRouter, getEngine, loadConfig: config.load, dataDir, streams });

  const control = createServer(async (req, res) => {
    try {
      checkHost(req, control.address().port);
      const { parts, query } = parseTarget(req.url);
      if (parts[0] !== 'api') return await serveUi(req, res, { webDir, parts });
      if (req.method !== 'GET') checkMutation(req);
      if (parts[1] === 'runs') return await runs(req, res, parts.slice(2), query);
      await config.route(req, res, parts.slice(1));
    } catch (error) {
      sendError(res, error);
    }
  });
  const preview = createServer(async (req, res) => {
    try {
      checkHost(req, preview.address().port);
      await servePreview(req, res, { ...parseTarget(req.url), dataDir });
    } catch (error) {
      sendError(res, error);
    }
  });
  let listening;

  const close = async () => {
    for (const end of streams) end();
    await Promise.all([stop(control), stop(preview)]);
    listening = null;
  };

  return {
    listen() {
      listening ??= (async () => {
        try {
          const url = await start(control, port);
          const previewUrl = await start(preview, previewPort);
          return { url, previewUrl };
        } catch (error) {
          await close();
          throw error;
        }
      })();
      return listening;
    },
    close,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = createConsoleServer();
  try {
    const { url, previewUrl } = await server.listen();
    console.log('ShallowSee console: ' + url);
    console.log('Product preview: ' + previewUrl);
    process.once('SIGINT', () => void server.close());
    process.once('SIGTERM', () => void server.close());
  } catch {
    console.error('Could not start the local control and preview listeners.');
    process.exitCode = 1;
  }
}
