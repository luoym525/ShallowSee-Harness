import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { createCoordinator } from '../core/index.mjs';
import { createRuntime, RuntimeError } from './index.mjs';

const roles = ['presales', 'planner', 'project_manager', 'developer', 'tester', 'support'];
const commit = 'git:' + 'a'.repeat(40);
const unknownUsage = { source: 'unknown', inputTokens: null, outputTokens: null, costUsd: null };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, backend = 'fake') {
  const projectId = 'project';
  const authority = Symbol('test operator');
  const workspace = mkdtempSync(join(tmpdir(), 'shallowsee-runtime-'));
  t.after(() => rmdirSync(workspace));
  const core = createCoordinator({ operatorId: 'test-user', operatorAuthority: authority });
  let seq = 0;
  const input = (fields = {}) => ({ commandId: 'fixture-' + ++seq, projectId, ...fields });
  const profiles = roles.map(role => ({ id: role + '-fixture', role, backend, model: 'fixture-model', tools: ['search', 'read_files', 'write_files'] }));
  core.createProject(input({ goal: 'Deliver an example', constraints: ['Use test fixtures'], profiles }));
  const plan = core.definePlan(input({ plan: {
    summary: 'Build a small example', scope: ['One working command'], architecture: 'One component',
    workItems: ['Implement, document and test'], acceptanceCriteria: ['Test passes'],
  } }));
  core.confirmPlan(input({ planVersion: plan.version, planDigest: plan.digest, confirmationRef: 'human-confirmation' }), authority);
  const state = () => core.getProject(projectId);
  const task = (kind, extra = {}) => core.createTask(input({ taskId: kind + '-' + seq, title: kind, kind, workspace, ...extra }));
  const claim = current => core.claimTask(input({
    taskId: current.id, agentId: current.role + '-fixture', expectedTaskVersion: current.version, leaseMs: 5_000,
  }));
  const identity = run => ({
    projectId: run.projectId, taskId: run.taskId, runId: run.id, agentId: run.agentId,
    taskVersion: run.taskVersion, executionVersion: run.executionVersion,
  });
  const adapter = (execute, extra = {}) => ({ id: 'fixture-adapter', backend, model: 'fixture-model', allToolsMediated: true, execute, ...extra });
  const startRequest = (current, fields = {}) => input({
    taskId: current.id, expectedTaskVersion: current.version, adapterId: 'fixture-adapter', leaseMs: 5_000, ...fields,
  });
  const completeDirectly = current => {
    const run = claim(current);
    core.recordRunEnd(input({ ...identity(run), outcome: 'completed' }));
    return run;
  };
  const candidate = run => core.submitCandidate(input({ ...identity(run), contentRef: commit })).candidate;
  function guide(current) {
    const run = completeDirectly(task('documentation'));
    return core.recordGuide(input({
      ...identity(run), candidateVersion: current.version, contentRef: current.contentRef, guideVersion: 'guide-v1', guideRef: 'guide-location',
    })).guide;
  }
  return { authority, core, state, task, claim, identity, adapter, startRequest, input, candidate, guide };
}

