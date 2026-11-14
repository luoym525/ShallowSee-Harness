import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const owners = new WeakSet();
const issuedErrors = new WeakSet();
const backends = new Set(['api', 'cli', 'mcp', 'fake']);
const capabilities = new Set(['search', 'read_files', 'write_files', 'run_command', 'read_artifacts']);
const coreDenials = new Set(['SEARCH_DENIED', 'TOOL_DENIED', 'WORKSPACE_WRITE_DENIED', 'STALE_RUN', 'CANDIDATE_SUPERSEDED']);
const messages = Object.freeze({
  INVALID_CONFIG: 'The runtime configuration is invalid.',
  COORDINATOR_IN_USE: 'This coordinator already has an execution runtime.',
  INVALID_START: 'The start request contains invalid fields.',
  START_CONFLICT: 'The start command ID already has different inputs.',
  TASK_NOT_FOUND: 'The selected task or role profile is unavailable.',
  ADAPTER_NOT_FOUND: 'The requested adapter is unavailable.',
  ADAPTER_PROFILE_MISMATCH: 'The adapter does not match the configured role model and backend.',
  ADAPTER_UNMEDIATED: 'The adapter cannot run with this tool broker.',
  ADAPTER_FAILED: 'The adapter execution failed.',
  ADAPTER_RESULT_INVALID: 'The adapter returned an invalid result.',
  OUTPUT_LIMIT: 'The adapter output exceeded its byte limit.',
  TOOL_REQUEST_INVALID: 'The tool request contains invalid fields.',
  TOOL_ARGS_INVALID: 'Tool arguments must be finite JSON.',
  TOOL_ARGS_LIMIT: 'The tool arguments exceeded their byte limit.',
  TOOL_RESULT_INVALID: 'The tool returned invalid JSON.',
  TOOL_RESULT_LIMIT: 'The tool result exceeded its byte limit.',
  TOOL_CALL_CONFLICT: 'The tool call ID already has different inputs.',
  TOOL_CALL_LIMIT: 'The run reached its tool call limit.',
  UNKNOWN_TOOL: 'The requested tool is unavailable.',
  TOOL_NOT_AUTHORIZED: 'This execution is no longer authorized for the tool.',
  SEARCH_DENIED: 'This role cannot use search.',
  TOOL_DENIED: 'The configured role does not permit this tool.',
  WORKSPACE_WRITE_DENIED: 'Source writes require a development workspace claim.',
  STALE_RUN: 'The execution claim is no longer current.',
  CANDIDATE_SUPERSEDED: 'The execution candidate is no longer current.',
  TOOL_FAILED: 'The tool execution failed.',
  TOOL_CHANNEL_CLOSED: 'The tool channel is closed.',
  TOOL_TIMEOUT: 'A tool exceeded its execution deadline.',
  RUN_TIMEOUT: 'The run exceeded its execution deadline.',
  RUN_CANCELLED: 'The run was cancelled.',
  RUN_END_COMMIT_FAILED: 'The coordinator could not record the confirmed execution end.',
});

export class RuntimeError extends Error {
  constructor(code) {
    const recognized = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'ADAPTER_FAILED';
    super(messages[recognized]);
    this.name = 'RuntimeError';
    this.code = recognized;
  }
}

function runtimeError(code) {
  const error = new RuntimeError(code);
  issuedErrors.add(error);
  return Object.freeze(error);
}

function requireThat(condition, code) {
  if (!condition) throw runtimeError(code);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fields(value, required, optional, code) {
  requireThat(plainObject(value), code);
  const keys = Reflect.ownKeys(value);
  requireThat(required.every(key => Object.hasOwn(value, key)) && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (required.includes(key) || optional.includes(key)) && descriptor.enumerable && 'value' in descriptor;
  }), code);
}

function identifier(value, code) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 160 && value === value.trim(), code);
  return value;
}

