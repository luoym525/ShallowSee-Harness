import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRoster, describeRouting, selectModel, RouterError } from './index.mjs';

const names = ['fable', 'opus', 'sonnet', 'haiku'];
const ref = name => 'anthropic/claude-' + name + (name === 'fable' ? '-5-2' : '-5-5');
const codes = code => ({ name: 'RouterError', code });

function provider(models, fields = {}) {
  return {
    id: 'anthropic', preset: 'anthropic', kind: 'anthropic', enabled: true,
    apiKey: 'offline-fixture', models: models.map(model => ({ enabled: true, ...model })), ...fields,
  };
}

const roster = buildRoster({
  providers: [provider(names.map(name => ({ id: ref(name).split('/')[1], label: name })))],
});

test('roster uses enabled configured models and never returns credentials', () => {
  const customModels = [
    { id: 'mini-pro-vision', inputUsdPerMTok: null, outputUsdPerMTok: 0 },
    { id: 'unknown/model', tier: 1, capabilities: ['coding'] },
    { id: 'unknown', enabled: false },
  ];
  const config = { providers: [
    provider(customModels, { id: 'local', kind: 'openai_compatible', preset: 'ollama', apiKey: '' }),
    provider([{ id: 'unknown' }], { id: 'keyless', apiKey: '' }),
    provider([{ id: 'unknown' }], { id: 'disabled', enabled: false }),
    provider([{ id: 'unknown' }], { id: 'search', kind: 'linkup' }),
  ] };
  const result = buildRoster(config);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    ref: 'local/mini-pro-vision', providerId: 'local', providerKind: 'openai_compatible', vendor: 'ollama',
    modelId: 'mini-pro-vision', label: 'mini-pro-vision', tier: 1, capabilities: ['coding', 'tools', 'json'],
    inputUsdPerMTok: null, outputUsdPerMTok: 0, catalogMatched: true,
  });
  assert.equal(result[1].ref, 'local/unknown/model');
  assert.deepEqual(result[1].capabilities, ['coding']);
  assert.equal(result[1].catalogMatched, false);
  assert.equal(result[1].inputUsdPerMTok, null);
  assert.equal(result[1].outputUsdPerMTok, null);
  assert(!JSON.stringify(result).includes('apiKey'));
});

test('catalog exact entries beat earlier matching regexes and explicit model fields win', () => {
  const catalog = [
    { match: '^.*', tier: 2, capabilities: ['json'], inputUsdPerMTok: 10, outputUsdPerMTok: 20 },
    { match: 'special', tier: 3, capabilities: ['tools'], inputUsdPerMTok: 30, outputUsdPerMTok: 40 },
  ];
  const config = { providers: [provider([{ id: 'special', capabilities: [], inputUsdPerMTok: null }])] };
  assert.deepEqual(buildRoster(config, { catalog })[0], {
    ref: 'anthropic/special', providerId: 'anthropic', providerKind: 'anthropic', vendor: 'anthropic',
    modelId: 'special', label: 'special', tier: 3, capabilities: [],
    inputUsdPerMTok: null, outputUsdPerMTok: 40, catalogMatched: true,
  });
});

test('the strongest configured planner and an independent reviewer route with distinct fallbacks', () => {
  const planner = selectModel({ role: 'planner' }, roster);
  assert.equal(planner.model, ref('fable'));
  assert.deepEqual(planner.fallbacks, [ref('opus'), ref('sonnet')]);
  const reviewer = selectModel({ role: 'reviewer', avoidModels: [planner.model] }, roster);
  assert.equal(reviewer.model, ref('opus'));
  assert.deepEqual(reviewer.fallbacks, [ref('sonnet')]);
});

test('one Haiku falls back from tier 2 when capable and rejects real missing requirements', () => {
  const small = roster.filter(model => model.ref === ref('haiku'));
  assert.match(selectModel({ role: 'tester' }, small).reason, /tier-2.*using tier 1/);
  assert.throws(() => selectModel({ role: 'planner' }, small), codes('no_match'));
  assert.throws(() => selectModel({ role: 'tester', avoidModels: [ref('haiku')] }, small), codes('no_match'));
});

test('builder follows tier 1, 2, 3 escalation and a low budget caps the target', () => {
  const expected = ['haiku', 'sonnet', 'opus'];
  expected.forEach((name, index) => {
    const choice = selectModel({ role: 'builder', difficulty: 'easy', attempt: index + 1 }, roster);
    assert.equal(choice.model, ref(name));
    assert.equal(choice.escalated, index > 0);
  });
  assert.equal(selectModel({ role: 'builder', difficulty: 'hard' }, roster).model, ref('sonnet'));
  assert.equal(selectModel({ role: 'builder', difficulty: 'medium' }, roster).model, ref('sonnet'));
  const capped = selectModel({ role: 'builder', attempt: 3, budgetRemainingUsd: 0.4 }, roster);
  assert.equal(capped.model, ref('sonnet'));
  assert.match(capped.reason, /budget.*tier 2/);
  assert.equal(selectModel({ role: 'planner', budgetRemainingUsd: 0.1 }, roster).model, ref('fable'));
});

