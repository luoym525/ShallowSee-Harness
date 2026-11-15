// Offline fakes for the engine tests (everything labelled synthetic: nothing here is a real model, search or product).
// The fakes follow contracts/interfaces.md. Only the event log, the Shelf Life skill registry and git are real.
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createEventLog } from '../../packages/event-log/index.mjs';
import { SKILLS } from '../skills/index.mjs';

export const FAKE_KEY = 'sk-test-FAKE-0123456789abcdef';
export const REFS = {
  fable: 'anthropic/claude-fable-5-2', opus: 'anthropic/claude-opus-5-5', sonnet: 'anthropic/claude-sonnet-5-5',
  haiku: 'anthropic/claude-haiku-5-5', gpt: 'openai/gpt-mid',
};
const ROSTER = [
  { ref: REFS.fable, tier: 3, vendor: 'anthropic', out: 40 }, { ref: REFS.opus, tier: 3, vendor: 'anthropic', out: 20 },
  { ref: REFS.sonnet, tier: 2, vendor: 'anthropic', out: 10 }, { ref: REFS.haiku, tier: 1, vendor: 'anthropic', out: 0.5 },
  { ref: REFS.gpt, tier: 2, vendor: 'openai', out: 8 },
].map(m => ({ ...m, label: m.ref.split('/')[1], providerId: m.ref.split('/')[0], modelId: m.ref.split('/')[1],
  capabilities: ['reasoning', 'coding', 'tools', 'json'], inputUsdPerMTok: 1, outputUsdPerMTok: m.out, catalogMatched: true }));

export const fakeConfig = (extra = {}) => ({
  version: 1,
  providers: [{ id: 'anthropic', name: 'Fake', preset: 'anthropic', kind: 'anthropic', enabled: true, notes: '', website: '', baseUrl: 'https://api.anthropic.com', apiKey: FAKE_KEY, headers: {}, models: [] }],
  routing: { autonomy: 'full', overrides: {}, preferVendorDiversity: true },
  budget: { maxUsdPerRun: 5, maxMinutesPerRun: 40, maxBuildIterations: 12 },
  ...extra,
});

export function fakeRouter(calls = []) {
  const byRef = new Map(ROSTER.map(m => [m.ref, m]));
  const select = (req, roster) => {
    calls.push(structuredClone({ ...req }));
    const avoid = new Set(req.avoidModels ?? []);
    const pick = (refs, why, extra = {}) => {
      const usable = [...new Set(refs)].filter(r => byRef.has(r) && !avoid.has(r));
      if (!usable.length) throw Object.assign(new Error('no model matches'), { code: 'no_match' });
      const diverse = (req.avoidVendors?.length ? usable.filter(r => !req.avoidVendors.includes(byRef.get(r).vendor)) : []);
      const ordered = diverse.length ? [...diverse, ...usable.filter(r => !diverse.includes(r))] : usable;
      return { model: ordered[0], tier: byRef.get(ordered[0]).tier, rule: `fake.${req.role}`, suggested: false, reason: `${why}: ${ordered[0]}`,
        escalated: false, pinned: false, fallbacks: ordered.slice(1, 3), ...extra };
    };
    switch (req.role) {
      case 'planner': return pick([REFS.fable, REFS.opus], 'Planning needs the strongest model');
      case 'reviewer': return pick([REFS.opus, REFS.fable], 'Review needs a strong independent model');
      case 'builder': {
        const attempt = req.attempt ?? 1;
        const base = req.difficulty === 'easy' ? 1 : 2;
        if (attempt === 1 && req.suggested && byRef.has(req.suggested) && !avoid.has(req.suggested)) {
          return pick([req.suggested, REFS.haiku, REFS.sonnet], 'Chosen by the planner', { suggested: true, rule: 'builder.planner_suggested' });
        }
        const tier = Math.min(3, base + attempt - 1);
        const byTier = { 1: [REFS.haiku, REFS.sonnet], 2: [REFS.sonnet, REFS.gpt, REFS.opus], 3: [REFS.opus, REFS.fable, REFS.sonnet] };
        return pick(byTier[tier], `Attempt ${attempt} uses tier ${tier}`, { escalated: attempt > 1, rule: attempt > 1 ? `builder.escalate.attempt${attempt}` : 'builder.base' });
      }
      case 'tester': return pick([REFS.gpt, REFS.sonnet, REFS.haiku], 'The tester must differ from the builder');
      default: return pick([REFS.sonnet, REFS.gpt], `${req.role} runs on a balanced model`);
    }
  };
  return { buildRoster: () => ROSTER.map(m => ({ ...m })), selectModel: select, describeRouting: () => [], calls };
}

