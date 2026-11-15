import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseJsonl, reduceRun, createRunView, applyEvent, approvalBadge, whoIsWorking, spendLabel, formatUsd, formatDuration, formatPercent,
  shortModelName, safeUrl, fetchModelsOutcome, testOutcome, factCheckRows, factCheckSummary, keyStatusLabel, hasUsableModels, orderPresets,
  loopStageForPhase, iterationLabel, modelsTable, elapsedMs, normalizeSources, itemStatusLabel,
} from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const events = parseJsonl(readFileSync(join(here, "fixtures", "sample-run.jsonl"), "utf8"));
const sampleDir = join(here, "fixtures", "sample-run");
const readJson = (name) => JSON.parse(readFileSync(join(sampleDir, name), "utf8"));

const indexOf = (pred) => events.findIndex(pred);
const upTo = (n) => events.slice(0, n);

test("the fixture is labelled synthetic and parses cleanly", () => {
  assert.equal(events.length, 205);
  assert.equal(events[0].type, "room.created");
  assert.equal(events[0].payload.synthetic, true);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
});

test("whole run: finished state, items, spend, approval, best candidate", () => {
  const v = reduceRun(events);
  assert.equal(v.synthetic, true);
  assert.equal(v.status, "delivered");
  assert.equal(v.phase, "done");
  assert.equal(v.closed, true);
  assert.equal(v.wish, "I want a page that tells me if I need an umbrella tomorrow");
  assert.equal(v.title, "Umbrella Check");
  assert.equal(v.finished.finalScore, 1);
  assert.equal(v.finished.allPassed, true);
  assert.equal(v.finished.previewPath, "index.html");
  assert.equal(v.finished.reportPath, "REPORT.md");
  assert.deepEqual(v.items.map((i) => [i.id, i.status]), [["W1", "passed"], ["W2", "passed"], ["W3", "passed"]]);
  const w2 = v.items.find((i) => i.id === "W2");
  assert.equal(w2.attempts, 2);
  assert.deepEqual(w2.scores, [0.8, 1]);
  assert.equal(w2.title, "Tomorrow's forecast and the umbrella verdict");
  assert.equal(v.best.commit, "d81b0c3");
  assert.equal(v.finalTest.passed, 7);
  assert.equal(v.finalTest.total, 7);
  assert.equal(v.spend.usd, 1.27);
  assert.equal(v.spend.source, "estimated");
  assert.equal(spendLabel(v).text, "$1.27");
  assert.equal(spendLabel(v).note, "estimated");
  assert.equal(iterationLabel(v), "4 / 12");
  assert.equal(v.unknownEvents, 0);
});

