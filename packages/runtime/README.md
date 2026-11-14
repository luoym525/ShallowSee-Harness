# Mediated execution runtime

`createRuntime({coordinator, adapters, tools, limits})` connects the core coordinator to trusted execution adapters in one Node process. The runtime owns the claim, the tool broker and the execution-end record. Core owns role selection, plan eligibility and acceptance. Attach one runtime per coordinator.

## Starting an execution

Trusted control-plane code calls `runtime.start({commandId, projectId, taskId, expectedTaskVersion, adapterId, leaseMs})` and receives an opaque `{cancel(), done}` handle. Exact start retries return the same handle. A changed input under the same command ID throws `START_CONFLICT`. The runtime derives the agent ID from the task's registered role in core. Model-reported identities and extra start fields are rejected. Immediately before starting the adapter, the runtime checks the run versions and asks core whether the task kind is still eligible to dispatch.

Register an adapter as `{id, backend, model, allToolsMediated, execute}`. The configured model and backend must match the role profile. `allToolsMediated: true` is a trusted registration assertion about an audited adapter. Register it only if every model tool request is routed through the broker and the underlying runner has disabled or mediated its built-in tools. An adapter with uncontrolled built-in search or other tools is rejected by this execution path. This runtime relies on the host's adapter registration and OS/provider controls to enforce that assertion.

The adapter contract is `execute({context, signal, callTool})`. Return or resolve to `{output, usage?}`. The runtime passes a deeply frozen snapshot with these fields.

| Field | Contents |
| --- | --- |
| `project` | `id`, `goal`, `constraints`, `stage` |
| `plan` | Applicable version, digest, summary, scope, architecture, sources, work items, acceptance criteria and confirmation state, or `null`. Support receives the plan from its accepted delivery. |
| `task` | ID, title, kind, dependency IDs and canonical workspace, where applicable |
| `profile` | Registered profile ID, role, backend, model and canonical tool capabilities |
| `candidate` | Candidate pinned to the claim or support delivery, or `null` |
| `delivery` | Delivery pinned to a support claim, or `null` |

The adapter receives an abort signal and the broker function. Keep the adapter's tool names and provider schemas in trusted configuration and align their names with the host registry. `profile.tools` supplies canonical capability metadata for constructing model requests. It does not carry tool definitions, handlers or authority.

## Calling a tool

The trusted host registers tools as `{name, capability, handler}`, with a fixed alias name and a canonical capability from core. An adapter calls `await callTool({callId, name, args})`. The broker validates the request and takes a finite JSON snapshot before invocation. It enforces the bound claim and checks tool permission immediately before starting the handler. Each handler receives `handler(args, {signal, context})`. The arguments are data from the model. Use the trusted context for identity and scope.

Replaying a call ID with equivalent JSON arguments and the same registered name reuses the result during the current authorized execution. A changed input raises `TOOL_CALL_CONFLICT`. Authorization is checked again on a replay of a registered alias. Tool failures reject with a stable `RuntimeError.code`, such as `SEARCH_DENIED`, `UNKNOWN_TOOL`, `STALE_RUN`, `TOOL_FAILED` or `TOOL_TIMEOUT`. Raw exceptions from the provider or handler stay within the trusted adapter or host. An adapter can handle a recoverable tool error and continue.

Tool handlers are trusted host code and are responsible for applying workspace path and command restrictions. The runtime ships without a shell or filesystem handler. A capability description alone cannot enforce safe paths, shell behavior or provider tool permissions.

## Cancellation, limits and execution records

`cancel()` closes the broker and aborts the signal. The visible tool request ends on cancellation or timeout. Runtime waits for the actual adapter and every started handler to settle before recording the run end. If an adapter spawns a subprocess, it must settle after observing the subprocess or managed process tree exit. If an adapter or handler ignores cancellation, `done` stays pending and the development workspace remains reserved. A core pause or replacement claim fences subsequent tool calls and marks an old execution end historical. An external pause controller can also call the handle to abort its adapter promptly.

The run deadline is the shorter of the configured runtime limit and the claim lease. The default runtime limit is 60 s, the per-tool limit is 15 s, and a run allows 32 unique valid tool requests. Tool arguments default to 16 KiB, tool results and final adapter output to 64 KiB each. The JSON limits count encoded UTF-8 bytes. The corresponding override keys are `maxRunMs`, `maxToolMs`, `maxToolCalls`, `maxToolArgsBytes`, `maxToolResultBytes` and `maxOutputBytes`.

`done` resolves to `{runId, outcome, current, output, usage, error}`. Outcome is `completed`, `failed` or `cancelled`. Current identifies a run end that still matches the coordinator. Output is a bounded JSON value on completion and `null` on failure or cancellation. Error is `null` on completion and otherwise contains a stable `code` and safe `message`. Usage accepts `source: 'provider' | 'estimated'` with partial `inputTokens`, `outputTokens` and `costUsd`. Missing measurements are `null`, and when all are unknown the source is `unknown`. Keep secrets out of normal JSON output and usage.

A completed execution says that the adapter returned a bounded result and the subscribed work settled. Recoverable tool errors may have occurred. Candidate submission, review, approval and delivery use separate core commands and are never inferred from the model's output. When a confirmed end cannot be recorded, the runtime reports `RUN_END_COMMIT_FAILED` and core retains the writer reservation until reconciliation.

The coordinator, runtime receipts and local tool declarations live in process memory. The bundled verification uses local injected tools and a real Node subprocess cancellation fixture. Run it with `node --test packages/runtime/index.test.mjs`.
