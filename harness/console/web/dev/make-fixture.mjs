// Generates the SYNTHETIC sample run used by the mock server and the model tests:
//   fixtures/sample-run.jsonl          the event log (events.md), room.created has synthetic: true
//   fixtures/sample-run/<artifact>     brief, research, spec, reviews, fact checks, tests, reflections, REPORT.md
// The product files in fixtures/sample-run/workspace/ are hand-written and not touched here.
//
// Nothing here is a real run: every number, model output and source snippet is made up to exercise
// the UI, and the UI labels it "Synthetic replay". Run: node harness/console/web/dev/make-fixture.mjs

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "..", "fixtures");
const RUN_DIR = join(FIX, "sample-run");

export const RUN_ID = "hr-20261115-013012-a1b2";
const T0 = Date.parse("2026-11-15T01:30:12.000Z");
const WISH = "I want a page that tells me if I need an umbrella tomorrow";

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const FABLE = "anthropic/claude-fable-5-2";
const LIMITS = { maxRuns: 12, maxMinutes: 40, maxUsd: 5 };

let t = T0;
let seq = 0;
let callNo = 0;
let toolNo = 0;
let spent = 0;
const events = [];
const sha = (s) => createHash("sha256").update(s).digest("hex");
const pad = (n, w = 4) => String(n).padStart(w, "0");

function emit(type, payload, o = {}) {
  t += o.dt ?? 400;
  seq += 1;
  const modelId = o.model ? o.model.slice(o.model.indexOf("/") + 1) : null;
  const env = {
    schemaVersion: 1,
    eventId: `evt-${RUN_ID}-${pad(seq)}`,
    seq,
    roomId: RUN_ID,
    ...(o.runId ? { runId: o.runId } : {}),
    ...(o.taskId ? { taskId: o.taskId } : {}),
    type,
    timestamp: new Date(t).toISOString(),
    provenance: { memberId: null, role: o.role || "engine", mode: o.model ? "api" : "system", provider: o.model ? "anthropic" : null, model: modelId, identitySource: "configured" },
    payload,
  };
  events.push(env);
  return env;
}

let phaseNow = null;
function phase(p, { iteration = 0, itemId = null, dt = 300 } = {}) {
  emit("harness.phase.changed", { phase: p, previous: phaseNow, iteration, itemId }, { dt });
  phaseNow = p;
}

function route(role, model, tier, rule, reason, { escalated = false, pinned = false, attempt = 1, dt = 150 } = {}) {
  emit("harness.route.selected", { role, model, tier, rule, reason, escalated, pinned, attempt }, { dt });
}

function note(role, text, dt = 900) {
  emit("harness.note", { role, text }, { dt });
}

/** One model call: run.started, inner tool events, run.completed. Returns the call id. */
function call(role, model, purpose, { attempt = 1, taskId, durationMs, inTok, outTok, cost, inner } = {}) {
  callNo += 1;
  const runId = `call-${pad(callNo)}`;
  const modelId = model.slice(model.indexOf("/") + 1);
  const start = t;
  emit("run.started", { memberId: null, provider: "anthropic", model: modelId, attempt, triggerEventId: null, roomVersion: 1, role, purpose }, { role, model, runId, taskId, dt: 200 });
  if (inner) inner({ runId, role, model, taskId });
  const remaining = Math.max(400, durationMs - (t - start));
  spent += cost;
  emit("run.completed", { stopReason: "end", usage: { inputTokens: inTok, outputTokens: outTok, costUsd: cost, source: "estimated" }, durationMs }, { role, model, runId, taskId, dt: remaining });
  return runId;
}

function tool(ctx, name, args, summary, { durationMs = 300, status = "ok", dt = 1200 } = {}) {
  toolNo += 1;
  const toolCallId = `tool-${pad(toolNo, 3)}`;
  emit("tool.called", { toolCallId, name, args }, { role: ctx.role, model: ctx.model, runId: ctx.runId, taskId: ctx.taskId, dt });
  emit("tool.result", { toolCallId, status, summary, durationMs }, { role: ctx.role, model: ctx.model, runId: ctx.runId, taskId: ctx.taskId, dt: durationMs + 50 });
}

function writeArtifact(name, content) {
  const file = join(RUN_DIR, name);
  mkdirSync(dirname(file), { recursive: true });
  const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
  writeFileSync(file, text);
  return text;
}

function artifact(name, kind, content, dt = 120) {
  const text = writeArtifact(name, content);
  emit("artifact.registered", { artifactId: name, kind, location: name, version: sha(text), evidence: [] }, { dt });
  return text;
}

function budget(elapsedMinutes, iterations) {
  emit("harness.budget.updated", { spentUsd: Math.round(spent * 1000) / 1000, usdSource: "estimated", elapsedMinutes, iterations, limits: LIMITS, exceeded: null }, { dt: 120 });
}

const minutes = () => Math.round(((t - T0) / 60000) * 10) / 10;
const at = () => new Date(t).toISOString();

// ------------------------------------------------------------------ content

const S = {
  docs: { name: "Weather Forecast API | Open-Meteo", url: "https://open-meteo.com/en/docs", domain: "open-meteo.com", snippet: "Daily variables include precipitation_probability_max and precipitation_sum; forecast_days sets how many days are returned.", retrievedAt: "2026-11-15T01:31:02.000Z" },
  geo: { name: "Geocoding API | Open-Meteo", url: "https://open-meteo.com/en/docs/geocoding-api", domain: "open-meteo.com", snippet: "Search a place by name and get its latitude and longitude.", retrievedAt: "2026-11-15T01:31:09.000Z" },
  terms: { name: "Terms | Open-Meteo", url: "https://open-meteo.com/en/terms", domain: "open-meteo.com", snippet: "Free for non-commercial use; no API key needed.", retrievedAt: "2026-11-15T01:31:14.000Z" },
  mdn: { name: "Geolocation API | MDN", url: "https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API", domain: "developer.mozilla.org", snippet: "Available only in secure contexts; the browser asks the visitor for permission.", retrievedAt: "2026-11-15T01:31:20.000Z" },
  gh: { name: "open-meteo/open-meteo on GitHub", url: "https://github.com/open-meteo/open-meteo", domain: "github.com", snippet: "Open-source weather API with forecasts of up to 16 days.", retrievedAt: "2026-11-15T01:33:40.000Z" },
  w3c: { name: "Geolocation | W3C", url: "https://www.w3.org/TR/geolocation/", domain: "w3.org", snippet: "The API is restricted to secure contexts.", retrievedAt: "2026-11-15T01:33:44.000Z" },
};
const ALL_SOURCES = [S.docs, S.geo, S.terms, S.mdn, S.gh, S.w3c];

