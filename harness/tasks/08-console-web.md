# Brief 08 — console web UI (English): Setup, Make a wish, Live run, Result

**Branch:** `bill/08-console-web` from `origin/bill/harness-contracts` · **Time box:** 4.5 h · **Size:** L (this is what the judges see in the 2-minute video)

## Mission
Build the console a non-technical person uses: set up providers the way CC Switch does, type a wish, watch the harness plan, build, test and reflect live (which model is doing what and why, what passed, what it cost), then open the finished product. **All text in English.**

## You own (write only here)
`harness/console/web/**` and `harness/tasks/reports/08-console-web.md`.

## Read first
`harness/AGENTS.md` · `harness/contracts/http-api.md` (your only backend) · `harness/contracts/events.md` (your data) · `harness/contracts/artifacts.md` (state, spec, test report, REPORT.md) · `harness/contracts/api-config.md` (presets, fields, key rules). For style reference only, look at `apps/web/` (read-only).

## Inputs
HTTP + SSE from the console server (brief 07). Until it exists, run your own tiny mock: `harness/console/web/dev/mock-server.mjs` serving the static files plus canned JSON and a replayed SSE stream from `harness/console/web/fixtures/sample-run.jsonl`. Write that fixture yourself following events.md, mark it `synthetic: true` in `room.created`, and label it "Synthetic replay" in the UI whenever it is shown.

## Outputs
- `index.html`, `app.js`, `styles.css`, `model.mjs` (pure functions: events → view state, used by `app.js` and tested with `node --test`), `fixtures/`, `dev/mock-server.mjs`, `README.md`.
- No frameworks, no CDN, no build step: vanilla ES modules and CSS. Hash routes.

## Screens
**1. Setup → Providers** (`#/setup`), modelled on CC Switch's provider list:
- A card per provider: name, kind badge (Model / Search / GitHub), base URL, key status (`sk-…ab12` or "No key"), model count, Enabled toggle, **Test** (shows latency or the error inline), **Edit**, **Delete** (confirm dialog).
- Header buttons **Add provider** and **Fetch models** (on each model provider).

**2. Setup → Add / Edit provider** (`#/setup/new`, `#/setup/:id`): the screenshot Bill shared, in English:
- Back arrow + title **"Add provider"** · a large letter avatar.
- **Preset chips** row first (Anthropic, OpenAI, DeepSeek, Gemini, OpenRouter, Ollama (local), Linkup, GitHub, Custom). Choosing one fills the fields.
- Fields: **Provider name** (placeholder "e.g. Claude official") · **Notes** ("e.g. company account") · **Website** ("https://example.com (optional)") · **API Key** (password input with show/hide; placeholder "Only this is required; the rest fills in automatically"; on edit, empty means keep the stored key, with a "Clear key" link) · **Request URL** ("https://your-api-endpoint.com").
- **Models** section (model providers only): rows with id, label, Enabled, Tier (Auto/1/2/3) and capabilities chips; **Fetch models** opens a checklist from `/fetch-models`.
- Advanced (collapsed): extra headers.
- Sticky footer: hint "💡 After picking a preset, just fill in the API key" · **Cancel** · **+ Add** (or **Save**). After saving, offer **Test connection**.

**3. Setup → Routing & budget** (`#/routing`): table from `/api/routing/preview`: role · model · tier · reason, with a per-role "Auto / pin a model" dropdown; **Autonomy** toggle: "Full autopilot (recommended): an independent model approves the plan" vs "Ask me to confirm the plan"; budget inputs (USD, minutes, build iterations).

**4. Make a wish** (`#/new`): one big textarea ("Describe what you want, in your own words"), 4 example chips, budget summary, **Start**. If there are no models, show a friendly card linking to Setup.

**5. Live run** (`#/runs/:id`): the money shot for the video.
- Top: wish, status pill, elapsed time, spend (USD or "unknown"), iteration counter.
- **Loop ring**: Plan → Build → Test → Reflect, with the current phase lit and animated (respect `prefers-reduced-motion`).
- **Work items** checklist: W1…Wn with attempts, pass/fail and score bars.
- **"Who's working"** card: role, model and the router's one-line reason; escalations highlighted ("Escalated: Haiku → Sonnet after failed tests").
- **Timeline**: a compact event feed with human sentences (from `model.mjs`), expandable details (test evidence, reflections, sources with links).
- **Plan approval** badge: "Auto-approved by <model>" (never "approved by you" unless `by: "user"`); in confirm mode, a **Confirm plan** button.
- **Sources** panel (research): domain chips linking to sources.
- When finished: **Open the product** (a new tab at `http://127.0.0.1:4321/<runId>/`, the separate preview origin; never embed it in the console page) for static-web, the rendered REPORT.md (write a tiny safe Markdown renderer: headings, lists, tables, code, links; escape all HTML), and a file browser.

**6. Runs** (`#/runs`): history list with status, title, score and date.

## Design
Dark theme by default, like the screenshot: near-black background, soft card borders, one blue primary button, rounded inputs. Light theme via `prefers-color-scheme` plus a toggle. CSS variables for tokens. Readable at 1280×720 (video framing) and usable at phone width. Keyboard accessible: focus rings, labels on inputs, buttons that are `<button>`s.

## Robustness
SSE reconnect with `Last-Event-ID`; tolerate unknown event types; never render HTML from data (`textContent` everywhere except the escaped Markdown renderer); never log or display keys (the server never sends them anyway).

## Testing
`node --test harness/console/web/` for `model.mjs`: the fixture → expected view state (phase, items, current model and reason, spend, approval label, finished state), unknown events ignored, partial streams. Manual check: run the mock server, click through every screen, and take screenshots for the hand-back report (save them under `harness/console/web/screenshots/`).

## Definition of Done
- [ ] All six screens work against the mock server; English everywhere.
- [ ] `node --test harness/console/web/` passes (paste the summary).
- [ ] The synthetic fixture is clearly labelled in the UI.
- [ ] Screenshots of Setup (list), Add provider, Routing, Make a wish, Live run (mid-run), Result.
- [ ] Hand-back report; branch pushed; SHA reported.

## Out of scope
Server code (07). Figma: if Bill wants the Figma prize, a separate Figma Make pass can restyle these screens later; don't block on it.
