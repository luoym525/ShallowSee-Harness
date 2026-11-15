import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createMockServer } from "./mock-server.mjs";

let mock, base, previewBase, port;
const JSON_HEADERS = { "Content-Type": "application/json" };
const FAKE_KEY = "unit-test-key-abcdef0123456789";

before(async () => {
  mock = createMockServer({ speed: 5000 });
  const urls = await mock.listen(0, 0);
  base = urls.url;
  previewBase = urls.previewUrl;
  port = new URL(base).port;
});
after(async () => { await mock.close(); });

const j = async (path, init) => { const r = await fetch(base + path, init); return { status: r.status, body: await r.json(), headers: r.headers }; };
const post = (path, body) => j(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
const put = (path, body) => j(path, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(body) });

function rawRequest(host, path, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: host, ...extraHeaders } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end();
  });
}

test("serves the web UI and falls back to index.html for hash-route paths; dev files stay private", async () => {
  const idx = await fetch(base + "/");
  assert.equal(idx.status, 200);
  assert.match(await idx.text(), /<title>ShallowSee Autopilot<\/title>/);
  assert.match((await fetch(base + "/model.mjs")).headers.get("content-type"), /javascript/);
  assert.match(await (await fetch(base + "/some/unknown/route")).text(), /<title>ShallowSee Autopilot<\/title>/);
  assert.match(await (await fetch(base + "/dev/mock-server.mjs")).text(), /<title>ShallowSee Autopilot<\/title>/);
  assert.match(await (await fetch(base + "/model.test.mjs")).text(), /<title>ShallowSee Autopilot<\/title>/);
  assert.equal((await fetch(base + "/..%2f..%2fREADME.md")).status, 200); // collapses to index.html, never a file outside the folder
});

test("rejects foreign Host headers, non-JSON writes and foreign origins", async () => {
  assert.equal(await rawRequest("evil.example", "/api/health"), 403);
  assert.equal(await rawRequest(`localhost:${port}`, "/api/health"), 200);
  const noType = await fetch(base + "/api/runs", { method: "POST", body: JSON.stringify({ wish: "x" }) });
  assert.equal(noType.status, 415);
  const foreign = await fetch(base + "/api/runs", { method: "POST", headers: { ...JSON_HEADERS, Origin: "http://127.0.0.1:4321" }, body: JSON.stringify({ wish: "x" }) });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  const del = await fetch(base + "/api/providers/nope", { method: "DELETE" });
  assert.equal(del.status, 415);
});