const brief = {
  title: "Umbrella Check",
  restatedGoal: "One web page that says whether to take an umbrella tomorrow, using the forecast for where you are.",
  targetUser: "Anyone who wants a quick yes or no about rain tomorrow, with no setup",
  productKind: "web_page",
  mustHaves: [
    "A clear answer: take an umbrella tomorrow, or not",
    "Uses the visitor's location, with a city search as a fallback",
    "Shows tomorrow's chance of rain and expected rainfall",
    "Works without an account or an API key",
    "Explains in plain words when the forecast can't be loaded",
  ],
  niceToHaves: ["Remembers the last city searched"],
  assumptions: [
    { topic: "Location", assumed: "Ask the browser for the location; if that is refused, let the visitor type a city", why: "The wish doesn't say where the visitor is" },
    { topic: "When to take an umbrella", assumed: "Yes when tomorrow's chance of rain is 40% or more, or at least 1 mm of rain is expected", why: "A common rule of thumb; the page shows the rule so it isn't hidden" },
    { topic: "Units", assumed: "Millimetres and percent", why: "The forecast service's defaults" },
  ],
  constraints: ["No API keys required", "Static files only (HTML, CSS, JavaScript)"],
  researchQuestions: [
    "Which free weather forecast API works from a browser without a key?",
    "How do I get tomorrow's chance of rain from it?",
    "How do I turn a city name into coordinates?",
  ],
  refused: null,
};

const research = {
  findings: [
    { question: brief.researchQuestions[0], answer: "Open-Meteo offers a free forecast API for non-commercial use with no API key, callable from the browser.", sources: [S.terms, S.docs], confidence: "high", basis: "search" },
    { question: brief.researchQuestions[1], answer: "Ask for daily=precipitation_probability_max,precipitation_sum with timezone=auto and forecast_days=2; index 1 of the daily arrays is tomorrow.", sources: [S.docs], confidence: "high", basis: "search" },
    { question: brief.researchQuestions[2], answer: "The Open-Meteo geocoding search endpoint takes a place name and returns latitude and longitude.", sources: [S.geo], confidence: "high", basis: "search" },
    { question: "Can the page use the visitor's location?", answer: "navigator.geolocation asks the visitor for permission and only works in a secure context (https or localhost).", sources: [S.mdn], confidence: "high", basis: "search" },
  ],
  recommendedApproach: "A static page with a small pure module (forecast.mjs) that builds the request URLs, reads tomorrow's values and decides the verdict, so it can be tested with node. The page asks for the location first and falls back to a city search.",
  externalServices: [
    { name: "Open-Meteo Forecast API", url: "https://api.open-meteo.com/v1/forecast", needsKey: false, notes: "Free for non-commercial use" },
    { name: "Open-Meteo Geocoding API", url: "https://geocoding-api.open-meteo.com/v1/search", needsKey: false, notes: "City name to coordinates" },
  ],
  risks: ["The visitor may refuse location access", "The forecast service may be unreachable"],
  searchesUsed: 3,
};

const checks = [
  { id: "A1", itemId: "W1", description: "index.html has the title and a city input", type: "file", path: "index.html", mustContain: ["Umbrella Check", "<input"] },
  { id: "A2", itemId: "W1", description: "The page has a search form and a result area", type: "command", run: ["node", "acceptance/a2-layout.test.mjs"], expectExitCode: 0, generate: true },
  { id: "A3", itemId: "W2", description: "The forecast request asks for tomorrow's daily rain values with timezone=auto", type: "command", run: ["node", "acceptance/a3-forecast-url.test.mjs"], expectExitCode: 0, generate: true },
  { id: "A4", itemId: "W2", description: "60% chance of rain gives 'Take an umbrella'; 10% and 0 mm gives 'No umbrella needed'", type: "command", run: ["node", "acceptance/a4-verdict.test.mjs"], expectExitCode: 0, generate: true },
  { id: "A5", itemId: "W2", description: "The verdict is clear to a non-technical reader and shows the rule used", type: "llm_judge", rubric: "Plain words; shows chance of rain, expected rainfall and the 40% / 1 mm rule", files: ["app.js", "forecast.mjs"] },
  { id: "A6", itemId: "W3", description: "When the forecast can't be loaded, the message says so in plain words", type: "command", run: ["node", "acceptance/a6-errors.test.mjs"], expectExitCode: 0, generate: true },
  { id: "A7", itemId: "W3", description: "README explains how to use the page and names the data source", type: "file", path: "README.md", mustContain: ["How to use", "Open-Meteo"] },
];

function spec(version) {
  return {
    specVersion: version,
    title: "Umbrella Check",
    summary: "A single static page that answers one question: do I need an umbrella tomorrow? It asks the browser for the visitor's location (or takes a city name), fetches tomorrow's forecast from Open-Meteo without any key, and shows a big yes or no with the chance of rain, the expected rainfall and the rule it used.",
    stack: "static-web",
    entry: { kind: "open_html", path: "index.html" },
    architecture: "index.html loads app.js (page logic). app.js imports forecast.mjs, a pure module that builds the request URLs, reads tomorrow's values and decides the verdict. styles.css holds the layout. README.md explains how to use it.",
    assumptions: brief.assumptions.map((a) => `${a.topic}: ${a.assumed}`),
    outOfScope: ["Hourly breakdown", "Notifications", "Saving several places"],
    sources: version === 1 ? [S.docs, S.geo, S.terms, S.mdn] : ALL_SOURCES,
    workItems: [
      { id: "W1", title: "Page layout and city search", description: "A clean page with a big answer area, a 'Use my location' button and a city search box.", difficulty: "easy", suggestedModel: HAIKU, modelReason: "Simple HTML and CSS; the cheapest coder is enough", dependsOn: [], files: ["index.html", "styles.css", "app.js"], checkIds: ["A1", "A2"] },
      { id: "W2", title: "Tomorrow's forecast and the umbrella verdict", description: "Fetches tomorrow's chance of rain and rainfall and turns them into a clear yes or no.", difficulty: "medium", suggestedModel: HAIKU, modelReason: "A small pure module with clear tests; try the cheapest coder first", dependsOn: ["W1"], files: ["forecast.mjs", "app.js"], checkIds: ["A3", "A4", "A5"] },
      { id: "W3", title: "Friendly errors and a README", description: "Plain-word messages when location or the forecast fails, and a short README.", difficulty: "easy", suggestedModel: HAIKU, modelReason: "Short text changes; the cheapest coder is enough", dependsOn: ["W2"], files: ["app.js", "README.md"], checkIds: ["A6", "A7"] },
    ],
    acceptance: checks,
  };
}

