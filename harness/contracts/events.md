# Contract: harness events

The engine writes one event log per run with `createEventLog({ rootDir: "<repo>/data/rooms", roomId: runId })` from `packages/event-log` (read-only dependency; do not modify it). The envelope is the team's v1 envelope from [docs/CONTRACT.md](../../docs/CONTRACT.md): `schemaVersion, eventId, seq, roomId, runId?, taskId?, type, timestamp, provenance, payload`. The store assigns `seq`, `eventId` and `timestamp`.

**Naming:** the harness *run* is the room (`roomId = runId`, e.g. `hr-20261115-013012-a1b2`). The envelope's `runId` field is **one model call**, `"call-0001"`, `"call-0002"`, …, as CONTRACT.md defines it. Work items are tasks (`taskId = "W1"`, …).

**Provenance:** `{ memberId: null, role, mode, provider, model, identitySource: "configured" }` where `role` is the harness role (`"engine"`, `"intake"`, `"researcher"`, `"planner"`, `"reviewer"`, `"builder"`, `"tester"`, `"reflector"`, `"reporter"`), `mode` is `"api"` for model calls and `"system"` for engine events, and `provider`/`model` are set for model calls, otherwise `null`.

Consumers ignore event types and fields they don't know (CONTRACT rule 5). Unknown numbers are `null` (rule 4). No keys, no raw tool file contents, no private reasoning in payloads (rule 8).

## Standard v1 events the engine writes

| Type | When | Payload (v1 fields + harness extras) |
|---|---|---|
| `room.created` | run start | `goal` (the wish), `acceptanceCriteria: []`, `constraints: []`, `limits: { maxRuns: maxBuildIterations, maxMinutes, maxUsd }`, `workflow: "harness.autopilot.v1"`, `driver: "harness"`, `roomVersion: 1`, extras: `autonomy` |
| `task.created` | after plan approval, one per work item | `title`, `owner: "builder"`, `dependencies`, `inputs: { difficulty }`, `deliverables: files`, `acceptance: checkIds`, `status: "ready" \| "pending"`, `version: specVersion` |
| `task.updated` | item status changes | `status` (`running` while building/testing, `review` after build, `failed`), `version`, `note?` |
| `task.done` | all of an item's checks pass | `verifiedBy: "check"`, `evidence: [{ kind: "test_result", ref: "tests/NNN.json", summary, passed: true }]`, `version` |
| `task.failed` | attempts exhausted | `reason`, `version` |
| `run.started` | before each model call | `memberId: null`, `provider`, `model`, `attempt`, `triggerEventId: null`, `roomVersion: 1`, extras: `role`, `purpose` (e.g. `"plan"`, `"build W2"`) |
| `run.completed` | after each model call | `stopReason`, `usage`, `durationMs` |
| `run.failed` | model call failed | `error: { code, message }` (redacted), `retryable`, `usage`, `durationMs` |
| `tool.called` / `tool.result` | builder/tester tool use and searches (envelope `runId` = the call) | `toolCallId`, `name`, `args` (summarised: paths and short strings only) / `status`, `summary`, `durationMs` |
| `artifact.registered` | each artifact file written | `artifactId` (= file name, e.g. `"spec.json"`), `kind: "report" \| "file" \| "source_list"`, `location` (path relative to the run folder), `version` (sha256 of content), `evidence: []` |
| `room.closed` | run end | `status: "completed" \| "failed" \| "cancelled"` (`delivered`/`partial` → `completed`), `summary` |

## `harness.*` events (new family, additive)

