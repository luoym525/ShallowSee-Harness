import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEventLog, EventLogError } from '../index.mjs';

const SYSTEM_PROVENANCE = {
  memberId: null,
  role: 'system',
  mode: 'system',
  provider: null,
  model: null,
  identitySource: 'configured',
};

const DIRECT_ROOM_PAYLOAD = {
  goal: 'Verify manual claims',
  acceptanceCriteria: ['All claims checked'],
  constraints: ['Read-only sources'],
  limits: { maxRuns: 5, maxMinutes: 10, maxUsd: null },
  workflow: 'shelf-life',
  driver: 'direct',
  roomVersion: 1,
  synthetic: true,
};

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'shallowsee-event-log-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('concurrent appends serialize cleanly with contiguous seq and preserve direct/synthetic flags', async () => {
  await withTempDir(async (rootDir) => {
    const log = await createEventLog({ rootDir, roomId: 'room_concurrent_1' });
    const first = await log.append({
      eventId: 'evt-1',
      type: 'room.created',
      provenance: SYSTEM_PROVENANCE,
      payload: DIRECT_ROOM_PAYLOAD,
    });
    assert.equal(first.seq, 1);
    assert.equal(first.payload.driver, 'direct');
    assert.equal(first.payload.synthetic, true);

    const results = await Promise.all([
      log.append({ eventId: 'evt-2', type: 'run.started', runId: 'run-1', provenance: SYSTEM_PROVENANCE, payload: { memberId: 'm1' } }),
      log.append({ eventId: 'evt-3', type: 'run.output', runId: 'run-1', provenance: SYSTEM_PROVENANCE, payload: { channel: 'progress', delta: 'step 1' } }),
      log.append({ eventId: 'evt-4', type: 'run.completed', runId: 'run-1', provenance: SYSTEM_PROVENANCE, payload: { usage: { inputTokens: null, outputTokens: null, costUsd: null, source: 'unknown' } } }),
    ]);

    assert.deepEqual(results.map((r) => r.seq), [2, 3, 4]);
    assert.equal(results[2].payload.usage.inputTokens, null);
    await log.close();

    const lines = (await readFile(log.logPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((l) => l.seq), [1, 2, 3, 4]);
  });
});

test('identical duplicate eventId is deduplicated, conflicting eventId throws', async () => {
  await withTempDir(async (rootDir) => {
    const log = await createEventLog({ rootDir, roomId: 'room_dedup_1' });
    const a = await log.append({
      eventId: 'same-id',
      type: 'room.created',
      provenance: SYSTEM_PROVENANCE,
      payload: DIRECT_ROOM_PAYLOAD,
    });
    const b = await log.append({
      eventId: 'same-id',
      type: 'room.created',
      provenance: SYSTEM_PROVENANCE,
      payload: DIRECT_ROOM_PAYLOAD,
    });
    assert.equal(b.seq, a.seq);
    assert.equal(b.timestamp, a.timestamp);

    await assert.rejects(
      () => log.append({
        eventId: 'same-id',
        type: 'room.created',
        provenance: SYSTEM_PROVENANCE,
        payload: { ...DIRECT_ROOM_PAYLOAD, goal: 'Different goal' },
      }),
      (err) => err instanceof EventLogError && err.code === 'conflicting_event_id',
    );
    await log.close();
  });
});

test('second writer for the same room is rejected and close releases lock', async () => {
  await withTempDir(async (rootDir) => {
    const log1 = await createEventLog({ rootDir, roomId: 'room_lock_1' });
    await assert.rejects(
      () => createEventLog({ rootDir, roomId: 'room_lock_1' }),
      (err) => err instanceof EventLogError && err.code === 'writer_locked',
    );
    await log1.close();

    // After close, lock is released; existing empty log still cannot be resumed,
    // so verify a fresh room or after removing events.jsonl can acquire lock cleanly.
    await rm(log1.logPath);
    const log2 = await createEventLog({ rootDir, roomId: 'room_lock_1' });
    await log2.close();
  });
});

test('truncated log file refuses further appends and does not auto-repair', async () => {
  await withTempDir(async (rootDir) => {
    const log = await createEventLog({ rootDir, roomId: 'room_trunc_1' });
    await log.append({
      eventId: 'evt-1',
      type: 'room.created',
      provenance: SYSTEM_PROVENANCE,
      payload: DIRECT_ROOM_PAYLOAD,
    });

    await truncate(log.logPath, 10);
    await assert.rejects(
      () => log.append({
        eventId: 'evt-2',
        type: 'room.closed',
        provenance: SYSTEM_PROVENANCE,
        payload: { status: 'completed' },
      }),
      (err) => err instanceof EventLogError && err.code === 'log_truncated',
    );
    await log.close();

    const remaining = await readFile(log.logPath);
    assert.equal(remaining.length, 10);
  });
});