function finding(claimId, line, statement, verdict, sources, opts = {}) {
  const passed = (c) => opts.failed?.includes(c) !== true;
  return {
    claimId, line, quote: opts.quote || statement, statement, category: opts.category || "other", verdict,
    currentValue: opts.currentValue ?? null, correction: opts.correction ?? null, sources,
    checks: [
      { check: "quote_in_doc", passed: passed("quote_in_doc"), detail: "The quoted text is in the document." },
      { check: "independent_sources", passed: passed("independent_sources"), detail: passed("independent_sources") ? "Two different sites contained the value (mechanical check); editorial independence not reviewed." : "Only one site stated the value." },
      { check: "correction_supported", passed: verdict === "stale" ? passed("correction_supported") : true, detail: verdict === "stale" ? "Both sources contain the proposed value." : "No correction proposed." },
      { check: "patch_scope", passed: true, detail: "The patch changes only the quoted line." },
    ],
  };
}

const planFacts = (v) => [
  finding("C1", 1, "The Open-Meteo forecast API needs no API key for non-commercial use", "fresh", [S.terms, S.docs], { category: "policy" }),
  v === 1
    ? finding("C2", 3, "The Open-Meteo forecast API returns at most 7 days of forecast", "stale", [S.docs, S.gh], { category: "limit", quote: "returns at most 7 days of forecast", currentValue: "up to 16 days (forecast_days; the default is 7)", correction: "returns up to 16 days of forecast (forecast_days; the default is 7)" })
    : finding("C2", 3, "The Open-Meteo forecast API returns up to 16 days of forecast (the default is 7)", "fresh", [S.docs, S.gh], { category: "limit" }),
  finding("C3", 5, "City names are turned into coordinates with the Open-Meteo geocoding search", "fresh", [S.geo, S.gh], { category: "other" }),
  finding("C4", 7, "Browser geolocation only works in a secure context (https or localhost)", "fresh", [S.mdn, S.w3c], { category: "policy" }),
];

function factCheck(n, label, findings, extra = {}) {
  const doc = findings.map((f) => f.statement).join("\n");
  return {
    status: "completed", reason: null, childRoomId: `${RUN_ID}-sl-${pad(n, 2)}`,
    doc: { label, sha256: sha(doc) },
    findings,
    diff: extra.diff ?? null,
    reviewStatus: "unreviewed",
    searchesUsed: extra.searchesUsed ?? findings.length,
  };
}

function testReport(scope, candidate, results, tester) {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const summary = { total: results.length, passed, failed, errored: 0, skipped: 0 };
  return { scope, candidate, results, summary, score: passed / results.length, acceptanceIntact: true, allPassed: passed === results.length, testerModel: tester };
}

const R = {
  A1: { checkId: "A1", itemId: "W1", type: "file", status: "pass", evidence: { quotes: [{ file: "index.html", text: "<h1>Umbrella Check</h1>" }] }, message: "index.html contains the title and an input", durationMs: 4 },
  A2: { checkId: "A2", itemId: "W1", type: "command", status: "pass", evidence: { command: ["node", "acceptance/a2-layout.test.mjs"], exitCode: 0, stdoutTail: "ok search form\nok result area\n" }, message: "exit code 0", durationMs: 182 },
  A3: { checkId: "A3", itemId: "W2", type: "command", status: "pass", evidence: { command: ["node", "acceptance/a3-forecast-url.test.mjs"], exitCode: 0, stdoutTail: "ok daily=precipitation_probability_max,precipitation_sum\nok timezone=auto\n" }, message: "exit code 0", durationMs: 171 },
  A4fail: { checkId: "A4", itemId: "W2", type: "command", status: "fail", evidence: { command: ["node", "acceptance/a4-verdict.test.mjs"], exitCode: 1, stdoutTail: "not ok 60% rain → expected \"Take an umbrella\", got \"No umbrella needed\"\n", stderrTail: "AssertionError: read hourly[24] instead of daily[1]\n" }, message: "Expected 'Take an umbrella' for 60% rain; got 'No umbrella needed' (read hourly data instead of tomorrow's daily maximum)", durationMs: 205 },
  A4: { checkId: "A4", itemId: "W2", type: "command", status: "pass", evidence: { command: ["node", "acceptance/a4-verdict.test.mjs"], exitCode: 0, stdoutTail: "ok 60% rain → Take an umbrella\nok 10% and 0 mm → No umbrella needed\n" }, message: "exit code 0", durationMs: 166 },
  A5: (judge) => ({ checkId: "A5", itemId: "W2", type: "llm_judge", status: "pass", evidence: { quotes: [{ file: "forecast.mjs", text: "Take an umbrella: ${pct}% chance of rain tomorrow" }], judgeModel: judge }, message: "Plain wording; shows the chance of rain and the rule", durationMs: 2300 }),
  A6: { checkId: "A6", itemId: "W3", type: "command", status: "pass", evidence: { command: ["node", "acceptance/a6-errors.test.mjs"], exitCode: 0, stdoutTail: "ok offline message\nok unknown city message\n" }, message: "exit code 0", durationMs: 158 },
  A7: { checkId: "A7", itemId: "W3", type: "file", status: "pass", evidence: { quotes: [{ file: "README.md", text: "## How to use" }] }, message: "README.md contains 'How to use' and 'Open-Meteo'", durationMs: 3 },
};

// ------------------------------------------------------------------ the run

emit("room.created", { goal: WISH, acceptanceCriteria: [], constraints: [], limits: LIMITS, workflow: "harness.autopilot.v1", driver: "harness", roomVersion: 1, autonomy: "full", synthetic: true }, { dt: 0 });
writeArtifact("wish.txt", `${WISH}\n`);

