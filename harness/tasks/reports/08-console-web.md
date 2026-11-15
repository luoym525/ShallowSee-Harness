# 08 console-web — hand-back
Branch: claude/08-console-web-24e4e9 · Code commit: 7294212588f7941df493f82535217720a3be0495 · Base: 069b5d8c781b0585465f923961e1bed38bbe3dc6 (contracts commit)

The branch is `claude/08-console-web-24e4e9`, not `bill/08-console-web`: this session was started in a pre-made worktree and told not to create or switch branches. The commit that adds this report sits on top of the code commit above; its SHA is in the hand-off message.

## What I built
The English web console in `harness/console/web/`: vanilla ES modules and CSS (no framework, CDN, build step or npm dependency), built against my own mock server and a **synthetic** fixture (`room.created.payload.synthetic: true`; every screen that shows it says **Synthetic replay**).

- **Live run** (`#/runs/:id`, the video screen): wish, status pill, elapsed (ticking), spend (`unknown` when unmeasured, `estimated` when estimated), iteration `3 / 12`, best/final score; the **Plan → Build → Test → Reflect loop ring** with the current phase lit and animated (`prefers-reduced-motion` respected); **work items** with attempts, status, model chip and score bars (`80% → 100%`); **Who's working** (role, model, tier, the router's one-line reason, escalation banner *Escalated: Haiku 5.5 → Sonnet 5.5 after failed tests*, last tool call); **Plan fact check** card (per plan version: stale fact, old → proposed value, two source links, "forced a plan revision"; "not verified" for skipped/failed checks); **Plan approval** badge (*Auto-approved by Claude Opus 5.5*; in confirm mode *Approved by …; waiting for you to confirm* plus **Confirm plan**; *Confirmed by you* only after a `by: "user"` event); README **Fact check** card ("Proposed, unreviewed", fresh/stale/unsure, diff); **Sources** chips; **Models in this run** table; **Timeline** with human sentences and expandable details (route reason, brief assumptions, sources, plan items, reviews, and **test evidence** loaded lazily from `tests/NNN.json`). SSE follows the stream and reconnects with `?after=` (and the browser's own `Last-Event-ID`). When finished: **Open the product** (new tab on `http://127.0.0.1:4321/<runId>/`, never embedded), a **Report** tab (safe Markdown renderer) and a **Files** tab (product files and run records).
- **Make a wish** (`#/new`), **Runs** (`#/runs`), **Setup → Providers** (`#/setup`: CC Switch-style cards with Test, Fetch models, Edit, Delete with confirm dialog), **Add / Edit provider** (`#/setup/new`, `#/setup/:id`: preset chips, Provider name, Notes, Website, API Key with show/hide, Request URL, Models with Tier and capability chips and "Estimated tier", Advanced headers, sticky Cancel / + Add, Test connection after saving), **Routing & budget** (`#/routing`).
- Dark theme by default; the theme button cycles dark → light → system (`prefers-color-scheme`). Readable at 1280×720, usable at 390 px (screenshot 10). Focus rings, labelled inputs, real `<button>`s.
- Dev tooling (not product code): `dev/mock-server.mjs` (every endpoint of http-api.md, in-memory providers that never hold a key, fixture replay, the :4321 preview origin), `dev/make-fixture.mjs`, `dev/screenshots.mjs`, `dev/ui-smoke.mjs`, `dev/cdp.mjs`.

## Exports (contracts/interfaces.md §9)
`index.html`, `app.js`, `styles.css`, `model.mjs` (pure, tested). No exports are consumed by other workstreams. Additions: `markdown.mjs`, `ui/*.mjs`, `fixtures/`, `dev/`, `screenshots/`, `README.md`.

## How to run / test
```bash
node harness/console/web/dev/mock-server.mjs        # UI + mock API on :4320, preview origin :4321; open /#/new and press Start (about 45 s synthetic replay)
node --test "harness/console/web/**/*.test.mjs"     # offline, no browser, no keys
node harness/console/web/dev/ui-smoke.mjs           # click-through of every screen in headless Edge/Chrome (skips if none installed)
node harness/console/web/dev/screenshots.mjs        # regenerate screenshots/
```

### `node --test "harness/console/web/**/*.test.mjs"` (real output, summary)
```
# tests 42
# suites 0
# pass 42
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms (about 20 s)
```
The 42 tests:
```
dev/mock-server.test.mjs (13)
  serves the web UI and falls back to index.html for hash-route paths; dev files stay private
  rejects foreign Host headers, non-JSON writes and foreign origins
  health, presets and config match the contract shapes
  API keys never appear in any response; update rules: missing keeps, null clears
  invalid provider input answers 400 invalid_config with issues
  fetch-models scenarios are distinct and test never throws a 500
  routing and budget updates validate and read back; preview rows cover every role
  the finished sample run: state, events (paged), artifacts, files
  SSE: full replay, resume with ?after and Last-Event-ID, ends after room.closed
  starting a run replays the synthetic fixture with the typed wish, then finishes
  confirm mode waits for POST /confirm; cancel closes the run
  no usable models → 409 no_models with a friendly message
  the preview origin serves product files only, with the contract's headers, and no /api
markdown.test.mjs (7)
  escapes all HTML, including raw tags and attributes
  links: only http(s) and mailto survive; javascript: and data: become plain text
  headings (offset), lists, nested lists, task boxes, rules, quotes
  tables with alignment and escaped cells
  fenced code keeps its text verbatim (escaped) and ends at the fence
  emphasis and inline code
  the synthetic REPORT.md fixture renders safely with its sections and table
model.test.mjs (22)
  the fixture is labelled synthetic and parses cleanly
  whole run: finished state, items, spend, approval, best candidate
  approval badge says Auto-approved by <model>, never approved by you
  approval is voided when a new plan version arrives, and a revise verdict never shows as approved
  confirm_plan mode: waiting label, then Confirmed by you only after the user's event
  escalation: Haiku 5.5 → Sonnet 5.5 after failed tests, shown in Who's working
  models table lists one row per role with the escalation chain
  plan fact check: v1 stale forced a revision, v2 clean
  README fact check is proposed and unreviewed, never 'Confirmed'
  skipped or failed fact checks read 'Not verified', never 'checked' or 'current'
  test evidence and timeline sentences
  partial streams: a half-finished log still yields a valid view
  unknown event types and fields are ignored
  a reconnect that resends events changes nothing (dedupe by seq)
  unknown cost stays unknown: never $0.00
  cancelled run: status, banner data and no leftover 'running' items
  room.closed alone (engine crashed before run.finished) still ends the view
  elapsed time: finished runs use their own timestamps, running runs use now
  formatters and helpers
  fetch-models results map to distinct plain-English outcomes and always keep the configured models
  hasUsableModels and preset order
  a skipped skill (childRoomId null) pairs started with completed: one entry per invocation, none stuck at running
```

### `node harness/console/web/dev/ui-smoke.mjs` (real output; headless Edge, 52 checks, exit code 0)
```
PASS  Setup lists 4 provider cards
PASS  Anthropic card shows the key preview sk-…ab12
PASS  GitHub card shows No key
PASS  Anthropic card shows its model count
PASS  OpenRouter shows an Estimated tier chip (catalogMatched false)
PASS  GitHub is disabled (toggle off)
PASS  Test shows latency inline
PASS  Preset chips include Ollama (local)
PASS  Choosing a preset fills name and request URL
PASS  API key placeholder matches the CC Switch wording
PASS  Adding without a key shows an inline error
PASS  Adding with a key shows the saved card
PASS  The typed key is not in the page markup after saving
PASS  The typed key is not in GET /api/config
PASS  Test connection after saving reports 'Key rejected (401)' inline
PASS  Fetch models: key rejected is distinct
PASS  …and says the configured models were kept
PASS  Fetch models: no list endpoint is distinct
PASS  Ollama (local) can be added without a key
PASS  Fetch models: unreachable is distinct
PASS  Edit shows 2 models, one marked Estimated tier
PASS  Edit: empty key field means keep the stored key
PASS  Edit offers a Clear key link
PASS  Fetch checklist locks the 2 models already added
PASS  After saving, the list shows 3 models for OpenRouter
PASS  Delete asks for confirmation
PASS  Confirming removes the card
PASS  Routing table has a row for every role
PASS  Planner (Claude Fable 5.2) and reviewer (Claude Opus 5.5) differ
PASS  Pinning a model for the planner shows Pinned
PASS  Budget saves and reads back
PASS  Make a wish shows the saved budget
PASS  …and the confirm-mode wording
PASS  Start with an empty wish shows a friendly message
PASS  Confirm mode: badge says Approved by <model>, waiting for you
PASS  …and never says Auto-approved
PASS  The run is labelled Synthetic replay
PASS  After Confirm plan the badge says Confirmed by you
PASS  Open the product links to the separate preview origin in a new tab
PASS  The product is never embedded in the console page
PASS  Sample run: Auto-approved by Claude Opus 5.5
PASS  Plan fact check shows the stale fact that forced a revision
PASS  …with the old → proposed values
PASS  README fact check is labelled Proposed, unreviewed
PASS  …and never says Confirmed
PASS  Work item W2 shows its score history 80% → 100%
PASS  Expanding a failed test shows the tester's evidence
PASS  Report renders as safe Markdown with its sections
PASS  File browser opens a product file
PASS  Runs history marks synthetic runs
PASS  Theme toggle switches dark → light
PASS  No browser console errors

All UI smoke checks passed
```
The smoke test found two real bugs while I built it, both fixed: DELETE sent no `Content-Type: application/json` (the contract requires it on every non-GET, so the real server would have answered 415), and `Element.append(null)` printed the text "null" into the page.

## Review fix (room #368)
A skipped skill has `childRoomId: null`, so `harness.skill.started` and `harness.skill.completed` could not be paired by room and `planChecks` showed two entries (one stuck at "running"). `model.mjs` now pairs each completed event with the most recent unpaired (still running) started event of the same `skillId` and `phase` when there is no matching `childRoomId`, and an unpaired completed event still yields an entry. Regression test: skipped plan_check (two invocations) and skipped fact_check, an orphan completed event, and a skipped invocation interleaved with a normal one that has a child room.

## Definition of Done
- [x] All six screens work against the mock server; English everywhere (click-through above).
- [x] `node --test "harness/console/web/**/*.test.mjs"` passes (42/42, summary above).
- [x] The synthetic fixture is labelled in the UI: **Synthetic replay** chip on the run page, "Synthetic" tag in Runs, a banner on the Report tab; the fixture itself is marked `synthetic: true`.
- [x] Screenshots in `harness/console/web/screenshots/` (1280×720 unless noted; synthetic data):
  - `01-setup-providers.png` Setup (list) · `02-add-provider.png` Add provider (Anthropic preset picked) and `02b-add-provider-full.png` (full page, shows Models)
  - `03-routing-budget.png` Routing & budget (1280×900) · `04-make-a-wish.png` Make a wish
  - `05-live-run-mid-run.png` Live run mid-run (builder escalated Haiku → Sonnet after a failed test) and `05b-live-run-mid-run-full.png` (full page)
  - `06-result-delivered.png` Result with **Open the product** · `07-result-report.png` rendered REPORT.md · `08-runs.png` Runs history
  - extras: `09-result-light-theme.png`, `10-phone-run.png` (390 px)
- [x] Hand-back report; branch pushed; SHA reported.

## Not done / known gaps
- **Not run against the real console server (07) or real engine events.** Everything was built and tested against my mock and the synthetic fixture, both written from the contracts. The mock reproduces http-api.md including the Host, Origin and Content-Type rules, but real-world differences (error bodies, issue paths, timing) are untested.
- In **Add** mode, **Fetch models** is disabled until the provider is saved, because `POST /api/providers/:id/fetch-models` needs an existing id. After saving, the saved card offers Fetch models and Test connection.
- Saving changed **extra headers** replaces all of them (header values are never sent back, so they can't be edited one by one). The form says so.
- No Figma pass (out of scope per the brief).
- The Live run timeline scrolls inside a 620 px box (newest first); test evidence loads lazily on expand.
- The preview link is `http://127.0.0.1:4321/<runId>/` (port hard-coded from the contract).

## Contract requests
1. **`catalogMatched` per model in `GET /api/config`.** http-api.md doesn't expose the router roster's `catalogMatched`. The UI shows **Estimated tier** when a model entry carries `catalogMatched === false` and no explicit `tier`. Please add `catalogMatched` (ideally also the resolved `tier`) to each model in the redacted config, or a `roster` array next to `config`.
2. **Document two error shapes.** `fetch-models` failures: the UI maps HTTP 401/403 or `error.code: "auth"` → "Key rejected"; 404 or `not_found` / `unsupported` / `no_model_list` → "no model list endpoint"; `invalid_response` → "not a model list"; anything else, including `network`, → "Couldn't reach the provider". `400 invalid_config`: the UI reads `error.issues` (falling back to `issues`), each `{ path, message }`; paths containing `baseUrl`, `apiKey`, `name` or `website` are shown next to that field.
3. **`RunState` additions for the Runs list:** `finalScore: number | null` (the UI falls back to `best.score`), and optionally `synthetic: boolean` (only the mock sets it).
4. **`PUT /api/routing` `overrides` semantics:** the UI sends the **complete** overrides map so that removing a pin works. Please confirm the server replaces rather than merges `overrides`.
5. **Artifact allow-list:** add `plan-check-v<N>.json`, `fact-check.json` and `plan-facts-v<N>.md` to the names `GET /api/runs/:runId/artifacts/:name` accepts. The UI loads the first two from `harness.skill.completed.reportPath`.

## Integration notes for the engine / PM
- In confirm mode the UI shows **Confirm plan** when the event log has `harness.phase.changed { phase: "awaiting_confirmation" }` (the mock emits it). Please make sure the engine emits that event; `harness.plan.confirmed { by: "user" }` then flips the badge to "Confirmed by you".
- Test evidence comes from `harness.test.completed.reportPath` (`tests/NNN.json`, `tests/final.json`) through the artifacts endpoint.
- Spend: the header uses `harness.budget.updated.spentUsd` with `usdSource`. Before the first budget event it sums `run.completed.usage.costUsd`, and only when every call reported a cost; otherwise it shows `unknown`.
- Approval wording is driven only by `harness.plan.reviewed.approval` (`by: "model"`) and `harness.plan.confirmed` (`by: "user"`); a new `harness.plan.ready` voids a displayed approval until the next review.
- The Setup pages re-read `GET /api/config` after every change and never ask the server for a key; typed keys live only in the form input until sent.
- `dev/`, `fixtures/`, `screenshots/` and `*.test.mjs` are not needed at runtime. My mock refuses to serve them; the real server's static handler should not need to.