/** Real git in a temp folder: a Workspace-shaped object. `guard` records git calls made while a worker is pending. */
export async function fakeWorkspace({ dir }, guard) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await mkdir(dir, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'fake@example.invalid');
  git('config', 'user.name', 'fake');
  git('config', 'core.autocrlf', 'false');
  const note = op => guard?.onGit?.(op);
  const walk = async (root, rel = '') => {
    const out = [];
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...await walk(root, r)); else out.push(r);
    }
    return out.sort();
  };
  const head = () => { try { return git('rev-parse', 'HEAD'); } catch { return null; } };
  return {
    dir,
    async readFile(rel, opts = {}) {
      try {
        const text = await readFile(join(dir, rel), 'utf8');
        if (opts.maxBytes && Buffer.byteLength(text) > opts.maxBytes) throw Object.assign(new Error('too large'), { code: 'too_large' });
        return text;
      } catch (e) { throw e.code === 'too_large' ? e : Object.assign(new Error(`not found: ${rel}`), { code: 'not_found' }); }
    },
    async writeFile(rel, content) { await mkdir(dirname(join(dir, rel)), { recursive: true }); await writeFile(join(dir, rel), content, 'utf8'); return { bytes: content.length }; },
    async listFiles() { return walk(dir); },
    git: {
      async commit(message) { note('commit'); git('add', '-A'); if (!git('status', '--porcelain')) return null; git('commit', '-q', '-m', message); return head(); },
      async head() { return head(); },
      async resetHard(sha) { note('resetHard'); git('reset', '--hard', '-q', sha); git('clean', '-fdq'); },
      async tag() {}, async changedFiles() { return []; }, async treeHash() { return 'tree'; }, async restorePath() {},
    },
  };
}

const ok = { inputTokens: 10, outputTokens: 5 };
export function fakeModelClient(opts = {}) {
  const calls = [];
  const client = {
    calls,
    async complete(req) {
      const record = { model: req.model, schema: req.responseSchema?.name ?? null, signal: req.signal ?? null, content: typeof req.messages?.[0]?.content === 'string' ? req.messages[0].content : '' };
      calls.push(record);
      if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'cancelled', retryable: false });
      const fail = opts.failModel?.(req);
      if (fail) throw Object.assign(new Error(fail === true ? `provider rejected the request (key ${FAKE_KEY})` : fail), { code: 'bad_request', retryable: false });
      if (opts.onComplete) await opts.onComplete(req, record);
      const usage = opts.unknownCost ? { inputTokens: null, outputTokens: null, costUsd: null, source: 'unknown' }
        : { ...ok, costUsd: typeof opts.costPerCall === 'function' ? opts.costPerCall(req) : (opts.costPerCall ?? 0.001), source: 'provider' };
      let json = null;
      if (req.responseSchema?.name === 'shelf_life_extract') json = shelfExtract(req);
      if (req.responseSchema?.name === 'shelf_life_verify') json = shelfVerify(req, opts.shelf ?? {});
      return { model: req.model, text: 'ok', json, toolCalls: [], stopReason: 'end', usage, durationMs: 5, assistantMessage: { role: 'assistant', content: 'ok' } };
    },
  };
  return client;
}

