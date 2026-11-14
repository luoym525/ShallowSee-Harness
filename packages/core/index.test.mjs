import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCoordinator } from './index.mjs';

const profileList = ['presales', 'planner', 'project_manager', 'developer', 'tester', 'support'].map(role => ({
  id: role + '-agent',
  role,
  backend: 'fake',
  model: role + '-test',
  tools: ['search', 'read_files', 'write_files'],
}));
const planBody = {
  summary: 'Build a converter',
  scope: ['Convert input'],
  architecture: 'One command',
  sources: ['primary-spec'],
  workItems: ['Implement converter', 'Write guide', 'Run independent checks'],
  acceptanceCriteria: ['Reject invalid input'],
};
const commit = key => 'git:' + key.repeat(40);

function fixture(t, { maxRework = 1 } = {}) {
  const authority = {};
  let time = 1_000;
  let sequence = 0;
  const core = createCoordinator({ operatorId: 'lynx', operatorAuthority: authority, now: () => time });
  const workspace = mkdtempSync(join(tmpdir(), 'shallowsee-coordinator-'));
  const subdirectories = [];
  t.after(() => {
    for (const directory of subdirectories.reverse()) rmdirSync(directory);
    rmdirSync(workspace);
  });
  function folder(name) {
    const directory = join(workspace, name);
    mkdirSync(directory);
    subdirectories.push(directory);
    return directory;
  }
  function input(overrides = {}) {
    return { projectId: 'example', commandId: 'command-' + ++sequence, ...overrides };
  }
  function create(overrides = {}) {
    return core.createProject(input({ goal: 'Build usable software', maxRework, profiles: profileList, ...overrides }));
  }
  function propose(overrides) {
    return core.definePlan(input({ plan: planBody, ...overrides }));
  }
  function confirm(plan, overrides) {
    return core.confirmPlan(input({ planVersion: plan.version, planDigest: plan.digest, confirmationRef: 'human:approve-plan', ...overrides }), authority);
  }
  function task(kind, overrides = {}) {
    return core.createTask(input({ taskId: kind + '-' + sequence, kind, title: kind, workspace, ...overrides }));
  }
  function claimInput(task, overrides = {}) {
    return input({ taskId: task.id, agentId: task.role + '-agent', expectedTaskVersion: task.version, leaseMs: 100, ...overrides });
  }
  function claim(task, overrides) {
    return core.claimTask(claimInput(task, overrides));
  }
  function forRun(run, overrides = {}) {
    return input({
      projectId: run.projectId, runId: run.id, taskId: run.taskId,
      agentId: run.agentId, taskVersion: run.taskVersion, executionVersion: run.executionVersion,
      candidateVersion: run.candidateVersion, contentRef: run.candidateContentRef, guideVersion: run.guideVersion, ...overrides,
    });
  }
  function end(run, result = 'completed') {
    return core.recordRunEnd(forRun(run, { outcome: result }));
  }
  function build(letter = 'a') {
    const run = claim(task('development'));
    end(run);
    return core.submitCandidate(forRun(run, { contentRef: commit(letter) })).candidate;
  }
  function document(version = 'guide-v1') {
    const run = claim(task('documentation'));
    end(run);
    return core.recordGuide(forRun(run, { guideVersion: version, guideRef: 'docs:' + version })).guide;
  }
  function check(passed, reportRef = 'report:one') {
    const run = claim(task('testing'));
    end(run);
    const command = forRun(run, { passed, reportRef });
    return { ...core.recordTestResult(command), command };
  }
  function accept(candidate, guide, reportRef) {
    return core.acceptDelivery(input({
      candidateVersion: candidate.version, contentRef: candidate.contentRef, guideVersion: guide.version,
      reportRef, confirmationRef: 'human:accept-delivery',
    }), authority);
  }
  create();
  return {
    core, authority, workspace, folder, input, create, propose, confirm, task, claimInput, claim, forRun, end, build, document, check, accept,
    advance(ms) { time += ms; },
    state() { return core.getProject('example'); },
  };
}

