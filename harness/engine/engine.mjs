// The ShallowSee Autopilot state machine (ARCHITECTURE §1): one wish → one delivered product,
// with no question to the user during the run. Every arrow is code; models only return labels
// that the hard rules in rules.mjs validate first.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventLog as defaultCreateEventLog } from '../../packages/event-log/index.mjs';
import { resolveDeps } from './deps.mjs';
import { renderPlanFacts } from './plan-facts.mjs';
import { fallbackReport } from './report-fallback.mjs';
import {
  applyPlanReviewRules, confirmedStaleFindings, decideStatus, itemChecksPass, normalizeViolations, orderItems,
  overrideReflection, reportAllPassed,
} from './rules.mjs';
import {
  CancelledError, EngineError, LimitExceededError, iso, isRecord, json, makeRedactor, makeRunId, normalizeUsage, pad,
  providerOf, sha256, truncate, writeAtomic,
} from './util.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DATA_DIR = join(REPO_ROOT, 'data');

export const MAX_PLAN_REVISIONS = 2;   // so at most 3 specs per plan loop
export const MAX_ATTEMPTS = 3;         // per work item
export const MAX_REPLANS = 1;          // per run
export const SKILL_ID = 'shelf-life';
const SKILL_MAX_CLAIMS = 4;
const DEFAULT_LIMITS = { maxUsdPerRun: 5, maxMinutesPerRun: 40, maxBuildIterations: 12 };
const ENGINE = Object.freeze({ memberId: null, role: 'engine', mode: 'system', provider: null, model: null, identitySource: 'configured' });
const EXECUTABLE = new Set(['command', 'file', 'http']);

const roleProvenance = (role, model, mode = 'api') => ({
  memberId: null, role, mode, provider: model ? providerOf(model) : null, model: model ?? null, identitySource: 'configured',
});

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * startRun({ wish, config, overrides, dataDir, deps }) → RunHandle (interfaces.md §7).
 * Extra option (additive): onEvent(envelope) is called after each event is durably appended (used by the CLI).
 */
export function startRun({ wish, config, overrides = {}, dataDir = DEFAULT_DATA_DIR, deps = {}, onEvent } = {}) {
  if (typeof wish !== 'string' || !wish.trim() || wish.length > 2000) {
    throw new EngineError('invalid_wish', 'The wish must be 1 to 2000 characters of text.');
  }
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const run = new Run({ runId: makeRunId(now()), wish: wish.trim(), config: config ?? {}, overrides: overrides ?? {}, dataDir, deps, onEvent, now });
  const done = run.execute();
  return {
    runId: run.runId,
    done,
    cancel: reason => run.cancel(reason),
    confirmPlan: () => run.confirmPlan(),
  };
}

class Run {
  constructor({ runId, wish, config, overrides, dataDir, deps, onEvent, now }) {
    this.runId = runId;
    this.wish = wish;
    this.config = config;
    this.overrides = overrides;
    this.dataDir = resolve(dataDir);
    this.runDir = join(this.dataDir, 'harness', 'runs', runId);
    this.roomsDir = join(this.dataDir, 'rooms');
    this.workspaceDir = join(this.runDir, 'workspace');
    this.depsInput = deps;
    this.deps = null;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.nowMs = now;
    this.startMs = now();
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.cancelReason = null;
    this.redact = makeRedactor(config, deps.redact);

    const budget = { ...(config?.budget ?? {}), ...(overrides?.budget ?? {}) };
    this.limits = {
      maxUsdPerRun: positive(budget.maxUsdPerRun, DEFAULT_LIMITS.maxUsdPerRun),
      maxMinutesPerRun: positive(budget.maxMinutesPerRun, DEFAULT_LIMITS.maxMinutesPerRun),
      maxBuildIterations: Math.floor(positive(budget.maxBuildIterations, DEFAULT_LIMITS.maxBuildIterations)),
    };
    const autonomy = overrides?.autonomy ?? config?.routing?.autonomy;
    this.autonomy = autonomy === 'confirm_plan' ? 'confirm_plan' : 'full';
    this.routerOpts = {
      overrides: config?.routing?.overrides ?? {},
      preferVendorDiversity: config?.routing?.preferVendorDiversity !== false,
    };

    this.counters = { call: 0, test: 0, reflection: 0, skill: 0, tool: 0 };
    this.spendAcc = { knownUsd: 0, knownCount: 0, unknownCost: false, estimated: false, calls: 0, inTok: 0, outTok: 0, tokKnown: false };
    this.limitHit = null;          // 'usd' | 'minutes' | 'iterations' once a limit stopped the build
    this.wrapUp = false;           // after a limit: final_test and report may still finish
    this.softLimitPhase = false;   // during fact_check a limit only skips the check
    this.softLimitHit = null;
    this.specVersionCounter = 0;
    this.replansUsed = 0;
    this.iterated = false;
    this.lastPhase = null;
    this.stateQueue = Promise.resolve();
    this.pendingEmits = new Set();
    this.openTools = [];
    this.planCorrections = new Map();   // stale fact line → { text, sources }, see plan-facts.mjs
    this.lastItemReport = null;

    this.brief = null; this.research = null; this.spec = null; this.planReview = null; this.planCheck = null;
    this.approvedSpecVersion = null; this.workspace = null; this.acceptance = null; this.best = null;
    this.finalReport = null; this.finalReview = null; this.factCheck = null; this.lastBuilderModel = null;
    this.outcome = null;           // { status, reason } set by terminal paths
    this.confirmResolve = null;

    this.state = {
      runId, wish, title: null, status: 'running', phase: 'intake', autonomy: this.autonomy, approval: null,
      iteration: 0, currentItemId: null, items: {}, best: null, models: {},
      spend: { usd: 0, usdSource: 'provider', calls: 0, inputTokens: 0, outputTokens: 0 },
      limits: { ...this.limits },
      startedAt: iso(this.startMs), updatedAt: iso(this.startMs), finishedAt: null, error: null, previewPath: null,
    };
  }

  // ---------------------------------------------------------------- handle

  cancel(reason) {
    if (this.signal.aborted) return;
    this.cancelReason = typeof reason === 'string' && reason.trim() ? truncate(reason.trim(), 200) : 'Cancelled by the user.';
    this.controller.abort(new CancelledError(this.cancelReason));
  }

  confirmPlan() {
    if (!this.confirmResolve) return false;
    const resolveConfirm = this.confirmResolve;
    this.confirmResolve = null;
    resolveConfirm();
    return true;
  }

  // ---------------------------------------------------------------- top level

  async execute() {
    await mkdir(this.runDir, { recursive: true });
    await writeFile(join(this.runDir, 'wish.txt'), this.wish + '\n', 'utf8');
    const createLog = this.depsInput.createEventLog ?? defaultCreateEventLog;
    this.log = await createLog({ rootDir: this.roomsDir, roomId: this.runId });
    await this.emit('room.created', {
      goal: this.wish, acceptanceCriteria: [], constraints: [],
      limits: { maxRuns: this.limits.maxBuildIterations, maxMinutes: this.limits.maxMinutesPerRun, maxUsd: this.limits.maxUsdPerRun },
      workflow: 'harness.autopilot.v1', driver: 'harness', roomVersion: 1, autonomy: this.autonomy,
    });
    await this.registerArtifact('wish.txt', this.wish + '\n', 'file');
    await this.saveState();

    try {
      this.deps = await resolveDeps(this.depsInput, this.config);
      if (!this.depsInput.redact && this.deps.redact) this.redact = makeRedactor(this.config, this.deps.redact);
      await this.preflight();
      await this.planning();
      await this.scaffold();
      for (;;) {
        const result = await this.buildAll();
        if (!result.replan) break;
        await this.planLoop({ previous: this.spec, replanReason: result.replan });
        await this.confirmIfNeeded();
        await this.scaffold();
      }
      await this.finalize();
    } catch (error) {
      await this.handleStop(error);
    }
    await this.reportPhase();
    return this.finish();
  }

