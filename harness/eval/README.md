# Held-out benchmark

The runner submits plain-language wishes to Autopilot. It reads the independent test definitions only after delivery for scoring. The checks are public repository data, so a human can audit the method. A benchmark run supplies only each wish to the engine and does not put test definitions or fixture files in the planner's input or workspace.

```sh
node harness/eval/run-bench.mjs --help
node harness/eval/run-bench.mjs --only times-table --k 2 --budget-usd 2 --minutes 15
node harness/eval/score.mjs "data/harness/eval/<manifest>.json"
```

The second command invokes configured providers and may use your model and search allowance. Raw manifests, state and event logs stay under `data/`. Use the same `--data-dir` for the runner and scorer if you override it. Real report rows carry the harness commit, UTC date, group size and run ID. Dirty checkout rows are explicitly marked.

The scorer extracts files from the recorded best Git commit into a temporary workspace and reuses the sandbox and tester. The recorded final candidate is used when no best commit was recorded. CLI checks exercise documented commands with held-out inputs. Browser checks inspect static entry text, excluding scripts, styles, comments and document headers. They do not exercise the product in a browser or establish runtime behavior such as localStorage persistence or live forecast fetching. Keep a separate browser demonstration for those claims.

A trial passes only if every held-out check passes. Failures, errors, cancellations, recorded interruptions and timeouts remain in the denominator. Rows without readable evidence cannot pass. An incomplete manifest is labelled and reports recorded attempts only. At a repeat count above one, pass@k is the probability of at least one success in k draws from the recorded wish group. Pass^k is the probability of success on every draw. Both are computed without replacement and display unknown if there are fewer than k recorded attempts. Synthetic groups are separate from recorded groups.

```sh
node --test "harness/eval/**/*.test.mjs"
```

These tests use labelled synthetic fixtures and run no model or search calls. [Benchmark report](REPORT.md)
