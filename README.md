# ShallowSee Autopilot

**Type a wish. Get a tested product.** A person with no technical background describes what they want. The harness then researches with live web search (Linkup), writes a plan, checks the plan's facts against current sources (built-in Shelf Life skill), has an independent model approve it, builds one piece at a time in a sandbox, tests every piece with an independent tester, reflects, switches to a stronger model when a piece keeps failing, and hands over the product with an honest report. It asks the user nothing during the run.

The harness picks a model for every step: the strongest model plans, an independent model reviews and tests, and cheaper models write the code unless the planner or a failed test says otherwise. Every choice is logged with a one-line reason.

## Quick start

1. Node.js 20 or later. No `npm install`; there are no dependencies.
2. `cp apiConfig.example.json apiConfig.json`, then paste your Anthropic and Linkup keys (git ignores the file), or add providers on the console's Setup page.
3. Check the setup and see which model each role gets: `node harness/bin/shallowsee.mjs config check`
4. Run a wish from the command line: `node harness/bin/shallowsee.mjs run "I want a page that splits a restaurant bill between friends" --budget-usd 3`
5. Or use the web console: `node harness/console/server/index.mjs`, then open http://127.0.0.1:4320. Finished web products open on a separate preview origin, http://127.0.0.1:4321.

## First real run (15 Nov 2026, real Anthropic and Linkup keys)

Run `hr-20261115-104503-z4sl`, wish: *"a simple web page where I type in my restaurant bill and how many friends are sharing it, and it tells each person how much to pay, including the usual UK service charge."*

| Step | What happened |
|---|---|
| Research | 4 live Linkup searches, 4 findings |
| Plan | Claude Opus 5.5 wrote the plan; version 1 broke 2 of the harness's spec rules and was revised automatically |
| Plan check | Shelf Life skill checked the plan's facts against live sources: 1 claim, 0 stale |
| Approval | Auto-approved by Claude Sonnet 5.5, a different model from the planner (recorded as a model approval, not a user approval) |
| Build | The planner chose each item's coder (Sonnet for item 1, Haiku for item 3). Item 2 failed twice; attempt 3 escalated to Claude Opus 5.5 and passed 8/8 |
| Final test | 10 of 11 acceptance checks passed. The 11th, a visual check, was skipped because no headless browser was available, so the run is honestly reported as **partial**, not delivered |
| Final review | Ship, with 7 listed gaps |
| Cost and time | $2.17, 9.0 minutes |

An earlier attempt the same morning failed at planning because the planner's output hit a 4,096-token cap; that was fixed (PR #22) before this run.

## How it works

- [harness/README.md](harness/README.md): user guide
- [harness/docs/ARCHITECTURE.md](harness/docs/ARCHITECTURE.md): the plan → plan check → review → build → test → reflect loop, budgets, keep-best, autonomy setting
- [harness/docs/METHODOLOGY.md](harness/docs/METHODOLOGY.md): which published practices from Anthropic, OpenAI, Google DeepMind and DeepSeek each design rule follows, with sources
- [harness/contracts/](harness/contracts/): the module interfaces, run artifacts, events and HTTP API
- Sandbox: model-written code runs under Node's permission model (workspace-only file access, no child processes, no keys in its environment); acceptance tests run from a read-only frozen copy

Offline test suite (no keys needed), 317 tests at the time of writing:

```sh
node --test "apps/**/*.test.mjs" "eval/**/*.test.mjs" "packages/**/*.test.mjs" "harness/**/*.test.mjs"
```

Built by Bill, LYM and Lynx with a team of coding agents, at Imperial AI Hack 2026.

---

> **Earlier README (team history).** The text below predates the harness above, and its status notes about what is "not yet implemented" are out of date.

# ShallowSee Harness · 许愿式编程

ShallowSee 的产品目标是：用户提出想法，Harness 根据用户当前目的和项目状态，调度售前、规划、项目经理、开发、测试和售后 Agent，完成从想法到软件交付的全过程。各岗位采用不同模型配置控制成本；只有售前、规划和项目经理可以使用搜索 API 核实成熟方案与实时事实。

默认流程是：**需求澄清 → 方案规划 → 用户确认方案 → 编程 Agent 开发 → 项目经理编写使用说明 → 独立测试与返工 → 交付与售后**。完整职责、意图路由、模型策略、权限和实施顺序见 [许愿式编程产品与架构定义](docs/WISH-CODING.md)。这是最新用户目标，取代旧文档中 Shelf Life 优先、通用 Harness 后置的范围说明。

**当前实现仍以 Shelf Life 文档核查为主**：已有本地日志、只读工作台、特定审计流程和离线评测，尚未实现上面的完整岗位调度与生产闭环。下面的启动方法用于查看现有工作台；Shelf Life 作为已有核查能力和历史演示保留。

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

The complete wish-driven software-production harness is not yet implemented. Existing Shelf Life provider integrations also need live verification. An ended model run is not accepted work; acceptance is recorded separately with evidence.

## Development

- [当前产品定义：许愿式编程](docs/WISH-CODING.md) — roles, routing, model policy, search permissions, handoffs and delivery gates.
- [Event contract](docs/CONTRACT.md) — the shared interface.
- [Workbench guide](docs/WORKBENCH.md) — transport, configuration and validation.
- [Earlier Shelf Life demonstration plan](demo-plan.md) — historical workflow and delivery proposal.
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
