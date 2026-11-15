import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, validateJson } from '../providers/index.mjs';
import { RoleError, SCHEMAS, checkSpecRules, intake, planner, reflector, reporter, researcher, reviewer } from './index.mjs';

const source = {
  name: 'Official docs', url: 'https://example.test/docs', domain: 'example.test',
  snippet: 'Public JSON at https://example.test/api', retrievedAt: '2026-11-15T05:00:00.000Z',
};
const brief = {
  title: 'Tip', restatedGoal: 'Split a tip', targetUser: 'Diner', productKind: 'cli_tool',
  mustHaves: ['Compute a tip', 'Warn on invalid input'], niceToHaves: [],
  assumptions: [{ topic: 'Currency', assumed: 'USD', why: 'Example locale' }], constraints: ['Offline'],
  researchQuestions: ['Which formula works?'], refused: null,
};
const researchResult = question => ({
  findings: [{ question, answer: 'Divide and round each share.', confidence: 'high', basis: 'search', sources: [source] }],
  recommendedApproach: 'Use Node. Calculate in cents.', externalServices: [], risks: [], searchesUsed: 0,
});
const command = {
  id: 'A1', itemId: 'W1', description: 'Print 8.00 for 20% of 40', type: 'command',
  run: ['node', 'tip.mjs', '40'], expectExitCode: 0, expectStdoutIncludes: ['8.00'], generate: false,
};
const spec = {
  specVersion: 1, title: 'Tip tool', summary: 'A tip calculator. Run it locally. Get the total.',
  stack: 'node', entry: { kind: 'command', run: ['node', 'tip.mjs', '40'] }, architecture: 'One Node script.',
  assumptions: [], outOfScope: ['Tax calculation'], sources: [source],
  workItems: [
    { id: 'W1', title: 'Tip arithmetic', description: 'Calculate a tip.', difficulty: 'easy', suggestedModel: 'fake/mini',
      modelReason: 'Works on basic arithmetic', dependsOn: [], files: ['tip.mjs'], checkIds: ['A1'] },
    { id: 'W2', title: 'Usage instructions', description: 'Explain usage.', difficulty: 'easy', suggestedModel: 'wrong/model',
      modelReason: 'Unknown model', dependsOn: ['W1'], files: ['README.md'], checkIds: ['A2'] },
  ],
  acceptance: [command, { id: 'A2', itemId: 'W2', description: 'Explain how to run the CLI and use its flags', type: 'file',
    path: 'README.md', mustContain: ['node tip.mjs', '--help'] }],
};
const plan = { verdict: 'approve', scores: { coversWish: 3, feasible: 3, testable: 3, scoped: 3 }, issues: [], requiredChanges: [] };
const final = { verdict: 'ship', scores: { meetsWish: 3, works: 2, quality: 2 }, gaps: [], iterateItems: [] };
const reflection = { itemId: 'W1', decision: 'retry', reason: 'CLI prints 7.00', fixInstructions: 'Compute 20% in tip.mjs; A1 expected 8.00.', lessons: [] };

function context(values, { search = null, signal } = {}) {
  const modelCalls = [];
  return {
    modelCalls, search, signal, now: () => source.retrievedAt, note() {},
    async llm(request) {
      const next = values[modelCalls.length];
      modelCalls.push(request);
      assert.notEqual(next, undefined, 'Unexpected model call');
      if (next instanceof Error) throw next;
      return Object.hasOwn(next, 'stopReason') ? next : { json: structuredClone(next), stopReason: 'end' };
    },
  };
}

test('intake returns the structured Brief, binds the signal and does not query private wish data', async () => {
  const signal = new AbortController().signal;
  const ctx = context([brief], { search: () => assert.fail('Intake search not expected'), signal });
  assert.deepEqual(await intake.run({ wish: 'A tool to split a tip' }, ctx), brief);
  const [request] = ctx.modelCalls;
  assert.equal(request.signal, signal);
  assert.equal(request.responseSchema.schema, SCHEMAS.brief);
  assert.equal(request.tools, undefined);
  assert.match(request.system, /untrusted data/);
});

test('intake preserves the refused Brief and does not repair a provider refusal', async () => {
  const refused = { ...brief, refused: { reason: 'Requires a private account.' } };
  assert.deepEqual(await intake.run({ wish: 'Needs private account' }, context([refused])), refused);
  const ctx = context([{ stopReason: 'refusal' }]);
  await assert.rejects(intake.run({ wish: 'Refuse this' }, ctx), { name: 'RoleError', code: 'refusal' });
  assert.equal(ctx.modelCalls.length, 1);
});