test('development requires trusted confirmation for the current version and digest', t => {
  const f = fixture(t);
  const { core } = f;
  assert.equal(f.state().stage, 'discovery');
  const plan = f.propose();
  const task = f.task('development');

  assert.equal(f.state().stage, 'awaiting_confirmation');
  assert.throws(() => core.dispatch({ projectId: 'example', kind: ['development'] }), { code: 'INVALID_TASK_KIND' });
  assert.throws(() => f.task('development', { kind: ['development'] }), { code: 'INVALID_TASK_KIND' });
  assert.equal(core.dispatch({ projectId: 'example', kind: 'development' }).reason, 'PLAN_UNCONFIRMED');
  assert.throws(() => f.claim(task), { code: 'PLAN_UNCONFIRMED' });
  assert.throws(() => core.confirmPlan(f.input({
    planVersion: plan.version, planDigest: plan.digest, confirmationRef: 'human:forged',
  }), {}), { code: 'OPERATOR_REQUIRED' });
  assert.throws(() => f.confirm(plan, { planDigest: 'forged-digest' }), { code: 'PLAN_MISMATCH' });
  assert.throws(() => f.confirm(plan, { planVersion: plan.version + 1 }), { code: 'PLAN_MISMATCH' });

  const approved = f.confirm(plan);
  assert.equal(approved.confirmation.operatorId, 'lynx');
  assert.equal(f.state().handoffs[0].to, 'developer');
  assert.equal(core.dispatch({ projectId: 'example', kind: 'development' }).permitted, true);
  assert.equal(f.claim(task).planVersion, plan.version);
});

test('task claim requires the configured role and completed dependencies', t => {
  const f = fixture(t);
  const dependency = f.task('presales');
  const task = f.task('planning', { dependencies: [dependency.id] });
  assert.throws(() => f.claim(task, { agentId: 'support-agent' }), { code: 'AGENT_ROLE_MISMATCH' });
  assert.throws(() => f.claim(task), { code: 'DEPENDENCIES_PENDING' });

  const first = f.claim(dependency);
  assert.throws(() => f.core.completeTask(f.forRun(first, { evidenceRef: 'notes:users' })), { code: 'RUN_NOT_COMPLETED' });
  f.end(first);
  assert.equal(f.state().tasks.find(item => item.id === dependency.id).status, 'claimed');
  f.core.completeTask(f.forRun(first, { evidenceRef: 'notes:users' }));
  assert.equal(f.claim(task).agentId, 'planner-agent');
});

test('concurrent distinct claims elect one winner and fenced leases reject old work', async t => {
  const f = fixture(t);
  const task = f.task('coordination');
  const firstCommand = f.claimInput(task);
  const secondCommand = f.claimInput(task);
  const contenders = [firstCommand, secondCommand].map(command => Promise.resolve().then(() => f.core.claimTask(command)));
  const [first, second] = await Promise.allSettled(contenders);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.reason.code, 'TASK_VERSION_MISMATCH');
  const run = first.value;
  assert.deepEqual(f.core.claimTask(firstCommand), run);
  assert.throws(() => f.core.claimTask({ ...firstCommand, leaseMs: 101 }), { code: 'COMMAND_CONFLICT' });
  assert.throws(() => f.claim({ ...task, version: run.taskVersion }), { code: 'TASK_ALREADY_CLAIMED' });

  f.advance(100);
  assert.throws(() => f.core.authorizeTool(f.forRun(run, { tool: 'read_files' })), { code: 'STALE_RUN' });
  const next = f.claim({ ...task, version: run.taskVersion });
  assert.equal(next.taskVersion, run.taskVersion + 1);
  f.end(run);
  assert.deepEqual(f.core.completeTask(f.forRun(run, { evidenceRef: 'notes:stale' })), {
    applied: false, reason: 'STALE_RUN', runId: run.id,
  });
  assert.equal(f.state().tasks[0].runId, next.id);
});

test('a paused or expired development run retains its directory until the runner confirms exit', t => {
  const f = fixture(t);
  f.confirm(f.propose());
  f.create({ projectId: 'other' });
  f.confirm(f.propose({ projectId: 'other' }), { projectId: 'other' });
  const firstTask = f.task('development');
  const alias = process.platform === 'win32' ? f.workspace.toUpperCase() : f.workspace;
  const otherTask = f.task('development', { projectId: 'other', workspace: alias + '/.' });
  const run = f.claim(firstTask);
  const other = () => f.claim(otherTask, { projectId: 'other' });
  assert.throws(other, { code: 'WORKSPACE_BUSY' });

  f.advance(100);
  assert.throws(other, { code: 'WORKSPACE_BUSY' });
  const pause = f.core.pause(f.input(), f.authority);
  assert.equal(pause.executionVersion, run.executionVersion + 1);
  f.core.resume(f.input(), f.authority);
  assert.throws(other, { code: 'WORKSPACE_BUSY' });
  f.end(run, 'cancelled');
  assert.equal(other().projectId, 'other');
});

test('canonical parent and child workspaces conflict in both directions, while siblings can run together', t => {
  const f = fixture(t);
  f.confirm(f.propose());
  const parent = f.task('development');
  const child = f.task('development', { workspace: f.folder('child') });
  const sibling = f.task('development', { workspace: f.folder('child-other') });

  const parentRun = f.claim(parent);
  assert.throws(() => f.claim(child), { code: 'WORKSPACE_BUSY' });
  f.end(parentRun);

  const childRun = f.claim(child);
  assert.throws(() => f.claim(f.task('development')), { code: 'WORKSPACE_BUSY' });
  assert.notEqual(f.claim(sibling).workspace, childRun.workspace);
});

