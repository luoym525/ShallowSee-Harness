# Demo Q&A

## Why separate building and testing?
A builder explains what it tried. The tester actually executes frozen checks against a specific candidate and records the result. Passing the builder's own claims does not qualify as acceptance evidence.

## How does the router decide?
It starts from the models you enabled, then considers the role, capabilities, tier, eligible pin or planner suggestion, remaining budget, and availability of an independent model. It gives a reason and bounded fallbacks. On repeated build failures it can move to a higher tier.

## What stops an infinite loop?
The engine limits plan revisions, build iterations, elapsed time and known cost. A candidate that passes only part of the acceptance suite can be reported as partial. A regression can trigger a restore to the prior better candidate.

## Can you guarantee the cost?
Provider usage and configured pricing drive the running estimate. The report labels estimated or unavailable amounts and uses time and attempt limits as well. The benchmark records elapsed cancellations, provider errors and incomplete runs.

## How trustworthy are the benchmark numbers?
Every measured row can be tied to the harness commit, recorded attempt and evaluated candidate. The runner supplies just the wish before planning. Held-out CLI checks use independent arguments or fixtures. The browser checks in this suite are static, so a separate live demonstration is needed for runtime behavior.

## What does Shelf Life add?
It audits the plan's factual assumptions and the product README against retrieved sources when search is configured. Confirmed stale plan facts can trigger revision. A README correction remains an unreviewed proposal with sources.

## What fails today?
Products that need private credentials, installations or an unsupported stack are outside this deliverable. Ambiguous requests may be scoped down. Missing models, search, provider capacity or evidence can lead to a failed or partial run, and the report records the gap.

## How is it different from using a coding agent alone?
Autopilot wraps models in a fixed build/test/review loop with role routing, a local workspace, frozen acceptance and a separate report. The planner chooses scope and tests; the harness verifies evidence and decides delivery.
