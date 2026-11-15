# ShallowSee Autopilot

Describe a small software tool in your own words. Autopilot researches the problem, plans a product, builds it in a local workspace and checks what actually works. Each run gives you the product files, use instructions and a report with evidence and remaining gaps.

## Set up in three steps

1. Install Node.js 20 or newer and Git. From the repository root, start the console with `node harness/console/server/index.mjs` and open [the local console](http://127.0.0.1:4320/).
2. Open **Setup**, choose **Add provider**, select a preset or enter your provider's address, and paste your key if required. Add the models you want to make available. Add Linkup search if you want live sources and the built-in fact checks.
3. Use **Test** to check the connection. Open **Routing & budget** to review the available roles and limits. Choose **Make a wish** when ready.

For CLI setup, copy `apiConfig.example.json` to `apiConfig.json` at the repository root and edit the local copy. `config check --offline` validates the configuration and previews routing without contacting providers.

## Make a wish

Describe a small product and give an example of the result you want. For example, “I want a little page that tells me if I need an umbrella in London tomorrow.” The console shows the plan, model selection, build attempts and checks. Full autopilot independently reviews the plan. Choose **Ask me to confirm the plan** if you want to approve the displayed version before building starts.

Use **Open the product** for a locally served static preview or **Report** for the instructions and test evidence. Run data, including `REPORT.md` and the candidate workspace, lives under `data/harness/runs/<runId>/`.

## CLI

```sh
node harness/bin/shallowsee.mjs config check --offline
node harness/bin/shallowsee.mjs run "Make a tip calculator page" --budget-usd 3 --minutes 20
node harness/bin/shallowsee.mjs runs
```

For manual plan confirmation, start the run from the console so you can use its confirmation button. The CLI's full-autopilot run exits successfully only when the product is delivered.

## Product scope

Choose small dependency-free static sites, Node.js CLI tools and small local Node.js servers. Static previews run at [the separate local preview origin](http://127.0.0.1:4321/). The builder works one item at a time, and failed tests can trigger a retry or escalation within the configured budget.

## Model selection

| Role | Default selection |
| --- | --- |
| Intake and reporting | Lowest-cost eligible JSON model near tier 2 |
| Research | Tier 2 target with JSON and tools, preferring long context |
| Plan and review | Strongest eligible reasoning model near tier 3, with reviewer model independence when available |
| Build | Lower tier for easy tasks, or the planner's eligible suggestion. Raises the target tier after failures |
| Test | Tier 2 target. Prefers reasoning and applies builder model exclusions with a fallback when there is no alternative |
| Reflect | Tier 2 reasoning target. Raises the tier on later attempts |
| Vision | Chooses a vision-capable model when available. Current practical test coverage is limited |

Pins, model capabilities and the configured roster affect these defaults. See [router policy](router/README.md) for the full selection rules and fallbacks.

## Local operation and limits

- Provider keys and secret headers stay in the local configuration, separate from generated product files. The sandbox scrubs the environment of child processes and limits filesystem access and child-process creation. Product preview and console controls use different local origins.
- An Autopilot run works in its own workspace. It does not deploy the product, push to GitHub or make purchases. Configured model and search calls use your provider account quota and can incur API charges.
- Partial or failed runs can still have useful artifacts. A model's review does not establish delivery on its own. The engine requires the final acceptance evidence to bind to the approved candidate.
- Live searches and built-in Shelf Life checks depend on a configured search provider. Where sources are unavailable, research and audit results show their limits. Automated tests do not cover every browser behavior.
- Known model spend is tracked against the run budget. Costs may be estimated or unknown when pricing or usage is unavailable.

**Evaluation** · [Run the independent benchmark](eval/README.md) · [Current evaluation status](eval/REPORT.md)