test("approval badge says Auto-approved by <model>, never approved by you", () => {
  const v = reduceRun(events);
  const b = approvalBadge(v);
  assert.equal(b.state, "auto");
  assert.equal(b.label, "Auto-approved by Claude Opus 5.5");
  assert.equal(b.specVersion, 2);
  assert.match(b.sha, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(b.label, /you/i);
  assert.equal(v.confirmation, null);
});

test("approval is voided when a new plan version arrives, and a revise verdict never shows as approved", () => {
  const firstReview = indexOf((e) => e.type === "harness.plan.reviewed");
  const v1 = reduceRun(upTo(firstReview + 1));
  assert.equal(v1.approval, null);
  assert.equal(approvalBadge(v1).state, "revise");
  assert.match(approvalBadge(v1).label, /^Changes requested by Claude Opus 5\.5$/);
  const approvedAt = indexOf((e) => e.type === "harness.plan.reviewed" && e.payload.approval);
  const v2 = reduceRun(upTo(approvedAt + 1));
  assert.equal(approvalBadge(v2).state, "auto");
  // a replan after approval voids it
  const replan = applyEvent(v2, { seq: 9999, type: "harness.plan.ready", timestamp: "2026-11-15T02:00:00.000Z", payload: { specVersion: 3, title: "Umbrella Check", items: [{ id: "W1", title: "x", difficulty: "easy" }] }, provenance: { role: "planner" } });
  assert.equal(replan.approval, null);
  assert.equal(approvalBadge(replan).state, "pending");
  assert.equal(approvalBadge(replan).label, "Waiting for an independent review");
});

test("confirm_plan mode: waiting label, then Confirmed by you only after the user's event", () => {
  const created = { seq: 1, type: "room.created", timestamp: "2026-11-15T02:00:00.000Z", payload: { goal: "x", autonomy: "confirm_plan", limits: { maxRuns: 12, maxMinutes: 40, maxUsd: 5 } }, provenance: { role: "engine" } };
  const plan = { seq: 2, type: "harness.plan.ready", timestamp: "2026-11-15T02:00:01.000Z", payload: { specVersion: 1, title: "T", items: [{ id: "W1", title: "a", difficulty: "easy" }] }, provenance: { role: "planner" } };
  const reviewed = { seq: 3, type: "harness.plan.reviewed", timestamp: "2026-11-15T02:00:02.000Z", payload: { verdict: "approve", scores: { coversWish: 3, feasible: 3, testable: 3, scoped: 3 }, issues: [], reviewerModel: "anthropic/claude-opus-5-5", specVersion: 1, specSha256: "a".repeat(64), sameModelAsPlanner: false, approval: { by: "model", model: "anthropic/claude-opus-5-5", at: "2026-11-15T02:00:02.000Z", specVersion: 1, specSha256: "a".repeat(64), reviewRef: "plan-review.json", callId: "call-0007" } }, provenance: { role: "reviewer" } };
  const wait = { seq: 4, type: "harness.phase.changed", timestamp: "2026-11-15T02:00:03.000Z", payload: { phase: "awaiting_confirmation", previous: "plan_review", iteration: 0, itemId: null }, provenance: { role: "engine" } };
  const v = reduceRun([created, plan, reviewed, wait]);
  assert.equal(v.status, "awaiting_confirmation");
  const waiting = approvalBadge(v);
  assert.equal(waiting.state, "awaiting");
  assert.match(waiting.label, /waiting for you to confirm/);
  assert.doesNotMatch(waiting.label, /Auto-approved/);
  applyEvent(v, { seq: 5, type: "harness.plan.confirmed", timestamp: "2026-11-15T02:00:09.000Z", payload: { by: "user", at: "2026-11-15T02:00:09.000Z", specVersion: 1, specSha256: "a".repeat(64) }, provenance: { role: "user" } });
  assert.equal(v.status, "running");
  assert.equal(approvalBadge(v).label, "Confirmed by you");
  // a confirmation that isn't by the user is ignored
  const v2 = reduceRun([created, plan, reviewed]);
  applyEvent(v2, { seq: 4, type: "harness.plan.confirmed", payload: { by: "model" }, provenance: {} });
  assert.equal(v2.confirmation, null);
});

test("escalation: Haiku 5.5 → Sonnet 5.5 after failed tests, shown in Who's working", () => {
  const i = indexOf((e) => e.type === "harness.route.selected" && e.payload.escalated);
  const v = reduceRun(upTo(i + 1));
  assert.equal(v.escalations.length, 1);
  assert.equal(v.escalations[0].text, "Escalated: Haiku 5.5 → Sonnet 5.5 after failed tests");
  assert.equal(v.escalations[0].itemId, "W2");
  const who = whoIsWorking(v);
  assert.equal(who.role, "builder");
  assert.equal(who.model, "anthropic/claude-sonnet-5-5");
  assert.equal(who.modelName, "Claude Sonnet 5.5");
  assert.equal(who.tier, 2);
  assert.match(who.reason, /escalated coder from tier 1 to tier 2/);
  assert.equal(who.escalation.text, "Escalated: Haiku 5.5 → Sonnet 5.5 after failed tests");
  assert.equal(v.phase, "build");
  assert.equal(v.currentItemId, "W2");
  assert.equal(loopStageForPhase(v.phase), "build");
  const w2 = v.items.find((it) => it.id === "W2");
  assert.equal(w2.lastScore, 0.8);
  assert.equal(w2.status, "building");
  assert.equal(itemStatusLabel("retrying"), "Failed a check, retrying");
});

test("models table lists one row per role with the escalation chain", () => {
  const rows = modelsTable(reduceRun(events));
  const builder = rows.find((r) => r.role === "builder");
  assert.deepEqual(builder.models, ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5"]);
  assert.equal(builder.escalated, true);
  assert.equal(rows.find((r) => r.role === "planner").models.length, 1);
});

test("plan fact check: v1 stale forced a revision, v2 clean", () => {
  const v = reduceRun(events);
  assert.equal(v.planChecks.length, 2);
  assert.equal(v.planChecks[0].staleCount, 1);
  assert.equal(v.planChecks[0].reportPath, "plan-check-v1.json");
  assert.equal(v.planChecks[0].specVersion, 1);
  assert.equal(v.planChecks[1].staleCount, 0);
  assert.equal(v.planChecks[1].reportPath, "plan-check-v2.json");
  const rows = factCheckRows(readJson("plan-check-v1.json"));
  const stale = rows.find((r) => r.verdict === "stale");
  assert.equal(stale.oldValue, "returns at most 7 days of forecast");
  assert.equal(stale.proposedValue, "returns up to 16 days of forecast (forecast_days; the default is 7)");
  assert.equal(stale.forcedRevision, true);
  assert.equal(stale.sources.length, 2);
  assert.match(stale.independentNote, /mechanical check/);
  assert.match(stale.independentNote, /editorial independence not reviewed/);
  assert.equal(rows.filter((r) => r.verdict === "fresh").length, 3);
  assert.equal(factCheckSummary(v.planChecks[0], readJson("plan-check-v1.json")).text, "4 facts checked: 3 current, 1 stale.");
});

test("README fact check is proposed and unreviewed, never 'Confirmed'", () => {
  const v = reduceRun(events);
  assert.equal(v.factCheck.phase, "fact_check");
  assert.equal(v.factCheck.reportPath, "fact-check.json");
  const rows = factCheckRows(readJson("fact-check.json"));
  assert.deepEqual(rows.map((r) => r.verdict), ["fresh", "stale", "unsure"]);
  for (const r of rows) assert.doesNotMatch(r.verdictLabel, /confirm/i);
  const unsure = rows.find((r) => r.verdict === "unsure");
  assert.equal(unsure.independentNote, null);
  assert.equal(unsure.checks.find((c) => c.check === "independent_sources").passed, false);
});

test("skipped or failed fact checks read 'Not verified', never 'checked' or 'current'", () => {
  const skipped = { status: "skipped", reason: "no search provider", findings: [], diff: null };
  const s = factCheckSummary({ status: "skipped" }, skipped);
  assert.equal(s.verified, false);
  assert.match(s.text, /^Not verified: no search provider/);
  assert.doesNotMatch(s.text, /checked|current/);
  const f = factCheckSummary({ status: "failed", reason: "model refused" }, null);
  assert.equal(f.verified, false);
  assert.match(f.text, /^Not verified/);
  const view = createRunView("hr-20261115-000000-aaaa");
  applyEvent(view, { seq: 1, type: "harness.skill.completed", timestamp: "2026-11-15T02:00:00.000Z", payload: { skillId: "shelf-life", phase: "plan_check", status: "skipped", reason: "no search provider", findingCount: 0, staleCount: 0, reportPath: "plan-check-v1.json" }, provenance: { role: "researcher" } });
  assert.match(view.timeline.at(-1).text, /not verified \(no search provider\)/);
});

test("test evidence and timeline sentences", () => {
  const v = reduceRun(events);
  const t = v.tests.find((x) => x.itemId === "W2" && x.failed > 0);
  assert.equal(t.passed, 4);
  assert.equal(t.total, 5);
  assert.equal(t.failures[0].checkId, "A4");
  assert.equal(t.reportPath, "tests/002.json");
  const line = v.timeline.find((e) => /W2: 4\/5 checks passed/.test(e.text));
  assert.ok(line, "a human sentence for the failed test");
  assert.equal(line.tone, "bad");
  assert.equal(line.detail.kind, "test");
  assert.equal(line.detail.reportPath, "tests/002.json");
  assert.ok(v.timeline.some((e) => /Plan v2 auto-approved by Claude Opus 5\.5/.test(e.text)));
  assert.ok(v.timeline.some((e) => /Kept as best candidate/.test(e.text)));
});

test("partial streams: a half-finished log still yields a valid view", () => {
  const i = indexOf((e) => e.type === "harness.research.ready");
  const v = reduceRun(upTo(i + 1));
  assert.equal(v.status, "running");
  assert.equal(v.phase, "research");
  assert.equal(v.research.sources.length, 4);
  assert.equal(v.research.sources[0].domain, "open-meteo.com");
  assert.deepEqual(v.items, []);
  assert.equal(v.finished, null);
  assert.equal(approvalBadge(v).state, "none");
  assert.equal(whoIsWorking(v).role, "researcher");
  const empty = reduceRun([]);
  assert.equal(empty.eventCount, 0);
  assert.equal(whoIsWorking(empty).idle, true);
  assert.equal(approvalBadge(empty).label, "No plan yet");
});

test("unknown event types and fields are ignored", () => {
  const base = reduceRun(events);
  const withNoise = reduceRun([
    ...events.slice(0, 10),
    { seq: 11, type: "harness.future.thing", payload: { a: 1 }, timestamp: "2026-11-15T01:31:00.000Z", provenance: {} },
    { ...events[10], seq: 12, extraField: "ignored", payload: { ...events[10].payload, extra: true } },
    ...events.slice(11).map((e) => ({ ...e, seq: e.seq + 2 })),
  ]);
  assert.equal(withNoise.unknownEvents, 1);
  assert.equal(withNoise.status, base.status);
  assert.deepEqual(withNoise.items.map((i) => [i.id, i.status, i.attempts]), base.items.map((i) => [i.id, i.status, i.attempts]));
  // garbage envelopes never throw
  const v = createRunView("x");
  for (const bad of [null, undefined, 5, "str", {}, { type: 7 }, { type: "harness.note" }, { type: "harness.phase.changed", payload: null }]) applyEvent(v, bad);
  assert.equal(v.timeline.length <= 2, true);
});

test("a reconnect that resends events changes nothing (dedupe by seq)", () => {
  const once = reduceRun(events);
  const twice = createRunView(once.runId);
  for (const e of events) applyEvent(twice, e);
  for (const e of events.slice(50, 120)) applyEvent(twice, e);
  assert.equal(twice.timeline.length, once.timeline.length);
  assert.equal(twice.spend.usd, once.spend.usd);
  assert.equal(twice.lastSeq, once.lastSeq);
  // out-of-order arrival through reduceRun is sorted by seq
  const shuffled = [...events].reverse();
  assert.equal(reduceRun(shuffled).status, "delivered");
});

test("unknown cost stays unknown: never $0.00", () => {
  assert.equal(formatUsd(null), "unknown");
  assert.equal(formatUsd(undefined), "unknown");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(1.2345), "$1.23");
  const v = createRunView("x");
  applyEvent(v, { seq: 1, type: "run.completed", runId: "call-0001", payload: { stopReason: "end", usage: { inputTokens: 100, outputTokens: 20, costUsd: null, source: "unknown" }, durationMs: 1000 }, provenance: {} });
  assert.equal(v.spend.usd, null);
  assert.equal(spendLabel(v).text, "unknown");
  assert.equal(v.spend.inputTokens, 100);
  // a later call with a known cost can't make the total known again
  applyEvent(v, { seq: 2, type: "run.completed", runId: "call-0002", payload: { stopReason: "end", usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01, source: "provider" }, durationMs: 1000 }, provenance: {} });
  assert.equal(v.spend.usd, null);
  assert.equal(v.spend.inputTokens, 110);
});

