// model.mjs: pure functions that turn harness events (contracts/events.md) into view state
// for the console UI. No DOM, no network, no timers. Used by app.js and tested with node --test.
//
// The main entry points:
//   createRunView(runId)        → an empty view
//   applyEvent(view, envelope)  → folds one envelope into the view (mutates and returns it)
//   reduceRun(envelopes)        → a fresh view built from a list of envelopes
// Everything else is a small formatter or helper the UI shares.

export const LOOP_STAGES = Object.freeze(["plan", "build", "test", "reflect"]);

const PHASE_STAGE = {
  intake: "plan", research: "plan", plan: "plan", plan_check: "plan", plan_review: "plan",
  awaiting_confirmation: "plan", scaffold: "plan",
  build: "build",
  test: "test", final_test: "test",
  reflect: "reflect", final_review: "reflect", fact_check: "reflect", report: "reflect",
  done: null,
};

const PHASE_LABELS = {
  intake: "Understanding the wish",
  research: "Researching",
  plan: "Planning",
  plan_check: "Checking plan facts",
  plan_review: "Reviewing the plan",
  awaiting_confirmation: "Waiting for your confirmation",
  scaffold: "Writing acceptance tests",
  build: "Building",
  test: "Testing",
  reflect: "Reflecting",
  final_test: "Final test",
  final_review: "Final review",
  fact_check: "Fact-checking the README",
  report: "Writing the report",
  done: "Done",
};

export const ROLE_LABELS = Object.freeze({
  engine: "Engine", intake: "Intake", researcher: "Researcher", planner: "Planner", reviewer: "Reviewer",
  builder: "Builder", tester: "Tester", reflector: "Reflector", reporter: "Reporter", vision: "Vision",
  router: "Router", user: "You", system: "System",
});

const STATUS_LABELS = {
  running: "Running",
  awaiting_confirmation: "Waiting for you",
  delivered: "Delivered",
  partial: "Partly delivered",
  failed: "Failed",
  cancelled: "Cancelled",
  completed: "Finished",
};

const STATUS_TONES = {
  running: "live", awaiting_confirmation: "warn", delivered: "good", partial: "warn",
  failed: "bad", cancelled: "muted", completed: "good",
};

const FINISHED_STATUSES = new Set(["delivered", "partial", "failed", "cancelled", "completed"]);

// ---------------------------------------------------------------- small formatters

/** Stage of the Plan → Build → Test → Reflect ring for an engine phase (null when done or unknown). */
export function loopStageForPhase(phase) {
  return Object.prototype.hasOwnProperty.call(PHASE_STAGE, phase) ? PHASE_STAGE[phase] : null;
}

/** Plain-English label for a phase, e.g. "Building W2". */
export function phaseLabel(phase, itemId = null) {
  const base = PHASE_LABELS[phase] || (phase ? String(phase).replace(/_/g, " ") : "Starting");
  if (itemId && (phase === "build" || phase === "test" || phase === "reflect")) return `${base} ${itemId}`;
  return base;
}

export function roleLabel(role) {
  if (!role) return "Engine";
  return ROLE_LABELS[role] || capitalize(String(role));
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || (status ? capitalize(String(status).replace(/_/g, " ")) : "Unknown");
}

export function statusTone(status) {
  return STATUS_TONES[status] || "muted";
}

