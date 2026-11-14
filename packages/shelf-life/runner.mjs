import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assessment, cleanAnswer, cleanSources, documentLines, makeDiff, normalizeClaims, queryFor } from './checks.mjs';
import { ProviderError } from './providers.mjs';

const SYSTEM = { memberId: null, role: 'system', mode: 'system', provider: null, model: null, identitySource: 'configured' };
const UNKNOWN = { inputTokens: null, outputTokens: null, costUsd: null, source: 'unknown' };
const ROOM_VERSION = 1;
const TASK_ID = 'task_audit';
const MAX_CLAIMS = 12;
const DEFAULT_CLAIMS = 4;
const VERIFY_TIMEOUT = 180;
const elapsed = t => Math.max(0, Math.round(performance.now() - t));
const errorCode = error => error instanceof ProviderError ? error.code : 'invalid_provider_output';
const safeError = error => error instanceof ProviderError ? error.message : 'The operation returned invalid data or failed.';

function provider(model, providerName, id, role, synthetic) {
  return { memberId: id, role, mode: synthetic ? 'system' : 'api', provider: synthetic ? null : providerName, model: synthetic ? null : model, identitySource: 'configured' };
}

function member(provenance, displayName) {
  const { memberId, role, mode, provider, model } = provenance;
  return { memberId, displayName, role, mode, provider, model,
    capabilities: { tools: false, cancel: false, resume: false, streaming: 'none', usage: 'unknown' } };
}

