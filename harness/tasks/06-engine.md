# Brief 06 — engine: the plan → build → test → reflect loop, run state, budgets, CLI

**Branch:** `bill/06-engine` from `origin/bill/harness-contracts` · **Time box:** 4.5 h · **Size:** L (most central piece; you are also the integration owner)

## Mission
Implement the state machine in `harness/docs/ARCHITECTURE.md` §1: it takes a wish and drives every role and worker, choosing each model through the router, writing every event and artifact, enforcing every hard limit, keeping the best candidate, and finishing with an honest report, all without asking the user anything.

## You own (write only here)
`harness/engine/**`, `harness/bin/**`, `harness/tasks/reports/06-engine.md`.

## Read first
Everything in `harness/contracts/` and `harness/docs/`. Then read `packages/event-log/index.mjs` (read-only; you call `createEventLog({ rootDir, roomId })`, then `append({ type, runId?, taskId?, provenance, payload })` and `close()`. Note that it cannot reopen an existing log: one fresh room per run).

## Inputs
`startRun({ wish, config, overrides, dataDir, deps })` (interfaces.md §7). `deps` defaults are wired in **`harness/engine/deps.mjs`**, the only file in the repository that imports every module's real implementation (use dynamic `import()` so a missing module gives a clear "module X not merged yet" error). Tests pass fakes for everything.

## Outputs
- `harness/engine/index.mjs`: `startRun`, `listRuns`, `readRun`, `RUN_ID_PATTERN`.
- Run folder and files exactly as artifacts.md; events exactly as events.md.
- `harness/bin/shallowsee.mjs` CLI: `run "<wish>" [--budget-usd N] [--minutes N] [--autonomy full|confirm_plan]` streams one line per event (phase, model and reason, test score, decision) and prints the run folder and REPORT.md path at the end; `runs`; `config check` (loads apiConfig, validates, prints the routing table from `describeRouting` and `testProvider` for each provider).
- `harness/engine/README.md`.

## Engine requirements
1. **Run setup:** runId (`hr-YYYYMMDD-HHMMSS-xxxx` UTC), folders, `wish.txt`, event log, `room.created`, initial `state.json`. Roster via `router.buildRoster(config)`; an empty roster fails fast with a clear message.
2. **Model calls:** one wrapper `callModel(role, req, routeReq)` used by every role and worker: `router.selectModel` → `harness.route.selected` → `run.started` → `modelClient.complete` (on a non-retryable provider error, try `fallbacks` in order) → `run.completed`/`run.failed` → add usage to spend (USD from `result.usage.costUsd`; if any call's cost is null, mark `usdSource: "unknown"` but still count known costs) → `harness.budget.updated`. Give roles `ctx.llm = req => callModel(role, req, routeReq)`. **Search permission:** give `ctx.search` only to intake, researcher and planner (wrap it to emit `tool.called`/`tool.result` with name `linkup_search`, under the current call's `runId`).
3. **Phases** in order, with `harness.phase.changed` and `state.json` rewrites (atomic: temp file + rename):
   - intake (a `refused` brief → stop with status `failed`, reason in the report) → research → plan → validate with `roles.checkSpecRules` (rule violations = automatic `revise` with the violations as required changes) → plan_review (router `avoidModels: [plannerModel]`; apply the hard approve rule; up to 2 revisions; after that, proceed with the best-scoring spec and note it). Record the approval exactly as artifacts.md (spec version plus sha256 of the exact spec bytes, reviewer model, call id). `confirm_plan` mode: set status `awaiting_confirmation` and wait for `handle.confirmPlan()`.
   - scaffold: `sandbox.createWorkspace` → `tester.materializeAcceptance` (tester model) → keep `acceptanceTree` → `task.created` for every item.
   - For each item in order (respect `dependsOn`): build (router `difficulty`, `attempt`) → test (item scope with regression; router `avoidModels: [builderModel]`, `avoidVendors: [builderVendor]`) → keep-best → reflect → apply engine overrides (artifacts.md Reflection) → next, retry, escalate (attempt+1), or replan (back to plan with `replanReason`; at most 1 replan per run). Append the progress.md entry after each reflection.
   - final_test (scope all) → final_review → at most 1 iterate pass over `iterateItems` → final_test again if iterated → report (reporter) → `harness.run.finished` → `room.closed`.
4. **Keep-best:** after each test, if `score < best.score` then `workspace.git.resetHard(best.commit)` and emit `harness.candidate.best { reverted: true }`; else update best. Score for keep-best = the item-scope score including regression checks.
5. **Limits:** check before every model call and every phase: USD (known spend), minutes, build iterations. When one is exceeded, stop building and jump to final_test → report with status `partial`. Cancellation via `handle.cancel()` aborts in-flight calls through `AbortSignal`, writes `cancelled`, and closes the log.
6. **Status:** `delivered` iff the final score is 1.0 and final review says `ship`; `partial` if anything works but not all; `failed` if nothing ran or a fatal error happened. Errors are recorded (redacted) in `state.error`, never swallowed.
7. **Preview:** for `static-web`, `previewPath = spec.entry.path`.

## Testing (offline)
A complete fake `deps` (scripted roles, fake builder writing files into a real temp git workspace, fake tester returning scripted reports, fake router, real `createEventLog` into a temp dir). Scenarios: happy path (2 items, both pass first time → delivered); retry then pass; escalation (attempt 2 asks the router with attempt 2); regression → reset to best; budget exceeded → partial; plan revised once; refused brief → failed; cancel mid-build; confirm_plan waits for confirmation. Validate the produced log with `node samples/validate-events.mjs <file>` (read-only team checker) and assert the key events.md order.

## Definition of Done
- [ ] Exports match interfaces.md §7; artifacts and events match the contracts.
- [ ] `node --test harness/engine/` passes offline (paste the summary); the event log of the happy path passes `samples/validate-events.mjs`.
- [ ] `node harness/bin/shallowsee.mjs config check` works with no `apiConfig.json` (helpful message) and with one.
- [ ] Integration (after the other branches merge, together with the PM): `node harness/bin/shallowsee.mjs run "I want a page that tells me if I need an umbrella in London tomorrow"` completes with real models. Paste the summary line, or say exactly where it stopped.
- [ ] Hand-back report; branch pushed; SHA reported.

## Out of scope
Prompts (03), tool safety (04), check execution (05), HTTP (07). Don't import `packages/core` this sprint; the core autonomy/approval adapter is a later, separate piece agreed with Astra and Sol.
