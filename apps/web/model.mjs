const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const strings = (value) => array(value).filter(item => typeof item === 'string');
const nullableText = (value) => typeof value === 'string' ? value : null;
const measured = (value) => number(value) ? value : null;
const flag = (value) => typeof value === 'boolean' ? value : null;
const choice = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const taskStates = ['pending', 'ready', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled'];
const taskTypes = ['task.claimed', 'task.updated', 'task.review', 'task.done', 'task.failed', 'task.cancelled'];
const runTypes = ['run.started', 'run.output', 'run.completed', 'run.failed', 'run.cancelled'];

function provenance(value) {
  const p = record(value);
  return { memberId: nullableText(p.memberId), role: text(p.role, 'agent'), mode: text(p.mode), provider: nullableText(p.provider), model: nullableText(p.model), identitySource: text(p.identitySource) };
}
function sources(value) {
  return array(value).filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)).map(item => ({
    name: text(item.name), url: text(item.url), domain: text(item.domain), snippet: text(item.snippet),
  }));
}
function evidenceItems(value) {
  // Keep malformed entries as failing placeholders: dropping them could turn a mixed
  // valid/invalid evidence list into a falsely accepted task.
  return array(value).map(value => {
    const item = record(value);
    return { kind: text(item.kind, 'unknown'), ref: text(item.ref), summary: text(item.summary, 'Evidence details unavailable'), passed: item.passed === true };
  });
}
function verdict(p) {
  return { claimId: text(p.claimId), attempt: measured(p.attempt), attempts: measured(p.attempts), verdict: choice(p.verdict, ['fresh', 'stale', 'unsure'], 'unknown'),
    currentValue: nullableText(p.currentValue), correction: nullableText(p.correction), rationale: text(p.rationale), sources: sources(p.sources), escalated: p.escalated === true };
}
function usage(value) {
  const p = record(value);
  return { inputTokens: measured(p.inputTokens), outputTokens: measured(p.outputTokens), costUsd: measured(p.costUsd), source: choice(p.source, ['provider', 'estimated', 'unknown'], 'unknown') };
}

