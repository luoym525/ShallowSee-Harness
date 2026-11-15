# 03 Roles hand-back

Branch `lynx/03-roles`. Implementation commit `78def2f2b57f2be0fb13bfd98b776b2c81e1344b`. Base `2ac5d1a59f7cc4e525c8d4445d0bda84149c3873`.

## Implementation

- Intake turns a wish into a brief with assumptions, research questions and an optional refusal. It does not send wish text to search.
- Research sends at most six queries with at most two per question and one deep search. It keeps matching retrieved citation records and marks unsupported findings as low-confidence model knowledge. Provider errors allow the role to continue with available evidence. Engine limits and cancellation still propagate.
- Planning produces an ordered spec, validates suggested builder references and exposes deterministic checks for acceptance binding, portability and the sandbox command boundary.
- Plan and final reviewers make evidence-based recommendations. The reflector returns the next action and concrete repair instructions for an identified item.
- Reporting renders the fixed Markdown sections from artifacts. The model can select which verified items to highlight. The report uses measured check results and records both plan and README audit outcomes.

## Exports

`intake`, `researcher`, `planner`, `reviewer`, `reflector`, `reporter`, `SCHEMAS`, `RoleError` and `checkSpecRules(spec)`. Each structured model output is validated using workstream 01's exported JSON Schema subset. Model-supplied plan and review fields exclude engine-owned identity and version binding. The engine remains authoritative for approval and delivery.

## Offline verification

```text
node --test "harness/roles/**/*.test.mjs"
tests 14     pass 14     fail 0     skipped 0
```

Coverage includes parsing, repair and refusal, signal and budget behavior, the search budget and citation grounding, versioned planning, sandbox-oriented acceptance rules, independent review, item identity, and report accuracy. The role tests use synthetic model and search responses. No live verification was performed.

## Contract requests

- The engine's current reporter input carries the final tester and reviewer identities and elapsed time. To list every role, build iterations and whether the recorded cost is estimated or incomplete, pass the recorded model map, iteration count and cost source to the reporter. The current renderer shows unavailable values as unknown and labels the supplied amount as recorded cost.
- The reporter consumes the additive `planCheck` input already supplied by the engine to report the pre-build audit. Include it in interfaces.md when the contract next changes.

## Integration

The engine should invoke the exports through `harness/roles/index.mjs`. The engine assigns review model, call and spec version metadata from the actual run. `checkSpecRules` returns plain strings intended for the engine's revision flow. Visual checks are allowed by the spec contract but the merged tester currently skips them.
