# ShallowSee Autopilot

**Say what you want in one sentence. Get back working software, test evidence, and an honest report. Nobody needs to write, review or test code.**

> First real run, 15 Nov 2026: a one-sentence wish became a working bill-splitter web page in **9 minutes for $2.17**. It used **4 live Linkup searches**, had its plan **fact-checked against current sources before any code was written**, and passed **10 of 11 independent acceptance checks**. One coding step escalated automatically from a cheaper model to Claude Opus 5.5 after failing twice.

## The problem

AI coding tools still need a developer in the loop. Someone has to answer their questions, check that the facts they rely on are current, decide whether the result is good, and test it. People with ideas but no technical background are locked out. And "the model says it works" is not evidence.

## What we built

ShallowSee Autopilot is an autonomous harness that runs the whole software process by itself:

- **It never asks the user anything during a run.** Every ambiguity becomes a written, reviewable assumption.
- **It researches with live web search** (Linkup) instead of trusting a model's memory.
- **It verifies its own plan's facts** against current sources before building, using the built-in Shelf Life skill.
- **It never grades its own work.** An independent tester runs real acceptance checks, and an independent model reviews the plan and the result.
- **It picks the right model for each step.** The strongest model plans, cheaper models write code, a different model tests, and it escalates after failures.
- **It is honest.** A skipped check means "partial", never "delivered", and every number in the report traces back to an event log.

## How it works

```
wish → intake → research (Linkup) → plan → plan check (Shelf Life + Linkup) → independent plan review
     → for each work item: build (sandboxed) → independent test → reflect → retry / escalate model / next
     → final test → final review → fact check (Shelf Life + Linkup) → report + product
```

- **Model routing:** the planner suggests a coder model for each work item, and the router checks it against the models you configured, their capabilities and your budget. A failed attempt escalates one tier, and every choice is logged with a one-line reason.
- **Keep-best:** if a new attempt scores lower, the workspace resets to the best commit.
- **Sandbox:** model-written code runs under Node's permission model. It can only touch its own workspace, can't start other processes, and has no API keys in its environment. Acceptance tests run from a read-only frozen copy, so the code under test can't edit them.
- **Hard limits:** a budget in USD, a time limit and a cap on build iterations. Plans that aren't approved stop the run instead of sneaking through.
- **Live console:** an English web UI shows each step, which model is working and why, sources, test evidence and cost. Setup works like CC Switch: pick a provider preset, paste a key, test it.

## How we use Linkup

Linkup is the harness's only source of fresh facts, and it is used at three points in every run:

1. **Research:** before planning, the researcher sends targeted Linkup searches (sourced answers) for the current APIs, standards and facts the product needs. Every finding carries its source URLs, which are passed to the planner and shown in the console.
2. **Plan check, before any code is written:** the built-in **Shelf Life** skill extracts every checkable fact the plan relies on and verifies each one with two independent Linkup searches. A fact that two independent sources show to be stale **automatically forces the plan to be revised** with the corrected value and its sources.
3. **Fact check of the delivered README:** the same skill audits the product's documentation and lists any stale claims as proposed, cited corrections.

Shelf Life started as our stand-alone tool for auditing documentation and was turned into a built-in harness skill. Its full audit trail (claims, searches, verdicts and checks) is kept in its own event log for each run.

## APIs, models and datasets

| Kind | What | Used for |
|---|---|---|
| API | **Linkup Search API** (`/v1/search`, sourced answers) | Research, plan fact check, README fact check |
| API | **Anthropic Messages API** (structured outputs, tool use) | All model calls in the real run |
| API | OpenAI-compatible Chat Completions (presets for OpenAI, DeepSeek, Gemini, OpenRouter, Ollama, custom) | Supported and unit-tested; not yet exercised live |
| Model | **Claude Opus 5.5** | Planner; escalation target after repeated failures |
| Model | **Claude Sonnet 5.5** | Intake, research, plan review (independent of the planner), tester, reflector, reporter, coder for harder items |
| Model | **Claude Haiku 5.5** | Default coder for easy work items |
| Dataset | `harness/eval/wishes.json`: 6 hand-written benchmark wishes with held-out checks | Evaluation (benchmark not yet run on live models) |
| Dataset | Labelled synthetic fixtures | Offline tests only |

