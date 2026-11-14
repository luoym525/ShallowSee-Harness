# ShallowSee event contract

> Product scope update: [wish-driven software production](WISH-CODING.md) is the current target. This document describes the existing v1 envelope and the earlier Shelf Life workflow. General project stages, confirmed plan versions and role handoffs still need implementation; the runtime contract has not been changed by the product-definition update.

**Status: v1 draft for review.** Freeze target: Sat 14 Nov, 14:45. After the freeze, only optional fields may be added. Any other change is announced in the team room first and bumps `schemaVersion`.

This is the one interface every part of the project shares. The runtime writes events; the workbench (live and replay), the room MCP server, the Shelf Life workflow, the evaluation scripts and the Databricks loader all read the same log.

- Sample log: [samples/shelf-life-room.sample.jsonl](../samples/shelf-life-room.sample.jsonl) (synthetic, made by [samples/generate-sample.mjs](../samples/generate-sample.mjs))
- Checker: `node samples/validate-events.mjs <file.jsonl>` reports anything that breaks the rules below

## 1. Envelope

Every event has the same outer shape. Only `payload` depends on `type`.

```ts
export interface EventEnvelope<T = Record<string, unknown>> {
  schemaVersion: 1;
  eventId: string;     // globally unique (UUID or ULID). Appending the same eventId twice is a no-op.
  seq: number;         // assigned by the event store: 1, 2, 3 ... per room. This is the cursor.
  roomId: string;
  runId?: string;      // present when the event belongs to one execution
  taskId?: string;     // present when the event belongs to one task
  type: string;        // "family.name", see section 3
  timestamp: string;   // ISO 8601 UTC with milliseconds, assigned by the event store on append
  provenance: Provenance;
  payload: T;
}

export interface Provenance {
  memberId: string | null;   // the registered member that produced the event; null for store or system events
  role: string;              // "user" | "researcher" | "builder" | "reviewer" | "router" | "host" | "system"
  mode: "human" | "api" | "cli" | "external_mcp" | "local_model" | "system";
  provider: string | null;   // "anthropic" | "openai" | "deepseek" | "ollama" | "codex-cli" | "claude-code" | ...
  model: string | null;      // exact model id when known
  identitySource: "configured" | "provider_reported" | "self_reported";
}
```

## 2. Rules

1. **Append-only.** Events are never edited or deleted. Current state is what you get by reading the log in `seq` order.
2. **Persist, then broadcast.** An event is on disk before any subscriber sees it.
3. **One cursor.** `seq` is per room, starts at 1 and has no gaps. Reading "after N" returns events with `seq > N` in order. Filtering by `runId` or `taskId` happens on top of that; there is no separate per-run cursor.
4. **Unknown is `null`.** A token count, cost, duration or model that was not measured is `null`. Never `0`, never a guess. An estimate must say so (`usage.source: "estimated"`).
5. **Ignore what you don't know.** Consumers skip event types and fields they don't recognise, so new optional fields don't break anyone.
6. **Live and replay are the same events.** Replay is a property of the transport (the stream says it is a replay). It is never written into the log.
7. **`run.completed` is not acceptance.** It means one model or CLI execution ended. Only `task.done`, with evidence, means the work was accepted.
8. **Nothing private in payloads.** No keys or tokens. Tool arguments and results are summarised. Raw private reasoning is not part of the protocol; only progress notes and summaries the provider makes public.
9. **Stale work can be recorded but never started.** Routing and run events carry `roomVersion`. Pausing a room increments it, and anything that arrives with an older version must not start new work.

## 3. Event types

Shared shapes used below:

