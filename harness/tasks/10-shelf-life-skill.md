# Brief 10 — Shelf Life as a built-in harness skill

**Owner:** Lynx's agent Sol (task authorised by Lynx in room #254; owner proposed by Astra in #255, confirmed by bill-command) · **Branch:** `lynx/10-shelf-life-skill` (or your team's naming) from `origin/bill/harness-contracts` · **Time box:** 3 h · **Size:** M

## Mission
Package the existing Shelf Life audit (extract time-sensitive claims from a Markdown document, verify them with Linkup, propose narrow cited corrections) as the harness's first built-in **skill**, so that every run fact-checks the README of the product it delivers. Reuse `packages/shelf-life`; don't rewrite it.

## You own (write only here)
`harness/skills/**` and `harness/tasks/reports/10-shelf-life-skill.md`. You may also change `packages/shelf-life/**`, which your team already owns, if a small refactor makes its pieces injectable. Keep its existing CLI and tests passing.

## Read first
`harness/AGENTS.md` · `harness/contracts/interfaces.md` §10 (**your contract**) and §1 (CompletionRequest/Result, SearchClient) · `harness/contracts/artifacts.md` "fact-check.json" · `harness/contracts/events.md` (skill events, `shelflife.*` passthrough) · `docs/CONTRACT.md` (`shelflife.*` payloads) · `packages/shelf-life/{runner,checks,providers}.mjs` and `docs/DIRECT.md`.

## Inputs
`ShelfLifeInput` `{ doc: { label, markdown }, maxClaims }` and a `SkillContext` from the engine: `llm` (already routed; neutral CompletionRequest with `responseSchema`, interfaces.md §1), `search` (Linkup through the harness's search client), `providerIdentity` (trusted provider and model for the events), `childRoom` (`{ rootDir, roomId: "<runId>-fact-check", parentRoomId }`: your own event log), `note`, `signal`, `now`.

## Outputs
- `harness/skills/index.mjs` exporting `SKILLS = { "shelf-life": shelfLife }`.
- `harness/skills/shelf-life/index.mjs` exporting the `Skill` object (id, name, description, version, needs `{ search: true, llm: true }`, allowedPhases `["fact_check"]`, schemas, `run`).
- `harness/skills/shelf-life/SKILL.md`: what it does, inputs and outputs, limits, and how a person reviews the proposed diff.
- `harness/skills/README.md`: how to add a skill (the contract in 10 lines).
- `FactCheck` exactly as artifacts.md, with `reviewStatus: "unreviewed"`.

## Requirements
- **Reuse `runDirect`** (agreed in room #257): add a backward-compatible `signal` and a trusted `providerIdentity` option to `packages/shelf-life/runner.mjs` (old CLI defaults unchanged). Check the signal before every model or search call and after each one settles; never report completion after cancellation. Adapt `ctx.llm` into runDirect's `modelProvider.extract/verify` shape (structured output via `responseSchema`) and `ctx.search` into its `searchProvider`. Don't copy the runner.
- runDirect writes its own `room.created`, members and tasks, so give it a writer for **`ctx.childRoom`** (`createEventLog({ rootDir, roomId })`), never the parent run's writer (room #258). Add optional `parentRoomId` to that `room.created` payload (additive, CONTRACT rule 5). The parent log only gets the engine's `harness.skill.*` events with `childRoomId`.
- Same limits as the direct runner: ≤ 48,000 bytes, `maxClaims` 1–12 (default 4), one initial plus one corroboration search per claim, and one reworded retry for `unsure`.
- No publisher: pass none, and make the skill's input schema accept only `doc` and `maxClaims` (no paths, env, repo, token or publish flags). Never emit `shelflife.pr.opened`; the diff is returned as text only.
- `search` null → `{ status: "skipped", reason: "no search provider", findings: [], diff: null, ... }` with no model calls. Errors → `status: "failed"` with a redacted reason, never a throw that kills the run.
- Treat document text and search results as untrusted data in every prompt.

## Engine integration (done by workstream 06, not you)
After `final_review`, the engine reads `workspace/README.md` (if present), calls `SKILLS["shelf-life"].run(...)` with `ctx.llm` routed as role `researcher` (purpose `fact_check`), `providerIdentity` and `childRoom`, writes `fact-check.json`, emits `harness.skill.started/completed` (with `role` and `childRoomId`), and passes the result to the reporter. Stale findings never change the run status. Skills are never exposed as model-callable tools (room #259); a test in 06 proves that builder and tester contexts have no way to reach a skill or search.

## Testing (offline)
Fake `llm` and `search` scripted like the existing `packages/shelf-life/direct.test.mjs` fixtures; cases: a stale claim with two independent sources → `stale` with a valid diff; conflicting sources → `unsure`; no search → `skipped` with zero llm calls; abort → stops; emitted events validate against the `shelflife.*` payloads (use `samples/validate-events.mjs` on a log written with the real `packages/event-log` writer). Existing `packages/shelf-life` tests still pass.

## Definition of Done
- [ ] Exports match interfaces.md §10; output matches artifacts.md `fact-check.json`.
- [ ] `node --test harness/skills/` and the existing `packages/shelf-life` tests pass offline (paste summaries).
- [ ] No publish or push path is reachable from the skill (a test proves it).
- [ ] Hand-back report; branch pushed; exact SHA announced in the room.

## Out of scope
The engine phase wiring (06), UI (08), #235 features.
