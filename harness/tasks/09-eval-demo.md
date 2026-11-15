# Brief 09 — evaluation, demo script and user README

**Branch:** `bill/09-eval-demo` from `origin/bill/harness-contracts` · **Time box:** 3 h now + 2 h after integration · **Size:** M

## Mission
Prove the harness works with numbers a judge believes, and prepare the story. You build a small benchmark of wishes with **held-out checks the planner never sees**, a scorer that reads real run folders, the user README, and the 2-minute video script. Judging weights: does it work 30 · technical depth 25 · usefulness 20 · video and answers 15 · originality 10.

## You own (write only here)
`harness/eval/**`, `harness/docs/demo/**`, `harness/README.md`, `harness/tasks/reports/09-eval-demo.md`.

## Read first
`harness/AGENTS.md` · `harness/contracts/artifacts.md` · `harness/contracts/events.md` · `harness/contracts/interfaces.md` §7 (engine `startRun`, CLI) · `harness/docs/ARCHITECTURE.md` · `harness/docs/METHODOLOGY.md` · the team's video honesty rules in `docs/VIDEO.md` (read-only).

## Inputs
Run folders `data/harness/runs/<runId>/` and logs `data/rooms/<runId>/events.jsonl` produced by the engine (real runs after integration; your own synthetic fixtures before then, labelled `synthetic`).

## Outputs
1. `harness/eval/wishes.json`: 6 wishes, from easy to hard, written as a non-technical person would type them. Each has `id`, `wish`, `expectedStack` (a hint for analysis only), and **held-out checks** in the AcceptanceCheck format (artifacts.md) that run against the delivered workspace. They must not depend on the planner's file names (test behaviour: CLI output, HTTP responses, or the presence of user-visible text in the entry HTML). Suggested set: a 7-times-table CLI; a tip calculator web page; a unit converter (km/miles, °C/°F) CLI with input validation; a "do I need an umbrella in London tomorrow?" page using the key-less Open-Meteo API; a tiny to-do web app with localStorage; a CSV-to-summary-stats CLI.
2. `harness/eval/run-bench.mjs`: runs the engine (or the CLI) on each wish sequentially with a per-wish budget; `--only <id>`, `--k <n>` repeats; records runIds and raw results under `data/harness/eval/<date>.json` (ignored by git); only the final summary, `harness/eval/REPORT.md`, is committed.
3. `harness/eval/score.mjs`: for each run, (a) outcome = held-out checks run against the run's workspace at its best commit, reusing the tester's `runChecks` when available, otherwise its own runners; (b) the engine's own final score; (c) iterations, escalations, models used per role, minutes, USD (or unknown), plan revisions, keep-best reverts. Prints a Markdown table; with k > 1 also pass@k and pass^k (Anthropic, *Demystifying evals*). **Reporting rules (room #269):** every result row carries the harness commit, the date and the sample size per group; success rates count failed, errored and timed-out runs in the denominator; latency and cost come only from measurements or are explicitly labelled estimated, and unknown stays `null`. Public leaderboards are not used in the scoring. Add a fixture test that a timed-out run lowers the success rate.
4. `harness/eval/REPORT.md`: generated after integration from real runs only. Every number traces to a runId.
5. `harness/README.md`: for users. What it is (3 sentences); **Setup in 3 steps** (start the console → Setup → Add provider → paste key → Test; or copy `apiConfig.example.json` to `apiConfig.json`); make a wish; CLI usage; what products it can build (stack limits); how model selection works (the router table); safety (keys stay local, sandbox scrubs environment, no pushes, no payments); honest limitations.
6. `harness/docs/demo/VIDEO-SCRIPT.md`: a 2-minute shot list with timestamps. 0:00 problem (a non-technical person with an idea); 0:10 Setup page (CC Switch-style, 10 s); 0:20 the wish typed live; 0:25–1:20 the Live run: research sources, plan auto-approved by a named model, coder escalation after a failing test, independent tester evidence, keep-best; 1:20 open the finished product; 1:35 the eval table (real numbers); 1:50 architecture in one frame plus the methodology one-liner. Mark every number as a blank to fill from a real run. Include a backup plan (pre-recorded real run replayed through the console's replay, labelled "replay").
7. `harness/docs/demo/QA-PREP.md`: likely judge questions with crisp answers (why separate tester, how routing decides, what stops infinite loops, cost control, what fails today, how it differs from Claude Code or Codex alone).

## Testing
`node --test "harness/eval/**/*.test.mjs"` for `score.mjs` against a small synthetic run folder (labelled synthetic) and its held-out checks.

## Definition of Done (two phases)
- [ ] Phase 1 (now): wishes.json, run-bench.mjs, score.mjs plus tests, README draft, VIDEO-SCRIPT draft with blanks, QA-PREP; `node --test "harness/eval/**/*.test.mjs"` passes; branch pushed; SHA reported.
- [ ] Phase 2 (after integration, with the PM): run the bench with real keys; REPORT.md from real runs; fill the video blanks with real numbers; push and report the new SHA.

## Out of scope
Changing engine behaviour to improve scores (report findings to the PM instead), recording or uploading the video (Bill does that), the team's existing `eval/` folder (read-only).
