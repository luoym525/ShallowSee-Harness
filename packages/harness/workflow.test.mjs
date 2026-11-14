import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkflow } from './workflow.mjs';
import { syntheticModel } from './synthetic-model.mjs';
const writer = { append: async () => {} };
const search = async () => ({ sources: [{ url: 'https://example.org/synthetic-node-docs' }] });
test('workflow requires approval before code and reaches delivery with independent tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-flow-'));
  try {
    const opts = { idea: 'cart', root, writer, modelFor: syntheticModel, search, synthetic: true };
    const blocked = await runWorkflow({ ...opts, confirm: async () => false });
    assert.equal(blocked.phase, 'awaiting_confirmation');
    const done = await runWorkflow({ ...opts, confirm: async () => true });
    assert.equal(done.phase, 'delivery'); assert.equal(done.evidence.passed, true); assert.equal(done.plan.confirmed, true);
    const unresolved = await runWorkflow({ ...opts, search: async () => ({ sources: [] }), confirm: async () => { throw Error('must not approve'); } });
    assert.equal(unresolved.research.assessment, 'unresolved');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('missing tester execution triggers only one bounded fix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-retry-'));
  let developmentRuns = 0;
  try {
    const modelFor = (role, stage) => {
      if (role === 'developer') developmentRuns++;
      if (role === 'tester') return async () => ({ value: { type: 'final', content: 'No tests executed.', name: '', argumentsJson: '{}' } });
      return syntheticModel(role, stage);
    };
    const result = await runWorkflow({ idea: 'cart', root, writer, modelFor, search, synthetic: true, confirm: async () => true });
    assert.equal(result.phase, 'development'); assert.equal(result.evidence, null); assert.equal(developmentRuns, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('failed tests trigger one fix and never deliver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-fail-')); let developmentRuns = 0;
  try {
    const modelFor = (role, stage) => {
      if (role === 'developer') developmentRuns++;
      if (role !== 'tester') return syntheticModel(role, stage);
      let i = 0;
      return async () => ({ value: i++ === 0 ? { type: 'tool', name: 'write-test', content: '', argumentsJson: JSON.stringify({ path: 'tests/fail.test.mjs', content: "import { test } from 'node:test'; test('fails', () => { throw Error('failure'); });" }) } : i === 2 ? { type: 'tool', name: 'run-tests', content: '', argumentsJson: '{}' } : { type: 'final', name: '', content: 'Tests failed.', argumentsJson: '{}' } });
    };
    const result = await runWorkflow({ idea: 'cart', root, writer, modelFor, search, synthetic: true, confirm: async () => true });
    assert.equal(result.phase, 'development'); assert.equal(result.evidence.passed, false); assert.equal(developmentRuns, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('invalid or invented research citations stop the workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-research-'));
  try {
    for (const response of ['null', JSON.stringify({ assessment: 'current_supported', sourceURLs: ['https://example.org/synthetic-node-docs', 'https://invented.example/'] })]) {
      const modelFor = (role, stage) => stage === 'research' ? (() => { let step = 0; return async () => ({ value: step++ === 0 ? { type: 'tool', name: 'search', content: '', argumentsJson: '{"query":"docs"}' } : { type: 'final', name: '', content: response, argumentsJson: '{}' } }); })() : syntheticModel(role, stage);
      const result = await runWorkflow({ idea: 'cart', root, writer, modelFor, search, synthetic: true, confirm: async () => { throw Error('must not approve'); } });
      assert.equal(result.research.assessment, 'unresolved');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a failed test can be repaired in the single retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-repair-')); let testerRuns = 0, developerRuns = 0;
  try {
    const modelFor = (role, stage) => {
      if (role === 'developer') developerRuns++;
      if (role !== 'tester' || testerRuns++ > 0) return syntheticModel(role, stage);
      let i = 0;
      return async () => ({ value: i++ === 0 ? { type: 'tool', name: 'write-test', content: '', argumentsJson: JSON.stringify({ path: 'tests/cart.test.mjs', content: "import { test } from 'node:test'; test('failure', () => { throw Error('failure'); });" }) } : i === 2 ? { type: 'tool', name: 'run-tests', content: '', argumentsJson: '{}' } : { type: 'final', name: '', content: 'Failed.', argumentsJson: '{}' } });
    };
    const result = await runWorkflow({ idea: 'cart', root, writer, modelFor, search, synthetic: true, confirm: async () => true });
    assert.equal(result.phase, 'delivery'); assert.equal(result.evidence.passed, true); assert.equal(developerRuns, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
