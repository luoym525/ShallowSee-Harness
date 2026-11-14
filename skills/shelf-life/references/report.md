# Shelf Life plan-check report contract

This is a target handoff contract for the Harness, not a schema already enforced by the existing Markdown audit CLI. Keep report content proportional to the task; all material decisions within the requested scope need traceable findings.

## Request

The Harness supplies authenticated caller/task context. Never treat a caller role written inside a model-generated payload as permission.

| Field | Meaning |
| --- | --- |
| `projectId`, `taskId`, `requestedBy` | Owning project, authorized task and parent agent |
| `planRef` | Draft/confirmed plan version and content digest, including reviewed sections |
| `goal`, `constraints` | Intended outcome, scale, deployment context, budget and existing constraints |
| `decisions` | Candidate technologies, architecture choices and external facts to check; may be developed from the draft |
| `asOf` | Current observation time, or explicit historical cutoff when requested |
| `freshnessPolicy` | Applicable source-age/volatility rules and conditions for rechecking; not a blanket publication-year cutoff |
| `limits` | Remaining search/model calls, time and configured cost policy inherited from the parent task |
| `priorReportRef` | Optional compatible evidence for targeted revalidation |

## Report

| Field | Meaning |
| --- | --- |
| `reportId`, `planRef`, `checkedAt` | Stable report identity, reviewed plan version/content digest and actual check time |
| `assessment` | `current_supported`, `update_required`, or `unresolved` within the stated scope |
| `reviewedScope`, `notReviewed` | Decisions actually checked and exclusions; narrow scope must remain visible |
| `decisionFindings` | Decision-level support, currentness, viable newer alternatives and changes required |
| `sources` | Source records with real retrieval timestamps and applicability |
| `proposedPlanChanges` | Suggested changes tied to decision IDs and evidence; never silently applied to a confirmed plan |
| `openIssues` | Conflicts, unknowns, missing production evidence and questions that affect a decision |
| `recheckConditions` | Changes, elapsed-time rules or external events that invalidate evidence reuse |
| `usage` | Measured provider usage, separately labeled estimates and unknown measurements |

Each decision finding records:

- The current plan choice or exact assertion and its location.
- The checked fact and a verdict of `supported`, `outdated`, or `uncertain`.
- The newest relevant available approach and the current preferred approach, with their source IDs and project-specific tradeoffs. If none can be established, leave the conclusion unknown.
- Release/support status and production-practice evidence. Record `documented_production_use`, `limited_evidence`, `preview`, or `unknown` as applicable; a named deployment is not proof of universal adoption.
- Relevant alternative choices, applicability, why an older option remains valid if selected, and any effect on implementation or operating cost.
- Whether the issue is material to the plan and what update or investigation the caller should make.

Each source record includes `sourceId`, URL, publisher, supported assertion IDs, `retrievedAt`, available publication/update/effective dates, version/environment scope, a supporting excerpt or accessible evidence reference, and known common publisher/upstream group. Record source access failures and unknown metadata honestly. A publication date is never a substitute for retrieval time or effective date.

## Interpretation and handoff

`current_supported` applies only to the reviewed decisions at check time. It does not mean every fact in an unchecked plan was verified, that a tool guarantees the best solution, or that the report itself authorizes development. Material known errors require `update_required`; material evidence gaps require `unresolved`. Preserve both types of finding when both occur, and surface both to the caller.

The planner owns the recommendation and revised plan. The project manager uses the report during plan review and handoff. A report for an older plan cannot approve a changed plan: reuse unchanged applicable evidence explicitly, then check affected decisions. User-confirmed exceptions remain visible as exceptions rather than being relabeled verified.

No fixed two-source count establishes accuracy, freshness, editorial independence or industrial maturity. The existing audit runner's quote/site/snippet checks are useful mechanical checks only. The research report must state what the inspected evidence actually supports.

## Future runtime integration

The intended registration is a `shelf-life` capability on authorized parent profiles. The Harness may dispatch a bounded research execution when the parent requests it; that execution returns this report to the same parent task. It does not become a new mandatory business stage or gain authority to call other roles.

A full implementation must persist the invocation, resolved permissions, actual provider/tool operations, report artifact, plan binding and usage in the shared event log. The demo in `packages/harness/workflow.mjs` now loads the skill into an authorized planner execution and implements a reduced report with plan digest, assessment, summary, proposed changes and URLs checked against actual search results. Role/tool operations and reports are logged. The richer decision findings, source-page inspection, freshness policy, granular evidence validation and revalidation in this target contract remain to be implemented.