test('invalid output is repaired once, text-only JSON is parsed, and exhaustion has a stable error', async () => {
  const ctx = context([{ ...brief, mustHaves: [] }, { json: null, text: JSON.stringify(brief), stopReason: 'end' }]);
  assert.deepEqual(await intake.run({ wish: 'Same wish' }, ctx), brief);
  assert.equal(ctx.modelCalls.length, 2);
  assert.match(ctx.modelCalls[1].messages[1].content, /mustHaves.*too few items/);
  const bad = context([{}, {}]);
  await assert.rejects(intake.run({ wish: 'Same wish' }, bad), error => error instanceof RoleError && error.code === 'invalid_output');
  assert.equal(bad.modelCalls.length, 2);
});

test('planner retries a token-truncated response once with a larger copy of the same request', async () => {
  const truncated = { json: { title: 'partial' }, text: '{"title":', stopReason: 'max_tokens' };
  const ctx = context([truncated, spec]);
  const output = await planner.run({
    brief, research: researchResult(brief.researchQuestions[0]), roster: [{ ref: 'fake/mini' }],
  }, ctx);
  assert.equal(output.title, spec.title);
  assert.deepEqual(ctx.modelCalls.map(call => call.maxTokens), [32000, 64000]);
  assert.deepEqual(ctx.modelCalls[1].messages, ctx.modelCalls[0].messages);
  assert.equal(ctx.modelCalls[1].responseSchema, ctx.modelCalls[0].responseSchema);
});

test('a second token stop reports the expanded limit even if a partial artifact parses', async () => {
  const truncated = { json: brief, stopReason: 'max_tokens' };
  const ctx = context([truncated, truncated]);
  await assert.rejects(intake.run({ wish: 'A tip tool' }, ctx), {
    name: 'RoleError', code: 'invalid_output', message: /output limit.*16000 tokens/,
  });
  assert.deepEqual(ctx.modelCalls.map(call => call.maxTokens), [8000, 16000]);
  assert(ctx.modelCalls.every(call => call.messages.length === 1));
});

test('schema repair and token expansion each run once and preserve their request context', async () => {
  const ctx = context([{}, { json: null, text: '{', stopReason: 'max_tokens' }, plan]);
  assert.deepEqual(await reviewer.reviewPlan.run({
    brief, research: researchResult(brief.researchQuestions[0]), spec, planCheck: null,
  }, ctx), plan);
  assert.deepEqual(ctx.modelCalls.map(call => call.maxTokens), [32000, 32000, 64000]);
  assert.match(ctx.modelCalls[1].messages[1].content, /failed validation/);
  assert.deepEqual(ctx.modelCalls[2].messages, ctx.modelCalls[1].messages);
});

test('model errors and cancellation propagate without a repair', async () => {
  const abort = new AbortController();
  abort.abort(new Error('Stopped'));
  const ctx = context([brief], { signal: abort.signal });
  await assert.rejects(intake.run({ wish: 'Same wish' }, ctx), abort.signal.reason);
  assert.equal(ctx.modelCalls.length, 0);
  const error = Object.assign(new Error('Payment limit'), { code: 'budget_exhausted' });
  const interrupted = context([error]);
  await assert.rejects(intake.run({ wish: 'Same wish' }, interrupted), error);
  assert.equal(interrupted.modelCalls.length, 1);
});

test('research has a six-call global cap and a single deep search across five questions', async () => {
  const questions = ['First?', 'Second?', 'Third?', 'Fourth?', 'Fifth?'];
  const expected = { ...researchResult(questions[0]), findings: questions.map(question => researchResult(question).findings[0]) };
  const signal = new AbortController().signal;
  const calls = [];
  const ctx = context([expected], { signal, search: async request => { calls.push(request); return {}; } });
  const got = await researcher.run({ brief: { ...brief, researchQuestions: questions } }, ctx);
  assert.equal(got.searchesUsed, 6);
  assert.equal(calls.filter(call => call.depth === 'deep').length, 1);
  assert.equal(calls.filter(call => call.query.startsWith('First')).length, 2);
  assert.equal(calls.every(call => call.signal === signal), true);
  assert.equal(got.findings.every(finding => finding.confidence === 'low' && finding.basis === 'model_knowledge'
    && finding.sources.length === 0), true);
  assert.equal(validateJson(SCHEMAS.research, got).ok, true);
});

test('research keeps canonical retrieved evidence only, and allows a documented service endpoint', async () => {
  const ctx = context([{
    ...researchResult(brief.researchQuestions[0]), searchesUsed: 6,
    findings: [{ ...researchResult(brief.researchQuestions[0]).findings[0],
      sources: [{ ...source, name: 'Invented attribution' }, { ...source, url: 'https://other.test/unknown' }] }],
    externalServices: [
      { name: 'Documented endpoint', url: 'https://example.test/api', needsKey: false, notes: 'Public' },
      { name: 'Fabricated endpoint', url: 'https://example.test/api-but-not-that-one', needsKey: false, notes: 'Fabrication' },
    ],
  }], { search: async () => ({ answer: 'Read the docs.', sources: [source, { ...source, url: 'https://example.test/more' }] }) });
  const got = await researcher.run({ brief }, ctx);
  assert.equal(got.searchesUsed, 1);
  assert.deepEqual(got.findings[0].sources, [source]);
  assert.equal(got.externalServices.length, 1);
});