test("cancelled run: status, banner data and no leftover 'running' items", () => {
  const i = indexOf((e) => e.type === "harness.route.selected" && e.payload.escalated);
  const view = reduceRun(upTo(i + 1));
  applyEvent(view, { seq: 500, type: "harness.run.finished", timestamp: "2026-11-15T01:40:00.000Z", payload: { status: "cancelled", summary: "Cancelled by you.", finalScore: null, allPassed: false, candidate: null, specVersion: null, reportPath: null, previewPath: null, spentUsd: null, minutes: null }, provenance: { role: "engine" } });
  applyEvent(view, { seq: 501, type: "room.closed", payload: { status: "cancelled", summary: "Cancelled by you." }, timestamp: "2026-11-15T01:40:01.000Z", provenance: {} });
  assert.equal(view.status, "cancelled");
  assert.equal(whoIsWorking(view).idle, true);
  assert.equal(view.items.find((it) => it.id === "W2").status, "pending");
  assert.equal(view.closed, true);
});

test("room.closed alone (engine crashed before run.finished) still ends the view", () => {
  const view = reduceRun([...upTo(5), { seq: 6, type: "room.closed", payload: { status: "failed", summary: "Engine stopped." }, timestamp: "2026-11-15T01:40:00.000Z", provenance: {} }]);
  assert.equal(view.status, "failed");
  assert.equal(view.closed, true);
});