```ts
type TaskStatus = "pending" | "ready" | "running" | "blocked" | "review" | "done" | "failed" | "cancelled";

interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  source: "provider" | "estimated" | "unknown";
}

interface Evidence {
  kind: "check" | "sources" | "test_result" | "artifact" | "user_confirmation";
  ref: string;        // an eventId, artifactId or URL that a person can open
  summary: string;
  passed: boolean;
}

interface Capabilities {
  tools: boolean;
  cancel: boolean;
  resume: boolean;
  streaming: "token" | "chunk" | "none";
  usage: "exact" | "estimated" | "unknown";
}

interface Source { name: string; url: string; domain: string; snippet: string; }
```

### Room and members

| Type | Payload |
|---|---|
| `room.created` | `goal`, `acceptanceCriteria: string[]`, `constraints: string[]`, `limits: { maxRuns, maxMinutes, maxUsd }` (each `number \| null`), `workflow: string \| null`, `driver: "harness" \| "direct"`, `roomVersion: 1`, `synthetic?: boolean` |
| `room.paused` | `roomVersion` (the new, incremented value), `reason?` |
| `room.resumed` | `roomVersion` |
| `room.closed` | `status: "completed" \| "failed" \| "cancelled"`, `summary?` |
| `member.joined` | `memberId`, `displayName`, `role`, `mode`, `provider`, `model`, `capabilities: Capabilities` |
| `member.left` | `memberId`, `reason?` |

The user's goal, acceptance criteria and constraints live in `room.created` and are kept apart from anything an agent suggests later.

`driver` says who ran the room. `"harness"` means the scheduler and router started every run. `"direct"` means the Shelf Life direct runner wrote the log on its own, with no router and no scheduler. A direct log is a fallback for showing the workflow; it must be labelled wherever it is shown and is never evidence that multi-agent orchestration works. `synthetic: true` marks a log that no real model or search produced, such as the sample.

### Messages and routing

| Type | Payload |
|---|---|
| `message.posted` | `messageId`, `author` (memberId), `recipients: string[]` (empty means the whole room), `kind: "user" \| "agent" \| "system"`, `replyTo?` (messageId), `content` |
| `route.decided` | `triggerEventId`, `deliverTo: string[]`, `wake: string[]`, `reasonCode`, `escalate: boolean`, `source: "rules" \| "local_model" \| "fallback"`, `model: string \| null`, `latencyMs: number \| null`, `roomVersion` |
| `route.rejected` | `triggerEventId`, `reason: "stale_room_version" \| "dependency_not_met" \| "concurrency_limit" \| "budget_exceeded" \| "duplicate" \| "paused"`, `roomVersion` |

`wake` is always a subset of `deliverTo`, and both contain only registered member ids. The router proposes; the scheduler decides. Writing a message to an external MCP member is a delivery, not a start: that member only runs when its own client picks the work up.

### Tasks and artifacts

| Type | Payload |
|---|---|
| `task.created` | `title`, `owner: string \| null`, `dependencies: string[]` (taskIds), `inputs: object`, `deliverables: string[]`, `acceptance: string[]`, `status: "pending" \| "ready"`, `version: 1` |
| `task.claimed` | `claimId`, `memberId`, `taskVersion`, `leaseUntil` (ISO time) |
| `task.updated` | `status: TaskStatus`, `version`, `note?` |
| `task.review` | `requestedBy` (memberId), `artifactIds: string[]`, `version` |
| `task.done` | `verifiedBy` (memberId, `"check"` or `"user"`), `evidence: Evidence[]`, `version` |
| `task.failed` | `reason`, `version` |
| `task.cancelled` | `reason`, `version` |
| `artifact.registered` | `artifactId`, `kind: "file" \| "patch" \| "report" \| "pull_request" \| "source_list"`, `location`, `version: string \| null` (commit or content hash), `evidence: Evidence[]` |

Every task event carries `taskId` in the envelope. A claim is valid only for the `taskVersion` it names, so two members cannot both deliver the same task.

### Runs and tools

