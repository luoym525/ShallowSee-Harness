import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { parseEventLog, EventLogReader } from '../log-reader.mjs';
import { startWorkbench } from '../index.mjs';

const provenance = { memberId: null, role: 'system', mode: 'system', provider: null, model: null, identitySource: 'configured' };
function event(seq, type = seq === 1 ? 'room.created' : 'message.posted', payload = {}) {
  return { schemaVersion: 1, eventId: `e${seq}`, seq, roomId: 'room_test', type,
    timestamp: new Date(Date.UTC(2026, 10, 14, 14, 0, seq)).toISOString(), provenance,
    payload: seq === 1 ? { goal: 'Verify the handbook', driver: 'direct', roomVersion: 1, ...payload } : { messageId: `m${seq}`, author: 'system', content: `Message ${seq}`, ...payload } };
}
const line = (value) => `${JSON.stringify(value)}\n`;

async function fixture(t, { sample = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'shelf-workbench-test-'));
  const roomsRoot = join(dir, 'rooms');
  const roomDir = join(roomsRoot, 'room_test');
  await mkdir(roomDir, { recursive: true });
  const file = join(roomDir, 'events.jsonl');
  await writeFile(file, line(event(1)));
  const sampleFile = sample ? join(dir, 'sample.jsonl') : null;
  if (sample) await writeFile(sampleFile, line({ ...event(1, 'room.created', { synthetic: true }), roomId: 'room_sample' }));
  const publicRoot = join(dir, 'public');
  await mkdir(publicRoot);
  await writeFile(join(publicRoot, 'index.html'), '<!doctype html><title>Test</title>');
  const server = await startWorkbench({ port: 0, roomsRoot, sampleFile, publicRoot, pollIntervalMs: 25, heartbeatMs: 100 });
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.stopStreams();
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, roomsRoot, roomDir, file, sampleFile, server, url };
}

async function readUntil(response, needle) {
  const reader = response.body.getReader();
  let text = '';
  while (!text.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return { text, reader };
}

test('parser ignores incomplete UTF-8 tail, then admits it only after newline', () => {
  const first = line(event(1));
  const second = JSON.stringify(event(2, 'message.posted', { content: '中文' }));
  const tail = Buffer.from(second);
  const partial = parseEventLog(Buffer.concat([Buffer.from(first), tail.subarray(0, tail.length - 3)]));
  assert.equal(partial.events.length, 1);
  assert.equal(partial.warnings[0].code, 'incomplete_tail');
  const final = parseEventLog(first + second + '\n');
  assert.equal(final.events.length, 2);
  assert.deepEqual(final.warnings, []);
  assert.throws(() => parseEventLog(first + '{bad}\n'), /invalid JSON/);
});

test('parser deduplicates identical records, rejects conflicting IDs and sequence gaps', () => {
  const one = event(1);
  const result = parseEventLog(line(one) + line(one) + line(event(2)));
  assert.equal(result.events.length, 2);
  assert.equal(result.room.lastSeq, 2);
  assert.equal(result.warnings[0].code, 'duplicate_event');
  assert.throws(() => parseEventLog(line(one) + line({ ...one, payload: { ...one.payload, goal: 'Changed' } })), /conflicting duplicate/);
  assert.throws(() => parseEventLog(line(one) + line(event(3))), /does not follow/);
});

test('room status does not become accepted when a model run completes', () => {
  const run = { ...event(2, 'run.completed', { usage: { inputTokens: null, outputTokens: null, costUsd: null, source: 'unknown' } }), runId: 'r1' };
  assert.equal(parseEventLog(line(event(1)) + line(run)).room.status, 'running');
  assert.throws(() => parseEventLog(line(event(1)) + line({ ...event(2, 'task.done'), taskId: 't1' })), /requires evidence/);
});

test('HTTP exposes registered sample and paginates by the room cursor', async (t) => {
  const { url, file } = await fixture(t, { sample: true });
  await appendFile(file, line(event(2)) + line(event(3)));
  const list = await (await fetch(`${url}/api/rooms`)).json();
  assert.equal(list.rooms.length, 2);
  assert.equal(list.rooms.find((room) => room.roomId === 'room_sample').synthetic, true);
  assert.equal(list.rooms.find((room) => room.roomId === 'room_sample').mode, 'replay');
  const result = await (await fetch(`${url}/api/rooms/room_test/events?after=1&limit=1`)).json();
  assert.deepEqual(result.events.map((e) => e.seq), [2]);
  assert.equal(result.nextAfter, 2);
  assert.equal(result.hasMore, true);
  assert.equal((await fetch(`${url}/api/rooms/room_test/events?after=99`)).status, 409);
  assert.equal((await fetch(`${url}/api/rooms/room_test/events?after=1e3`)).status, 400);
});

test('live SSE waits for full lines and reconnects using Last-Event-ID without duplicates', async (t) => {
  const { url, file } = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(`${url}/api/rooms/room_test/stream?after=0`, { signal: controller.signal });
  const initial = await readUntil(response, 'id: 1\n');
  assert.match(initial.text, /event: stream-info/);
  assert.match(initial.text, /"mode":"live"/);
  const nextLine = line(event(2));
  await appendFile(file, nextLine.slice(0, -1));
  let collected = '';
  while (!collected.includes('incomplete_tail')) {
    const next = await initial.reader.read();
    collected += new TextDecoder().decode(next.value);
  }
  assert.doesNotMatch(collected, /id: 2\n/);
  await appendFile(file, '\n');
  while (!collected.includes('id: 2\n')) {
    const next = await initial.reader.read();
    collected += new TextDecoder().decode(next.value);
  }
  controller.abort();
  await initial.reader.cancel().catch(() => {});
  await appendFile(file, line(event(3)));
  const again = new AbortController();
  const reconnect = await fetch(`${url}/api/rooms/room_test/stream?after=0`, { headers: { 'Last-Event-ID': '2' }, signal: again.signal });
  const resumed = await readUntil(reconnect, 'id: 3\n');
  assert.doesNotMatch(resumed.text, /id: [12]\n/);
  again.abort();
  await resumed.reader.cancel().catch(() => {});
});

test('sample replay is labeled and finite even if mode=live is requested', async (t) => {
  const { url } = await fixture(t, { sample: true });
  const response = await fetch(`${url}/api/rooms/room_sample/stream?mode=live`);
  const body = await response.text();
  assert.match(body, /"mode":"replay"/);
  assert.match(body, /"synthetic":true/);
  assert.match(body, /event: stream-end/);
});

test('invalid complete records produce errors, while a torn tail produces a warning', async (t) => {
  const { url, file } = await fixture(t);
  await appendFile(file, '{broken');
  let result = await fetch(`${url}/api/rooms/room_test/events`);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).warnings[0].code, 'incomplete_tail');
  await appendFile(file, '}\n');
  result = await fetch(`${url}/api/rooms/room_test/events`);
  assert.equal(result.status, 409);
  assert.equal((await result.json()).error.code, 'invalid_log');
});

