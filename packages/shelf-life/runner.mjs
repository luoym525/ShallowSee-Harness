import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assessment, cleanAnswer, cleanSources, documentLines, makeDiff, normalizeClaims, queryFor } from './checks.mjs';
import { ProviderError } from './providers.mjs';
import { PUBLISH_TIMEOUT_MS } from './publish.mjs';

const SYSTEM = { memberId: null, role: 'system', mode: 'system', provider: null, model: null, identitySource: 'configured' };
const UNKNOWN = { inputTokens: null, outputTokens: null, costUsd: null, source: 'unknown' };
const ROOM_VERSION = 1;
const TASK_ID = 'task_audit';
const MAX_CLAIMS = 12;
const DEFAULT_CLAIMS = 4;
const CANCELLED = 'audit_cancelled';
const CANCEL_REASON = 'The audit was cancelled.';
const LEGACY_IDENTITY = { model: { provider: 'anthropic', mode: 'api' }, search: { provider: 'linkup', mode: 'api' } };
const PROVIDER_MODES = new Set(['api', 'cli', 'external_mcp', 'local_model', 'system']);
// One minute for extraction and bookkeeping, plus 75 seconds per claim: up to three
// searches and two model verdicts, run one after another.
export const timeBudgetSeconds = maxClaims => 60 + 75 * maxClaims;
const elapsed = t => Math.max(0, Math.round(performance.now() - t));
const errorCode = error => error instanceof ProviderError ? error.code : 'invalid_provider_output';
const safeError = error => error instanceof ProviderError ? error.message : 'The operation returned invalid data or failed.';

function provider(model, identity, id, role, synthetic) {
  return { memberId: id, role, mode: synthetic ? 'system' : identity.mode, provider: synthetic ? null : identity.provider, model: synthetic ? null : model, identitySource: 'configured' };
}

function readIdentity(value) {
  const valid = source => source && typeof source === 'object' && Object.keys(source).length === 2 &&
    Object.hasOwn(source, 'provider') && Object.hasOwn(source, 'mode') && PROVIDER_MODES.has(source.mode) &&
    typeof source.provider === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9 ._/-]{0,79}$/u.test(source.provider) &&
    source.provider.trim() === source.provider;
  if (!value || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'model') || !Object.hasOwn(value, 'search') ||
      !valid(value.model) || !valid(value.search)) throw new Error('Configure trusted model and search provider identities.');
  return { model: { ...value.model }, search: { ...value.search } };
}

function member(provenance, displayName) {
  const { memberId, role, mode, provider, model } = provenance;
  return { memberId, displayName, role, mode, provider, model,
    capabilities: { tools: false, cancel: false, resume: false, streaming: 'none', usage: 'unknown' } };
}

