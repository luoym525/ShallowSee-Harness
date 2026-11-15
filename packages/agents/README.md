# Agent runtime bridge

`createAgentAdapter({ id, backend, model, client, system = '', tools = [], limits = {} })` returns `{ id, backend, model, allToolsMediated: true, execute }`. `model` is a fixed `providerId/modelId` ModelRef. `client.complete` uses the neutral ModelClient contract pinned at `edd3e06d71bf6ab7478895d5ac2d73366a2e9fb5`, `harness/contracts/interfaces.md` §1. `tools` are host-provided `{ name, description, inputSchema }` specifications. `execute({ context, signal, callTool })` returns `{ output, usage }`; it requires matching profile backend and model. The runtime retains authority over every tool call and must enforce its own policy.

The bridge sends a bounded snapshot of project goal, constraints and stage, task details, plan, candidate and delivery. Do not put credentials in these fields. It has no provider implementation, direct tools, persistent state, acceptance authority, or runtime registration. It runs tool calls sequentially, maps model IDs to local IDs per execution, and suppresses repeat side effects for repeated IDs with identical arguments. Rejections receive a generic code; provider failures are sanitized. Cancellation waits for in-flight work to settle, so a client or tool that never settles can delay cancellation.

Default ceilings (each can only be lowered through `limits`) are `maxTurns: 8`, `maxToolCalls: 24`, `maxJsonBytes: 65536`, `maxHistoryBytes: 262144`, `maxOutputBytes: 65536`, `maxTokens: 16000`, `timeoutMs: 120000`. JSON and output sizes are UTF-8 bytes. Usage aggregates known fields and leaves unknown fields null. Completion is only model output, not acceptance or approval.

Run tests with `node --test packages/agents/index.test.mjs`. They use injected clients and runtime callbacks only.

`allToolsMediated` is a trusted, reviewed host assertion about this bridge, not a sandbox. The injected client is trusted code and must not execute built-in or other unmediated tools.
