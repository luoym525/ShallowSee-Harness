import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

const roles = {
  presales: 'presales',
  planning: 'planner',
  coordination: 'project_manager',
  development: 'developer',
  documentation: 'project_manager',
  testing: 'tester',
  support: 'support',
};
const roleSet = new Set(Object.values(roles));
const searchRoles = new Set(['presales', 'planner', 'project_manager']);
const planTasks = new Set(['development', 'documentation', 'testing']);
const candidateTasks = new Set(['documentation', 'testing']);
const backendTypes = new Set(['api', 'cli', 'mcp', 'fake']);
const toolKinds = new Set(['search', 'read_files', 'write_files', 'run_command', 'read_artifacts']);
const evidenceTasks = ['presales', 'planning', 'coordination', 'support'];

export class CoordinatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code;
  }
}

function requireThat(condition, code, message) {
  if (!condition) throw new CoordinatorError(code, message);
}

function text(value, field) {
  requireThat(typeof value === 'string' && value.length > 0 && value === value.trim(), 'INVALID_INPUT', field + ' must be nonempty and trimmed.');
  return value;
}

function strings(value, field) {
  requireThat(Array.isArray(value), 'INVALID_INPUT', field + ' must be an array.');
  return value.map(item => text(item, field));
}

function integer(value, min, max, field) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INPUT', field + ' is out of range.');
  return value;
}

function orderedJson(value) {
  const sort = (key, item) => {
    if (!item || Array.isArray(item) || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  };
  return JSON.stringify(value, sort);
}

function digest(value) {
  return createHash('sha256').update(orderedJson(value)).digest('hex');
}

function profiles(input) {
  requireThat(Array.isArray(input) && input.length === roleSet.size, 'INVALID_PROFILES', 'Configure one profile for each of the six roles.');
  const byRole = new Map();
  const ids = new Set();
  for (const profile of input) {
    const { role, id, model, backend, tools = [] } = profile;
    text(id, 'profile.id');
    requireThat(roleSet.has(role) && !byRole.has(role) && !ids.has(id), 'INVALID_PROFILES', 'Profile roles and IDs must each be unique.');
    requireThat(backendTypes.has(backend), 'INVALID_PROFILES', 'Profile backend must be api, cli, mcp, or fake.');
    const capabilities = [...new Set(strings(tools, 'profile.tools'))];
    requireThat(capabilities.every(tool => toolKinds.has(tool)), 'INVALID_PROFILES', 'Use canonical tool capabilities.');
    byRole.set(role, { id, role, backend, model: text(model, 'profile.model'), tools: capabilities });
    ids.add(id);
  }
  return byRole;
}

function workspacePath(workspace) {
  try {
    const resolved = realpathSync.native(text(workspace, 'workspace'));
    requireThat(statSync(resolved).isDirectory(), 'INVALID_WORKSPACE', 'Development workspace must be a directory.');
    return { path: resolved, key: process.platform === 'win32' ? resolved.toLowerCase() : resolved };
  } catch (error) {
    if (error instanceof CoordinatorError) throw error;
    throw new CoordinatorError('INVALID_WORKSPACE', 'Development workspace must resolve to an existing directory.');
  }
}

function containsWorkspace(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep));
}

function planBody(plan = {}) {
  const acceptanceCriteria = strings(plan.acceptanceCriteria, 'acceptanceCriteria');
  requireThat(acceptanceCriteria.length, 'INVALID_PLAN', 'A plan needs at least one acceptance criterion.');
  return {
    summary: text(plan.summary, 'plan.summary'),
    scope: strings(plan.scope, 'plan.scope'),
    architecture: text(plan.architecture, 'plan.architecture'),
    sources: strings(plan.sources ?? [], 'plan.sources'),
    workItems: strings(plan.workItems, 'plan.workItems'),
    acceptanceCriteria,
  };
}

function planOf(project) {
  return project.plans.at(-1);
}

function stageOf(project) {
  if (project.paused) return 'paused';
  if (project.blocked) return 'blocked';
  const plan = planOf(project);
  if (!plan) return [...project.tasks.values()].some(task => task.kind === 'planning') ? 'planning' : 'discovery';
  if (!plan.confirmation) return 'awaiting_confirmation';
  const candidate = project.candidate;
  if (!candidate || candidate.test?.passed === false) return 'development';
  if (!candidate.guide) return 'documentation';
  if (!candidate.test) return 'testing';
  return candidate.delivered ? 'support' : 'delivery';
}