export function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function buildAudit(events = []) {
  const room = { goal: '', status: 'waiting', driver: null, synthetic: false, acceptanceCriteria: [] };
  const members = new Map(), tasks = new Map(), runs = new Map(), claims = new Map();
  const entries = [], patches = [], prs = new Map(), reviews = [], warnings = [];
  const ids = new Set(), sequences = new Set();
  const ordered = array(events).filter(e => e && Number.isInteger(e.seq) && e.seq > 0 && typeof e.type === 'string').slice().sort((a, b) => a.seq - b.seq);
  let eventCount = 0, lastSeq = 0;
  function runFor(e) {
    if (typeof e.runId !== 'string' || !e.runId) return null;
    if (!runs.has(e.runId)) {
      const run = { id: e.runId, seq: e.seq, timestamp: text(e.timestamp), provenance: provenance(e.provenance), status: 'running', output: { answer: '', progress: '', summary: '' }, tools: new Map(), notes: [], usage: null, durationMs: null };
      runs.set(e.runId, run);
      entries.push({ kind: 'run', seq: e.seq, runId: e.runId });
    }
    return runs.get(e.runId);
  }
  function claimFor(id) {
    if (!claims.has(id)) claims.set(id, { id, checks: [], searches: [], proposed: null, final: null });
    return claims.get(id);
  }
  for (const e of ordered) {
    if (ids.has(e.eventId) || sequences.has(e.seq)) continue;
    if (typeof e.eventId === 'string') ids.add(e.eventId);
    sequences.add(e.seq); eventCount++; lastSeq = Math.max(lastSeq, e.seq);
    const p = record(e.payload);
    if (e.type === 'room.created') {
      Object.assign(room, { roomId: text(e.roomId), createdAt: text(e.timestamp), status: 'running', goal: text(p.goal),
        acceptanceCriteria: strings(p.acceptanceCriteria), constraints: strings(p.constraints), workflow: nullableText(p.workflow),
        driver: choice(p.driver, ['harness', 'direct'], null), synthetic: p.synthetic === true, roomVersion: measured(p.roomVersion) });
    } else if (e.type === 'room.closed') Object.assign(room, { status: choice(p.status, ['completed', 'failed', 'cancelled'], 'unknown'), summary: text(p.summary), endedAt: text(e.timestamp) });
    else if (e.type === 'room.paused') room.status = 'paused';
    else if (e.type === 'room.resumed') room.status = 'running';
    else if (e.type === 'member.joined' && typeof p.memberId === 'string') {
      members.set(p.memberId, { memberId: p.memberId, displayName: text(p.displayName, p.memberId), role: text(p.role, 'agent'),
        mode: text(p.mode), provider: nullableText(p.provider), model: nullableText(p.model) });
    } else if (e.type === 'message.posted') entries.push({ kind: 'message', seq: e.seq, event: { timestamp: text(e.timestamp), payload: {
      messageId: text(p.messageId), author: text(p.author), recipients: strings(p.recipients), kind: text(p.kind), content: text(p.content), replyTo: nullableText(p.replyTo),
    } } });
    else if (e.type === 'task.created' && typeof e.taskId === 'string') tasks.set(e.taskId, {
      id: e.taskId, title: text(p.title, e.taskId), owner: nullableText(p.owner), dependencies: strings(p.dependencies), deliverables: strings(p.deliverables),
      acceptance: strings(p.acceptance), status: choice(p.status, ['pending', 'ready'], 'pending'), version: measured(p.version), evidence: [], accepted: false,
    });
    else if (taskTypes.includes(e.type) && typeof e.taskId === 'string') {
      const task = tasks.get(e.taskId) || { id: e.taskId, title: e.taskId, acceptance: [], evidence: [], accepted: false };
      if (e.type === 'task.done') {
        const evidence = evidenceItems(p.evidence);
        const accepted = evidence.length > 0 && evidence.every(item => item.passed && item.ref.trim().length > 0);
        Object.assign(task, { verifiedBy: text(p.verifiedBy), version: measured(p.version), evidence, accepted, status: accepted ? 'done' : 'unverified' });
        if (!accepted) warnings.push('Task ' + e.taskId + ' was marked done without complete passing evidence.');
        entries.push({ kind: 'acceptance', seq: e.seq, taskId: e.taskId, evidence, accepted, timestamp: text(e.timestamp) });
      } else {
        // Every new claim, update or review supersedes a previous acceptance.
        task.accepted = false;
        if (e.type === 'task.review') Object.assign(task, { status: 'review', version: measured(p.version), requestedBy: text(p.requestedBy), artifactIds: strings(p.artifactIds) });
        else if (e.type === 'task.failed' || e.type === 'task.cancelled') Object.assign(task, { status: e.type.slice(5), reason: text(p.reason), version: measured(p.version) });
        else if (e.type === 'task.updated') Object.assign(task, { status: p.status === 'done' ? 'unverified' : choice(p.status, taskStates, 'unknown'), version: measured(p.version), note: text(p.note) });
        else if (e.type === 'task.claimed') Object.assign(task, { claimId: text(p.claimId), memberId: text(p.memberId), taskVersion: measured(p.taskVersion), leaseUntil: text(p.leaseUntil), status: task.status === 'done' ? 'ready' : task.status || 'ready' });
      }
      tasks.set(e.taskId, task);
    }
    if (runTypes.includes(e.type)) {
      const run = runFor(e); if (!run) continue;
      if (e.type === 'run.started') Object.assign(run, { memberId: text(p.memberId), provider: nullableText(p.provider), model: nullableText(p.model),
        attempt: measured(p.attempt), triggerEventId: text(p.triggerEventId), roomVersion: measured(p.roomVersion), provenance: provenance(e.provenance), taskId: nullableText(e.taskId) });
      if (e.type === 'run.output' && ['answer', 'progress', 'summary'].includes(p.channel) && typeof p.delta === 'string') run.output[p.channel] += p.delta;
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(e.type)) {
        Object.assign(run, { status: e.type.slice(4), endedAt: text(e.timestamp) });
        if (e.type !== 'run.cancelled') Object.assign(run, { usage: usage(p.usage), durationMs: measured(p.durationMs) });
        if (e.type === 'run.completed') run.stopReason = nullableText(p.stopReason);
        if (e.type === 'run.failed') { const error = record(p.error); run.error = { code: text(error.code), message: text(error.message) }; run.retryable = p.retryable === true; }
        if (e.type === 'run.cancelled') run.reason = text(p.reason);
      }
    }
    if (e.type === 'tool.called' || e.type === 'tool.result') {
      const run = runFor(e); if (!run || typeof p.toolCallId !== 'string') continue;
      const tool = run.tools.get(p.toolCallId) || { id: p.toolCallId, name: text(p.name), status: 'running' };
      tool.name = text(p.name, tool.name);
      if (e.type === 'tool.called') tool.args = record(p.args);
      else Object.assign(tool, { status: choice(p.status, ['ok', 'error', 'timeout'], 'unknown'), summary: text(p.summary), durationMs: measured(p.durationMs) });
      run.tools.set(p.toolCallId, tool);
    }
    const claimId = typeof p.claimId === 'string' && p.claimId ? p.claimId : null;
    if (e.type === 'shelflife.claim.extracted' && claimId) Object.assign(claimFor(claimId), { claimId, doc: text(p.doc), lineStart: measured(p.lineStart),
      lineEnd: measured(p.lineEnd), quote: text(p.quote), statement: text(p.statement), category: text(p.category) });
    if (e.type === 'shelflife.search.completed' && claimId) claimFor(claimId).searches.push({ claimId, attempt: measured(p.attempt), query: text(p.query),
      provider: text(p.provider), depth: text(p.depth), answer: nullableText(p.answer), sources: sources(p.sources), durationMs: measured(p.durationMs) });
    if (e.type === 'shelflife.check.result' && claimId) claimFor(claimId).checks.push({ claimId, attempt: measured(p.attempt), check: text(p.check),
      passed: flag(p.passed), detail: text(p.detail), eventId: text(e.eventId) });
    if (e.type === 'shelflife.verdict.proposed' && claimId) claimFor(claimId).proposed = verdict(p);
    if (e.type === 'shelflife.verdict.final' && claimId) claimFor(claimId).final = verdict(p);
    if (e.type === 'shelflife.patch.proposed') patches.push({ doc: text(p.doc), claimIds: strings(p.claimIds), diff: text(p.diff), eventId: text(e.eventId) });
    if (e.type === 'shelflife.pr.opened' || e.type === 'shelflife.pr.updated') {
      const key = text(p.repo) + '#' + String(measured(p.number));
      const pr = prs.get(key) || { repo: text(p.repo), number: measured(p.number), claimIds: [] };
      for (const field of ['url', 'branch', 'commit', 'note']) if (typeof p[field] === 'string') pr[field] = p[field];
      if (e.type === 'shelflife.pr.opened') pr.claimIds = strings(p.claimIds);
      prs.set(key, pr);
    }
    if (e.type === 'shelflife.review.result') {
      const review = { commit: text(p.commit), passed: flag(p.passed), findings: array(p.findings).map(item => { const f = record(item); return { claimId: text(f.claimId), issue: text(f.issue, 'Finding details unavailable') }; }) };
      reviews.push({ ...review, seq: e.seq });
      runFor(e)?.notes.push({ ...review, kind: 'review' });
    }
  }
  const claimList = [...claims.values()], runList = [...runs.values()], taskList = [...tasks.values()];
  const completed = runList.filter(r => ['completed', 'failed', 'cancelled'].includes(r.status));
  const totals = {};
  for (const key of ['inputTokens', 'outputTokens', 'costUsd']) {
    const known = completed.filter(r => number(r.usage?.[key]));
    totals[key] = { known: known.length, missing: completed.length - known.length, value: known.reduce((sum, r) => sum + r.usage[key], 0), estimated: known.some(r => r.usage.source === 'estimated') };
  }
  const counts = { stale: 0, fresh: 0, unsure: 0, pending: 0 };
  for (const claim of claimList) {
    const conclusion = claim.final?.verdict;
    counts[Object.hasOwn(counts, conclusion) ? conclusion : 'pending']++;
  }
  const checks = claimList.flatMap(c => c.checks);
  return { room, members, tasks: taskList, runs: runList, claims: claimList, entries, patches, prs: [...prs.values()], reviews, warnings,
    metrics: { eventCount, lastSeq, counts, claimCount: claimList.length, completedRuns: completed.length, acceptedTasks: taskList.filter(t => t.accepted).length,
      totalTasks: taskList.length, failedChecks: checks.filter(c => c.passed === false).length, passedChecks: checks.filter(c => c.passed === true).length,
      retries: claimList.reduce((sum, c) => sum + new Set(c.searches.filter(s => s.attempt > 1).map(s => s.attempt)).size, 0),
      requestedRevisions: reviews.filter(r => r.passed === false).length,
      failedTools: runList.flatMap(r => [...r.tools.values()]).filter(t => ['error', 'timeout'].includes(t.status)).length, totals }
  };
}