// intake
phase("intake", { dt: 200 });
route("intake", HAIKU, 1, "intake.base", "Turning a wish into a brief is a short structured task; the cheapest tier-1 model is enough");
call("intake", HAIKU, "intake", { durationMs: 5200, inTok: 1450, outTok: 820, cost: 0.006, inner: () => note("intake", "No location given, so the page will ask the browser and fall back to a city search.", 2600) });
artifact("brief.json", "report", brief);
emit("harness.brief.ready", { title: brief.title, productKind: brief.productKind, mustHaves: brief.mustHaves, assumptions: brief.assumptions.map(({ topic, assumed }) => ({ topic, assumed })), refused: null }, { dt: 100 });

// research
phase("research");
route("researcher", SONNET, 2, "researcher.base", "Research needs good reading and tool use; a tier-2 model with web search (Linkup)");
call("researcher", SONNET, "research", {
  durationMs: 21000, inTok: 9800, outTok: 2100, cost: 0.061,
  inner: (ctx) => {
    tool(ctx, "linkup_search", { query: "free weather forecast API no key browser CORS" }, "5 sources; best: open-meteo.com/en/docs", { durationMs: 2400 });
    tool(ctx, "linkup_search", { query: "Open-Meteo daily precipitation_probability_max tomorrow" }, "4 sources; best: open-meteo.com/en/docs", { durationMs: 2100 });
    tool(ctx, "linkup_search", { query: "Open-Meteo geocoding API city name to coordinates" }, "3 sources; best: open-meteo.com/en/docs/geocoding-api", { durationMs: 1900 });
  },
});
artifact("research.json", "source_list", research);
emit("harness.research.ready", { findingCount: 4, searchesUsed: 3, sources: [S.docs, S.geo, S.terms, S.mdn], basis: "search" }, { dt: 100 });

// plan v1
phase("plan");
route("planner", FABLE, 3, "planner.strongest", "Planning decides everything downstream, so it gets the strongest model provided");
call("planner", FABLE, "plan", { durationMs: 34000, inTok: 14200, outTok: 4600, cost: 0.214 });
const spec1 = artifact("spec.json", "report", spec(1));
emit("harness.plan.ready", { specVersion: 1, title: "Umbrella Check", stack: "static-web", items: spec(1).workItems.map(({ id, title, difficulty }) => ({ id, title, difficulty })), checkCount: 7, executableCheckCount: 6 }, { dt: 100 });

// plan check v1 (Shelf Life)
phase("plan_check");
route("researcher", SONNET, 2, "researcher.skill", "Fact-checking the plan needs web search; same researcher model, pinned for the whole skill call");
writeArtifact("plan-facts-v1.md", planFacts(1).map((f) => `${f.statement}\n${f.sources.map((s) => `Source: ${s.url}`).join("\n")}`).join("\n\n") + "\n");
emit("harness.skill.started", { skillId: "shelf-life", version: "1.0.0", phase: "plan_check", role: "researcher", docLabel: "plan-facts-v1.md", childRoomId: `${RUN_ID}-sl-01` }, { dt: 150 });
call("researcher", SONNET, "plan_check", { durationMs: 26000, inTok: 7600, outTok: 1900, cost: 0.048 });
const pc1 = factCheck(1, "plan-facts-v1.md", planFacts(1), { diff: "--- plan-facts-v1.md\n+++ plan-facts-v1.md\n@@ -3 +3 @@\n-The Open-Meteo forecast API returns at most 7 days of forecast\n+The Open-Meteo forecast API returns up to 16 days of forecast (forecast_days; the default is 7)\n", searchesUsed: 4 });
artifact("plan-check-v1.json", "report", pc1);
emit("harness.skill.completed", { skillId: "shelf-life", version: "1.0.0", phase: "plan_check", role: "researcher", docLabel: "plan-facts-v1.md", childRoomId: `${RUN_ID}-sl-01`, status: "completed", findingCount: 4, staleCount: 1, searchesUsed: 4, reportPath: "plan-check-v1.json" }, { dt: 100 });

// plan review v1 → revise (the stale fact is an automatic blocker)
phase("plan_review");
route("reviewer", OPUS, 3, "reviewer.independent", "The reviewer must not be the planner (Claude Fable 5.2), so the next strongest tier-3 model reviews");
const rev1Call = call("reviewer", OPUS, "plan_review", { durationMs: 18000, inTok: 11800, outTok: 1300, cost: 0.103 });
emit("harness.plan.reviewed", {
  verdict: "revise", scores: { coversWish: 3, feasible: 3, testable: 3, scoped: 2 },
  issues: [
    { severity: "blocker", text: "Plan check: “returns at most 7 days of forecast” is stale. Two sources say up to 16 days (forecast_days; the default is 7)." },
    { severity: "minor", text: "Show the 40% / 1 mm rule on the page so the assumption isn't hidden." },
  ],
  reviewerModel: OPUS, reviewerCallId: rev1Call, specVersion: 1, specSha256: sha(spec1), sameModelAsPlanner: false, approval: null,
}, { dt: 100 });

// plan v2
phase("plan");
route("planner", FABLE, 3, "planner.strongest", "Revising the plan: same strongest model, with the reviewer's required changes");
call("planner", FABLE, "plan revision", { durationMs: 22000, inTok: 16900, outTok: 4400, cost: 0.226 });
const spec2 = artifact("spec.json", "report", spec(2));
emit("harness.plan.ready", { specVersion: 2, title: "Umbrella Check", stack: "static-web", items: spec(2).workItems.map(({ id, title, difficulty }) => ({ id, title, difficulty })), checkCount: 7, executableCheckCount: 6 }, { dt: 100 });

phase("plan_check");
route("researcher", SONNET, 2, "researcher.skill", "Fact-checking the revised plan; same researcher model, pinned for the whole skill call");
writeArtifact("plan-facts-v2.md", planFacts(2).map((f) => `${f.statement}\n${f.sources.map((s) => `Source: ${s.url}`).join("\n")}`).join("\n\n") + "\n");
emit("harness.skill.started", { skillId: "shelf-life", version: "1.0.0", phase: "plan_check", role: "researcher", docLabel: "plan-facts-v2.md", childRoomId: `${RUN_ID}-sl-02` }, { dt: 150 });
call("researcher", SONNET, "plan_check", { durationMs: 21000, inTok: 7400, outTok: 1700, cost: 0.044 });
artifact("plan-check-v2.json", "report", factCheck(2, "plan-facts-v2.md", planFacts(2), { searchesUsed: 4 }));
emit("harness.skill.completed", { skillId: "shelf-life", version: "1.0.0", phase: "plan_check", role: "researcher", docLabel: "plan-facts-v2.md", childRoomId: `${RUN_ID}-sl-02`, status: "completed", findingCount: 4, staleCount: 0, searchesUsed: 4, reportPath: "plan-check-v2.json" }, { dt: 100 });