  async handleStop(error) {
    if (this.signal.aborted || error instanceof CancelledError) {
      this.outcome = { status: 'cancelled', reason: this.cancelReason ?? 'The run was cancelled.' };
      return;
    }
    if (error instanceof LimitExceededError) {
      try {
        await this.wrapUpAfterLimit(error.limit);
      } catch (inner) {
        if (this.signal.aborted || inner instanceof CancelledError) {
          this.outcome = { status: 'cancelled', reason: this.cancelReason ?? 'The run was cancelled.' };
        } else this.recordFatal(inner);
      }
      return;
    }
    if (error instanceof EngineError && ['refused', 'plan_not_approved', 'no_models', 'sandbox_unavailable'].includes(error.code)) {
      this.state.error = { code: error.code, message: this.redact(error.message) };
      this.outcome = { status: 'failed', reason: error.message };
      return;
    }
    this.recordFatal(error);
  }

  recordFatal(error) {
    const code = typeof error?.code === 'string' ? error.code : 'engine_error';
    const message = this.redact(error?.message ?? String(error));
    this.state.error = { code, message };
    this.outcome = { status: 'failed', reason: `${code}: ${message}`, fatal: true };
  }

  // ---------------------------------------------------------------- events, state, artifacts

  async emit(type, payload, { runId, taskId, provenance = ENGINE } = {}) {
    const envelope = await this.log.append({
      type, provenance, payload, ...(runId ? { runId } : {}), ...(taskId ? { taskId } : {}),
    });
    if (this.onEvent) {
      try { this.onEvent(envelope); } catch { /* a listener never breaks the run */ }
    }
    return envelope;
  }

  /** Fire-and-forget emit for synchronous callbacks (notes, builder tool events). Order is kept by the log queue. */
  emitLater(type, payload, opts) {
    const p = this.emit(type, payload, opts).catch(() => {}).finally(() => this.pendingEmits.delete(p));
    this.pendingEmits.add(p);
  }

  note(role, text) {
    const clean = truncate(this.redact(String(text ?? '').replace(/\s+/g, ' ').trim()), 300);
    if (clean) this.emitLater('harness.note', { role, text: clean });
  }

  saveState() {
    this.state.updatedAt = iso(this.nowMs());
    const snapshot = json(this.state);
    const next = this.stateQueue.then(() => writeAtomic(join(this.runDir, 'state.json'), snapshot));
    this.stateQueue = next.catch(() => {});
    return next;
  }

  async writeArtifact(rel, content, kind = 'file') {
    const path = join(this.runDir, ...rel.split('/'));
    await writeAtomic(path, content);
    await this.registerArtifact(rel, content, kind);
  }

  registerArtifact(rel, content, kind) {
    return this.emit('artifact.registered', { artifactId: rel, kind, location: rel, version: sha256(content), evidence: [] });
  }

  async setPhase(phase, itemId = null) {
    if (!['final_test', 'fact_check', 'report', 'done', 'awaiting_confirmation'].includes(phase)) this.checkLimits();
    const previous = this.lastPhase;
    this.lastPhase = phase;
    this.state.phase = phase;
    this.state.currentItemId = itemId;
    await this.emit('harness.phase.changed', { phase, previous, iteration: this.state.iteration, itemId });
    await this.saveState();
  }

  elapsedMinutes() { return Math.max(0, (this.nowMs() - this.startMs) / 60000); }

  // ---------------------------------------------------------------- limits and spend

  limitStatus() {
    if (this.spendAcc.knownUsd >= this.limits.maxUsdPerRun) return 'usd';
    if (this.elapsedMinutes() >= this.limits.maxMinutesPerRun) return 'minutes';
    return null;
  }

  throwIfCancelled() {
    if (this.signal.aborted) throw new CancelledError(this.cancelReason);
  }

  /** Checked before every model call and every phase. */
  checkLimits({ beforeBuild = false } = {}) {
    this.throwIfCancelled();
    if (this.wrapUp) return;
    let hit = this.limitStatus();
    if (!hit && beforeBuild && this.state.iteration >= this.limits.maxBuildIterations) hit = 'iterations';
    if (!hit) return;
    if (this.softLimitPhase) { this.softLimitHit = hit; throw new LimitExceededError(hit); }
    this.limitHit = hit;
    throw new LimitExceededError(hit);
  }

  /** After a worker or role returns: surface a cancellation or a limit it may have swallowed. */
  afterCall() {
    this.throwIfCancelled();
    if (this.limitHit && !this.wrapUp) throw new LimitExceededError(this.limitHit);
  }

  budgetRemaining() { return Math.max(0, this.limits.maxUsdPerRun - this.spendAcc.knownUsd); }

  addSpend(usage) {
    const a = this.spendAcc;
    a.calls++;
    if (usage.costUsd === null) a.unknownCost = true;
    else { a.knownUsd += usage.costUsd; a.knownCount++; if (usage.source === 'estimated') a.estimated = true; }
    if (usage.inputTokens !== null) { a.inTok += usage.inputTokens; a.tokKnown = true; }
    if (usage.outputTokens !== null) { a.outTok += usage.outputTokens; a.tokKnown = true; }
    this.state.spend = {
      usd: a.knownCount === 0 && a.unknownCost ? null : Math.round(a.knownUsd * 1e6) / 1e6,
      usdSource: a.unknownCost ? 'unknown' : a.estimated ? 'estimated' : 'provider',
      calls: a.calls,
      inputTokens: a.tokKnown ? a.inTok : null,
      outputTokens: a.tokKnown ? a.outTok : null,
    };
  }

  async budgetUpdated() {
    const exceeded = this.limitHit ?? this.limitStatus()
      ?? (this.state.iteration >= this.limits.maxBuildIterations ? 'iterations' : null);
    await this.emit('harness.budget.updated', {
      spentUsd: this.state.spend.usd, usdSource: this.state.spend.usdSource,
      elapsedMinutes: Math.round(this.elapsedMinutes() * 100) / 100, iterations: this.state.iteration,
      limits: { ...this.limits }, exceeded,
    });
  }

  // ---------------------------------------------------------------- routing and model calls

  async route(req, purpose) {
    this.checkLimits();
    const request = { ...req, budgetRemainingUsd: this.budgetRemaining() };
    let decision;
    try {
      decision = this.deps.router.selectModel(request, this.roster, this.routerOpts);
    } catch (error) {
      if (error?.code !== 'no_match' || !(request.avoidModels?.length || request.avoidVendors?.length)) throw error;
      // Only one suitable model is configured: independence is impossible, so say so instead of failing.
      decision = this.deps.router.selectModel({ ...request, avoidModels: [], avoidVendors: [] }, this.roster, this.routerOpts);
      decision = { ...decision, reason: `${decision.reason} (no other suitable model is configured, so the model to avoid was allowed)`, independenceRelaxed: true };
    }
    await this.emit('harness.route.selected', {
      role: req.role, model: decision.model, tier: decision.tier ?? null, rule: decision.rule ?? null, reason: decision.reason ?? '',
      escalated: decision.escalated === true, pinned: decision.pinned === true, attempt: req.attempt ?? 1,
      purpose, suggested: decision.suggested === true,
    });
    return decision;
  }