test("elapsed time: finished runs use their own timestamps, running runs use now", () => {
  const done = reduceRun(events);
  assert.equal(formatDuration(elapsedMs(done, Date.now())), "6:48");
  const i = indexOf((e) => e.type === "harness.research.ready");
  const running = reduceRun(upTo(i + 1));
  const start = Date.parse(events[0].timestamp);
  assert.equal(elapsedMs(running, start + 90_000), 90_000);
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(3_725_000), "1:02:05");
});

test("formatters and helpers", () => {
  assert.equal(shortModelName("anthropic/claude-sonnet-5-5"), "Claude Sonnet 5.5");
  assert.equal(shortModelName("openrouter/some/model"), "some/model");
  assert.equal(shortModelName(null), "unknown model");
  assert.equal(formatPercent(0.8), "80%");
  assert.equal(formatPercent(null), "—");
  assert.equal(safeUrl("https://open-meteo.com/en/docs"), "https://open-meteo.com/en/docs");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "/relative", "ftp://x.y", "", null, undefined, 7]) assert.equal(safeUrl(bad), null);
  assert.deepEqual(normalizeSources([{ url: "javascript:x" }, { url: "https://a.example/x", name: "A" }, { url: "https://a.example/x" }]).map((s) => s.url), ["https://a.example/x"]);
  assert.equal(keyStatusLabel({ hasKey: true, preview: "sk-…ab12" }), "sk-…ab12");
  assert.equal(keyStatusLabel({ hasKey: true, preview: "set" }), "Key set");
  assert.equal(keyStatusLabel({ hasKey: false, preview: "" }), "No key");
  assert.equal(keyStatusLabel(undefined), "No key");
});