function integer(value, min, max, code) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, code);
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function jsonSnapshot(value, maxBytes, invalidCode, limitCode) {
  const chunks = [];
  const ancestors = new Set();
  let bytes = 0;

  function write(text) {
    bytes += Buffer.byteLength(text);
    requireThat(bytes <= maxBytes, limitCode);
    chunks.push(text);
  }

  function quoted(text) {
    requireThat(text.length <= maxBytes - bytes, limitCode);
    write(JSON.stringify(text));
  }

  function visit(node, depth) {
    requireThat(depth <= 64, invalidCode);
    if (typeof node === 'string') return quoted(node);
    if (node === null || typeof node === 'boolean' || Number.isFinite(node)) return write(JSON.stringify(node));
    requireThat((plainObject(node) || Array.isArray(node)) && !ancestors.has(node), invalidCode);
    ancestors.add(node);
    const isArray = Array.isArray(node);
    const keys = Reflect.ownKeys(node);
    requireThat(keys.length <= maxBytes - bytes + (isArray ? 1 : 0), limitCode);
    if (isArray) {
      requireThat(keys.length === node.length + 1, invalidCode);
    } else {
      requireThat(keys.every(key => typeof key === 'string'), invalidCode);
      keys.sort();
    }

    write(isArray ? '[' : '{');
    const length = isArray ? node.length : keys.length;
    for (let index = 0; index < length; index++) {
      const key = isArray ? String(index) : keys[index];
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      requireThat(descriptor?.enumerable && 'value' in descriptor, invalidCode);
      if (index) write(',');
      if (!isArray) {
        quoted(key);
        write(':');
      }
      visit(descriptor.value, depth + 1);
    }
    write(isArray ? ']' : '}');
    ancestors.delete(node);
  }

  visit(value, 0);
  const encoded = chunks.join('');
  return { encoded, value: deepFreeze(JSON.parse(encoded)) };
}

function register(entries, key, normalize) {
  requireThat(Array.isArray(entries), 'INVALID_CONFIG');
  const registry = new Map();
  for (const entry of entries) {
    requireThat(plainObject(entry), 'INVALID_CONFIG');
    const id = identifier(entry[key], 'INVALID_CONFIG');
    requireThat(!registry.has(id), 'INVALID_CONFIG');
    registry.set(id, Object.freeze(normalize(entry)));
  }
  return registry;
}

function readLimits(input) {
  const defaults = {
    maxRunMs: 60_000,
    maxToolMs: 15_000,
    maxToolCalls: 32,
    maxToolArgsBytes: 16_384,
    maxToolResultBytes: 65_536,
    maxOutputBytes: 65_536,
  };
  fields(input, [], Object.keys(defaults), 'INVALID_CONFIG');
  const limits = { ...defaults, ...input };
  integer(limits.maxRunMs, 1, 3_600_000, 'INVALID_CONFIG');
  integer(limits.maxToolMs, 1, 3_600_000, 'INVALID_CONFIG');
  integer(limits.maxToolCalls, 0, 1_000, 'INVALID_CONFIG');
  for (const field of ['maxToolArgsBytes', 'maxToolResultBytes', 'maxOutputBytes']) {
    integer(limits[field], 1, 1_048_576, 'INVALID_CONFIG');
  }
  return limits;
}

function usageSnapshot(input) {
  const source = input?.source;
  const known = source === 'provider' || source === 'estimated';
  const tokens = value => known && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const inputTokens = tokens(input?.inputTokens);
  const outputTokens = tokens(input?.outputTokens);
  const costUsd = known && Number.isFinite(input?.costUsd) && input.costUsd >= 0 ? input.costUsd : null;
  return { source: inputTokens === null && outputTokens === null && costUsd === null ? 'unknown' : source,
    inputTokens, outputTokens, costUsd };
}

function executionContext(project, task, profile, run) {
  const plan = task.planVersion === null ? project.plans.at(-1) : project.plans.find(item => item.version === task.planVersion);
  const candidateVersion = run.candidateVersion ?? run.baseCandidateVersion;
  const candidate = project.candidates.find(item => item.version === candidateVersion);
  const delivery = project.deliveries.find(item => item.id === run.deliveryId);
  return deepFreeze({
    project: { id: project.id, goal: project.goal, constraints: project.constraints, stage: project.stage },
    plan: plan ? {
      version: plan.version, digest: plan.digest, summary: plan.summary, scope: plan.scope, architecture: plan.architecture,
      sources: plan.sources, workItems: plan.workItems, acceptanceCriteria: plan.acceptanceCriteria, confirmed: Boolean(plan.confirmation),
    } : null,
    task: { id: task.id, title: task.title, kind: task.kind, dependencies: task.dependencies, workspace: run.workspace },
    profile: { ...profile },
    candidate: candidate ?? null,
    delivery: delivery ?? null,
  });
}

function handled(promise) {
  promise.catch(() => {});
  return promise;
}