test('registered alias authorizes actual tool execution, with immutable context and idempotent start and tool calls', async t => {
  const f = fixture(t);
  let starts = 0;
  let toolCalls = 0;
  const runtime = createRuntime({
    coordinator: f.core,
    adapters: [f.adapter(async ({ context, callTool }) => {
      starts++;
      assert.equal(context.profile.role, 'planner');
      assert.equal(context.plan.confirmed, true);
      assert.deepEqual(Object.keys(context), ['project', 'plan', 'task', 'profile', 'candidate', 'delivery']);
      assert.equal('confirmation' in context.plan, false);
      assert.throws(() => context.profile.tools.push('invented'), TypeError);
      assert.throws(() => { context.plan.scope[0] = 'modified'; }, TypeError);
      const args = { query: 'original', filters: { two: 2, one: 1 } };
      const first = callTool({ name: 'index.lookup', callId: 'lookup', args });
      args.query = 'modified afterwards';
      const replay = callTool({ name: 'index.lookup', callId: 'lookup', args: { filters: { one: 1, two: 2 }, query: 'original' } });
      assert.equal(first, replay);
      await assert.rejects(callTool({ name: 'index.lookup', callId: 'lookup', args }), { code: 'TOOL_CALL_CONFLICT' });
      await assert.rejects(callTool({ name: 'index.lookup', callId: 'spoof', args: {}, agentId: 'developer' }), { code: 'TOOL_REQUEST_INVALID' });
      const result = await replay;
      assert.throws(() => { result.query = 'changed'; }, TypeError);
      return { output: result, usage: { source: 'provider', inputTokens: 10 } };
    })],
    tools: [{ name: 'index.lookup', capability: 'search', handler(args, { context }) {
      toolCalls++;
      assert.equal(context.profile.role, 'planner');
      assert.equal(args.query, 'original');
      return { query: args.query, matches: 1 };
    } }],
  });
  assert.throws(() => createRuntime({ coordinator: f.core }), { code: 'COORDINATOR_IN_USE' });
  const task = f.task('planning');
  const request = f.startRequest(task);
  const handle = runtime.start(request);
  assert.equal(runtime.start({ ...request }), handle);
  assert.throws(() => runtime.start({ ...request, leaseMs: 999 }), { code: 'START_CONFLICT' });
  assert.throws(() => runtime.start({ ...request, agentId: 'developer' }), { code: 'INVALID_START' });
  const result = await handle.done;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.current, true);
  assert.deepEqual(result.output, { query: 'original', matches: 1 });
  assert.deepEqual(result.usage, { source: 'provider', inputTokens: 10, outputTokens: null, costUsd: null });
  assert.equal(starts, 1);
  assert.equal(toolCalls, 1);
  assert.equal(f.state().runs.length, 1);
  assert.equal(f.state().tasks.find(item => item.id === task.id).status, 'claimed');
  assert.equal(handle.cancel(), false);
});

test('search and forged canonical alias requests are blocked before developer, tester and support handlers', async t => {
  const f = fixture(t);
  const blocked = [];
  let handlers = 0;
  const runtime = createRuntime({
    coordinator: f.core,
    adapters: [f.adapter(async ({ context, callTool }) => {
      blocked.push(context.profile.role);
      await assert.rejects(callTool({ name: 'unassuming.lookup', callId: 'try-1', args: { role: 'planner' } }), { code: 'SEARCH_DENIED' });
      await assert.rejects(callTool({ name: 'search', callId: 'try-2', args: {} }), { code: 'UNKNOWN_TOOL' });
      await assert.rejects(callTool({ name: 'unassuming.lookup', callId: 'try-3', args: {}, capability: 'read_files' }), { code: 'TOOL_REQUEST_INVALID' });
      return { output: { accepted: true } };
    })],
    tools: [{ name: 'unassuming.lookup', capability: 'search', handler() { handlers++; return null; } }],
  });
  async function execute(type, fields) {
    const result = await runtime.start(f.startRequest(f.task(type, fields))).done;
    assert.equal(result.outcome, 'completed');
    return f.state().runs.find(run => run.id === result.runId);
  }
  const developer = await execute('development');
  assert.equal(f.state().candidate, null);
  const compiled = f.candidate(developer);
  const guide = f.guide(compiled);
  const tester = await execute('testing');
  assert.equal(f.state().candidate.test, null);
  f.core.recordTestResult(f.input({
    ...f.identity(tester), candidateVersion: compiled.version, contentRef: compiled.contentRef,
    guideVersion: guide.version, passed: true, reportRef: 'independent-report',
  }));
  const delivery = f.core.acceptDelivery(f.input({
    candidateVersion: compiled.version, contentRef: compiled.contentRef, guideVersion: guide.version,
    reportRef: 'independent-report', confirmationRef: 'operator-accept',
  }), f.authority);
  await execute('support', { deliveryId: delivery.id });
  assert.deepEqual(blocked, ['developer', 'tester', 'support']);
  assert.equal(handlers, 0);
});