test('rejects invalid roomId, path traversal, and existing non-empty/truncated logs on open', async () => {
  await withTempDir(async (rootDir) => {
    await assert.rejects(
      () => createEventLog({ rootDir, roomId: '../escape' }),
      (err) => err instanceof EventLogError && err.code === 'invalid_room',
    );
    await assert.rejects(
      () => createEventLog({ rootDir, roomId: '.hidden' }),
      (err) => err instanceof EventLogError && err.code === 'invalid_room',
    );

    const log = await createEventLog({ rootDir, roomId: 'room_existing_1' });
    await log.append({ type: 'room.created', provenance: SYSTEM_PROVENANCE, payload: DIRECT_ROOM_PAYLOAD });
    await log.close();

    await assert.rejects(
      () => createEventLog({ rootDir, roomId: 'room_existing_1' }),
      (err) => err instanceof EventLogError && err.code === 'existing_log_unsupported',
    );

    await writeFile(join(rootDir, 'room_existing_1', 'events.jsonl'), '{"torn":', 'utf8');
    await assert.rejects(
      () => createEventLog({ rootDir, roomId: 'room_existing_1' }),
      (err) => err instanceof EventLogError && err.code === 'existing_log_unsupported',
    );
  });
});

test('close drains accepted appends and rejects new ones', async () => {
  await withTempDir(async (rootDir) => {
    const log = await createEventLog({ rootDir, roomId: 'room_drain' });
    const invalid = assert.rejects(log.append({ type: 'room.closed', provenance: SYSTEM_PROVENANCE, payload: {} }), { code: 'invalid_first_event' });
    const payload = { ...DIRECT_ROOM_PAYLOAD, diagnostic: new Date(0), optional: undefined };
    const first = log.append({ type: 'room.created', provenance: SYSTEM_PROVENANCE, payload });
    payload.goal = 'Mutated after enqueue';
    const second = log.append({ type: 'room.closed', provenance: SYSTEM_PROVENANCE, payload: { status: 'completed' } });
    const closing = log.close();
    assert.equal(log.close(), closing);
    await assert.rejects(log.append({}), { code: 'log_closed' });
    await Promise.all([invalid, closing]);
    const written = (await readFile(log.logPath, 'utf8')).trimEnd().split('\n').map(JSON.parse);
    assert.deepEqual(written, await Promise.all([first, second]));
    assert.equal(written[0].payload.goal, DIRECT_ROOM_PAYLOAD.goal);
    assert.equal(written[0].payload.diagnostic, '1970-01-01T00:00:00.000Z');
    assert.deepEqual(written.map(e => e.seq), [1, 2]);
  });
});

test('losing the lock stops writes and never removes its replacement', async () => {
  await withTempDir(async (rootDir) => {
    const roomId = 'room_replaced_lock';
    const log = await createEventLog({ rootDir, roomId });
    const lock = join(rootDir, roomId, '.writer.lock');
    await rename(lock, lock + '.retired');
    await writeFile(lock, 'new lock', { flag: 'wx' });
    await assert.rejects(log.append({ type: 'room.created', provenance: SYSTEM_PROVENANCE, payload: DIRECT_ROOM_PAYLOAD }), { code: 'writer_lock_lost' });
    await log.close();
    assert.equal(await readFile(lock, 'utf8'), 'new lock');
    assert.equal((await readFile(log.logPath)).length, 0);
  });
});

test('room aliases and replaced log files are rejected', async () => {
  await withTempDir(async (rootDir) => {
    const roomId = 'room_replaced_log';
    const log = await createEventLog({ rootDir, roomId });
    try {
      await symlink(join(rootDir, roomId), join(rootDir, 'room_alias'), 'junction');
      await assert.rejects(createEventLog({ rootDir, roomId: 'room_alias' }), { code: 'forbidden_path' });
      await assert.rejects(createEventLog({ rootDir, roomId: 'room_alias.' }), { code: 'invalid_room' });
      await rename(log.logPath, log.logPath + '.retired');
      await writeFile(log.logPath, '');
      await assert.rejects(log.append({ type: 'room.created', provenance: SYSTEM_PROVENANCE, payload: DIRECT_ROOM_PAYLOAD }), { code: 'log_replaced' });
      assert.equal((await readFile(log.logPath)).length, 0);
    } finally { await log.close(); }
  });
});

test('short writes are completed and a failed flush prevents subsequent disk writes', async t => {
  await withTempDir(async (rootDir) => {
    const other = await open(join(rootDir, 'unrelated'), 'w');
    const proto = Object.getPrototypeOf(other);
    await other.close();
    const log = await createEventLog({ rootDir, roomId: 'room_short_write' });
    const realWrite = proto.write;
    const write = t.mock.method(proto, 'write', function (buf, offset, length, position) {
      return realWrite.call(this, buf, offset, Math.min(length, 31), position);
    });
    try {
      const first = await log.append({ type: 'room.created', provenance: SYSTEM_PROVENANCE, payload: DIRECT_ROOM_PAYLOAD });
      assert.ok(write.mock.callCount() > 1);
      assert.deepEqual(JSON.parse(await readFile(log.logPath, 'utf8')), first);
      t.mock.method(proto, 'sync', async () => { throw new Error('simulated flush failure'); });
      const closing = { type: 'room.closed', provenance: SYSTEM_PROVENANCE, payload: { status: 'completed' } };
      await assert.rejects(log.append(closing), { code: 'log_write_failed' });
      const written = write.mock.callCount();
      await assert.rejects(log.append(closing), { code: 'log_unavailable' });
      assert.equal(write.mock.callCount(), written);
    } finally { await log.close(); }
  });
});