  binding(role, decision, { purpose, attempt = 1, taskId, pinnedModel } = {}) {
    const models = pinnedModel ? [pinnedModel] : [decision.model, ...(Array.isArray(decision.fallbacks) ? decision.fallbacks : [])];
    return { role, decision, purpose, attempt, taskId, models, active: 0, pinned: Boolean(pinnedModel), pinnedFailed: false,
      lastCallId: null, reservedCallId: null };
  }

  activeModel(binding) { return binding.models[binding.active] ?? binding.decision.model; }

  nextCallId() { return `call-${pad(++this.counters.call, 4)}`; }

  /**
   * callModel: the one wrapper every role and worker uses. router choice → run.started → modelClient.complete
   * (non-retryable provider error → next fallback, unless the binding is pinned) → run.completed/run.failed →
   * spend → harness.budget.updated.
   */
  async callModel(binding, req) {
    this.checkLimits();
    for (let i = binding.active; i < binding.models.length; i++) {
      const model = binding.models[i];
      const callId = binding.reservedCallId ?? this.nextCallId();
      binding.reservedCallId = null;
      binding.lastCallId = callId;
      const provenance = roleProvenance(binding.role, model);
      const opts = { runId: callId, taskId: binding.taskId, provenance };
      await this.emit('run.started', {
        memberId: null, provider: providerOf(model), model, attempt: binding.attempt, triggerEventId: null, roomVersion: 1,
        role: binding.role, purpose: binding.purpose, ...(i > 0 ? { fallbackFrom: binding.models[0] } : {}),
      }, opts);
      const t0 = this.nowMs();
      let result;
      try {
        const signal = req?.signal && req.signal !== this.signal ? AbortSignal.any([this.signal, req.signal]) : this.signal;
        result = await this.deps.modelClient.complete({ ...req, model, signal });
      } catch (error) {
        const usage = normalizeUsage(error?.usage ?? error?.result?.usage);
        this.addSpend(usage);
        await this.emit('run.failed', {
          error: { code: typeof error?.code === 'string' ? error.code : 'error', message: this.redact(error?.message ?? 'Model call failed.') },
          retryable: error?.retryable === true, usage, durationMs: Math.max(0, this.nowMs() - t0),
        }, opts);
        this.throwIfCancelled();
        const nonRetryable = error?.retryable === false;
        if (nonRetryable && binding.pinned) binding.pinnedFailed = true;
        if (nonRetryable && !binding.pinned && i + 1 < binding.models.length) {
          binding.active = i + 1;
          this.note('engine', `${model} failed (${error?.code ?? 'error'}); trying the fallback ${binding.models[i + 1]}.`);
          continue;
        }
        throw error;
      }
      const usage = normalizeUsage(result?.usage);
      this.addSpend(usage);
      await this.emit('run.completed', {
        stopReason: result?.stopReason ?? 'other', usage,
        durationMs: typeof result?.durationMs === 'number' ? result.durationMs : Math.max(0, this.nowMs() - t0),
      }, opts);
      this.state.models[binding.role] = model;
      await this.budgetUpdated();
      this.throwIfCancelled();
      return result;
    }
    throw new EngineError('no_model', 'No model was available for this call.');
  }

  /** Search capability, given ONLY to intake, researcher and planner. Logged as linkup_search under the current call. */
  searchFor(binding) {
    return async req => {
      this.checkLimits();
      const runId = binding.lastCallId ?? (binding.reservedCallId ??= this.nextCallId());
      const toolCallId = `tool-${pad(++this.counters.tool, 4)}`;
      const provenance = { ...roleProvenance(binding.role, null), provider: 'linkup' };
      const opts = { runId, taskId: binding.taskId, provenance };
      await this.emit('tool.called', { toolCallId, name: 'linkup_search', args: { query: truncate(req?.query, 200), depth: req?.depth ?? 'standard' } }, opts);
      const t0 = this.nowMs();
      try {
        const res = await this.deps.searchClient.search({ ...req, signal: this.signal });
        await this.emit('tool.result', { toolCallId, status: 'ok', summary: `${res?.sources?.length ?? 0} sources`, durationMs: Math.max(0, this.nowMs() - t0) }, opts);
        this.throwIfCancelled();
        return res;
      } catch (error) {
        await this.emit('tool.result', { toolCallId, status: 'error', summary: this.redact(error?.message ?? 'search failed'), durationMs: Math.max(0, this.nowMs() - t0) }, opts);
        this.throwIfCancelled();
        throw error;
      }
    };
  }

  roleContext(binding, { search = false } = {}) {
    return {
      llm: req => this.callModel(binding, req),
      search: search && this.searchAvailable ? this.searchFor(binding) : null,
      note: text => this.note(binding.role, text),
      signal: this.signal,
      now: () => iso(this.nowMs()),
    };
  }

  /** Routes, builds the role context and runs one role. Returns { out, binding }. */
  async invokeRole(roleName, role, input, routeReq, { purpose, search = false, taskId } = {}) {
    const decision = await this.route({ role: roleName, ...routeReq }, purpose);
    const binding = this.binding(roleName, decision, { purpose, attempt: routeReq.attempt ?? 1, taskId });
    let out;
    try {
      out = await role.run(input, this.roleContext(binding, { search }));
    } catch (error) {
      this.afterCall();
      throw error;
    }
    this.afterCall();
    return { out, binding };
  }

  // ---------------------------------------------------------------- phases

  async preflight() {
    let roster;
    try {
      roster = this.deps.router.buildRoster(this.config);
    } catch (error) {
      if (error?.code === 'no_models') roster = [];
      else throw error;
    }
    if (!Array.isArray(roster) || roster.length === 0) {
      throw new EngineError('no_models', 'No models are configured. Add a provider with an API key on the Setup page (or in apiConfig.json), then start the run again.');
    }
    this.roster = roster;
    this.rosterSummary = roster.map(m => ({
      ref: m.ref, label: m.label ?? m.ref, tier: m.tier, capabilities: m.capabilities ?? [],
      inputUsdPerMTok: m.inputUsdPerMTok ?? null, outputUsdPerMTok: m.outputUsdPerMTok ?? null,
    }));
    const support = await this.deps.sandbox.sandboxSupport();
    if (!support?.ok) {
      throw new EngineError('sandbox_unavailable', `The sandbox is not available on this machine, so the run was not started: ${support?.detail ?? 'unknown reason'}`);
    }
    this.searchAvailable = this.deps.searchClient?.available === true && typeof this.deps.searchClient.search === 'function';
    if (!this.searchAvailable) this.note('engine', 'No search provider is configured: research uses model knowledge and fact checks are skipped.');
  }

  async planning() {
    await this.setPhase('intake');
    const { out: brief } = await this.invokeRole('intake', this.deps.roles.intake, { wish: this.wish }, {}, { purpose: 'intake', search: true });
    this.brief = brief;
    await this.writeArtifact('brief.json', json(brief));
    await this.emit('harness.brief.ready', {
      title: brief?.title ?? null, productKind: brief?.productKind ?? null, mustHaves: brief?.mustHaves ?? [],
      assumptions: (brief?.assumptions ?? []).map(a => ({ topic: a.topic, assumed: a.assumed })), refused: brief?.refused ?? null,
    });
    if (brief?.refused) throw new EngineError('refused', `The wish was refused: ${brief.refused.reason ?? 'no reason given'}`);

    await this.setPhase('research');
    const { out: research } = await this.invokeRole('researcher', this.deps.roles.researcher, { brief }, {}, { purpose: 'research', search: true });
    this.research = research;
    await this.writeArtifact('research.json', json(research), 'source_list');
    const findings = Array.isArray(research?.findings) ? research.findings : [];
    const bases = new Set(findings.map(f => f.basis));
    const sources = [];
    for (const f of findings) for (const s of f.sources ?? []) if (s?.url && !sources.some(x => x.url === s.url) && sources.length < 12) sources.push(s);
    await this.emit('harness.research.ready', {
      findingCount: findings.length, searchesUsed: research?.searchesUsed ?? 0, sources,
      basis: bases.size === 1 && bases.has('search') ? 'search' : bases.size === 0 || (bases.size === 1 && bases.has('model_knowledge')) ? 'model_knowledge' : 'mixed',
    });

    await this.planLoop(null);
    await this.confirmIfNeeded();
  }

