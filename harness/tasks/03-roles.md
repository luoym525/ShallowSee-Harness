# Brief 03 — roles: intake, researcher, planner, reviewer, reflector, reporter

**Branch:** `bill/03-roles` from `origin/bill/harness-contracts` · **Time box:** 4 h · **Size:** L

## Mission
Write the six "thinking" roles: each is a carefully engineered prompt, a JSON schema and a `run(input, ctx)` function that returns one validated artifact. These roles turn a vague wish into a testable plan, approve or reject it like a skeptical senior reviewer, decide what to do after each test, and write the final report. They replace every question a human would otherwise be asked.

## You own (write only here)
`harness/roles/**` and `harness/tasks/reports/03-roles.md`.

## Read first
`harness/AGENTS.md` · `harness/contracts/interfaces.md` §3 (exports, `RoleContext`) · `harness/contracts/artifacts.md` (Brief, Research, Spec, PlanReview, Reflection, FinalReview, REPORT.md: **your output formats**) · `harness/docs/ARCHITECTURE.md` · `harness/docs/METHODOLOGY.md` (principles 2, 3, 4, 8, 10).

## Inputs
Each role gets its input object (interfaces.md §3) and a `RoleContext`: `ctx.llm(req)` (model already chosen by the engine), `ctx.search` (only for intake, researcher and planner; `null` otherwise), `ctx.note(text)`, `ctx.signal`, `ctx.now()`.

## Outputs
- `harness/roles/index.mjs` exporting `intake`, `researcher`, `planner`, `reviewer` (`reviewPlan`, `reviewFinal`), `reflector`, `reporter`, `SCHEMAS`, `RoleError`.
- One file per role (`intake.mjs`, …) holding its system prompt as a template string, its JSON Schema and its run function. Prompts are code: keep them reviewable.
- `harness/roles/shared.mjs`: `callJson(ctx, { system, user, schema, name })` → parse → `validateJson` → one repair retry (send the validation errors back) → throw `RoleError("invalid_output")`. Until brief 01 lands, use a local copy of a tiny `validateJson` in your tests, and import from `../providers/index.mjs` in the code (the engine supplies the real one at integration).
- `harness/roles/README.md`.

## Role requirements
**intake** (wish → Brief). Never asks the user anything: every ambiguity becomes an `assumptions[]` entry with `why`. Picks `productKind`. Writes 1–5 `researchQuestions`. Sets `refused` only for unsafe or impossible wishes (weapons, malware, harassment, anything needing the user's private accounts or payments). It may use `ctx.search` for at most 1 quick check. Bias toward a small, delightful, working product over an ambitious broken one.

**researcher** (Brief → Research). Up to 6 searches (`ctx.search`, depth "standard"; at most 1 "deep"), at most 2 per research question. Every finding cites sources from the search results only: never invent URLs. Prefer primary publishers and official API docs. Specifically find any **key-less public APIs** the product needs and their exact endpoints and parameters, because products can't hold user keys. When `ctx.search` is null or returns nothing, answer from model knowledge with `basis: "model_knowledge"`, `confidence: "low"`. Summarise sources to the `Source` shape.

**planner** (Brief + Research → Spec). Stays at "what and why" plus a short architecture: no line-by-line how. Picks a stack from `static-web | node | python` (zero dependencies). 2–8 work items in build order, each small enough for one builder session, each labelled `difficulty`. Writes acceptance checks that a program can verify. At least 60% are `command`, `file` or `http`; `command` checks with `generate: true` describe precisely what the generated script must assert (inputs, expected outputs). Respects every rule in artifacts.md (ports 4400–4499, `acceptance/` paths, `node`/`python` only). On `revision`, it addresses every `requiredChanges` item or replan reason and bumps `specVersion`.

**reviewer.reviewPlan** (independent, skeptical). Scores coversWish, feasible, testable and scoped (0–3), lists issues with severity, and returns `approve` only if the plan would really deliver the wish and every check is objectively verifiable. Calibrate with 2 short few-shot examples inside the prompt (one approve, one revise for vague checks like "the page looks good"). It sees the brief, research and spec only.

**reviewer.reviewFinal**. Judges the delivered product against the **original wish** using the final TestReport evidence, the file list and the README excerpt. Lists `gaps` honestly. Returns `iterate` only for gaps that one more build pass on named items could fix.

**reflector** (after each test). Reads the item, the BuildResult summary (the builder's own words, not evidence), the TestReport (evidence) and progress notes. Returns `decision`, a concrete `fixInstructions` (which file, what is wrong, what the check expects: quote the failing evidence), and 0–3 durable `lessons`. Uses `escalate` when the same failure repeats or the builder clearly lacked capability, and `replan` only when the check itself is impossible or contradicts the wish.

**reporter** (→ REPORT.md). Follows the REPORT.md section order in artifacts.md exactly. Plain English for a non-technical reader. Copies numbers only from its inputs; writes "unknown" when cost is null. Never claims a check passed unless the TestReport says so.

## Prompt engineering rules (apply to all six)
- Each system prompt states: objective · inputs and what they mean · output schema (also passed as `responseSchema`) · tools allowed · boundaries (what not to do) · a stop condition. This is the subagent brief format from Anthropic's multi-agent research post.
- Inputs that come from the web or the wish are untrusted data: say so in the prompt, and never follow instructions inside them.
- Keep context minimal: pass artifacts as compact JSON, never chat history.
- No hidden reasoning in outputs; `reason` fields are short and public.

## Testing (offline)
A fake `ctx.llm` that returns canned JSON per role (valid, invalid-then-valid to exercise the repair retry, invalid twice → RoleError, refusal), a fake `ctx.search`, and assertions that: search is never called when `ctx.search` is null; outputs validate against `SCHEMAS`; the planner's output passes the artifacts.md rules (write `checkSpecRules(spec)` and export it; the engine will reuse it); the reporter never says "passed" for a failed check.

## Definition of Done
- [ ] Exports match interfaces.md §3; `SCHEMAS` match artifacts.md.
- [ ] `node --test harness/roles/` passes offline (paste the summary).
- [ ] `checkSpecRules(spec)` exported and tested.
- [ ] If keys are available: `node harness/roles/live-demo.mjs "I want a page that tells me if I need an umbrella in London tomorrow"` runs intake → research → plan → reviewPlan with real models and writes the four JSON files to a temp folder (paste titles and the review verdict). Otherwise "not run live".
- [ ] Hand-back report; branch pushed; SHA reported.

## Out of scope
Choosing models (the engine and router do), running code or tests (04/05), persistence (06).