test("fetch-models results map to distinct plain-English outcomes and always keep the configured models", () => {
  const auth = fetchModelsOutcome({ ok: false, status: 401, code: "auth" });
  const none = fetchModelsOutcome({ ok: false, status: 404, code: "not_found" });
  const empty = fetchModelsOutcome({ ok: true, models: [] });
  const down = fetchModelsOutcome({ ok: false, status: 0, code: "network" });
  const ok = fetchModelsOutcome({ ok: true, models: ["a", "b"] });
  assert.match(auth.text, /^Key rejected \(401\/403\)/);
  assert.match(none.text, /^This provider has no model list endpoint/);
  assert.match(empty.text, /^The list is empty/);
  assert.match(down.text, /^Couldn't reach the provider/);
  assert.equal(ok.text, "Found 2 models. Tick the ones to add.");
  assert.equal(new Set([auth.kind, none.kind, empty.kind, down.kind, ok.kind]).size, 5);
  for (const o of [auth, none, empty, down]) { assert.equal(o.ok, false); assert.match(o.text, /Your configured models were kept\.$/); }
  assert.equal(fetchModelsOutcome({ ok: false, status: 403 }).kind, "auth");
  assert.equal(testOutcome({ ok: true, latencyMs: 212.4, detail: "Connected. 4 models available." }).text, "Connected · 212 ms · Connected. 4 models available.");
  assert.equal(testOutcome({ ok: false, latencyMs: null, detail: "Key rejected (401)." }).text, "Key rejected (401).");
});

test("hasUsableModels and preset order", () => {
  const cfg = { providers: [{ id: "a", preset: "anthropic", kind: "anthropic", enabled: true, apiKey: { hasKey: false }, models: [{ id: "m", enabled: true }] }] };
  assert.equal(hasUsableModels(cfg, []), false);
  cfg.providers[0].apiKey.hasKey = true;
  assert.equal(hasUsableModels(cfg, []), true);
  cfg.providers[0].models[0].enabled = false;
  assert.equal(hasUsableModels(cfg, []), false);
  assert.equal(hasUsableModels({ providers: [{ id: "o", preset: "ollama", kind: "openai_compatible", enabled: true, apiKey: { hasKey: false }, models: [{ id: "x" }] }] }, []), true);
  assert.deepEqual(orderPresets([{ id: "custom" }, { id: "github" }, { id: "anthropic" }, { id: "zzz" }]).map((p) => p.id), ["anthropic", "github", "custom", "zzz"]);
});