test('mismatched model and unmediated CLI adapters are rejected before claiming or running', t => {
  const f = fixture(t, 'cli');
  let launches = 0;
  const execute = () => { launches++; return { output: null }; };
  const runtime = createRuntime({
    coordinator: f.core,
    adapters: [
      f.adapter(execute, { id: 'unmediated', allToolsMediated: false }),
      f.adapter(execute, { id: 'wrong-model', model: 'unregistered-model' }),
      f.adapter(execute, { id: 'wrong-backend', backend: 'api' }),
    ],
  });
  const task = f.task('development');
  assert.throws(() => runtime.start(f.startRequest(task, { adapterId: 'unmediated' })), { code: 'ADAPTER_UNMEDIATED' });
  assert.throws(() => runtime.start(f.startRequest(task, { adapterId: 'wrong-model' })), { code: 'ADAPTER_PROFILE_MISMATCH' });
  assert.throws(() => runtime.start(f.startRequest(task, { adapterId: 'wrong-backend' })), { code: 'ADAPTER_PROFILE_MISMATCH' });
  assert.equal(f.state().runs.length, 0);
  assert.equal(launches, 0);
});

test('pause and resume fences prevent subsequent broker side effects and mark the runner end historical', async t => {
  const f = fixture(t);
  const started = deferred();
  const continueRun = deferred();
  let invoked = 0;
  const runtime = createRuntime({
    coordinator: f.core,
    adapters: [f.adapter(async ({ callTool }) => {
      const first = { callId: 'before-pause', name: 'file.read', args: null };
      await callTool(first);
      started.resolve();
      await continueRun.promise;
      await assert.rejects(callTool(first), { code: 'STALE_RUN' });
      await assert.rejects(callTool({ callId: 'read', name: 'file.read', args: null }), { code: 'STALE_RUN' });
      return { output: 'finished the interrupted run' };
    })],
    tools: [{ name: 'file.read', capability: 'read_files', handler() { invoked++; return null; } }],
  });
  const handle = runtime.start(f.startRequest(f.task('development')));
  await started.promise;
  f.core.pause(f.input(), f.authority);
  f.core.resume(f.input(), f.authority);
  continueRun.resolve();
  const result = await handle.done;
  assert.equal(result.outcome, 'completed');
  assert.equal(result.current, false);
  assert.equal(invoked, 1);
  assert.equal(f.state().candidate, null);
});

test('pause between claim and dispatch fences the adapter before it starts', async t => {
  const f = fixture(t);
  let launched = false;
  const runtime = createRuntime({
    coordinator: f.core,
    adapters: [f.adapter(() => { launched = true; return { output: null }; })],
  });
  const handle = runtime.start(f.startRequest(f.task('development')));
  f.core.pause(f.input(), f.authority);
  const result = await handle.done;
  assert.equal(launched, false);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.current, false);
  assert.equal(result.error.code, 'STALE_RUN');
});

test('cancellation closes queued tools before invocation', async t => {
  const f = fixture(t);
  const scheduled = deferred();
  let calls = 0;
  const runtime = createRuntime({
    coordinator: f.core,
    adapters: [f.adapter(async ({ callTool }) => {
      scheduled.resolve();
      await assert.rejects(callTool({ callId: 'queued', name: 'read', args: null }), { code: 'RUN_CANCELLED' });
      await assert.rejects(callTool({ callId: 'later', name: 'read', args: null }), { code: 'RUN_CANCELLED' });
      return { output: null };
    })],
    tools: [{ name: 'read', capability: 'read_files', handler() { calls++; return null; } }],
  });
  const handle = runtime.start(f.startRequest(f.task('development')));
  await scheduled.promise;
  assert.equal(handle.cancel(), true);
  const result = await handle.done;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(calls, 0);
  assert.equal(handle.cancel(), false);
});

