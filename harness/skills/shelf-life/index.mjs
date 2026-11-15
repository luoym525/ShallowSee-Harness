import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createEventLog } from '../../../packages/event-log/index.mjs';
import { CATEGORIES, documentLines } from '../../../packages/shelf-life/checks.mjs';
import { extractionRequest, ProviderError, verificationRequest } from '../../../packages/shelf-life/providers.mjs';
import { runDirect } from '../../../packages/shelf-life/runner.mjs';

const string = { type: 'string' };
const integer = { type: 'integer' };
const enumOf = (...values) => ({ type: 'string', enum: values });
const arrayOf = items => ({ type: 'array', items });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});

const inputSchema = object({
  doc: object({ label: { ...string, minLength: 1, maxLength: 250 }, markdown: { ...string, minLength: 1 } }),
  maxClaims: { ...integer, minimum: 1, maximum: 12 },
}, ['doc']);

const sourceSchema = object({ name: string, url: string, domain: string, snippet: string, retrievedAt: string });
const checkSchema = object({
  check: enumOf('quote_in_doc', 'independent_sources', 'correction_supported', 'patch_scope'),
  passed: { type: 'boolean' }, detail: string,
});
const outputSchema = object({
  status: enumOf('completed', 'skipped', 'failed'), reason: nullable(string),
  childRoomId: nullable(string), doc: nullable(object({ label: string, sha256: string })),
  findings: arrayOf(object({
    claimId: string, line: integer, quote: string, statement: string, category: enumOf(...CATEGORIES),
    verdict: enumOf('fresh', 'stale', 'unsure'), currentValue: nullable(string), correction: nullable(string),
    sources: arrayOf(sourceSchema), checks: arrayOf(checkSchema),
  })),
  diff: nullable(string), reviewStatus: enumOf('unreviewed'), searchesUsed: { ...integer, minimum: 0 },
});

const EMPTY = { status: 'failed', reason: null, childRoomId: null, doc: null, findings: [], diff: null, reviewStatus: 'unreviewed', searchesUsed: 0 };
const CANCEL_REASON = 'Shelf Life audit cancelled.';
const AUDIT_FAILED = 'Shelf Life audit did not complete. See the child-room evidence when available.';
const ROOM_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function isRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fields(value, required, optional = []) {
  if (!isRecord(value) || !required.every(key => Object.hasOwn(value, key))) return false;
  return Reflect.ownKeys(value).every(key => {
    const item = Object.getOwnPropertyDescriptor(value, key);
    return (required.includes(key) || optional.includes(key)) && item?.enumerable && 'value' in item;
  });
}

function destination(ctx) {
  const location = ctx.childRoom;
  if (!location || typeof location.rootDir !== 'string' || !location.rootDir ||
      typeof location.roomId !== 'string' || !ROOM_ID.test(location.roomId) ||
      typeof location.parentRoomId !== 'string' || !ROOM_ID.test(location.parentRoomId) ||
      location.roomId === location.parentRoomId) return null;
  return location;
}

function usage(value) {
  const source = value?.source;
  const known = source === 'provider' || source === 'estimated';
  const tokens = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const inputTokens = known ? tokens(value.inputTokens) : null;
  const outputTokens = known ? tokens(value.outputTokens) : null;
  const costUsd = known && Number.isFinite(value.costUsd) && value.costUsd >= 0 ? value.costUsd : null;
  return { inputTokens, outputTokens, costUsd, source: inputTokens === null && outputTokens === null && costUsd === null ? 'unknown' : source };
}

function modelAdapter(ctx, model) {
  async function request(builder, input) {
    const { system, data, name, schema } = builder(input);
    let result;
    try {
      result = await ctx.llm({
        system, messages: [{ role: 'user', content: JSON.stringify(data) }],
        responseSchema: { name, schema }, maxTokens: 16000, timeoutMs: input.timeoutMs, signal: input.signal,
      });
    } catch (error) {
      const auth = error?.code === 'auth';
      throw new ProviderError(auth ? 'model_auth' : 'model_failed',
        auth ? 'The routed model authentication failed.' : 'The routed model request failed.', error?.retryable === true);
    }
    const measured = usage(result?.usage);
    if (result?.stopReason !== 'end' || !isRecord(result.json) || (result.toolCalls?.length ?? 0) > 0) {
      throw new ProviderError('model_output', 'The routed model did not return a complete structured answer.', false, { usage: measured });
    }
    return { value: result.json, usage: measured, stopReason: result.stopReason };
  }
  return {
    model,
    extract: input => request(extractionRequest, input),
    verify: input => request(verificationRequest, input),
  };
}

function timestamp(value, fallback) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
}

