# Contract: run artifacts

Every run has a folder `data/harness/runs/<runId>/` (`data/` is ignored by git). The engine writes every file in it; roles and workers return values and the engine persists them. The console server reads them. JSON files are pretty-printed, UTF-8, 2-space indent.

`runId` matches `/^hr-\d{8}-\d{6}-[a-z0-9]{4}$/`, for example `hr-20261115-013012-a1b2` (UTC date and time plus 4 random characters).

## `state.json` — RunState (rewritten atomically after every phase change)

```ts
interface RunState {
  runId: string;
  wish: string;
  title: string | null;                 // from the spec once planned
  status: "running" | "awaiting_confirmation" | RunStatus;   // RunStatus = delivered | partial | failed | cancelled
  phase: "intake" | "research" | "plan" | "plan_review" | "awaiting_confirmation" | "scaffold" | "build" | "test"
       | "reflect" | "final_test" | "final_review" | "fact_check" | "report" | "done"
       | "plan_check";                  // between "plan" and "plan_review"
  autonomy: "full" | "confirm_plan";
  approval: { by: "model"; model: ModelRef; at: string; specVersion: number; specSha256: string; reviewRef: string; callId: string }
          | { by: "user"; at: string; specVersion: number; specSha256: string } | null;   // see PlanReview rules
  iteration: number;                    // build attempts so far (all items)
  currentItemId: string | null;
  items: Record<string, { status: "pending" | "building" | "testing" | "passed" | "failed"; attempts: number; lastScore: number | null }>;
  best: { commit: string; score: number } | null;
  models: Partial<Record<RoleName, ModelRef>>;  // most recent model used per role
  spend: { usd: number | null; usdSource: "provider" | "estimated" | "unknown"; calls: number; inputTokens: number | null; outputTokens: number | null };
  limits: { maxUsdPerRun: number; maxMinutesPerRun: number; maxBuildIterations: number };
  startedAt: string; updatedAt: string; finishedAt: string | null;
  error: { code: string; message: string } | null;
  previewPath: string | null;           // for static-web: entry HTML path relative to workspace
}
```

## `brief.json` — Brief (intake)

```ts
interface Brief {
  title: string;                        // short product name
  restatedGoal: string;                 // the wish in one or two clear sentences
  targetUser: string;
  productKind: "web_page" | "web_app" | "cli_tool" | "script" | "data_report" | "other";
  mustHaves: string[];                  // 2–8 user-visible capabilities
  niceToHaves: string[];
  assumptions: { topic: string; assumed: string; why: string }[];   // replaces every question we would have asked the user
  constraints: string[];                // e.g. "no API keys required", "runs offline after load"
  researchQuestions: string[];          // 1–5 questions for the researcher
  refused: { reason: string } | null;   // non-null only when the wish is unsafe or impossible; the run then stops honestly
}
```

## `research.json` — Research (researcher)

```ts
interface Research {
  findings: { question: string; answer: string; sources: Source[]; confidence: "high" | "medium" | "low";
              basis: "search" | "model_knowledge" }[];      // model_knowledge only when search is unavailable or empty
  recommendedApproach: string;          // 2–5 sentences: stack, data source, why
  externalServices: { name: string; url: string; needsKey: boolean; notes: string }[];
  risks: string[];
  searchesUsed: number;
}
```

## `spec.json` — Spec (planner). The definition of done.