| Type | Payload |
|---|---|
| `harness.phase.changed` | `phase`, `previous`, `iteration`, `itemId: string \| null` |
| `harness.route.selected` | `role`, `model`, `tier`, `rule`, `reason`, `escalated`, `pinned`, `attempt` |
| `harness.note` | `role`, `text` (≤ 300 chars, a public progress note) |
| `harness.brief.ready` | `title`, `productKind`, `mustHaves`, `assumptions` (array of `{topic, assumed}`), `refused` |
| `harness.research.ready` | `findingCount`, `searchesUsed`, `sources: Source[]` (deduplicated, ≤ 12), `basis: "search" \| "model_knowledge" \| "mixed"` |
| `harness.plan.ready` | `specVersion`, `title`, `stack`, `items: [{ id, title, difficulty }]`, `checkCount`, `executableCheckCount` |
| `harness.plan.reviewed` | `verdict`, `scores`, `issues`, `reviewerModel`, `reviewerCallId`, `specVersion`, `specSha256`, `sameModelAsPlanner`, `approval: { by: "model", model, at, specVersion, specSha256, reviewRef, callId } \| null` |
| `harness.plan.confirmed` | `by: "user"`, `at`, `specVersion`, `specSha256` (only in `confirm_plan` mode) |
| `harness.build.completed` | `itemId`, `attempt`, `status`, `commit`, `filesChanged`, `turns`, `toolCalls`, `model` |
| `harness.test.completed` | `scope`, `itemId: string \| null`, `candidate`, `passed`, `failed`, `errored`, `skipped`, `total`, `score`, `acceptanceIntact`, `testerModel`, `reportPath`, `failures: [{ checkId, message }]` (≤ 5) |
| `harness.reflect.decided` | `itemId`, `decision`, `reason`, `overriddenBy: null \| "all_checks_pass" \| "attempts_exhausted" \| "budget"` |
| `harness.candidate.best` | `commit`, `score`, `previousBest: number \| null`, `reverted: boolean` (true when the engine reset to the best commit) |
| `harness.budget.updated` | `spentUsd`, `usdSource`, `elapsedMinutes`, `iterations`, `limits`, `exceeded: null \| "usd" \| "minutes" \| "iterations"` |
| `harness.final.reviewed` | `verdict`, `scores`, `gaps`, `reviewerModel` |
| `harness.skill.started` / `harness.skill.completed` | `skillId`, `version`, `phase`, `role: "researcher"`, `docLabel`, `childRoomId` / plus `status`, `findingCount`, `staleCount`, `searchesUsed`, `reportPath: "fact-check.json"` |

The Shelf Life skill writes its full audit (its own `room.created` with optional `parentRoomId`, and the existing `shelflife.*` events from CONTRACT.md) into a **separate child room** `data/rooms/<runId>-fact-check/events.jsonl`, never into the parent run's log, so there are no duplicate `room.created` events and the team workbench can display it unchanged. Never `shelflife.pr.opened` inside a harness run.
| `harness.run.finished` | `status: RunStatus`, `summary`, `finalScore`, `allPassed`, `candidate` (final commit), `specVersion`, `reportPath`, `previewPath`, `spentUsd`, `minutes` |

## Typical order (abridged)

```
room.created
harness.phase.changed {phase:"intake"}  harness.route.selected {role:"intake"}  run.started  run.completed  artifact.registered brief.json  harness.brief.ready
harness.phase.changed {phase:"research"}  harness.route.selected  run.started  tool.called linkup_search  tool.result  …  run.completed  harness.research.ready
harness.phase.changed {phase:"plan"}  …  harness.plan.ready
harness.phase.changed {phase:"plan_review"}  …  harness.plan.reviewed {verdict:"approve", approval:{by:"model",…}}
task.created W1 … task.created Wn
harness.phase.changed {phase:"scaffold"}  …
loop: harness.phase.changed {phase:"build", itemId:"W1"}  harness.route.selected {role:"builder"}  run.started  tool.called … run.completed …  harness.build.completed
      harness.phase.changed {phase:"test"}  harness.route.selected {role:"tester"}  harness.test.completed  (task.done | task.updated)
      harness.candidate.best  harness.phase.changed {phase:"reflect"}  …  harness.reflect.decided  harness.budget.updated
harness.phase.changed {phase:"final_test"} … harness.final.reviewed … harness.run.finished  room.closed
```

The console UI must render a run from these events alone (live and replay), with `state.json` as a shortcut for the summary.
