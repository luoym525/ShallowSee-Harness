import { open, mkdir, realpath, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_ROOM = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const MODES = new Set(['human', 'api', 'cli', 'external_mcp', 'local_model', 'system']);
const IDENTITIES = new Set(['configured', 'provider_reported', 'self_reported']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyText = (value) => typeof value === 'string' && value.length > 0;

function within(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'));
}

export class EventLogError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'EventLogError';
    this.code = code;
    this.status = status;
  }
}

function validateProvenance(provenance) {
  if (!isRecord(provenance)) throw new EventLogError('invalid_event', 'provenance must be an object.');
  if (!(provenance.memberId === null || isNonEmptyText(provenance.memberId))) {
    throw new EventLogError('invalid_event', 'provenance.memberId must be a non-empty string or null.');
  }
  if (!isNonEmptyText(provenance.role)) {
    throw new EventLogError('invalid_event', 'provenance.role must be a non-empty string.');
  }
  if (!MODES.has(provenance.mode)) {
    throw new EventLogError('invalid_event', 'provenance.mode is invalid.');
  }
  if (!IDENTITIES.has(provenance.identitySource)) {
    throw new EventLogError('invalid_event', 'provenance.identitySource is invalid.');
  }
  for (const field of ['provider', 'model']) {
    if (!(provenance[field] === null || isNonEmptyText(provenance[field]))) {
      throw new EventLogError('invalid_event', `provenance.${field} must be a non-empty string or null.`);
    }
  }
}

