# Shelf Life evaluation plan

**Status:** draft for team review. Do not report scores until the handbook, reference labels and a real run are available. This plan evaluates the Shelf Life workflow; it does not establish that any provider integration works.

## Evaluation unit and answer key

Use one row per independently checkable claim, with a stable `claim_id`. Keep the source handbook frozen for a run and retain a separate reference file that the agent cannot read. Record the exact quoted text and document location so the label can be reproduced.

Suggested answer-key columns (the older compact schema below is superseded by this fuller split):

```text
dataset_version,claim_id,document_path,source_span,claim_text,category,
scope,as_of_utc,gold_label,expected_value,gold_evidence_ids,planted,
verified_by,verified_at_utc,confidence,notes
```

`gold_label` is `fresh`, `stale`, or `unverifiable`. `scope` records applicable geography, product/version and period. `confidence` is a human assessment (`high`, `medium`, `low`), not a model probability. An unverifiable reference is not counted as a stale hit or a fresh true negative. Do not put API keys or private account data in the answer key.

For each row, a human reviewer should confirm that the quote exists at the stated location; the reference value applies to the same product, geography and time period; the source is authoritative enough for that fact; and its publication/effective date supports the label. A second reviewer should adjudicate low-confidence or disputed rows before scoring.

## Dataset design

Freeze and version the handbook and key together. Include a mixture of fresh and stale claims, different fact types, an ambiguous or changed-in-scope fact, and a claim with insufficient or inaccessible evidence. Include a document with no checkable claims if extraction is in scope. Deliberately planted stale examples are acceptable for a demo, but disclose them and do not present the result as an unbiased real-world prevalence estimate.

Avoid near-duplicate claims that inflate the sample count. Group claims that depend on the same underlying source so errors can be inspected together. Record how each example was selected. Keep the evaluation key outside the agent's input and avoid tuning prompts against the scored set.

## Run result file

Keep separate, versioned CSV files and retain raw event references. Use one row per finding in `claim-results.csv`, one row per cited page in `sources.csv`, and one row per run in `runs.csv`:

```text
claim-results.csv: run_id,finding_id,claim_id,predicted_label,proposed_text,
output_ref,evidence_result,independent_support_count,correction_result,
reviewed_by,review_notes

sources.csv: evidence_id,run_id,finding_id,source_url,retrieved_at_utc,
access_status,source_group_id,supports_verdict,supports_replacement,reviewed_by,notes

runs.csv: run_id,dataset_version,input_commit,code_commit,provider,model,
config_ref,started_at_utc,finished_at_utc,status,retry_count,usage_status,
input_tokens,output_tokens,cost_status,cost,currency,events_path,artifact_ref
```

`source_group_id` captures known common upstream publishers; domain diversity alone does not prove independent sources. `supports_verdict` and `supports_replacement` are human labels (`yes` / `no` / `unclear`). Store task acceptance and patch evidence references in the result or run record. A completed model run alone is not accepted work. Usage and cost stay null when the provider did not measure them.

## Metrics

Report counts and denominators alongside rates, by run and overall:

- **Stale precision:** correct stale predictions / all stale predictions. Shows the share of proposed stale findings that are true.
- **Stale recall:** correct stale predictions / all reference-stale claims. Shows how many known stale facts were found.
- **Fresh false-positive rate:** fresh claims incorrectly predicted stale / all reference-fresh claims.
- **Abstention rate:** `unsure` predictions / all evaluated claims, split by reference label. Abstention is not a correct stale detection.
- **Extraction coverage:** reference claims represented by a matched prediction / all reference claims. Create an explicit `missing` result for each unmatched reference claim; report extra predictions separately and do not publish final precision until extras are adjudicated.
- **Citation support:** predictions whose cited pages actually support the stated verdict/value / all predictions with citations. A URL or a matching number in a search snippet is not, by itself, proof that the whole claim is supported.
- **Independent support:** stale verdicts with sufficient, genuinely independent sources / stale verdicts. Track domains as an initial warning only; humans must identify syndication, affiliates and copied pages.
- **Correction safety:** count of unsupported values, edits outside the claim's scope, and proposed changes to claims labeled fresh or unverifiable.
- **Evidence-backed safe correction recall:** stale claims that received a correct, supported, in-scope correction / all gold-stale claims. Also report the raw unsafe correction count.
- **Completion and operations:** accepted tasks / attempted tasks, failed runs, retries per claim, elapsed time and measured cost. Present unknown cost separately; never treat it as zero.

Show a confusion table over `fresh`, `stale` and `unsure`, with `unverifiable` references broken out. When a denominator is zero, show `N/A`. Do not average percentages with different denominators without also providing the underlying counts.

## Comparison and evidence

If comparing prompt, model or routing variants, use the same frozen handbook, answer key, source-access conditions and acceptance rules. Record the exact variant, provider, model, timestamp and configuration. Separate cold-start from warm latency. Keep failures in the denominator for completion. Report per-run values and variation; do not select the best run. A direct workflow run and a harness-scheduled run are distinct cohorts and must be labelled separately.

For every score, keep a reproducible link to the answer-key version, event log, run IDs, human review record and calculation script. A reviewer should be able to recompute each aggregate from claim-level rows.

## Human review required

Humans must validate reference facts and their effective dates, decide whether cited pages actually support the whole proposition, identify copied or non-independent sources, adjudicate ambiguous claims, inspect patch scope and correctness, and verify that the final task acceptance evidence matches the produced artifact. Automated domain, quote and substring checks can flag cases for review but cannot make these judgments.