function searchAdapter(ctx, count) {
  return async ({ query, depth, timeoutMs, signal }) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, Math.max(1, timeoutMs));
    try {
      if (controller.signal.aborted) throw new ProviderError('search_timeout', 'The search deadline was reached.');
      count();
      const response = await ctx.search({ query, depth, maxResults: 8, signal: controller.signal });
      if (controller.signal.aborted) throw new ProviderError('search_timeout', 'The search deadline was reached.');
      if (!Array.isArray(response?.sources)) throw new ProviderError('search_output', 'The search provider did not return sources.');
      const retrievedAt = new Date(ctx.now()).toISOString();
      return { answer: response.answer, sources: response.sources.map(source => source && ({
        ...source, retrievedAt: timestamp(source.retrievedAt, retrievedAt),
      })) };
    } catch (error) {
      if (controller.signal.aborted || error?.code === 'timeout') throw new ProviderError('search_timeout', 'The search deadline was reached.');
      if (error instanceof ProviderError && error.code === 'search_output') throw error;
      const auth = error?.code === 'auth';
      throw new ProviderError(auth ? 'linkup_auth' : 'search_failed',
        auth ? 'The search provider authentication failed.' : 'The search request failed.', error?.retryable === true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}

function projectEvidence(events) {
  const anchors = new Map();
  const checks = new Map();
  const findings = [];
  for (const { type, payload } of events) {
    const { claimId, attempt } = payload;
    if (type === 'shelflife.claim.extracted') anchors.set(claimId, payload);
    if (type === 'shelflife.check.result') {
      const key = claimId + ':' + attempt;
      const entries = checks.get(key) ?? [];
      entries.push({ check: payload.check, passed: payload.passed, detail: payload.detail });
      checks.set(key, entries);
    }
    if (type === 'shelflife.verdict.final') {
      const { lineStart: line, quote, statement, category } = anchors.get(claimId);
      const { verdict, currentValue, correction, sources, attempts } = payload;
      findings.push({ claimId, line, quote, statement, category, verdict, currentValue, correction, sources,
        checks: checks.get(claimId + ':' + attempts) ?? [] });
    }
  }
  return findings;
}

async function run(input, ctx) {
  const state = { ...EMPTY, findings: [] };
  try {
    if (!fields(input, ['doc'], ['maxClaims']) || !fields(input.doc, ['label', 'markdown'])) {
      return { ...state, reason: 'Invalid Shelf Life input.' };
    }
    const { label, markdown } = input.doc;
    documentLines(label, markdown);
    const maxClaims = Object.hasOwn(input, 'maxClaims') ? input.maxClaims : 4;
    if (!Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > 12) {
      return { ...state, reason: 'Invalid Shelf Life claim limit.' };
    }
    state.doc = { label, sha256: createHash('sha256').update(markdown).digest('hex') };
    if (ctx?.search === null) return { ...state, status: 'skipped', reason: 'no search provider' };
    if (ctx?.signal?.aborted) return { ...state, reason: CANCEL_REASON };

    const location = ctx && destination(ctx);
    const identity = ctx?.providerIdentity;
    if (!location || typeof ctx.llm !== 'function' || typeof ctx.search !== 'function' || typeof ctx.now !== 'function' ||
        !identity || typeof identity.provider !== 'string' || !identity.provider.trim() ||
        typeof identity.model !== 'string' || !/^[^/]+\/.+$/u.test(identity.model)) {
      return { ...state, reason: 'Invalid Shelf Life host context.' };
    }
    const writer = await createEventLog({ rootDir: location.rootDir, roomId: location.roomId });
    const events = [];
    let result;
    try {
      if ((await stat(writer.logPath)).size > 0) {
        return { ...state, childRoomId: writer.roomId, reason: 'The Shelf Life child room already contains an audit.' };
      }
      result = await runDirect({
        writer: { async append(event) {
          const record = await writer.append(event);
          if (record.type === 'room.created') state.childRoomId = writer.roomId;
          if (record.type.startsWith('shelflife.')) events.push(record);
          return record;
        } },
        doc: label, markdown, maxClaims, parentRoomId: location.parentRoomId, signal: ctx.signal,
        now: () => new Date(ctx.now()), modelProvider: modelAdapter(ctx, identity.model),
        searchProvider: searchAdapter(ctx, () => { state.searchesUsed++; }),
        ...(ctx.synthetic === true ? { synthetic: true } : {
          providerIdentity: { model: { provider: identity.provider, mode: 'api' }, search: { provider: 'linkup', mode: 'api' } },
        }),
      });
    } finally {
      await writer.close();
    }
    if (result.status !== 'completed') return { ...state, reason: result.status === 'cancelled' ? CANCEL_REASON : AUDIT_FAILED };
    return { ...state, status: 'completed', findings: projectEvidence(events), diff: result.diff || null };
  } catch {
    return { ...state, reason: ctx?.signal?.aborted ? CANCEL_REASON : AUDIT_FAILED };
  }
}

export const shelfLife = Object.freeze({
  id: 'shelf-life',
  name: 'Shelf Life',
  description: 'Audit time-sensitive Markdown claims and propose cited corrections for human review.',
  version: '1.0.0',
  needs: Object.freeze({ search: true, llm: true }),
  allowedPhases: Object.freeze(['plan_check', 'fact_check']),
  inputSchema,
  outputSchema,
  run,
});