phase("plan_review");
route("reviewer", OPUS, 3, "reviewer.independent", "The reviewer must not be the planner (Claude Fable 5.2), so the next strongest tier-3 model reviews");
const rev2Call = call("reviewer", OPUS, "plan_review", { durationMs: 15000, inTok: 12400, outTok: 900, cost: 0.098 });
const approvalAt = at();
const planReview = {
  verdict: "approve", scores: { coversWish: 3, feasible: 3, testable: 3, scoped: 3 },
  issues: [{ severity: "minor", text: "Consider remembering the last city; not required." }],
  requiredChanges: [],
  reviewerModel: OPUS, reviewerCallId: rev2Call, specVersion: 2, specSha256: sha(spec2),
};
artifact("plan-review.json", "report", planReview);
emit("harness.plan.reviewed", {
  verdict: "approve", scores: planReview.scores, issues: planReview.issues, reviewerModel: OPUS, reviewerCallId: rev2Call,
  specVersion: 2, specSha256: sha(spec2), sameModelAsPlanner: false,
  approval: { by: "model", model: OPUS, at: approvalAt, specVersion: 2, specSha256: sha(spec2), reviewRef: "plan-review.json", callId: rev2Call },
}, { dt: 100 });

for (const w of spec(2).workItems) {
  emit("task.created", { title: w.title, owner: "builder", dependencies: w.dependsOn, inputs: { difficulty: w.difficulty }, deliverables: w.files, acceptance: w.checkIds, status: w.dependsOn.length ? "pending" : "ready", version: 2 }, { taskId: w.id, dt: 60 });
}

// scaffold: the tester writes the frozen acceptance tests
phase("scaffold");
route("tester", SONNET, 2, "tester.scaffold", "The tester writes the acceptance scripts before any code exists, so the builder can't shape the tests");
call("tester", SONNET, "scaffold acceptance tests", {
  durationMs: 19000, inTok: 6200, outTok: 3100, cost: 0.065,
  inner: (ctx) => {
    tool(ctx, "write_file", { path: "acceptance/a2-layout.test.mjs" }, "wrote 34 lines", { durationMs: 40 });
    tool(ctx, "write_file", { path: "acceptance/a3-forecast-url.test.mjs" }, "wrote 21 lines", { durationMs: 40 });
    tool(ctx, "write_file", { path: "acceptance/a4-verdict.test.mjs" }, "wrote 27 lines", { durationMs: 40 });
    tool(ctx, "write_file", { path: "acceptance/a6-errors.test.mjs" }, "wrote 22 lines", { durationMs: 40 });
  },
});
note("tester", "Froze 4 acceptance scripts in acceptance/ (scaffold commit 5e0c2d1). Any later change to them fails every check.", 300);

// W1 attempt 1
phase("build", { iteration: 1, itemId: "W1" });
emit("task.updated", { status: "running", version: 2 }, { taskId: "W1", dt: 60 });
route("builder", HAIKU, 1, "builder.planner_suggested", "Planner suggested Claude Haiku 5.5 for simple HTML and CSS; accepted", { attempt: 1 });
call("builder", HAIKU, "build W1", {
  taskId: "W1", durationMs: 31000, inTok: 8800, outTok: 3900, cost: 0.024,
  inner: (ctx) => {
    tool(ctx, "list_files", {}, "acceptance/ (4 files)", { durationMs: 20 });
    tool(ctx, "write_file", { path: "index.html" }, "wrote 41 lines", { durationMs: 30 });
    tool(ctx, "write_file", { path: "styles.css" }, "wrote 58 lines", { durationMs: 30 });
    tool(ctx, "write_file", { path: "app.js" }, "wrote 37 lines", { durationMs: 30 });
    tool(ctx, "run_command", { args: ["acceptance/a2-layout.test.mjs"] }, "exit 0", { durationMs: 190 });
  },
});
emit("harness.build.completed", { itemId: "W1", attempt: 1, status: "done", commit: "a1c3e5f", filesChanged: ["index.html", "styles.css", "app.js"], turns: 6, toolCalls: 5, model: HAIKU }, { dt: 150 });
emit("task.updated", { status: "review", version: 2 }, { taskId: "W1", dt: 60 });
phase("test", { iteration: 1, itemId: "W1" });
route("tester", SONNET, 2, "tester.independent", "Tester must differ from the builder (Claude Haiku 5.5); picked Claude Sonnet 5.5", { attempt: 1 });
const t1 = testReport({ kind: "item", itemId: "W1", includeRegression: true }, "a1c3e5f", [R.A1, R.A2], SONNET);
artifact("tests/001.json", "report", t1, 2600);
emit("harness.test.completed", { scope: "item", itemId: "W1", candidate: "a1c3e5f", passed: 2, failed: 0, errored: 0, skipped: 0, total: 2, score: 1, acceptanceIntact: true, testerModel: SONNET, reportPath: "tests/001.json", failures: [] }, { dt: 100 });
emit("task.done", { verifiedBy: "check", evidence: [{ kind: "test_result", ref: "tests/001.json", summary: "2/2 checks passed", passed: true }], version: 2 }, { taskId: "W1", dt: 80 });
emit("harness.candidate.best", { commit: "a1c3e5f", score: 1, previousBest: null, reverted: false }, { dt: 80 });
phase("reflect", { iteration: 1, itemId: "W1" });
artifact("reflections/001.json", "report", { itemId: "W1", decision: "next", reason: "All W1 checks pass.", fixInstructions: null, lessons: [] });
emit("harness.reflect.decided", { itemId: "W1", decision: "next", reason: "All W1 checks pass.", overriddenBy: "all_checks_pass" }, { dt: 100 });
budget(minutes(), 1);