test('fire-and-forget tool keeps the workspace reserved after the adapter returns and cancellation starts', async t => {
  const f = fixture(t);
  const started = deferred();
  const releaseTool = deferred();
  let observedSignal;
  const runtime = createRuntime({
    coordinator: f.core,
    adapters: [f.adapter(({ callTool }) => {
      void callTool({ callId: 'write', name: 'writer', args: {} });
      return { output: null };
    })],
    tools: [{ name: 'writer', capability: 'write_files', async handler(args, { signal }) {
      observedSignal = signal;
      started.resolve();
      await releaseTool.promise;
      return null;
    } }],
  });
  const handle = runtime.start(f.startRequest(f.task('development')));
  const nextTask = f.task('development');
  await started.promise;
  await nextTurn();
  assert.throws(() => f.claim(nextTask), { code: 'WORKSPACE_BUSY' });
  assert.equal(handle.cancel(), true);
  assert.equal(observedSignal.aborted, true);
  await nextTurn();
  assert.equal(f.state().runs[0].end, null);
  assert.throws(() => f.claim(nextTask), { code: 'WORKSPACE_BUSY' });
  releaseTool.resolve();
  const result = await handle.done;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(f.state().runs[0].end.outcome, 'cancelled');
  assert.ok(f.claim(nextTask).workspace);
});

test('runtime deadline is bounded by its lease and does not release a still-executing adapter', { timeout: 5_000 }, async t => {
  const f = fixture(t);
  const abort = deferred();
  const release = deferred();
  const runtime = createRuntime({
    coordinator: f.core,
    limits: { maxRunMs: 2_000 },
    adapters: [f.adapter(async ({ signal }) => {
      signal.addEventListener('abort', abort.resolve, { once: true });
      await release.promise;
      return { output: 'late output' };
    })],
  });
  const handle = runtime.start(f.startRequest(f.task('development'), { leaseMs: 200 }));
  const nextTask = f.task('development');
  await abort.promise;
  assert.equal(f.state().runs[0].end, null);
  assert.throws(() => f.claim(nextTask), { code: 'WORKSPACE_BUSY' });
  release.resolve();
  const result = await handle.done;
  assert.equal(result.error.code, 'RUN_TIMEOUT');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.output, null);
  assert.ok(f.claim(nextTask));
});

test('a timed-out tool rejects the visible call but the actual tool retains the workspace until settlement', { timeout: 5_000 }, async t => {
  const f = fixture(t);
  const visibleTimeout = deferred();
  const release = deferred();
  const runtime = createRuntime({
    coordinator: f.core,
    limits: { maxToolMs: 20 },
    adapters: [f.adapter(async ({ callTool }) => {
      await assert.rejects(callTool({ callId: 'write', name: 'write', args: null }), { code: 'TOOL_TIMEOUT' });
      visibleTimeout.resolve();
      return { output: 'handled timeout' };
    })],
    tools: [{ name: 'write', capability: 'write_files', async handler() { await release.promise; return null; } }],
  });
  const handle = runtime.start(f.startRequest(f.task('development')));
  const next = f.task('development');
  await visibleTimeout.promise;
  assert.equal(f.state().runs[0].end, null);
  assert.throws(() => f.claim(next), { code: 'WORKSPACE_BUSY' });
  release.resolve();
  const result = await handle.done;
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error.code, 'TOOL_TIMEOUT');
  assert.ok(f.claim(next));
});

test('JSON arguments, tool count, result size and final output are bounded with safe errors', async t => {
  const f = fixture(t);
  let toolInvocations = 0;
  const runtime = createRuntime({
    coordinator: f.core,
    limits: { maxToolCalls: 1, maxToolArgsBytes: 16, maxToolResultBytes: 16, maxOutputBytes: 16 },
    adapters: [
      f.adapter(async ({ callTool }) => {
        const attempt = (callId, args) => callTool({ callId, name: 'find', args });
        await assert.rejects(attempt('non-json', { count: Infinity }), { code: 'TOOL_ARGS_INVALID' });
        await assert.rejects(attempt('too-large', 'x'.repeat(16)), { code: 'TOOL_ARGS_LIMIT' });
        assert.equal(await attempt('regular', {}), 13);
        await assert.rejects(attempt('too-many', {}), { code: 'TOOL_CALL_LIMIT' });
        return { output: '☃'.repeat(8), usage: { inputTokens: 1_000 } };
      }),
      f.adapter(async ({ callTool }) => {
        await assert.rejects(callTool({ callId: 'large-result', name: 'find', args: true }), { code: 'TOOL_RESULT_LIMIT' });
        return { output: 'caught failure' };
      }, { id: 'big-tool-result' }),
    ],
    tools: [{ name: 'find', capability: 'search', handler(args) {
      toolInvocations++;
      return args === true ? 'x'.repeat(17) : 13;
    } }],
  });
  const oversized = await runtime.start(f.startRequest(f.task('planning'))).done;
  assert.deepEqual(oversized.usage, unknownUsage);
  assert.equal(oversized.outcome, 'failed');
  assert.equal(oversized.error.code, 'OUTPUT_LIMIT');
  const toolResult = await runtime.start(f.startRequest(f.task('planning'), { adapterId: 'big-tool-result' })).done;
  assert.equal(toolResult.outcome, 'failed');
  assert.equal(toolResult.error.code, 'TOOL_RESULT_LIMIT');
  assert.equal(toolInvocations, 2);
});

