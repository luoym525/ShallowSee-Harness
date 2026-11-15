// mock-server.mjs: a stand-in for the console server (brief 07) so the web UI can be built and shown
// without the engine. Serves the static UI plus the endpoints from contracts/http-api.md, with canned
// data and a SYNTHETIC replay of fixtures/sample-run.jsonl. It never holds an API key: typed keys are
// reduced to a "sk-…ab12" preview and dropped.
//
//   node harness/console/web/dev/mock-server.mjs            → UI + API on http://127.0.0.1:4320,
//                                                              product preview on http://127.0.0.1:4321
//   MOCK_SPEED=20 node …                                     → faster replay (default 10; a run takes about a minute)
//   PORT=0 PREVIEW_PORT=0 …                                  → pick free ports (used by tests)
//
// Fetch-models scenarios (by base URL host): deepseek → 401, 127.0.0.1:11434 → can't reach, example.com → no list
// endpoint (404), "empty" in the URL → empty list, anything else → a list of models.

import http from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonl, reduceRun } from "../model.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "..");
const FIXTURE_JSONL = join(WEB_DIR, "fixtures", "sample-run.jsonl");
const FIXTURE_DIR = join(WEB_DIR, "fixtures", "sample-run");
const SAMPLE_ID = "hr-20261115-013012-a1b2";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".jsonl": "text/plain; charset=utf-8" };