test('late callbacks are retained once and cannot advance a resumed project', t => {
  const f = fixture(t);
  f.confirm(f.propose());
  const task = f.task('development');
  const run = f.claim(task);
  f.core.pause(f.input(), f.authority);
  f.core.resume(f.input(), f.authority);

  const result = f.end(run);
  assert.equal(result.current, false);
  const command = f.forRun(run, { contentRef: commit('a') });
  const rejected = f.core.submitCandidate(command);
  assert.deepEqual(rejected, { applied: false, reason: 'STALE_RUN', runId: run.id });
  assert.deepEqual(f.core.submitCandidate(command), rejected);
  assert.throws(() => f.core.submitCandidate({ ...command, contentRef: commit('b') }), { code: 'COMMAND_CONFLICT' });
  const state = f.state();
  assert.equal(state.history.filter(item => item.action === 'submitCandidate').length, 1);
  assert.equal(state.history.find(item => item.action === 'submitCandidate').value.contentRef, commit('a'));
  assert.equal(state.candidate, null);
  assert.equal(state.stage, 'development');
  const newRun = f.claim({ ...task, version: run.taskVersion });
  assert.throws(() => f.core.authorizeTool(f.forRun(newRun, {
    tool: 'read_files', executionVersion: run.executionVersion,
  })), { code: 'RUN_FENCE_MISMATCH' });
});

test('search requires a trusted live run, a configured capability and a permitted role', t => {
  const f = fixture(t);
  f.confirm(f.propose());
  for (const kind of ['presales', 'planning', 'coordination']) {
    const run = f.claim(f.task(kind));
    assert.deepEqual(f.core.authorizeTool(f.forRun(run, { tool: 'search' })), { permitted: true });
    assert.throws(() => f.core.authorizeTool(f.forRun(run, { tool: 'run_command' })), { code: 'TOOL_DENIED' });
    assert.throws(() => f.core.authorizeTool(f.forRun(run, { tool: 'write_files' })), { code: 'WORKSPACE_WRITE_DENIED' });
  }
  const developer = f.claim(f.task('development'));
  assert.deepEqual(f.core.authorizeTool(f.forRun(developer, { tool: 'write_files' })), { permitted: true });
  assert.throws(() => f.core.authorizeTool(f.forRun(developer, { tool: 'search' })), { code: 'SEARCH_DENIED' });
  assert.throws(() => f.core.authorizeTool(f.forRun(developer, { tool: 'web_search' })), { code: 'TOOL_DENIED' });
  f.end(developer, 'failed');

  const candidate = f.build();
  const guide = f.document();
  const tester = f.claim(f.task('testing'));
  assert.throws(() => f.core.authorizeTool(f.forRun(tester, { tool: 'search' })), { code: 'SEARCH_DENIED' });
  f.end(tester);
  f.core.recordTestResult(f.forRun(tester, { passed: true, reportRef: 'tests:pass' }));
  const delivery = f.accept(candidate, guide, 'tests:pass');
  const support = f.claim(f.task('support', { deliveryId: delivery.id }));
  assert.throws(() => f.core.authorizeTool(f.forRun(support, { tool: 'search' })), { code: 'SEARCH_DENIED' });
  assert.equal(support.deliveryId, delivery.id);
});

test('end-to-end delivery requires an exact candidate, a usage guide, and an independent passing report', t => {
  const f = fixture(t);
  f.confirm(f.propose());
  const developer = f.claim(f.task('development'));
  f.end(developer);
  assert.equal(f.state().stage, 'development');

  const candidate = f.core.submitCandidate(f.forRun(developer, { contentRef: commit('a') })).candidate;
  assert.equal(f.state().stage, 'documentation');
  assert.throws(() => f.task('testing'), { code: 'GUIDE_REQUIRED' });
  assert.throws(() => f.core.recordTestResult(f.forRun(developer, { passed: true, reportRef: 'dev:own-check' })), { code: 'WRONG_TASK_KIND' });
  const guide = f.document();
  const tester = f.claim(f.task('testing'));
  f.end(tester);
  assert.equal(f.state().stage, 'testing');
  assert.throws(() => f.accept(candidate, guide, 'test:pass'), { code: 'TEST_NOT_PASSED' });
  assert.throws(() => f.core.recordTestResult(f.forRun(tester, {
    passed: true, reportRef: 'test:pass', guideVersion: 'wrong-guide',
  })), { code: 'CANDIDATE_MISMATCH' });
  f.core.recordTestResult(f.forRun(tester, { passed: true, reportRef: 'test:pass' }));
  assert.equal(f.state().stage, 'delivery');
  assert.throws(() => f.accept(candidate, guide, 'test:other'), { code: 'TEST_NOT_PASSED' });
  const delivery = f.accept(candidate, guide, 'test:pass');
  assert.equal(f.state().stage, 'support');
  assert.equal(delivery.test.contentRef, candidate.contentRef);
  assert.equal(delivery.test.guideVersion, guide.version);
  assert.equal(delivery.operatorId, 'lynx');
  assert.deepEqual(f.state().handoffs.map(item => item.to), ['developer', 'project_manager', 'tester', 'project_manager', 'support']);
});

