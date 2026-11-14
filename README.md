# Shelf Life · ShallowSee Harness

Shelf Life checks documentation for facts that may be out of date, gathers sources, proposes focused corrections and records the review evidence. It is the current Imperial AI Hack project. The general collaboration platform and local model router are deferred.

## Run the workbench

The workbench reads the shared event log and shows the execution timeline, findings with sources, and reliability evidence. It has no external dependencies. Use Node.js 20 or later; local verification uses Node.js 24.

From the repository root:

```sh
node apps/server/index.mjs
```

Open **http://127.0.0.1:4318**. The bundled example is clearly labeled **synthetic / replay**; it does not call a model, perform a search or open a pull request.

Real workflow logs are discovered under `data/rooms/<roomId>/events.jsonl`. The page follows appended events and reconnects using the per-room sequence cursor. The workflow producer is developed separately; the workbench does not yet start an audit itself.

## What is available

- Local read-only HTTP and SSE event service.
- Run timeline, claim verdicts, source links, checks, patches and review evidence.
- Replay and synthetic-data labels; direct workflow runs are distinguished from harness-driven runs.
- Usage subtotals with missing measurements preserved as unknown.
- Handling of incomplete log tails and errors, without modifying the log.
- [Direct audit runner](docs/DIRECT.md), including an offline synthetic command and bounded provider adapters; live accounts remain unverified. With `--open-pr` it can publish a validated patch as a branch and a pull request for a person to approve; that path is tested against a local Git remote and a simulated GitHub API, not yet against GitHub.
- [Offline evaluation](docs/EVALUATION.md), with independent gold and an unreviewed draft generator for new logs.

The complete research → correction → review workflow and external provider integrations are in development. An ended model run is not accepted work; acceptance is recorded separately with evidence.

## Development

- [Event contract](docs/CONTRACT.md) — the shared interface.
- [Workbench guide](docs/WORKBENCH.md) — transport, configuration and validation.
- [Fable's demonstration plan](demo-plan.md) — workflow and delivery plan.
- [Coordination notes](coordination-notes.md) — current scope and earlier discussion.
- [Sample log](samples/shelf-life-room.sample.jsonl) — generated example, not a real run.

Validate the example contract:

```sh
node samples/validate-events.mjs samples/shelf-life-room.sample.jsonl
```

Run the offline test suite (no provider accounts required):

```sh
node --test apps/server/tests/server.test.mjs apps/web/tests/ui-model.test.mjs eval/tests/score.test.mjs eval/tests/prepare-review.test.mjs packages/event-log/tests/event-log.test.mjs packages/shelf-life/direct.test.mjs packages/shelf-life/publish.test.mjs
```

Keep API keys and access tokens in the relevant machine's environment. Do not put credentials in event payloads, screenshots, source files or commits. `data/` is local runtime output and is ignored by Git.