test('builder accepts a capable planner suggestion then escalates from its tier', () => {
  const request = { role: 'builder', difficulty: 'easy', suggested: ref('sonnet') };
  const first = selectModel(request, roster);
  assert.equal(first.model, ref('sonnet'));
  assert.equal(first.suggested, true);
  assert.equal(first.rule, 'builder.planner_suggested');
  const second = selectModel({ ...request, attempt: 2 }, roster);
  assert.equal(second.model, ref('opus'));
  assert.equal(second.rule, 'builder.escalate.attempt2');
  assert.equal(second.escalated, true);
  assert.equal(second.suggested, false);
});

test('invalid suggestions explain absent model, missing capabilities, and avoidance', () => {
  const unusable = { ...roster[0], ref: 'fixture/text-only', capabilities: ['json'] };
  const candidates = [...roster, unusable];
  const cases = [
    [{ suggested: 'unconfigured/model' }, /not configured/],
    [{ suggested: unusable.ref }, /lacks coding, tools/],
    [{ suggested: ref('fable'), avoidModels: [ref('fable')] }, /excluded for this task/],
  ];
  for (const [request, reason] of cases) {
    const choice = selectModel({ role: 'builder', ...request }, candidates);
    assert.equal(choice.model, ref('haiku'));
    assert.equal(choice.suggested, false);
    assert.match(choice.reason, reason);
  }
});

test('explicit pins win only for configured, capable and allowed models', () => {
  const pin = selectModel({ role: 'builder', suggested: ref('sonnet') }, roster, { overrides: { builder: ref('fable') } });
  assert.equal(pin.model, ref('fable'));
  assert.equal(pin.pinned, true);
  const missingCapability = selectModel({ role: 'planner' }, roster, { overrides: { planner: ref('haiku') } });
  assert.equal(missingCapability.model, ref('fable'));
  assert.match(missingCapability.reason, /Pinned model.*lacks reasoning/);
  const avoided = selectModel({ role: 'tester', avoidModels: [ref('sonnet')] }, roster, { overrides: { tester: ref('sonnet') } });
  assert.notEqual(avoided.model, ref('sonnet'));
  assert.equal(avoided.pinned, false);
  assert(!avoided.fallbacks.includes(ref('sonnet')));
});

test('a tester selects an eligible different vendor when enabled and keeps same-vendor options otherwise', () => {
  const anotherVendor = { ...roster[3], ref: 'local/independent', vendor: 'ollama', outputUsdPerMTok: null };
  const request = { role: 'tester', avoidModels: [ref('haiku')], avoidVendors: ['anthropic'] };
  assert.equal(selectModel(request, [...roster, anotherVendor]).model, anotherVendor.ref);
  assert.equal(selectModel(request, roster).model, ref('sonnet'));
  assert.equal(selectModel(request, [...roster, anotherVendor], { preferVendorDiversity: false }).model, ref('sonnet'));
});

test('prefer capabilities before known price and break price ties by ref regardless of roster order', () => {
  const known = { ...roster[2], capabilities: ['json', 'tools'], outputUsdPerMTok: 0 };
  const preferred = { ...roster[2], ref: 'vendor/a', outputUsdPerMTok: null };
  const preferredTie = { ...preferred, ref: 'vendor/z' };
  const researcher = { role: 'researcher' };
  assert.equal(selectModel(researcher, [known, preferred]).model, preferred.ref);
  const candidates = [known, preferredTie, preferred];
  const first = selectModel({ role: 'intake' }, candidates);
  assert.equal(first.model, known.ref);
  assert.deepEqual(first.fallbacks, [preferred.ref, preferredTie.ref]);
  assert.deepEqual(first, selectModel({ role: 'intake' }, [...candidates].reverse()));
});

test('extra needs are hard constraints and the closer higher tier wins a distance tie', () => {
  const choice = selectModel({ role: 'researcher', needs: ['vision'], avoidModels: [ref('sonnet')] }, roster);
  assert.equal(choice.model, ref('opus'));
  assert(!choice.fallbacks.includes(ref('sonnet')));
});

test('empty rosters throw a configuration error and preview keeps all nine roles', () => {
  assert.throws(() => selectModel({ role: 'planner' }, []), RouterError);
  assert.throws(() => selectModel({ role: 'planner' }, []), codes('no_models'));
  const rows = describeRouting(roster, { overrides: { intake: ref('haiku') } });
  assert.equal(rows.length, 9);
  assert.deepEqual(rows[0], { role: 'intake', model: ref('haiku'), tier: 1, reason: 'Pinned by you in Setup: haiku.', pinned: true });
  assert(describeRouting([]).every(row => row.model === null && row.tier === null && /Setup/.test(row.reason)));
});
