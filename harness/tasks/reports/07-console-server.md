# 07 Console Server hand-back

Branch `lynx/07-console-server`. Implementation `0e30d13d27183df36c616fb6dea584aa3afce7a9`. Base `2ac5d1a59f7cc4e525c8d4445d0bda84149c3873`.

## Implementation

- Loopback HTTP and an independent product preview listener. JSON writes require the control origin when Origin is present. Static console modules and workspace files use separate paths and origins.
- Redacted provider configuration with serialized writes, optional key clearing, test and discovery routes, routing preview, and budget settings.
- Run creation with local readiness detection, history, cancel and confirmation on local handles, bounded text source inspection, and artifact reads. Each SSE follows a JSONL log with byte-aware incomplete-line handling, a file watcher and a 500 ms polling fallback.
- `createConsoleServer(opts)` matches interfaces §8 and accepts the provider and router injections specified in brief 07. The production defaults load each implementation lazily.

## Offline verification

```text
node --test "harness/console/server/**/*.test.mjs"
tests 16   pass 16   fail 0   skipped 0
```

Request tests use separate ephemeral listeners and temporary files. They cover concurrent writes, prevention of raw key/header disclosure, Host and Origin checks, write body limits, stale or failed run initialization, cancel and confirmation, history, allow-listed artifacts, text limits, path traversal, Windows junctions, pagination and partial UTF-8 SSE, replay after room closure, and bounded shutdown when browsers leave speculative preview sockets open.

A separate integration probe used the actual 01 provider adapter with injected synthetic HTTP responses, the pushed 02 and 03 code, and the production 06 engine and workers. One run passed through a real headless Edge browser and the 08 web code from integration commit `e77c91a`. Another used the HTTP API with `confirm_plan`. Both completed cleanly (full browser run hr-20261115-081257-a5qm and manual HTTP run hr-20261115-081255-zdxg). Each delivered with 2/2 final checks after a generated acceptance command initially failed with exit code 1 and the builder retried. The browser verified that a page on the preview listener could neither read the control API nor submit a JSON write. No real provider or search services were called. The browser probe is independent of the outstanding 08 duplicate-submit fix.

## Contract alignment

- The allow-list includes narrowly named `plan-check-v<N>.json`, `plan-facts-v<N>.md` and `fact-check.json` run artifacts. Those names are already defined by the artifact and event contracts and currently requested by 08. The list in http-api.md omits them. Review in room #417. No contract file changed.
- A routing update keeps unspecified top-level settings. A supplied `overrides` replaces the role pin map, which lets Setup clear an existing pin.
- Preview roots redirect to a nested HTML entry so relative resources resolve within its directory. Workspace files on the control origin are returned as UTF-8 plain text.
