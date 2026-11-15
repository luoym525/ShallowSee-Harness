# 09 Evaluation and demo hand-back

Branch `lynx/09-eval-demo`. Implementation commit `35f20511e9781987a579556460acf0c378ec2567`. Base `2ac5d1a59f7cc4e525c8d4445d0bda84149c3873`.

## Phase 1

- Six plain-language wishes exercise a multiplication CLI, a tip calculator page, a unit converter, a forecast page, a to-do page and a CSV statistics CLI. The launcher passes only the wish to the engine. It records the checkout revision, attempt status, elapsed time and run IDs in a local manifest.
- The scorer projects the run's recorded best candidate into an isolated workspace from Git objects and reuses the sandbox and tester. If there is no recorded best commit, it uses the recorded final candidate. It measures held-out results separately from the engine's own score.
- Trial rows show Git revision, date, group size, run ID, candidate, check outcomes, model choices, iteration and escalation counts, plan revisions, reverts and available cost and time evidence. Timed-out, failed, errored and interrupted attempts count as misses. Incomplete manifests and synthetic evidence are labelled.
- `harness/README.md` covers user setup, scope, routing and the CLI. The demo script leaves measured fields blank. The Q&A records practical coverage limits.

## Verification

```text
node --test "harness/eval/**/*.test.mjs"
tests 7     pass 7     fail 0     skipped 0
```

Tests used temporary labelled synthetic run folders, real Git commits, and the real sandbox and tester. They check that the committed candidate is used even after the original worktree moves, that invalid numeric results and hidden script/head/comment text do not pass, and that a timeout reduces a perfect rate to one out of two. The runner also records an interrupted attempt as incomplete and includes it in the denominator. No real model or search calls were made.

## Limits and pending evidence

Browser benchmark checks read static entry text, with no runtime browser coverage. They do not validate interaction, live forecast responses or localStorage behavior. A live browser demonstration and measured Phase 2 benchmark are still pending. The score report is a status draft with no measured figures. The team has not recorded or uploaded a video.

## Contract notes

Production code is read through the public 01, 04, 05 and 06 interfaces. The scorer reads the current sandbox's sibling `workspace.git` location to copy the selected commit without changing the original candidate. If that layout changes, expose a read-only export-at-commit operation through the Workspace contract.