// ---- Shelf Life fixtures (synthetic) -------------------------------------------------------------------------
function shelfExtract(req) {
  const { lines } = JSON.parse(req.messages[0].content);
  const hit = lines.find(l => /calls per day/.test(l.text));
  if (!hit) return { claims: [] };
  const tag = lines[0].text.startsWith('Plan facts') ? 'plan fact' : 'readme fact';
  const oldValue = /\d[\d,]*\d|\d/.exec(hit.text)[0];
  return { claims: [{ line: hit.line, quote: hit.text, statement: `${tag}: the free API allows ${oldValue} calls per day`, category: 'limit', oldValue }] };
}
function shelfVerify(req, shelf) {
  const { claim, sources } = JSON.parse(req.messages[0].content);
  const mode = claim.statement.startsWith('plan fact') ? (shelf.plan ?? 'fresh') : (shelf.readme ?? 'stale');
  if (mode === 'insufficient') return { verdict: 'unsure', currentValue: null, sourceIndexes: [0], rationale: 'The sources do not state the limit.' };
  const all = sources.map((_, i) => i);
  if (mode === 'fresh' || claim.oldValue === '5,000') return { verdict: 'fresh', currentValue: claim.oldValue, sourceIndexes: all, rationale: 'Fixture rationale.' };
  return { verdict: 'stale', currentValue: '5,000', sourceIndexes: all, rationale: 'Fixture rationale.' };
}
export function fakeSearchClient(opts = {}) {
  const calls = [];
  return {
    calls, available: opts.available !== false,
    async search(req) {
      calls.push({ query: req.query, signal: req.signal ?? null });
      if (req.signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'cancelled' });
      const mode = req.query.includes('plan fact') ? (opts.plan ?? 'fresh') : (opts.readme ?? 'stale');
      const first = req.query.startsWith('Find ');
      const insufficient = mode === 'insufficient';
      const value = mode === 'fresh' ? (/allows ([\d,]*\d) calls/.exec(req.query)?.[1] ?? '5,000') : '5,000';
      const source = first
        ? { name: 'Provider docs', url: 'https://docs.weather-api.example/limits', domain: 'docs.weather-api.example', snippet: insufficient ? 'Limits are described on the provider website.' : `The free tier allows ${value} calls per day.`, retrievedAt: '2026-11-15T00:00:00.000Z' }
        : { name: 'Developer forum', url: 'https://dev-forum.example.net/limits', domain: 'dev-forum.example.net', snippet: insufficient ? 'Contact the provider for current limits.' : `Free accounts are limited to ${value} calls per day.`, retrievedAt: '2026-11-15T00:00:00.000Z' };
      return { answer: null, sources: [source], durationMs: 1 };
    },
  };
}

// ---- artifacts ------------------------------------------------------------------------------------------------
const nowIso = '2026-11-15T00:00:00.000Z';
export const makeBrief = (extra = {}) => ({
  title: 'Umbrella page', restatedGoal: 'A page that says whether to take an umbrella.', targetUser: 'Anyone in London',
  productKind: 'web_page', mustHaves: ['Shows yes or no', 'Uses tomorrow forecast'], niceToHaves: [],
  assumptions: [{ topic: 'Location', assumed: 'London', why: 'The wish names London.' }], constraints: ['no API keys'],
  researchQuestions: ['Is there a free weather API?'], refused: null, ...extra,
});
export const makeResearch = () => ({
  findings: [{ question: 'Is there a free weather API?', answer: 'Open-Meteo free tier allows 10,000 calls per day.',
    sources: [{ name: 'Open-Meteo pricing', url: 'https://open-meteo.com/en/pricing', domain: 'open-meteo.com', snippet: 'Free tier.', retrievedAt: nowIso }], confidence: 'high', basis: 'search' }],
  recommendedApproach: 'Static page calling Open-Meteo.', externalServices: [{ name: 'Open-Meteo', url: 'https://open-meteo.com', needsKey: false, notes: 'free forecast API' }],
  risks: [], searchesUsed: 1,
});
export const makeSpec = (extra = {}) => ({
  specVersion: 1, title: 'Umbrella page', summary: 'Shows whether to take an umbrella tomorrow.', stack: 'static-web',
  entry: { kind: 'open_html', path: 'index.html' }, architecture: 'One page.', assumptions: [], outOfScope: [],
  sources: [{ name: 'Open-Meteo', url: 'https://open-meteo.com', domain: 'open-meteo.com', snippet: 'Open-Meteo documents daily precipitation probability.', retrievedAt: nowIso }],
  workItems: [
    { id: 'W1', title: 'Page shell', description: 'A page.', difficulty: 'easy', suggestedModel: REFS.haiku, modelReason: 'Simple HTML.', dependsOn: [], files: ['W1.txt'], checkIds: ['A1'] },
    { id: 'W2', title: 'Forecast logic', description: 'Decides yes or no.', difficulty: 'medium', suggestedModel: null, modelReason: null, dependsOn: ['W1'], files: ['W2.txt'], checkIds: ['A2'] },
  ],
  acceptance: [
    { id: 'A1', itemId: 'W1', description: 'W1 file says ok', type: 'file', path: 'W1.txt', mustContain: ['ok'] },
    { id: 'A2', itemId: 'W2', description: 'W2 file says ok', type: 'file', path: 'W2.txt', mustContain: ['ok'] },
  ],
  ...extra,
});

// ---- the full deps --------------------------------------------------------------------------------------------
/**
 * makeKit(opts) → { deps, config, dataDir, calls, ... }. Every script is optional; defaults give the happy path.
 *   builder(item, attempt) → { [path]: content }      what the fake builder writes (default: "ok" into <id>.txt)
 *   reflector(input) → decision string                (default: next when the item's checks pass, else retry)
 *   reviewPlan(input, n) → partial PlanReview         (default: approve, all scores 3)
 *   planner(input, n) → spec                          (default: makeSpec())
 *   reviewFinal(input, n) → partial FinalReview
 *   shelf: { plan, readme }  'stale' | 'insufficient'    search/model scripts for the real Shelf Life skill
 */