export async function runDirect({
  writer, doc, markdown, modelProvider, searchProvider,
  maxClaims = DEFAULT_CLAIMS, synthetic = false, now = () => new Date(),
}) {
  const lines = documentLines(doc, markdown);
  if (!writer || typeof writer.append !== 'function' || typeof modelProvider?.extract !== 'function'
      || typeof modelProvider?.verify !== 'function' || typeof searchProvider !== 'function') throw new Error('Audit requires writer, extraction, verification and search providers.');
  if (!synthetic && (typeof modelProvider.model !== 'string' || !modelProvider.model.trim())) throw new Error('Configure the model provenance for a live audit.');
  if (!Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > MAX_CLAIMS) throw new Error('maxClaims must be an integer from 1 to ' + MAX_CLAIMS + '.');

  const observedAt = now().toISOString();
  const documentSha256 = createHash('sha256').update(markdown).digest('hex');
  const deadline = performance.now() + VERIFY_TIMEOUT * 1000;
  const maxRuns = 1 + maxClaims * 5;
  const researcher = provider(modelProvider.model, 'anthropic', 'm_researcher', 'researcher', synthetic);
  const reviewer = provider(modelProvider.model, 'anthropic', 'm_reviewer', 'reviewer', synthetic);
  const searcher = provider(null, 'linkup', 'm_linkup', 'researcher', synthetic);
  const emit = (type, payload, options = {}) => writer.append({
    type, provenance: SYSTEM, payload, ...options,
  });
  const task = (type, payload) => emit(type, payload, { taskId: TASK_ID });
  const room = await emit('room.created', {
    goal: 'Audit time-sensitive claims in ' + doc,
    acceptanceCriteria: ['Each supported correction is proposed with cited review evidence.', 'Evidence gaps stay visible for human review.'],
    constraints: ['Read-only input and external sources.', 'No automatic application or publication of corrections.'],
    limits: { maxRuns, maxMinutes: VERIFY_TIMEOUT / 60, maxUsd: null },
    workflow: 'shelf-life', driver: 'direct', roomVersion: ROOM_VERSION, ...(synthetic ? { synthetic: true } : {}),
  });
  await emit('member.joined', member(researcher, synthetic ? 'Synthetic extractor' : 'Anthropic extractor'));
  await emit('member.joined', member(reviewer, synthetic ? 'Synthetic verifier' : 'Anthropic verifier'));
  await emit('member.joined', member(searcher, synthetic ? 'Synthetic search' : 'Linkup search'));
  const started = await task('task.created', {
    title: 'Generate a cited audit for ' + doc, owner: null, dependencies: [], inputs: { doc, documentSha256 },
    deliverables: ['Claim verdicts', 'Optional scoped patch for review'],
    acceptance: room.payload.acceptanceCriteria,
    status: 'ready', version: 1,
  });
  await task('task.updated', { status: 'running', version: 2 });

  let runCount = 0;
  let failedSearches = 0;
  function assertLive() {
    if (performance.now() >= deadline) throw new ProviderError('time_limit', 'Workflow time limit reached.');
    if (++runCount > maxRuns) throw new ProviderError('run_limit', 'Workflow run limit reached.');
    return Math.floor(Math.max(1, deadline - performance.now()));
  }

  async function modelRun(provenance, triggerEventId, attempt, operation, invoke, check, summary) {
    const timeoutMs = assertLive();
    const runId = randomUUID();
    const runOptions = { runId, taskId: TASK_ID, provenance };
    await emit('run.started', { memberId: provenance.memberId, provider: provenance.provider, model: provenance.model, attempt, triggerEventId, roomVersion: ROOM_VERSION }, runOptions);
    const t = performance.now();
    let outcome, checked;
    try {
      outcome = await invoke(timeoutMs);
      checked = check(outcome?.value);
    } catch (error) {
      const recorded = outcome ?? error?.result;
      const actual = recorded?.model && !synthetic ? { ...provenance, model: recorded.model, identitySource: 'provider_reported' } : provenance;
      await emit('run.failed', { error: { code: errorCode(error), message: safeError(error) },
        retryable: error instanceof ProviderError && error.retryable, usage: synthetic ? UNKNOWN : recorded?.usage ?? UNKNOWN, durationMs: elapsed(t) },
      { ...runOptions, provenance: actual });
      if (errorCode(error) === 'anthropic_auth') throw error;
      return null;
    }
    const actual = outcome?.model && !synthetic ? { ...provenance, model: outcome.model, identitySource: 'provider_reported' } : provenance;
    const terminalOptions = { ...runOptions, provenance: actual };
    await emit('run.output', { channel: 'summary', delta: operation + ': ' + summary(checked) }, terminalOptions);
    await emit('run.completed', { stopReason: outcome.stopReason ?? null, usage: synthetic ? UNKNOWN : outcome.usage ?? UNKNOWN, durationMs: elapsed(t) }, terminalOptions);
    return { checked, runId, provenance: actual };
  }

  async function search(claim, attempt, stage, triggerEventId) {
    const timeoutMs = assertLive();
    const runId = randomUUID();
    const runOptions = { runId, taskId: TASK_ID, provenance: searcher };
    const query = queryFor(claim, stage);
    const depth = 'standard';
    const name = synthetic ? 'synthetic_search' : 'linkup_search';
    const toolCallId = randomUUID();
    await emit('run.started', { memberId: searcher.memberId, provider: searcher.provider, model: null, attempt, triggerEventId, roomVersion: ROOM_VERSION }, runOptions);
    await emit('tool.called', { toolCallId, name, args: { claimId: claim.claimId, depth } }, runOptions);
    const t = performance.now();
    let result;
    try {
      const raw = await searchProvider({ query, depth, claim, stage, attempt, timeoutMs });
      if (!Array.isArray(raw?.sources)) throw new ProviderError('linkup_output', 'Search did not return valid sources.');
      result = { answer: cleanAnswer(raw.answer), sources: cleanSources(raw.sources) };
    } catch (error) {
      failedSearches++;
      const info = { code: errorCode(error), message: safeError(error) };
      const status = info.code === 'linkup_timeout' ? 'timeout' : 'error';
      await emit('tool.result', { toolCallId, name, status, summary: info.message, durationMs: elapsed(t) }, runOptions);
      await emit('run.failed', { error: info, retryable: error instanceof ProviderError && error.retryable, usage: UNKNOWN, durationMs: elapsed(t) }, runOptions);
      if (info.code === 'linkup_auth') throw error;
      return null;
    }
    await emit('tool.result', { toolCallId, name, status: 'ok', summary: result.sources.length + ' usable source snippets', durationMs: elapsed(t) }, runOptions);
    await emit('shelflife.search.completed', { claimId: claim.claimId, attempt, query, provider: 'linkup', depth, ...result, durationMs: elapsed(t) }, runOptions);
    await emit('run.completed', { stopReason: null, usage: UNKNOWN, durationMs: elapsed(t) }, runOptions);
    return result;
  }

  try {
    const extracted = await modelRun(researcher, started.eventId, 1, 'Claim extraction',
      timeoutMs => modelProvider.extract({ lines: lines.map((text, i) => ({ line: i + 1, text })), maxClaims, timeoutMs }),
      value => normalizeClaims(value, doc, lines, maxClaims),
      data => data.claims.length + ' anchored claims; ' + data.rejected + ' rejected');
    if (!extracted) throw new ProviderError('extraction_failed', 'Claim extraction failed; no conclusions were created.');

    const { claims, rejected } = extracted.checked;
    if (claims.length === 0 && rejected > 0) throw new ProviderError('unanchored_extraction', 'No proposed claim matched its source position.');
    const perLine = new Map();
    for (const claim of claims) perLine.set(claim.lineStart, (perLine.get(claim.lineStart) ?? 0) + 1);
    const final = [];
    const edits = [];
    for (const claim of claims) {
      const claimEvent = await emit('shelflife.claim.extracted', claim, {
        taskId: TASK_ID, runId: extracted.runId, provenance: extracted.provenance,
      });
      let original = await search(claim, 1, 0, claimEvent.eventId);
      let verdict = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const confirm = await search(claim, attempt, attempt, claimEvent.eventId);
        if (attempt === 1 && !original?.sources.length && confirm?.sources.length) {
          original = confirm;
          continue;
        }
        const byUrl = new Map();
        const originalSources = original?.sources ?? [];
        const confirmedSources = confirm?.sources ?? [];
        for (const source of [...confirmedSources, ...originalSources]) if (!byUrl.has(source.url)) byUrl.set(source.url, source);
        const available = [...byUrl.values()];
        const evaluated = available.length ? await modelRun(reviewer, claimEvent.eventId, attempt, 'Verdict verification',
          timeoutMs => modelProvider.verify({ claim, sources: available, observedAt, timeoutMs }),
          value => assessment(value, claim, available, originalSources, confirmedSources, lines[claim.lineStart - 1], perLine.get(claim.lineStart) === 1),
          data => 'proposed ' + data.proposed.verdict) : null;
        if (evaluated) {
          await emit('shelflife.verdict.proposed', { claimId: claim.claimId, attempt, ...evaluated.checked.proposed },
            { runId: evaluated.runId, taskId: TASK_ID, provenance: evaluated.provenance });
          for (const check of evaluated.checked.checks) await emit('shelflife.check.result', { claimId: claim.claimId, attempt, ...check }, { taskId: TASK_ID });
        }
        const accepted = evaluated?.checked.final;
        if (accepted && accepted.verdict !== 'unsure') {
          verdict = { ...accepted, attempts: attempt, escalated: false };
          break;
        }
        if (attempt === 2) verdict = { verdict: 'unsure', currentValue: null, correction: null, sources: accepted?.sources ?? available, attempts: attempt, escalated: true };
      }
      const finalEvent = await emit('shelflife.verdict.final', { claimId: claim.claimId, ...verdict }, { taskId: TASK_ID });
      final.push({ claimId: claim.claimId, verdict: verdict.verdict, eventId: finalEvent.eventId });
      if (verdict.verdict === 'stale') edits.push({ claimId: claim.claimId, line: claim.lineStart, quote: claim.quote, correction: verdict.correction });
    }
    const diff = makeDiff(doc, lines, edits, markdown);
    if (diff) await emit('shelflife.patch.proposed', { doc, documentSha256, claimIds: edits.map(e => e.claimId), diff }, { taskId: TASK_ID });
    await task('task.review', { requestedBy: reviewer.memberId, artifactIds: [], version: 3 });
    await emit('room.closed', { status: 'completed', summary: final.length + ' findings; corrections and unresolved claims await human review.' });
    return { roomId: room.roomId, driver: 'direct', synthetic, doc, documentSha256, claimCount: final.length, rejectedClaims: rejected, failedSearches, findings: final, diff, status: 'completed' };
  } catch (error) {
    if (error?.name === 'EventLogError') throw error;
    await task('task.failed', { reason: safeError(error), version: 3 });
    await emit('room.closed', { status: 'failed', summary: safeError(error) });
    return { roomId: room.roomId, driver: 'direct', synthetic, status: 'failed', reason: safeError(error) };
  }
}