const PRESETS = [
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", website: "https://console.anthropic.com", keyRequired: true, keyHint: "Starts with sk-ant-…; create one at console.anthropic.com", models: ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((id) => ({ id, enabled: true })) },
  { id: "openai", name: "OpenAI", kind: "openai_compatible", baseUrl: "https://api.openai.com/v1", website: "https://platform.openai.com", keyRequired: true, keyHint: "Starts with sk-…; create one at platform.openai.com", models: [] },
  { id: "deepseek", name: "DeepSeek", kind: "openai_compatible", baseUrl: "https://api.deepseek.com", website: "https://platform.deepseek.com", keyRequired: true, keyHint: "Create one at platform.deepseek.com", models: [] },
  { id: "gemini", name: "Gemini", kind: "openai_compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", website: "https://aistudio.google.com", keyRequired: true, keyHint: "Create one in Google AI Studio", models: [] },
  { id: "openrouter", name: "OpenRouter", kind: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1", website: "https://openrouter.ai", keyRequired: true, keyHint: "Starts with sk-or-…; create one at openrouter.ai/keys", models: [] },
  { id: "ollama", name: "Ollama (local)", kind: "openai_compatible", baseUrl: "http://127.0.0.1:11434/v1", website: "https://ollama.com", keyRequired: false, keyHint: "No key needed for a local Ollama", models: [] },
  { id: "custom", name: "Custom", kind: "openai_compatible", baseUrl: "", website: "", keyRequired: true, keyHint: "Any OpenAI-compatible endpoint", models: [] },
  { id: "linkup", name: "Linkup", kind: "linkup", baseUrl: "https://api.linkup.so/v1", website: "https://www.linkup.so", keyRequired: true, keyHint: "Web search for the research and fact-check steps; create one at linkup.so", models: [] },
  { id: "github", name: "GitHub", kind: "github", baseUrl: "https://api.github.com", website: "https://github.com", keyRequired: false, keyHint: "Optional; nothing in a run pushes", models: [] },
];

const CATALOG_TIER = { "claude-fable-5-2": 3, "claude-opus-5-5": 3, "claude-sonnet-5-5": 2, "claude-haiku-5-5": 1 };

function claudeModel(id, label) {
  return { id, label, enabled: true, tier: CATALOG_TIER[id], capabilities: ["reasoning", "coding", "tools", "json", "long_context"], catalogMatched: true };
}

function seedConfig() {
  return {
    version: 1,
    providers: [
      { id: "anthropic", name: "Anthropic (official)", preset: "anthropic", kind: "anthropic", enabled: true, notes: "Company account", website: "https://console.anthropic.com", baseUrl: "https://api.anthropic.com", apiKey: { hasKey: true, preview: "sk-…ab12" }, headers: {}, models: [claudeModel("claude-fable-5-2", "Claude Fable 5.2"), claudeModel("claude-opus-5-5", "Claude Opus 5.5"), claudeModel("claude-sonnet-5-5", "Claude Sonnet 5.5"), claudeModel("claude-haiku-5-5", "Claude Haiku 5.5")] },
      { id: "openrouter", name: "OpenRouter", preset: "openrouter", kind: "openai_compatible", enabled: true, notes: "", website: "https://openrouter.ai", baseUrl: "https://openrouter.ai/api/v1", apiKey: { hasKey: true, preview: "sk-…9f3c" }, headers: {}, models: [{ id: "synthetic-large-1", label: "Synthetic large (example)", enabled: true, tier: 3, catalogMatched: false }, { id: "synthetic-small-1", label: "Synthetic small (example)", enabled: true, catalogMatched: false }] },
      { id: "linkup", name: "Linkup (web search)", preset: "linkup", kind: "linkup", enabled: true, notes: "Used for research and fact checks", website: "https://www.linkup.so", baseUrl: "https://api.linkup.so/v1", apiKey: { hasKey: true, preview: "lk-…77de" }, headers: {}, models: [] },
      { id: "github", name: "GitHub", preset: "github", kind: "github", enabled: false, notes: "Optional", website: "https://github.com", baseUrl: "https://api.github.com", apiKey: { hasKey: false, preview: "" }, headers: {}, models: [] },
    ],
    routing: { autonomy: "full", overrides: {}, preferVendorDiversity: true },
    budget: { maxUsdPerRun: 5, maxMinutesPerRun: 40, maxBuildIterations: 12 },
  };
}

const ROLES = ["intake", "researcher", "planner", "reviewer", "builder", "tester", "reflector", "reporter", "vision"];
const ROLE_TIER = { intake: 1, researcher: 2, planner: 3, reviewer: 3, builder: 1, tester: 2, reflector: 2, reporter: 1 };
const ROLE_REASON = {
  intake: "Turning a wish into a brief is a short structured task, so the cheapest tier is enough",
  researcher: "Research needs good reading and web search, so a mid tier is used",
  planner: "Planning decides everything downstream, so it gets the strongest model provided",
  reviewer: "An independent reviewer: the strongest model that isn't the planner",
  builder: "The coder starts at the cheapest tier and escalates after failed tests",
  tester: "The tester must differ from the builder, so it is a mid tier model",
  reflector: "Reflection reads failing evidence and writes fix instructions: mid tier",
  reporter: "Summarising verified artifacts is easy, so the cheapest tier is enough",
};

export function createMockServer(opts = {}) {
  const speed = Number(opts.speed ?? process.env.MOCK_SPEED ?? 10);
  const sampleEvents = parseJsonl(readFileSync(FIXTURE_JSONL, "utf8"));
  let config = seedConfig();
  const runs = new Map();
  const sockets = new Set();

  // ------------------------------------------------------------ runs
  function addRun(id) {
    const run = { id, events: [], listeners: new Set(), closed: false, timer: null, waitingConfirm: null, artifacts: new Set(["wish.txt"]) };
    runs.set(id, run);
    return run;
  }
  function push(run, env) {
    run.events.push(env);
    if (env.type === "artifact.registered" && env.payload?.artifactId) run.artifacts.add(env.payload.artifactId);
    if (env.type === "room.closed") run.closed = true;
    for (const l of run.listeners) l(env);
  }
  // the finished sample run, available instantly
  {
    const run = addRun(SAMPLE_ID);
    for (const e of sampleEvents) push(run, e);
    for (const f of listArtifactFiles()) run.artifacts.add(f);
  }

  function startReplay(wish, autonomy) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const id = `hr-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}-${Math.random().toString(36).slice(2, 6).replace(/[^a-z0-9]/g, "x")}`;
    const run = addRun(id);
    const steps = sampleEvents.map((e) => JSON.parse(JSON.stringify(e).split(SAMPLE_ID).join(id)));
    steps[0].payload.goal = wish;
    steps[0].payload.autonomy = autonomy;
    let i = 0;
    let seq = 0;
    const emit = (env) => { seq += 1; push(run, { ...env, seq, eventId: `evt-${id}-${String(seq).padStart(4, "0")}`, roomId: id, timestamp: new Date().toISOString() }); };
    const tick = () => {
      if (run.closed) return;
      if (i >= steps.length) return;
      const env = steps[i];
      const prev = i > 0 ? Date.parse(steps[i - 1].timestamp) : null;
      const gap = prev === null ? 0 : Math.min(2200, Math.max(60, (Date.parse(env.timestamp) - prev) / speed));
      run.timer = setTimeout(() => {
        emit(env);
        i += 1;
        const isApproval = env.type === "harness.plan.reviewed" && env.payload.approval;
        if (isApproval && autonomy === "confirm_plan") {
          emit({ type: "harness.phase.changed", provenance: env.provenance, payload: { phase: "awaiting_confirmation", previous: "plan_review", iteration: 0, itemId: null } });
          run.waitingConfirm = () => {
            run.waitingConfirm = null;
            emit({ type: "harness.plan.confirmed", provenance: env.provenance, payload: { by: "user", at: new Date().toISOString(), specVersion: env.payload.specVersion, specSha256: env.payload.specSha256 } });
            tick();
          };
          return;
        }
        tick();
      }, gap);
    };
    tick();
    return id;
  }

  function stateOf(run) {
    const v = reduceRun(run.events, run.id);
    const items = {};
    for (const it of v.items) items[it.id] = { status: it.status === "built" || it.status === "retrying" ? "testing" : it.status, attempts: it.attempts, lastScore: it.lastScore };
    const roleModels = {};
    for (const [r, m] of Object.entries(v.modelsByRole)) roleModels[r] = m.model;
    return {
      runId: run.id, wish: v.wish || "", title: v.title, status: v.status, phase: v.phase || "intake", autonomy: v.autonomy, approval: v.approval, iteration: v.iteration,
      currentItemId: v.currentItemId, items, best: v.best && v.best.commit ? { commit: v.best.commit, score: v.best.score } : null, models: roleModels,
      spend: { usd: v.spend.usd, usdSource: v.spend.source, calls: v.spend.calls, inputTokens: v.spend.inputTokens, outputTokens: v.spend.outputTokens },
      limits: { maxUsdPerRun: v.limits?.maxUsd ?? 5, maxMinutesPerRun: v.limits?.maxMinutes ?? 40, maxBuildIterations: v.limits?.maxRuns ?? 12 },
      startedAt: v.startedAt, updatedAt: v.lastEventAt, finishedAt: v.finishedAt, error: null,
      previewPath: v.finished?.previewPath ?? null, finalScore: v.finished?.finalScore ?? v.finalTest?.score ?? null, synthetic: v.synthetic,
    };
  }

  function listArtifactFiles(dir = FIXTURE_DIR, prefix = "") {
    const out = [];
    for (const name of readdirSync(dir)) {
      if (name === "workspace") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...listArtifactFiles(p, `${prefix}${name}/`));
      else out.push(`${prefix}${name}`);
    }
    return out;
  }
  function listWorkspace(dir = join(FIXTURE_DIR, "workspace"), prefix = "") {
    if (!existsSync(dir)) return [];
    const out = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...listWorkspace(p, `${prefix}${name}/`));
      else out.push(`${prefix}${name}`);
    }
    return out.sort();
  }

  // ------------------------------------------------------------ config helpers
  const preview = (key) => (key.length >= 12 ? `${key.slice(0, 3)}…${key.slice(-4)}` : "set");
  const slug = (s) => String(s || "provider").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "provider";
  function validateProviderInput(input, existing) {
    const issues = [];
    const baseUrl = input.baseUrl ?? existing?.baseUrl ?? "";
    if (!existing && !String(input.name ?? "").trim()) issues.push({ path: "name", message: "Give the provider a name." });
    if (!/^https:\/\/[^\s/]+/.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(baseUrl)) issues.push({ path: "baseUrl", message: "The request URL must start with https:// (http:// is allowed only for 127.0.0.1 or localhost)." });
    for (const m of input.models || []) if (m.tier !== undefined && ![1, 2, 3].includes(m.tier)) issues.push({ path: `models.${m.id}.tier`, message: "Tier must be 1, 2 or 3." });
    return issues;
  }
  function applyInput(base, input) {
    const p = { ...base };
    for (const k of ["name", "preset", "kind", "enabled", "notes", "website", "baseUrl"]) if (input[k] !== undefined) p[k] = input[k];
    if (input.apiKey === null) p.apiKey = { hasKey: false, preview: "" };
    else if (typeof input.apiKey === "string" && input.apiKey) p.apiKey = { hasKey: true, preview: preview(input.apiKey) };
    if (input.headers === null) p.headers = {};
    else if (input.headers && typeof input.headers === "object") p.headers = Object.fromEntries(Object.keys(input.headers).map((k) => [k, "•••"]));
    if (Array.isArray(input.models)) p.models = input.models.map((m) => ({ ...m, catalogMatched: CATALOG_TIER[m.id] !== undefined }));
    return p;
  }
  function routingRows() {
    const models = [];
    for (const p of config.providers) {
      if (!p.enabled || p.kind === "linkup" || p.kind === "github") continue;
      if (!p.apiKey.hasKey && p.preset !== "ollama") continue;
      for (const m of p.models) if (m.enabled !== false) models.push({ ref: `${p.id}/${m.id}`, tier: m.tier ?? CATALOG_TIER[m.id] ?? 2 });
    }
    const byTier = (tier) => models.filter((x) => x.tier === tier);
    const pick = (tier) => {
      const exact = byTier(tier);
      if (exact.length) return exact[0];
      const lower = models.filter((x) => x.tier < tier).sort((p, q) => q.tier - p.tier)[0];
      return lower || [...models].sort((p, q) => p.tier - q.tier)[0] || null;
    };
    return ROLES.map((role) => {
      const pinRef = config.routing.overrides[role];
      if (pinRef) {
        const m = models.find((x) => x.ref === pinRef);
        return { role, model: pinRef, tier: m?.tier ?? null, reason: "You pinned this model", pinned: true };
      }
      if (role === "vision") return { role, model: null, tier: null, reason: "No model with vision is configured; image checks are skipped", pinned: false };
      if (!models.length) return { role, model: null, tier: null, reason: "No models yet: add a provider on the Setup page", pinned: false };
      const top = byTier(3);
      const m = role === "reviewer" ? (top[1] || top[0] || pick(3)) : pick(ROLE_TIER[role]);
      return { role, model: m ? m.ref : null, tier: m ? m.tier : null, reason: ROLE_REASON[role], pinned: false };
    });
  }
  function usableModels() {
    return config.providers.some((p) => p.enabled && p.apiKey.hasKey && (p.kind === "anthropic" || p.kind === "openai_compatible") && p.models.some((m) => m.enabled !== false));
  }

  // ------------------------------------------------------------ HTTP helpers
  const send = (res, status, body, headers = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(text);
  };
  const fail = (res, status, code, message, extra = {}) => send(res, status, { error: { code, message, ...extra } });
  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 256 * 1024) throw Object.assign(new Error("Body too large"), { status: 413 }); chunks.push(c); }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text.trim()) return {};
    try { return JSON.parse(text); } catch { throw Object.assign(new Error("Body is not valid JSON"), { status: 400 }); }
  }
  function sendFile(res, file, extraHeaders = {}) {
    try {
      const data = readFileSync(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders });
      res.end(data);
    } catch { fail(res, 404, "not_found", "File not found."); }
  }
  function insideDir(root, rel) {
    const target = normalize(join(root, rel));
    return target === root || target.startsWith(root + sep) ? target : null;
  }

  function handleStream(req, res, run, afterQuery) {
    const last = Number(req.headers["last-event-id"]);
    let after = Number.isFinite(last) && last > 0 ? last : Number(afterQuery) || 0;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": connected\n\n");
    const write = (env) => { if (env.seq > after) { after = env.seq; res.write(`id: ${env.seq}\nevent: harness\ndata: ${JSON.stringify(env)}\n\n`); } };
    const finish = () => { res.write("event: end\ndata: {}\n\n"); res.end(); };
    for (const env of run.events) write(env);
    if (run.closed) return finish();
    const onEvent = (env) => { write(env); if (env.type === "room.closed") { run.listeners.delete(onEvent); clearInterval(beat); finish(); } };
    run.listeners.add(onEvent);
    const beat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => { run.listeners.delete(onEvent); clearInterval(beat); });
  }

  // ------------------------------------------------------------ control server (port 4320)
  async function handleApi(req, res, url) {
    const path = url.pathname;
    const method = req.method;
    let m;
    if (method !== "GET" && method !== "HEAD") {
      if (!/^application\/json/i.test(req.headers["content-type"] || "")) return fail(res, 415, "unsupported_media_type", "Send JSON with Content-Type: application/json.");
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return fail(res, 403, "forbidden_origin", "Requests from other origins are not allowed.");
    }
    if (method === "GET" && path === "/api/health") return send(res, 200, { ok: true, version: "harness.console.v1", configPath: "(mock: in memory)", hasConfig: true, mock: true });
    if (method === "GET" && path === "/api/presets") return send(res, 200, { presets: PRESETS });
    if (method === "GET" && path === "/api/config") {
      const issues = config.providers.filter((p) => p.enabled && (p.kind === "anthropic" || p.kind === "openai_compatible") && !p.apiKey.hasKey && p.preset !== "ollama").map((p) => ({ path: `providers.${p.id}.apiKey`, message: "No API key set." }));
      return send(res, 200, { config, validation: { ok: true, errors: [], warnings: issues } });
    }
    if (method === "POST" && path === "/api/providers") {
      const input = await readJson(req);
      const issues = validateProviderInput(input);
      if (issues.length) return fail(res, 400, "invalid_config", "The provider has problems.", { issues });
      let id = slug(input.name);
      while (config.providers.some((p) => p.id === id)) id = `${id.slice(0, 36)}-${Math.random().toString(36).slice(2, 5)}`;
      const base = { id, name: "", preset: "custom", kind: "openai_compatible", enabled: true, notes: "", website: "", baseUrl: "", apiKey: { hasKey: false, preview: "" }, headers: {}, models: [] };
      const provider = applyInput(base, input);
      config.providers.push(provider);
      return send(res, 201, { provider });
    }
    if ((m = /^\/api\/providers\/([a-z0-9-]+)(?:\/(test|fetch-models))?$/.exec(path))) {
      const idx = config.providers.findIndex((p) => p.id === m[1]);
      if (idx === -1) return fail(res, 404, "not_found", "No such provider.");
      const provider = config.providers[idx];
      if (!m[2] && method === "PUT") {
        const input = await readJson(req);
        const issues = validateProviderInput(input, provider);
        if (issues.length) return fail(res, 400, "invalid_config", "The provider has problems.", { issues });
        config.providers[idx] = applyInput(provider, input);
        return send(res, 200, { provider: config.providers[idx] });
      }
      if (!m[2] && method === "DELETE") { config.providers.splice(idx, 1); return send(res, 200, { ok: true }); }
      if (m[2] === "test" && method === "POST") {
        await new Promise((r) => setTimeout(r, 450));
        const keyless = provider.preset === "ollama" || provider.preset === "github";
        if (!provider.apiKey.hasKey && !keyless) return send(res, 200, { ok: false, latencyMs: null, detail: "No API key set." });
        if (/127\.0\.0\.1:11434/.test(provider.baseUrl)) return send(res, 200, { ok: false, latencyMs: null, detail: "Couldn't reach the provider at the request URL." });
        if (/deepseek/.test(provider.baseUrl)) return send(res, 200, { ok: false, latencyMs: 212, detail: "Key rejected (401)." });
        const models = provider.kind === "linkup" || provider.kind === "github" ? undefined : provider.models.length;
        return send(res, 200, { ok: true, latencyMs: 180 + Math.floor(Math.random() * 220), detail: models === undefined ? "Connected." : `Connected. ${models || 4} models available.` });
      }
      if (m[2] === "fetch-models" && method === "POST") {
        await new Promise((r) => setTimeout(r, 500));
        if (provider.kind === "linkup" || provider.kind === "github") return fail(res, 400, "not_a_model_provider", "This provider has no models.");
        const u = provider.baseUrl;
        if (/deepseek/.test(u)) return fail(res, 401, "auth", "Key rejected (401).");
        if (/127\.0\.0\.1:11434/.test(u)) return fail(res, 502, "network", "Couldn't reach the provider.");
        if (/example\.com/.test(u)) return fail(res, 404, "not_found", "This provider has no model list endpoint.");
        if (/empty/.test(u)) return send(res, 200, { models: [] });
        const have = provider.models.map((x) => x.id);
        const listed = provider.kind === "anthropic" ? ["claude-fable-5-2", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"] : ["synthetic-large-1", "synthetic-medium-1", "synthetic-small-1", "synthetic-vision-1", "synthetic-embed-1"];
        return send(res, 200, { models: [...new Set([...have, ...listed])].sort() });
      }
      return fail(res, 405, "method_not_allowed", "Method not allowed.");
    }
    if (method === "PUT" && path === "/api/routing") {
      const input = await readJson(req);
      if (input.autonomy !== undefined && !["full", "confirm_plan"].includes(input.autonomy)) return fail(res, 400, "invalid_config", "autonomy must be full or confirm_plan.");
      config.routing = { ...config.routing, ...(input.autonomy !== undefined ? { autonomy: input.autonomy } : {}), ...(input.overrides !== undefined ? { overrides: input.overrides } : {}), ...(input.preferVendorDiversity !== undefined ? { preferVendorDiversity: !!input.preferVendorDiversity } : {}) };
      return send(res, 200, { routing: config.routing });
    }
    if (method === "PUT" && path === "/api/budget") {
      const input = await readJson(req);
      for (const k of ["maxUsdPerRun", "maxMinutesPerRun", "maxBuildIterations"]) if (input[k] !== undefined && !(Number(input[k]) > 0)) return fail(res, 400, "invalid_config", `${k} must be a positive number.`);
      config.budget = { ...config.budget, ...Object.fromEntries(Object.entries(input).filter(([k]) => k in config.budget).map(([k, v]) => [k, Number(v)])) };
      return send(res, 200, { budget: config.budget });
    }
    if (method === "GET" && path === "/api/routing/preview") return send(res, 200, { rows: routingRows() });

    if (method === "POST" && path === "/api/runs") {
      const input = await readJson(req);
      const wish = typeof input.wish === "string" ? input.wish.trim() : "";
      if (!wish || wish.length > 2000) return fail(res, 400, "invalid_wish", "Describe what you want in 1 to 2000 characters.");
      if (!usableModels()) return fail(res, 409, "no_models", "No models are set up yet. Add a provider on the Setup page first.");
      const autonomy = input.autonomy || config.routing.autonomy;
      return send(res, 202, { runId: startReplay(wish, autonomy) });
    }
    if (method === "GET" && path === "/api/runs") {
      const list = [...runs.values()].map(stateOf).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      return send(res, 200, { runs: list });
    }
    if ((m = /^\/api\/runs\/(hr-\d{8}-\d{6}-[a-z0-9]{4})(?:\/(.*))?$/.exec(path))) {
      const run = runs.get(m[1]);
      if (!run) return fail(res, 404, "not_found", "No such run.");
      const rest = m[2] || "";
      if (!rest && method === "GET") return send(res, 200, { state: stateOf(run), artifacts: [...run.artifacts].sort() });
      if (rest === "events" && method === "GET") {
        const after = Number(url.searchParams.get("after")) || 0;
        const events = run.events.filter((e) => e.seq > after).slice(0, 500);
        return send(res, 200, { events, nextAfter: events.length ? events[events.length - 1].seq : after });
      }
      if (rest === "stream" && method === "GET") return handleStream(req, res, run, url.searchParams.get("after"));
      if (rest.startsWith("artifacts/") && method === "GET") {
        const name = decodeURIComponent(rest.slice("artifacts/".length));
        if (!run.artifacts.has(name)) return fail(res, 404, "not_found", "No such artifact.");
        const file = insideDir(FIXTURE_DIR, name);
        return file ? sendFile(res, file) : fail(res, 400, "bad_path", "Bad path.");
      }
      if (rest === "files" && method === "GET") return send(res, 200, { files: listWorkspace() });
      if (rest.startsWith("files/") && method === "GET") {
        const rel = decodeURIComponent(rest.slice(6));
        const file = insideDir(join(FIXTURE_DIR, "workspace"), rel);
        if (!file || !existsSync(file)) return fail(res, 404, "not_found", "No such file.");
        if (!/\.(html|css|js|mjs|json|md|txt)$/i.test(file)) return fail(res, 415, "binary", "Binary files can't be shown.");
        return sendFile(res, file, { "Content-Type": "text/plain; charset=utf-8" });
      }
      if (rest === "cancel" && method === "POST") {
        if (run.closed) return send(res, 200, { ok: true });
        clearTimeout(run.timer);
        const seq = run.events.length + 1;
        const base = { schemaVersion: 1, roomId: run.id, timestamp: new Date().toISOString(), provenance: { memberId: null, role: "engine", mode: "system", provider: null, model: null, identitySource: "configured" } };
        push(run, { ...base, eventId: `evt-${run.id}-c${seq}`, seq, type: "harness.run.finished", payload: { status: "cancelled", summary: "Cancelled by you.", finalScore: null, allPassed: false, candidate: null, specVersion: null, reportPath: null, previewPath: null, spentUsd: null, minutes: null } });
        push(run, { ...base, eventId: `evt-${run.id}-c${seq + 1}`, seq: seq + 1, type: "room.closed", payload: { status: "cancelled", summary: "Cancelled by you." } });
        return send(res, 200, { ok: true });
      }
      if (rest === "confirm" && method === "POST") {
        if (run.waitingConfirm) { run.waitingConfirm(); return send(res, 200, { ok: true }); }
        return send(res, 200, { ok: false });
      }
    }
    return fail(res, 404, "not_found", "No such endpoint.");
  }

  function hostOk(req, port) {
    const h = String(req.headers.host || "");
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  }

  const control = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req, control.address().port)) return fail(res, 403, "bad_host", "Unexpected Host header.");
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "method_not_allowed", "Method not allowed.");
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (!rel) rel = "index.html";
      let file = insideDir(WEB_DIR, rel);
      const blocked = !file || /^(dev|screenshots)(\/|$)/.test(relative(WEB_DIR, file).split(sep).join("/")) || /\.test\.mjs$/.test(file);
      if (blocked || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIR, "index.html");
      sendFile(res, file);
    } catch (e) {
      fail(res, e.status || 500, e.status === 400 ? "bad_request" : "internal", e.status ? e.message : "Mock server error.");
    }
  });
  control.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });

  // ------------------------------------------------------------ preview server (port 4321), separate origin
  const preview_ = http.createServer((req, res) => {
    if (!hostOk(req, preview_.address().port)) return fail(res, 403, "bad_host", "Unexpected Host header.");
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "method_not_allowed", "Method not allowed.");
    const url = new URL(req.url, "http://localhost");
    const m = /^\/(hr-\d{8}-\d{6}-[a-z0-9]{4})\/(.*)$/.exec(url.pathname);
    if (!m || !runs.has(m[1])) return fail(res, 404, "not_found", "No such run.");
    const file = insideDir(join(FIXTURE_DIR, "workspace"), decodeURIComponent(m[2]) || "index.html");
    if (!file || !existsSync(file) || statSync(file).isDirectory()) return fail(res, 404, "not_found", "No such file.");
    sendFile(res, file, { "Content-Security-Policy": "frame-ancestors 'none'" });
  });
  preview_.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });

  return {
    sampleRunId: SAMPLE_ID,
    async listen(port = Number(process.env.PORT ?? 4320), previewPort = Number(process.env.PREVIEW_PORT ?? 4321)) {
      await new Promise((r) => control.listen(port, "127.0.0.1", r));
      await new Promise((r) => preview_.listen(previewPort, "127.0.0.1", r));
      return { url: `http://127.0.0.1:${control.address().port}`, previewUrl: `http://127.0.0.1:${preview_.address().port}` };
    },
    async close() {
      for (const r of runs.values()) { clearTimeout(r.timer); }
      for (const s of sockets) s.destroy();
      await new Promise((r) => control.close(r));
      await new Promise((r) => preview_.close(r));
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const server = createMockServer();
  const { url, previewUrl } = await server.listen();
  console.log(`ShallowSee console MOCK (synthetic data) on ${url}\nProduct preview origin: ${previewUrl}\nSample finished run: ${url}/#/runs/${server.sampleRunId}\nStart a run from ${url}/#/new to watch a synthetic replay.`);
}
