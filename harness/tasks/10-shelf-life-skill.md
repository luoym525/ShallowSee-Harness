# Brief 10 — Shelf Life as a built-in harness skill

**Owner:** Lynx's agent Sol (task authorised by Lynx in room #254; owner proposed by Astra in #255, confirmed by bill-command) · **Branch:** `lynx/10-shelf-life-skill` (or your team's naming) from `origin/bill/harness-contracts` · **Time box:** 3 h · **Size:** M

## Mission
Package the existing Shelf Life audit (extract time-sensitive claims from a Markdown document, verify them with Linkup, propose narrow cited corrections) as the harness's first built-in **skill**, so that every run fact-checks the README of the product it delivers. Reuse `packages/shelf-life`; don't rewrite it.

## You own (write only here)
`harness/skills/**` and `harness/tasks/reports/10-shelf-life-skill.md`. You may also change `packages/shelf-life/**`, which your team already owns, if a small refactor makes its pieces injectable. Keep its existing CLI and tests passing.

## Read first
`harness/AGENTS.md` · `harness/contracts/interfaces.md` §10 (**your contract**) and §1 (CompletionRequest/Result, SearchClient) · `harness/contracts/artifacts.md` "fact-check.json" · `harness/contracts/events.md` (skill events, `shelflife.*` passthrough) · `docs/CONTRACT.md` (`shelflife.*` payloads) · `packages/shelf-life/{runner,checks,providers}.mjs` and `docs/DIRECT.md`.

## Inputs
`ShelfLifeInput` `{ doc: { label, markdown }, maxClaims }` and a `SkillContext` from the engine: `llm` (already routed; neutral CompletionRequest with `responseSchema`, interfaces.md §1), `search` (Linkup through the harness's search client), `emit` (appends `shelflife.*` events to the run log), `note`, `signal`, `now`.

## Outputs
- `harness/skills/index.mjs` exporting `SKILLS = { "shelf-life": shelfLife }`.
- `harness/skills/shelf-life/index.mjs` exporting the `Skill` object (id, name, description, version, needs `{ search: true, llm: true }`, allowedPhases `["fact_check"]`, schemas, `run`).
- `harness/skills/shelf-life/SKILL.md`: what it does, inputs and outputs, limits, and how a person reviews the proposed diff.
- `harness/skills/README.md`: how to add a skill (the contract in 10 lines).
- `FactCheck` exactly as artifacts.md, with `reviewStatus: "unreviewed"`.

## Requirements
- Reuse `packages/shelf-life/checks.mjs` (normalizeClaims, cleanSources, includesValue, assessment, makeDiff, queryFor) and its prompts and schemas. Replace its direct Anthropic and Linkup providers with `ctx.llm` (claim extraction and verdicts via `responseSchema`) and `ctx.search`.
- Same limits as the direct runner: ≤ 48,000 bytes, `maxClaims` 1–12 (default 4), one initial plus one corroboration search per claim, and one reworded retry for `unsure`. Honour `ctx.signal`.
- Emit the existing `shelflife.*` events with their v1 payloads through `ctx.emit` (so the team workbench can also display them). Never emit `shelflife.pr.opened`; never publish, push, open a PR or write files: the diff is returned as text only.
- `search` null → `{ status: "skipped", reason: "no search provider", findings: [], diff: null, ... }` with no model calls. Errors → `status: "failed"` with a redacted reason, never a throw that kills the run.
- Treat document text and search results as untrusted data in every prompt.

## Engine integration (done by workstream 06, not you)
After `final_review`, the engine reads `workspace/README.md` (if present), calls `SKILLS["shelf-life"].run(...)` with `ctx.llm` routed as role `researcher` (purpose `fact_check`), writes `fact-check.json`, emits `harness.skill.started/completed`, and passes the result to the reporter. Stale findings never change the run status.

## Testing (offline)
Fake `llm` and `search` scripted like the existing `packages/shelf-life/direct.test.mjs` fixtures; cases: a stale claim with two independent sources → `stale` with a valid diff; conflicting sources → `unsure`; no search → `skipped` with zero llm calls; abort → stops; emitted events validate against the `shelflife.*` payloads (use `samples/validate-events.mjs` on a log written with the real `packages/event-log` writer). Existing `packages/shelf-life` tests still pass.

## Definition of Done
- [ ] Exports match interfaces.md §10; output matches artifacts.md `fact-check.json`.
- [ ] `node --test harness/skills/` and the existing `packages/shelf-life` tests pass offline (paste summaries).
- [ ] No publish or push path is reachable from the skill (a test proves it).
- [ ] Hand-back report; branch pushed; exact SHA announced in the room.

## Out of scope
The engine phase wiring (06), UI (08), #235 features.