// W2 attempt 1 (cheap coder, fails one check)
phase("build", { iteration: 2, itemId: "W2" });
emit("task.updated", { status: "running", version: 2 }, { taskId: "W2", dt: 60 });
route("builder", HAIKU, 1, "builder.planner_suggested", "Planner suggested Claude Haiku 5.5 (a small pure module with clear tests); accepted for attempt 1", { attempt: 1 });
call("builder", HAIKU, "build W2", {
  taskId: "W2", durationMs: 38000, inTok: 12600, outTok: 4800, cost: 0.032,
  inner: (ctx) => {
    tool(ctx, "read_file", { path: "app.js" }, "37 lines", { durationMs: 20 });
    tool(ctx, "write_file", { path: "forecast.mjs" }, "wrote 52 lines", { durationMs: 30 });
    tool(ctx, "edit_file", { path: "app.js" }, "replaced 1 block", { durationMs: 30 });
    tool(ctx, "run_command", { args: ["acceptance/a3-forecast-url.test.mjs"] }, "exit 0", { durationMs: 180 });
  },
});
emit("harness.build.completed", { itemId: "W2", attempt: 1, status: "done", commit: "b7d2e90", filesChanged: ["forecast.mjs", "app.js"], turns: 7, toolCalls: 4, model: HAIKU }, { dt: 150 });
emit("task.updated", { status: "review", version: 2 }, { taskId: "W2", dt: 60 });
phase("test", { iteration: 2, itemId: "W2" });
route("tester", SONNET, 2, "tester.independent", "Tester must differ from the builder (Claude Haiku 5.5); picked Claude Sonnet 5.5", { attempt: 1 });
call("tester", SONNET, "judge A5", { taskId: "W2", durationMs: 6000, inTok: 3900, outTok: 380, cost: 0.016 });
const t2 = testReport({ kind: "item", itemId: "W2", includeRegression: true }, "b7d2e90", [R.A1, R.A2, R.A3, R.A4fail, R.A5(SONNET)], SONNET);
artifact("tests/002.json", "report", t2, 300);
emit("harness.test.completed", { scope: "item", itemId: "W2", candidate: "b7d2e90", passed: 4, failed: 1, errored: 0, skipped: 0, total: 5, score: 0.8, acceptanceIntact: true, testerModel: SONNET, reportPath: "tests/002.json", failures: [{ checkId: "A4", message: R.A4fail.message }] }, { dt: 100 });
emit("task.updated", { status: "running", version: 2, note: "A4 failed; retrying" }, { taskId: "W2", dt: 60 });
phase("reflect", { iteration: 2, itemId: "W2" });
route("reflector", SONNET, 2, "reflector.base", "Reflection reads the failing evidence and writes fix instructions; a tier-2 model");
call("reflector", SONNET, "reflect W2", { taskId: "W2", durationMs: 9000, inTok: 5200, outTok: 640, cost: 0.023 });
artifact("reflections/002.json", "report", { itemId: "W2", decision: "escalate", reason: "The coder read hourly data instead of tomorrow's daily maximum. A stronger coder should fix the parsing.", fixInstructions: "In parseTomorrow, read daily.precipitation_probability_max[1] and daily.precipitation_sum[1]; don't use the hourly arrays.", lessons: ["Open-Meteo daily values need daily= in the query string; index 1 is tomorrow."] });
emit("harness.reflect.decided", { itemId: "W2", decision: "escalate", reason: "The coder read hourly data instead of tomorrow's daily maximum; retry with a stronger coder.", overriddenBy: null }, { dt: 100 });
budget(minutes(), 2);

// W2 attempt 2 (escalated coder, passes)
phase("build", { iteration: 3, itemId: "W2" });
route("builder", SONNET, 2, "builder.escalate.attempt2", "Attempt 1 failed tests (4/5); escalated coder from tier 1 to tier 2 (claude-sonnet-5-5)", { escalated: true, attempt: 2 });
call("builder", SONNET, "build W2 attempt 2", {
  taskId: "W2", attempt: 2, durationMs: 33000, inTok: 14100, outTok: 3600, cost: 0.091,
  inner: (ctx) => {
    tool(ctx, "read_file", { path: "forecast.mjs" }, "52 lines", { durationMs: 20 });
    tool(ctx, "edit_file", { path: "forecast.mjs" }, "replaced 1 block (parseTomorrow reads daily[1])", { durationMs: 30 });
    tool(ctx, "run_command", { args: ["acceptance/a4-verdict.test.mjs"] }, "exit 0", { durationMs: 170 });
  },
});
emit("harness.build.completed", { itemId: "W2", attempt: 2, status: "done", commit: "c4f9a12", filesChanged: ["forecast.mjs"], turns: 5, toolCalls: 3, model: SONNET }, { dt: 150 });
emit("task.updated", { status: "review", version: 2 }, { taskId: "W2", dt: 60 });
phase("test", { iteration: 3, itemId: "W2" });
route("tester", OPUS, 3, "tester.independent", "The builder is now Claude Sonnet 5.5, so the tester switched to Claude Opus 5.5 to stay independent", { attempt: 2 });
call("tester", OPUS, "judge A5", { taskId: "W2", durationMs: 7000, inTok: 4100, outTok: 420, cost: 0.03 });
const t3 = testReport({ kind: "item", itemId: "W2", includeRegression: true }, "c4f9a12", [R.A1, R.A2, R.A3, R.A4, R.A5(OPUS)], OPUS);
artifact("tests/003.json", "report", t3, 300);
emit("harness.test.completed", { scope: "item", itemId: "W2", candidate: "c4f9a12", passed: 5, failed: 0, errored: 0, skipped: 0, total: 5, score: 1, acceptanceIntact: true, testerModel: OPUS, reportPath: "tests/003.json", failures: [] }, { dt: 100 });
emit("task.done", { verifiedBy: "check", evidence: [{ kind: "test_result", ref: "tests/003.json", summary: "5/5 checks passed", passed: true }], version: 2 }, { taskId: "W2", dt: 80 });
emit("harness.candidate.best", { commit: "c4f9a12", score: 1, previousBest: 1, reverted: false }, { dt: 80 });
phase("reflect", { iteration: 3, itemId: "W2" });
artifact("reflections/003.json", "report", { itemId: "W2", decision: "next", reason: "All W2 checks pass.", fixInstructions: null, lessons: [] });
emit("harness.reflect.decided", { itemId: "W2", decision: "next", reason: "All W2 checks pass.", overriddenBy: "all_checks_pass" }, { dt: 100 });
budget(minutes(), 3);

