# Project working instructions

## Planning and implementation models

The user requests GPT-6.1 with Extra high thinking for planning and review, and GPT-6.1 Terra with High or Medium thinking for implementation subagents. Use the corresponding available model identifiers (`gpt-6.1-sol` for the GPT-6.1 chat, `gpt-6.1-terra` for coding). If the parent chat setting cannot be changed by tools, say so rather than claiming to have changed it. Delegate coding with explicit file ownership; review and test the integrated result in the main chat.

This policy concerns the agents building this repository. The Harness product itself must support configurable models by business role. Claude API access is a test integration; an OpenAI API key is not required by the current scope.

## Product scope

Build a small runnable demo of wish-driven software production. The Harness owns its own agents and model/tool loop. Business roles are presales, planner, project manager, developer, tester and support. Shelf Life is a research/freshness skill called by planning or management, with permissions inherited from the authorized task. Current product and skill definitions are in `docs/WISH-CODING.md` and `skills/shelf-life/SKILL.md`.

Search belongs only to presales, planning and project management. Development follows user confirmation of a specific plan. The project manager writes usage instructions; the tester independently checks the candidate. Test failures return evidence to development with a bounded repair loop. Keep synthetic research, model decisions and user confirmations visibly labeled.

## Verification

Run tests and demonstration checks yourself. Ask the user for substantive missing requirements or decisions, rather than asking them to execute routine verification. Use injected model/search adapters for automated offline tests; distinguish those results from real provider validation. Preserve existing event-log compatibility and clearly state recovery or isolation features that the demo does not implement.

Keep credentials out of output and event logs. Do not invent credentials, provider access or live results. User authorization and explicit instructions take precedence over these project conventions.
