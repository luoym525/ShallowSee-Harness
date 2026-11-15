# Harness roles

The engine passes a small JSON artifact and an already routed model to each role. Call a role through its `run(input, ctx)` method as specified in [interfaces.md §3](../contracts/interfaces.md).

| Role | Output |
| --- | --- |
| `intake` | A brief with a goal, user, scope, assumptions, research questions and an optional refusal |
| `researcher` | Findings and an approach grounded in the retrieved sources |
| `planner` | A versioned spec with work items, acceptance checks and roster-bound model suggestions |
| `reviewer.reviewPlan` | An independent plan verdict, scores, issues and required changes |
| `reviewer.reviewFinal` | A delivery recommendation and remaining gaps based on test evidence |
| `reflector` | The next action and concrete repair instructions for the current work item |
| `reporter` | Markdown rendered from the run artifacts |

Structured output is validated with the provider module's JSON Schema subset. Each role can request one repair. Cancellation and engine budget limits propagate to the run controller. No role can invoke a model tool. The researcher uses only the search function supplied by the engine, with a six-call total, no more than two per question and at most one deep search. Retrieved source records take precedence over model-supplied metadata. If a search fails or yields no usable citation, an uncited finding is marked as low-confidence model knowledge.

The engine calls `checkSpecRules(spec)` before accepting a plan. It returns violation strings for work-item and acceptance binding, build order, path and command checks, and the minimum executable check ratio. The reviewer returns only its verdict fields. The engine writes the reviewer identity and exact spec binding.

The reporter can select highlights only from work items with intact passing acceptance checks. Report sections, test results, source provenance and known costs are rendered from artifacts. Missing run metadata is shown as unknown.

## Offline verification

```text
node --test "harness/roles/**/*.test.mjs"
```

The suite uses synthetic responses and does not contact model or search APIs.
