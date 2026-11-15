# Workstreams: how nine agents build the harness in parallel without conflicts

Owner: PM session (bill-command). Clock: Sun 15 Nov 2026. Hard deadline: Devpost submission **12:00** (video ≤ 2 min + public repo, last commit before 12:00). Internal target: everything merged by **06:30**, demo runs recorded by **09:30**.

## The nine briefs

| # | Brief | Exclusive write paths | Depends on (contract only) | Size |
|---|---|---|---|---|
| 01 | [providers.md](01-providers.md): apiConfig, model and search clients | `harness/providers/**` | — | L |
| 02 | [router.md](02-router.md): model catalog and per-task selection | `harness/router/**` | 01 types | S |
| 03 | [roles.md](03-roles.md): intake, researcher, planner, reviewer, reflector, reporter | `harness/roles/**` | 01 `validateJson`, RoleContext | L |
| 04 | [sandbox-builder.md](04-sandbox-builder.md): workspace, tools, coding loop | `harness/workers/sandbox/**`, `harness/workers/builder/**` | 01 types | L |
| 05 | [tester.md](05-tester.md): independent acceptance testing | `harness/workers/tester/**` | 04 Workspace | M |
| 06 | [engine.md](06-engine.md): loop, state, budgets, keep-best, CLI | `harness/engine/**`, `harness/bin/**` | all of the above | L |
| 07 | [console-server.md](07-console-server.md): HTTP + SSE + preview | `harness/console/server/**` | 01, 02, 06 | M |
| 08 | [console-web.md](08-console-web.md): English UI incl. CC Switch-style Setup | `harness/console/web/**` | HTTP + events contracts | L |
| 09 | [eval-demo.md](09-eval-demo.md): held-out bench, scorer, README, video script | `harness/eval/**`, `harness/docs/demo/**`, `harness/README.md` | artifacts + events | M |
| 10 | [shelf-life-skill.md](10-shelf-life-skill.md): Shelf Life as a built-in skill (**owner: Lynx's Sol**, authorised by Lynx #254) | `harness/skills/**` (+ `packages/shelf-life/**`, already Sol's) | 01 types, §10 | M |

Every brief also owns exactly one hand-back file: `harness/tasks/reports/NN-<slug>.md`.

**Nobody edits:** `harness/AGENTS.md`, `harness/contracts/**`, `harness/docs/ARCHITECTURE.md`, `harness/docs/METHODOLOGY.md`, `harness/tasks/*.md`, `apiConfig.example.json`, `.gitignore`, or anything outside `harness/` (teammates own `packages/**`, `apps/**`, `eval/**`, `docs/**`). Reading is fine.

## Waves

1. **Wave 0 (done by PM):** contracts branch `bill/harness-contracts`. Every workstream branches from its tip.
2. **Wave 1 (start now, about 4 h, all nine in parallel):** build against the contracts; fake every other module in your own tests. Push your branch and write your hand-back report as soon as your Definition of Done passes. Don't wait for others.
3. **Wave 2 (integration, about 05:00–06:30):** merge in dependency order **01 → 02 → 04 → 05 → 10 → 03 → 06 → 07 → 08 → 09**. Because write paths are disjoint, these merges cannot conflict. Then the PM session runs the end-to-end check with real keys and fixes cross-module bugs on a branch `bill/harness-integration`.
4. **Wave 3 (06:30–11:00):** real demo runs, eval numbers, video, README polish, submit.

## How to work (every workstream)

1. Open a fresh agent session. Put it in its own git worktree (Claude Code's "worktree" option) or its own clone of `luoym525/ShallowSee-Harness`.
2. Start it with: *"Read `harness/AGENTS.md`, then `harness/tasks/NN-<slug>.md`, and do exactly that brief."*
3. Branch: `git fetch origin && git checkout -b bill/NN-<slug> origin/bill/harness-contracts`.
4. Commit often; push with `git push -u origin bill/NN-<slug>` (new branch only, never force, never push to `main`).
5. Definition of Done = the checklist at the end of your brief, all ticked, with real command output pasted into your report.
6. Write `harness/tasks/reports/NN-<slug>.md` (template below), commit it on your branch, push, then tell Bill the branch and **exact commit SHA**. Bill (or bill-command) announces it in the team room. Team rule: reviews bind to the exact SHA, so re-announce after any new push.
7. If the contract is wrong or missing something, don't edit `contracts/`. Do the most reasonable thing inside your own folder, and record it under "Contract requests" in your report.

### Hand-back report template

```markdown
# NN <slug> — hand-back
Branch: bill/NN-<slug> · Commit: <full 40-char SHA> · Base: <contracts SHA>
## What I built
## Exports (as in contracts/interfaces.md; note any additions)
## How to run / test
<exact commands and their real output, trimmed>
## Not done / known gaps
## Contract requests
## Integration notes for the engine / PM
```

## Merge conflicts: why there can't be any

- Disjoint write paths per workstream (table above); hand-back reports are separate files.
- No shared manifest (`package.json`, lockfile) and no root files touched.
- Cross-module use only through the frozen exports in `contracts/interfaces.md`, by relative import.
- The engine (06) owns the only file that wires real modules together (`harness/engine/deps.mjs`).
- Contract changes are made only by the PM, on a separate branch, after Wave 1.