export async function runDirect({
  writer, doc, markdown, modelProvider, searchProvider,
  maxClaims = DEFAULT_CLAIMS, synthetic = false, now = () => new Date(), publisher = null,
  signal, providerIdentity, parentRoomId,
}) {
  const lines = documentLines(doc, markdown);
  if (!writer || typeof writer.append !== 'function' || typeof modelProvider?.extract !== 'function'
      || typeof modelProvider?.verify !== 'function' || typeof searchProvider !== 'function') throw new Error('Audit requires writer, extraction, verification and search providers.');
  if (!synthetic && (typeof modelProvider.model !== 'string' || !modelProvider.model.trim())) throw new Error('Configure the model provenance for a live audit.');
  if (!Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > MAX_CLAIMS) throw new Error('maxClaims must be an integer from 1 to ' + MAX_CLAIMS + '.');
  if (publisher !== null && typeof publisher !== 'function') throw new Error('publisher must be a function when it is provided.');
  if (synthetic && publisher) throw new Error('Synthetic audits cannot publish corrections.');
  if (synthetic && providerIdentity !== undefined) throw new Error('Synthetic audits do not use live provider identities.');
  const identity = providerIdentity === undefined ? LEGACY_IDENTITY : readIdentity(providerIdentity);
  const invocationOptions = signal ? { signal } : {};
  const cancelled = () => new ProviderError(CANCELLED, CANCEL_REASON);
  const checkCancelled = () => {
    if (signal?.aborted) throw cancelled();
  };
  if (signal?.aborted) return { roomId: null, driver: 'direct', synthetic, status: 'cancelled', reason: CANCEL_REASON };

  const observedAt = now().toISOString();
  const documentSha256 = createHash('sha256').update(markdown).digest('hex');
  const budgetSeconds = timeBudgetSeconds(maxClaims);
  const deadline = performance.now() + budgetSeconds * 1000;
  const maxRuns = 1 + maxClaims * 5 + (publisher ? 1 : 0);
  const researcher = provider(modelProvider.model, identity.model, 'm_researcher', 'researcher', synthetic);
  const reviewer = provider(modelProvider.model, identity.model, 'm_reviewer', 'reviewer', synthetic);
  const searcher = provider(null, identity.search, identity.search.provider === 'linkup' ? 'm_linkup' : 'm_search', 'researcher', synthetic);
  const modelLabel = synthetic ? 'Synthetic' : providerIdentity === undefined ? 'Anthropic' : identity.model.provider;
  const searchLabel = synthetic ? 'Synthetic' : providerIdentity === undefined ? 'Linkup' : identity.search.provider;
  const builder = { memberId: 'm_publisher', role: 'builder', mode: 'system', provider: 'github', model: null, identitySource: 'configured' };
  const emit = (type, payload, options = {}) => writer.append({
    type, provenance: SYSTEM, payload, ...options,
  });
  const task = (type, payload) => emit(type, payload, { taskId: TASK_ID });
  const room = await emit('room.created', {
    goal: 'Audit time-sensitive claims in ' + doc,
    acceptanceCriteria: ['Each supported correction is proposed with cited review evidence.', 'Evidence gaps stay visible for human review.'],
    constraints: ['Read-only input and external sources.', publisher
      ? 'Corrections are published as a new branch and optional pull request for human review. Merging requires a person.'
      : 'No automatic application or publication of corrections.'],
    limits: { maxRuns, maxMinutes: (budgetSeconds + (publisher ? PUBLISH_TIMEOUT_MS / 1000 : 0)) / 60, maxUsd: null },
    workflow: 'shelf-life', driver: 'direct', roomVersion: ROOM_VERSION, ...(synthetic ? { synthetic: true } : {}),
    ...(parentRoomId === undefined ? {} : { parentRoomId }),
  });
  await emit('member.joined', member(researcher, modelLabel + ' extractor'));
  await emit('member.joined', member(reviewer, modelLabel + ' verifier'));
  await emit('member.joined', member(searcher, searchLabel + ' search'));
  if (publisher) await emit('member.joined', member(builder, 'Pull request publisher'));
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
    checkCancelled();
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
      checkCancelled();
      outcome = await invoke(timeoutMs);
      checkCancelled();
      checked = check(outcome?.value);
    } catch (error) {
      if (signal?.aborted) {
        await emit('run.cancelled', { reason: CANCEL_REASON }, runOptions);
        throw cancelled();
      }
      const recorded = outcome ?? error?.result;
      const actual = recorded?.model && !synthetic ? { ...provenance, model: recorded.model, identitySource: 'provider_reported' } : provenance;
      await emit('run.failed', { error: { code: errorCode(error), message: safeError(error) },
        retryable: error instanceof ProviderError && error.retryable, usage: synthetic ? UNKNOWN : recorded?.usage ?? UNKNOWN, durationMs: elapsed(t) },
      { ...runOptions, provenance: actual });
      if (['anthropic_auth', 'model_auth'].includes(errorCode(error))) throw error;
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
    const name = synthetic ? 'synthetic_search' : identity.search.provider === 'linkup' ? 'linkup_search' : 'web_search';
    const toolCallId = randomUUID();
    await emit('run.started', { memberId: searcher.memberId, provider: searcher.provider, model: null, attempt, triggerEventId, roomVersion: ROOM_VERSION }, runOptions);
    await emit('tool.called', { toolCallId, name, args: { claimId: claim.claimId, depth } }, runOptions);
    const t = performance.now();
    let result;
    try {
      checkCancelled();
      const raw = await searchProvider({ query, depth, claim, stage, attempt, timeoutMs, ...invocationOptions });
      checkCancelled();
      if (!Array.isArray(raw?.sources)) throw new ProviderError(name === 'linkup_search' ? 'linkup_output' : 'search_output', 'Search did not return valid sources.');
      result = { answer: cleanAnswer(raw.answer), sources: cleanSources(raw.sources) };
    } catch (error) {
      if (signal?.aborted) {
        await emit('tool.result', { toolCallId, name, status: 'error', summary: CANCEL_REASON, durationMs: elapsed(t) }, runOptions);
        await emit('run.cancelled', { reason: CANCEL_REASON }, runOptions);
        throw cancelled();
      }
      failedSearches++;
      const info = { code: errorCode(error), message: safeError(error) };
      const status = info.code.endsWith('_timeout') ? 'timeout' : 'error';
      await emit('tool.result', { toolCallId, name, status, summary: info.message, durationMs: elapsed(t) }, runOptions);
      await emit('run.failed', { error: info, retryable: error instanceof ProviderError && error.retryable, usage: UNKNOWN, durationMs: elapsed(t) }, runOptions);
      if (info.code === 'linkup_auth') throw error;
      return null;
    }
    await emit('tool.result', { toolCallId, name, status: 'ok', summary: result.sources.length + ' usable source snippets', durationMs: elapsed(t) }, runOptions);
    await emit('shelflife.search.completed', { claimId: claim.claimId, attempt, query, provider: synthetic ? 'synthetic' : searcher.provider, depth, ...result, durationMs: elapsed(t) }, runOptions);
    await emit('run.completed', { stopReason: null, usage: UNKNOWN, durationMs: elapsed(t) }, runOptions);
    return result;
  }

  // Publishes the validated patch as a branch and, when possible, a pull request.
  // A pull request is recorded only when the publisher returns a real number and address.
  async function publish(patchEvent, edits, diff, artifactIds) {
    checkCancelled();
    if (++runCount > maxRuns) return null;
    const runId = randomUUID();
    const runOptions = { runId, taskId: TASK_ID, provenance: builder };
    const toolCallId = randomUUID();
    const name = 'open_pull_request';
    const claimIds = edits.map(e => e.claimId);
    const evidence = [{ kind: 'check', ref: patchEvent.eventId, summary: 'The published change is the patch that passed the patch_scope check.', passed: true }];
    await emit('run.started', { memberId: builder.memberId, provider: builder.provider, model: null, attempt: 1, triggerEventId: patchEvent.eventId, roomVersion: ROOM_VERSION }, runOptions);
    await emit('tool.called', { toolCallId, name, args: { doc, claimIds } }, runOptions);
    const t = performance.now();
    let result;
    try {
      checkCancelled();
      result = await publisher({ roomId: room.roomId, doc, documentSha256, diff, timeoutMs: PUBLISH_TIMEOUT_MS,
        corrections: edits.map(({ claimId, line, oldValue, currentValue, sources }) => ({ claimId, line, oldValue, currentValue, sources })) });
      if (!result || !/^[0-9a-f]{40}$/u.test(result.commit) || typeof result.branch !== 'string' || typeof result.repo !== 'string'
          || typeof result.compareUrl !== 'string' || !result.compareUrl.startsWith('https://')) throw new ProviderError('publish_output', 'The publisher did not return a branch and commit.');
    } catch (error) {
      if (signal?.aborted) {
        await emit('tool.result', { toolCallId, name, status: 'error', summary: CANCEL_REASON, durationMs: elapsed(t) }, runOptions);
        await emit('run.cancelled', { reason: CANCEL_REASON }, runOptions);
        throw cancelled();
      }
      const info = { code: error instanceof ProviderError ? error.code : 'publish_failed', message: safeError(error) };
      await emit('tool.result', { toolCallId, name, status: 'error', summary: info.message, durationMs: elapsed(t) }, runOptions);
      await emit('run.failed', { error: info, retryable: error instanceof ProviderError && error.retryable, usage: UNKNOWN, durationMs: elapsed(t) }, runOptions);
      return null;
    }
    const { repo, branch, commit, compareUrl } = result;
    const opened = Number.isSafeInteger(result.number) && result.number > 0 && typeof result.url === 'string' && result.url.startsWith('https://');
    if (opened) {
      const artifactId = 'pr_' + result.number;
      await emit('tool.result', { toolCallId, name, status: 'ok', summary: 'Pull request #' + result.number + ' opened for review.', durationMs: elapsed(t) }, runOptions);
      await emit('shelflife.pr.opened', { repo, number: result.number, url: result.url, branch, commit, claimIds }, runOptions);
      await emit('artifact.registered', { artifactId, kind: 'pull_request', location: result.url, version: commit, evidence }, { taskId: TASK_ID, provenance: builder });
      await emit('run.completed', { stopReason: null, usage: UNKNOWN, durationMs: elapsed(t) }, runOptions);
      artifactIds.push(artifactId);
      return { repo, branch, commit, number: result.number, url: result.url, compareUrl };
    }
    const artifactId = 'branch_' + commit.slice(0, 12);
    const failed = !!result.prError && typeof result.prError.code === 'string';
    const summary = failed ? 'The branch was pushed, but no pull request was confirmed: ' + String(result.prError.message)
      : 'The branch was pushed. No token was configured, so no pull request was opened.';
    await emit('tool.result', { toolCallId, name, status: failed ? 'error' : 'ok', summary, durationMs: elapsed(t) }, runOptions);
    await emit('artifact.registered', { artifactId, kind: 'patch', location: compareUrl, version: commit, evidence }, { taskId: TASK_ID, provenance: builder });
    if (failed) await emit('run.failed', { error: { code: result.prError.code, message: String(result.prError.message) }, retryable: false, usage: UNKNOWN, durationMs: elapsed(t) }, runOptions);
    else await emit('run.completed', { stopReason: null, usage: UNKNOWN, durationMs: elapsed(t) }, runOptions);
    artifactIds.push(artifactId);
    return { repo, branch, commit, number: null, url: null, compareUrl };
  }

  try {
    const extracted = await modelRun(researcher, started.eventId, 1, 'Claim extraction',
      timeoutMs => modelProvider.extract({ lines: lines.map((text, i) => ({ line: i + 1, text })), maxClaims, timeoutMs, ...invocationOptions }),
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
      checkCancelled();
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
          timeoutMs => modelProvider.verify({ claim, sources: available, observedAt, timeoutMs, ...invocationOptions }),
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
      if (verdict.verdict === 'stale') edits.push({ claimId: claim.claimId, line: claim.lineStart, quote: claim.quote, correction: verdict.correction,
        oldValue: claim.oldValue, currentValue: verdict.currentValue, sources: verdict.sources });
    }
    checkCancelled();
    const diff = makeDiff(doc, lines, edits, markdown);
    const patchEvent = diff ? await emit('shelflife.patch.proposed', { doc, documentSha256, claimIds: edits.map(e => e.claimId), diff }, { taskId: TASK_ID }) : null;
    const artifactIds = [];
    const publication = patchEvent && publisher ? await publish(patchEvent, edits, diff, artifactIds) : null;
    checkCancelled();
    await task('task.review', { requestedBy: reviewer.memberId, artifactIds, version: 3 });
    checkCancelled();
    await emit('room.closed', { status: 'completed', summary: final.length + ' findings; corrections and unresolved claims await human review.' });
    return { roomId: room.roomId, driver: 'direct', synthetic, doc, documentSha256, claimCount: final.length, rejectedClaims: rejected, failedSearches, findings: final, diff, publication, status: 'completed' };
  } catch (error) {
    if (error?.name === 'EventLogError') throw error;
    if (signal?.aborted) {
      await task('task.cancelled', { reason: CANCEL_REASON, version: 3 });
      await emit('room.closed', { status: 'cancelled', summary: CANCEL_REASON });
      return { roomId: room.roomId, driver: 'direct', synthetic, status: 'cancelled', reason: CANCEL_REASON };
    }
    await task('task.failed', { reason: safeError(error), version: 3 });
    await emit('room.closed', { status: 'failed', summary: safeError(error) });
    return { roomId: room.roomId, driver: 'direct', synthetic, status: 'failed', reason: safeError(error) };
  }
}
