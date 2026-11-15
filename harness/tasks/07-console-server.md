# Brief 07 — console server: local HTTP + SSE + product preview

**Branch:** `bill/07-console-server` from `origin/bill/harness-contracts` · **Time box:** 3.5 h · **Size:** M

## Mission
Serve the English web console: the CC Switch-style provider setup (reading and writing `apiConfig.json` without ever exposing a key), starting runs, streaming their events live, browsing artifacts and workspace files, and previewing the finished product in the browser.

## You own (write only here)
`harness/console/server/**` and `harness/tasks/reports/07-console-server.md`.

## Read first
`harness/AGENTS.md` · `harness/contracts/http-api.md` (**implement exactly**) · `harness/contracts/interfaces.md` §1 (providers config functions), §2 (`describeRouting`), §7 (engine), §8 (your export) · `harness/contracts/events.md` · `harness/contracts/artifacts.md` (`state.json`). Look at `apps/server/index.mjs` (read-only) for the team's existing local-only HTTP/SSE patterns and Host checks.

## Inputs
- `apiConfig.json` via the providers functions (`loadApiConfig`, `saveApiConfig`, `applyProviderInput`, `removeProvider`, `redactApiConfig`, `testProvider`, `fetchRemoteModels`, `PROVIDER_PRESETS`).
- Router `buildRoster` + `describeRouting` for `/api/routing/preview`.
- Engine `startRun`, `listRuns`, `readRun`.
- Run folders `data/harness/runs/<runId>/` and logs `data/rooms/<runId>/events.jsonl`.

## Outputs
- `harness/console/server/index.mjs`: `createConsoleServer(opts)`; when run directly, listens on `127.0.0.1:4320` and prints the URL.
- Every endpoint in http-api.md, with the error shape and security rules.
- `harness/console/server/README.md`.

## Requirements
- **Dependency injection:** `createConsoleServer({ providers, router, engine, ... })` accepts module objects so tests can inject fakes; the defaults import `../../providers/index.mjs`, `../../router/index.mjs` and `../../engine/index.mjs` lazily (dynamic import, a clear 503 `module_not_merged` if one is missing). This lets you build and test before the other branches merge.
- **Keys:** responses only ever contain `redactApiConfig` output. Add a test that creates a provider with a fake key and greps every endpoint's response body for it.
- **Config writes** serialised through one in-process queue (no lost updates); `saveApiConfig` does the atomic write.
- **Runs:** keep a `Map<runId, RunHandle>` for runs started by this process (for cancel and confirm). `GET` endpoints work for any run on disk, including ones started by the CLI.
- **SSE:** tail the events file: read from byte 0, parse complete lines only (ignore a partial last line until it completes), and watch with `fs.watch` plus a 500 ms poll fallback (`fs.watch` is unreliable on Windows). Send `id: seq`. Resume from `?after=` or `Last-Event-ID`. Heartbeat every 15 s. Send `event: end` after `room.closed`. Clean up watchers on disconnect.
- **Preview on a separate origin** (http-api.md "Product preview"): a second listener on `127.0.0.1:4321` (`previewPort`) that only serves GET/HEAD static files from `data/harness/runs/<runId>/workspace/` with path checks (no `..`, no `.git`, no symlinks out), its own Host check (`:4321`), correct content types (html, css, js, mjs, json, svg, png, jpg, ico, txt), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: frame-ancestors 'none'`. Generated products are untrusted, so they must never be served from the 4320 control origin. The control API sends no CORS headers.
- **Validation:** `runId` must match `RUN_ID_PATTERN`; artifact names from the allow-list; wish 1–2000 chars; JSON bodies ≤ 256 KB.
- Graceful `close()`: ends SSE streams and stops watchers.

## Testing (offline)
Start the server on port 0 in tests with injected fake providers, router and engine and a temp `dataDir` holding a prepared synthetic run (`synthetic: true` in its `room.created`). Test every endpoint's happy path and main errors, Host/Origin rejection, key redaction, SSE resume with `Last-Event-ID` while lines are appended, preview path escapes, **a page served from the 4321 preview origin cannot use the 4320 API** (a POST with `Origin: http://127.0.0.1:4321` is rejected; the 4320 responses carry no `Access-Control-Allow-Origin`), the preview listener exposes no `/api`, and cancel and confirm routing to the handle.

## Definition of Done
- [ ] Every endpoint in http-api.md implemented; `node --test "harness/console/server/**/*.test.mjs"` passes offline (paste the summary).
- [ ] Test proves no API key appears in any response.
- [ ] `node harness/console/server/index.mjs` serves the web folder (or a placeholder page if brief 08 hasn't merged yet).
- [ ] Hand-back report; branch pushed; SHA reported.

## Out of scope
UI (08), engine logic (06). No auth system beyond the local-only checks. No HTTPS.
