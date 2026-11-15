# Workstream 01 hand-back

Implemented configuration loading, atomic saving, validation, presets, redaction and provider updates; neutral Anthropic and OpenAI-compatible model clients with tools, schemas, retries and cancellation; Linkup search, provider testing, model discovery and JSON Schema subset validation.

Offline verification: `node --test "harness/providers/**/*.test.mjs"` — 17 tests passed, 0 failed. `node harness/providers/live-check.mjs` — SKIPPED: no providers configured. No live calls were made.

Configuration loading rejects non-object JSON, malformed credentials and enablement fields, and invalid runtime settings, with defaults for omitted routing and budget fields. Regression tests cover discovery failures and non-mutation, cancellation during backoff, both tool round trips, and schema fallbacks, including Anthropic prompt-only fallback for models that reject native structured output.

Contract requests: none.

Limitations: the live API integrations were verified using offline fakes only. The configuration validation implements the stated contract rules, rather than a full schema for every optional configuration field.

Rate-limit contract request: add `quota_exhausted` to `ProviderError.code`, and `resetAt: string | null` to errors. Completion results add `rateLimit`, either null or `{ requests, tokens, inputTokens, outputTokens }`; each entry is `{ remaining: number | null, resetAt: string | null }`, from Anthropic response headers. Short 429/529 throttles retry up to three attempts with abortable jitter and a 60-second cumulative backoff cap; explicit exhausted balance/spend limits and retry-after above 60 seconds return non-retryable `quota_exhausted`. The existing utility request return shapes are unchanged.

Rate-limit verification: 24 offline tests passed, including short and long throttles, balance and spend exhaustion, reset metadata, redaction and cancellation. Fake fetches only; no paid calls. The test log is in `test/providers-rate-limits.log` (local ignored artifact).