  /** plan → checkSpecRules → plan_check → plan_review, up to MAX_PLAN_REVISIONS revisions. */
  async planLoop(initialRevision) {
    let revision = initialRevision;
    if (initialRevision?.replanReason) {
      this.state.approval = null;
      this.approvedSpecVersion = null;
      this.state.userConfirmation = null;
    }
    let lastReview = null;
    for (let round = 0; round <= MAX_PLAN_REVISIONS; round++) {
      await this.setPhase('plan');
      const input = { brief: this.brief, research: this.research, roster: this.rosterSummary, ...(revision ? { revision } : {}) };
      const purpose = revision?.replanReason ? 'replan' : revision ? `revise plan (round ${round + 1})` : 'plan';
      const { out: raw, binding: planBinding } = await this.invokeRole('planner', this.deps.roles.planner, input, {}, { purpose, search: true });
      const spec = { ...raw, specVersion: ++this.specVersionCounter };
      const specText = json(spec);
      const specSha256 = sha256(specText);
      await this.writeArtifact('spec.json', specText);
      this.spec = spec;
      this.state.title = typeof spec.title === 'string' ? spec.title : null;
      this.state.previewPath = spec.stack === 'static-web' && spec.entry?.kind === 'open_html' ? spec.entry.path : null;
      const checks = Array.isArray(spec.acceptance) ? spec.acceptance : [];
      await this.emit('harness.plan.ready', {
        specVersion: spec.specVersion, title: spec.title ?? null, stack: spec.stack ?? null,
        items: (spec.workItems ?? []).map(i => ({ id: i.id, title: i.title, difficulty: i.difficulty })),
        checkCount: checks.length, executableCheckCount: checks.filter(c => EXECUTABLE.has(c.type)).length,
      });
      const violations = typeof this.deps.roles.checkSpecRules === 'function' ? normalizeViolations(this.deps.roles.checkSpecRules(spec)) : [];
      if (violations.length) this.note('engine', `The plan breaks ${violations.length} spec rule(s); it will be revised.`);

      await this.setPhase('plan_check');
      const planCheck = await this.planCheckPhase(spec);
      this.planCheck = planCheck;

      await this.setPhase('plan_review');
      const plannerModel = this.activeModel(planBinding);
      const { out: rawReview, binding: reviewBinding } = await this.invokeRole('reviewer', this.deps.roles.reviewer.reviewPlan,
        { brief: this.brief, research: this.research, spec, planCheck }, { avoidModels: [plannerModel] }, { purpose: 'plan_review' });
      const reviewerModel = this.activeModel(reviewBinding);
      const { review, approved, overrides } = applyPlanReviewRules(rawReview, { violations, planCheck });
      const planReview = {
        ...review,
        reviewerModel, reviewerCallId: reviewBinding.lastCallId, specVersion: spec.specVersion, specSha256,
        modelVerdict: rawReview?.verdict ?? null, engineOverrides: overrides,
      };
      this.planReview = planReview;
      lastReview = planReview;
      await this.writeArtifact('plan-review.json', json(planReview));
      const approval = approved ? {
        by: 'model', model: reviewerModel, at: iso(this.nowMs()), specVersion: spec.specVersion, specSha256,
        reviewRef: 'plan-review.json', callId: reviewBinding.lastCallId,
      } : null;
      await this.emit('harness.plan.reviewed', {
        verdict: planReview.verdict, scores: planReview.scores, issues: planReview.issues, reviewerModel,
        reviewerCallId: planReview.reviewerCallId, specVersion: spec.specVersion, specSha256,
        sameModelAsPlanner: reviewerModel === plannerModel, approval, engineOverrides: overrides,
      });
      if (approved) {
        this.state.approval = approval;
        this.approvedSpecVersion = spec.specVersion;
        this.approvedSpecSha256 = specSha256;
        await this.saveState();
        return;
      }
      revision = { previous: spec, review: planReview };
    }
    const blockers = (lastReview?.issues ?? []).filter(i => i.severity === 'blocker').map(i => i.text);
    throw new EngineError('plan_not_approved', `plan not approved${blockers.length ? `; blockers: ${blockers.join(' | ')}` : ''}`, { blockers });
  }

  async planCheckPhase(spec) {
    const n = spec.specVersion;
    const label = `plan-facts-v${n}.md`;
    const markdown = renderPlanFacts(spec, this.research, { corrections: this.planCorrections });
    await this.writeArtifact(label, markdown);
    const result = await this.runSkill('plan_check', { label, markdown }, `plan-check-v${n}.json`);
    for (const f of confirmedStaleFindings(result)) {
      if (typeof f.quote === 'string' && typeof f.correction === 'string' && f.correction.trim()) {
        this.planCorrections.set(f.quote, { text: f.correction, sources: (f.sources ?? []).map(s => s.url).filter(Boolean) });
      }
    }
    return result;
  }