export function isFinishedStatus(status) {
  return FINISHED_STATUSES.has(status);
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "anthropic/claude-sonnet-5-5" → "Claude Sonnet 5.5"; other ids are shown as they are. */
export function shortModelName(ref) {
  if (!ref) return "unknown model";
  const s = String(ref);
  const id = s.includes("/") ? s.slice(s.indexOf("/") + 1) : s;
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  if (m) return `Claude ${capitalize(m[1])} ${m[2]}.${m[3]}`;
  return id;
}

/** "anthropic/claude-haiku-5-5" → "Haiku 5.5" (used in "Escalated: Haiku 5.5 → Sonnet 5.5"). */
export function modelFamilyName(ref) {
  const name = shortModelName(ref);
  return name.startsWith("Claude ") ? name.slice(7) : name;
}

/** Joins provider and model into a ModelRef when the model id has no provider prefix. */
export function toModelRef(provider, model) {
  if (!model) return null;
  const m = String(model);
  if (m.includes("/")) return m;
  return provider ? `${provider}/${m}` : m;
}

/** USD for display. null → "unknown" (never "$0.00" for an unmeasured cost). */
export function formatUsd(usd) {
  if (usd === null || usd === undefined || !Number.isFinite(Number(usd))) return "unknown";
  const n = Number(usd);
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** Milliseconds → "4:05" or "1:02:03". null → "—". */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 0.8 → "80%". Exact scores are only rounded here, for display. null → "—". */
export function formatPercent(score) {
  if (score === null || score === undefined || !Number.isFinite(Number(score))) return "—";
  return `${Math.round(Number(score) * 100)}%`;
}

export function formatMinutes(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return "unknown";
  const n = Number(minutes);
  return n < 10 ? `${n.toFixed(1)} min` : `${Math.round(n)} min`;
}

/** Keeps only http(s) links. Anything else (javascript:, data:, relative) → null. */
export function safeUrl(url) {
  if (typeof url !== "string") return null;
  const u = url.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(u)) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function domainOf(source) {
  if (!source) return "";
  if (source.domain) return String(source.domain);
  const u = safeUrl(source.url);
  if (!u) return "";
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** Deduplicates sources by URL and keeps only ones with a safe link. */
export function normalizeSources(list, max = 12) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== "object") continue;
    const url = safeUrl(s.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ name: s.name ? String(s.name) : domainOf(s) || url, url, domain: domainOf({ ...s, url }), snippet: s.snippet ? String(s.snippet) : "" });
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------- providers (Setup page)

export const PRESET_ORDER = Object.freeze(["anthropic", "openai", "deepseek", "gemini", "openrouter", "ollama", "linkup", "github", "custom"]);

/** Orders presets the way the Add provider chips show them; unknown presets go last. */
export function orderPresets(presets) {
  const list = Array.isArray(presets) ? presets.slice() : [];
  const rank = (p) => { const i = PRESET_ORDER.indexOf(p.id); return i === -1 ? PRESET_ORDER.length : i; };
  return list.sort((a, b) => rank(a) - rank(b));
}

/** The chip label for a preset id ("Ollama (local)"), falling back to the preset's own name. */
export function presetChipLabel(preset) {
  const fixed = { anthropic: "Anthropic", openai: "OpenAI", deepseek: "DeepSeek", gemini: "Gemini", openrouter: "OpenRouter", ollama: "Ollama (local)", linkup: "Linkup", github: "GitHub", custom: "Custom" };
  return fixed[preset?.id] || preset?.name || "Preset";
}

export function providerKindBadge(kind) {
  if (kind === "linkup") return "Search";
  if (kind === "github") return "GitHub";
  return "Model";
}

export function isModelKind(kind) {
  return kind === "anthropic" || kind === "openai_compatible";
}

/** Redacted key view → short status text. The UI never sees a real key. */
export function keyStatusLabel(apiKey) {
  if (!apiKey || typeof apiKey !== "object") return "No key";
  if (!apiKey.hasKey) return "No key";
  if (apiKey.preview && apiKey.preview !== "set") return String(apiKey.preview);
  return "Key set";
}

/** True when at least one enabled model on an enabled model provider can be used. */
export function hasUsableModels(config, presets = []) {
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const keyless = new Set((Array.isArray(presets) ? presets : []).filter((p) => p && p.keyRequired === false).map((p) => p.id));
  keyless.add("ollama");
  return providers.some((p) => p && p.enabled !== false && isModelKind(p.kind)
    && (p.apiKey?.hasKey || keyless.has(p.preset))
    && Array.isArray(p.models) && p.models.some((m) => m && m.enabled !== false));
}

/** Every enabled model as a ModelRef option for the routing pin dropdown. */
export function modelOptions(config) {
  const out = [];
  for (const p of Array.isArray(config?.providers) ? config.providers : []) {
    if (!p || p.enabled === false || !isModelKind(p.kind)) continue;
    for (const m of Array.isArray(p.models) ? p.models : []) {
      if (!m || m.enabled === false) continue;
      out.push({ ref: `${p.id}/${m.id}`, label: `${m.label || shortModelName(m.id)} (${p.name || p.id})` });
    }
  }
  return out;
}

/**
 * Turns the result of POST /api/providers/:id/fetch-models into one plain-English outcome.
 * Pass { ok: true, models } on success, or { ok: false, status, code } from the error response.
 * A failed fetch never changes the configured models (room #269), and every message says so.
 */
export function fetchModelsOutcome(res) {
  const kept = "Your configured models were kept.";
  if (res && res.ok) {
    const models = Array.isArray(res.models) ? res.models : [];
    if (models.length === 0) return { ok: false, kind: "empty", tone: "warn", text: `The list is empty: the provider returned no models. ${kept}` };
    return { ok: true, kind: "ok", tone: "good", text: `Found ${models.length} model${models.length === 1 ? "" : "s"}. Tick the ones to add.` };
  }
  const status = Number(res?.status) || 0;
  const code = String(res?.code || "");
  if (status === 401 || status === 403 || code === "auth") {
    return { ok: false, kind: "auth", tone: "bad", text: `Key rejected (401/403). Check the API key. ${kept}` };
  }
  if (status === 404 || code === "not_found" || code === "unsupported" || code === "no_model_list") {
    return { ok: false, kind: "no_endpoint", tone: "warn", text: `This provider has no model list endpoint. Add model ids by hand. ${kept}` };
  }
  if (code === "invalid_response") {
    return { ok: false, kind: "invalid", tone: "bad", text: `The provider answered, but not with a model list. ${kept}` };
  }
  return { ok: false, kind: "unreachable", tone: "bad", text: `Couldn't reach the provider. Check the request URL and your connection. ${kept}` };
}

/** Result of POST /api/providers/:id/test → one inline line. */
export function testOutcome(res) {
  if (!res) return { ok: false, tone: "bad", text: "Couldn't run the test." };
  const detail = res.detail ? String(res.detail) : "";
  if (res.ok) {
    const ms = Number.isFinite(res.latencyMs) ? `${Math.round(res.latencyMs)} ms` : "unknown latency";
    return { ok: true, tone: "good", text: `Connected · ${ms}${detail ? ` · ${detail}` : ""}` };
  }
  return { ok: false, tone: "bad", text: detail || "The test failed." };
}

/** roster rows (ref, tier, catalogMatched) → Map for quick lookup by ModelRef. */
export function rosterIndex(roster) {
  const map = new Map();
  for (const r of Array.isArray(roster) ? roster : []) if (r && r.ref) map.set(String(r.ref), r);
  return map;
}

// ---------------------------------------------------------------- run view

export function createRunView(runId = null) {
  return {
    runId,
    lastSeq: 0,
    wish: null,
    synthetic: false,
    autonomy: "full",
    limits: null,
    status: "running",
    closed: false,
    closedStatus: null,
    phase: null,
    iteration: 0,
    currentItemId: null,
    startedAt: null,
    lastEventAt: null,
    finishedAt: null,
    title: null,
    brief: null,
    research: null,
    searches: [],
    plan: null,
    planVersions: [],
    planChecks: [],
    factCheck: null,
    shelfLife: { claims: {}, order: [], diff: null },
    reviews: [],
    approval: null,
    confirmation: null,
    items: [],
    current: null,
    routes: [],
    modelsByRole: {},
    escalations: [],
    calls: {},
    lastTool: null,
    tests: [],
    finalTest: null,
    builds: [],
    reflections: [],
    best: null,
    spend: { usd: null, source: "unknown", calls: 0, inputTokens: null, outputTokens: null, costKnown: true, costSum: 0 },
    budget: null,
    finalReview: null,
    finished: null,
    artifacts: [],
    timeline: [],
    unknownEvents: 0,
    eventCount: 0,
  };
}

/** Builds a fresh view from a list of envelopes (any order; sorted by seq). */
export function reduceRun(envelopes, runId = null) {
  const view = createRunView(runId);
  const list = (Array.isArray(envelopes) ? envelopes : []).filter((e) => e && typeof e === "object");
  list.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  for (const env of list) applyEvent(view, env);
  return view;
}

/** Parses JSON Lines text into envelopes, skipping blank and broken lines. */
export function parseJsonl(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* a partial or broken line is skipped */ }
  }
  return out;
}

function getItem(view, id) {
  let it = view.items.find((i) => i.id === id);
  if (!it) {
    it = { id, title: id, difficulty: null, status: "pending", attempts: 0, attempt: null, lastScore: null, scores: [], model: null, lastTest: null, checkIds: [], note: null };
    view.items.push(it);
  }
  return it;
}

function pushTimeline(view, env, entry) {
  const e = {
    key: entry.key || `seq:${env.seq}`,
    seq: Number(env.seq) || 0,
    at: env.timestamp || null,
    role: entry.role || env?.provenance?.role || null,
    tone: entry.tone || "info",
    icon: entry.icon || "•",
    text: entry.text,
    detail: entry.detail || null,
    rev: 1,
  };
  view.timeline.push(e);
  return e;
}

function findTimeline(view, key) {
  for (let i = view.timeline.length - 1; i >= 0; i--) if (view.timeline[i].key === key) return view.timeline[i];
  return null;
}

function callModelRef(env, p) {
  return toModelRef(p.provider ?? env?.provenance?.provider, p.model ?? env?.provenance?.model);
}

function normalizeScope(scope, itemId) {
  if (scope && typeof scope === "object") return scope.kind === "all" ? "all" : "item";
  if (scope === "all") return "all";
  if (scope === "item") return "item";
  return itemId ? "item" : "all";
}