function executeClaim({ coordinator, adapter, registry, limits, claim, context, deadline }) {
  const controller = new AbortController();
  const { signal } = controller;
  const calls = new Map();
  const pending = new Set();
  const waiting = new Set();
  let accepting = true;
  let closedWith = null;

  const identity = {
    projectId: claim.projectId, taskId: claim.taskId, runId: claim.id,
    agentId: claim.agentId, taskVersion: claim.taskVersion, executionVersion: claim.executionVersion,
  };

  function stop(code) {
    if (closedWith) return false;
    closedWith = code;
    accepting = false;
    for (const reject of waiting) reject(runtimeError(code));
    controller.abort();
    return true;
  }

  function checkDeadline() {
    if (performance.now() >= deadline) stop('RUN_TIMEOUT');
  }

  function checkToolChannel() {
    checkDeadline();
    requireThat(accepting, closedWith ?? 'TOOL_CHANNEL_CLOSED');
  }

  function authorizeTool(tool) {
    requireThat(tool, 'UNKNOWN_TOOL');
    try {
      const grant = coordinator.authorizeTool({ ...identity, tool: tool.capability });
      requireThat(grant?.permitted === true, 'TOOL_NOT_AUTHORIZED');
    } catch (error) {
      throw runtimeError(coreDenials.has(error?.code) ? error.code : 'TOOL_NOT_AUTHORIZED');
    }
  }

  function checkLaunch() {
    const project = coordinator.getProject(claim.projectId);
    const task = project.tasks.find(item => item.id === claim.taskId);
    const active = project.runs.find(item => item.id === claim.id);
    requireThat(!project.paused && project.executionVersion === claim.executionVersion &&
      task?.runId === claim.id && task.version === claim.taskVersion && active && !active.end, 'STALE_RUN');
    const candidateVersion = project.candidate?.version ?? null;
    const expected = context.task.kind === 'development' ? claim.baseCandidateVersion : claim.candidateVersion;
    requireThat((context.task.kind !== 'development' && expected === null) || expected === candidateVersion, 'CANDIDATE_SUPERSEDED');
  }

  function invokeTool(tool, args) {
    const toolDeadline = performance.now() + limits.maxToolMs;
    const timer = setTimeout(() => stop('TOOL_TIMEOUT'), limits.maxToolMs);

    function checkToolDeadline() {
      checkDeadline();
      if (performance.now() >= toolDeadline) stop('TOOL_TIMEOUT');
      requireThat(!closedWith, closedWith);
    }

    const actual = Promise.resolve().then(async () => {
      checkToolChannel();
      checkToolDeadline();
      authorizeTool(tool);

      let result;
      try {
        result = await tool.handler(args, { signal, context });
      } catch {
        throw runtimeError('TOOL_FAILED');
      }
      checkToolDeadline();
      try {
        return jsonSnapshot(result, limits.maxToolResultBytes, 'TOOL_RESULT_INVALID', 'TOOL_RESULT_LIMIT').value;
      } catch (error) {
        const failure = issuedErrors.has(error) ? error : runtimeError('TOOL_RESULT_INVALID');
        if (failure.code === 'TOOL_RESULT_LIMIT') stop(failure.code);
        throw failure;
      }
    });

    let rejectWaiting;
    const visible = new Promise((resolve, reject) => {
      rejectWaiting = reject;
      waiting.add(reject);
      actual.then(resolve, reject);
    });
    function clean() {
      clearTimeout(timer);
      waiting.delete(rejectWaiting);
      pending.delete(settled);
    }
    const settled = actual.then(clean, clean);
    pending.add(settled);
    return handled(visible);
  }

  function callTool(input) {
    try {
      checkToolChannel();
      fields(input, ['callId', 'name', 'args'], [], 'TOOL_REQUEST_INVALID');
      const callId = identifier(input.callId, 'TOOL_REQUEST_INVALID');
      const name = identifier(input.name, 'TOOL_REQUEST_INVALID');
      const args = jsonSnapshot(input.args, limits.maxToolArgsBytes, 'TOOL_ARGS_INVALID', 'TOOL_ARGS_LIMIT');
      const fingerprint = JSON.stringify([name, args.encoded]);
      const tool = registry.get(name);
      const previous = calls.get(callId);
      if (previous) {
        requireThat(previous.fingerprint === fingerprint, 'TOOL_CALL_CONFLICT');
        if (tool) authorizeTool(tool);
        return previous.result;
      }
      requireThat(calls.size < limits.maxToolCalls, 'TOOL_CALL_LIMIT');
      const result = invokeTool(tool, args.value);
      calls.set(callId, { fingerprint, result });
      return result;
    } catch (error) {
      return handled(Promise.reject(issuedErrors.has(error) ? error : runtimeError('TOOL_REQUEST_INVALID')));
    }
  }

  let settled = false;
  const timer = setTimeout(() => stop('RUN_TIMEOUT'), Math.max(0, Math.ceil(deadline - performance.now())));
  const done = Promise.resolve().then(async () => {
    let output = null;
    let usage = usageSnapshot();
    try {
      checkToolChannel();
      checkLaunch();
      checkToolChannel();
      const result = await adapter.execute(Object.freeze({ context, signal, callTool }));
      checkDeadline();
      fields(result, ['output'], ['usage'], 'ADAPTER_RESULT_INVALID');
      usage = usageSnapshot(result.usage);
      output = jsonSnapshot(result.output, limits.maxOutputBytes, 'ADAPTER_RESULT_INVALID', 'OUTPUT_LIMIT').value;
    } catch (error) {
      stop(issuedErrors.has(error) ? error.code : 'ADAPTER_FAILED');
    } finally {
      accepting = false;
      await Promise.all(pending);
      checkDeadline();
      clearTimeout(timer);
      settled = true;
    }

    const outcome = closedWith === 'RUN_CANCELLED' ? 'cancelled' : closedWith ? 'failed' : 'completed';
    let current = false;
    try {
      const record = coordinator.recordRunEnd({ ...identity, commandId: claim.id + ':end', outcome });
      current = record.current;
    } catch {
      return deepFreeze({
        runId: claim.id, outcome: 'failed', current: false, output: null, usage,
        error: { code: 'RUN_END_COMMIT_FAILED', message: messages.RUN_END_COMMIT_FAILED },
      });
    }
    return deepFreeze({
      runId: claim.id, outcome, current, output: outcome === 'completed' ? output : null, usage,
      error: closedWith ? { code: closedWith, message: messages[closedWith] } : null,
    });
  });
  return Object.freeze({ done, cancel: () => !settled && stop('RUN_CANCELLED') });
}