```ts
interface Spec {
  specVersion: number;                  // 1, then +1 per replan
  title: string;
  summary: string;                      // what and why, 3–6 sentences, no low-level how
  stack: "static-web" | "node";         // python is out of scope this sprint (no OS sandbox for it here)
  entry: { kind: "open_html"; path: string }                               // static-web, e.g. "index.html"
       | { kind: "command"; run: string[] }                                // e.g. ["node","cli.mjs","--help"]
       | { kind: "server"; run: string[]; port: number; path: string };    // e.g. ["node","server.mjs"], 4401, "/"
  architecture: string;                 // short paragraph: files and how they fit
  assumptions: string[];
  outOfScope: string[];
  sources: Source[];                    // facts from research that the plan relies on
  workItems: WorkItem[];                // 2–8, in build order
  acceptance: AcceptanceCheck[];        // every item has ≥1 check; ≥60% of checks are executable (not llm_judge/visual)
}

interface WorkItem {
  id: string;                           // "W1", "W2", ...
  title: string;
  description: string;                  // what the user gets when this is done
  difficulty: "easy" | "medium" | "hard";   // drives model routing
  suggestedModel: ModelRef | null;      // planner's choice of builder model, from the roster it was given; router validates
  modelReason: string | null;           // one line, shown in the UI ("Simple HTML; the cheapest coder is enough")
  dependsOn: string[];
  files: string[];                      // expected files to create or change (guidance, not a whitelist)
  checkIds: string[];
}

type AcceptanceCheck = { id: string; itemId: string; description: string } & (
  | { type: "command"; run: string[]; expectExitCode: number; expectStdoutIncludes?: string[]; timeoutMs?: number;
      generate: boolean }               // generate:true → tester writes the script at `run[1]` under acceptance/ during scaffold
  | { type: "file"; path: string; mustContain?: string[]; mustMatch?: string }      // mustMatch: regex source
  | { type: "http"; start: string[]; port: number; request: { method: "GET" | "POST"; path: string; body?: string; headers?: Record<string,string> };
      expectStatus: number; expectBodyIncludes?: string[] }
  | { type: "llm_judge"; rubric: string; files: string[] }       // judge reads these files and must quote evidence
  | { type: "visual"; page: string; rubric: string }             // optional, needs a headless browser and a vision model
);
```

Rules the planner's output must satisfy (checked in code by the engine; violations trigger a revision):
- Every `WorkItem.checkIds` entry exists in `acceptance` and points back with `itemId`.
- Generated command checks live under `acceptance/` (`run[1]` starts with `acceptance/`).
- Commands use only `node` as `run[0]`; files Node runs use the `.mjs` extension.
- Ports are in 4400–4499.
- Everything runs inside the sandbox (interfaces.md "Sandbox boundary"): no reading or writing outside the workspace, no spawning processes. So a CLI is tested with a direct `command` check (`run: ["node","cli.mjs","7"]` + `expectStdoutIncludes`, `generate: false`), a server with an `http` check, and generated scripts only import the product's modules or read its files.

## `plan-review.json` — PlanReview (reviewer)