function quote(s, max = 120) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function toolSentence(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const path = a.path || a.file || null;
  const n = String(name || "tool");
  if (/search/i.test(n)) return a.query ? `Searched the web: “${quote(a.query, 90)}”` : "Searched the web";
  if (n === "read_file") return path ? `Read ${path}` : "Read a file";
  if (n === "write_file") return path ? `Wrote ${path}` : "Wrote a file";
  if (n === "edit_file") return path ? `Edited ${path}` : "Edited a file";
  if (n === "list_files") return "Listed the workspace files";
  if (n === "run_command") {
    const cmd = Array.isArray(a.args) ? ["node", ...a.args].join(" ") : Array.isArray(a.command) ? a.command.join(" ") : a.command || a.cmd || "";
    return cmd ? `Ran ${quote(cmd, 80)}` : "Ran a command";
  }
  return path ? `${n} ${path}` : n.replace(/_/g, " ");
}

function scoresText(scores) {
  if (!scores || typeof scores !== "object") return "";
  return Object.values(scores).filter((v) => Number.isFinite(v)).join("/");
}

/**
 * Folds one envelope into the view. Unknown types and fields are ignored (CONTRACT rule 5).
 * Events at or below the last seen seq are ignored, so a reconnect that resends events is harmless.
 */
export function applyEvent(view, env) {
  if (!env || typeof env !== "object" || typeof env.type !== "string") return view;
  const seq = Number(env.seq);
  if (Number.isFinite(seq) && seq > 0) {
    if (seq <= view.lastSeq) return view;
    view.lastSeq = seq;
  }
  view.eventCount += 1;
  const p = env.payload && typeof env.payload === "object" ? env.payload : {};
  const at = env.timestamp || null;
  if (at) view.lastEventAt = at;
  const role = env?.provenance?.role || null;

  switch (env.type) {
    case "room.created": {
      view.wish = p.goal ? String(p.goal) : view.wish;
      view.synthetic = p.synthetic === true;
      if (p.autonomy === "confirm_plan" || p.autonomy === "full") view.autonomy = p.autonomy;
      view.limits = p.limits && typeof p.limits === "object" ? p.limits : view.limits;
      view.startedAt = at || view.startedAt;
      if (!view.runId && env.roomId) view.runId = env.roomId;
      pushTimeline(view, env, {
        icon: "★", tone: "info",
        text: `Run started: “${quote(view.wish, 140)}”`,
        detail: { kind: "text", lines: [view.autonomy === "confirm_plan" ? "Mode: you confirm the plan before building." : "Mode: full autopilot. An independent model approves the plan; nobody is asked anything during the run."] },
      });
      break;
    }
    case "harness.phase.changed": {
      const phase = p.phase ? String(p.phase) : null;
      view.phase = phase;
      if (Number.isFinite(p.iteration)) view.iteration = p.iteration;
      view.currentItemId = p.itemId ?? (phase === "build" || phase === "test" || phase === "reflect" ? view.currentItemId : null);
      if (phase === "awaiting_confirmation" && !view.confirmation && !isFinishedStatus(view.status)) view.status = "awaiting_confirmation";
      else if (view.status === "awaiting_confirmation" && phase !== "awaiting_confirmation") view.status = "running";
      if (p.itemId) {
        const it = getItem(view, p.itemId);
        if (phase === "build" && it.status !== "passed") it.status = "building";
        if (phase === "test" && it.status !== "passed") it.status = "testing";
      }
      const label = phaseLabel(phase, p.itemId || null);
      const iter = (phase === "build" || phase === "test" || phase === "reflect") && Number.isFinite(p.iteration) && p.iteration > 0 ? ` · iteration ${p.iteration}` : "";
      pushTimeline(view, env, { icon: "", tone: "phase", text: `${label}${iter}` });
      break;
    }
    case "harness.route.selected": {
      const r = String(p.role || role || "engine");
      const model = p.model ? String(p.model) : null;
      const prev = view.modelsByRole[r]?.model || null;
      let escalation = null;
      if (p.escalated === true) {
        const itemId = view.currentItemId;
        const lastItemTest = [...view.tests].reverse().find((t) => t.itemId === itemId && t.scope === "item");
        const afterFailedTests = !!(lastItemTest && (lastItemTest.failed > 0 || lastItemTest.errored > 0));
        const from = prev && prev !== model ? prev : null;
        const text = from
          ? `Escalated: ${modelFamilyName(from)} → ${modelFamilyName(model)}${afterFailedTests ? " after failed tests" : ""}`
          : `Escalated to ${modelFamilyName(model)}${afterFailedTests ? " after failed tests" : ""}`;
        escalation = { role: r, from, to: model, itemId, attempt: p.attempt ?? null, reason: p.reason || "", afterFailedTests, text, seq: view.lastSeq };
        view.escalations.push(escalation);
      }
      const route = {
        role: r, model, tier: p.tier ?? null, rule: p.rule || null, reason: p.reason ? String(p.reason) : "",
        escalated: p.escalated === true, pinned: p.pinned === true, attempt: p.attempt ?? null,
        itemId: r === "builder" || r === "tester" || r === "reflector" ? view.currentItemId : null,
        phase: view.phase, at, escalation, purpose: null, active: false, seq: view.lastSeq,
      };
      if (view.lastTool && view.lastTool.role !== r) view.lastTool = null;
      view.routes.push(route);
      view.modelsByRole[r] = { model, tier: route.tier, reason: route.reason, escalated: route.escalated, pinned: route.pinned, at };
      view.current = route;
      if (r === "builder" && view.currentItemId && Number.isFinite(p.attempt)) {
        const it = getItem(view, view.currentItemId);
        it.attempt = p.attempt;
        it.model = model;
      }
      pushTimeline(view, env, {
        icon: escalation ? "▲" : "◆", tone: escalation ? "warn" : "route", role: r,
        text: escalation
          ? `${escalation.text}. ${roleLabel(r)} is now ${shortModelName(model)}.`
          : `Router picked ${shortModelName(model)} for the ${roleLabel(r).toLowerCase()}${route.itemId && r === "builder" ? ` (${route.itemId})` : ""}`,
        detail: { kind: "route", reason: route.reason, rule: route.rule, tier: route.tier, model, pinned: route.pinned },
      });
      break;
    }
    case "run.started": {
      const callId = env.runId || p.callId || `seq-${env.seq}`;
      const r = String(p.role || role || "engine");
      const model = callModelRef(env, p);
      view.calls[callId] = { callId, role: r, model, purpose: p.purpose ? String(p.purpose) : null, attempt: p.attempt ?? null, status: "running", startedAt: at, durationMs: null, usage: null };
      if (view.current && view.current.role === r) {
        view.current.purpose = view.calls[callId].purpose;
        view.current.active = true;
        view.current.callId = callId;
        if (!view.current.model) view.current.model = model;
      } else {
        view.current = { role: r, model, tier: null, rule: null, reason: "", escalated: false, pinned: false, attempt: p.attempt ?? null, itemId: env.taskId || null, phase: view.phase, at, escalation: null, purpose: view.calls[callId].purpose, active: true, callId, seq: view.lastSeq };
      }
      break;
    }
    case "run.completed":
    case "run.failed": {
      const callId = env.runId || p.callId || null;
      const call = callId ? view.calls[callId] : null;
      if (call) {
        call.status = env.type === "run.completed" ? "done" : "failed";
        call.durationMs = Number.isFinite(p.durationMs) ? p.durationMs : null;
        call.usage = p.usage || null;
      }
      if (view.current && view.current.callId && view.current.callId === callId) view.current.active = false;
      addUsage(view, p.usage);
      if (env.type === "run.failed") {
        const err = p.error && typeof p.error === "object" ? p.error : {};
        pushTimeline(view, env, {
          icon: "!", tone: "bad", role: call?.role || role,
          text: `Model call failed (${shortModelName(call?.model || callModelRef(env, p))}): ${quote(err.message || err.code || "unknown error", 140)}${p.retryable ? " · will retry" : ""}`,
        });
      }
      break;
    }
    case "tool.called": {
      const id = p.toolCallId || `seq-${env.seq}`;
      const text = toolSentence(p.name, p.args);
      const isSearch = /search/i.test(String(p.name || ""));
      if (isSearch) view.searches.push({ toolCallId: id, query: p.args?.query ? String(p.args.query) : null, status: "running", summary: null });
      view.lastTool = { toolCallId: id, name: p.name || null, text, status: "running", role, at };
      pushTimeline(view, env, { key: `tool:${id}`, icon: isSearch ? "⌕" : "›", tone: "tool", role, text, detail: null });
      break;
    }
    case "tool.result": {
      const id = p.toolCallId || null;
      const entry = id ? findTimeline(view, `tool:${id}`) : null;
      const ok = p.status !== "error";
      if (entry) {
        entry.tone = ok ? "tool" : "bad";
        entry.detail = p.summary ? { kind: "text", lines: [String(p.summary)] } : entry.detail;
        entry.durationMs = Number.isFinite(p.durationMs) ? p.durationMs : null;
        entry.rev += 1;
      }
      const s = view.searches.find((x) => x.toolCallId === id);
      if (s) { s.status = ok ? "ok" : "error"; s.summary = p.summary ? String(p.summary) : null; }
      if (view.lastTool && view.lastTool.toolCallId === id) view.lastTool.status = ok ? "ok" : "error";
      break;
    }
    case "harness.note": {
      if (p.text) pushTimeline(view, env, { icon: "✎", tone: "note", role: p.role || role, text: `${roleLabel(p.role || role)}: ${quote(p.text, 300)}` });
      break;
    }
    case "harness.brief.ready": {
      view.brief = {
        title: p.title ? String(p.title) : null,
        productKind: p.productKind || null,
        mustHaves: Array.isArray(p.mustHaves) ? p.mustHaves.map(String) : [],
        assumptions: Array.isArray(p.assumptions) ? p.assumptions.filter((a) => a && typeof a === "object").map((a) => ({ topic: String(a.topic ?? ""), assumed: String(a.assumed ?? "") })) : [],
        refused: p.refused || null,
      };
      if (view.brief.title) view.title = view.brief.title;
      const n = view.brief.assumptions.length;
      pushTimeline(view, env, {
        icon: "◎", tone: p.refused ? "bad" : "good", role: "intake",
        text: p.refused
          ? `The wish can't be built safely: ${quote(p.refused.reason || "refused", 160)}`
          : `Understood the wish as “${view.brief.title || "a product"}” (${productKindLabel(view.brief.productKind)}). ${n} assumption${n === 1 ? "" : "s"} made for you instead of asking.`,
        detail: { kind: "brief", mustHaves: view.brief.mustHaves, assumptions: view.brief.assumptions },
      });
      break;
    }
    case "harness.research.ready": {
      const sources = normalizeSources(p.sources);
      view.research = {
        findingCount: Number.isFinite(p.findingCount) ? p.findingCount : null,
        searchesUsed: Number.isFinite(p.searchesUsed) ? p.searchesUsed : null,
        sources,
        basis: p.basis || null,
      };
      const basisText = p.basis === "model_knowledge" ? " (no web search available: from model knowledge)" : p.basis === "mixed" ? " (web search plus model knowledge)" : "";
      pushTimeline(view, env, {
        icon: "⌕", tone: "good", role: "researcher",
        text: `Research done: ${count(view.research.findingCount, "finding")} from ${sources.length} source${sources.length === 1 ? "" : "s"}, ${count(view.research.searchesUsed, "web search", "web searches")}${basisText}.`,
        detail: { kind: "sources", sources },
      });
      break;
    }
    case "harness.plan.ready": {
      const items = Array.isArray(p.items) ? p.items.filter((i) => i && i.id) : [];
      const plan = {
        specVersion: Number.isFinite(p.specVersion) ? p.specVersion : (view.plan?.specVersion || 0) + 1,
        title: p.title ? String(p.title) : view.title,
        stack: p.stack || null,
        items: items.map((i) => ({ id: String(i.id), title: String(i.title ?? i.id), difficulty: i.difficulty || null })),
        checkCount: Number.isFinite(p.checkCount) ? p.checkCount : null,
        executableCheckCount: Number.isFinite(p.executableCheckCount) ? p.executableCheckCount : null,
        at,
      };
      const isRevision = !!view.plan;
      view.plan = plan;
      view.planVersions.push(plan);
      if (plan.title) view.title = plan.title;
      if (view.approval && view.approval.specVersion !== plan.specVersion) view.approval = null; // a new spec voids the approval
      // keep started items, replace untouched ones with the new plan's items
      const keep = view.items.filter((it) => it.attempts > 0 || it.attempt || it.status === "passed" || it.status === "failed");
      const next = [];
      for (const pi of plan.items) {
        const existing = keep.find((k) => k.id === pi.id) || view.items.find((k) => k.id === pi.id);
        const it = existing || { id: pi.id, title: pi.title, difficulty: pi.difficulty, status: "pending", attempts: 0, attempt: null, lastScore: null, scores: [], model: null, lastTest: null, checkIds: [], note: null };
        it.title = pi.title; it.difficulty = pi.difficulty;
        next.push(it);
      }
      for (const k of keep) if (!next.includes(k)) next.push(k);
      view.items = next;
      pushTimeline(view, env, {
        icon: "▤", tone: "good", role: "planner",
        text: `${isRevision ? "Revised plan" : "Plan"} v${plan.specVersion}: “${plan.title || "untitled"}”, ${count(plan.items.length, "work item")}, ${count(plan.checkCount, "acceptance check")}${plan.executableCheckCount !== null ? ` (${plan.executableCheckCount} executable)` : ""}.`,
        detail: { kind: "plan", items: plan.items, stack: plan.stack },
      });
      break;
    }
    case "harness.skill.started":
    case "harness.skill.completed": {
      const phase = p.phase === "fact_check" ? "fact_check" : "plan_check";
      const key = p.childRoomId || `${phase}:${p.reportPath || view.lastSeq}`;
      let entry;
      if (phase === "plan_check") {
        entry = view.planChecks.find((c) => c.key === key);
        if (!entry) { entry = { key, specVersion: view.plan?.specVersion ?? null }; view.planChecks.push(entry); }
      } else {
        entry = view.factCheck && view.factCheck.key === key ? view.factCheck : { key };
        view.factCheck = entry;
      }
      Object.assign(entry, {
        phase,
        skillId: p.skillId || entry.skillId || "shelf-life",
        version: p.version || entry.version || null,
        docLabel: p.docLabel || entry.docLabel || null,
        childRoomId: p.childRoomId || entry.childRoomId || null,
      });
      if (env.type === "harness.skill.started") {
        entry.status = "running";
        pushTimeline(view, env, {
          icon: "✓", tone: "info", role: p.role || "researcher",
          text: phase === "plan_check"
            ? `Checking the plan's facts against live sources (Shelf Life) before building${entry.specVersion ? `: plan v${entry.specVersion}` : ""}`
            : `Fact-checking ${p.docLabel || "the README"} against live sources (Shelf Life)`,
        });
      } else {
        entry.status = p.status || "completed";
        entry.findingCount = Number.isFinite(p.findingCount) ? p.findingCount : null;
        entry.staleCount = Number.isFinite(p.staleCount) ? p.staleCount : null;
        entry.searchesUsed = Number.isFinite(p.searchesUsed) ? p.searchesUsed : null;
        entry.reportPath = p.reportPath || entry.reportPath || null;
        entry.reason = p.reason || null;
        const verified = entry.status === "completed";
        let text;
        if (!verified) text = `${phase === "plan_check" ? "Plan fact check" : "Fact check"}: not verified (${entry.reason || entry.status}).`;
        else if (phase === "plan_check") text = entry.staleCount > 0
          ? `Plan fact check: ${count(entry.staleCount, "stale fact")} out of ${count(entry.findingCount, "checked fact")}. The plan must be revised before building.`
          : `Plan fact check: ${count(entry.findingCount, "fact")} checked, none stale.`;
        else text = `Fact check of ${entry.docLabel || "the README"}: ${count(entry.findingCount, "claim")} checked, ${count(entry.staleCount, "proposed correction")} (proposed, unreviewed).`;
        pushTimeline(view, env, { icon: "✓", tone: verified ? (entry.staleCount > 0 ? "warn" : "good") : "muted", role: p.role || "researcher", text, detail: entry.reportPath ? { kind: "report", path: entry.reportPath, phase } : null });
      }
      break;
    }
    case "harness.plan.reviewed": {
      const review = {
        verdict: p.verdict === "approve" ? "approve" : "revise",
        scores: p.scores && typeof p.scores === "object" ? p.scores : null,
        issues: Array.isArray(p.issues) ? p.issues.filter((i) => i && typeof i === "object").map((i) => ({ severity: i.severity || "minor", text: String(i.text ?? "") })) : [],
        reviewerModel: p.reviewerModel || null,
        specVersion: Number.isFinite(p.specVersion) ? p.specVersion : view.plan?.specVersion ?? null,
        specSha256: p.specSha256 || null,
        sameModelAsPlanner: p.sameModelAsPlanner === true,
        approval: p.approval && typeof p.approval === "object" ? p.approval : null,
        at,
      };
      view.reviews.push(review);
      if (review.approval && review.verdict === "approve") view.approval = { ...review.approval };
      else view.approval = null;
      const who = shortModelName(review.reviewerModel);
      const blocker = review.issues.find((i) => i.severity === "blocker") || review.issues[0];
      pushTimeline(view, env, {
        icon: review.verdict === "approve" ? "✔" : "↺", tone: review.verdict === "approve" ? "good" : "warn", role: "reviewer",
        text: review.verdict === "approve"
          ? `Plan v${review.specVersion} ${view.autonomy === "confirm_plan" ? "approved" : "auto-approved"} by ${who}${scoresText(review.scores) ? ` (scores ${scoresText(review.scores)} out of 3)` : ""}.`
          : `${who} asked for changes to plan v${review.specVersion}${blocker ? `: ${quote(blocker.text, 160)}` : "."}`,
        detail: { kind: "review", scores: review.scores, issues: review.issues, sameModelAsPlanner: review.sameModelAsPlanner },
      });
      break;
    }
    case "harness.plan.confirmed": {
      if (p.by === "user") {
        view.confirmation = { by: "user", at: p.at || at, specVersion: p.specVersion ?? null, specSha256: p.specSha256 || null };
        if (view.status === "awaiting_confirmation") view.status = "running";
        pushTimeline(view, env, { icon: "✔", tone: "good", role: "user", text: `You confirmed plan v${p.specVersion ?? "?"}.` });
      }
      break;
    }
    case "task.created": {
      const id = env.taskId || p.taskId;
      if (!id) break;
      const it = getItem(view, String(id));
      if (p.title) it.title = String(p.title);
      if (p.inputs?.difficulty) it.difficulty = p.inputs.difficulty;
      if (Array.isArray(p.acceptance)) it.checkIds = p.acceptance.map(String);
      break;
    }
    case "task.updated": {
      const id = env.taskId || p.taskId;
      if (!id) break;
      const it = getItem(view, String(id));
      if (p.status === "failed") it.status = "failed";
      else if (p.status === "review") it.status = "built";
      else if (p.status === "running" && it.status !== "testing") it.status = view.phase === "test" ? "testing" : "building";
      else if (p.status === "done") it.status = "passed";
      if (p.note) it.note = String(p.note);
      break;
    }
    case "task.done": {
      const id = env.taskId || p.taskId;
      if (!id) break;
      const it = getItem(view, String(id));
      it.status = "passed";
      const ev = Array.isArray(p.evidence) ? p.evidence.find((e) => e && e.ref) : null;
      pushTimeline(view, env, { icon: "✔", tone: "good", text: `${id} accepted: all its checks passed${ev ? ` (evidence: ${ev.ref})` : ""}.`, detail: ev ? { kind: "test", reportPath: ev.ref, failures: [] } : null });
      break;
    }
    case "task.failed": {
      const id = env.taskId || p.taskId;
      if (!id) break;
      const it = getItem(view, String(id));
      it.status = "failed";
      pushTimeline(view, env, { icon: "✗", tone: "bad", text: `${id} failed: ${quote(p.reason || "attempts exhausted", 160)}.` });
      break;
    }
    case "harness.build.completed": {
      const id = p.itemId ? String(p.itemId) : view.currentItemId;
      const build = { itemId: id, attempt: p.attempt ?? null, status: p.status || null, commit: p.commit || null, filesChanged: Array.isArray(p.filesChanged) ? p.filesChanged.map(String) : [], turns: p.turns ?? null, toolCalls: p.toolCalls ?? null, model: p.model || null };
      view.builds.push(build);
      if (id) {
        const it = getItem(view, id);
        if (Number.isFinite(build.attempt)) it.attempts = Math.max(it.attempts, build.attempt);
        else it.attempts += 1;
        if (build.model) it.model = build.model;
        if (it.status === "building") it.status = "built";
      }
      const files = build.filesChanged.length;
      pushTimeline(view, env, {
        icon: "⚒", tone: build.status === "done" ? "info" : "warn", role: "builder",
        text: build.status === "done"
          ? `Builder finished ${id} attempt ${build.attempt ?? "?"}: ${count(files, "file")} changed${build.commit ? ` (commit ${String(build.commit).slice(0, 7)})` : ""}.`
          : `Builder stopped on ${id} attempt ${build.attempt ?? "?"}: ${String(build.status || "unknown").replace(/_/g, " ")}.`,
        detail: files ? { kind: "files", files: build.filesChanged, turns: build.turns, toolCalls: build.toolCalls } : null,
      });
      break;
    }
    case "harness.test.completed": {
      const scope = normalizeScope(p.scope, p.itemId);
      const t = {
        scope, itemId: p.itemId ? String(p.itemId) : null, candidate: p.candidate || null,
        passed: num(p.passed), failed: num(p.failed), errored: num(p.errored), skipped: num(p.skipped), total: num(p.total),
        score: Number.isFinite(p.score) ? p.score : null, acceptanceIntact: p.acceptanceIntact !== false,
        testerModel: p.testerModel || null, reportPath: p.reportPath || null,
        failures: Array.isArray(p.failures) ? p.failures.slice(0, 5).filter((f) => f && typeof f === "object").map((f) => ({ checkId: String(f.checkId ?? ""), message: String(f.message ?? "") })) : [],
        seq: view.lastSeq,
      };
      view.tests.push(t);
      if (scope === "all") view.finalTest = t;
      if (t.itemId) {
        const it = getItem(view, t.itemId);
        it.lastScore = t.score;
        it.scores.push(t.score);
        it.lastTest = { passed: t.passed, total: t.total, failed: t.failed };
        if (it.status === "testing" || it.status === "built" || it.status === "building") it.status = t.failed + t.errored > 0 || t.score < 1 ? "retrying" : "testing";
      }
      const ok = t.total > 0 && t.passed === t.total && t.acceptanceIntact;
      const scopeText = scope === "all" ? "Final test of everything" : `${t.itemId}`;
      pushTimeline(view, env, {
        icon: ok ? "✔" : "✗", tone: ok ? "good" : "bad", role: "tester",
        text: `${scopeText}: ${t.passed}/${t.total} checks passed (${formatPercent(t.score)}), tested by ${shortModelName(t.testerModel)}${t.acceptanceIntact ? "" : ". Acceptance tests were modified, so every result counts as failed"}.`,
        detail: { kind: "test", reportPath: t.reportPath, failures: t.failures },
      });
      break;
    }
    case "harness.reflect.decided": {
      const r = { itemId: p.itemId ? String(p.itemId) : view.currentItemId, decision: p.decision || null, reason: p.reason ? String(p.reason) : "", overriddenBy: p.overriddenBy || null };
      view.reflections.push(r);
      const decisionText = {
        next: "move on to the next item", retry: "retry with fix instructions", escalate: "retry with a stronger model",
        replan: "revise the plan", finish: "finish", stop: "stop",
      }[r.decision] || String(r.decision || "continue");
      const why = r.overriddenBy === "all_checks_pass" ? "all checks pass" : r.overriddenBy === "attempts_exhausted" ? "attempts used up" : r.overriddenBy === "budget" ? "budget used up" : null;
      pushTimeline(view, env, {
        icon: "↻", tone: r.decision === "escalate" || r.decision === "retry" || r.decision === "replan" ? "warn" : r.decision === "stop" ? "bad" : "info", role: "reflector",
        text: `Reflection on ${r.itemId || "the run"}: ${decisionText}${why ? ` (${why})` : ""}.${r.reason ? ` ${quote(r.reason, 180)}` : ""}`,
      });
      break;
    }
    case "harness.candidate.best": {
      view.best = { commit: p.commit || null, score: Number.isFinite(p.score) ? p.score : null, previousBest: Number.isFinite(p.previousBest) ? p.previousBest : null, reverted: p.reverted === true };
      pushTimeline(view, env, {
        icon: view.best.reverted ? "⤺" : "★", tone: view.best.reverted ? "warn" : "good",
        text: view.best.reverted
          ? `Regression: reset the workspace to the best candidate so far (${formatPercent(view.best.score)}, commit ${String(view.best.commit || "").slice(0, 7)}).`
          : `Kept as best candidate: commit ${String(view.best.commit || "").slice(0, 7)} at ${formatPercent(view.best.score)}${view.best.previousBest !== null && view.best.previousBest !== view.best.score ? ` (was ${formatPercent(view.best.previousBest)})` : ""}.`,
      });
      break;
    }
    case "harness.budget.updated": {
      view.budget = {
        spentUsd: Number.isFinite(p.spentUsd) ? p.spentUsd : null,
        usdSource: p.usdSource || "unknown",
        elapsedMinutes: Number.isFinite(p.elapsedMinutes) ? p.elapsedMinutes : null,
        iterations: Number.isFinite(p.iterations) ? p.iterations : null,
        limits: p.limits && typeof p.limits === "object" ? p.limits : null,
        exceeded: p.exceeded || null,
      };
      view.spend.usd = view.budget.spentUsd;
      view.spend.source = view.budget.spentUsd === null ? "unknown" : view.budget.usdSource;
      if (view.budget.iterations !== null) view.iteration = Math.max(view.iteration, view.budget.iterations);
      if (view.budget.limits) view.limits = { ...(view.limits || {}), ...view.budget.limits };
      if (view.budget.exceeded) pushTimeline(view, env, { icon: "!", tone: "bad", text: `Budget reached (${view.budget.exceeded === "usd" ? "spend" : view.budget.exceeded}). The harness stops and delivers the best candidate so far.` });
      break;
    }
    case "harness.final.reviewed": {
      view.finalReview = { verdict: p.verdict || null, scores: p.scores || null, gaps: Array.isArray(p.gaps) ? p.gaps.map(String) : [], reviewerModel: p.reviewerModel || null };
      pushTimeline(view, env, {
        icon: p.verdict === "ship" ? "✔" : "↺", tone: p.verdict === "ship" ? "good" : "warn", role: "reviewer",
        text: `Final review by ${shortModelName(p.reviewerModel)}: ${p.verdict === "ship" ? "ready to ship" : "needs another iteration"}${scoresText(p.scores) ? ` (scores ${scoresText(p.scores)} out of 3)` : ""}.`,
        detail: view.finalReview.gaps.length ? { kind: "list", title: "Known gaps", lines: view.finalReview.gaps } : null,
      });
      break;
    }
    case "harness.run.finished": {
      view.finished = {
        status: p.status || "completed", summary: p.summary ? String(p.summary) : "", finalScore: Number.isFinite(p.finalScore) ? p.finalScore : null,
        allPassed: p.allPassed === true, candidate: p.candidate || null, specVersion: p.specVersion ?? null,
        reportPath: p.reportPath || null, previewPath: p.previewPath || null,
        spentUsd: Number.isFinite(p.spentUsd) ? p.spentUsd : null, minutes: Number.isFinite(p.minutes) ? p.minutes : null,
      };
      view.status = view.finished.status;
      view.finishedAt = at;
      view.phase = "done";
      if (view.finished.spentUsd !== null) view.spend.usd = view.finished.spentUsd;
      for (const it of view.items) if (it.status === "building" || it.status === "testing" || it.status === "built" || it.status === "retrying") it.status = view.finished.status === "cancelled" ? "pending" : it.status;
      if (view.current) view.current.active = false;
      pushTimeline(view, env, {
        icon: view.status === "delivered" ? "★" : view.status === "failed" ? "✗" : "■", tone: statusTone(view.status) === "good" ? "good" : statusTone(view.status) === "bad" ? "bad" : "warn",
        text: `${statusLabel(view.status)}${view.finished.summary ? `: ${quote(view.finished.summary, 200)}` : "."}`,
      });
      break;
    }
    case "artifact.registered": {
      const id = p.artifactId || p.location;
      if (id && !view.artifacts.includes(String(id))) view.artifacts.push(String(id));
      break;
    }
    case "room.closed": {
      view.closed = true;
      view.closedStatus = p.status || null;
      if (!view.finished) {
        view.status = p.status === "cancelled" ? "cancelled" : p.status === "failed" ? "failed" : "completed";
        view.finishedAt = at;
        view.phase = "done";
        pushTimeline(view, env, { icon: "■", tone: "muted", text: `Run closed (${statusLabel(view.status).toLowerCase()})${p.summary ? `: ${quote(p.summary, 160)}` : "."}` });
      }
      if (!view.finishedAt) view.finishedAt = at;
      if (view.current) view.current.active = false;
      break;
    }
    // Shelf Life audit events (normally in the skill's child room; folded in when a stream includes them)
    case "shelflife.claim.extracted": {
      const c = slClaim(view, p.claimId);
      if (!c) break;
      Object.assign(c, { quote: p.quote ?? c.quote, statement: p.statement ?? c.statement, category: p.category ?? c.category, line: p.lineStart ?? c.line });
      break;
    }
    case "shelflife.verdict.final":
    case "shelflife.verdict.proposed": {
      const c = slClaim(view, p.claimId);
      if (!c) break;
      if (env.type === "shelflife.verdict.final" || !c.final) {
        Object.assign(c, { verdict: p.verdict ?? c.verdict, currentValue: p.currentValue ?? c.currentValue, correction: p.correction ?? c.correction, sources: normalizeSources(p.sources, 4) });
        if (env.type === "shelflife.verdict.final") c.final = true;
      }
      break;
    }
    case "shelflife.check.result": {
      const c = slClaim(view, p.claimId);
      if (!c) break;
      c.checks = c.checks.filter((k) => k.check !== p.check);
      c.checks.push({ check: String(p.check || ""), passed: p.passed === true, detail: String(p.detail ?? "") });
      break;
    }
    case "shelflife.patch.proposed": {
      view.shelfLife.diff = p.diff ? String(p.diff) : view.shelfLife.diff;
      break;
    }
    default:
      view.unknownEvents += 1;
  }
  return view;
}