export function createRuntime({ coordinator, adapters = [], tools = [], limits = {} } = {}) {
  requireThat(coordinator && ['getProject', 'claimTask', 'authorizeTool', 'recordRunEnd'].every(key => typeof coordinator[key] === 'function'),
    'INVALID_CONFIG');
  requireThat(!owners.has(coordinator), 'COORDINATOR_IN_USE');
  const settings = readLimits(limits);
  const adapterRegistry = register(adapters, 'id', entry => {
    const { backend, model, allToolsMediated, execute } = entry;
    requireThat(backends.has(backend) && typeof allToolsMediated === 'boolean' && typeof execute === 'function', 'INVALID_CONFIG');
    return { backend, model: identifier(model, 'INVALID_CONFIG'), allToolsMediated, execute };
  });
  const toolRegistry = register(tools, 'name', entry => {
    const { capability, handler } = entry;
    requireThat(capabilities.has(capability) && typeof handler === 'function', 'INVALID_CONFIG');
    return { capability, handler };
  });
  owners.add(coordinator);
  const starts = new Map();

  return Object.freeze({
    start(input) {
      const names = ['commandId', 'projectId', 'taskId', 'expectedTaskVersion', 'adapterId', 'leaseMs'];
      fields(input, names, [], 'INVALID_START');
      for (const key of ['commandId', 'projectId', 'taskId', 'adapterId']) identifier(input[key], 'INVALID_START');
      integer(input.expectedTaskVersion, 1, Number.MAX_SAFE_INTEGER, 'INVALID_START');
      integer(input.leaseMs, 1, 3_600_000, 'INVALID_START');
      const fingerprint = JSON.stringify(names.map(name => input[name]));
      const previous = starts.get(input.commandId);
      if (previous) {
        requireThat(previous.fingerprint === fingerprint, 'START_CONFLICT');
        return previous.handle;
      }

      const adapter = adapterRegistry.get(input.adapterId);
      requireThat(adapter, 'ADAPTER_NOT_FOUND');
      requireThat(adapter.allToolsMediated, 'ADAPTER_UNMEDIATED');
      const project = coordinator.getProject(input.projectId);
      const task = project.tasks.find(item => item.id === input.taskId);
      const profile = task && project.profiles.find(item => item.role === task.role);
      requireThat(profile, 'TASK_NOT_FOUND');
      requireThat(profile.backend === adapter.backend && profile.model === adapter.model, 'ADAPTER_PROFILE_MISMATCH');
      const deadline = performance.now() + Math.min(input.leaseMs, settings.maxRunMs);
      const claim = coordinator.claimTask({
        commandId: 'runtime:' + randomUUID(), projectId: input.projectId, taskId: input.taskId,
        agentId: profile.id, expectedTaskVersion: input.expectedTaskVersion, leaseMs: input.leaseMs,
      });
      const context = executionContext(project, task, profile, claim);
      const handle = executeClaim({ coordinator, adapter, registry: toolRegistry, limits: settings, claim, context, deadline });
      starts.set(input.commandId, { fingerprint, handle });
      return handle;
    },
  });
}
