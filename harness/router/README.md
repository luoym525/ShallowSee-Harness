# Model router

The router builds a roster from the enabled configuration and selects a model for each harness call. It returns an explanation and up to two fallbacks. It has no network or model calls.

| Role | Initial tier | Requires | Prefers | Selection | Escalation |
| --- | --- | --- | --- | --- | --- |
| Intake | 2 | JSON | | Cheapest | |
| Researcher | 2 | JSON, tools | Long context | Cheapest | |
| Planner | 3 | Reasoning, JSON | | Strongest | |
| Reviewer | 3 | Reasoning, JSON | | Strongest | |
| Builder | 1 easy, 2 medium or hard | Coding, tools | | Cheapest | +1 on attempt 2, tier 3 on attempt 3 |
| Tester | 2 | JSON | Reasoning | Cheapest | |
| Reflector | 2 | Reasoning, JSON | | Cheapest | Tier 3 on attempt 3 |
| Reporter | 2 | JSON | | Cheapest | |
| Vision | 2 | Vision | | Cheapest | |

An eligible user pin overrides the default policy. An eligible planner suggestion picks the first builder and sets the starting tier for retries. Requested capabilities and per-call model exclusions apply to every pick. When requested, vendor diversity prefers an eligible model from another vendor within each tier. The router ranks exact tier matches first, followed by the nearest available tier with the higher tier first when distances tie. Within a tier, it compares preferred capabilities, known output price and then the model ref. For planner and reviewer the frozen policy uses higher known output price as a strength proxy.

Below $0.50 remaining, the target is capped at tier 2 for default choices outside planner and reviewer. Capacity and cost reflect the checked-in catalog and configured overrides. Unlisted prices are unknown and can be supplied in the provider config.

Example decision text produced from the configured Claude catalog in an offline fixture:

- Selected the strongest available reasoning model: Claude Fable 5.2.
- Selected the strongest available reasoning model: Claude Opus 5.5.
- Selected the cheapest eligible model at tier 1: Claude Haiku 5.5.
- Escalated on attempt 2 from tier 1 to target tier 2: Claude Sonnet 5.5.
- Chosen by the planner: Claude Sonnet 5.5.

`node --test "harness/router/**/*.test.mjs"`