function slClaim(view, claimId) {
  if (!claimId) return null;
  const id = String(claimId);
  if (!view.shelfLife.claims[id]) {
    view.shelfLife.claims[id] = { claimId: id, quote: null, statement: null, category: null, line: null, verdict: null, currentValue: null, correction: null, sources: [], checks: [], final: false };
    view.shelfLife.order.push(id);
  }
  return view.shelfLife.claims[id];
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}

function count(n, singular, plural = `${singular}s`) {
  if (n === null || n === undefined || !Number.isFinite(n)) return `an unknown number of ${plural}`;
  return `${n} ${n === 1 ? singular : plural}`;
}

export function productKindLabel(kind) {
  return { web_page: "web page", web_app: "web app", cli_tool: "command-line tool", script: "script", data_report: "data report", other: "product" }[kind] || "product";
}

function addUsage(view, usage) {
  const s = view.spend;
  const u = usage && typeof usage === "object" ? usage : null;
  const first = s.calls === 0;
  s.calls += 1;
  // A token total is only known while every call reported it (unknown is null, never 0).
  const sum = (cur, v) => (!Number.isFinite(v) ? null : first ? v : cur === null ? null : cur + v);
  s.inputTokens = sum(s.inputTokens, u?.inputTokens);
  s.outputTokens = sum(s.outputTokens, u?.outputTokens);
  if (Number.isFinite(u?.costUsd)) s.costSum += u.costUsd;
  else s.costKnown = false;
  if (u?.source === "estimated") s.anyEstimated = true;
  if (!view.budget) {
    // Before the engine's first budget event, show the sum only when every call's cost was measured.
    s.usd = s.costKnown ? s.costSum : null;
    s.source = s.costKnown ? (s.anyEstimated ? "estimated" : "provider") : "unknown";
  }
}

