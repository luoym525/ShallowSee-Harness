# ShallowSee Harness · 许愿式编程

ShallowSee 的产品目标是：用户提出想法，Harness 根据用户当前目的和项目状态，调度售前、规划、项目经理、开发、测试和售后 Agent，完成从想法到软件交付的全过程。各岗位采用不同模型配置控制成本；只有售前、规划和项目经理可以使用搜索 API 核实成熟方案与实时事实。

默认流程是：**需求澄清 → 方案规划 → 用户确认方案 → 编程 Agent 开发 → 项目经理编写使用说明 → 独立测试与返工 → 交付与售后**。完整职责、意图路由、模型策略、权限和实施顺序见 [许愿式编程产品与架构定义](docs/WISH-CODING.md)。这是最新用户目标，取代旧文档中 Shelf Life 优先、通用 Harness 后置的范围说明。

**Shelf Life 是规划／项目经理的研究与时效核查 skill**：目标是主动寻找最新相关工业方案，核实版本、准确性、维护状态与实际生产实践，把带来源和核实时间的报告交回原岗位。[可复用 skill 指令](skills/shelf-life/SKILL.md)已接入演示中的规划研究任务；当前实现使用搜索结果并绑定方案摘要与来源 URL，完整的[报告契约](skills/shelf-life/references/report.md)、原文核查和时效重查仍需扩展。

**当前已有小型多岗位 Harness 演示**：包含本项目自己的 Agent 工具循环、岗位权限、方案确认、开发、项目经理说明、独立测试和有上限的返工。模型与搜索可注入，Claude 用作测试供应商适配。完整工业生产平台、运行恢复与售后交互仍未实现。下方也保留原 Shelf Life 工作台与审计功能。

一个早期 Harness 合成演示可通过 `node packages/harness/demo.mjs` 运行。它使用模拟的模型、研究结果和用户确认，生成并测试一个本地示例程序；不调用真实模型或搜索。事件记录可在工作台查看。该演示尚未实现真实模型适配、Shelf Life 调度或服务重启后的任务恢复。

新增的多岗位演示入口是 `node packages/harness/run.mjs --synthetic`，使用本项目自己的 Agent 执行循环、Shelf Life 研究任务和独立测试岗。Claude 测试适配、按岗位选择模型以及交互式方案确认的使用方法和限制见 [Harness demo guide](docs/HARNESS-DEMO.md)。真实供应商链路仍需单独验证。

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
