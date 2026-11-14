# Multi-agent harness plan (with Shelf Life and Linkup)

*Imperial AI Hack, Autonomous Agents track. Written Sat 14 Nov 2026, 13:30, from the Claude / GPT 6.1 / Bill discussion. This adds to [demo-plan.md](demo-plan.md); it does not replace it. Every gate, deadline, fallback and pitch beat in that plan still stands.*

Items marked **(agreed)** were settled in the discussion. Items marked **(proposed)** are Claude's suggestions to fill gaps nobody decided; change them freely.

## In one line

A harness that works out what the user wants, hands each part of the job to a dedicated agent with its own model and tools, checks the result, and logs every step. Shelf Life is the first workflow that runs on it, with Linkup as the search tool behind the research agent.

## 1. Routing (agreed)

1. **Explicit choice comes first.** If the user names a model or agent in the request, the harness skips the router and calls that agent directly. The named agent still gets its role prompt, tools and checks.
2. **Otherwise a small local model routes.** It only interprets intent and picks a workflow. It never does the task itself. It returns JSON: an intent and a confidence score.
3. **Low confidence goes to the strong model.** Below the cutoff, the task goes to Opus 5.5, which breaks it down rather than the router guessing.
4. **The harness controls handoffs.** Models never call each other directly.

Starting intents: code, research, writing, chat. Add testing, review and computer use as the registry grows.

## 2. Agent registry (agreed structure)

One list. Each entry names four things: **model, role prompt, tools, and how its result is checked**. Adding a new agent means adding a row, not changing the harness. Role prompts are predefined; the specific assignment and context are passed at run time.

| Agent | Model | Tools | Check |
|---|---|---|---|
| Router | Small local model (e.g. via Ollama) | None | Labelled prompt set (section 5) |
| Planner | Opus 5.5 **(agreed)** | Read-only repo | Plan matches the fixed spec format |
| Coder | DeepSeek **(agreed)** | Write files, run tests | Tests from the plan pass |
| Tester | Not decided. **(proposed)** same model as Coder | Run tests | Tests run and report pass/fail |
| Reviewer | Not decided. **(proposed)** Opus 5.5 | Read-only code and diff | Review tied to an exact commit |
| Computer use | GPT 6.1 Tera **(Bill's choice)** | The Linux machine | Task-specific end state reached |
| Research | Not decided. **(proposed)** a mid-tier Claude model | **Linkup search only** | Two agreeing sources per claim |

Choosing a model does not give an agent access to anything. Tools are granted per agent through MCP, and each agent gets only the tools in its row: the computer-use agent can reach the machine, the reviewer can only read.

All models sit behind **one shared interface** (agreed), so swapping a model is a config change.

## 3. The coding workflow (agreed)

1. **Plan.** Opus writes a concrete spec in a fixed structure: files to create, the job of each function, and the test cases that count as done. Tests are written before any code.
2. **Code.** DeepSeek gets one file or function at a time, with the plan and tests, not the whole conversation.
3. **Test.** The harness runs the tests. On failure, the error output goes back to the coder.
4. **Escalate.** After the retry limit, Opus looks at the failure and either fixes the plan or writes the code itself.

## 4. The shared task record (agreed)

Agents do not pass chat history. Every task has one record that all agents read from and add to.

- **Append-only.** Entries are added, never overwritten. The current state is the latest entry. This also avoids clashes when two agents finish together.
- **Every entry is tagged** with agent, model, time, tokens, cost, pass/fail, and the commit it worked on.
- **User goal and constraints are stored separately** from agent suggestions.
- **Test and review results are tied to the exact code** they checked.
- **Each agent receives only its relevant slice**, but always the user's constraints.

This record is the same event log the original plan already calls for: the interface, Databricks and the backup replay all read it.

## 5. Numbers to measure, not assume (agreed)

- **Confidence cutoff: start at 0.7.** A score of 0.7 does not mean 70% correct. Label about 50 prompts by intent, set the cutoff on 40, and check it on the 10 held back.
- **Retry limit: start at 3.** Log the pass rate after each attempt and stop where another try rarely fixes anything.
- **Do not assume the cheap coder is cheaper.** Measure the cost and reliability of the whole loop, retries and escalations included.

## 6. Where Shelf Life and Linkup fit

Shelf Life stays exactly as written in demo-plan.md. It becomes a workflow on the harness **(proposed mapping)**:

| Shelf Life step | Agent |
|---|---|
| Pull out the claims that can go stale | Research agent (extraction prompt) |
| Search the live web for each claim | Research agent, **Linkup as its only search tool** |
| Verdict with at least two sources | Research agent |
| Self-check; reword and retry; mark "unsure" | Same retry-then-escalate loop as coding, escalating to Opus |
| Rewrite stale lines, open the pull request | Coder agent |
| Check the pull request | Reviewer agent |
| Log every step | The shared task record, loaded into Databricks |

What this adds to the pitch:

- **Linkup:** unchanged. It still researches, verifies and acts, with sources on screen.
- **Databricks:** the dashboard gains cost and pass rate per agent and per model, plus escalation counts.
- **Track ("reliably finishes"):** retry and escalation are now visible, measured behaviour.

## 7. Scope warning

At 13:30 there are about 7.5 hours until the building closes at 21:00, and the original plan already fills them. The harness must not push out any gate in demo-plan.md. Build order:

1. **Must have:** the registry as a config file, the shared interface, and the append-only log. This is small and Shelf Life needs the log anyway.
2. **Should have:** retry then escalate to Opus, used by Shelf Life's self-check.
3. **Only if the 21:00 gate is passed early:** the local router, the 50-prompt calibration, the DeepSeek coding loop, and computer use. For the demo, Shelf Life can be started by explicit choice, which rule 1 of routing already allows.

Cut from the bottom. Never cut anything demo-plan.md says not to cut.

## 8. Still to decide

- [ ] Which local model the router uses, and whether it runs on the demo laptop.
- [ ] How the user names an agent explicitly (a keyword or prefix).
- [ ] Models for the Tester, Reviewer and Research agents.
- [ ] Whether DeepSeek and GPT 6.1 Tera keys and credits are in hand. Only the Anthropic credit comes with the event.
- [ ] List every model and API used in the README and on Devpost; the rules require it.
- [ ] Whether a general harness or Shelf Life is the headline of the pitch. **(proposed)** Shelf Life is the headline; the harness is the "how it works" slide.