test('without search the role emits low-confidence model knowledge and repairs missing findings', async () => {
  const ctx = context([{ ...researchResult('Wrong question'), externalServices: [] }, researchResult(brief.researchQuestions[0])]);
  const got = await researcher.run({ brief }, ctx);
  assert.equal(got.searchesUsed, 0);
  assert.deepEqual(got.findings[0].sources, []);
  assert.equal(got.findings[0].basis, 'model_knowledge');
  assert.equal(got.findings[0].confidence, 'low');
  assert.equal(ctx.modelCalls.length, 2);
});

test('provider search failures degrade to model knowledge while engine limits propagate', async () => {
  const partial = context([researchResult(brief.researchQuestions[0])], {
    search: async () => { throw new ProviderError('network', 'Network unavailable.'); },
  });
  const result = await researcher.run({ brief }, partial);
  assert.equal(result.searchesUsed, 2);
  assert.equal(result.findings[0].basis, 'model_knowledge');
  assert.equal(result.findings[0].confidence, 'low');
  const limit = Object.assign(new Error('Engine deadline exceeded.'), { code: 'limit_exceeded' });
  const interrupted = context([], { search: async () => { throw limit; } });
  await assert.rejects(researcher.run({ brief }, interrupted), limit);
  assert.equal(interrupted.modelCalls.length, 0);
});

test('planner preserves valid model suggestions, strips unknown refs, grounds sources and sets the rev', async () => {
  const input = { brief, research: researchResult(brief.researchQuestions[0]), roster: [{ ref: 'fake/mini' }],
    revision: { previous: { ...spec, specVersion: 3 }, review: { requiredChanges: ['Clarify CLI flags.'] } } };
  const ctx = context([{ ...spec, sources: [{ ...source, name: 'Misattribution' }, { ...source, url: 'https://unseen.test/' }] }]);
  const value = await planner.run(input, ctx);
  assert.equal(value.specVersion, 4);
  assert.equal(value.workItems[0].suggestedModel, 'fake/mini');
  assert.equal(value.workItems[1].suggestedModel, null);
  assert.equal(value.workItems[1].modelReason, null);
  assert.deepEqual(value.sources, [source]);
  assert.deepEqual(checkSpecRules(value), []);
  assert.match(ctx.modelCalls[0].messages[0].content, /Clarify CLI flags/);
});

test('spec rejects incorrect links, out-of-order dependencies and too few executable checks', () => {
  const broken = structuredClone(spec);
  broken.workItems[0].checkIds = ['A2'];
  broken.workItems[0].dependsOn = ['W2'];
  broken.acceptance[0] = { id: 'A1', itemId: 'W1', description: 'Look', type: 'visual', page: '/', rubric: 'Looks good' };
  const issues = checkSpecRules(broken).join('\n');
  assert.match(issues, /earlier work item/);
  assert.match(issues, /must exist and point back/);
  assert.match(issues, /only once/);
  assert.match(issues, /owning work item/);
  assert.match(issues, /At least 60%/);
});

test('spec rejects sandbox command escapes, generated paths, and non-local HTTP requests', () => {
  const broken = structuredClone(spec);
  broken.entry.run = ['node', '--eval', 'test'];
  broken.acceptance[0].run = ['node', '../escape.mjs'];
  broken.acceptance[0].generate = true;
  const httpCheck = { id: 'A3', itemId: 'W2', type: 'http', description: 'Check response',
    start: ['node', 'server.mjs'], port: 4400, request: { method: 'GET', path: '//remote.test' }, expectStatus: 200 };
  broken.workItems[1].checkIds.push(httpCheck.id);
  broken.acceptance.push(httpCheck);
  const issues = checkSpecRules(broken).join('\n');
  assert.match(issues, /node entry/);
  assert.match(issues, /workspace-relative .mjs/);
  assert.match(issues, /local request path/);
  broken.acceptance[0].run = ['node', 'escape.mjs'];
  assert.ok(checkSpecRules(broken).some(issue => issue.includes('Place generated scripts under acceptance/')));
  httpCheck.port = 4499;
  httpCheck.request.path = '/forecast?units=metric';
  broken.entry.run = ['node', 'tip.mjs', '--help'];
  broken.acceptance[0].run = ['node', 'acceptance/tip.mjs'];
  assert.deepEqual(checkSpecRules(broken), []);
});