No model training or fine-tuning; no user data leaves the machine except the prompts and search queries sent to these APIs.

## First real run, in detail

Run `hr-20261115-104503-z4sl`, wish: *"I want a simple web page where I type in my restaurant bill and how many friends are sharing it, and it tells each person how much to pay, including the usual UK service charge."*

| Step | What happened |
|---|---|
| Research | 4 live Linkup searches, 4 findings |
| Plan | Opus 5.5 wrote the plan. Version 1 broke 2 of the harness's own spec rules, so it was revised automatically |
| Plan check | The Shelf Life skill checked the plan's facts with Linkup: 1 claim, 0 stale |
| Approval | Auto-approved by Sonnet 5.5, a different model from the planner. Recorded as a model approval, never as a user approval |
| Build | The planner chose the coder for each item. Item 2 failed twice, then attempt 3 escalated to Opus 5.5 and passed 8/8 |
| Final test | 10 of 11 checks passed. The visual check was skipped because there was no headless browser, so the run is reported as **partial**, not delivered |
| Final review | Ship, with 7 listed gaps |
| Cost and time | $2.17, 9.0 minutes |

An earlier attempt the same morning failed at planning because the planner's output hit a 4,096-token cap. That was fixed in PR #22 before this run.

## Quick start

**Windows one-click app:** [`release/ShallowSee.exe`](release/ShallowSee.exe) (34 MB) bundles Node.js and this repo at `97f2aaf`. Double-click it: it unpacks itself, starts the console and opens http://127.0.0.1:4320. Add your API keys on the Setup page (they are stored in `%APPDATA%\ShallowSee\apiConfig.json`, never in the exe). Requires Git for Windows. Self-tested on Windows 11.

1. Node.js 20 or later. Nothing to install: zero dependencies.
2. `cp apiConfig.example.json apiConfig.json` and paste your Anthropic and Linkup keys (git ignores the file), or add providers on the console's Setup page.
3. `node harness/bin/shallowsee.mjs config check` shows which model each role gets, and tests each key.
4. `node harness/bin/shallowsee.mjs run "I want a page that splits a restaurant bill between friends" --budget-usd 3`
5. Or open the console: `node harness/console/server/index.mjs`, then go to http://127.0.0.1:4320. Finished web products open on a separate, isolated preview origin, http://127.0.0.1:4321.

Offline test suite (no keys needed): 318 tests pass on this commit's parent.

```sh
node --test "apps/**/*.test.mjs" "eval/**/*.test.mjs" "packages/**/*.test.mjs" "harness/**/*.test.mjs"
```

## Known limitations

- One successful real run so far. The 6-wish benchmark has not yet been run on live models, so we don't quote a success rate.
- Visual checks need a headless browser and a vision model; without them they are skipped, and the run is reported as partial.
- Only Anthropic and Linkup have been used live. The other provider presets are implemented and unit-tested.
- When the user's API quota runs out, the harness now routes around that provider or pauses the run with a resume time (merged in PRs #24 and #25, offline-tested only). The console doesn't show a quota banner yet.

## Read more

- [harness/README.md](harness/README.md): user guide
- [harness/docs/ARCHITECTURE.md](harness/docs/ARCHITECTURE.md): the loop, budgets, keep-best and the autonomy setting
- [harness/docs/METHODOLOGY.md](harness/docs/METHODOLOGY.md): the published agent-building practices from Anthropic, OpenAI, Google DeepMind and DeepSeek behind each design rule, with sources
- [harness/contracts/](harness/contracts/): module interfaces, run artifacts, events and the HTTP API
- [docs/archive/README-earlier.md](docs/archive/README-earlier.md): the team's earlier design notes

Built by Bill, LYM and Lynx, with a team of coding agents, at Imperial AI Hack 2026.