// Keep in-memory duplicates, returned envelopes and persisted JSON on the same
// representation. Snapshot at enqueue time, so callers can reuse their input.
function snapshotObject(value, field) {
  try {
    const snapshot = JSON.parse(JSON.stringify(value));
    if (isRecord(snapshot)) return snapshot;
  } catch {}
  throw new EventLogError('invalid_event', field + ' must serialize to a JSON object.');
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

function normalizeCallerInput(input) {
  if (!isRecord(input)) throw new EventLogError('invalid_event', 'Event input must be an object.');
  if (!isNonEmptyText(input.type)) throw new EventLogError('invalid_event', 'type must be a non-empty string.');
  if (input.eventId !== undefined && !isNonEmptyText(input.eventId)) {
    throw new EventLogError('invalid_event', 'eventId must be a non-empty string when provided.');
  }
  if (!isRecord(input.payload)) throw new EventLogError('invalid_event', 'payload must be an object.');
  const provenance = snapshotObject(input.provenance, 'provenance');
  const payload = snapshotObject(input.payload, 'payload');
  validateProvenance(provenance);

  if ((input.type.startsWith('run.') || input.type.startsWith('tool.')) && !isNonEmptyText(input.runId)) {
    throw new EventLogError('invalid_event', 'runId is required for run.* and tool.* events.');
  }
  if (input.runId !== undefined && !isNonEmptyText(input.runId)) {
    throw new EventLogError('invalid_event', 'runId must be a non-empty string when provided.');
  }
  if (input.type.startsWith('task.') && !isNonEmptyText(input.taskId)) {
    throw new EventLogError('invalid_event', 'taskId is required for task.* events.');
  }
  if (input.taskId !== undefined && !isNonEmptyText(input.taskId)) {
    throw new EventLogError('invalid_event', 'taskId must be a non-empty string when provided.');
  }
  if (input.type === 'task.done' && (!Array.isArray(payload.evidence) || payload.evidence.length === 0)) {
    throw new EventLogError('invalid_event', 'task.done requires non-empty payload.evidence.');
  }

  return {
    type: input.type,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    provenance,
    payload,
  };
}

export async function createEventLog({ rootDir, roomId }) {
  if (!isNonEmptyText(rootDir)) throw new EventLogError('invalid_root', 'rootDir must be a non-empty string.');
  if (!isNonEmptyText(roomId) || !ROOM_ID.test(roomId) || roomId.endsWith('.') || RESERVED_ROOM.test(roomId)) {
    throw new EventLogError('invalid_room', 'Invalid roomId.');
  }

  const resolvedRoot = resolve(rootDir);
  await mkdir(resolvedRoot, { recursive: true });
  const realRoot = await realpath(resolvedRoot);
  const candidateRoomDir = join(realRoot, roomId);
  try { await mkdir(candidateRoomDir); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const roomStat = await lstat(candidateRoomDir, { bigint: true });
  const realRoomDir = await realpath(candidateRoomDir);
  if (!roomStat.isDirectory() || roomStat.isSymbolicLink()
      || !within(realRoot, realRoomDir) || realRoomDir === realRoot) {
    throw new EventLogError('forbidden_path', 'Room path must be a directory under rootDir, without a link.', 403);
  }

  const lockPath = join(realRoomDir, '.writer.lock');
  const logPath = join(realRoomDir, 'events.jsonl');

  let lockHandle;
  try {
    lockHandle = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new EventLogError('writer_locked', 'Another writer already holds the lock for this room.', 409);
    }
    throw error;
  }

  let lockStat;
  let logHandle;
  let logStat;
  const currentLock = () => lstat(lockPath, { bigint: true }).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const releaseLock = async () => {
    try {
      const current = await currentLock();
      if (lockStat && current && sameFile(current, lockStat)) {
        await unlink(lockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
    } finally {
      await lockHandle.close();
    }
  };

  try {
    lockStat = await lockHandle.stat({ bigint: true });
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, roomId, acquiredAt: new Date().toISOString() }) + '\n', 'utf8');
    try {
      logHandle = await open(logPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new EventLogError(
        'existing_log_unsupported',
        'Resuming or appending to an existing or truncated event log is not supported; start with a fresh room.',
        409,
      );
    }
    logStat = await logHandle.stat({ bigint: true });
  } catch (error) {
    if (logHandle) await logHandle.close().catch(() => {});
    await releaseLock().catch(() => {});
    throw error;
  }

  let closePromise;
  let poisoned = false;
  let lastSeq = 0;
  let lastTimestamp = '';
  let expectedBytes = 0;
  const seen = new Map();
  let queue = Promise.resolve();

  async function appendInternal(eventId, normalized) {
    if (poisoned) throw new EventLogError('log_unavailable', 'A previous disk write failed; start with a fresh room.', 409);

    const existing = seen.get(eventId);
    if (existing) {
      if (!isDeepStrictEqual(existing.normalized, normalized)) {
        throw new EventLogError('conflicting_event_id', 'Conflicting payload for duplicate eventId.', 409);
      }
      return structuredClone(existing.envelope);
    }

    if (lastSeq === 0) {
      if (normalized.type !== 'room.created') {
        throw new EventLogError('invalid_first_event', 'First event in a room log must be room.created.');
      }
      if (!['direct', 'harness'].includes(normalized.payload.driver)) {
        throw new EventLogError('invalid_first_event', 'room.created payload.driver must be "direct" or "harness".');
      }
    } else if (normalized.type === 'room.created') {
      throw new EventLogError('duplicate_room_created', 'room.created must appear only once.', 409);
    }

    const lock = await currentLock();
    if (!lock || !sameFile(lock, lockStat)) {
      poisoned = true;
      throw new EventLogError('writer_lock_lost', 'Writer lock was removed or replaced; refusing to write.', 409);
    }
    const currentStat = await lstat(logPath, { bigint: true }).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!currentStat || !sameFile(currentStat, logStat)) {
      poisoned = true;
      throw new EventLogError('log_replaced', 'Event log was removed or replaced; refusing to write.', 409);
    }
    if (currentStat.size !== BigInt(expectedBytes)) {
      poisoned = true;
      throw new EventLogError(
        'log_truncated',
        `Event log size changed externally (expected ${expectedBytes} bytes, found ${currentStat.size}); refusing to write.`,
        409,
      );
    }

    const seq = lastSeq + 1;
    let timestamp = new Date().toISOString();
    if (timestamp < lastTimestamp) timestamp = lastTimestamp;

    const envelope = {
      schemaVersion: 1,
      eventId,
      seq,
      roomId,
      ...(normalized.runId !== undefined ? { runId: normalized.runId } : {}),
      ...(normalized.taskId !== undefined ? { taskId: normalized.taskId } : {}),
      type: normalized.type,
      timestamp,
      provenance: normalized.provenance,
      payload: normalized.payload,
    };

    const line = Buffer.from(JSON.stringify(envelope) + '\n', 'utf8');
    try {
      let offset = 0;
      while (offset < line.length) {
        const { bytesWritten } = await logHandle.write(line, offset, line.length - offset, expectedBytes + offset);
        if (bytesWritten === 0) throw new Error('No bytes written.');
        offset += bytesWritten;
      }
      await logHandle.sync();
    } catch (cause) {
      // The file might now contain a partial or unflushed record. Never truncate
      // or attempt another write after ambiguous disk state.
      poisoned = true;
      const error = new EventLogError('log_write_failed', 'Could not durably append the event.', 500);
      error.cause = cause;
      throw error;
    }

    expectedBytes += line.length;
    lastSeq = seq;
    lastTimestamp = timestamp;
    seen.set(eventId, { normalized, envelope });
    return structuredClone(envelope);
  }

  return {
    roomId,
    logPath,
    async append(input) {
      if (closePromise) throw new EventLogError('log_closed', 'Event log writer is closed.', 409);
      const normalized = normalizeCallerInput(input);
      const eventId = input.eventId ?? randomUUID();
      const next = queue.then(() => appendInternal(eventId, normalized));
      queue = next.catch(() => {});
      return next;
    },
    close() {
      closePromise ??= queue.then(async () => {
        await logHandle.close();
        await releaseLock();
      });
      return closePromise;
    },
  };
}
