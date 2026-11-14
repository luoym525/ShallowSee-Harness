import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudit, messageAuthor, safeUrl } from '../model.mjs';

function event(seq, type, payload = {}, extra = {}) { return { seq, eventId: `e${seq}`, type, payload, roomId: 'room', schemaVersion: 1, timestamp: '2026-11-14T14:00:00.000Z', provenance: {}, ...extra }; }

test('execution completion is not task acceptance; failed evidence cannot accept', () => {
  const model = buildAudit([
    event(1, 'task.created', { title: 'Check document', status: 'ready' }, { taskId: 't1' }),
    event(2, 'run.started', {}, { runId: 'r1' }),
    event(3, 'run.completed', {}, { runId: 'r1' }),
    event(4, 'task.done', { evidence: [{ ref: 'bad', passed: false }] }, { taskId: 't1' }),
  ]);
  assert.equal(model.metrics.completedRuns, 1);
  assert.equal(model.metrics.acceptedTasks, 0);
  assert.equal(model.tasks[0].status, 'unverified');
  assert.equal(model.warnings.length, 1);
});

test('latest task transition revokes older acceptance until new evidence arrives', () => {
  const model = buildAudit([
    event(1, 'task.created', { status: 'ready' }, { taskId: 't1' }),
    event(2, 'task.done', { evidence: [{ ref: 'check1', passed: true }] }, { taskId: 't1' }),
    event(3, 'task.updated', { status: 'running' }, { taskId: 't1' }),
  ]);
  assert.equal(model.metrics.acceptedTasks, 0);
});

test('unknown usage is counted separately from measured subtotal and zero', () => {
  const model = buildAudit([
    event(1, 'run.started', {}, { runId: 'r1' }),
    event(2, 'run.completed', { usage: { inputTokens: 0, outputTokens: 4, costUsd: 0, source: 'provider' } }, { runId: 'r1' }),
    event(3, 'run.started', {}, { runId: 'r2' }),
    event(4, 'run.completed', { usage: { inputTokens: null, outputTokens: null, costUsd: null, source: 'unknown' } }, { runId: 'r2' }),
  ]);
  assert.deepEqual(model.metrics.totals.costUsd, { value: 0, known: 1, missing: 1, estimated: false });
  assert.equal(model.metrics.totals.outputTokens.value, 4);
});

test('final unsure remains open when a run closes; a proposed stale verdict is not final', () => {
  const model = buildAudit([
    event(1, 'shelflife.claim.extracted', { claimId: 'c1', quote: 'A fact' }),
    event(2, 'shelflife.verdict.proposed', { claimId: 'c1', verdict: 'stale' }),
    event(3, 'shelflife.claim.extracted', { claimId: 'c2' }),
    event(4, 'shelflife.verdict.final', { claimId: 'c2', verdict: 'unsure' }),
    event(5, 'room.closed', { status: 'completed' }),
  ]);
  assert.deepEqual(model.metrics.counts, { pending: 1, stale: 0, fresh: 0, unsure: 1 });
  assert.equal(model.room.status, 'completed');
});

test('replayed duplicates do not inflate counts; output channels are explicit', () => {
  const started = event(1, 'run.started', {}, { runId: 'r' });
  const model = buildAudit([
    started, started,
    event(2, 'run.output', { channel: 'answer', delta: 'A' }, { runId: 'r' }),
    event(3, 'run.output', { channel: 'answer', delta: 'B' }, { runId: 'r' }),
    event(4, 'run.output', { channel: 'thinking', delta: 'private field' }, { runId: 'r' }),
  ]);
  assert.equal(model.metrics.eventCount, 4);
  assert.equal(model.runs.length, 1);
  assert.equal(model.runs[0].output.answer, 'AB');
  assert.equal(Object.hasOwn(model.runs[0].output, 'thinking'), false);
});

test('only http(s) source and artifact links without credentials are navigable', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,content'), null);
  assert.equal(safeUrl('file:///C:/private'), null);
  assert.equal(safeUrl('https://user:password@example.com'), null);
  assert.equal(safeUrl('https://example.com/source'), 'https://example.com/source');
});

test('returning an accepted task to review or claiming it again revokes acceptance', () => {
  for (const type of ['task.review', 'task.claimed', 'task.failed', 'task.cancelled']) {
    const model = buildAudit([
      event(1, 'task.created', { status: 'ready' }, { taskId: 't1' }),
      event(2, 'task.done', { evidence: [{ ref: 'check1', passed: true }] }, { taskId: 't1' }),
      event(3, type, { requestedBy: 'reviewer', accepted: true }, { taskId: 't1' }),
    ]);
    assert.equal(model.metrics.acceptedTasks, 0, type);
    assert.equal(model.tasks[0].accepted, false, type);
    assert.notEqual(model.tasks[0].status, 'done', type);
  }
});

