# Offline Shelf Life evaluation

The dependency-free evaluator scores one v1 JSONL room against a separate human-reviewed answer key and explicit claim mapping. It makes no model/search requests, edits no handbook and never infers evidence quality from domain counts or snippet matches.

Run with Node.js 20+ from the repository root:

```sh
node eval/score.mjs samples/shelf-life-room.sample.jsonl eval/fixtures/synthetic-gold.json eval/fixtures/synthetic-review.json
node --test eval/tests/score.test.mjs
```

The bundled gold and review describe fictional Acme claims from the generated sample. Their numbers test the evaluator, not real accuracy. Synthetic output always has `publishable: false`. No real verified handbook dataset has been delivered with this tool.

## Inputs

Keep gold and review files outside the workflow agent's input. Freeze the actual handbook separately; `handbookRef` must identify its commit or content digest. The evaluator records SHA-256 hashes of all three input files for reproducibility. It does not independently validate that a handbook commit exists or that a reference is true.

Gold JSON uses `schemaVersion: 1`, a unique `datasetVersion`, explicit `synthetic: true/false`, `handbookRef`, and `claims`. Each claim has:

| Field | Meaning |
| --- | --- |
| `id` | Stable reference ID, independent of model-generated claim IDs |
| `label` | `fresh`, `stale`, or `unverifiable` |
| `doc`, `quote` | Source document and exact claim text |
| `asOfUtc` | Fact's applicable UTC observation/capture time |
| `verifiedBy`, `verifiedAtUtc` | Human reference reviewer and UTC verification time |
| `referenceUrls` | Original HTTP(S) sources; required for real fresh/stale labels |

Use additional fields for source spans, scope, expected value and review notes when collecting real references. An unverifiable claim is separate from fresh and stale; it is not a correct stale detection or fresh true negative. A person's name and URL in JSON are declarations, not proof of independent source review.

Review JSON has `schemaVersion: 1`, the log's `roomId`, the gold's `datasetVersion`, `goldDigest`, and `findings`. `goldDigest` is SHA-256 of `JSON.stringify(parsedGold)`; create it only after reviewing that frozen gold snapshot:

```sh
node --input-type=module -e "import fs from 'node:fs'; import {goldDigest} from './eval/score.mjs'; console.log(goldDigest(JSON.parse(fs.readFileSync('YOUR-GOLD.json'))))"
```

Each review row records `claimId`, `goldId` (or `null` for an extra), `extractedEventId`, `finalEventId` (`null` if no final exists), and `reviewedBy`. Mapping is explicit and one-to-one: IDs, text similarity and quotes are never matched automatically. A duplicate/split finding needs adjudication; map the duplicate as an extra rather than silently selecting the better answer. Unknown IDs and duplicate mapping targets are rejected.

Review labels are:

| Field | Allowed values |
| --- | --- |
| `citationSupport` | `yes`, `no`, `unclear`, `unreviewed` |
| `independentSources` | `yes`, `no`, `unclear`, `unreviewed` |
| `correctionSafety` | `safe`, `unsafe`, `not_applicable`, `unreviewed` |

Humans must inspect the cited pages, editorial independence, correction correctness and edit scope. The tool does not turn producer `shelflife.check.result` assertions into human evidence labels. New final/extraction event IDs or changed gold invalidate old reviews. Reviewers must recheck affected claims before updating the bindings.

Positive citation review requires at least one valid cited URL; positive independence review requires two distinct cited URLs. These checks reject impossible review entries; distinct URLs do not establish source independence. Malformed citation records fail validation.

Every review row also has `sourceReviews`, one entry per distinct final cited URL. Each entry binds `url`, `source_group_id` (string or `null` when unknown), `supportsVerdict`, `supportsReplacement` (the same four support labels), and `reviewedBy` (string or `null`). Positive support needs a named source reviewer. Uncited, missing and duplicate URL bindings are rejected. Use the same group for mirrors, syndication and pages derived from one upstream publisher, even across different domains. Unknown groups earn no independence credit.

Independent support needs the aggregate positive review and at least two source groups with positive verdict reviews. Safe-correction credit additionally needs both groups to have positive replacement reviews, plus the aggregate safety review and stale gold label. The report retains each binding and both group counts. **Evaluator logic cannot verify whether a human truly reviewed a source, whether a reviewer identity is genuine, or whether the supplied group assignments are correct.** These remain human evidence judgments; URLs and different group strings alone do not prove independence.

## Output and interpretation

Rates include numerator and denominator; zero denominators are `null` (N/A). The confusion table includes `missing`, distinct from explicit `unsure`. Every gold claim stays in extraction/recall denominators even when the agent missed it. Extra findings are listed separately; they block final stale precision until adjudicated into a new gold version and remapped.

Stale precision is correctly matched stale predictions / all stale final predictions. Stale recall and safe correction recall use all gold-stale claims. A safe correction needs a stale gold label, stale final verdict, nonempty correction, explicit positive support/independence/safety reviews, and the two reviewed source groups above. Unsafe correction counts include edits to fresh/unverifiable claims, reviewer-marked unsafe changes and unsupported cited corrections. Unreviewed correction counts remain separate; they are never presumed safe.

Citation support uses all final verdicts with citations as denominator; independent support uses all final stale verdicts. Unclear/unreviewed cases remain in denominators, fail positive-support counts and make the report provisional. Abstention uses all gold claims as denominator, with a split by gold label. Counts are descriptive; there is no automatic release threshold or statistical generalization from the planted sample.

The report preserves `synthetic` and `driver` (`direct`/`harness`). `transport: offline_log` describes this reader; replay is transport metadata and cannot be reconstructed from the log. Never combine direct and harness runs, or synthetic and real cohorts, into one headline score. Provider usage, labeled estimates and unknown runs remain separate; no measurement yields `null`, not a zero bill. An ended model run never implies accepted work; task acceptance follows the same evidence/revocation projection as the workbench.

Partial tails are reported and skipped by the shared reader; they make the report provisional. Malformed committed records fail. `publishable` only means the declared input/review completeness checks passed; it does not certify factual truth. Non-completed rooms, extra findings and unresolved reviews retain computed diagnostic counts with reasons. Failures must still be included in any cross-run completion denominator.

Exit status: `0` for a generated report (possibly provisional), `1` for invalid inputs, `2` for incorrect CLI arguments. Consumers must inspect `publishable` and `reasons`; exit status alone is not an acceptance signal.

## Next real dataset

Astra scoped the first candidate batch to 12 dev-tool handbook claims (versions, support cycles and installation requirements), with intended document `handbook/developer-tooling.md`. That handbook and its independently verified gold are pending. Capture original sources and UTC verification times, keep real records separate from these fixtures, and have a human adjudicate ambiguous facts before quoting accuracy. Provider credentials and live Linkup/model checks belong to the workflow integration owner.
