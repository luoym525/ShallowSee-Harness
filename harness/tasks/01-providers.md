# Brief 01 — providers: apiConfig, model client, search client

**Branch:** `bill/01-providers` from `origin/bill/harness-contracts` · **Time box:** 4 h · **Size:** L

## Mission
Give the harness one safe door to the outside world. Everything that needs a key goes through your module: loading and saving `apiConfig.json`, calling any configured model in one neutral format, and calling Linkup search. Nobody else ever touches a key.

## Why it matters
Model selection (Bill's module 2) only works if every model, whatever its vendor, answers through the same interface. The CC Switch-style Setup page (brief 08) is only as good as your presets, validation, redaction and "Test connection".

## You own (write only here)
`harness/providers/**` and `harness/tasks/reports/01-providers.md`.

## Read first
1. `harness/AGENTS.md`
2. `harness/contracts/api-config.md` (the file format and key rules: implement exactly)
3. `harness/contracts/interfaces.md` §1 (your exports: implement exactly)
4. `packages/shelf-life/providers.mjs` (read only): a working raw-`fetch` Anthropic call with `output_config.format` JSON-schema structured output, usage handling and a Linkup call. Reuse ideas, don't import it.
5. If you are Claude Code: load the `claude-api` skill before writing Anthropic API code. Known gotchas: `max_tokens` includes thinking; structured output goes in `output_config.format` with a `json_schema` (nullable fields via `anyOf`); no assistant prefill; Opus 5.5 rejects forced `tool_choice` (400), so never force a tool for JSON; handle `stop_reason: "refusal"`.

## Inputs (what you receive)
- `apiConfig.json` on disk (shape in api-config.md), or a config object passed in.
- `CompletionRequest` objects from the engine, roles, builder and tester (neutral format in interfaces.md).
- Search requests `{ query, depth, maxResults }`.

## Outputs (what you produce)
- `harness/providers/index.mjs` exporting every name in interfaces.md §1.
- `harness/providers/presets.mjs`: the 9 presets from api-config.md, with `keyHint` text for the UI (e.g. "Starts with sk-ant-…; create one at console.anthropic.com").
- `harness/providers/anthropic.mjs`, `openai-compatible.mjs`, `linkup.mjs`, `config.mjs`, `schema.mjs` (validateJson): internal split is your choice.
- `harness/providers/README.md`: usage in 20 lines.
- `harness/providers/live-check.mjs`: optional live smoke (`node harness/providers/live-check.mjs`) that, for each configured provider, does `testProvider` and one tiny completion; prints PASS/FAIL/SKIPPED; never prints keys.

## Requirements
**Config**
- `loadApiConfig`: missing file → `{ version: 1, providers: [], routing: { autonomy: "full", overrides: {}, preferVendorDiversity: true }, budget: { maxUsdPerRun: 5, maxMinutesPerRun: 40, maxBuildIterations: 12 } }`. Fill missing `routing`/`budget` fields with these defaults.
- `saveApiConfig`: validate, atomic write (temp file in the same folder + rename), keys untouched otherwise.
- `applyProviderInput`: create → id from preset or name slug, unique (`openai`, `openai-2`, …); defaults from the preset; key rule "missing = keep, null = clear, string = set".
- `redactApiConfig` / `redact`: exactly as api-config.md rules 2 and 5. Unit-test that no key substring survives in any error path.

**Model client**
- Anthropic: `POST {baseUrl}/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`. Map neutral messages ↔ Anthropic content blocks (`text`, `image` base64 source, `tool_use`, `tool_result`). `tools` → `{ name, description, input_schema }`. `responseSchema` → `output_config: { format: { type: "json_schema", schema } }`. Stop reasons: `end_turn`→`end`, `tool_use`→`tool_use`, `max_tokens`→`max_tokens`, `refusal`→`refusal`, else `other`.
- OpenAI-compatible: `POST {baseUrl}/chat/completions`, `Authorization: Bearer`. Neutral tool calls ↔ `tool_calls` / `role:"tool"` messages; images as `image_url` data URLs. `responseSchema` → `response_format: { type: "json_schema", json_schema: { name, schema, strict: false } }`; if the server answers 400 mentioning response_format, retry once with `{ type: "json_object" }` and the schema embedded in the system prompt; if that fails too, retry with prompt-only. Remember which mode works per provider for the rest of the process.
- `assistantMessage`: for a `tool_use` result its `content` is an array containing every `tool_call` part **in the same order and with the same id, name and input as `toolCalls`** (text parts may come before them). lym's `packages/agents` adapter (team room #242) relies on this.
- `result.model` echoes the request's `ModelRef` exactly.
- `json`: parse the text; if it isn't pure JSON, extract the first balanced `{…}` block. Never validate here (callers use `validateJson`).
- Usage: tokens from the provider response; `costUsd` = tokens × price from `opts.pricing(ref)` when both are known, else `null`; `source: "provider"` when tokens came back, else `"unknown"`.
- Errors → `ProviderError` with codes from interfaces.md; 401/403 → `auth`, 429 → `rate_limit` (retryable), 5xx → `server` (retryable), fetch failure → `network` (retryable), abort/timeout → `timeout`. Two retries with 1 s / 3 s backoff (respect `retry-after` up to 10 s). Honour `signal` throughout, including during backoff.
- Ollama and other key-less local servers: no auth header when `apiKey` is empty and the preset says `keyRequired: false`.

**Search client**
- Linkup `POST {baseUrl}/search` with `Authorization: Bearer`, body `{ q, depth, outputType: "sourcedAnswer", maxResults }`; normalise sources to `Source` (`domain` from URL hostname; `retrievedAt` = now). `available` false when no enabled linkup provider with a key.

**Utilities**
- `testProvider`: anthropic → `GET {baseUrl}/v1/models` (fallback: 1-token completion with the first enabled model); openai_compatible → `GET {baseUrl}/models`; linkup → a tiny search `"current UTC date"` with depth standard; github → `GET /user`. Return `ok`, latency and a short redacted `detail` ("Connected. 4 models available." / "Key rejected (401).").
- `fetchRemoteModels`: model ids from the list endpoint, sorted. Only ever called on demand (the Setup page's button or `testProvider`), never in the background or during a run. Errors are distinguishable and redacted: `auth` (401/403), `not_found`/unsupported (404, i.e. no list endpoint), `server`/`network`, `invalid_response`; an empty list is a valid result, not an error. A failed fetch never changes the stored `models` (room #269). Test all of these against a mocked official list endpoint.
- `validateJson`: the subset listed in interfaces.md, with readable error paths (`$.workItems[2].id: required`).

## Method notes (why it's built this way)
- Credentials stay in one process and never reach the sandbox or the UI (Anthropic, *Managed Agents*).
- One neutral interface lets the router swap models freely: the harness assumes nothing about any vendor.

## Testing (offline, no keys)
Inject `fetchImpl` fakes that record requests and return canned responses. Cover: Anthropic text, JSON-schema, tool-call round trip, refusal; OpenAI-compatible tool-call round trip and the json_schema → json_object fallback; retries on 429/500 then success; abort; redaction (put a fake key `sk-ant-test-1234567890abcd` in config and assert it never appears in any thrown message or redacted output); config create/update/clear-key/remove; atomic save to a temp dir; validation errors and warnings.

## Definition of Done
- [ ] Every export in interfaces.md §1 exists with that shape.
- [ ] `node --test harness/providers/` passes offline (paste the summary line).
- [ ] No key substring in any test output, error or redacted view (test proves it).
- [ ] `live-check.mjs` runs and prints SKIPPED cleanly with no `apiConfig.json`.
- [ ] If Bill has put keys in `apiConfig.json` on your machine: one real Anthropic completion and one Linkup search succeed (paste redacted output). Otherwise say "not run live".
- [ ] README and hand-back report written; branch pushed; exact SHA reported.

## Out of scope
Model choice (brief 02), prompts (03), UI (08). No streaming. No OpenAI Responses API. Don't read `.env`.