test('null and malformed evidence cannot crash or accidentally accept a task', () => {
  for (const evidence of [[null], [null, { ref: 'good', passed: true }], [1], [{ passed: true, ref: {} }], 'not-an-array']) {
    const model = buildAudit([event(1, 'task.done', { evidence }, { taskId: 't1' })]);
    assert.equal(model.metrics.acceptedTasks, 0);
    assert.equal(model.tasks[0].status, 'unverified');
    assert.ok(model.tasks[0].evidence.every(item => item && typeof item.ref === 'string'));
  }
});

test('unknown payload fields cannot replace internal state, identities or acceptance', () => {
  const model = buildAudit([
    event(1, 'room.created', { goal: 'Actual goal', status: 'completed', createdAt: 'invented' }),
    event(2, 'run.started', { id: 'injected', output: null, tools: [], notes: {}, status: 'completed', usage: { costUsd: 999 } }, { runId: 'r1' }),
    event(3, 'run.output', { channel: 'answer', delta: 'Safe text' }, { runId: 'r1' }),
    event(4, 'tool.called', { toolCallId: 'tool1', name: 'search', id: 'wrong', status: 'ok' }, { runId: 'r1' }),
    event(5, 'shelflife.claim.extracted', { claimId: 'c1', id: 'wrong', checks: null, searches: {}, final: { verdict: 'stale' } }),
    event(6, 'shelflife.search.completed', { claimId: 'c1', attempt: 1, sources: [] }),
    event(7, 'task.created', { title: 'Actual task', accepted: true, evidence: [{ ref: 'fake', passed: true }], id: 'wrong' }, { taskId: 't1' }),
    event(8, 'task.updated', { status: 'running', accepted: true, evidence: null }, { taskId: 't1' }),
    event(9, 'run.completed', { output: {}, tools: null, notes: null, id: 'wrong', status: 'failed' }, { runId: 'r1' }),
  ]);
  assert.equal(model.room.status, 'running');
  assert.equal(model.room.createdAt, '2026-11-14T14:00:00.000Z');
  assert.equal(model.runs[0].id, 'r1');
  assert.equal(model.runs[0].output.answer, 'Safe text');
  assert.ok(model.runs[0].tools instanceof Map);
  assert.equal(model.runs[0].tools.get('tool1').id, 'tool1');
  assert.equal(model.runs[0].tools.get('tool1').status, 'running');
  assert.deepEqual(model.runs[0].notes, []);
  assert.equal(model.runs[0].status, 'completed');
  assert.equal(model.claims[0].id, 'c1');
  assert.deepEqual(model.claims[0].checks, []);
  assert.equal(model.claims[0].searches.length, 1);
  assert.equal(model.claims[0].final, null);
  assert.equal(model.tasks[0].id, 't1');
  assert.deepEqual(model.tasks[0].evidence, []);
  assert.equal(model.tasks[0].accepted, false);
});

test('renderer arrays and text are normalized when recognized events contain malformed fields', () => {
  const model = buildAudit([
    event(1, 'member.joined', { memberId: 'm1', role: {}, displayName: 123 }),
    event(2, 'message.posted', { content: null, recipients: 'not-an-array' }),
    event(3, 'task.created', { acceptance: { bad: true } }, { taskId: 't1' }),
    event(4, 'shelflife.claim.extracted', { claimId: 'c1', quote: {}, lineStart: 'bad' }),
    event(5, 'shelflife.verdict.final', { claimId: 'c1', verdict: 'unsure', sources: [null, 'bad', { name: {}, snippet: [] }] }),
    event(6, 'shelflife.patch.proposed', { claimIds: {}, diff: null }),
    event(7, 'shelflife.review.result', { findings: [null, 'bad'], passed: 'yes' }, { runId: 'r1' }),
  ]);
  assert.equal(model.members.get('m1').role, 'agent');
  assert.deepEqual(model.entries[0].event.payload.recipients, []);
  assert.deepEqual(model.tasks[0].acceptance, []);
  assert.equal(model.claims[0].quote, '');
  assert.equal(model.claims[0].final.sources.length, 1);
  assert.equal(model.claims[0].final.sources[0].name, '');
  assert.deepEqual(model.patches[0].claimIds, []);
  assert.ok(model.reviews[0].findings.every(item => typeof item.issue === 'string'));
  assert.equal(model.reviews[0].passed, null);
});