// ---------------------------------------------------------------- derived labels for the run screen

/** Elapsed run time in ms: finished runs use their own timestamps, running runs use `nowMs`. */
export function elapsedMs(view, nowMs) {
  const start = Date.parse(view?.startedAt || "");
  if (!Number.isFinite(start)) return null;
  const endIso = view.finishedAt || (isFinishedStatus(view.status) ? view.lastEventAt : null);
  const end = endIso ? Date.parse(endIso) : nowMs;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/** Offset of an event from the run start, e.g. "+03:12". */
export function offsetLabel(view, iso) {
  const start = Date.parse(view?.startedAt || "");
  const t = Date.parse(iso || "");
  if (!Number.isFinite(start) || !Number.isFinite(t)) return "";
  return `+${formatDuration(Math.max(0, t - start))}`;
}

/** Spend for the header: { text: "$0.42", note: "estimated" | "measured" | "" }. */
export function spendLabel(view) {
  const usd = view?.spend?.usd;
  if (usd === null || usd === undefined) return { text: "unknown", note: "not measured" };
  const src = view.spend.source;
  return { text: formatUsd(usd), note: src === "estimated" ? "estimated" : src === "provider" ? "measured" : "" };
}

/** Iteration counter text, e.g. "3 / 12". */
export function iterationLabel(view) {
  const max = view?.limits?.maxRuns ?? view?.limits?.maxBuildIterations ?? null;
  return max ? `${view.iteration || 0} / ${max}` : String(view?.iteration || 0);
}

/**
 * The plan approval badge. Never says "approved by you" unless the user confirmed (by: "user").
 * Returns { state, label, tone, model, specVersion, sha }.
 */
export function approvalBadge(view) {
  const lastReview = view?.reviews?.length ? view.reviews[view.reviews.length - 1] : null;
  if (view?.confirmation && view.confirmation.by === "user") {
    return { state: "confirmed", label: "Confirmed by you", tone: "good", model: view.approval?.model || null, specVersion: view.confirmation.specVersion, sha: view.confirmation.specSha256 };
  }
  if (view?.approval && view.approval.by === "model") {
    const name = shortModelName(view.approval.model);
    if (view.autonomy === "confirm_plan") {
      return { state: view.status === "awaiting_confirmation" ? "awaiting" : "model", label: `Approved by ${name}${view.status === "awaiting_confirmation" ? "; waiting for you to confirm" : ""}`, tone: view.status === "awaiting_confirmation" ? "warn" : "good", model: view.approval.model, specVersion: view.approval.specVersion ?? null, sha: view.approval.specSha256 || null };
    }
    return { state: "auto", label: `Auto-approved by ${name}`, tone: "good", model: view.approval.model, specVersion: view.approval.specVersion ?? null, sha: view.approval.specSha256 || null };
  }
  if (lastReview && lastReview.verdict === "revise") {
    return { state: "revise", label: `Changes requested by ${shortModelName(lastReview.reviewerModel)}`, tone: "warn", model: lastReview.reviewerModel, specVersion: lastReview.specVersion, sha: null };
  }
  if (view?.plan) return { state: "pending", label: "Waiting for an independent review", tone: "muted", model: null, specVersion: view.plan.specVersion, sha: null };
  return { state: "none", label: "No plan yet", tone: "muted", model: null, specVersion: null, sha: null };
}

/** The "Who's working" card. */
export function whoIsWorking(view) {
  const c = view?.current;
  if (isFinishedStatus(view?.status)) {
    return { idle: true, title: statusLabel(view.status), role: null, model: null, reason: "", escalation: null, purpose: null, tool: null };
  }
  if (!c) return { idle: true, title: "Starting up", role: null, model: null, reason: "", escalation: null, purpose: null, tool: null };
  const latestEsc = c.escalation || null;
  const tool = view.lastTool && view.lastTool.role === c.role ? view.lastTool.text : null;
  return {
    idle: false,
    title: roleLabel(c.role),
    role: c.role,
    model: c.model,
    modelName: shortModelName(c.model),
    tier: c.tier,
    reason: c.reason || "",
    rule: c.rule || null,
    pinned: c.pinned,
    purpose: c.purpose || (c.itemId ? `${c.role === "builder" ? "build" : c.role === "tester" ? "test" : c.role} ${c.itemId}` : null),
    attempt: c.attempt,
    itemId: c.itemId,
    escalation: latestEsc,
    active: c.active,
    tool,
  };
}

/** One row per role used so far: which model does what, and the router's reason. */
export function modelsTable(view) {
  const order = ["intake", "researcher", "planner", "reviewer", "builder", "tester", "reflector", "reporter", "vision"];
  const rows = [];
  for (const role of order) {
    const routes = (view?.routes || []).filter((r) => r.role === role);
    if (!routes.length) continue;
    const models = [];
    for (const r of routes) if (r.model && !models.includes(r.model)) models.push(r.model);
    const last = routes[routes.length - 1];
    rows.push({ role, label: roleLabel(role), models, current: last.model, tier: last.tier, reason: last.reason, escalated: routes.some((r) => r.escalated), pinned: last.pinned });
  }
  return rows;
}

const ITEM_STATUS_LABELS = { pending: "Waiting", building: "Building", built: "Built, waiting for tests", testing: "Testing", retrying: "Failed a check, retrying", passed: "Passed", failed: "Failed" };
export function itemStatusLabel(status) {
  return ITEM_STATUS_LABELS[status] || statusLabel(status);
}

// ---------------------------------------------------------------- fact check (Shelf Life) rows

const VERDICT_LABELS = { fresh: "Current", stale: "Stale", unsure: "Unsure" };

/**
 * Normalises a FactCheck report (plan-check-v<N>.json or fact-check.json), or the claims folded
 * from shelflife.* events, into display rows. Never labels anything "Confirmed".
 */
export function factCheckRows(report, view = null) {
  let findings = [];
  if (report && Array.isArray(report.findings)) findings = report.findings;
  else if (view && view.shelfLife && view.shelfLife.order.length) findings = view.shelfLife.order.map((id) => view.shelfLife.claims[id]);
  return findings.filter((f) => f && typeof f === "object").map((f) => {
    const checks = Array.isArray(f.checks) ? f.checks.map((c) => ({ check: String(c.check || ""), passed: c.passed === true, detail: String(c.detail ?? "") })) : [];
    const independent = checks.find((c) => c.check === "independent_sources");
    const supported = checks.find((c) => c.check === "correction_supported");
    const verdict = ["fresh", "stale", "unsure"].includes(f.verdict) ? f.verdict : "unsure";
    return {
      claimId: String(f.claimId ?? ""),
      statement: String(f.statement ?? f.quote ?? ""),
      quote: f.quote ? String(f.quote) : null,
      category: f.category || "other",
      verdict,
      verdictLabel: VERDICT_LABELS[verdict],
      oldValue: f.quote ? String(f.quote) : null,
      proposedValue: verdict === "stale" ? (f.correction ? String(f.correction) : f.currentValue ? String(f.currentValue) : null) : null,
      currentValue: f.currentValue ? String(f.currentValue) : null,
      sources: normalizeSources(f.sources, 2),
      checks,
      forcedRevision: verdict === "stale" && independent?.passed === true && supported?.passed === true,
      independentNote: independent?.passed ? "Two different sites contained the value (mechanical check); editorial independence not reviewed." : null,
    };
  });
}

/** Summary line for a plan check or fact check entry plus its loaded report (if any). */
export function factCheckSummary(entry, report = null) {
  if (!entry) return { verified: false, text: "Not run yet." };
  const status = report?.status || entry.status;
  if (status === "running") return { verified: false, text: "Checking against live sources…" };
  if (status === "skipped" || status === "failed") return { verified: false, text: `Not verified: ${report?.reason || entry.reason || status}.` };
  const rows = report ? factCheckRows(report) : [];
  const total = report ? rows.length : entry.findingCount;
  const stale = report ? rows.filter((r) => r.verdict === "stale").length : entry.staleCount;
  const fresh = report ? rows.filter((r) => r.verdict === "fresh").length : null;
  const unsure = report ? rows.filter((r) => r.verdict === "unsure").length : null;
  const parts = [];
  if (fresh !== null) parts.push(`${fresh} current`);
  if (Number.isFinite(stale)) parts.push(`${stale} stale`);
  if (unsure) parts.push(`${unsure} unsure`);
  return { verified: true, total, stale, text: `${count(total, "fact")} checked${parts.length ? `: ${parts.join(", ")}` : ""}.` };
}