export async function makeKit(opts = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'shallowsee-engine-'));
  const routerCalls = [];
  const router = fakeRouter(routerCalls);
  const modelClient = fakeModelClient(opts);
  const searchClient = fakeSearchClient({ available: opts.search !== false, ...(opts.shelf ?? {}) });
  const order = [];
  const violations = [];
  // active = workers (builder/tester) still pending; self = a worker doing its OWN git call. Engine git calls while active > self are violations.
  const guard = { active: 0, self: 0, onGit: op => { if (guard.active > guard.self) violations.push(`${op} while a worker was pending`); order.push(`git.${op}`); } };
  const seen = { roleCtx: {}, builderKeys: [], testerKeys: [], builderCalls: [], testerCalls: [], planner: [], reviewer: [], reporter: null, reflector: [] };
  let planRound = 0; let reviewRound = 0; let finalRound = 0;
  const touch = ctx => ctx.llm({ messages: [{ role: 'user', content: 'x' }] });
  const mark = (name, ctx) => { seen.roleCtx[name] = { search: ctx.search !== null, hasSkills: 'skills' in ctx }; };

  const roles = {
    checkSpecRules: opts.checkSpecRules ?? (() => []),
    intake: { name: 'intake', async run(input, ctx) { mark('intake', ctx); await touch(ctx); return opts.brief ?? makeBrief(opts.refused ? { refused: { reason: 'The wish needs a private account.' } } : {}); } },
    researcher: { name: 'researcher', async run(input, ctx) { mark('researcher', ctx); const p = ctx.search?.({ query: 'free weather api', depth: 'standard' }); await touch(ctx); await p; return makeResearch(); } },
    planner: { name: 'planner', async run(input, ctx) { mark('planner', ctx); await touch(ctx); seen.planner.push(input); return (opts.planner ?? (() => makeSpec()))(input, ++planRound); } },
    reviewer: {
      reviewPlan: { name: 'reviewer', async run(input, ctx) {
        mark('reviewPlan', ctx); await touch(ctx); seen.reviewer.push(input);
        return { verdict: 'approve', scores: { coversWish: 3, feasible: 3, testable: 3, scoped: 3 }, issues: [], requiredChanges: [], ...(opts.reviewPlan?.(input, ++reviewRound) ?? {}) };
      } },
      reviewFinal: { name: 'reviewer', async run(input, ctx) {
        mark('reviewFinal', ctx); await touch(ctx);
        return { verdict: 'ship', scores: { meetsWish: 3, works: 3, quality: 3 }, gaps: [], iterateItems: [], reviewerModel: REFS.opus, ...(opts.reviewFinal?.(input, ++finalRound) ?? {}) };
      } },
    },
    reflector: { name: 'reflector', async run(input, ctx) {
      mark('reflector', ctx); await touch(ctx); seen.reflector.push(input);
      const passed = (input.testReport.results ?? []).filter(r => r.itemId === input.item.id).every(r => r.status === 'pass');
      const decision = opts.reflector?.(input) ?? (passed ? 'next' : 'retry');
      return { itemId: input.item.id, decision, reason: `fake reflector: ${decision}`, fixInstructions: decision === 'retry' || decision === 'escalate' ? `Fix ${input.item.id}` : null, lessons: ['fake lesson'] };
    } },
    reporter: { name: 'reporter', async run(input, ctx) { mark('reporter', ctx); await touch(ctx); seen.reporter = input; if (opts.reporterThrows) throw new Error('reporter exploded'); return `# Fake report\nstatus: ${input.status}\n`; } },
  };

  const sandbox = {
    sandboxSupport: async () => (opts.sandboxOk === false ? { ok: false, flag: null, detail: 'Node permission model is unavailable' } : { ok: true, flag: '--permission', detail: 'ok' }),
    createWorkspace: async ({ dir }) => fakeWorkspace({ dir }, guard),
  };

  const builder = { async buildItem(o) {
    seen.builderKeys.push(Object.keys(o).sort());
    seen.builderCalls.push({ itemId: o.item.id, attempt: o.attempt, fixInstructions: o.fixInstructions, progress: o.progress });
    guard.active++; order.push(`builder.start ${o.item.id}#${o.attempt}`);
    try {
      await o.llm({ messages: [{ role: 'user', content: `build ${o.item.id}` }] });
      if (opts.blockBuilder) await opts.blockBuilder(o);
      o.onTool?.({ phase: 'call', name: 'write_file', summary: 'path ' + o.item.id });
      const files = await (opts.builder ?? ((item) => ({ [`${item.id}.txt`]: 'ok' })))(o.item, o.attempt, o);
      for (const [path, content] of Object.entries(files)) await o.workspace.writeFile(path, content);
      o.onTool?.({ phase: 'result', name: 'write_file', summary: 'written', status: 'ok', durationMs: 1 });
      guard.self++;
      const commit = await o.workspace.git.commit(`${o.item.id} attempt ${o.attempt}`);
      guard.self--;
      return { status: 'done', summary: 'fake build', commit, filesChanged: Object.keys(files), turns: 1, toolCalls: 1 };
    } finally { guard.active--; order.push(`builder.settled ${o.item.id}#${o.attempt}`); }
  } };

  const tester = {
    async materializeAcceptance(o) {
      await o.llm({ messages: [{ role: 'user', content: 'materialize' }] });
      await o.workspace.writeFile('acceptance/README.txt', 'frozen acceptance tests (synthetic)\n');
      guard.self++;
      const commit = await o.workspace.git.commit('scaffold: acceptance tests');
      guard.self--;
      return { files: ['acceptance/README.txt'], commit, acceptanceTree: 'tree-1' };
    },
    async runChecks(o) {
      seen.testerKeys.push(Object.keys(o).sort());
      seen.testerCalls.push({ scope: o.scope, acceptanceCommit: o.acceptanceCommit, acceptanceTree: o.acceptanceTree });
      guard.active++; order.push(`tester.start ${o.scope.kind}`);
      try {
        const judged = await o.judge({ messages: [{ role: 'user', content: 'judge' }] });
        if (opts.blockTester) await opts.blockTester(o);
        const ids = o.spec.workItems.map(i => i.id);
        const upTo = o.scope.kind === 'item' ? ids.indexOf(o.scope.itemId) : ids.length - 1;
        const inScope = new Set(o.scope.kind === 'all' ? ids : ids.slice(0, o.scope.includeRegression ? upTo + 1 : 0).concat(o.scope.itemId));
        const results = [];
        for (const c of o.spec.acceptance.filter(x => inScope.has(x.itemId))) {
          let content = null;
          try { content = await o.workspace.readFile(c.path); } catch { /* missing file */ }
          const pass = content !== null && c.mustContain.every(t => content.includes(t));
          results.push({ checkId: c.id, itemId: c.itemId, type: c.type, status: pass ? 'pass' : 'fail',
            evidence: { command: undefined, quotes: pass ? [{ file: c.path, text: c.mustContain[0] }] : [] }, message: pass ? 'file contains the text' : `${c.path} missing "${c.mustContain[0]}"`, durationMs: 1 });
        }
        const passed = results.filter(r => r.status === 'pass').length;
        const intact = opts.acceptanceIntact !== false;
        const report = {
          scope: o.scope, candidate: await o.workspace.git.head(), results,
          summary: { total: results.length, passed, failed: results.length - passed, errored: 0, skipped: 0 },
          score: results.length ? passed / results.length : 0, acceptanceIntact: intact,
          allPassed: results.length > 0 && passed === results.length && intact, testerModel: judged.model,
        };
        return opts.mutateReport ? opts.mutateReport(report, o) : report;
      } finally { guard.active--; order.push(`tester.settled ${o.scope.kind}`); }
    },
  };

  const config = opts.config ?? fakeConfig(opts.configExtra ?? {});
  const deps = {
    modelClient, searchClient, router, roles, sandbox, builder, tester, createEventLog,
    skills: opts.skills === undefined ? SKILLS : opts.skills, now: opts.now ?? Date.now,
    ...(opts.depsOverride ?? {}),
  };
  return { deps, config, dataDir, modelClient, searchClient, routerCalls, order, violations, seen, guard, cleanup: () => rm(dataDir, { recursive: true, force: true }).catch(() => {}) };
}

export async function readLog(dataDir, roomId) {
  const text = await readFile(join(dataDir, 'rooms', roomId, 'events.jsonl'), 'utf8');
  return text.trim().split('\n').map(line => JSON.parse(line));
}
export const readJson = async (dataDir, runId, rel) => JSON.parse(await readFile(join(dataDir, 'harness', 'runs', runId, ...rel.split('/')), 'utf8'));
export const readText = (dataDir, runId, rel) => readFile(join(dataDir, 'harness', 'runs', runId, ...rel.split('/')), 'utf8');
