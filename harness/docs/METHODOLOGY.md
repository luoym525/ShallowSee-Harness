# Methodology: what the labs publish, and how this harness applies it

Compiled 14–15 Nov 2026 from primary posts by Anthropic, OpenAI, Google and DeepSeek. Where a primary page could not be fetched, this says so. Each principle maps to a concrete, checkable design rule in this repository.

## Principles → rules

| # | Principle | Source | Rule in this harness |
|---|---|---|---|
| 1 | **Start simple; compose known patterns.** Prefer workflows with fixed code paths; add agency only where it pays. The useful patterns are routing, orchestrator-workers and evaluator-optimizer. | Anthropic, *Building effective agents* (Dec 2024); Google, *Developer's guide to multi-agent patterns in ADK* (Dec 2025): sequential, coordinator, parallel, hierarchical, generator–critic, iterative refinement, human-in-the-loop, composite | The engine is a fixed state machine (sequential + loop with exit condition and `max_iterations`). Models return labels; code moves the run. |
| 2 | **Planner, generator and a separate skeptical evaluator.** Agents grading their own work rate mediocre work too highly; a separate evaluator tuned for skepticism, testing the running app against criteria with hard thresholds, fixes it. The planner stays at "what and why" so detail errors don't cascade. | Anthropic, *Harness design for long-running application development* (Mar 2026) | `planner` writes spec + acceptance checks; `builder` never grades itself; `tester` runs the checks for real; every check is pass/fail with evidence; the reviewer is calibrated with few-shot examples and must cite evidence. |
| 3 | **One feature at a time, a JSON feature list that defines done, immutable tests, progress notes and git.** Fixes for one-shotting, early victory, undocumented state and untested "done". | Anthropic, *Effective harnesses for long-running agents* (Nov 2025) | `spec.workItems` built one per build step; acceptance tests frozen in `workspace/acceptance/` and tamper-checked; `progress.md` appended every iteration; a git commit per attempt; the builder starts each item by reading progress and the file list. |
| 4 | **Context is a finite attention budget.** Smallest high-signal context; artifacts by reference; just-in-time retrieval; structured note-taking; sub-agents return condensed results. | Anthropic, *Effective context engineering for AI agents* (Sep 2025); Google, *Architecting an efficient, context-aware multi-agent framework* (Dec 2025): context is a compiled view over state; each call sees the minimum it needs | Roles receive artifacts, never other roles' transcripts. Builder sees its one item, the spec summary, progress notes and file paths (reads files through tools). Each role returns one JSON artifact. |
| 5 | **Decouple brain, hands and session; one tool interface; credentials never in the sandbox; treat harness parts as assumptions to re-test.** | Anthropic, *Managed Agents* engineering post (2026) | Engine / sandbox / event log are separate modules; `executeTool(name, input) → string`; sandbox processes run under Node's permission model (workspace-only file access, no child processes) with a scrubbed environment, so keys are unreachable; components can be removed when a model no longer needs them. |
| 6 | **Repository as system of record; a short AGENTS.md as a map; enforce architecture mechanically, not by prompt.** | OpenAI, *Harness engineering: leveraging Codex in an agent-first world* (Feb 2026). The page returned 403 to our fetcher; summarised from search excerpts and secondary write-ups. | `harness/AGENTS.md` is a map; contracts are files; ownership is enforced by folder; tests gate every module; permissions (search, file writes) are capabilities passed in code. |
| 7 | **Manager pattern vs handoffs; layered guardrails.** Use agents-as-tools when a manager should keep control; guardrails check input and output. | OpenAI, *A practical guide to building agents* (2025) | The engine is the manager; roles are tools it calls. Input guard: intake rejects unsafe wishes. Output guards: JSON-schema validation of every artifact, path and command allow-lists in the sandbox. |
| 8 | **Verifiable rewards and verifier + meta-verifier.** Prefer tasks that are hard to solve but easy to check by program; audit the verifier itself. | DeepSeek-V3.2 technical report (arXiv 2512.02556, Dec 2025) and DeepSeek-Math-V2 self-verification (generator, verifier, meta-verifier). Details from secondary summaries; only the abstract was fetched directly. | At least 60% of acceptance checks must be executable (command, file, http). A "pass" without evidence is downgraded to "fail" in code (meta-check). The tester must use a different model from the builder. |
| 9 | **Automated evaluators plus keep-best selection; evaluators get gamed if they miss what matters.** | Google DeepMind, AlphaEvolve (2025; general availability reported Jul 2026) | Keep-best: the engine resets to the best-scoring commit after a regression. Held-out eval checks in `harness/eval/` that the planner never sees catch spec-gaming. |
| 10 | **Route by difficulty and cost; parallel subagents cost many more tokens.** An Opus lead with Sonnet subagents beat single-agent Opus by 90.2% on Anthropic's research eval; multi-agent runs use far more tokens. Clear subagent briefs (objective, output format, tools, boundaries) matter most. | Anthropic, *How we built our multi-agent research system* (Jun 2025); Anthropic, *Building effective agents* (routing) | `router/` tiers; escalation on failure; hard USD and time budgets; each role prompt states objective, output schema, allowed tools and boundaries. The same brief format is used for this repo's nine workstreams. |
| 11 | **Evaluate outcomes and read transcripts; report pass@k and pass^k.** | Anthropic, *Demystifying evals for AI agents* (Jan 2026) | `harness/eval/` scores outcome (held-out checks) and keeps every transcript as events; reports pass@k and pass^k when k > 1. |

## What we deliberately do not do

- **No human gate inside a run** (Bill's requirement). Where the published patterns use human-in-the-loop for high-stakes actions, this harness has none of those actions: it never deploys, pays, emails or pushes during a run. It works only in its own workspace, so an automatic reviewer gate is enough. Teammates who want the gate set `autonomy: "confirm_plan"`.
- **No framework dependency.** The patterns are small enough to implement directly; zero dependencies also keeps the nine parallel branches conflict-free.
- **No self-grading.** No module that produced an artifact decides whether it is good.

## Sources

- Anthropic — https://www.anthropic.com/engineering/building-effective-agents
- Anthropic — https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic — https://www.anthropic.com/engineering/harness-design-long-running-apps
- Anthropic — https://www.anthropic.com/engineering/managed-agents
- Anthropic — https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- OpenAI — https://openai.com/index/harness-engineering/
- OpenAI — https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
- Google — https://developers.googleblog.com/developers-guide-to-multi-agent-patterns-in-adk/
- Google — https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/
- Google DeepMind AlphaEvolve — https://www.infoq.com/news/2026/07/alphaevolve-generally-available
- DeepSeek — https://arxiv.org/abs/2512.02556
