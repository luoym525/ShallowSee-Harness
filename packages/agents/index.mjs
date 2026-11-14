// A bounded bridge to the neutral ModelClient contract; it grants no tool authority.
export class AdapterError extends Error {
  constructor(code) { super(code); this.name = 'AdapterError'; this.code = code; }
}
const fail = code => { throw new AdapterError(code); };
const defaults = { maxTurns: 8, maxToolCalls: 24, maxJsonBytes: 65536, maxHistoryBytes: 262144, maxOutputBytes: 65536, maxTokens: 16000, timeoutMs: 120000 };
const bytes = s => Buffer.byteLength(s, 'utf8');
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;

// Reject custom serialization, accessors, non-JSON values, cycles and sparse arrays.
function json(value, limit) {
  const seen = new Set();
  function check(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || seen.has(v)) fail('INVALID_JSON');
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) fail('INVALID_JSON');
    seen.add(v);
    const keys = Reflect.ownKeys(v);
    if (keys.some(k => typeof k !== 'string')) fail('INVALID_JSON');
    for (const key of keys) {
      if (Array.isArray(v) && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !('value' in d) || !d.enumerable) fail('INVALID_JSON');
      check(d.value);
    }
    if (Array.isArray(v) && (keys.length !== v.length + 1 || Object.keys(v).some((k, i) => k !== String(i)))) fail('INVALID_JSON');
    seen.delete(v);
  }
  check(value);
  const result = JSON.stringify(value);
  if (bytes(result) > limit) fail('SIZE_LIMIT');
  return result;
}
function cancelled(signal) { if (signal?.aborted) fail('CANCELLED'); }
function usageAdd(total, usage) {
  const known = usage && ['provider', 'estimated'].includes(usage.source);
  const token = v => Number.isSafeInteger(v) && v >= 0;
  const cost = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const add = (old, value, valid) => old === null || !known || !valid(value) || !valid(old + value) ? null : old + value;
  return { source: !known || total.source === 'unknown' ? 'unknown' : usage.source === 'estimated' || total.source === 'estimated' ? 'estimated' : 'provider', inputTokens: add(total.inputTokens, usage?.inputTokens, token), outputTokens: add(total.outputTokens, usage?.outputTokens, token), costUsd: add(total.costUsd, usage?.costUsd, cost) };
}
export function createAgentAdapter({ id, backend, model, client, system = '', tools = [], limits = {} }) {
  if (typeof id !== 'string' || !id || typeof backend !== 'string' || !backend || typeof model !== 'string' || !/^[^/]+\/.+/.test(model) || typeof client?.complete !== 'function' || typeof system !== 'string' || !Array.isArray(tools)) fail('INVALID_CONFIG');
  const cap = { ...defaults };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(defaults, key) || !Number.isSafeInteger(value) || value < 1 || value > defaults[key]) fail('INVALID_CONFIG');
    cap[key] = value;
  }
  const configuredTools = JSON.parse(json(tools, cap.maxJsonBytes));
  const names = new Set();
  for (const t of configuredTools) {
    if (!t || typeof t.name !== 'string' || !t.name || typeof t.description !== 'string' || !t.inputSchema || typeof t.inputSchema !== 'object' || Array.isArray(t.inputSchema) || names.has(t.name)) fail('INVALID_CONFIG');
    names.add(t.name);
  }
  if (bytes(system) > cap.maxJsonBytes) fail('SIZE_LIMIT');
  return Object.freeze({ id, backend, model, allToolsMediated: true, async execute({ context, signal, callTool }) {
    cancelled(signal);
    if (!context || context.profile?.backend !== backend || context.profile?.model !== model || typeof callTool !== 'function') fail('PROFILE_MISMATCH');
    // Explicit allowlist avoids leaking profile identity and runtime IDs.
    const { project, task, plan, candidate, delivery } = context;
    const payload = { project: { goal: project?.goal, constraints: project?.constraints, stage: project?.stage }, task: { title: task?.title, kind: task?.kind, dependencies: task?.dependencies, workspace: task?.workspace }, plan: plan ?? null, candidate: candidate ?? null, delivery: delivery ?? null };
    // Optional missing fields are represented as null rather than undefined.
    for (const obj of [payload.project, payload.task]) for (const key of Object.keys(obj)) if (obj[key] === undefined) obj[key] = null;
    const messages = [{ role: 'user', content: json(payload, cap.maxJsonBytes) }];
    const used = new Map(); let count = 0;
    let usage = { source: 'provider', inputTokens: 0, outputTokens: 0, costUsd: 0 };
    for (let turn = 0; turn < cap.maxTurns; turn++) {
      cancelled(signal);
      json(messages, cap.maxHistoryBytes);
      let result;
      try { result = await client.complete({ model, system, messages: structuredClone(messages), tools: structuredClone(configuredTools), maxTokens: cap.maxTokens, timeoutMs: cap.timeoutMs, signal }); }
      catch { cancelled(signal); fail('PROVIDER_FAILED'); }
      cancelled(signal);
      if (!result || !Array.isArray(result.toolCalls) || typeof result.text !== 'string') fail('INVALID_RESPONSE');
      if (result.model !== model) fail('MODEL_MISMATCH');
      usage = usageAdd(usage, result.usage);
      json(result.toolCalls, cap.maxJsonBytes);
      if (result.stopReason === 'end' && result.toolCalls.length === 0) {
        if (bytes(result.text) > cap.maxOutputBytes) fail('SIZE_LIMIT');
        return { output: result.text, usage };
      }
      if (result.stopReason !== 'tool_use' || result.toolCalls.length === 0) fail('INCOMPLETE_RESPONSE');
      if (!result.assistantMessage || result.assistantMessage.role !== 'assistant' || !(typeof result.assistantMessage.content === 'string' || Array.isArray(result.assistantMessage.content))) fail('INVALID_RESPONSE');
      json(result.assistantMessage, cap.maxJsonBytes);
      if (!Array.isArray(result.assistantMessage.content)) fail('INVALID_RESPONSE');
      const messageCalls = result.assistantMessage.content.filter(part => part?.type === 'tool_call');
      const signature = c => JSON.stringify([c.id, c.name, canonical(c.input)]);
      if (messageCalls.length !== result.toolCalls.length || messageCalls.some((c, i) => signature(c) !== signature(result.toolCalls[i]))) fail('INVALID_RESPONSE');
      messages.push(structuredClone(result.assistantMessage));
      const parts = [];
      for (const call of result.toolCalls) {
        cancelled(signal);
        if (++count > cap.maxToolCalls) fail('TOOL_LIMIT');
        if (!call || typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.input || typeof call.input !== 'object' || Array.isArray(call.input)) fail('INVALID_RESPONSE');
        const args = json(call.input, cap.maxJsonBytes);
        const fingerprint = JSON.stringify([call.name, canonical(JSON.parse(args))]);
        let record = used.get(call.id);
        if (record && record.fingerprint !== fingerprint) fail('TOOL_ID_CONFLICT');
        if (!record) {
          record = { fingerprint, callId: `call-${used.size + 1}` };
          if (!names.has(call.name)) { record.content = 'TOOL_NOT_REGISTERED'; record.isError = true; }
          else {
            let value; let rejected = false;
            try { value = await callTool({ callId: record.callId, name: call.name, args: JSON.parse(args) }); }
            catch { rejected = true; }
            cancelled(signal);
            if (rejected) { record.content = 'TOOL_REJECTED'; record.isError = true; }
            else record.content = json(value, cap.maxJsonBytes);
          }
          used.set(call.id, record);
        }
        parts.push({ type: 'tool_result', toolCallId: call.id, content: record.content, ...(record.isError ? { isError: true } : {}) });
      }
      messages.push({ role: 'user', content: parts });
      json(messages, cap.maxHistoryBytes);
    }
    fail('TURN_LIMIT');
  } });
}