function disposition(project, kind, task) {
  if (project.paused) return 'PROJECT_PAUSED';
  if (planTasks.has(kind)) {
    if (project.blocked) return 'REWORK_EXHAUSTED';
    const plan = planOf(project);
    if (!plan?.confirmation) return 'PLAN_UNCONFIRMED';
    if (task && task.planVersion !== plan.version) return 'PLAN_SUPERSEDED';
  }
  if (candidateTasks.has(kind)) {
    const candidate = project.candidate;
    if (!candidate) return 'CANDIDATE_REQUIRED';
    if (task && task.candidateVersion !== candidate.version) return 'CANDIDATE_SUPERSEDED';
    if (kind === 'documentation' && candidate.guide) return 'GUIDE_EXISTS';
    if (kind === 'testing' && !candidate.guide) return 'GUIDE_REQUIRED';
    if (kind === 'testing' && candidate.test) return 'TEST_EXISTS';
  }
  if (kind === 'support' && !project.deliveries.length) return 'DELIVERY_REQUIRED';
  return null;
}

function matchesRun(project, task, run, at) {
  return !project.paused && run.executionVersion === project.executionVersion &&
    task.runId === run.id && task.version === run.taskVersion && at < run.leaseUntil;
}

function runDisposition(project, task, run, at) {
  if (!matchesRun(project, task, run, at)) return 'STALE_RUN';
  if (task.kind === 'development' && run.baseCandidateVersion !== (project.candidate?.version ?? null)) {
    return 'CANDIDATE_SUPERSEDED';
  }
  return disposition(project, task.kind, task);
}

function handoff(project, input, from, to, artifacts) {
  const entry = { id: input.commandId, from, to, planVersion: planOf(project).version, candidateVersion: project.candidate?.version ?? null, artifacts };
  project.handoffs.push(entry);
  return entry;
}

