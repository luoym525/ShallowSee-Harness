# Brief 02 — router: model catalog and per-task model selection

**Branch:** `bill/02-router` from `origin/bill/harness-contracts` · **Time box:** 2.5 h · **Size:** S (pure logic, but it is one of Bill's three headline modules: make it excellent and explainable)

## Mission
Decide, for every single model call, which configured model should do it and why, in one plain-English sentence a non-technical person understands. Users rarely pick models; the harness does.

## You own (write only here)
`harness/router/**` and `harness/tasks/reports/02-router.md`.

## Read first
`harness/AGENTS.md` · `harness/contracts/interfaces.md` §2 (implement exactly) · `harness/contracts/api-config.md` (`routing`, `ModelEntry`) · `harness/docs/ARCHITECTURE.md` §1 table and §5.

## Inputs
- `ApiConfig` (to build the roster via your `buildRoster`, which may use `listConfiguredModels` from providers; until brief 01 lands, reimplement that tiny filter locally: enabled providers of kind anthropic/openai_compatible that have a key or are key-less local, and their enabled models).
- `RouteRequest` objects from the engine.

## Outputs
- `harness/router/index.mjs` with `DEFAULT_CATALOG`, `DEFAULT_POLICY`, `buildRoster`, `selectModel`, `describeRouting`, `RouterError`.
- `harness/router/catalog.mjs`, `policy.mjs` (your split).
- `harness/router/README.md` with the policy table, as the UI and video will quote it.

## Catalog (defaults; a `ModelEntry` field set by the user always wins)
| match | tier | capabilities | $/M in | $/M out |
|---|---|---|---|---|
| `claude-fable-5-2` | 3 | reasoning, coding, vision, tools, json, long_context | 8 | 40 |
| `claude-opus-5-5` | 3 | reasoning, coding, vision, tools, json, long_context | 4 | 20 |
| `claude-sonnet-5-5` | 2 | reasoning, coding, vision, tools, json, long_context | 2 | 10 |
| `claude-haiku-5-5` | 1 | coding, vision, tools, json | 0.10 | 0.50 |
| `^.*(mini\|nano\|flash\|lite\|haiku\|small).*$` | 1 | coding, tools, json | null | null |
| `^.*(opus\|fable\|pro\|sol\|large\|reasoner).*$` | 3 | reasoning, coding, tools, json | null | null |
| `^.*(vision\|vl\|tera\|terra).*$` | 2 | vision, tools, json | null | null |
| fallback (no match) | 2 | tools, json | null | null |

Claude prices are from the team's `claude-api` skill cache (3 Nov 2026); everything else is unknown (`null`) unless the user types it in. `catalogMatched` tells the UI whether the tier was guessed. Exact matches beat regex; regexes are tried in table order.

## Policy (Bill's mapping, encoded)
| role | base tier | requires | prefers | pick | escalation |
|---|---|---|---|---|---|
| intake | 2 | json | — | cheapest | none |
| researcher | 2 | json, tools | long_context | cheapest | none |
| planner | 3 | reasoning, json | — | **strongest** | none |
| reviewer | 3 | reasoning, json | — | **strongest** | none |
| builder | easy→1, medium→2, hard→2 (or the planner's suggestion) | coding, tools | — | cheapest | per_attempt: attempt 2 → +1 tier, attempt ≥3 → tier 3 |
| tester | 2 | json | reasoning | cheapest | none |
| reflector | 2 | reasoning, json | — | cheapest | after_two: attempt ≥3 → tier 3 |
| reporter | 2 | json | — | cheapest | none |
| vision | 2 | vision | — | cheapest | none |

Team decision (room #247, lym as admin): the planner runs on the best model provided, and the planner chooses each work item's builder model (`WorkItem.suggestedModel`). The router treats that as a validated suggestion, never as authority.

Selection algorithm (deterministic):
1. **Pin:** if `overrides[role]` is in the roster and has every required capability → use it (`pinned: true`, reason "Pinned by you in Setup"). If it lacks a capability, ignore the pin and say so in `reason`.
1b. **Planner suggestion** (builder only, `req.suggested`): on attempt 1, use it if it is in the roster, has every required capability and is not in `avoidModels` (`suggested: true`, rule `builder.planner_suggested`, reason "Chosen by the planner: <modelReason if passed via needs/reason>"; keep it short). On attempt ≥2, escalate from the suggestion's tier (+1, then tier 3). An invalid suggestion is ignored and the reason says why ("Planner suggested gpt-x, which isn't configured; using the cheapest capable coder").
2. Target tier = base tier (+ escalation). Candidates = roster models with every required capability, excluding `avoidModels`.
3. Choose from the candidates at exactly the target tier; if there are none, go up a tier, then down a tier (say "no tier-3 model configured, using best available"), and keep searching outward.
4. If `preferVendorDiversity` and `avoidVendors` is non-empty, drop same-vendor candidates when any other remains.
5. Prefer models with more of the `prefers` capabilities; then, for `pick: "cheapest"`, the lowest known output price (unknown prices sort after known), and for `pick: "strongest"`, the highest known output price as the strength proxy within the tier (so planner → Fable 5.2 when configured, reviewer → Opus 5.5 because it must avoid the planner's model); then the `ref` string. When `budgetRemainingUsd` < 0.5, cap the target tier at 2 except for planner and reviewer.
6. `fallbacks` = the next 2 candidates by the same ordering.
7. No candidates at all → `RouterError("no_match")`; empty roster → `RouterError("no_models")` with a message telling the user to add a provider on the Setup page.

`reason` examples (aim for this voice): "Planning needs the strongest reasoning: Claude Opus 5.5 (tier 3)." · "Easy coding task: the cheapest capable coder, Claude Haiku 5.5." · "Attempt 2 failed tests, so escalated the coder to tier 2 (Claude Sonnet 5.5)." · "Tester must differ from the builder (Haiku 5.5), so Claude Sonnet 5.5 checks the work."

## Method notes
Routing easy work to cheap models and hard work to strong ones (Anthropic, *Building effective agents*); escalate on failure; keep the verifier independent from the generator (DeepSeek verifier/meta-verifier; Anthropic's separate evaluator). Pure functions make this testable and the UI explainable.

## Testing
Table-driven tests: planner suggestion accepted, rejected (not configured, missing capability, avoided) and escalated from on attempt 2; planner and reviewer pick the strongest and differ from each other; Claude-only roster (all four models); Haiku-only roster (everything falls back to tier 1 with honest reasons); mixed vendors (tester picks another vendor); pin honoured and pin rejected for a missing capability; escalation across attempts 1–3; budget cap; `avoidModels`; empty roster error; determinism (same input twice → same output); `describeRouting` rows for every role.

## Definition of Done
- [ ] Exports match interfaces.md §2; no I/O anywhere in the module.
- [ ] `node --test "harness/router/**/*.test.mjs"` passes (paste the summary).
- [ ] README has the final policy table and 5 example decisions produced by your code (paste real output).
- [ ] Hand-back report; branch pushed; SHA reported.

## Out of scope
Calling models, learned routing, a local classifier model (the evidence in `design-evidence/qwen05-routing-smoke.json` shows a 0.5B model routing badly; labels come from the planner, the route is computed in code).