// W3 attempt 1
phase("build", { iteration: 4, itemId: "W3" });
emit("task.updated", { status: "running", version: 2 }, { taskId: "W3", dt: 60 });
route("builder", HAIKU, 1, "builder.planner_suggested", "Planner suggested Claude Haiku 5.5 for short text changes; accepted", { attempt: 1 });
call("builder", HAIKU, "build W3", {
  taskId: "W3", durationMs: 24000, inTok: 9100, outTok: 2700, cost: 0.019,
  inner: (ctx) => {
    tool(ctx, "edit_file", { path: "app.js" }, "replaced 2 blocks", { durationMs: 30 });
    tool(ctx, "write_file", { path: "README.md" }, "wrote 24 lines", { durationMs: 30 });
    tool(ctx, "run_command", { args: ["acceptance/a6-errors.test.mjs"] }, "exit 0", { durationMs: 160 });
  },
});
emit("harness.build.completed", { itemId: "W3", attempt: 1, status: "done", commit: "d81b0c3", filesChanged: ["app.js", "README.md"], turns: 5, toolCalls: 3, model: HAIKU }, { dt: 150 });
emit("task.updated", { status: "review", version: 2 }, { taskId: "W3", dt: 60 });
phase("test", { iteration: 4, itemId: "W3" });
route("tester", SONNET, 2, "tester.independent", "Tester must differ from the builder (Claude Haiku 5.5); picked Claude Sonnet 5.5", { attempt: 1 });
call("tester", SONNET, "judge A5", { taskId: "W3", durationMs: 6000, inTok: 4000, outTok: 400, cost: 0.017 });
const t4 = testReport({ kind: "item", itemId: "W3", includeRegression: true }, "d81b0c3", [R.A1, R.A2, R.A3, R.A4, R.A5(SONNET), R.A6, R.A7], SONNET);
artifact("tests/004.json", "report", t4, 300);
emit("harness.test.completed", { scope: "item", itemId: "W3", candidate: "d81b0c3", passed: 7, failed: 0, errored: 0, skipped: 0, total: 7, score: 1, acceptanceIntact: true, testerModel: SONNET, reportPath: "tests/004.json", failures: [] }, { dt: 100 });
emit("task.done", { verifiedBy: "check", evidence: [{ kind: "test_result", ref: "tests/004.json", summary: "7/7 checks passed", passed: true }], version: 2 }, { taskId: "W3", dt: 80 });
emit("harness.candidate.best", { commit: "d81b0c3", score: 1, previousBest: 1, reverted: false }, { dt: 80 });
phase("reflect", { iteration: 4, itemId: "W3" });
artifact("reflections/004.json", "report", { itemId: "W3", decision: "finish", reason: "All checks pass and W3 was the last item.", fixInstructions: null, lessons: [] });
emit("harness.reflect.decided", { itemId: "W3", decision: "finish", reason: "All checks pass and W3 was the last item.", overriddenBy: "all_checks_pass" }, { dt: 100 });
budget(minutes(), 4);

// final test and review
phase("final_test", { iteration: 4 });
route("tester", OPUS, 3, "tester.final", "The final test uses a model that built nothing in this run: Claude Opus 5.5");
call("tester", OPUS, "judge A5 (final)", { durationMs: 7000, inTok: 4300, outTok: 410, cost: 0.031 });
const tf = testReport({ kind: "all" }, "d81b0c3", [R.A1, R.A2, R.A3, R.A4, R.A5(OPUS), R.A6, R.A7], OPUS);
artifact("tests/final.json", "report", tf, 300);
emit("harness.test.completed", { scope: "all", itemId: null, candidate: "d81b0c3", passed: 7, failed: 0, errored: 0, skipped: 0, total: 7, score: 1, acceptanceIntact: true, testerModel: OPUS, reportPath: "tests/final.json", failures: [] }, { dt: 100 });

phase("final_review", { iteration: 4 });
route("reviewer", OPUS, 3, "reviewer.final", "The final review uses the strongest model that didn't plan this run");
call("reviewer", OPUS, "final_review", { durationMs: 14000, inTok: 9600, outTok: 700, cost: 0.072 });
const finalReview = {
  verdict: "ship", scores: { meetsWish: 3, works: 3, quality: 2 },
  gaps: ["If the visitor blocks location access, they have to type a city.", "Only tomorrow's maximum chance of rain is shown, not an hourly breakdown."],
  iterateItems: [], reviewerModel: OPUS,
};
artifact("final-review.json", "report", finalReview);
emit("harness.final.reviewed", { verdict: "ship", scores: finalReview.scores, gaps: finalReview.gaps, reviewerModel: OPUS }, { dt: 100 });

// README fact check (Shelf Life)
phase("fact_check", { iteration: 4 });
route("researcher", SONNET, 2, "researcher.skill", "Fact-checking the README needs web search; same researcher model, pinned for the whole skill call");
emit("harness.skill.started", { skillId: "shelf-life", version: "1.0.0", phase: "fact_check", role: "researcher", docLabel: "README.md", childRoomId: `${RUN_ID}-sl-03` }, { dt: 150 });
call("researcher", SONNET, "fact_check", { durationMs: 19000, inTok: 6100, outTok: 1500, cost: 0.039 });
const readmeFacts = [
  finding("R1", 5, "Open-Meteo is free for non-commercial use and needs no API key", "fresh", [S.terms, S.docs], { category: "policy" }),
  finding("R2", 7, "Open-Meteo forecasts up to 7 days ahead", "stale", [S.docs, S.gh], { category: "limit", quote: "forecasts up to 7 days ahead", currentValue: "up to 16 days (forecast_days; the default is 7)", correction: "forecasts up to 16 days ahead (7 by default)" }),
  finding("R3", 9, "The city search returns up to 10 matching places by default", "unsure", [S.geo], { category: "limit", failed: ["independent_sources"] }),
];
artifact("fact-check.json", "report", factCheck(3, "README.md", readmeFacts, { diff: "--- README.md\n+++ README.md\n@@ -7 +7 @@\n-Open-Meteo forecasts up to 7 days ahead.\n+Open-Meteo forecasts up to 16 days ahead (7 by default).\n", searchesUsed: 3 }));
emit("harness.skill.completed", { skillId: "shelf-life", version: "1.0.0", phase: "fact_check", role: "researcher", docLabel: "README.md", childRoomId: `${RUN_ID}-sl-03`, status: "completed", findingCount: 3, staleCount: 1, searchesUsed: 3, reportPath: "fact-check.json" }, { dt: 100 });

