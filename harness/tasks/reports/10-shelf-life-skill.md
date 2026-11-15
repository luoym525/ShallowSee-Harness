# 10 Shelf Life skill hand-back

Branch `lynx/10-shelf-life-skill`. Implementation commit `6c8ca41f0346d2620523adf1143e1788b076e26d` on Bill's contract `8482fbcf8a1a83e9b6ed28eaea70d67a3355bd5d`.

## Exports and behavior

- `harness/skills/index.mjs` exports `SKILLS`. Its `shelf-life` entry declares `plan_check` and `fact_check` and implements the §10 `run(input, ctx)` interface and FactCheck schema.
- The skill reuses the existing Shelf Life prompts, schema, verifications and diff generator. It binds the host's routed model identity and Linkup search, and creates a separate event log for the supplied child-room ID. It rejects attempts to append another audit to that room.
- Findings carry the input hash, exact quote, verdict, sources and checks from the final attempt. The diff is an unreviewed proposal. Skipped and failed checks are shown as unverified. Source corroboration is mechanical and editorial independence remains for human review.
- Cancellation signals propagate to the routed model and search. The run awaits the active provider's settlement, then writes cancellation to the audit log and returns the current FactCheck shape with `status: "failed"` and a cancellation reason.

## Offline verification

Node v24.19.0 on Windows.

```text
node --test harness/skills/shelf-life/index.test.mjs
tests 7, pass 7, fail 0, skipped 0

node --test apps/server/tests/server.test.mjs apps/web/tests/ui-model.test.mjs eval/tests/score.test.mjs eval/tests/prepare-review.test.mjs packages/event-log/tests/event-log.test.mjs packages/shelf-life/direct.test.mjs packages/shelf-life/publish.test.mjs packages/core/index.test.mjs harness/skills/shelf-life/index.test.mjs
tests 103, pass 103, fail 0, skipped 0

node samples/validate-events.mjs samples/shelf-life-room.sample.jsonl
81 events, 0 problem(s), 0 warning(s)
```

The directory-only `node --test harness/skills/` used in the brief is resolved as a module on Node v24.19.0 and returned `MODULE_NOT_FOUND`. The commands above name the actual files. The skill tests call the exported registry, use real child-room event writers, run the event validator on generated logs and use `git apply --check --unidiff-zero` to validate the proposed patch. Model and search providers are local fixtures.

## Contract requests and engine hand-off

- The v1 event consumers and validator accept the additive `room.created.parentRoomId` and `Source.retrievedAt` fields. Consider documenting those fields in the legacy event contract along with `shelflife.search.completed.provider` values for hosts and synthetic runs.
- Workstream 06 owns the phase loop and role permission tests. Invoke the registry with a routed researcher in `plan_check` and `fact_check`, and a new `<runId>-sl-NN` room per call. Pass the returned result to the plan reviewer or final reporter and emit the matching lightweight parent events. Use the host model and search clients to enforce live budgets.
- Engine composition and configured-provider checks remain integration verification. Test fixtures exercise the host interface, cancel semantics and child-log isolation without provider accounts.
