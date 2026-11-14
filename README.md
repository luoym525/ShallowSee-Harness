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
- [Direct audit runner](docs/DIRECT.md), including an offline synthetic command and bounded provider adapters; live accounts remain unverified.
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
node --test apps/server/tests/server.test.mjs apps/web/tests/ui-model.test.mjs eval/tests/score.test.mjs eval/tests/prepare-review.test.mjs packages/event-log/tests/event-log.test.mjs packages/shelf-life/direct.test.mjs
```

Keep API keys and access tokens in the relevant machine's environment. Do not put credentials in event payloads, screenshots, source files or commits. `data/` is local runtime output and is ignored by Git.
