# Brief 05 — tester: independent acceptance testing

**Branch:** `bill/05-tester` from `origin/bill/harness-contracts` · **Time box:** 3.5 h · **Size:** M

## Mission
Be the harness's skeptical QA engineer. Before any code is written, turn the plan's acceptance checks into frozen test scripts. After every build, run the checks **for real** against the workspace and return evidence-backed pass/fail results that no model can talk its way around.

## Why it matters
This is Bill's module 3 (self-testing replaces the human reviewer). Self-grading agents overrate their own work, and a separate, evidence-bound evaluator is what makes autonomous building trustworthy (Anthropic, *Harness design for long-running apps*; DeepSeek verifier and meta-verifier).

## You own (write only here)
`harness/workers/tester/**` and `harness/tasks/reports/05-tester.md`.

## Read first
`harness/AGENTS.md` · `harness/contracts/interfaces.md` §4 (Workspace, `executeTool`) and §6 (your exports) · `harness/contracts/artifacts.md` (AcceptanceCheck, **TestReport** and its meta-check rules) · METHODOLOGY principles 2, 8, 9.

## Inputs
- `Spec` (with `acceptance[]`), a `Workspace` (from brief 04), `judge` = `llm` function bound to the tester's model (always different from the builder's: the router guarantees it), optional `vision`, `acceptanceTree` (expected hash), `scope`, `signal`.
- Until brief 04 lands, test against a small fake Workspace of your own that uses real temp directories and `child_process` (same method names and semantics as the contract).

## Outputs
- `materializeAcceptance({ spec, workspace, llm, signal })`: for every `command` check with `generate: true`, have the model write the script at `run[1]` (under `acceptance/`). Rules for generated tests: Node `.mjs` with `node:assert`, zero dependencies, deterministic. They run **inside the sandbox** (interfaces.md §4 "Sandbox boundary"): they cannot spawn processes or touch files outside the workspace, so they only import the product's exported functions or read its files. CLI behaviour is covered by direct `command` checks and servers by `http` checks, not by generated scripts. Each prints `PASS <checkId>` or `FAIL <checkId>: <why>`. Validate that each script at least parses (`node --check`). Commit `"scaffold: acceptance tests"`; return `acceptanceTree = workspace.git.treeHash("acceptance")`.
- `runChecks(...)` → `TestReport` exactly as artifacts.md.
- `harness/workers/tester/README.md`.

## Check runners
- **command:** `workspace.exec(run[0], run.slice(1), { timeoutMs })`; pass iff the exit code equals `expectExitCode` and every `expectStdoutIncludes` string appears. Evidence: command, exitCode, stdout/stderr tails.
- **file:** exists; `mustContain` substrings; `mustMatch` regex. Evidence: a short excerpt around each match.
- **http:** `workspace.startProcess(start[0], start.slice(1), { port, readyPath: request.path })`, send the request with global `fetch` (10 s timeout), check status and `expectBodyIncludes`, always `stop()` in `finally`. Evidence: httpStatus, bodyExcerpt (≤ 500 chars).
- **llm_judge:** read the listed files (via `executeTool(…, { readOnly: true })`, or `workspace.readFile`), give the judge the rubric plus file contents with line numbers, and require JSON `{ pass: boolean, quotes: [{ file, text }], reason }`. **Meta-check in code:** every quote must appear verbatim in the named file; no quotes or a missing quote → `fail` "unsupported pass". `judge` null → `skipped`.
- **visual (stretch, only after everything else is done):** if Microsoft Edge or Chrome is installed, `--headless --screenshot=<tmp>.png --window-size=1280,800 <file-url-or-preview-url>`, then ask `vision` with the rubric; same quote discipline (it must describe concrete visible elements). Otherwise `skipped` with a reason.
- **Scope:** item scope runs that item's checks plus, if `includeRegression`, every check of items listed before it in `spec.workItems` that previously passed (simply all earlier items' checks). `all` runs everything.
- **Tamper check first:** if `workspace.git.treeHash("acceptance") !== acceptanceTree` → `acceptanceIntact: false`, every result `fail` with message "acceptance tests were modified", then `workspace.git.restorePath(acceptanceCommit, "acceptance")` so the next attempt runs the frozen tests. (Builder code run through `run_command` can write inside the workspace; this check is what makes that pointless.)
- **Cancellation:** pass `signal` to every `exec`/`startProcess`; `runChecks` resolves only after every process it started has exited (stop servers in `finally` and await them).
- Score = passed ÷ (total − skipped), exact (no rounding); 0 when nothing ran. `allPassed` = total > 0, every result `pass` (no fail, error or skipped) and `acceptanceIntact`. Test that one skipped check makes `allPassed` false.

## Testing (offline)
Real temp workspaces with tiny hand-written products: a passing and a failing CLI, an HTTP server on port 4450, a missing file, a judge fake that returns a pass with a fabricated quote (must become fail), a judge with a valid quote (pass), a tampered `acceptance/` (all fail), a timeout, an aborted run. `materializeAcceptance` with a fake llm returning a script, plus a syntax-error script (must be reported, not committed silently).

## Definition of Done
- [ ] Exports match interfaces.md §6; TestReport matches artifacts.md.
- [ ] `node --test harness/workers/tester/` passes offline on Windows (paste the summary).
- [ ] Tests prove: unsupported judge passes are downgraded; tampering fails everything; servers are always stopped.
- [ ] If keys are available: a live run generates acceptance tests for a 2-item sample spec with Claude Sonnet 5.5 and runs them against a hand-written product (paste the summary). Otherwise "not run live".
- [ ] Hand-back report; branch pushed; SHA reported.

## Out of scope
Fixing code, choosing models, deciding what to do next (that's the reflector).
