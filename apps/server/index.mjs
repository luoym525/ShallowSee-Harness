import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventLogReader, LogError, within } from './log-reader.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/model.mjs', ['model.mjs', 'text/javascript; charset=utf-8']],
]);

function json(response, status, body, method = 'GET') {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(method === 'HEAD' ? undefined : JSON.stringify(body));
}

function integer(value, name, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new LogError('invalid_cursor', `${name} must be a non-negative integer.`, 400);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw new LogError('invalid_cursor', `${name} is out of range.`, 400);
  return number;
}

function checkLocalRequest(request, port) {
  const host = request.headers.host;
  let url;
  try { url = new URL(`http://${host}`); } catch { throw new LogError('forbidden_host', 'Invalid Host header.', 403); }
  if (!host || !LOCAL_HOSTS.has(url.hostname) || Number(url.port || 80) !== port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new LogError('forbidden_host', 'This service accepts requests for its local address only.', 403);
  }
  const origin = request.headers.origin;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new LogError('forbidden_origin', 'Invalid Origin header.', 403); }
    if (parsed.protocol !== 'http:' || !LOCAL_HOSTS.has(parsed.hostname) || Number(parsed.port || 80) !== port || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new LogError('forbidden_origin', 'Origin is not this local service.', 403);
    }
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new LogError('forbidden_origin', 'Cross-site requests are not accepted.', 403);
}

export function createWorkbenchServer({
  roomsRoot = resolve('data/rooms'),
  sampleFile = resolve('samples/shelf-life-room.sample.jsonl'),
  publicRoot = resolve(MODULE_DIR, '../web'),
  pollIntervalMs = 500,
  heartbeatMs = 15000,
  maxBytes,
} = {}) {
  const reader = new EventLogReader({ roomsRoot, sampleFile, maxBytes });
  const streams = new Set();
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    try {
      checkLocalRequest(request, server.address().port);
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        throw new LogError('read_only', 'This workbench is read-only.', 405);
      }
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api/health') return json(response, 200, { status: 'ok', readOnly: true }, request.method);
      if (url.pathname === '/api/rooms') return json(response, 200, await reader.listRooms(), request.method);
      const match = /^\/api\/rooms\/([^/]+)\/(events|stream)$/.exec(url.pathname);
      if (match) {
        let roomId;
        try { roomId = decodeURIComponent(match[1]); } catch { throw new LogError('invalid_room', 'Room ID has invalid encoding.', 400); }
        const after = Math.max(integer(url.searchParams.get('after'), 'after', 0), integer(request.headers['last-event-id'], 'Last-Event-ID', 0));
        const snapshot = await reader.readRoom(roomId);
        if (after > snapshot.room.lastSeq) throw new LogError('cursor_ahead', 'The cursor is ahead of this log. Reload the room from the beginning.', 409);
        if (match[2] === 'events') {
          const limit = integer(url.searchParams.get('limit'), 'limit', 1000, 5000);
          if (limit < 1) throw new LogError('invalid_limit', 'limit must be at least 1.', 400);
          const remaining = snapshot.events.filter((event) => event.seq > after);
          const events = remaining.slice(0, limit);
          return json(response, 200, { events, nextAfter: events.at(-1)?.seq ?? after, hasMore: remaining.length > events.length, room: snapshot.room, warnings: snapshot.warnings }, request.method);
        }
        if (request.method === 'HEAD') throw new LogError('method_not_allowed', 'Streaming requires GET.', 405);
        const requestedMode = url.searchParams.get('mode');
        if (requestedMode && !['live', 'replay'].includes(requestedMode)) throw new LogError('invalid_mode', 'mode must be live or replay.', 400);
        const mode = snapshot.room.mode === 'replay' || requestedMode === 'replay' ? 'replay' : 'live';
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        let cursor = after;
        let closed = false;
        let pending = false;
        let timer;
        let heartbeat;
        let lastWarnings = '';
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          clearInterval(heartbeat);
          streams.delete(response);
        };
        const frame = (type, value, id) => {
          if (closed || response.destroyed) return false;
          if (response.writableLength > 1024 * 1024) { cleanup(); response.destroy(); return false; }
          response.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
          return true;
        };
        const publish = (current) => {
          if (current.room.lastSeq < cursor) throw new LogError('log_replaced', 'The log was truncated or replaced. Reload the room.');
          const warnings = JSON.stringify(current.warnings);
          if (warnings !== lastWarnings) {
            lastWarnings = warnings;
            frame('stream-warning', { warnings: current.warnings });
          }
          for (const event of current.events) {
            if (event.seq > cursor && frame('room-event', event, event.seq)) cursor = event.seq;
          }
        };
        streams.add(response);
        response.on('close', cleanup);
        frame('stream-info', { roomId, mode, synthetic: snapshot.room.synthetic, driver: snapshot.room.driver, lastSeq: snapshot.room.lastSeq });
        publish(snapshot);
        if (mode === 'replay') {
          frame('stream-end', { nextAfter: cursor });
          cleanup();
          response.end();
          return;
        }
        timer = setInterval(async () => {
          if (pending || closed) return;
          pending = true;
          try { publish(await reader.readRoom(roomId)); }
          catch (error) {
            frame('stream-error', { code: error.code ?? 'read_failed', message: error instanceof LogError ? error.message : 'The event log can no longer be read.' });
            cleanup();
            response.end();
          } finally { pending = false; }
        }, pollIntervalMs);
        heartbeat = setInterval(() => { if (!closed) response.write(': heartbeat\n\n'); }, heartbeatMs);
        timer.unref();
        heartbeat.unref();
        return;
      }
      const asset = ASSETS.get(url.pathname);
      if (!asset) throw new LogError('not_found', 'No such endpoint.', 404);
      const root = await realpath(publicRoot);
      const file = await realpath(join(root, asset[0]));
      if (!within(root, file)) throw new LogError('forbidden_path', 'Asset path escapes the public directory.', 403);
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': asset[1] });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const known = error instanceof LogError;
      const missing = error.code === 'ENOENT';
      json(response, known ? error.status : missing ? 404 : 500, { error: { code: known ? error.code : missing ? 'not_found' : 'internal_error', message: known ? error.message : missing ? 'Requested file was not found.' : 'The request could not be completed.' } }, request.method);
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  server.reader = reader;
  server.stopStreams = () => { for (const response of streams) response.end(); };
  return server;
}

export async function startWorkbench(options = {}) {
  const port = options.port ?? Number(process.env.PORT || 4318);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  const server = createWorkbenchServer(options);
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveReady);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = await startWorkbench({
    roomsRoot: process.env.SHELF_LIFE_ROOMS_DIR || resolve('data/rooms'),
    sampleFile: process.env.SHELF_LIFE_SAMPLE_FILE || resolve('samples/shelf-life-room.sample.jsonl'),
    publicRoot: process.env.SHELF_LIFE_PUBLIC_DIR || resolve(MODULE_DIR, '../web'),
  });
  console.log(`Shelf Life read-only workbench: http://127.0.0.1:${server.address().port}`);
  const stop = () => { server.stopStreams(); server.close(); server.closeIdleConnections(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
