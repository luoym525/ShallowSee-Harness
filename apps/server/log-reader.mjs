import { readFile, realpath, readdir, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export class LogError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODES = new Set(['human', 'api', 'cli', 'external_mcp', 'local_model', 'system']);
const IDENTITIES = new Set(['configured', 'provider_reported', 'self_reported']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;

export function validateRoomId(roomId) {
  if (!ROOM_ID.test(roomId)) throw new LogError('invalid_room', 'Invalid room ID.', 400);
  return roomId;
}

export function within(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'));
}

function corrupt(line, reason) {
  throw new LogError('invalid_log', `Event log line ${line}: ${reason}.`);
}

function validateEnvelope(event, line) {
  if (!record(event)) corrupt(line, 'expected an event object');
  if (event.schemaVersion !== 1) corrupt(line, 'unsupported schema version');
  for (const field of ['eventId', 'roomId', 'type', 'timestamp']) {
    if (!text(event[field])) corrupt(line, `${field} must be a non-empty string`);
  }
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) corrupt(line, 'seq must be a positive safe integer');
  if (!ISO.test(event.timestamp) || !Number.isFinite(Date.parse(event.timestamp))) corrupt(line, 'timestamp must be UTC ISO 8601 with milliseconds');
  if (!record(event.payload) || !record(event.provenance)) corrupt(line, 'payload and provenance must be objects');
  const p = event.provenance;
  if (!(p.memberId === null || text(p.memberId)) || !text(p.role) || !MODES.has(p.mode) || !IDENTITIES.has(p.identitySource)) corrupt(line, 'invalid provenance');
  for (const field of ['provider', 'model']) if (!(p[field] === null || text(p[field]))) corrupt(line, `provenance.${field} must be a string or null`);
  if ((event.type.startsWith('run.') || event.type.startsWith('tool.')) && !text(event.runId)) corrupt(line, 'runId is required');
  if (event.type.startsWith('task.') && !text(event.taskId)) corrupt(line, 'taskId is required');
  if (event.type === 'task.done' && (!Array.isArray(event.payload.evidence) || event.payload.evidence.length === 0)) corrupt(line, 'task.done requires evidence');
}

/** Only newline-terminated records are committed; a torn tail is never repaired. */
export function parseEventLog(buffer, { expectedRoomId, forceSynthetic = false } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const lastNewline = bytes.lastIndexOf(10);
  const committed = bytes.subarray(0, lastNewline + 1);
  const warnings = [];
  if (lastNewline + 1 < bytes.length) warnings.push({ code: 'incomplete_tail', message: 'An unterminated trailing record is waiting for completion; it has not been displayed.' });
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(committed); }
  catch { throw new LogError('invalid_log', 'Committed event log contains invalid UTF-8.'); }
  const events = [];
  const ids = new Map();
  let roomId = expectedRoomId ?? null;
  let previousTimestamp = '';
  const lines = source.split('\n');
  lines.pop();
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].replace(/\r$/, '');
    let event;
    try { event = JSON.parse(raw); } catch { corrupt(index + 1, 'invalid JSON'); }
    validateEnvelope(event, index + 1);
    if (roomId === null) roomId = event.roomId;
    if (event.roomId !== roomId) corrupt(index + 1, 'roomId differs from its log');
    if (ids.has(event.eventId)) {
      if (!isDeepStrictEqual(ids.get(event.eventId), event)) corrupt(index + 1, 'conflicting duplicate eventId');
      warnings.push({ code: 'duplicate_event', message: `Identical duplicate event ${event.eventId} was ignored.` });
      continue;
    }
    if (event.seq !== events.length + 1) corrupt(index + 1, `seq ${event.seq} does not follow ${events.length}`);
    if (event.timestamp < previousTimestamp) corrupt(index + 1, 'timestamp goes backwards');
    if (events.length === 0) {
      if (event.type !== 'room.created') corrupt(index + 1, 'first event must be room.created');
      if (!['direct', 'harness'].includes(event.payload.driver)) corrupt(index + 1, 'room driver must be direct or harness');
    }
    previousTimestamp = event.timestamp;
    ids.set(event.eventId, event);
    events.push(event);
  }
  const initial = events[0]?.payload ?? {};
  let status = events.length ? 'running' : 'initializing';
  for (const event of events) {
    if (event.type === 'room.paused') status = 'paused';
    if (event.type === 'room.resumed') status = 'running';
    if (event.type === 'room.closed') status = ['completed', 'failed', 'cancelled'].includes(event.payload.status) ? event.payload.status : 'closed';
  }
  const goal = typeof initial.goal === 'string' ? initial.goal : '';
  return {
    events,
    warnings,
    room: {
      roomId,
      title: goal ? (goal.length > 90 ? `${goal.slice(0, 87)}…` : goal) : (roomId ?? 'Uninitialized room'),
      goal,
      status,
      driver: initial.driver ?? null,
      synthetic: forceSynthetic || initial.synthetic === true,
      lastSeq: events.at(-1)?.seq ?? 0,
      eventCount: events.length,
      createdAt: events[0]?.timestamp ?? null,
      updatedAt: events.at(-1)?.timestamp ?? null,
      warnings,
    },
  };
}