test('unknown task and run event types do not invent projected work', () => {
  const model = buildAudit([
    event(1, 'run.future_optional_event', {}, { runId: 'future-run' }),
    event(2, 'task.future_optional_event', {}, { taskId: 'future-task' }),
  ]);
  assert.equal(model.metrics.eventCount, 2);
  assert.equal(model.runs.length, 0);
  assert.equal(model.tasks.length, 0);
});

test('known usage requires provider or estimated provenance even for numeric zero', () => {
  const records = [
    { inputTokens: 0, outputTokens: 0, costUsd: 0, source: 'provider' },
    { inputTokens: 2, outputTokens: 3, costUsd: 0.01, source: 'estimated' },
    { inputTokens: 2000, outputTokens: 4000, costUsd: 9, source: 'unknown' },
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    { inputTokens: 0, outputTokens: 0, costUsd: 0, source: 'unsupported-source' },
    { inputTokens: -1, outputTokens: Infinity, costUsd: NaN, source: 'provider' },
  ];
  const model = buildAudit(records.map((usage, index) => event(index + 1, 'run.completed', { usage }, { runId: 'r' + index })));
  assert.deepEqual(model.metrics.totals.inputTokens, { value: 2, known: 2, missing: 4, estimated: true });
  assert.deepEqual(model.metrics.totals.outputTokens, { value: 3, known: 2, missing: 4, estimated: true });
  assert.deepEqual(model.metrics.totals.costUsd, { value: 0.01, known: 2, missing: 4, estimated: true });
  const onlyUnknown = buildAudit([event(1, 'run.completed', { usage: records[2] }, { runId: 'r' })]);
  assert.deepEqual(onlyUnknown.metrics.totals.costUsd, { value: 0, known: 0, missing: 1, estimated: false });
});

test('message author prefers explicit author then normalized provenance then System', () => {
  const model = buildAudit([
    event(1, 'member.joined', { memberId: 'explicit', displayName: 'Explicit author' }),
    event(2, 'member.joined', { memberId: 'origin', displayName: 'Origin author' }),
    event(3, 'message.posted', { author: 'explicit', content: 'Explicit wins' }, { provenance: { memberId: 'origin' } }),
    event(4, 'message.posted', { content: 'Use origin' }, { provenance: { memberId: 'origin', role: {}, ignoredField: 'not copied' } }),
    event(5, 'message.posted', { author: '   ' }, { provenance: { memberId: 'unregistered' } }),
    event(6, 'message.posted', { author: 42 }, { provenance: { memberId: {} } }),
  ]);
  const messages = model.entries.filter(entry => entry.kind === 'message').map(entry => entry.event);
  assert.deepEqual(messages.map(message => messageAuthor(message, model.members)), ['Explicit author', 'Origin author', 'unregistered', 'System']);
  assert.equal(messages[1].provenance.memberId, 'origin');
  assert.equal(messages[1].provenance.role, 'agent');
  assert.equal(Object.hasOwn(messages[1].provenance, 'ignoredField'), false);
  assert.equal(messages[3].provenance.memberId, null);
  assert.equal(messageAuthor(null, model.members), 'System');
});

test('extracted oldValue and registered artifacts are retained for findings view', () => {
  const model = buildAudit([
    event(1, 'shelflife.claim.extracted', { claimId: 'c1', doc: 'handbook/a.md', lineStart: 5, lineEnd: 5, quote: 'Python 3.11.', statement: 'Latest Python', category: 'version', oldValue: '3.11' }),
    event(2, 'shelflife.verdict.final', { claimId: 'c1', verdict: 'stale', currentValue: '3.15', correction: 'Python 3.15.', rationale: 'Updated', sources: [] }),
    event(3, 'artifact.registered', { artifactId: 'branch_1234', kind: 'patch', location: 'https://github.com/acme/repo/compare/main...shelf-life/a', version: '1234567890abcdef' }),
  ]);
  assert.equal(model.claims[0].oldValue, '3.11');
  assert.equal(model.claims[0].final.currentValue, '3.15');
  assert.deepEqual(model.artifacts, [{ artifactId: 'branch_1234', kind: 'patch', location: 'https://github.com/acme/repo/compare/main...shelf-life/a', version: '1234567890abcdef' }]);
});