export function createCoordinator({ operatorId, operatorAuthority, now = Date.now } = {}) {
  text(operatorId, 'operatorId');
  requireThat(operatorAuthority && ['object', 'symbol'].includes(typeof operatorAuthority), 'INVALID_AUTHORITY', 'Supply an opaque operator authority.');
  requireThat(typeof now === 'function', 'INVALID_INPUT', 'now must be a clock function.');

  const projects = new Map();
  const commands = new Map();

  function clock() {
    return integer(now(), 0, Number.MAX_SAFE_INTEGER - 3_600_000, 'clock');
  }

  function asOperator(authority) {
    requireThat(operatorAuthority === authority, 'OPERATOR_REQUIRED', 'A trusted human operator is required.');
  }

  function projectOf(projectId) {
    const project = projects.get(projectId);
    requireThat(project, 'PROJECT_NOT_FOUND', 'Unknown project.');
    return project;
  }

  function taskOf(project, taskId) {
    const task = project.tasks.get(taskId);
    requireThat(task, 'TASK_NOT_FOUND', 'Unknown task.');
    return task;
  }

  function apply(action, input, update) {
    const id = text(input.commandId, 'commandId');
    const fingerprint = digest({ action, input });
    const prior = commands.get(id);
    if (prior) {
      requireThat(fingerprint === prior.fingerprint, 'COMMAND_CONFLICT', 'Command ID already used with different input.');
      return structuredClone(prior.result);
    }
    const result = structuredClone(update());
    commands.set(id, { fingerprint, result });
    return structuredClone(result);
  }

  function runContext(input) {
    const project = projectOf(input.projectId);
    const task = taskOf(project, input.taskId);
    const run = project.runs.get(input.runId);
    requireThat(run && run.taskId === task.id && run.agentId === input.agentId &&
      run.taskVersion === input.taskVersion && run.executionVersion === input.executionVersion,
    'RUN_FENCE_MISMATCH', 'Run, agent and both version fences must match the original claim.');
    return { project, task, run };
  }

  function hasWriter(key) {
    for (const project of projects.values()) {
      for (const run of project.runs.values()) {
        if (run.workspaceKey && !run.end &&
            (containsWorkspace(key, run.workspaceKey) || containsWorkspace(run.workspaceKey, key))) return true;
      }
    }
    return false;
  }

  function outcome(action, inputs, kinds, value, commit) {
    return apply(action, inputs, () => {
      const { project, task, run } = runContext(inputs);
      requireThat(kinds.includes(task.kind), 'WRONG_TASK_KIND', 'Run cannot submit this kind of outcome.');
      const at = clock();
      const reason = runDisposition(project, task, run, at);
      if (reason) {
        const result = { applied: false, reason, runId: run.id };
        project.history.push({ ...result, commandId: inputs.commandId, action, value, at });
        return result;
      }
      requireThat(task.status === 'claimed', 'TASK_SETTLED', 'Task already has a recorded outcome.');
      requireThat(run.end?.outcome === 'completed', 'RUN_NOT_COMPLETED', 'A successfully ended execution is required before recording its outcome.');
      const result = commit(project, task, value);
      task.status = 'done';
      return { applied: true, ...result };
    });
  }

  return {
    createProject(input) {
      return apply('createProject', input, () => {
        const id = text(input.projectId, 'projectId');
        requireThat(!projects.has(id), 'PROJECT_EXISTS', 'Project already exists.');
        const project = {
          id, goal: text(input.goal, 'goal'), constraints: strings(input.constraints ?? [], 'constraints'),
          profiles: profiles(input.profiles), maxRework: integer(input.maxRework ?? 1, 0, 20, 'maxRework'),
          plans: [], tasks: new Map(), runs: new Map(), candidates: [], candidate: null,
          deliveries: [], handoffs: [], history: [], executionVersion: 1, failedTests: 0, paused: false, blocked: false,
        };
        projects.set(id, project);
        return { projectId: id, executionVersion: project.executionVersion };
      });
    },

    definePlan(input) {
      return apply('definePlan', input, () => {
        const project = projectOf(input.projectId);
        requireThat(!project.paused, 'PROJECT_PAUSED', 'Resume the project before defining a plan.');
        const body = planBody(input.plan);
        const version = project.plans.length + 1;
        const plan = { ...body, version, digest: digest({ projectId: project.id, version, body }), confirmation: null };
        project.plans.push(plan);
        project.executionVersion++;
        project.candidate = null;
        project.failedTests = 0;
        project.blocked = false;
        return plan;
      });
    },

    confirmPlan(input, authority) {
      asOperator(authority);
      return apply('confirmPlan', input, () => {
        const project = projectOf(input.projectId);
        const plan = planOf(project);
        requireThat(!project.paused, 'PROJECT_PAUSED', 'Resume the project before confirming a plan.');
        requireThat(plan && input.planVersion === plan.version && input.planDigest === plan.digest, 'PLAN_MISMATCH', 'Confirm the current exact plan version and digest.');
        requireThat(!plan.confirmation, 'PLAN_CONFIRMED', 'This version already has a confirmation.');
        plan.confirmation = { operatorId, ref: text(input.confirmationRef, 'confirmationRef'), at: clock() };
        handoff(project, input, 'project_manager', 'developer', [plan.digest, plan.confirmation.ref]);
        return plan;
      });
    },

    dispatch({ projectId, kind }) {
      const project = projectOf(projectId);
      requireThat(typeof kind === 'string' && Object.hasOwn(roles, kind), 'INVALID_TASK_KIND', 'Unknown dispatch kind.');
      const role = roles[kind];
      const reason = disposition(project, kind);
      return { role, agentId: project.profiles.get(role).id, permitted: !reason, reason };
    },

    createTask(input) {
      return apply('createTask', input, () => {
        const project = projectOf(input.projectId);
        requireThat(!project.paused, 'PROJECT_PAUSED', 'Resume the project before creating a task.');
        const id = text(input.taskId, 'taskId');
        requireThat(!project.tasks.has(id), 'TASK_EXISTS', 'Task already exists.');
        const { kind } = input;
        requireThat(typeof kind === 'string' && Object.hasOwn(roles, kind), 'INVALID_TASK_KIND', 'Unknown task kind.');
        const planVersion = planTasks.has(kind) ? planOf(project)?.version : null;
        requireThat(!planTasks.has(kind) || planVersion, 'PLAN_REQUIRED', 'Define a plan before creating production tasks.');
        const candidateVersion = candidateTasks.has(kind) ? project.candidate?.version : null;
        requireThat(!candidateTasks.has(kind) || candidateVersion, 'CANDIDATE_REQUIRED', 'A current candidate is required.');
        const guideVersion = kind === 'testing' ? project.candidate.guide?.version : null;
        requireThat(kind !== 'testing' || guideVersion, 'GUIDE_REQUIRED', 'A current usage guide is required.');
        const delivery = kind === 'support' ? project.deliveries.find(item => item.id === input.deliveryId) : null;
        requireThat(kind !== 'support' || delivery, 'DELIVERY_REQUIRED', 'Support must target a delivered candidate.');
        const dependencies = [...new Set(strings(input.dependencies ?? [], 'dependencies'))];
        for (const dependency of dependencies) taskOf(project, dependency);
        const task = {
          id, kind, role: roles[kind], title: text(input.title, 'title'), dependencies,
          planVersion, candidateVersion, guideVersion, deliveryId: delivery?.id ?? null,
          workspace: kind === 'development' ? workspacePath(input.workspace) : null,
          status: 'pending', version: 1, runId: null,
        };
        project.tasks.set(id, task);
        return task;
      });
    },

    claimTask(input) {
      return apply('claimTask', input, () => {
        const project = projectOf(input.projectId);
        const task = taskOf(project, input.taskId);
        const at = clock();
        const reason = disposition(project, task.kind, task);
        requireThat(!reason, reason, 'Task is unavailable in the current project state.');
        requireThat(task.version === input.expectedTaskVersion, 'TASK_VERSION_MISMATCH', 'Claim must match the current task version.');
        const agent = project.profiles.get(task.role);
        requireThat(agent.id === input.agentId, 'AGENT_ROLE_MISMATCH', 'Only the assigned role profile can claim this task.');
        requireThat(task.status !== 'done', 'TASK_SETTLED', 'Task already has a recorded outcome.');
        const previous = project.runs.get(task.runId);
        requireThat(!previous || runDisposition(project, task, previous, at) || previous.end?.outcome === 'failed' || previous.end?.outcome === 'cancelled',
          'TASK_ALREADY_CLAIMED', 'A current claim still owns the task.');
        requireThat(task.dependencies.every(id => taskOf(project, id).status === 'done'), 'DEPENDENCIES_PENDING', 'Complete all dependency tasks before claiming this task.');
        requireThat(!task.workspace || !hasWriter(task.workspace.key), 'WORKSPACE_BUSY', 'An earlier writer has yet to confirm it stopped.');
        const leaseMs = integer(input.leaseMs, 1, 3_600_000, 'leaseMs');
        const run = {
          id: input.commandId, projectId: project.id, taskId: task.id, agentId: agent.id,
          taskVersion: task.version + 1, executionVersion: project.executionVersion, leaseUntil: at + leaseMs,
          baseCandidateVersion: task.kind === 'development' ? project.candidate?.version ?? null : null,
          planVersion: task.planVersion, candidateVersion: task.candidateVersion,
          candidateContentRef: task.candidateVersion ? project.candidate.contentRef : null,
          guideVersion: task.guideVersion, deliveryId: task.deliveryId,
          workspace: task.workspace?.path ?? null, workspaceKey: task.workspace?.key ?? null, end: null,
        };
        project.runs.set(run.id, run);
        Object.assign(task, { runId: run.id, version: run.taskVersion, status: 'claimed' });
        return run;
      });
    },

    authorizeTool(input) {
      const { project, task, run } = runContext(input);
      const role = task.role;
      const tool = text(input.tool, 'tool');
      requireThat(toolKinds.has(tool), 'TOOL_DENIED', 'Tool capability is unknown.');
      requireThat(!run.end && task.status === 'claimed', 'STALE_RUN', 'Only the active execution may use tools.');
      const reason = runDisposition(project, task, run, clock());
      requireThat(!reason, reason, 'The task is unavailable in the current project state.');
      requireThat(tool !== 'search' || searchRoles.has(role), 'SEARCH_DENIED', 'This role cannot use search.');
      requireThat(tool !== 'write_files' || (role === 'developer' && run.workspace),
        'WORKSPACE_WRITE_DENIED', 'Source writes require a development workspace claim.');
      requireThat(project.profiles.get(role).tools.includes(tool), 'TOOL_DENIED', 'Tool is outside the role profile permissions.');
      return { permitted: true };
    },

    completeTask(input) {
      return outcome('completeTask', input, evidenceTasks,
        { evidenceRef: text(input.evidenceRef, 'evidenceRef') }, (project, task, value) => {
          task.evidence = value;
          return value;
        });
    },

    submitCandidate(input) {
      const contentRef = text(input.contentRef, 'contentRef');
      requireThat(/^(git:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(contentRef), 'INVALID_CONTENT_REF', 'Use a full git commit or SHA-256 content hash.');
      return outcome('submitCandidate', input, ['development'], { contentRef },
        (project, task, value) => {
          const candidate = {
            ...value, version: project.candidates.length + 1, planVersion: task.planVersion,
            taskId: task.id, runId: task.runId, guide: null, test: null, delivered: false,
          };
          project.candidates.push(candidate);
          project.candidate = candidate;
          handoff(project, input, 'developer', 'project_manager', [contentRef]);
          return { candidate };
        });
    },

    recordGuide(input) {
      const guide = { version: text(input.guideVersion, 'guideVersion'), ref: text(input.guideRef, 'guideRef') };
      return outcome('recordGuide', input, ['documentation'], guide,
        (project, task, value) => {
          requireThat(input.candidateVersion === task.candidateVersion && input.contentRef === project.candidate.contentRef,
            'CANDIDATE_MISMATCH', 'The usage guide must target the version and content from the claim.');
          project.candidate.guide = value;
          handoff(project, input, 'project_manager', 'tester', [project.candidate.contentRef, value.ref]);
          return { candidateVersion: task.candidateVersion, guide: value };
        });
    },

    recordTestResult(input) {
      requireThat(typeof input.passed === 'boolean', 'INVALID_INPUT', 'passed must be a Boolean.');
      const reportRef = text(input.reportRef, 'reportRef');
      return outcome('recordTestResult', input, ['testing'], { passed: input.passed, reportRef },
        (project, task, value) => {
          const candidate = project.candidate;
          requireThat(input.candidateVersion === task.candidateVersion && input.contentRef === candidate.contentRef && input.guideVersion === task.guideVersion,
            'CANDIDATE_MISMATCH', 'The test report must target the claimed candidate, content and usage guide.');
          const test = { ...value, candidateVersion: candidate.version, contentRef: candidate.contentRef, guideVersion: task.guideVersion, taskId: task.id, runId: task.runId };
          candidate.test = test;
          if (!test.passed) {
            project.failedTests++;
            project.blocked = project.failedTests > project.maxRework;
          }
          handoff(project, input, 'tester', test.passed || project.blocked ? 'project_manager' : 'developer', [test.reportRef]);
          return { test, blocked: project.blocked };
        });
    },

    acceptDelivery(input, authority) {
      asOperator(authority);
      return apply('acceptDelivery', input, () => {
        const project = projectOf(input.projectId);
        const candidate = project.candidate;
        requireThat(!project.paused, 'PROJECT_PAUSED', 'Resume the project before accepting delivery.');
        requireThat(candidate && input.candidateVersion === candidate.version && input.contentRef === candidate.contentRef &&
          input.guideVersion === candidate.guide?.version && candidate.guide,
        'CANDIDATE_MISMATCH', 'Acceptance must refer to the current candidate and guide.');
        requireThat(candidate.test?.passed === true && candidate.test.reportRef === input.reportRef &&
          candidate.test.candidateVersion === candidate.version && candidate.test.guideVersion === candidate.guide.version,
        'TEST_NOT_PASSED', 'An independent passing report for this exact candidate and guide is required.');
        requireThat(!candidate.delivered, 'ALREADY_DELIVERED', 'Candidate already accepted.');
        const delivery = {
          id: input.commandId, planVersion: candidate.planVersion, candidateVersion: candidate.version, contentRef: candidate.contentRef,
          guide: candidate.guide, test: candidate.test, operatorId, confirmationRef: text(input.confirmationRef, 'confirmationRef'), at: clock(),
        };
        candidate.delivered = true;
        project.deliveries.push(delivery);
        handoff(project, input, 'project_manager', 'support', [candidate.contentRef, candidate.guide.ref, candidate.test.reportRef]);
        return delivery;
      });
    },

    recordRunEnd(input) {
      return apply('recordRunEnd', input, () => {
        const { project, task, run } = runContext(input);
        requireThat(!run.end, 'RUN_ENDED', 'Execution has already ended.');
        requireThat(['completed', 'failed', 'cancelled'].includes(input.outcome), 'INVALID_INPUT', 'Invalid run outcome.');
        const at = clock();
        run.end = { outcome: input.outcome, at };
        const current = !runDisposition(project, task, run, at);
        project.history.push({ action: 'recordRunEnd', commandId: input.commandId, runId: run.id, current, ...run.end });
        return { runId: run.id, current, end: run.end };
      });
    },

    pause(input, authority) {
      asOperator(authority);
      return apply('pause', input, () => {
        const project = projectOf(input.projectId);
        requireThat(!project.paused, 'PROJECT_PAUSED', 'Project is already paused.');
        project.paused = true;
        return { stage: 'paused', executionVersion: ++project.executionVersion };
      });
    },

    resume(input, authority) {
      asOperator(authority);
      return apply('resume', input, () => {
        const project = projectOf(input.projectId);
        requireThat(project.paused, 'PROJECT_ACTIVE', 'Project is already active.');
        project.paused = false;
        return { stage: stageOf(project), executionVersion: project.executionVersion };
      });
    },

    getProject(projectId) {
      const project = projectOf(projectId);
      return structuredClone({
        ...project, profiles: [...project.profiles.values()], tasks: [...project.tasks.values()], runs: [...project.runs.values()], stage: stageOf(project),
      });
    },
  };
}