test('a new candidate invalidates prior testing and preserves the earlier report in history', t => {
  const f = fixture(t);
  f.confirm(f.propose());
  const before = f.build('a');
  const oldGuide = f.document('one');
  const oldTest = f.check(true, 'old-report');

  const current = f.build('b');
  const currentGuide = f.document('two');
  assert.throws(() => f.accept(before, oldGuide, 'old-report'), { code: 'CANDIDATE_MISMATCH' });
  assert.throws(() => f.accept(current, currentGuide, 'old-report'), { code: 'TEST_NOT_PASSED' });
  assert.equal(f.state().candidates[0].test.runId, oldTest.test.runId);
  const late = f.claim(f.task('testing'));
  f.end(late);
  f.build('c');
  const result = f.core.recordTestResult(f.forRun(late, { passed: false, reportRef: 'late-report' }));
  assert.deepEqual(result, { applied: false, reason: 'CANDIDATE_SUPERSEDED', runId: late.id });
  assert.equal(f.state().failedTests, 0);
});

test('a late development result preserves the newer candidate, guide and passing report', t => {
  const f = fixture(t);
  f.confirm(f.propose());
  const oldTask = f.task('development');
  const oldRun = f.claim(oldTask);
  f.end(oldRun);
  const current = f.build('b');
  const guide = f.document('current');
  const { test: report } = f.check(true, 'current-report');
  const handoffs = f.state().handoffs;

  const input = f.forRun(oldRun, { contentRef: commit('a') });
  const result = { applied: false, reason: 'CANDIDATE_SUPERSEDED', runId: oldRun.id };
  assert.deepEqual(f.core.submitCandidate(input), result);
  assert.deepEqual(f.core.submitCandidate(input), result);
  const state = f.state();
  assert.deepEqual(state.candidate, { ...current, guide, test: report });
  assert.deepEqual(state.handoffs, handoffs);
  assert.deepEqual(state.history.filter(entry => entry.commandId === input.commandId).map(entry => entry.value.contentRef), [commit('a')]);

  const nextRun = f.claim({ ...oldTask, version: oldRun.taskVersion });
  assert.equal(nextRun.baseCandidateVersion, current.version);
  f.end(nextRun);
  const next = f.core.submitCandidate(f.forRun(nextRun, { contentRef: commit('c') })).candidate;
  assert.equal(next.version, current.version + 1);
  assert.equal(f.state().candidates[0].test.reportRef, report.reportRef);
});

test('failed independent tests permit bounded rework and replay cannot charge the budget twice', t => {
  const f = fixture(t, { maxRework: 1 });
  const plan = f.confirm(f.propose());
  f.build('a');
  f.document('one');
  const first = f.check(false, 'failure-1');
  assert.equal(first.blocked, false);
  assert.equal(f.state().stage, 'development');
  assert.deepEqual(f.core.recordTestResult(first.command), { applied: true, test: first.test, blocked: false });
  assert.equal(f.state().failedTests, 1);

  const candidate = f.build('b');
  const guide = f.document('two');
  const second = f.check(false, 'failure-2');
  assert.equal(second.blocked, true);
  assert.equal(f.state().stage, 'blocked');
  assert.equal(f.state().failedTests, 2);
  assert.throws(() => f.claim(f.task('development')), { code: 'REWORK_EXHAUSTED' });
  assert.throws(() => f.accept(candidate, guide, 'failure-2'), { code: 'TEST_NOT_PASSED' });
  assert.equal(f.state().candidate.planVersion, plan.version);
});

test('new plans supersede earlier task versions even after the new version is confirmed', t => {
  const f = fixture(t);
  const old = f.confirm(f.propose());
  const task = f.task('development');
  const run = f.claim(task);
  const updated = f.propose();
  assert.equal(updated.version, old.version + 1);
  assert.notEqual(updated.digest, old.digest);
  assert.throws(() => f.confirm(old), { code: 'PLAN_MISMATCH' });
  f.confirm(updated);

  assert.equal(f.end(run).current, false);
  const result = f.core.submitCandidate(f.forRun(run, { contentRef: commit('a') }));
  assert.equal(result.reason, 'STALE_RUN');
  assert.throws(() => f.claim({ ...task, version: run.taskVersion }), { code: 'PLAN_SUPERSEDED' });
  assert.equal(f.build('b').planVersion, updated.version);
});