  /**
   * Invokes the Shelf Life skill in `phase`. ctx.llm is PINNED to the routed model (no fallback inside one call,
   * room #292); a failed run whose pinned model failed non-retryably is rerun once with the router's next fallback,
   * in a NEW child room. Every invocation gets a unique child room "<runId>-sl-NN". Never throws for a skill
   * failure; throws only for cancellation (and for a hard limit outside fact_check).
   */
  async runSkill(phase, doc, reportRel) {
    const skill = this.deps.skills?.[SKILL_ID] ?? null;
    const base = {
      status: 'skipped', reason: null, childRoomId: null, doc: { label: doc.label, sha256: sha256(doc.markdown) },
      findings: [], diff: null, reviewStatus: 'unreviewed', searchesUsed: 0,
    };
    const meta = { skillId: SKILL_ID, version: skill?.version ?? null, phase, role: 'researcher', docLabel: doc.label };
    let skip = null;
    if (!skill || typeof skill.run !== 'function') skip = { ...base, reason: this.deps.skillsMissingReason ?? 'Shelf Life skill not merged' };
    else if (!Array.isArray(skill.allowedPhases) || !skill.allowedPhases.includes(phase)) skip = { ...base, status: 'failed', reason: `The skill is not allowed in phase ${phase}.` };
    else if (!this.searchAvailable) skip = { ...base, reason: 'no search provider' };

    let result;
    let childRoomId = null;
    if (skip) {
      await this.emit('harness.skill.started', { ...meta, childRoomId: null });
      result = skip;
    } else {
      const decision = await this.route({ role: 'researcher' }, phase);
      const candidates = [decision.model, ...(Array.isArray(decision.fallbacks) ? decision.fallbacks : [])].slice(0, 2);
      for (let i = 0; i < candidates.length; i++) {
        const model = candidates[i];
        childRoomId = `${this.runId}-sl-${pad(++this.counters.skill, 2)}`;
        const binding = this.binding('researcher', decision, { purpose: phase, attempt: i + 1, pinnedModel: model });
        await this.emit('harness.skill.started', { ...meta, childRoomId, model, attempt: i + 1 });
        const ctx = {
          llm: req => this.callModel(binding, req),
          search: req => this.deps.searchClient.search({ ...req, signal: req?.signal ?? this.signal }),
          providerIdentity: { provider: providerOf(model), model },
          childRoom: { rootDir: this.roomsDir, roomId: childRoomId, parentRoomId: this.runId },
          note: text => this.note('researcher', text),
          signal: this.signal,
          now: () => iso(this.nowMs()),
        };
        let r;
        try {
          r = await skill.run({ doc: { label: doc.label, markdown: doc.markdown }, maxClaims: SKILL_MAX_CLAIMS }, ctx);
        } catch (error) {
          r = { ...base, status: 'failed', reason: `The skill failed: ${this.redact(error?.message ?? 'unknown error')}` };
        }
        r = normalizeFactCheck(r, base);
        const limitStopped = this.signal.aborted || (this.limitHit && !this.wrapUp) || this.softLimitHit;
        if (r.status === 'failed' && binding.pinnedFailed && !limitStopped && i + 1 < candidates.length) {
          await this.emit('harness.skill.completed', {
            ...meta, childRoomId, status: r.status, findingCount: r.findings.length, staleCount: countStale(r),
            searchesUsed: r.searchesUsed, reportPath: null, rerunWith: candidates[i + 1],
          });
          this.note('engine', `The ${phase} skill's model ${model} failed; rerunning the whole check once with ${candidates[i + 1]} in a new child room.`);
          continue;
        }
        result = r;
        break;
      }
    }
    await this.writeArtifact(reportRel, json(result), 'report');
    await this.emit('harness.skill.completed', {
      ...meta, childRoomId, status: result.status, findingCount: result.findings.length, staleCount: countStale(result),
      confirmedStaleCount: confirmedStaleFindings(result).length, searchesUsed: result.searchesUsed, reportPath: reportRel,
      reason: result.reason,
    });
    this.afterCall();
    return result;
  }

  async confirmIfNeeded() {
    if (this.autonomy !== 'confirm_plan') return;
    this.state.status = 'awaiting_confirmation';
    await this.setPhase('awaiting_confirmation');
    await new Promise((resolveWait, rejectWait) => {
      const onAbort = () => { this.confirmResolve = null; rejectWait(new CancelledError(this.cancelReason)); };
      if (this.signal.aborted) return onAbort();
      this.signal.addEventListener('abort', onAbort, { once: true });
      this.confirmResolve = () => { this.signal.removeEventListener('abort', onAbort); resolveWait(); };
    });
    const confirmation = { by: 'user', at: iso(this.nowMs()), specVersion: this.approvedSpecVersion, specSha256: this.approvedSpecSha256 };
    this.state.userConfirmation = confirmation;   // recorded separately: state.approval stays the model's approval
    this.state.status = 'running';
    await this.emit('harness.plan.confirmed', confirmation);
    await this.saveState();
  }

  async scaffold() {
    const items = orderItems(this.spec.workItems);
    for (const item of items) {
      await this.emit('task.created', {
        title: item.title, owner: 'builder', dependencies: item.dependsOn ?? [], inputs: { difficulty: item.difficulty },
        deliverables: item.files ?? [], acceptance: item.checkIds ?? [], status: (item.dependsOn ?? []).length ? 'pending' : 'ready',
        version: this.spec.specVersion,
      }, { taskId: item.id });
    }
    await this.setPhase('scaffold');
    if (!this.workspace) this.workspace = await this.deps.sandbox.createWorkspace({ dir: this.workspaceDir });
    this.throwIfCancelled();
    const decision = await this.route({ role: 'tester' }, 'scaffold acceptance tests');
    const binding = this.binding('tester', decision, { purpose: 'scaffold acceptance tests' });
    const out = await this.deps.tester.materializeAcceptance({
      spec: this.spec, workspace: this.workspace, llm: req => this.callModel(binding, req), signal: this.signal,
    });
    this.afterCall();
    this.acceptance = {
      files: out?.files ?? [], tree: out?.acceptanceTree ?? null,
      commit: out?.commit ?? (await this.workspace.git.head()),
    };
    this.state.items = Object.fromEntries(items.map(i => [i.id, { status: 'pending', attempts: 0, lastScore: null }]));
    this.best = null;
    this.state.best = null;
    await this.saveState();
  }