export class EventLogReader {
  constructor({ roomsRoot, sampleFile = null, sampleRoomId = 'room_sample_shelflife', maxBytes = 32 * 1024 * 1024 }) {
    this.roomsRoot = resolve(roomsRoot);
    this.sampleFile = sampleFile ? resolve(sampleFile) : null;
    this.sampleRoomId = sampleRoomId;
    this.maxBytes = maxBytes;
    this.cache = new Map();
  }

  async readFile(file, options = {}) {
    const info = await stat(file);
    if (!info.isFile()) throw new LogError('invalid_log', 'The log is not a regular file.');
    if (info.size > this.maxBytes) throw new LogError('log_too_large', 'Event log exceeds the configured read limit.', 413);
    const cacheKey = JSON.stringify([file, options.expectedRoomId ?? null, options.forceSynthetic === true]);
    const cached = this.cache.get(cacheKey);
    const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (cached?.stamp === stamp) return cached.result;
    const data = await readFile(file);
    if (data.length > this.maxBytes) throw new LogError('log_too_large', 'Event log exceeds the configured read limit.', 413);
    if (cached && (data.length < cached.committed.length || !data.subarray(0, cached.committed.length).equals(cached.committed))) {
      throw new LogError('log_replaced', 'A previously committed event was changed or removed. The read-only log cannot be replayed safely.');
    }
    const result = parseEventLog(data, options);
    const committed = data.subarray(0, data.lastIndexOf(10) + 1);
    if (this.cache.size >= 32 && !this.cache.has(cacheKey)) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(cacheKey, { stamp, result, committed });
    return result;
  }

  async sample() {
    if (!this.sampleFile) return null;
    try {
      const result = await this.readFile(this.sampleFile, { forceSynthetic: true });
      if (!result.events.length) throw new LogError('invalid_sample', 'Sample log has no committed events.');
      validateRoomId(result.room.roomId);
      this.sampleRoomId = result.room.roomId;
      result.room.mode = 'replay';
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async liveFile(roomId) {
    validateRoomId(roomId);
    try {
      const root = await realpath(this.roomsRoot);
      const file = await realpath(join(root, roomId, 'events.jsonl'));
      if (!within(root, file)) throw new LogError('forbidden_path', 'Log path escapes the configured rooms directory.', 403);
      return file;
    } catch (error) {
      if (error.code === 'ENOENT') throw new LogError('room_not_found', 'No log exists for this room.', 404);
      throw error;
    }
  }

  async readRoom(roomId) {
    validateRoomId(roomId);
    let sample;
    try { sample = await this.sample(); }
    catch (error) {
      // A broken optional sample must never prevent access to a real workflow log.
      if (roomId === this.sampleRoomId) throw error;
    }
    if (sample?.room.roomId === roomId) return sample;
    const file = await this.liveFile(roomId);
    const result = await this.readFile(file, { expectedRoomId: roomId });
    result.room.mode = 'live';
    return result;
  }

  async listRooms() {
    const rooms = [];
    const warnings = [];
    let sample;
    try {
      sample = await this.sample();
      if (sample) rooms.push(sample.room);
    } catch (error) {
      warnings.push({ code: error.code ?? 'sample_unavailable', message: error instanceof LogError ? error.message : 'Sample log is unavailable.' });
    }
    let directories;
    try { directories = await readdir(this.roomsRoot, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return { rooms, warnings };
      throw error;
    }
    for (const entry of directories) {
      if (!entry.isDirectory() || !ROOM_ID.test(entry.name)) continue;
      if (sample?.room.roomId === entry.name) {
        warnings.push({ code: 'sample_id_collision', roomId: entry.name, message: 'A local room uses the registered sample ID; only the sample is displayed.' });
        continue;
      }
      try {
        const file = await this.liveFile(entry.name);
        const result = await this.readFile(file, { expectedRoomId: entry.name });
        rooms.push({ ...result.room, mode: 'live' });
      } catch (error) {
        warnings.push({ code: error.code ?? 'room_unavailable', roomId: entry.name, message: error instanceof LogError ? error.message : 'This room log cannot be read.' });
      }
    }
    rooms.sort((a, b) => Number(a.synthetic) - Number(b.synthetic) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return { rooms, warnings };
  }
}
