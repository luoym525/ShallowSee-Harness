# ShallowSee Harness — coordination and interface notes

*14 November 2026, Europe/London. Discussion snapshot, not a declaration that the product is implemented or the team has approved every proposal. Companion to [the architecture plan](shallowsee-design-plan.md).*

## Outline

The detailed architecture plan was shared in the ShallowSeek meeting. The discussion reconciled two proposals: a general multi-model collaboration platform and Fable's Shelf Life workflow for detecting and repairing outdated documentation.

The merged proposal retains **model API + official CLI + MCP rooms + interchangeable local 0.5B / rule routing**. Shelf Life is the proposed demonstration workflow: research with sources, edit documentation, independently review it, request a targeted revision, and accept the resulting artifact with evidence.

The earlier proposal for a separate Python implementation and a second `server/` / `web/` tree was withdrawn. The proposed implementation builds on the existing local TypeScript scaffold. That scaffold has not yet been published or accepted as a working product. The user previously limited work to structural design; the current implementation scope remains to be confirmed while design coordination continues.

## Three owners and supporting agents

| Workstream | Proposed or accepted agent responsibility | Status |
| --- | --- | --- |
| Runtime and integrations | Codex architecture/integration: `packages/core`, `packages/providers`, `apps/server`, `apps/mcp`, `apps/cli` | Architecture and interface review accepted; implementation scope pending |
| Contract and demonstration workflow | Claude-Fable: `docs/CONTRACT.md`, `packages/shelf-life` | Proposed owner; contract draft pending |
| Workbench | Codex-青舟: `apps/web` | Invitation to claim; not yet accepted in this snapshot |
| Local routing and routing evaluation | `packages/router`, model service, labeled routing cases | Owner pending |
| Handbook, reference answers, workflow evaluation and Databricks | lym's agent, with human source review | Scope and access pending |
| Meeting monitoring | GPT-6 Luna | Active; read-only, immediate new-message reports to coordinator, one-minute summaries |

These are agent workstreams, not a claim that the three human participants have accepted named assignments. Luna does not implement the interface or make product decisions. The coordinator decides how to act on reports within the user's instructions.

## Interfaces to freeze

### One event envelope

Proposed fields: `schemaVersion`, `eventId`, `seq`, `roomId`, optional `runId` and `taskId`, `type`, `timestamp`, `provenance`, and `payload`.

The contract must define the scope of sequence numbers and replay cursors. Events persist before broadcast; live display and replay consume the same durable log. Replay is labeled. Unknown token counts and costs remain unknown, rather than becoming zero or fabricated estimates.

### Runs, tasks and evidence

A completed model response ends a run. It does not by itself prove that a task is complete. A task needs explicit acceptance criteria and evidence, with a review transition before `done`.

Task ownership needs an atomic claim and an execution version or lease. The contract must specify who may claim, renew, submit and accept a task, and how stale callbacks are rejected. Artifacts need a stable reference, version and verification evidence.

### Managed and external members

The service can launch a managed API or official CLI adapter. An external MCP client normally retrieves its own pending work. Writing a notification does not demonstrate that the external client has started executing.

Each provider reports supported capabilities: tools, cancellation, session resume, output granularity and usage reporting. A fresh CLI process with injected context must not be described as native session resume. API text streaming is not a complete tool-execution loop.

### Routing and scheduling

The public decision retains `deliverTo`, `wake`, `reasonCode`, `escalate` and `source`. `wake` must be a subset of `deliverTo`, and all member IDs must be registered.

The model may suggest a recipient and action. Program logic validates them and applies room version, task dependencies, concurrency and execution limits. Malformed or invalid decisions fall back to rules. The model does not directly execute commands or mark tasks accepted.

### Workflow and downstream storage

Shelf Life should run through the shared execution and event boundaries. A separate direct-run demonstration, if built, must be labeled and cannot be presented as evidence that multi-agent orchestration works.

Linkup is a proposed research tool. Databricks is a proposed downstream event sink, with retry and independent ingestion; its availability must not determine whether the local service can start. Bounty selection and account access are still pending.

## Existing scaffold: observed limits

The local scaffold includes room messaging, API and CLI adapters, a JSONL store, SSE, a room MCP server and a web interface. These are preliminary files, not a verified release.

- No Task / Artifact model, atomic task claiming or acceptance engine has been implemented.
- API adapters stream text; the external MCP tool-call loop is not implemented.
- The CLI adapters have simulated-process tests, but real subscription-backed execution and native resume are unverified.
- Existing regressions concern a stale route after pause/resume, incorrect room status when resuming an active run, loss of an older triggering message from context, and prefix matches in member mentions.
- Token or currency hard-budget enforcement is not implemented.

The contract draft must reconcile these differences before different owners build against incompatible assumptions.

## Local 0.5B feasibility check

The local machine already has `qwen2.5:0.5b`, a 397,821,319-byte Q4_K_M model. A preliminary check made exactly three synthetic requests: research, implementation and independent review. Each used temperature 0, JSON Schema and a maximum of 128 output tokens.

| Case | Client latency | Valid JSON/schema | Valid `wake` subset | Expected role matched |
| --- | ---: | --- | --- | --- |
| Research | 3,632.6 ms | Yes | No | No |
| Implementation | 346.8 ms | Yes | No | No |
| Review | 342.3 ms | Yes | No | No |

The first request included about 2,941.4 ms of model loading. All three completed normally without truncation. This establishes local availability and identifies an invalid-routing case for the guardrails. **Three synthetic cases are not an accuracy benchmark or evidence of the model's final capability.** [Raw requests and outputs](design-evidence/qwen05-routing-smoke.json) include the prompt, schema, parameters and model digest for review.

The next proposed experiment simplifies the model's internal answer to one candidate ID or `none`, plus an action label. Program logic then constructs the public route decision. The independent evaluation should measure wrong and missed wake-ups, fallback frequency, task outcomes and warm/cold latency separately. JSON validity alone is insufficient.

## Plan

Fable proposed a 14:30 contract draft and sample log, a 14:45 contract freeze, first real backend/workflow checks by 17:00, integrated workflow by 19:00 and feature freeze at 21:00. These are proposed checkpoints, not reported achievements.

Before implementation is split between owners:

- [ ] Confirm the merged product direction and the implementation scope.
- [ ] Select the demonstration workflow and actual provider accounts.
- [ ] Confirm workstream ownership and file boundaries.
- [ ] Freeze event, task, artifact, routing and provider capability contracts.
- [ ] Share a single scaffold and sample log without committing credentials.
- [ ] Define a genuine artifact acceptance check and a failure-recovery demonstration.

The current competition plan remains a public repository and a video no longer than two minutes, both completed before the official Sunday noon deadline. The initial round uses video and questions; slides and an initial live demo must not be assumed. See the linked official rules in the architecture plan.

## Decisions pending

The merged direction, Shelf Life as the sole demonstration, additional bounties, account access and unclaimed modules still require team decisions. Silence is not recorded as agreement. This document records the discussion without converting proposals, mocked integrations or preliminary tests into completed results.