test("health, presets and config match the contract shapes", async () => {
  const health = await j("/api/health");
  assert.equal(health.body.ok, true);
  assert.equal(health.body.version, "harness.console.v1");
  const { presets } = (await j("/api/presets")).body;
  assert.deepEqual(presets.map((p) => p.id).sort(), ["anthropic", "custom", "deepseek", "gemini", "github", "linkup", "ollama", "openai", "openrouter"]);
  assert.deepEqual(presets.find((p) => p.id === "anthropic").models.map((m) => m.id), ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  assert.equal(presets.find((p) => p.id === "ollama").keyRequired, false);
  const { config, validation } = (await j("/api/config")).body;
  assert.equal(config.version, 1);
  assert.equal(validation.ok, true);
  for (const p of config.providers) assert.deepEqual(Object.keys(p.apiKey).sort(), ["hasKey", "preview"]);
});

test("API keys never appear in any response; update rules: missing keeps, null clears", async () => {
  const created = await post("/api/providers", { name: "Key test", preset: "custom", kind: "openai_compatible", baseUrl: "https://example.org/v1", apiKey: FAKE_KEY, headers: { "X-Secret": "header-secret-value" }, models: [{ id: "m1", enabled: true }] });
  assert.equal(created.status, 201);
  const id = created.body.provider.id;
  assert.deepEqual(created.body.provider.apiKey, { hasKey: true, preview: "uni…6789" });
  assert.deepEqual(created.body.provider.headers, { "X-Secret": "•••" });
  const everything = JSON.stringify([created.body, (await j("/api/config")).body, (await j("/api/routing/preview")).body, (await post(`/api/providers/${id}/test`, {})).body]);
  assert.equal(everything.includes(FAKE_KEY), false);
  assert.equal(everything.includes("header-secret-value"), false);
  const keep = await put(`/api/providers/${id}`, { notes: "changed" });
  assert.equal(keep.body.provider.apiKey.hasKey, true);
  assert.equal(keep.body.provider.notes, "changed");
  const cleared = await put(`/api/providers/${id}`, { apiKey: null });
  assert.deepEqual(cleared.body.provider.apiKey, { hasKey: false, preview: "" });
  const gone = await fetch(base + `/api/providers/${id}`, { method: "DELETE", headers: JSON_HEADERS });
  assert.equal(gone.status, 200);
  assert.equal((await j(`/api/providers/${id}`, { method: "PUT", headers: JSON_HEADERS, body: "{}" })).status, 404);
});

test("invalid provider input answers 400 invalid_config with issues", async () => {
  const bad = await post("/api/providers", { name: "Bad", baseUrl: "http://example.com/v1", apiKey: "x" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "invalid_config");
  assert.equal(bad.body.error.issues[0].path, "baseUrl");
  assert.equal((await post("/api/providers", { name: "Local ok", baseUrl: "http://127.0.0.1:11434/v1", preset: "ollama" })).status, 201);
});

test("fetch-models scenarios are distinct and test never throws a 500", async () => {
  const mk = async (name, baseUrl) => (await post("/api/providers", { name, baseUrl, apiKey: FAKE_KEY, preset: "custom", kind: "openai_compatible" })).body.provider.id;
  const auth = await post(`/api/providers/${await mk("Auth", "https://api.deepseek.com")}/fetch-models`, {});
  assert.equal(auth.status, 401);
  const none = await post(`/api/providers/${await mk("None", "https://example.com/v1")}/fetch-models`, {});
  assert.equal(none.status, 404);
  const empty = await post(`/api/providers/${await mk("Empty", "https://empty.test.org/v1")}/fetch-models`, {});
  assert.deepEqual(empty.body, { models: [] });
  const fine = await post(`/api/providers/${await mk("Fine", "https://api.openai.com/v1")}/fetch-models`, {});
  assert.ok(fine.body.models.length > 0);
  const t = await post(`/api/providers/${await mk("Rejected", "https://api.deepseek.com/v2")}/test`, {});
  assert.equal(t.status, 200);
  assert.equal(t.body.ok, false);
});

test("routing and budget updates validate and read back; preview rows cover every role", async () => {
  const rows = (await j("/api/routing/preview")).body.rows;
  assert.equal(rows.length, 9);
  assert.notEqual(rows.find((r) => r.role === "planner").model, rows.find((r) => r.role === "reviewer").model);
  assert.equal((await put("/api/routing", { autonomy: "sometimes" })).status, 400);
  assert.equal((await put("/api/routing", { overrides: { planner: "anthropic/claude-opus-5-5" } })).body.routing.overrides.planner, "anthropic/claude-opus-5-5");
  assert.equal((await j("/api/routing/preview")).body.rows.find((r) => r.role === "planner").pinned, true);
  await put("/api/routing", { overrides: {} });
  assert.equal((await put("/api/budget", { maxUsdPerRun: -1 })).status, 400);
  assert.equal((await put("/api/budget", { maxUsdPerRun: 7.5 })).body.budget.maxUsdPerRun, 7.5);
});

test("the finished sample run: state, events (paged), artifacts, files", async () => {
  const id = mock.sampleRunId;
  const run = (await j(`/api/runs/${id}`)).body;
  assert.equal(run.state.status, "delivered");
  assert.equal(run.state.synthetic, true);
  assert.equal(run.state.items.W2.attempts, 2);
  assert.ok(run.artifacts.includes("REPORT.md") && run.artifacts.includes("tests/002.json") && run.artifacts.includes("plan-check-v1.json"));
  const ev = (await j(`/api/runs/${id}/events?after=200`)).body;
  assert.equal(ev.events.length, 5);
  assert.equal(ev.nextAfter, 205);
  assert.equal((await j(`/api/runs/${id}/events?after=205`)).body.events.length, 0);
  const md = await fetch(base + `/api/runs/${id}/artifacts/REPORT.md`);
  assert.match(md.headers.get("content-type"), /markdown/);
  assert.equal((await fetch(base + `/api/runs/${id}/artifacts/..%2f..%2fmock-server.mjs`)).status, 404);
  assert.equal((await fetch(base + `/api/runs/${id}/artifacts/spec.json`)).status, 200);
  assert.deepEqual((await j(`/api/runs/${id}/files`)).body.files, ["README.md", "forecast.mjs", "index.html", "styles.css"]);
  assert.equal((await fetch(base + `/api/runs/${id}/files/index.html`)).status, 200);
  assert.equal((await j("/api/runs/hr-20200101-000000-zzzz")).status, 404);
  assert.equal((await j("/api/runs/not-a-run")).status, 404);
});

async function readSse(path, headers = {}) {
  const res = await fetch(base + path, { headers });
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const text = await res.text();
  const events = [...text.matchAll(/^id: (\d+)\nevent: harness\ndata: (.*)$/gm)].map((m) => ({ id: Number(m[1]), env: JSON.parse(m[2]) }));
  return { events, ended: /event: end/.test(text) };
}

test("SSE: full replay, resume with ?after and Last-Event-ID, ends after room.closed", async () => {
  const id = mock.sampleRunId;
  const all = await readSse(`/api/runs/${id}/stream`);
  assert.equal(all.events.length, 205);
  assert.equal(all.ended, true);
  assert.deepEqual(all.events.map((e) => e.id), all.events.map((e) => e.env.seq));
  assert.equal(all.events.at(-1).env.type, "room.closed");
  const after = await readSse(`/api/runs/${id}/stream?after=200`);
  assert.deepEqual(after.events.map((e) => e.id), [201, 202, 203, 204, 205]);
  const resumed = await readSse(`/api/runs/${id}/stream`, { "Last-Event-ID": "203" });
  assert.deepEqual(resumed.events.map((e) => e.id), [204, 205]);
});

test("starting a run replays the synthetic fixture with the typed wish, then finishes", async () => {
  const bad = await post("/api/runs", { wish: "" });
  assert.equal(bad.status, 400);
  const started = await post("/api/runs", { wish: "A page for my cat's schedule" });
  assert.equal(started.status, 202);
  assert.match(started.body.runId, /^hr-\d{8}-\d{6}-[a-z0-9]{4}$/);
  const stream = await readSse(`/api/runs/${started.body.runId}/stream`);
  assert.equal(stream.ended, true);
  assert.equal(stream.events[0].env.payload.goal, "A page for my cat's schedule");
  assert.equal(stream.events[0].env.payload.synthetic, true);
  assert.equal(stream.events[0].env.roomId, started.body.runId);
  assert.ok(stream.events.every((e, i) => e.id === i + 1));
  assert.equal((await j("/api/runs")).body.runs.some((r) => r.runId === started.body.runId), true);
});

test("confirm mode waits for POST /confirm; cancel closes the run", async () => {
  const started = await post("/api/runs", { wish: "confirm me", autonomy: "confirm_plan" });
  const id = started.body.runId;
  const deadline = Date.now() + 15000;
  let state;
  do { await new Promise((r) => setTimeout(r, 100)); state = (await j(`/api/runs/${id}`)).body.state; } while (state.status !== "awaiting_confirmation" && Date.now() < deadline);
  assert.equal(state.status, "awaiting_confirmation");
  assert.equal(state.approval.by, "model");
  const ok = await post(`/api/runs/${id}/confirm`, {});
  assert.deepEqual(ok.body, { ok: true });
  assert.deepEqual((await post(`/api/runs/${id}/confirm`, {})).body, { ok: false });
  const second = await post("/api/runs", { wish: "cancel me" });
  assert.deepEqual((await post(`/api/runs/${second.body.runId}/cancel`, {})).body, { ok: true });
  const stream = await readSse(`/api/runs/${second.body.runId}/stream`);
  assert.equal(stream.ended, true);
  assert.equal(stream.events.at(-1).env.payload.status, "cancelled");
});

test("no usable models → 409 no_models with a friendly message", async () => {
  const cfg = (await j("/api/config")).body.config;
  for (const p of cfg.providers) await put(`/api/providers/${p.id}`, { enabled: false });
  const r = await post("/api/runs", { wish: "anything" });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "no_models");
  assert.match(r.body.error.message, /Setup/);
});

test("the preview origin serves product files only, with the contract's headers, and no /api", async () => {
  const id = mock.sampleRunId;
  const page = await fetch(`${previewBase}/${id}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Umbrella Check/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'none'");
  assert.equal((await fetch(`${previewBase}/api/health`)).status, 404);
  assert.equal((await fetch(`${previewBase}/${id}/..%2f..%2fmock-server.mjs`)).status, 404);
  assert.equal((await fetch(`${previewBase}/${id}/`, { method: "POST" })).status, 405);
});
