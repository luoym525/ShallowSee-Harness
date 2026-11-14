# Demonstration and acceptance checklist (draft)

The team has proposed both a multi-model collaboration harness and a Shelf Life workflow. Product scope, demo scenario, owners and the event contract remain to be agreed by the human team. This checklist identifies evidence common to either direction; it is not a claim that any capability exists.

## Demonstration

- [ ] Freeze one task, initial inputs, acceptance criteria, and expected artifact before recording. Identify any scripted, simulated, human-performed, or replayed step.
- [ ] Show a real task progressing from request through execution and review to an inspectable artifact. Identify each actual provider and connection; do not imply that an external MCP participant was automatically woken if it polled or was manually started.
- [ ] Record task/run identifiers, event log location, artifact version, test command, exit status and output. An independent reviewer should be able to link the displayed result to the same run.
- [ ] Show a review or failure and its actual resolution. Do not stage an error as an autonomous recovery without disclosure.
- [ ] Capture a complete real run and preserve an offline replay; label the replay and any accelerated footage with the actual duration.

## Reliability checks

| Case | Procedure | Evidence / acceptance |
| --- | --- | --- |
| Normal handoff | Run the agreed task across the enabled participants. | Correct recipient receives the current task context; one identifiable artifact and its verification result are linked to the run. |
| Failure and timeout | Cause one tool or backend request to fail or exceed its limit. | Failure and any retry are visible; no success is reported without passing acceptance. |
| Duplicate delivery | Deliver the same message or claim twice. | The expected action occurs at most once; inspect the log and any side effects. |
| Pause with in-flight result | Pause while routing or execution is pending, then let the old result arrive. | No new work is scheduled from a stale result; existing history remains inspectable. |
| Disconnect / reconnect | Interrupt the live event connection and reconnect using the supported cursor. | Missing persisted events are recovered in order, and duplicates are not shown twice. |
| Restart | Stop the service with a run in flight and restart it. | The run is marked interrupted or otherwise accurately represented; side effects are not silently repeated. |
| Incomplete log tail | Test a copy of a log with a partial final record. | Existing valid records are preserved; the failure or recovery is explicit and no invented event appears. |
| Missing cost or usage | Use a backend that does not report usage. | UI and reports show unknown, not zero or an estimate presented as measured. |

Record actual pass/fail/blocked, date, environment, exact reproduction steps and evidence links for each check. A proposed contract must be reconciled with the implementation before assertions about cursors, IDs or recovery can be tested.

## Scenario-specific checks

**If Shelf Life is chosen:** maintain a separate, independently checked answer key with claim IDs, source URLs and verification dates. Report stale recall and precision with denominators, false positives and abstentions. Check that cited pages support the conclusion, distinguish independent sources from copies, and prevent unsupported edits or PRs. Disclose intentionally planted stale facts.

**If a code-change scenario is chosen:** specify exact behavior and edge cases in advance. Run reproducible tests on the delivered patch, including a negative or edge case that the review identifies. Avoid prescribing the review finding as if it necessarily emerged autonomously.

## Open decisions

- Confirm product scope and one demonstration scenario with the human team.
- Agree owners, shared event contract and which repository/version each owner uses.
- Verify real provider capabilities, credentials and access privately; never place secrets in the shared log.
- Agree the benchmark, test environment and time available before quoting metrics.

## Harness capability evidence

Track these separately from the selected workflow. For each item record `not implemented`, `implemented but unverified`, `verified`, or `blocked`, plus the actual run ID, configuration and evidence; never infer a capability from a mock.

| Capability | What to demonstrate |
| --- | --- |
| Model API | A real request and its observable result, with tool support only if actually exercised. |
| Official CLI | A real supported invocation, accurately describing login, streaming, cancellation and resume behavior. |
| External MCP | Join, read and post; claim or update only if implemented. Distinguish client polling from managed wake-up. |
| Rules and local routing | Run each available mode against the same labeled examples and record fallback, errors and actual outputs. |

For routing, test that recipients are registered and `wake` is a subset of `deliverTo`; malformed local-model output must fall back or fail visibly. Under long history, the current trigger must remain in the context delivered to the recipient. A message received while a member is executing must be queued rather than starting a concurrent run for that member, according to the agreed scheduling policy.

For reproducibility, save the room, task, run, message and event identifiers used by each test. Duplicate-delivery tests must repeat the same idempotency identifier, not merely identical text. Use a controllably delayed callback for pause/restart tests and count side effects. Confirm whether the agreed event cursor is inclusive or exclusive before asserting reconnect behavior.