```ts
interface PlanReview {
  verdict: "approve" | "revise";
  scores: { coversWish: number; feasible: number; testable: number; scoped: number };   // 0–3 each
  issues: { severity: "blocker" | "major" | "minor"; text: string }[];
  requiredChanges: string[];            // empty when approved
  // Filled by the engine, not the model:
  reviewerModel: ModelRef;
  reviewerCallId: string;               // envelope runId of the review call, e.g. "call-0007"
  specVersion: number;                  // exact spec reviewed
  specSha256: string;                   // sha256 of the exact spec.json bytes reviewed
}
```
Hard rules (engine):
- `approve` is only accepted when every score is ≥ 2 and there is no blocker; otherwise it is treated as `revise`.
- **Plan check:** every `planCheck` finding with verdict `stale` whose `independent_sources` and `correction_supported` checks both passed is an automatic blocker. The engine adds the required change "Update <statement> to <currentValue> (sources: …)" and treats the verdict as `revise`. `unsure` findings are passed to the reviewer as major issues to weigh. A skipped or failed plan check is recorded and does not block (no search configured ≠ wrong plan).
- **Independence:** the reviewer gets a fresh context (brief, research, spec only: never the planner's messages) and a different model from the planner whenever another tier-3 model is configured (router `avoidModels`). If only one tier-3 model exists, the same model may review, and `harness.plan.reviewed` says `sameModelAsPlanner: true`.
- **Binding:** the approval in `state.json` is `{ by: "model", model, at, specVersion, specSha256, reviewRef: "plan-review.json", callId }`. Any later spec change (replan) voids it and requires a new review. The approval is never written or shown as a user confirmation; in `confirm_plan` mode the user's confirmation is recorded separately as `{ by: "user", at, specVersion, specSha256 }`.

## `tests/NNN.json`, `tests/final.json` — TestReport (tester)

```ts
interface TestReport {
  scope: { kind: "item"; itemId: string; includeRegression: boolean } | { kind: "all" };
  candidate: string | null;             // workspace commit tested
  results: {
    checkId: string; itemId: string; type: AcceptanceCheck["type"];
    status: "pass" | "fail" | "error" | "skipped";
    evidence: { command?: string[]; exitCode?: number | null; stdoutTail?: string; stderrTail?: string;
                httpStatus?: number; bodyExcerpt?: string; quotes?: { file: string; text: string }[]; judgeModel?: ModelRef };
    message: string;                    // one line, why it passed or failed
    durationMs: number;
  }[];
  summary: { total: number; passed: number; failed: number; errored: number; skipped: number };
  score: number;                        // passed / (total - skipped), exact (not rounded; round only for display), 0 when nothing ran
  acceptanceIntact: boolean;            // tree hash of acceptance/ matches the scaffold
  allPassed: boolean;                   // total > 0 && passed === total && acceptanceIntact (no fail, error or skipped). The ONLY basis for "delivered".
  testerModel: ModelRef | null;
}
```
Meta-checks (tester code): a `pass` needs evidence (exit code and output for command, status for http, a verbatim quote found in the named file for llm_judge); without it the result becomes `fail` with message `"unsupported pass"`. If `acceptanceIntact` is false, every result is `fail` (message "acceptance tests were modified"), and after writing the report the tester restores `acceptance/` from the scaffold commit (`git.restorePath`) so the next attempt runs the frozen tests.

## `reflections/NNN.json` — Reflection (reflector)

```ts
interface Reflection {
  itemId: string;
  decision: "next" | "retry" | "escalate" | "replan" | "finish" | "stop";
  reason: string;
  fixInstructions: string | null;       // concrete, for the builder's next attempt
  lessons: string[];                    // 0–3 durable notes appended to progress.md
}
```
Engine overrides: all item checks pass → `next` (or `finish` when it was the last item); attempts exhausted → `next` with the item marked failed; budget exhausted → `stop`.

## `final-review.json` — FinalReview (reviewer)

```ts
interface FinalReview {
  verdict: "ship" | "iterate";
  scores: { meetsWish: number; works: number; quality: number };   // 0–3 each
  gaps: string[];                        // honest list of what is missing or weak
  iterateItems: string[];                // item ids to rebuild when verdict is iterate
  reviewerModel: ModelRef;
}
```

## `plan-check-v<N>.json` and `fact-check.json` — FactCheck (Shelf Life skill)

Two uses of the same skill and format, each in its own child room:
- **`plan_check`** (before plan review, once per spec version): the engine renders `plan-facts-v<N>.md` deterministically from the spec and research (no model): one Markdown line per checkable fact the plan relies on, i.e. each external service and endpoint, runtime and standard versions, documented limits, and every finding with its sources. The skill audits that document, and the result goes to the plan reviewer. This is the "verify the plan is current before development" step (room #216, #247, #268).
- **`fact_check`** (after final review): audits the delivered product's `README.md`.

```ts
interface FactCheck {
  status: "completed" | "skipped" | "failed";
  reason: string | null;                 // why skipped or failed
  childRoomId: string | null;            // "<runId>-sl-NN": the skill's own event log for this invocation
  doc: { label: string; sha256: string } | null;
  findings: {
    claimId: string; line: number; quote: string; statement: string;
    category: "price" | "version" | "rate" | "limit" | "date" | "policy" | "other";
    verdict: "fresh" | "stale" | "unsure";
    currentValue: string | null; correction: string | null;
    sources: Source[];
    checks: { check: "quote_in_doc" | "independent_sources" | "correction_supported" | "patch_scope"; passed: boolean; detail: string }[];
  }[];
  diff: string | null;                   // unified diff, zero context; proposal only, never applied during the run
  reviewStatus: "unreviewed";
  searchesUsed: number;
}
```
The engine runs it on the workspace's `README.md` (if the product has one) after `final_review` and before `report`. Stale findings never change the run status; they go in REPORT.md under **Fact check** with their sources, marked "proposed, unreviewed".

## `progress.md` — structured notes (engine appends; builder and reflector read)

```markdown
## Iteration 3 — W2 "Fetch tomorrow's forecast" — attempt 2 (builder: anthropic/claude-sonnet-5-5)
- Build: done, commit 4f2a9c1, files: app.js, forecast.mjs
- Tests: 3/4 passed (A4 failed: expected "Umbrella: yes", got "undefined")
- Decision: retry: parse precipitation_probability_max from daily, not hourly
- Lessons: Open-Meteo daily fields need `daily=` in the query string
```

## `REPORT.md` — final report (reporter)

Sections, in order: **What you asked for** · **What you got** (one paragraph) · **How to use it** (exact steps) · **What was checked** (table of checks with pass/fail) · **Known gaps** (from final review and failed checks, honest) · **Fact check** (Shelf Life findings with sources, "proposed, unreviewed"; or why it was skipped) · **Assumptions we made for you** · **Sources** · **How it was built** (models per role, iterations, time, cost; cost `unknown` when not measured).
