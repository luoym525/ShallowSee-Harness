---
name: shelf-life
description: Audit checkable claims in plan facts or a delivered Markdown README and propose cited corrections for review.
---

# Shelf Life

The harness calls this skill as the researcher in `plan_check` for rendered plan facts and in `fact_check` for the delivered README. Each call receives its own child room and shares the existing Shelf Life claim, verification and patch code.

Pass `{ doc: { label, markdown }, maxClaims? }`. The label is a safe repository-relative Markdown name. It identifies the proposed diff and the audit document. The input is limited to 48,000 UTF-8 bytes and 1–12 claims, with a default of four. Each claim gets an initial search, a corroboration search and at most one reworded search when its evidence remains insufficient.

The engine supplies a routed structured model and, when available, Linkup search. Document text and search excerpts are untrusted data. With search unavailable, the result is `skipped` and the skill makes zero model calls. Skipped and failed checks are **not verified** and carry a reason. Cancellation stops further provider requests and waits for any active provider promise to settle. The child log records cancellation and the `FactCheck` result uses `failed` with a cancellation reason.

The result includes the input document hash, the child-room ID, findings with sources and checks, and any proposed unified diff. The child log keeps the full evidence. The result's `reviewStatus` is `unreviewed`. A passed source check means two different sites contained the value in a mechanical check. Editorial independence remains for human review.

Before accepting a proposed correction, compare the input hash, open the cited sources, verify scope and dates, and inspect the exact changed line. The proposed diff is returned for review. Application or publication requires a separate action.
