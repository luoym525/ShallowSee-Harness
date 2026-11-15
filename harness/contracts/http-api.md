# Contract: console HTTP API

Server: `harness/console/server/` (workstream 07). Client: `harness/console/web/` (workstream 08). Base URL `http://127.0.0.1:4320`. JSON in and out (`Content-Type: application/json; charset=utf-8`). Errors: HTTP status plus `{ "error": { "code": "...", "message": "..." } }`.

**Security (server-enforced):** listen on 127.0.0.1 only; reject requests whose `Host` is not `127.0.0.1:4320` or `localhost:4320`; for every non-GET request require `Content-Type: application/json` and, if an `Origin` header is present, that it equals the server's own origin. **Never return an API key**: every config response is the redacted view from `providers.redactApiConfig`.

## Config and providers (the CC Switch-style Setup page)

| Method & path | Body | Response |
|---|---|---|
| `GET /api/health` | — | `{ ok: true, version: "harness.console.v1", configPath, hasConfig: boolean }` |
| `GET /api/presets` | — | `{ presets: Preset[] }` |
| `GET /api/config` | — | `{ config: RedactedApiConfig, validation: { ok, errors, warnings } }` |
| `POST /api/providers` | `ProviderInput` | `201 { provider: RedactedProvider }`; `400 invalid_config` with issues |
| `PUT /api/providers/:id` | `ProviderInput` (partial; `apiKey` missing = keep, `null` = clear) | `{ provider: RedactedProvider }` |
| `DELETE /api/providers/:id` | — | `{ ok: true }` |
| `POST /api/providers/:id/test` | — | `{ ok, latencyMs, detail, models? }` (never throws 500 for a failed test; `ok:false` instead) |
| `POST /api/providers/:id/fetch-models` | — | `{ models: string[] }` (ids only; the UI lets the user tick which to add) |
| `PUT /api/routing` | `{ autonomy?, overrides?, preferVendorDiversity? }` | `{ routing }` |
| `PUT /api/budget` | `{ maxUsdPerRun?, maxMinutesPerRun?, maxBuildIterations? }` | `{ budget }` |
| `GET /api/routing/preview` | — | `{ rows: describeRouting(...) }`: which model each role would get right now, and why |

`RedactedProvider` = `ProviderEntry` with `apiKey` replaced by `{ hasKey, preview }` and header values replaced by `"•••"`.

## Runs

| Method & path | Body / query | Response |
|---|---|---|
| `POST /api/runs` | `{ wish: string (1–2000 chars), budget?: {...}, autonomy? }` | `202 { runId }`; `409 no_models` when the router has nothing to use, with a message telling the user to add a provider |
| `GET /api/runs` | — | `{ runs: RunState[] }` newest first |
| `GET /api/runs/:runId` | — | `{ state: RunState, artifacts: string[] }` (file names present in the run folder) |
| `GET /api/runs/:runId/events?after=N` | — | `{ events: Envelope[], nextAfter }` (max 500 per call) |
| `GET /api/runs/:runId/stream?after=N` | — | `text/event-stream`. Each event: `id: <seq>`, `event: harness`, `data: <envelope JSON>`. Honours `Last-Event-ID`. Heartbeat comment every 15 s. Sends `event: end` after `room.closed`. |
| `GET /api/runs/:runId/artifacts/:name` | `name` ∈ `wish.txt, brief.json, research.json, spec.json, plan-review.json, progress.md, final-review.json, REPORT.md, tests/<file>, reflections/<file>` | the file (`application/json` or `text/markdown`/`text/plain`) |
| `GET /api/runs/:runId/files` | — | `{ files: string[] }` workspace files (relative paths) |
| `GET /api/runs/:runId/files/<path>` | — | text content, max 500 KB; `415` for binary |
| *(preview, separate origin)* `GET http://127.0.0.1:4321/<runId>/<path>` | — | see "Product preview" below |
| `POST /api/runs/:runId/cancel` | `{}` | `{ ok: true }` |
| `POST /api/runs/:runId/confirm` | `{}` | `{ ok: boolean }` (only in `confirm_plan` mode) |

## Product preview (separate origin)

Generated products are untrusted code. They must never share an origin with the control API, or their JavaScript could read the config, start runs or confirm plans. So the console server opens a **second listener on `127.0.0.1:4321`** that serves only static files:
- `GET /<runId>/` → the run's `spec.entry.path`; `GET /<runId>/<path>` → that workspace file. GET and HEAD only; no `/api`, no directory listings, no `.git`, path-checked, symlinks refused.
- Host must be `127.0.0.1:4321` or `localhost:4321`. Headers: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: frame-ancestors 'none'`.
- The control API on 4320 already rejects any non-GET request without `Content-Type: application/json` or with a foreign `Origin` (so a 4321 page's cross-origin POST is refused, and the JSON content type forces a CORS preflight that the API never approves), and it sends no CORS headers, so a 4321 page can't read 4320 responses.
- The UI's **Open the product** button links to `http://127.0.0.1:4321/<runId>/` in a new tab.

## Static UI

`GET /` and any path not starting with `/api/` → files from `harness/console/web/` (`index.html` for unknown paths so hash routes work).
