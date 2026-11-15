# harness/engine: the loop

The engine turns one wish into one delivered product, without asking the user anything during the run. It owns the state machine in [ARCHITECTURE §1](../docs/ARCHITECTURE.md): every arrow is code; models only return labels that the hard rules validate first.

```js
import { startRun, listRuns, readRun, RUN_ID_PATTERN } from "./harness/engine/index.mjs";

const handle = startRun({ wish, config, overrides: { budget: { maxUsdPerRun: 3 }, autonomy: "full" }, dataDir });
handle.runId;                 // "hr-20261115-013012-a1b2"
handle.cancel("reason");      // aborts; done resolves "cancelled" only after every in-flight call, tool and process settled
handle.confirmPlan();         // confirm_plan mode only, while awaiting_confirmation
const summary = await handle.done;   // { runId, status, finalScore, spentUsd, minutes, reportPath, workspaceDir, previewPath }
```

`startRun` also accepts `onEvent(envelope)` (additive; the CLI uses it) and `deps` (tests inject fakes; defaults come from `deps.mjs`).

## CLI

```
node harness/bin/shallowsee.mjs run "<wish>" [--budget-usd N] [--minutes N] [--autonomy full|confirm_plan]
node harness/bin/shallowsee.mjs runs
node harness/bin/shallowsee.mjs config check [--offline]
```

`run` prints one line per event (phase, model and the router's reason, test score, decision, "auto-approved by <model>", skill results) and ends with the run folder and the REPORT.md path. Exit code 0 only for `delivered`; 1 for partial, failed, cancelled or a config problem; 2 for usage errors. `config check` validates `apiConfig.json`, prints the routing table (`describeRouting`) and calls `testProvider` for each enabled provider (`--offline` skips the network); with no `apiConfig.json` it says how to create one.

## Files

| File | What |
|---|---|
| `index.mjs` | public exports (interfaces.md §7) |
| `engine.mjs` | the state machine: setup, `callModel`, phases, keep-best, limits, cancellation, status |
| `rules.mjs` | the hard rules as pure functions: plan approval, plan-check blockers, reflection overrides, `delivered`, build order |
| `plan-facts.mjs` | deterministic `renderPlanFacts(spec, research)` for the plan check (no model) |
| `report-fallback.mjs` | engine-written REPORT.md when the reporter cannot run (refused, plan not approved, cancelled, failed early) |
| `deps.mjs` | the ONLY file that imports every real module (dynamic `import()`; a missing module gives "module X not merged yet") |
| `util.mjs` | ids, atomic writes, usage normalisation, redaction |
| `testkit.mjs` | offline fakes for the tests (marked synthetic: nothing in it is a real model, search or product) |

## What the engine enforces (not the models)

- **Approval:** `approve` is accepted only when every score is at least 2 and there is no blocker; spec-rule violations (`roles.checkSpecRules`) and confirmed-stale plan facts turn it into `revise`. Max 2 revisions; the third unapproved spec ends the run `failed`, reason "plan not approved", blockers listed in the report. Recorded as `{ by: "model", model, specVersion, specSha256, reviewRef, callId }` and never as a user confirmation (`confirm_plan` records `harness.plan.confirmed { by: "user" }` separately).
- **Plan check (`plan_check`):** `plan-facts-v<N>.md` is rendered from spec and research, one plain text line per fact and its `Source: <url>` lines (room #284). The Shelf Life skill audits it; a two-source stale fact becomes an automatic blocker with the correction as a required change. Skipped or failed checks are recorded and never block. A stale fact is replaced by its cited correction in later renders so a stale research finding cannot loop forever.
- **Skills:** only the engine calls `SKILLS["shelf-life"]`, only in `allowedPhases`, as role `researcher`. `ctx.llm` is pinned to exactly `providerIdentity.model` (no fallback inside one call). If the pinned model fails non-retryably, the whole skill is rerun once with the router's next fallback in a new child room. Child rooms are `<runId>-sl-01`, `-02`, … (an event log cannot be reopened). A skill failure never fails the run; `fact-check.json` is skipped (recorded) with no README, no search, no skill or no budget.
- **Search permission:** only intake, researcher and planner get `ctx.search`; builder and tester get none and no way to reach skills.
- **Keep-best:** after each item test, a score below the best (the state before the item, or the best attempt so far) resets the workspace with `git.resetHard(best.commit)` and emits `harness.candidate.best { reverted: true }`. An iterate pass after the final review that lowers the final score is reverted and the earlier candidate is delivered.
- **Limits:** USD (known spend), minutes and build iterations are checked before every model call and phase. A limit stops building, runs the final test and the report, status `partial`; the fact check is skipped.
- **Cancellation:** one run-level `AbortController` goes to every model call, tool and worker. The engine awaits settlement of the builder/tester before any git operation, state write, `harness.run.finished` or closing the log.
- **`delivered`** iff the final `scope: all` report really has every check executed and passed (re-derived from `summary` and `results`, not only the tester's `allPassed`), the final review says `ship`, and both are bound to the same candidate commit and the approved spec version. Otherwise `partial` when at least one check passed, else `failed`.
- **Unknown stays `null`:** if any call's cost is unknown the run's `usdSource` is `"unknown"` (known costs still count); a run with no known cost reports `null`, never `0`.
- **Secrets:** every error stored in an event, `state.error` or a report goes through redaction (configured keys, `Bearer …`, `sk-…`).

## Tests

```
node --test "harness/engine/**/*.test.mjs"
```

Offline, no keys, no network. Fakes: router, roles, builder, tester, model and search clients; real: `packages/event-log`, git (temp workspace), and the real `harness/skills` registry running Shelf Life against scripted LLM and search responses. The happy-path logs are validated with `node samples/validate-events.mjs`.