test('read-only routes reject foreign hosts/origins and encoded path traversal', async (t) => {
  const { url, server } = await fixture(t);
  assert.equal((await fetch(`${url}/api/rooms`, { method: 'POST', body: '{}' })).status, 405);
  assert.equal((await fetch(`${url}/api/rooms`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${url}/api/rooms`, { headers: { Origin: 'http://localhost:9999' } })).status, 403);
  assert.equal((await fetch(`${url}/api/rooms/%2e%2e%2fsecret/events`)).status, 400);
  assert.equal((await fetch(`${url}/server/index.mjs`)).status, 404);
  const badHost = await new Promise((resolve, reject) => {
    const socket = createConnection(server.address().port, '127.0.0.1');
    let answer = '';
    socket.on('connect', () => socket.write('GET /api/rooms HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n'));
    socket.on('data', (chunk) => { answer += chunk; });
    socket.on('end', () => resolve(answer));
    socket.on('error', reject);
  });
  assert.match(badHost, /^HTTP\/1.1 403/);
});

test('logs cannot follow a directory junction outside the configured root', async (t) => {
  const { dir, roomsRoot, url } = await fixture(t);
  const outside = join(dir, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'events.jsonl'), line({ ...event(1), roomId: 'escaped' }));
  try { await symlink(outside, join(roomsRoot, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symlink creation is not available.'); return; }
    throw error;
  }
  const response = await fetch(`${url}/api/rooms/escaped/events`);
  assert.equal(response.status, 403);
  const body = await response.text();
  assert.doesNotMatch(body, /outside|shelf-workbench-test/);
});

test('reader notices committed history being replaced rather than silently skipping it', async (t) => {
  const { url, file } = await fixture(t);
  await fetch(`${url}/api/rooms/room_test/events`);
  await writeFile(file, line(event(1, 'room.created', { goal: 'Altered history' })));
  const response = await fetch(`${url}/api/rooms/room_test/events`);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'log_replaced');
});

test('corrupt optional sample is reported without blocking valid live rooms', async (t) => {
  const { url, sampleFile } = await fixture(t, { sample: true });
  // Register the custom sample room ID, then corrupt that sample.
  await fetch(`${url}/api/rooms`);
  await appendFile(sampleFile, '{invalid}\n');
  const live = await fetch(`${url}/api/rooms/room_test/events`);
  assert.equal(live.status, 200);
  assert.equal((await live.json()).events.length, 1);
  const sample = await fetch(`${url}/api/rooms/room_sample/events`);
  assert.equal(sample.status, 409);
  assert.equal((await sample.json()).error.code, 'invalid_log');
  const list = await (await fetch(`${url}/api/rooms`)).json();
  assert.deepEqual(list.rooms.map((room) => room.roomId), ['room_test']);
  assert.equal(list.warnings[0].code, 'invalid_log');
});

test('cached parsing is scoped to expected room ID and synthetic provenance', async (t) => {
  const { roomsRoot, file } = await fixture(t);
  const reader = new EventLogReader({ roomsRoot });
  const real = await reader.readFile(file, { expectedRoomId: 'room_test' });
  assert.equal(real.room.synthetic, false);
  const sample = await reader.readFile(file, { expectedRoomId: 'room_test', forceSynthetic: true });
  assert.equal(sample.room.synthetic, true);
  const again = await reader.readFile(file, { expectedRoomId: 'room_test' });
  assert.equal(again.room.synthetic, false);
  await assert.rejects(reader.readFile(file, { expectedRoomId: 'other_room' }), /roomId differs/);
});
