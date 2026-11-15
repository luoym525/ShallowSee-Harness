import { watch } from 'node:fs';
import { locate, openChecked } from './files.mjs';
import { HttpError, integerCursor } from './http.mjs';

const ROOM_LOG = 'events.jsonl';
const READ_SIZE = 64 * 1024;
const MAX_EVENT_SIZE = 2 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

const newCursor = () => ({ offset: 0, pending: Buffer.alloc(0), seq: 0, identity: null });

function invalidLog() {
  return new HttpError(500, 'invalid_event_log', 'The run contains an invalid event log.');
}

function parseLine(bytes, runId, previous) {
  try {
    const event = JSON.parse(decoder.decode(bytes));
    if (event.roomId === runId && event.seq === previous + 1 && typeof event.type === 'string') return event;
  } catch {
    // A partial final line is never passed into this parser.
  }
  throw invalidLog();
}

async function readEvents(dataDir, runId, cursor, consume) {
  const file = await locate(dataDir, ['rooms', runId, ROOM_LOG]);
  if (!file) return;
  const identity = file.stat.dev + ':' + file.stat.ino;
  if (cursor.identity !== null && cursor.identity !== identity) throw invalidLog();
  cursor.identity = identity;
  const { fd, size } = await openChecked(file);
  try {
    if (size < cursor.offset) throw invalidLog();
    const chunk = Buffer.allocUnsafe(READ_SIZE);
    while (cursor.offset < size) {
      const { bytesRead } = await fd.read(chunk, 0, Math.min(size - cursor.offset, READ_SIZE), cursor.offset);
      if (!bytesRead) return;
      cursor.offset += bytesRead;
      const data = Buffer.concat([cursor.pending, chunk.subarray(0, bytesRead)]);
      let start = 0;
      let end = data.indexOf(10);
      while (end >= 0) {
        if (end - start > MAX_EVENT_SIZE) throw invalidLog();
        const line = data.subarray(start, end);
        if (line.length) {
          const event = parseLine(line, runId, cursor.seq);
          cursor.seq = event.seq;
          if (!await consume(event)) return;
        }
        start = end + 1;
        end = data.indexOf(10, start);
      }
      cursor.pending = data.subarray(start);
      if (cursor.pending.length > MAX_EVENT_SIZE) throw invalidLog();
    }
  } finally {
    await fd.close();
  }
}

export async function pageEvents(dataDir, runId, after) {
  const events = [];
  await readEvents(dataDir, runId, newCursor(), event => {
    if (event.seq > after) events.push(event);
    return events.length < 500;
  });
  return { events, nextAfter: events.at(-1)?.seq ?? after };
}

export function eventStream(req, res, { dataDir, runId, query, streams }) {
  const after = Math.max(integerCursor(req.headers['last-event-id']), integerCursor(query.get('after')));
  const cursor = newCursor();
  let closed = false;
  let pumping = false;
  let watcher = null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Content-Type-Options': 'nosniff',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();

  const poll = setInterval(pump, 500);
  const heart = setInterval(() => {
    if (!closed && !res.writableNeedDrain) res.write(': heartbeat\n\n');
  }, 15000);

  function stop() {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(heart);
    watcher?.close();
    streams.delete(stop);
    if (!res.destroyed) res.end();
  }

  function write(frame) {
    if (closed) return false;
    if (res.write(frame)) return true;
    return new Promise(resolve => {
      function finish() {
        res.off('drain', finish);
        res.off('close', finish);
        resolve(!closed);
      }
      res.once('drain', finish);
      res.once('close', finish);
    });
  }

  async function pump() {
    if (pumping || closed) return;
    pumping = true;
    try {
      if (watcher === null) {
        const room = await locate(dataDir, ['rooms', runId], 'dir');
        if (room && !closed) {
          try {
            watcher = watch(room.path, (_, name) => {
              if (!name || name === ROOM_LOG) void pump();
            });
            watcher.on('error', () => {
              watcher?.close();
              watcher = null;
            });
          } catch {
            // The polling fallback covers Windows and filesystems without a watch.
          }
        }
      }
      await readEvents(dataDir, runId, cursor, async event => {
        if (closed) return false;
        if (event.seq > after && !await write('id: ' + event.seq + '\nevent: harness\ndata: ' + JSON.stringify(event) + '\n\n')) {
          return false;
        }
        if (event.type === 'room.closed') {
          await write('event: end\ndata: {}\n\n');
          stop();
        }
        return !closed;
      });
    } catch {
      stop();
    } finally {
      pumping = false;
    }
  }

  streams.add(stop);
  res.once('close', stop);
  void pump();
}
