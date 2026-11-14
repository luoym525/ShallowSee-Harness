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
| `GET /preview/:runId/<path>` | — | serves workspace files with the right content type so a `static-web` product opens in the browser (`/preview/<runId>/` → `spec.entry.path`). Read-only, path-checked, same security rules. |
| `POST /api/runs/:runId/cancel` | `{}` | `{ ok: true }` |
| `POST /api/runs/:runId/confirm` | `{}` | `{ ok: boolean }` (only in `confirm_plan` mode) |

## Static UI

`GET /` and any path not starting with `/api/` or `/preview/` → files from `harness/console/web/` (`index.html` for unknown paths so hash routes work).
