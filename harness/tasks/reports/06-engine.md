# 06 engine — hand-back
Branch: `claude/06-engine-4e3dda` (the session's own branch, cut from `bill/harness-contracts` at 069b5d8 and merged with `origin/main` a8803ca for `harness/skills/`) · Commit: the final SHA is in the message that reported this branch; this file is committed on top of code commit `1584c409915c16c50a594c67f2770b21e3617d2f` · Base: 069b5d8

## What I built
The whole state machine from ARCHITECTURE §1, behind `startRun`, plus the CLI. Everything is tested against fakes; the Shelf Life skill is the **real** `SKILLS` registry from `harness/skills/`.

- `harness/engine/engine.mjs`: run setup (runId, folders, `wish.txt`, event log, `room.created`, atomic `state.json`, roster, sandbox check), the one `callModel` wrapper (router → `harness.route.selected` → `run.started` → `modelClient.complete`, non-retryable error → router fallbacks, `run.completed`/`run.failed`, spend with `usdSource`, `harness.budget.updated`), all phases (intake, research, plan, plan_check, plan_review, scaffold, build/test/reflect per item, final_test, final_review, one iterate pass, fact_check, report), keep-best, limits, cancellation, status.
- `rules.mjs` (hard rules as pure functions), `plan-facts.mjs` (`renderPlanFacts`), `report-fallback.mjs`, `deps.mjs` (the only file importing real modules, dynamic `import()`), `util.mjs`, `index.mjs`, `README.md`.
- `harness/bin/shallowsee.mjs` + `cli-lib.mjs`: `run`, `runs`, `config check`.
- Tests: `engine.test.mjs`, `scenarios.test.mjs`, `cli.test.mjs`, kit in `testkit.mjs` (fakes labelled synthetic).

## Exports (as in contracts/interfaces.md §7; additions noted)
`startRun`, `listRuns`, `readRun`, `RUN_ID_PATTERN` exactly as specified. Additions: `renderPlanFacts` (index.mjs), and `startRun({ onEvent })` (called after each event is durably appended; the CLI streams with it). `deps` accepts extra optional keys: `skills` (default: `SKILLS` from `../skills/index.mjs`), `redact`. `EngineDeps.router` may also carry `describeRouting` (CLI only).

## How to run / test
```
node --test "harness/engine/**/*.test.mjs"
# tests 47 · pass 47 · fail 0 · cancelled 0 · skipped 0

node samples/validate-events.mjs <happy-path events.jsonl>        (the happy-path test also runs this itself)
ok    …/rooms/hr-20261115-053635-xv0j/events.jsonl: 134 events, 0 problem(s), 69 warning(s)
   (every warning is "unknown type harness.* (allowed, consumers skip it)"; the contract adds that family)

node harness/bin/shallowsee.mjs config check        # in this checkout, where harness/providers is not merged
Module harness/providers (workstream 01) is not merged yet (expected harness/providers/index.mjs).    exit=1
node harness/bin/shallowsee.mjs run                 # usage error → exit 2 with the usage text
```
`config check` with no `apiConfig.json` and with one is covered by `cli.test.mjs` against fake `providers`/`router` modules (message: "No apiConfig.json was found … copy apiConfig.example.json … or use the Setup page"; with a config: validation, provider table with `key: set`, the `describeRouting` table, search availability, one `testProvider` line per enabled provider; no key is ever printed). It is **not yet run against the real modules**.

Covered scenarios (each asserts events and artifacts): happy path (delivered, key event order, log validates, approval bound to the sha256 of the exact spec bytes); retry then pass; escalation (router asked with attempt 2/3, tester gets `avoidModels`/`avoidVendors` of the builder); regression → `resetHard` to best (no git while a worker is pending); USD, build-iteration and minutes limits → partial with final_test and report; plan revised (spec-rule violation, reviewer revise, approve-with-low-score/blocker treated as revise); plan not approved after 3 specs → failed with blockers in REPORT; refused brief → failed; cancel mid-build (done resolves only after the builder settled, log closed once, status cancelled); `confirm_plan` waits, records `harness.plan.confirmed` separately and keeps `approval.by = "model"`, cancel while waiting; replan once; final-review iterate (bounded, reverted when worse); a tester that claims `allPassed` with a skipped check or a tampered acceptance tree cannot yield `delivered`; unknown cost; redaction of a planted key everywhere on disk; setup failures (no models, sandbox unavailable).

**Skill wiring (for Lynx-Sol and lym):** `plan_check` and `fact_check` run through `SKILLS["shelf-life"]` with no skill fake.
- Two-source stale plan fact → `plan-check-v1.json` stale with both required checks passed → engine overrides a model "approve" to revise, required change `Update <statement> to <value> (sources: …)` reaches the planner; v2 renders the corrected fact, verifies fresh, approved.
- Insufficient evidence → `unsure`, passed to the reviewer, no override, no block.
- `harness.skill.started/completed` carry `skillId, version, phase, role: "researcher", docLabel, childRoomId`; `reportPath` is `plan-check-v<N>.json` / `fact-check.json` and the test reads it back.
- Child rooms `<runId>-sl-01`, `-02`, … never repeat; the skill's events are only in the child log (the parent log has no `shelflife.*` and one `room.created`).
- Pinned model: every provider request of a skill call goes to exactly `providerIdentity.model`, equal to the child room's recorded provenance; a non-retryable failure of that model reruns the whole skill once with the router's next fallback in a **new** child room.
- Builder/tester option objects are asserted to have no `search`/`skill`/config key; only intake, researcher, planner get `ctx.search`.

## Review fix: P1 "delivered" binding (room #351, lym-astra-monitor)
`decideStatus` used `finalReview.candidate === finalReport.candidate`, so `null === null` passed and a run with every check passing, a ship review and no candidate was `delivered`. Fixed in `rules.mjs` (`bindingProblem`, `isCommitSha`) and `engine.mjs` (`verifyFinalCandidate`): `delivered` now also requires a valid 40-lowercase-hex candidate on the report, the report's scope to be `all`, the review bound to the same SHA and spec version, **the workspace's actual HEAD to equal that SHA, and a clean tree**. The check runs after the final test, review and fact check and fails closed (an unverifiable workspace is not delivered); the engine never commits a dirty tree to make it match. The result is in `harness.run.finished.candidateCheck` and an "Engine note" at the end of REPORT.md says why a run whose checks all passed is `partial`. Regression tests (`binding.test.mjs`, `rules.test.mjs`): null/undefined/malformed/uppercase/foreign candidate, non-`all` scope, untracked and tracked dirty tree, no-`status()` fallback, git failure; these four binding scenarios fail on the previous commit ed022e6 (0 pass / 4 fail) and pass now. The old test that asserted "delivered" for a foreign candidate SHA was wrong and was removed.
**Second review round (room #366):** the first fix fell back to `git.changedFiles(candidate)`, which does not look at the working tree, so a dirty workspace read as clean against the real 04 sandbox. Per the contract ruling the engine now calls only `workspace.git.status()` → `{ clean: boolean, changed: string[] }` and has **no fallback**: a missing method, a throw (redacted), a non-object or ill-typed result, `clean: false`, or a non-empty `changed` all mean "not clean" and the run cannot be `delivered`. Tests: missing method (even for a clean workspace), throwing call, seven malformed shapes, `clean: false` with an empty list, contradictory `clean: true` with changes, untracked and tracked dirty files; the fakes implement `status()` with real `git status --porcelain`. The `isClean` and `changedFiles` code paths were removed.

## Not done / known gaps
- **Integration run with real models: not done.** `providers`, `router`, `roles`, `workers/*` are not merged on this branch, so `deps.mjs` has only been exercised for its "module not merged yet" path (a run with no deps ends `failed` with `error.code: "module_not_merged"`, a state, and a REPORT.md). The first real run will show any shape mismatch with the real modules.
- Assumptions about real modules I could not check: `roles.checkSpecRules(spec)` returns `string[]` (or `{ violations | errors | issues }`); `roles.reviewer.reviewPlan` returns a `PlanReview` (the engine overwrites the engine-filled fields); `providers.createModelClient({ config, pricing })` and `createSearchClient({ config })`; `router.selectModel(req, roster, { overrides, preferVendorDiversity })` throws `code: "no_match"` when the avoid lists leave nothing.
- No parallel work items (one item at a time, as briefed); `vision` checks are not wired (`vision: null`).
- A final-review role failure leaves no review, so the run can only end `partial`; a reporter failure falls back to an engine-written REPORT.md (no model).
- README fact check skips a README larger than 48,000 bytes with the reason "no README.md in the product" (wording to refine).

## Contract requests
1. **Keep-best across items (artifacts/ARCHITECTURE).** Scores of different items have different denominators, so "score below best" needs a definition. Implemented: best resets per item to the pre-item state, scored as (earlier checks that passed in the last report) / (earlier checks + the item's own checks); `null` (no comparison) for the first item and for iterate passes. An iterate pass whose final score drops is reverted and the earlier final report and review are delivered. Please confirm or change.
2. **FinalReview binding.** The engine adds `candidate` and `specVersion` to `final-review.json` (and the `harness.final.reviewed` event) so "delivered" can prove both artifacts describe the same commit and spec. Please add them to the `FinalReview` type (additive).
3. **Plan-fact corrections.** Because `research.json` is fixed after the research phase, a stale research finding would be flagged on every revision. The engine replaces a confirmed-stale fact line with the skill's cited correction (and its sources) in later `plan-facts-v<N>.md`. Please note this in artifacts.md "plan-check".
4. **`harness.skill.completed` for an abandoned first attempt** (pinned model failed, rerun follows) is emitted with `status: "failed"`, `reportPath: null`, `rerunWith: <model>`; only the final attempt has a `reportPath`. UI (08) should pair started/completed by `childRoomId`.
5. **Additive fields** the contract may want to list: `harness.route.selected` `purpose`, `suggested`; `run.started` `fallbackFrom`; `harness.plan.reviewed` and `plan-review.json` `engineOverrides` (and `modelVerdict` in the file); `harness.candidate.best` `rejected`; `harness.skill.completed` `confirmedStaleCount`, `reason`, `rerunWith`; `harness.run.finished` `approvedSpecVersion`, `finalReviewVerdict`; `state.json` `userConfirmation` (the user's separate confirmation in `confirm_plan` mode; `approval` stays the model's).
6. **Router `no_match` for the tester.** When avoidance leaves no candidate (for example a Haiku-only roster) the engine retries the route without the avoid lists and appends "no other suitable model is configured" to the route reason, instead of failing the run. Tell me if the router should do this itself.

7. **Workspace dirty check (workstream 04): decided in room #366.** `Workspace.git.status(): Promise<{ clean: boolean; changed: string[] }>`, read-only, tracked and untracked; being added by the 04 owner. The engine requires it and fails closed without it.
8. `harness.run.finished` gains `candidateCheck: { ok, reason }` (additive), and the final review is bound by `candidate` + `specVersion` (request 2).

9. **Provider quota (room #486):** An optional hard `RouteRequest.avoidProviders: string[]` lists unavailable configured provider IDs. The engine maintains that exclusion in memory for each run. A `rate_limit` that survives provider retries can switch to another eligible model at the same tier. The engine emits `harness.provider.limited` with `{ provider, kind: "quota_exhausted" | "rate_limit", resetAt: string | null, reason: string }`. The reason contains safe routing information. When provider quota blocks progress, run state, the terminal event and the run summary add `pausedReason: "api_quota"` and `resumeAt` (the earliest known future reset, or null). The run ends partial, retains its spec and workspace where available, and writes a local report with the saved best commit and completed work. The user can start a fresh run after reset or configure another provider. USD, time and iteration caps keep their existing budget outcomes.

## Integration notes for the engine / PM
- After merging 01 → 02 → 04 → 05 → 10 → 03, run `node --test "harness/engine/**/*.test.mjs"` (it must not change: tests inject every dependency) and then `node harness/bin/shallowsee.mjs config check --offline`, then the umbrella wish with `--budget-usd 2 --minutes 20`.
- Data lands in `<repo>/data/rooms/<runId>/events.jsonl` (+ `<runId>-sl-NN` child rooms) and `<repo>/data/harness/runs/<runId>/`; the console server can use `startRun`'s `onEvent` or tail the log.
- `deps.mjs` falls back gracefully: a missing `harness/skills` skips both fact checks with "Shelf Life skill not merged".
