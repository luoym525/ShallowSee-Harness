# harness/ — map for coding agents

Read this first. It is a map, not the manual: follow the links for detail.

## What we are building

**ShallowSee Autopilot**: a person with no technical background types a vague wish ("I want a page that tells me if I need an umbrella tomorrow"). The harness turns it into a finished, tested product **without asking the person anything during the run**. It researches on the web, plans, builds, tests itself, reflects and loops until the product passes its own acceptance checks or the budget runs out. Then it hands over the product and an honest report.

Three core modules (Bill's words):
1. **Loop**: plan → execute → test → reflect → loop back.
2. **Model selection**: the harness picks the model for every sub-task (strong for planning and review, cheap for coding, an independent one for testing, a vision model for images).
3. **Self-testing and optimisation**: an independent tester and reviewer do the job a human reviewer would do, and the harness keeps the best candidate.

## Where things are

| Path | What | Owner |
|---|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Runtime loop, components, data flow. Start here. | PM (frozen) |
| [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | The published agent-building practices this design follows, with sources | PM (frozen) |
| [contracts/interfaces.md](contracts/interfaces.md) | Every module's exports and types. **The integration contract.** | PM (frozen) |
| [contracts/artifacts.md](contracts/artifacts.md) | Run folder layout and JSON formats (brief, research, spec, test report, ...) | PM (frozen) |
| [contracts/events.md](contracts/events.md) | Event log types the engine writes and the console reads | PM (frozen) |
| [contracts/api-config.md](contracts/api-config.md) | `apiConfig.json` format, provider presets, key-handling rules | PM (frozen) |
| [contracts/http-api.md](contracts/http-api.md) | Console server ↔ web UI endpoints | PM (frozen) |
| [tasks/README.md](tasks/README.md) | How the nine workstreams run in parallel, branch, report and merge | PM (frozen) |
| `tasks/NN-*.md` | One brief per workstream | PM (frozen) |
| `providers/` | apiConfig load/save, model and search clients | Workstream 01 |
| `router/` | Model catalog and per-task model selection | Workstream 02 |
| `roles/` | Intake, researcher, planner, reviewer, reflector, reporter | Workstream 03 |
| `workers/sandbox/`, `workers/builder/` | Safe workspace, tools, coding loop | Workstream 04 |
| `workers/tester/` | Independent acceptance testing | Workstream 05 |
| `engine/`, `bin/` | The loop, run state, budgets, CLI | Workstream 06 |
| `console/server/` | Local HTTP + SSE server for the UI | Workstream 07 |
| `console/web/` | English web UI, including the provider setup page | Workstream 08 |
| `eval/`, `docs/demo/`, `README.md` | Benchmark wishes, scorer, demo script, user README | Workstream 09 |
| `skills/` | Built-in skills; first: Shelf Life fact check (reuses `packages/shelf-life`) | Workstream 10 (Lynx's Sol) |
| `tasks/reports/NN-*.md` | Each workstream's hand-back report (one file each) | Each workstream, own file only |

## Rules that are enforced, not suggested

1. **Write only inside the paths your brief gives you.** Everything else is read-only for you, including `contracts/`, other workstreams' folders and every file outside `harness/` (apart from the hand-back report). This is what keeps nine parallel branches conflict-free.
2. **Zero npm dependencies.** Node.js 20+ ES modules (`.mjs`), built-in `node:` modules and global `fetch` only. No `package.json`, no lockfile, no build step, no CDN scripts. Python is not used inside `harness/`.
3. **Import other workstreams only through the exports listed in `contracts/interfaces.md`**, by relative path (for example `../providers/index.mjs`). Until a module lands on `main`, write a small fake of its contract inside your own tests.
4. **Keys never leave `apiConfig.json`.** Not in events, logs, errors, test fixtures, screenshots, commits or HTTP responses. Errors are redacted. The sandbox gets no keys in its environment.
5. **Unknown is `null`, never `0` or a guess** (tokens, cost, durations). Estimates are labelled `"estimated"`.
6. **Never present synthetic output as real.** Fixtures are labelled `synthetic: true`. Demo numbers come from real runs only.
7. **Tests:** `node --test "harness/<your-folder>/**/*.test.mjs"` (quote the glob; on Node 22 a bare folder path does not run its tests) must pass offline with no keys and no network. Live checks go in a separate script that skips cleanly when no key is configured.
8. **Contract change needed?** Don't edit `contracts/`. Write the request in your hand-back report under "Contract requests" and tell Bill; the PM session decides and re-issues the contract.

## Conventions

- Files: `index.mjs` is your public entry; tests are `*.test.mjs` next to the code; a short `README.md` in your folder says how to use it.
- Errors: throw `Error` subclasses with a stable `code` string and a redacted `message`.
- Time: ISO 8601 UTC strings. IDs: lowercase, `[a-z0-9-]`.
- Line endings: this Windows checkout uses CRLF via `core.autocrlf`; let git handle it, and don't commit whole-file line-ending churn.
- Commit messages: imperative, prefixed with your workstream, e.g. `providers: add Anthropic tool-call mapping`.