// report
phase("report", { iteration: 4 });
route("reporter", HAIKU, 1, "reporter.base", "Writing the report from verified artifacts is a summarising task; tier 1 is enough");
call("reporter", HAIKU, "report", { durationMs: 12000, inTok: 10400, outTok: 1800, cost: 0.015 });
budget(minutes(), 4);
const totalMinutes = minutes();
const spentUsd = Math.round(spent * 100) / 100;

writeArtifact("progress.md", `# Progress (synthetic sample)

## Iteration 1 — W1 "Page layout and city search" — attempt 1 (builder: ${HAIKU})
- Build: done, commit a1c3e5f, files: index.html, styles.css, app.js
- Tests: 2/2 passed
- Decision: next

## Iteration 2 — W2 "Tomorrow's forecast and the umbrella verdict" — attempt 1 (builder: ${HAIKU})
- Build: done, commit b7d2e90, files: forecast.mjs, app.js
- Tests: 4/5 passed (A4 failed: expected "Take an umbrella" for 60% rain, got "No umbrella needed")
- Decision: escalate: read daily.precipitation_probability_max[1], not the hourly arrays
- Lessons: Open-Meteo daily values need daily= in the query string; index 1 is tomorrow

## Iteration 3 — W2 "Tomorrow's forecast and the umbrella verdict" — attempt 2 (builder: ${SONNET})
- Build: done, commit c4f9a12, files: forecast.mjs
- Tests: 5/5 passed
- Decision: next

## Iteration 4 — W3 "Friendly errors and a README" — attempt 1 (builder: ${HAIKU})
- Build: done, commit d81b0c3, files: app.js, README.md
- Tests: 7/7 passed
- Decision: finish
`);

artifact("REPORT.md", "report", `# Umbrella Check: report

> **Synthetic sample.** This report comes from the console's mock fixture, not from a real run. Every number below is made up to show the layout.

## What you asked for
“${WISH}”

## What you got
A single web page, **Umbrella Check**, that asks your browser where you are (or lets you type a city), fetches tomorrow's forecast from Open-Meteo without any key, and answers with a big *Take an umbrella* or *No umbrella needed*, plus the chance of rain, the expected rainfall and the rule it used.

## How to use it
1. Click **Open the product** (or open \`index.html\` from the files).
2. Click **Use my location**, or type a city and press **Check**.
3. Read the answer. The page says which rule it used: 40% chance of rain or 1 mm of rain.

## What was checked
| Check | What it tests | Result |
|---|---|---|
| A1 | index.html has the title and a city input | pass |
| A2 | The page has a search form and a result area | pass |
| A3 | The forecast request asks for tomorrow's daily rain values with timezone=auto | pass |
| A4 | 60% chance of rain gives "Take an umbrella"; 10% and 0 mm gives "No umbrella needed" | pass |
| A5 | The verdict is clear to a non-technical reader (judged by ${OPUS}, with quotes) | pass |
| A6 | When the forecast can't be loaded, the message says so in plain words | pass |
| A7 | README explains how to use the page and names the data source | pass |

7 of 7 checks passed in the final test (tester: ${OPUS}, a model that built nothing in this run).

## Known gaps
- If you block location access, you have to type a city.
- Only tomorrow's maximum chance of rain is shown, not an hourly breakdown.

## Fact check
Proposed, unreviewed. A person, not a model, accepts corrections.

**Plan check (before building).** Plan v1 said the forecast API returns *at most 7 days*. Two sources say *up to 16 days* (open-meteo.com, github.com), so the plan was revised before any code was written. Plan v2: 4 facts checked, none stale.

**README check (after building).**
- Stale: “forecasts up to 7 days ahead” → proposed: “forecasts up to 16 days ahead (7 by default)”. Two different sites contained the value (mechanical check); editorial independence not reviewed. Sources: https://open-meteo.com/en/docs, https://github.com/open-meteo/open-meteo
- Unsure: “up to 10 matching places by default” (only one site stated it). Not verified.
- Current: no API key needed for non-commercial use.

## Assumptions we made for you
- **Location:** ask the browser; if refused, type a city.
- **When to take an umbrella:** 40% chance of rain or more, or at least 1 mm expected.
- **Units:** millimetres and percent.

## Sources
- [Weather Forecast API | Open-Meteo](https://open-meteo.com/en/docs)
- [Geocoding API | Open-Meteo](https://open-meteo.com/en/docs/geocoding-api)
- [Terms | Open-Meteo](https://open-meteo.com/en/terms)
- [Geolocation API | MDN](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API)

## How it was built
| Role | Model |
|---|---|
| Intake, reporter | ${HAIKU} |
| Researcher, plan check, README check | ${SONNET} |
| Planner | ${FABLE} |
| Plan reviewer, final reviewer | ${OPUS} (independent of the planner) |
| Builder | ${HAIKU}; escalated to ${SONNET} for W2 attempt 2 after a failed test |
| Tester | ${SONNET} or ${OPUS}, always a different model from the builder |

4 build iterations · ${totalMinutes} minutes · $${spentUsd.toFixed(2)} (estimated).

\`\`\`text
plan v1 → fact check: 1 stale → revise → plan v2 → auto-approved by ${OPUS}
W1 ✓ · W2 ✗ (4/5) → escalate → W2 ✓ · W3 ✓ · final 7/7
\`\`\`
`);

emit("harness.run.finished", { status: "delivered", summary: "Umbrella Check is ready: all 7 checks passed.", finalScore: 1, allPassed: true, candidate: "d81b0c3", specVersion: 2, reportPath: "REPORT.md", previewPath: "index.html", spentUsd, minutes: totalMinutes }, { dt: 200 });
emit("room.closed", { status: "completed", summary: "Delivered: Umbrella Check, 7/7 checks passed." }, { dt: 100 });

mkdirSync(FIX, { recursive: true });
writeFileSync(join(FIX, "sample-run.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
console.log(`wrote ${events.length} events (${totalMinutes} min, $${spentUsd}) to fixtures/sample-run.jsonl`);