test('the plan must assign the root README to a work item with a content check for its actual entry', () => {
  const missing = structuredClone(spec);
  missing.workItems[1].files = ['docs/README.md'];
  assert.match(checkSpecRules(missing).join('\n'), /lists the root README\.md/);

  const unchecked = structuredClone(spec);
  delete unchecked.acceptance[1].mustContain;
  unchecked.acceptance[1].mustMatch = '.*';
  assert.match(checkSpecRules(unchecked).join('\n'), /file check for.*node tip\.mjs/);
  unchecked.acceptance[1].mustContain = ['node unrelated.mjs'];
  assert.match(checkSpecRules(unchecked).join('\n'), /file check for.*node tip\.mjs/);
  unchecked.acceptance[1].mustContain = ['node tip.mjs'];
  assert.deepEqual(checkSpecRules(unchecked), []);

  const otherOwner = structuredClone(spec);
  otherOwner.acceptance[1].itemId = 'W1';
  assert.match(checkSpecRules(otherOwner).join('\n'), /README\.md work item must have a file check/);

  const web = structuredClone(spec);
  web.stack = 'static-web';
  web.entry = { kind: 'open_html', path: 'public/index.html' };
  web.acceptance[1].mustContain = [web.entry.path];
  assert.deepEqual(checkSpecRules(web), []);
});

test('reviewer uses separated input and rejects an iteration naming an unknown work item', async () => {
  const noSearch = () => assert.fail('Reviewers cannot use search');
  const ctx = context([plan], { search: noSearch });
  const planCheck = { status: 'completed', findings: [{ verdict: 'unsure' }] };
  assert.deepEqual(await reviewer.reviewPlan.run({ brief, spec, research: {}, planCheck, internal: 'ignored' }, ctx), plan);
  assert.equal(JSON.parse(ctx.modelCalls[0].messages[0].content).internal, undefined);
  assert.match(ctx.modelCalls[0].system, /Calibration example, approve/);
  const finalCtx = context([{ ...final, verdict: 'iterate', iterateItems: ['W99'] }, final], { search: noSearch });
  assert.deepEqual(await reviewer.reviewFinal.run({ brief, spec, testReport: {}, fileList: [], readmeExcerpt: null }, finalCtx), final);
  assert.equal(finalCtx.modelCalls.length, 2);
});

test('reflector output is tied to the item being tested', async () => {
  const ctx = context([{ ...reflection, itemId: 'W2' }, reflection], { search: () => assert.fail('No reflection search') });
  assert.deepEqual(await reflector.run({ item: spec.workItems[0], progress: 'The CLI check failed.' }, ctx), reflection);
  assert.match(ctx.modelCalls[1].messages[1].content, /exact ID/);
});

test('reporter renders checks mechanically, verifies highlight IDs and labels skipped fact checks', async () => {
  const testReport = { acceptanceIntact: true, testerModel: 'fake/tester',
    results: [
      { checkId: 'A1', itemId: 'W1', status: 'pass', message: 'Output was 8.00.' },
      { checkId: 'A2', itemId: 'W2', status: 'fail', message: 'Expected usage | help.' },
    ] };
  const ctx = context([{ highlightItemIds: ['W2'] }, { highlightItemIds: ['W1'] }], { search: () => assert.fail('No reporting search') });
  const md = await reporter.run({
    wish: 'Split a tip', spec, brief, finalReport: testReport, finalReview: final, planCheck: { status: 'skipped', reason: 'No search configured' },
    factCheck: { status: 'completed', findings: [{ verdict: 'stale', statement: 'Rate is old', currentValue: 'new',
      sources: [source], checks: [{ check: 'independent_sources', passed: true }] }] },
    status: 'partial', spend: { usd: null, minutes: 2.5 }, fileList: ['tip.mjs'],
  }, ctx);
  assert.deepEqual([...md.matchAll(/^## (.+)$/gm)].map(match => match[1]), [
    'What you asked for', 'What you got', 'How to use it', 'What was checked', 'Known gaps',
    'Fact check', 'Assumptions we made for you', 'Sources', 'How it was built',
  ]);
  assert.match(md, /A1 \| W1 \| pass/);
  assert.match(md, /A2 \| W2 \| fail/);
  assert.match(md, /1 of 2 checks passed/);
  assert.match(md, /Recorded model cost — unknown/);
  assert.match(md, /not verified \(No search configured\)/);
  assert.match(md, /proposed, unreviewed/);
  assert.match(md, /Editorial independence has not been reviewed/);
  assert.match(md, /Tip arithmetic/);
  assert.doesNotMatch(md, /Work verified.*Usage instructions/);
  assert.equal(ctx.modelCalls.length, 2);
});