  async buildAll() {
    const items = orderItems(this.spec.workItems);
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      let fixInstructions = null;
      let outcome = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const cycle = await this.buildTestReflect(item, attempt, fixInstructions, idx === items.length - 1);
        if (cycle.decision === 'next' || cycle.decision === 'finish') { outcome = 'next'; break; }
        if (cycle.decision === 'stop') { outcome = 'stop'; break; }
        if (cycle.decision === 'replan') {
          this.replansUsed++;
          return { replan: cycle.reflection?.reason || 'The reflector asked for a new plan.' };
        }
        fixInstructions = cycle.reflection?.fixInstructions ?? null;
      }
      if (outcome === 'stop') {
        // A limit or the reflector stopped the build: the outer handler runs final_test and the report.
        if (this.limitHit) throw new LimitExceededError(this.limitHit);
        return { stopped: true };
      }
    }
    return {};
  }

  /** One build → test → keep-best → reflect cycle for one item. */
  async buildTestReflect(item, attempt, fixInstructions, isLastItem, { iterate = false } = {}) {
    this.checkLimits({ beforeBuild: true });
    this.state.iteration++;
    const itemState = this.state.items[item.id] ?? (this.state.items[item.id] = { status: 'pending', attempts: 0, lastScore: null });
    itemState.attempts++;
    itemState.status = 'building';
    const version = this.spec.specVersion;
    if (this.best?.itemId !== item.id || (iterate && !this.best?.iterating)) {
      await this.startItemBaseline(item, { iterate });
      if (iterate) this.best.iterating = true;
    }
    await this.setPhase('build', item.id);
    await this.emit('task.updated', { status: 'running', version, note: iterate ? 'final review iteration' : `attempt ${attempt}` }, { taskId: item.id });

    const purpose = `build ${item.id}`;
    const decision = await this.route({ role: 'builder', difficulty: item.difficulty, attempt, suggested: item.suggestedModel ?? null }, purpose);
    const binding = this.binding('builder', decision, { purpose, attempt, taskId: item.id });
    const progress = await this.progressTail();
    let build;
    try {
      build = await this.deps.builder.buildItem({
        spec: this.spec, item, attempt, fixInstructions, progress, workspace: this.workspace,
        llm: req => this.callModel(binding, req), signal: this.signal,
        onTool: e => this.onBuilderTool(binding, item.id, e),
      });
    } catch (error) {
      this.afterCall();
      build = { status: 'error', summary: 'The builder failed.', commit: null, filesChanged: [], turns: 0, toolCalls: 0,
        error: { code: typeof error?.code === 'string' ? error.code : 'builder_error', message: this.redact(error?.message) } };
    }
    this.afterCall();
    this.closeOpenTools(binding);
    const builderModel = this.activeModel(binding);
    this.lastBuilderModel = builderModel;
    await this.emit('harness.build.completed', {
      itemId: item.id, attempt, status: build?.status ?? 'error', commit: build?.commit ?? null, filesChanged: build?.filesChanged ?? [],
      turns: build?.turns ?? null, toolCalls: build?.toolCalls ?? null, model: builderModel,
    });
    await this.emit('task.updated', { status: 'review', version }, { taskId: item.id });

    itemState.status = 'testing';
    await this.setPhase('test', item.id);
    const report = await this.runTests({ kind: 'item', itemId: item.id, includeRegression: true }, builderModel, `test ${item.id}`);
    const reportRel = `tests/${pad(++this.counters.test, 3)}.json`;
    await this.recordTest(report, reportRel, item.id);
    itemState.lastScore = typeof report.score === 'number' ? report.score : null;
    const kept = await this.keepBest(report, item.id, build);
    if (!kept.reverted) this.lastItemReport = report;
    const itemPassed = itemChecksPass(report, item.id, this.spec) && !kept.reverted;
    if (itemPassed) {
      await this.emit('task.done', {
        verifiedBy: 'check', version,
        evidence: [{ kind: 'test_result', ref: reportRel, summary: `${report.summary?.passed}/${report.summary?.total} checks passed`, passed: true }],
      }, { taskId: item.id });
    }

    await this.setPhase('reflect', item.id);
    const limitNow = this.limitStatus() ?? (this.state.iteration >= this.limits.maxBuildIterations ? 'iterations' : null);
    const limitStops = Boolean(limitNow) && !(itemPassed && isLastItem);
    let reflection;
    if (limitStops) {
      reflection = { itemId: item.id, decision: 'stop', reason: `The ${limitNow} limit for this run was reached.`, fixInstructions: null, lessons: [] };
    } else {
      try {
        const { out } = await this.invokeRole('reflector', this.deps.roles.reflector, {
          spec: this.spec, item, attempt, build, testReport: report, progress: await this.progressTail(),
          best: this.best ? { commit: this.best.commit, score: this.best.score } : null,
        }, { attempt }, { purpose: `reflect ${item.id}`, taskId: item.id });
        reflection = out;
      } catch (error) {
        if (this.signal.aborted || error instanceof CancelledError || error instanceof LimitExceededError) throw error;
        this.note('engine', `The reflector failed (${error?.code ?? 'error'}); the engine decides from the test results.`);
        reflection = { itemId: item.id, decision: itemPassed ? 'next' : 'retry', reason: 'The reflector failed; decided from the test results.', fixInstructions: null, lessons: [] };
      }
    }
    const replansLeft = iterate ? 0 : MAX_REPLANS - this.replansUsed;
    const { decision: finalDecision, overriddenBy } = overrideReflection(reflection, {
      itemPassed, attempt, maxAttempts: iterate ? attempt : MAX_ATTEMPTS, isLastItem, limitHit: limitStops, replansLeft,
    });
    const record = { ...reflection, itemId: item.id, decision: finalDecision, modelDecision: reflection?.decision ?? null, overriddenBy };
    await this.writeArtifact(`reflections/${pad(++this.counters.reflection, 3)}.json`, json(record));
    await this.emit('harness.reflect.decided', { itemId: item.id, decision: finalDecision, reason: truncate(reflection?.reason ?? '', 500), overriddenBy });
    await this.appendProgress(item, attempt, builderModel, build, report, record);

    if (['next', 'finish', 'stop'].includes(finalDecision) || (iterate && finalDecision !== 'replan')) {
      itemState.status = itemPassed ? 'passed' : 'failed';
      if (!itemPassed) await this.emit('task.failed', { reason: truncate(reflection?.reason || 'checks did not pass', 300), version }, { taskId: item.id });
    } else itemState.status = 'pending';
    if (limitStops) this.limitHit = limitNow;
    await this.budgetUpdated();
    await this.saveState();
    return { decision: finalDecision, reflection: record, itemPassed, report };
  }

  async runTests(scope, builderModel, purpose) {
    const avoid = builderModel ? { avoidModels: [builderModel], avoidVendors: [this.vendorOf(builderModel)] } : {};
    const decision = await this.route({ role: 'tester', ...avoid }, purpose);
    const binding = this.binding('tester', decision, { purpose, taskId: scope.kind === 'item' ? scope.itemId : undefined });
    const report = await this.deps.tester.runChecks({
      spec: this.spec, workspace: this.workspace, scope, judge: req => this.callModel(binding, req), vision: null,
      acceptanceTree: this.acceptance?.tree ?? null, acceptanceCommit: this.acceptance?.commit ?? null, signal: this.signal,
    });
    this.afterCall();
    if (!isRecord(report)) throw new EngineError('invalid_test_report', 'The tester returned no report.');
    return report;
  }

  async recordTest(report, reportRel, itemId) {
    await this.writeArtifact(reportRel, json(report), 'report');
    const s = report.summary ?? {};
    await this.emit('harness.test.completed', {
      scope: report.scope ?? null, itemId, candidate: report.candidate ?? null,
      passed: s.passed ?? 0, failed: s.failed ?? 0, errored: s.errored ?? 0, skipped: s.skipped ?? 0, total: s.total ?? 0,
      score: typeof report.score === 'number' ? report.score : 0, acceptanceIntact: report.acceptanceIntact === true,
      testerModel: report.testerModel ?? null, reportPath: reportRel,
      failures: (report.results ?? []).filter(r => r.status !== 'pass').slice(0, 5).map(r => ({ checkId: r.checkId, message: truncate(r.message, 200) })),
    });
  }

  /** Keep-best (ARCHITECTURE §1): a lower item-scope score resets the workspace to the best commit. */
  async keepBest(report, itemId, build) {
    const score = typeof report.score === 'number' ? report.score : 0;
    const prev = this.best;
    // Never run git while a builder or tester call is pending: both have settled here (afterCall ran).
    if (prev && prev.commit && typeof prev.score === 'number' && score < prev.score) {
      await this.workspace.git.resetHard(prev.commit);
      await this.emit('harness.candidate.best', {
        commit: prev.commit, score: prev.score, previousBest: prev.score, reverted: true, itemId,
        rejected: { commit: report.candidate ?? build?.commit ?? null, score },
      });
      return { reverted: true };
    }
    const commit = (await this.workspace.git.head()) ?? report.candidate ?? build?.commit ?? null;
    this.best = { commit, score, itemId };
    this.state.best = { commit, score };
    await this.emit('harness.candidate.best', { commit, score, previousBest: prev?.score ?? null, reverted: false, itemId });
    return { reverted: false };
  }

  /**
   * The state before an item's first attempt is the baseline "best": earlier items' checks that passed in the last
   * report, over the checks in scope for this item (its own checks fail until built). null when nothing is comparable.
   */
  async startItemBaseline(item, { iterate }) {
    const commit = await this.workspace.git.head();
    let score = null;
    if (!iterate) {
      const order = orderItems(this.spec.workItems).map(i => i.id);
      const prior = new Set(order.slice(0, order.indexOf(item.id)));
      const priorChecks = (this.spec.acceptance ?? []).filter(c => prior.has(c.itemId)).length;
      const own = (this.spec.acceptance ?? []).filter(c => c.itemId === item.id).length;
      const passedPrior = (this.lastItemReport?.results ?? []).filter(r => prior.has(r.itemId) && r.status === 'pass').length;
      if (priorChecks > 0 && this.lastItemReport) score = passedPrior / (priorChecks + own);
    }
    this.best = { commit, score, itemId: item.id, baseline: true };
  }

  async finalize() {
    await this.finalTest();
    await this.finalReviewPhase();
    const iterateIds = this.finalReview?.verdict === 'iterate' && Array.isArray(this.finalReview.iterateItems)
      ? orderItems(this.spec.workItems).filter(i => this.finalReview.iterateItems.includes(i.id)) : [];
    if (iterateIds.length && !this.iterated) {
      this.iterated = true;
      const before = { report: this.finalReport, review: this.finalReview, commit: await this.workspace.git.head() };
      const gaps = (this.finalReview.gaps ?? []).join('\n');
      for (const item of iterateIds) {
        const attempt = Math.min((this.state.items[item.id]?.attempts ?? 0) + 1, MAX_ATTEMPTS);
        const cycle = await this.buildTestReflect(item, attempt, gaps ? `Final review gaps to fix:\n${gaps}` : null, false, { iterate: true });
        if (cycle.decision === 'stop' && this.limitHit) throw new LimitExceededError(this.limitHit);
      }
      await this.finalTest();
      const prevScore = typeof before.report?.score === 'number' ? before.report.score : null;
      const newScore = typeof this.finalReport?.score === 'number' ? this.finalReport.score : 0;
      if (prevScore !== null && newScore < prevScore && before.commit) {
        // Keep-best: the iterate pass made the product worse, so deliver the earlier candidate with its own review.
        await this.workspace.git.resetHard(before.commit);
        await this.emit('harness.candidate.best', {
          commit: before.commit, score: prevScore, previousBest: prevScore, reverted: true, itemId: null,
          rejected: { commit: this.finalReport?.candidate ?? null, score: newScore },
        });
        this.finalReport = before.report;
        this.finalReview = before.review;
        await this.writeArtifact('tests/final.json', json(before.report), 'report');
        if (before.review) await this.writeArtifact('final-review.json', json(before.review));
      } else {
        await this.finalReviewPhase();
      }
    }
    await this.factCheckPhase();
  }

  async finalTest() {
    await this.setPhase('final_test');
    const report = await this.runTests({ kind: 'all' }, this.lastBuilderModel, 'final test');
    this.finalReport = report;
    await this.recordTest(report, 'tests/final.json', null);
    await this.saveState();
    return report;
  }

  async finalReviewPhase() {
    await this.setPhase('final_review');
    const fileList = await this.safeFileList();
    const readmeExcerpt = await this.readWorkspaceFile('README.md', 4000);
    let raw;
    let binding;
    try {
      ({ out: raw, binding } = await this.invokeRole('reviewer', this.deps.roles.reviewer.reviewFinal,
        { brief: this.brief, spec: this.spec, testReport: this.finalReport, fileList, readmeExcerpt }, {}, { purpose: 'final_review' }));
    } catch (error) {
      if (this.signal.aborted || error instanceof CancelledError || error instanceof LimitExceededError) throw error;
      this.note('engine', `The final review failed (${error?.code ?? 'error'}); the product cannot be marked delivered.`);
      this.finalReview = null;
      return;
    }
    this.finalReview = {
      ...raw, reviewerModel: this.activeModel(binding), candidate: this.finalReport?.candidate ?? null, specVersion: this.spec.specVersion,
    };
    await this.writeArtifact('final-review.json', json(this.finalReview));
    await this.emit('harness.final.reviewed', {
      verdict: this.finalReview.verdict, scores: this.finalReview.scores ?? null, gaps: this.finalReview.gaps ?? [],
      reviewerModel: this.finalReview.reviewerModel, candidate: this.finalReview.candidate, specVersion: this.finalReview.specVersion,
    });
  }

  async factCheckPhase() {
    await this.setPhase('fact_check');
    const markdown = await this.readWorkspaceFile('README.md', 48000, { exact: true });
    if (markdown === null || markdown === undefined || !markdown.trim()) {
      this.factCheck = await this.recordSkippedSkill('fact_check', 'README.md', markdown?.tooLarge ? 'README.md is larger than 48,000 bytes' : 'no README.md in the product', 'fact-check.json');
      return;
    }
    if (this.limitStatus()) {
      this.factCheck = await this.recordSkippedSkill('fact_check', 'README.md', 'budget exhausted before the fact check', 'fact-check.json', markdown);
      return;
    }
    this.softLimitPhase = true;
    try {
      this.factCheck = await this.runSkill('fact_check', { label: 'README.md', markdown }, 'fact-check.json');
    } catch (error) {
      if (this.signal.aborted || error instanceof CancelledError) throw error;
      // A skill failure never fails the run; findings never change the run status.
      this.note('engine', `The fact check did not complete (${error?.code ?? 'error'}).`);
    } finally {
      this.softLimitPhase = false;
      this.softLimitHit = null;
    }
  }

  async recordSkippedSkill(phase, label, reason, reportRel, markdown = '') {
    const result = {
      status: 'skipped', reason, childRoomId: null, doc: markdown ? { label, sha256: sha256(markdown) } : null,
      findings: [], diff: null, reviewStatus: 'unreviewed', searchesUsed: 0,
    };
    const meta = { skillId: SKILL_ID, version: this.deps?.skills?.[SKILL_ID]?.version ?? null, phase, role: 'researcher', docLabel: label };
    await this.emit('harness.skill.started', { ...meta, childRoomId: null });
    await this.writeArtifact(reportRel, json(result), 'report');
    await this.emit('harness.skill.completed', { ...meta, childRoomId: null, status: 'skipped', findingCount: 0, staleCount: 0, confirmedStaleCount: 0, searchesUsed: 0, reportPath: reportRel, reason });
    return result;
  }

  async wrapUpAfterLimit(limit) {
    this.limitHit = limit;
    this.wrapUp = true;
    this.note('engine', `The ${limit} limit was reached: building stopped; running the final test and writing the report.`);
    await this.budgetUpdated();
    if (this.workspace && this.spec && this.acceptance && !this.finalReportAfterLimit) {
      this.finalReportAfterLimit = true;
      await this.finalTest();
    }
    if (this.workspace && !this.factCheck) {
      this.factCheck = await this.recordSkippedSkill('fact_check', 'README.md', 'budget exhausted before the fact check', 'fact-check.json');
    }
  }

  async reportPhase() {
    const cancelled = this.outcome?.status === 'cancelled';
    const status = this.decideStatus();
    this.finalStatus = status;
    let markdown = null;
    try {
      await this.setPhase('report');
    } catch { /* setPhase never blocks the report */ }
    const fileList = this.workspace ? await this.safeFileList() : [];
    if (!cancelled && this.brief && this.spec && this.finalReport && this.deps?.roles?.reporter) {
      this.wrapUp = true;   // the report is always written, whatever the budget
      try {
        const { out } = await this.invokeRole('reporter', this.deps.roles.reporter, {
          wish: this.wish, brief: this.brief, spec: this.spec, finalReport: this.finalReport, finalReview: this.finalReview,
          factCheck: this.factCheck, planCheck: this.planCheck, status,
          spend: { usd: this.state.spend.usd, minutes: Math.round(this.elapsedMinutes() * 10) / 10 }, fileList,
        }, {}, { purpose: 'report' });
        if (typeof out === 'string' && out.trim()) markdown = out;
      } catch (error) {
        if (this.signal.aborted) this.outcome = { status: 'cancelled', reason: this.cancelReason ?? 'The run was cancelled.' };
        else this.note('engine', `The reporter failed (${error?.code ?? 'error'}); the engine wrote the report.`);
      }
    }
    const reason = this.outcome?.reason ?? (status === 'delivered' ? null : this.limitHit ? `the ${this.limitHit} limit was reached` : null);
    if (!markdown) {
      markdown = fallbackReport({
        wish: this.wish, brief: this.brief, spec: this.spec, status: this.decideStatus(),
        reason: reason ?? (this.finalReport ? 'the reporter did not produce a report' : 'the run ended before a product was built'),
        finalReport: this.finalReport, finalReview: this.finalReview, planCheck: this.planCheck, factCheck: this.factCheck,
        planReview: this.planReview, spend: this.state.spend, minutes: this.elapsedMinutes(), models: this.state.models,
        iterations: this.state.iteration, fileList,
      });
    }
    try {
      await this.writeArtifact('REPORT.md', markdown, 'report');
      this.reportPath = join(this.runDir, 'REPORT.md');
    } catch (error) {
      this.recordFatal(error);
    }
  }

  decideStatus() {
    if (this.outcome?.status === 'cancelled') return 'cancelled';
    if (this.outcome?.status === 'failed') return 'failed';
    return decideStatus({
      finalReport: this.finalReport, finalReview: this.finalReview, approvedSpecVersion: this.approvedSpecVersion,
      specVersion: this.spec?.specVersion ?? null, limitHit: this.limitHit, fatal: false,
    });
  }

  async finish() {
    const status = this.decideStatus();
    await Promise.allSettled([...this.pendingEmits]);
    const finishedMs = this.nowMs();
    const minutes = Math.round(this.elapsedMinutes() * 100) / 100;
    const finalScore = typeof this.finalReport?.score === 'number' ? this.finalReport.score : null;
    const allPassed = reportAllPassed(this.finalReport);
    const summaryText = status === 'delivered' ? 'Delivered: every check passed and the final review said ship.'
      : status === 'partial' ? `Partial: ${this.finalReport?.summary?.passed ?? 0} of ${this.finalReport?.summary?.total ?? 0} checks passed.`
      : status === 'cancelled' ? `Cancelled: ${this.cancelReason ?? 'by the user'}.`
      : `Failed: ${this.outcome?.reason ?? 'no check passed'}.`;
    this.state.status = status;
    this.state.currentItemId = null;
    this.state.finishedAt = iso(finishedMs);
    try {
      await this.emit('harness.phase.changed', { phase: 'done', previous: this.lastPhase, iteration: this.state.iteration, itemId: null });
      this.lastPhase = 'done';
      this.state.phase = 'done';
      await this.emit('harness.run.finished', {
        status, summary: truncate(this.redact(summaryText), 500), finalScore, allPassed, candidate: this.finalReport?.candidate ?? null,
        specVersion: this.spec?.specVersion ?? null, approvedSpecVersion: this.approvedSpecVersion,
        finalReviewVerdict: this.finalReview?.verdict ?? null, reportPath: this.reportPath ? 'REPORT.md' : null,
        previewPath: this.state.previewPath, spentUsd: this.state.spend.usd, minutes,
      });
      await this.emit('room.closed', {
        status: status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'completed',
        summary: truncate(this.redact(summaryText), 500),
      });
    } finally {
      await this.saveState().catch(() => {});
      await this.stateQueue;
      await this.log.close().catch(() => {});
    }
    return {
      runId: this.runId, status, finalScore, spentUsd: this.state.spend.usd, minutes,
      reportPath: this.reportPath ?? null, workspaceDir: this.workspaceDir, previewPath: this.state.previewPath,
    };
  }

  // ---------------------------------------------------------------- helpers

  vendorOf(ref) {
    return this.roster?.find(m => m.ref === ref)?.vendor ?? providerOf(ref);
  }

  async safeFileList() {
    try { return await this.workspace.listFiles(); } catch { return []; }
  }

  async readWorkspaceFile(rel, maxBytes, { exact = false } = {}) {
    if (!this.workspace) return null;
    try {
      const text = await this.workspace.readFile(rel, { maxBytes });
      if (exact && Buffer.byteLength(text) > maxBytes) return null;
      return text;
    } catch (error) {
      if (error?.code === 'too_large' && !exact) {
        try { return (await this.workspace.readFile(rel, { maxBytes: 200000 })).slice(0, maxBytes); } catch { return null; }
      }
      return null;
    }
  }

  async progressTail() {
    try {
      const text = await readFile(join(this.runDir, 'progress.md'), 'utf8');
      return text.length > 4096 ? text.slice(-4096) : text;
    } catch { return ''; }
  }

  async appendProgress(item, attempt, builderModel, build, report, reflection) {
    const s = report.summary ?? {};
    const failures = (report.results ?? []).filter(r => r.status !== 'pass').slice(0, 3).map(r => `${r.checkId} ${r.status}: ${truncate(r.message, 120)}`);
    const entry = [
      `## Iteration ${this.state.iteration} — ${item.id} "${truncate(item.title, 80)}" — attempt ${attempt} (builder: ${builderModel})`,
      `- Build: ${build?.status ?? 'error'}, commit ${build?.commit ? String(build.commit).slice(0, 7) : 'none'}, files: ${(build?.filesChanged ?? []).join(', ') || 'none'}`,
      `- Tests: ${s.passed ?? 0}/${s.total ?? 0} passed${failures.length ? ` (${failures.join('; ')})` : ''}`,
      `- Decision: ${reflection.decision}: ${truncate(reflection.reason ?? '', 200)}${reflection.overriddenBy ? ` (engine override: ${reflection.overriddenBy})` : ''}`,
      `- Lessons: ${(reflection.lessons ?? []).map(l => truncate(l, 160)).join(' · ') || 'none'}`,
      '',
    ].join('\n') + '\n';
    const path = join(this.runDir, 'progress.md');
    await appendFile(path, entry, 'utf8');
    const content = await readFile(path, 'utf8');
    await this.registerArtifact('progress.md', content, 'file');
  }

  onBuilderTool(binding, taskId, e) {
    const runId = binding.lastCallId ?? (binding.reservedCallId ??= this.nextCallId());
    const provenance = roleProvenance('builder', this.activeModel(binding));
    if (e?.phase === 'call') {
      const toolCallId = `tool-${pad(++this.counters.tool, 4)}`;
      this.openTools.push({ toolCallId, name: e.name, runId });
      this.emitLater('tool.called', { toolCallId, name: String(e.name ?? 'tool'), args: { summary: truncate(this.redact(e.summary ?? ''), 200) } }, { runId, taskId, provenance });
    } else if (e?.phase === 'result') {
      const idx = this.openTools.findLastIndex(t => t.name === e.name);
      const open = idx >= 0 ? this.openTools.splice(idx, 1)[0] : { toolCallId: `tool-${pad(++this.counters.tool, 4)}`, runId };
      this.emitLater('tool.result', {
        toolCallId: open.toolCallId, status: e.status === 'error' ? 'error' : 'ok', summary: truncate(this.redact(e.summary ?? ''), 200),
        durationMs: typeof e.durationMs === 'number' ? e.durationMs : null,
      }, { runId: open.runId, taskId, provenance });
    }
  }

  closeOpenTools() { this.openTools = []; }
}

function countStale(fc) { return (fc?.findings ?? []).filter(f => f?.verdict === 'stale').length; }

function normalizeFactCheck(r, base) {
  if (!isRecord(r)) return { ...base, status: 'failed', reason: 'The skill returned no result.' };
  return {
    status: ['completed', 'skipped', 'failed'].includes(r.status) ? r.status : 'failed',
    reason: typeof r.reason === 'string' ? r.reason : r.status === 'completed' ? null : 'The skill returned an unknown status.',
    childRoomId: typeof r.childRoomId === 'string' ? r.childRoomId : null,
    doc: isRecord(r.doc) ? r.doc : base.doc,
    findings: Array.isArray(r.findings) ? r.findings : [],
    diff: typeof r.diff === 'string' ? r.diff : null,
    reviewStatus: 'unreviewed',
    searchesUsed: Number.isSafeInteger(r.searchesUsed) ? r.searchesUsed : 0,
  };
}
