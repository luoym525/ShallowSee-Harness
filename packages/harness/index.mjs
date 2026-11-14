import { createHash, randomUUID } from 'node:crypto';

const ROLES = ['presales', 'planner', 'project_manager', 'developer', 'tester', 'support'];
const SEARCH_ROLES = new Set(['presales', 'planner', 'project_manager']);
const SYSTEM = { memberId: null, role: 'system', mode: 'system', provider: null, model: null, identitySource: 'configured' };
const USER = { ...SYSTEM, role: 'user', mode: 'human' };
const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' is required');
  return value;
};
const digest = text => createHash('sha256').update(text).digest('hex');

/** Each project has one writer. Commands serialize validation and append together. */
export function createHarness({ writer, profiles = {} }) {
  if (!writer || typeof writer.append !== 'function') throw new Error('A project event writer is required');
  const state = { phase: 'new', version: 1, goal: null, plan: null, report: null, candidate: null, manual: null, tasks: [] };
  let queue = Promise.resolve();
  const command = fn => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  const append = (type, payload, options = {}) => writer.append({ type, payload, provenance: SYSTEM, ...options });
  const task = async (role, title, inputs = {}) => {
    const taskId = randomUUID();
    const payload = { title, owner: role, dependencies: [], inputs, deliverables: [], acceptance: [], status: 'ready', version: 1 };
    await append('task.created', payload, { taskId });
    state.tasks.push({ taskId, role, title });
    return taskId;
  };
  return {
    snapshot: () => structuredClone(state),
    start: (goal, { synthetic = false } = {}) => command(async () => {
      if (state.phase !== 'new') throw new Error('Project already started');
      required(goal, 'goal');
      await append('room.created', { goal, acceptanceCriteria: [], constraints: [], limits: { maxRuns: null, maxMinutes: null, maxUsd: null }, workflow: 'wish-coding', driver: 'harness', roomVersion: 1, ...(synthetic ? { synthetic: true } : {}) });
      for (const role of ROLES) {
        const profile = profiles[role] ?? {};
        await append('member.joined', { memberId: role, displayName: role, role, mode: profile.mode ?? 'system', provider: profile.provider ?? null, model: profile.model ?? null, capabilities: { tools: false, cancel: false, resume: false, streaming: 'none', usage: 'unknown' } });
      }
      state.goal = goal; state.phase = 'discovery';
      return task('presales', 'Clarify the project');
    }),
    proposePlan: text => command(async () => {
      if (state.phase === 'new' || state.phase === 'paused') throw new Error('Project is not available for planning');
      required(text, 'plan');
      const plan = { text, version: (state.plan?.version ?? 0) + 1, digest: digest(text), confirmed: false };
      await append('artifact.registered', { artifactId: 'plan-' + plan.version, kind: 'report', location: 'plan:' + plan.digest, version: plan.digest, evidence: [], plan });
      state.plan = plan; state.report = null; state.candidate = null; state.manual = null; state.phase = 'planning';
      return structuredClone(plan);
    }),
    recordResearch: report => command(async () => {
      if (!state.plan || report?.planDigest !== state.plan.digest) throw new Error('Research must match the current plan');
      if (!['planning', 'awaiting_confirmation'].includes(state.phase)) throw new Error('Research may only be recorded during planning');
      if (!['current_supported', 'update_required', 'unresolved'].includes(report.assessment)) throw new Error('Invalid research assessment');
      if (!Array.isArray(report.sources)) throw new Error('Research sources are required');
      if (report.assessment === 'current_supported' && !report.sources.some(source => {
        try {
          const url = new URL(source.url);
          const retrievedAt = Date.parse(source.retrievedAt);
          return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
            && Number.isFinite(retrievedAt) && retrievedAt <= Date.now();
        } catch { return false; }
      })) throw new Error('A supported report requires a dated source URL');
      const saved = structuredClone(report);
      await append('artifact.registered', { artifactId: randomUUID(), kind: 'report', location: 'research:' + state.plan.digest, version: state.plan.digest, evidence: [], report: saved });
      state.report = saved; state.phase = 'awaiting_confirmation';
    }),
    confirmPlan: planDigest => command(async () => {
      if (!state.plan || state.plan.digest !== planDigest) throw new Error('Confirmation must match the current plan');
      if (!state.report || state.report.assessment !== 'current_supported') throw new Error('Current plan needs a supported research report');
      if (state.phase !== 'awaiting_confirmation' || state.plan.confirmed) throw new Error('Plan is not awaiting confirmation');
      await append('message.posted', { messageId: randomUUID(), author: 'user', recipients: ['project_manager'], kind: 'user', content: 'Confirmed plan ' + planDigest }, { provenance: USER });
      state.plan.confirmed = true; state.phase = 'development';
      return task('developer', 'Implement confirmed plan', { planDigest });
    }),
    submitCode: candidate => command(async () => {
      if (state.phase !== 'development' || !state.plan?.confirmed) throw new Error('An approved plan is required');
      required(candidate, 'candidate version');
      await append('artifact.registered', { artifactId: randomUUID(), kind: 'file', location: candidate, version: candidate, evidence: [] });
      state.candidate = candidate; state.manual = null; state.phase = 'documentation';
      return task('project_manager', 'Write usage instructions', { candidate });
    }),
    submitManual: manual => command(async () => {
      if (state.phase !== 'documentation') throw new Error('A candidate is required');
      required(manual, 'manual');
      await append('artifact.registered', { artifactId: randomUUID(), kind: 'report', location: 'manual:' + digest(manual), version: state.candidate, evidence: [], content: manual });
      state.manual = manual; state.phase = 'testing';
      return task('tester', 'Test candidate and manual', { candidate: state.candidate });
    }),
    submitTest: ({ candidate, passed, evidence }) => command(async () => {
      if (state.phase !== 'testing' || candidate !== state.candidate) throw new Error('Test must match the candidate');
      if (typeof passed !== 'boolean') throw new Error('Test result must be explicit');
      required(evidence, 'test evidence');
      await append('artifact.registered', { artifactId: randomUUID(), kind: 'report', location: evidence, version: candidate, evidence: [{ kind: 'test_result', ref: evidence, summary: 'Independent test', passed }] });
      state.phase = passed ? 'delivery' : 'development';
      return task(passed ? 'project_manager' : 'developer', passed ? 'Prepare delivery' : 'Fix test failure', { candidate, evidence });
    }),
  };
}

/** Called by trusted runtime context, never by a model-provided role field. */
export function authorizeTool(role, tool) {
  if (!ROLES.includes(role)) return false;
  if (tool === 'search' || tool === 'shelf-life') return SEARCH_ROLES.has(role);
  if (tool === 'write-code') return role === 'developer';
  if (tool === 'run-tests') return role === 'developer' || role === 'tester';
  return false;
}

export function routeIntent(intent) {
  const routes = { idea: 'presales', planning: 'planner', progress: 'project_manager', coding: 'developer', testing: 'tester', support: 'support' };
  return typeof intent === 'string' && Object.hasOwn(routes, intent) ? routes[intent] : null;
}