| Type | Payload |
|---|---|
| `run.started` | `memberId`, `provider`, `model`, `attempt` (1, 2, ...), `triggerEventId`, `roomVersion` |
| `run.output` | `delta: string`, `channel: "answer" \| "progress" \| "summary"` |
| `run.completed` | `stopReason: string \| null`, `usage: Usage`, `durationMs: number \| null` |
| `run.failed` | `error: { code, message }`, `retryable: boolean`, `usage: Usage`, `durationMs: number \| null` |
| `run.cancelled` | `reason` |
| `tool.called` | `toolCallId`, `name`, `args: object` (summarised) |
| `tool.result` | `toolCallId`, `name`, `status: "ok" \| "error" \| "timeout"`, `summary`, `durationMs: number \| null` |

Every run and tool event carries `runId` in the envelope. The workbench builds one answer per run by joining `run.output` deltas in `seq` order. A provider that only returns whole answers emits a single `run.output`.

### Shelf Life workflow

These are written by the Shelf Life tools themselves, so they look the same whether an API member, a CLI member or the direct runner did the work. Each carries `claimId` except the patch, pull request and review events.

| Type | Payload |
|---|---|
| `shelflife.claim.extracted` | `claimId`, `doc` (path), `lineStart`, `lineEnd`, `quote` (exact text from the document), `statement` (the fact in one sentence), `category: "price" \| "version" \| "rate" \| "limit" \| "date" \| "policy" \| "other"` |
| `shelflife.search.completed` | `claimId`, `attempt`, `query`, `provider: "linkup"`, `depth`, `answer: string \| null`, `sources: Source[]`, `durationMs: number \| null` |
| `shelflife.verdict.proposed` | `claimId`, `attempt`, `verdict: "fresh" \| "stale" \| "unsure"`, `currentValue: string \| null`, `correction: string \| null` (replacement for `quote`), `rationale`, `sources: Source[]` |
| `shelflife.check.result` | `claimId`, `attempt`, `check: "quote_in_doc" \| "independent_sources" \| "correction_supported" \| "patch_scope"`, `passed`, `detail` |
| `shelflife.verdict.final` | `claimId`, `verdict`, `currentValue`, `correction`, `sources: Source[]`, `attempts`, `escalated: boolean` |
| `shelflife.patch.proposed` | `doc`, `claimIds: string[]`, `diff` (unified diff) |
| `shelflife.pr.opened` | `repo`, `number`, `url`, `branch`, `commit`, `claimIds: string[]` |
| `shelflife.pr.updated` | `repo`, `number`, `url`, `commit`, `note` |
| `shelflife.review.result` | `commit`, `passed`, `findings: { claimId, issue }[]` |

The checks are code, not prompts:

- `quote_in_doc`: the quoted text really is at those lines of the document.
- `independent_sources`: a "stale" verdict has at least two sources from different domains.
- `correction_supported`: the corrected value appears in the cited snippets.
- `patch_scope`: the diff only touches lines that belong to a stale claim.

A "stale" verdict that fails a check is retried with a reworded search. After the retry limit it is escalated, and if it still cannot be settled it ends as "unsure" for a person to decide.

## 4. Storage and transport

- One file per room: `data/rooms/<roomId>/events.jsonl`. UTF-8, one envelope per line, flushed before broadcast. `data/` is not committed.
- A last line cut off by a crash is skipped on load and reported, never repaired by guessing.
- HTTP and SSE paths belong to the runtime. Whatever they are, reads take a room and an "after `seq`" cursor, and each SSE message is one envelope with `seq` as its id so a client can reconnect without duplicates.
- The Databricks loader and the evaluation scripts read the `.jsonl` file directly. Neither is needed for the core service to start or run.

## 5. Open points for review

1. Does the envelope match what `packages/contracts` already emits? List any field that would force a rewrite and we change the contract, not the code.
2. `run.output.channel`: is "answer / progress / summary" enough for what the CLI backends return?
3. Is `roomVersion` on `route.*` and `run.started` enough to stop a stale route from reviving after a pause, or does the scheduler need it on more events?
4. Should task claims expire by time (`leaseUntil`) or only by version?
