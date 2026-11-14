# Handbook gold candidate review

Status: awaiting human review; not scoring gold. This draft follows Fable's request for24 handbook facts. It is pinned to PR5 commit `97010d003d4a8eea87697cbad3994966501df85f`; the PR was draft/unmerged when prepared. Do not audit this directory or expose it to the workflow agent.

- Candidate JSON: [handbook-gold-candidate.json](handbook-gold-candidate.json).
- All24 IDs, paths, line numbers and exact quotes were checked against that commit. Git blob IDs bind the four documents, author intent and worksheet.
- `label`, `expectedValue`, `scope`, `asOfUtc`, `verifiedBy`, `verifiedAtUtc` and `confidence` are deliberately null. `referenceUrls` is empty. The existing gold validator rejects this unchanged draft.
- The14 planted/10 other split is author intent only. Worksheet value/label strings are copied under `machineObservation`, with its original source URL and reported lookup window. They are not independently verified findings, labels or current values.
- The worksheet's reported17:25–17:40 UTC lookup window is unverified. Source commit97010d0 records17:30:52 UTC, before that window ends; no fetch logs establish the actual retrieval times. Do not copy this author record into verification timestamps.
- `additionalSourceCandidates` records three automated lookups with limitations. They are not human review or a second independent source group. IETF/RFC pages and Oracle are offered for f11/f20/f23; Wikipedia observations are retained as provenance rather than silently replaced.

## Human handoff

1. Confirm that the evaluated handbook is exactly the pinned commit. If its text changes, regenerate/recheck the source mappings before using a new dataset version.
2. Open the original source pages, establish applicable region/product/version/date/units, and resolve each `reviewQuestions` item. A latest-version claim needs evidence about released versions, not merely the existence of an older standard.
3. In a separate frozen gold file, choose `fresh`, `stale` or `unverifiable` for each row; fill the actual expected value, applicable observation time, human name/time and confirmed source URLs. Do not copy `machineObservation.suggestedLabelText` or `plantedStale` automatically.
4. In particular, resolve f04 file-limit scope, f05 configurable branch defaults, f06 subscription conditions, f09 stable-vs-RC, f12 timeout exception, tax-year/eligibility/units for f13–f18, and f24 approximate/word-versus-number wording.
5. Have ambiguous/disputed rows independently adjudicated. Do not silently remove missed or ambiguous reference claims to improve metrics. Keep pending rows unscored until this gold is confirmed.
6. Only after gold is genuinely confirmed, generate the run-specific review draft with `eval/prepare-review.mjs`. A human then maps actual run claim IDs, reviews each final source URL, assigns common publisher groups and confirms correction scope. Two domains or two RFC links do not establish editorial independence.

## Additional primary-source candidates

- f11: [IETF RFC9846](https://datatracker.ietf.org/doc/html/rfc9846) describes TLS1.3 and supersedes RFC8446. The older RFC page is therefore insufficient as the only current-spec reference. This does not by itself settle the newest-version claim.
- f20: [Oracle support roadmap](https://www.oracle.com/java/technologies/java-se-support-roadmap.html) lists LTS/non-LTS releases. Check the applicable release date and vendor scope before confirming a value.
- f23: [RFC Editor RFC9114](https://www.rfc-editor.org/info/rfc9114/) specifies HTTP/3. A human must separately establish whether it is the newest relevant version.

These additions come from automated reading, not the project's real Anthropic/Linkup runner. No real run, measured provider cost, human verification, source independence or factual score is claimed by this artifact.
