# Running the wish-driven Harness demo

The demo runs this repository's own model/tool loop. It does not delegate coding to an installed CLI agent. The implementation is deliberately local and small: presales, planning, Shelf Life research, explicit plan approval, development, project-manager instructions, independent tests and a bounded repair attempt.

## Offline verification

`node packages/harness/run.mjs --synthetic` runs a scripted cart-calculator fixture. Model choices, research and approval are simulated and labeled; generated source, independent test files and Node test execution are real. It writes a new project under `data/harness-projects` and a contract event log under `data/rooms`. The older `packages/harness/demo.mjs` is the original Hello World fixture.

The agent building this repository runs these checks itself. The synthetic command is also available for inspecting the demonstration; it is not evidence that live research or a live model has succeeded.

## Claude test integration

Live mode accepts a project idea:

```powershell
node --env-file=.env packages/harness/run.mjs --idea "Build a small cart total calculator with validation"
```

It requires `ANTHROPIC_API_KEY`, `LINKUP_API_KEY`, and explicitly selected structured-output-capable Claude models. No OpenAI API key is required. Set `HARNESS_MODEL` as a shared test default, or configure separate role selections:

| Role | Environment variable |
| --- | --- |
| Presales | `HARNESS_MODEL_PRESALES` |
| Planner | `HARNESS_MODEL_PLANNER` |
| Project manager | `HARNESS_MODEL_PROJECT_MANAGER` |
| Developer | `HARNESS_MODEL_DEVELOPER` |
| Tester | `HARNESS_MODEL_TESTER` |
| Support | `HARNESS_MODEL_SUPPORT` |

Role overrides take precedence over the shared default. Sharing a default does not demonstrate cost savings from different models. The GPT-6.1 / Terra policy in the root `AGENTS.md` concerns the agents developing this repository, separately from these product runtime settings.

The live CLI prints the plan and its SHA-256 digest, then requires an interactive `approve` for that version. It stops before development if research requires revision, evidence remains unresolved, input is noninteractive or approval is declined. It does not silently approve a plan. Search access is supplied only to authorized research roles; Shelf Life findings are bound to the plan digest and URLs actually returned by the search adapter.

## Evidence and limits

The event log records role/model identity, tool activity and measured usage when available. Usage from multiple calls in one role execution is aggregated; unavailable counters stay unknown. The final delivery candidate must match the tested source content. A model's statement that tests passed is insufficient: the host checks an actual test execution.

Workspace tools reject ordinary path traversal and symbolic links, separate source writes from tester writes and limit file/output sizes and execution time. Generated Node.js runs with the local user's operating-system permissions. These tools are not an OS sandbox; this demo is intended for trusted local experiments.

Provider adapters are checked with injected responses. Without separately recorded live evidence, do not claim that a real Claude/Linkup workflow completed. Shelf Life research conclusions are bounded judgments over the retrieved material, rather than a guarantee of factual accuracy or industry-wide adoption.

The current demo has sequential role handoffs and bounded retries. It does not implement arbitrary intent routing during an active run, persistent execution recovery, parallel worktree scheduling, deployment, or a remote authenticated service. Its `delivery` phase means a tested candidate is ready for review, not that the user has accepted a release. The support role is registered for future post-delivery interactions.
