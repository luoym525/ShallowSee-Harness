# 02 Router hand-back

Branch `lynx/02-router`. Implementation `4e1702cf4059a3ab641e96ce1c85e352e013b509`. Base `2ac5d1a59f7cc4e525c8d4445d0bda84149c3873`, which contains the current contract and workstream 01.

## Implementation

- Builds the roster through the workstream 01 provider filter. Fills missing model fields from the catalog while preserving explicit settings, including unknown or zero prices.
- Exports `DEFAULT_CATALOG`, `DEFAULT_POLICY`, `buildRoster`, `selectModel`, `describeRouting` and `RouterError` as specified in interfaces §2. The engine and CLI use these exports directly.
- Implements per-role capability checks, user pins, builder suggestions, capability and tier ordering, bounded escalations, vendor diversity, and deterministic fallbacks. Hard capability requirements and model exclusions also apply to pins. For review #399, the target tier precedes vendor diversity. The router filters vendors within each tier and keeps lower-tier alternatives available as fallbacks. When only Haiku is configured, eligible calls can use its lower tier. Calls that require reasoning return `no_match`.

## Verification

```text
node --test "harness/router/**/*.test.mjs"
tests 13, pass 13, fail 0, skipped 0

node harness/bin/shallowsee.mjs config check --offline
Configuration: valid
Provider connection tests skipped (--offline).
Config check passed.
```

The CLI check used a temporary config made from the example with offline fixture credentials and Anthropic models, loading actual workstream 01 and 02 exports. It printed nine routing rows. Test scenarios cover the strongest planner, an independent reviewer, successful and rejected builder suggestions, deterministic fallbacks, an invalid user pin, and model exclusion even with a pin.

## Integration notes

- The engine must pass the preceding model to `avoidModels` where independence is required. A routing preview has no run history and therefore may list the same default planner and reviewer.
- The reason used when a planner suggestion is accepted names the model. The frozen request supplies a model ref and has no field for the planner's free-text `modelReason`.
- Catalog prices and heuristic capabilities are the checked-in contract defaults. No live connections, provider pricing verification, or provider calls were made.