test('handler and adapter failures preserve stable error codes without exposing raw exceptions or fabricated cancellation', async t => {
  const f = fixture(t);
  const runtime = createRuntime({
    coordinator: f.core,
    adapters: [
      f.adapter(async ({ callTool }) => {
        try {
          await callTool({ callId: 'broken', name: 'find', args: null });
        } catch (error) {
          assert.equal(error.code, 'TOOL_FAILED');
          assert.doesNotMatch(error.message, /private-detail/);
          throw error;
        }
        assert.fail('broken tool unexpectedly succeeded');
      }),
      f.adapter(() => { throw new Error('private-detail-from-provider'); }, { id: 'raw-failure' }),
      f.adapter(() => { throw new RuntimeError('RUN_CANCELLED'); }, { id: 'fabricated' }),
    ],
    tools: [{ name: 'find', capability: 'search', handler() { throw new Error('private-detail-from-tool'); } }],
  });
  for (const [adapterId, code] of [['fixture-adapter', 'TOOL_FAILED'], ['raw-failure', 'ADAPTER_FAILED'], ['fabricated', 'ADAPTER_FAILED']]) {
    const result = await runtime.start(f.startRequest(f.task('planning'), { adapterId })).done;
    assert.equal(result.outcome, 'failed');
    assert.equal(result.error.code, code);
    assert.doesNotMatch(JSON.stringify(result), /private-detail/);
    assert.deepEqual(result.usage, unknownUsage);
  }
});

test('a real Node process holding the workspace receives cancellation and must exit before release', { timeout: 10_000 }, async t => {
  const f = fixture(t, 'cli');
  const ready = deferred();
  const notified = deferred();
  let child;
  let exitObserved = false;
  const runtime = createRuntime({
    coordinator: f.core,
    adapters: [f.adapter(({ signal }) => new Promise((resolve, reject) => {
      child = spawn(process.execPath, ['-e', [
        "const {createInterface} = require('node:readline');",
        "const lines = createInterface({input: process.stdin});",
        "lines.on('line', line => { if (line === 'cancel') console.log('cancel-seen'); if (line === 'exit') process.exit(0); });",
        "console.log('ready');",
      ].join('\n')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      t.after(() => { if (!exitObserved) child.kill(); });
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        if (line === 'ready') ready.resolve();
        if (line === 'cancel-seen') notified.resolve();
      });
      signal.addEventListener('abort', () => child.stdin.write('cancel\n'), { once: true });
      child.once('error', reject);
      child.once('exit', exitCode => {
        exitObserved = true;
        if (exitCode === 0) resolve({ output: 'child exited' });
        else reject(new Error('child failed'));
      });
    }))],
  });
  const handle = runtime.start(f.startRequest(f.task('development')));
  const replacement = f.task('development');
  await ready.promise;
  assert.equal(handle.cancel(), true);
  await notified.promise;
  assert.equal(exitObserved, false);
  assert.equal(f.state().runs[0].end, null);
  assert.throws(() => f.claim(replacement), { code: 'WORKSPACE_BUSY' });
  child.stdin.write('exit\n');
  const result = await handle.done;
  assert.equal(exitObserved, true);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(f.state().runs[0].end.outcome, 'cancelled');
  assert.ok(f.claim(replacement).workspace);
});
