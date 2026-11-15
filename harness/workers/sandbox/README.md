Sandbox workspaces use a separate trusted sibling Git directory and empty hooks directory. Node runs with its permission model, a scrubbed environment, no subprocess or worker permission, and a host-built script or test invocation. Host-trusted readOnlyPaths can provide frozen acceptance scripts. Model tools cannot supply these paths.

Tool-level readOnly and denyPaths protect writes through tools only. A Node script can modify acceptance/ inside the workspace; the tester detects and restores this using its tree-hash check and runs tests from a frozen copy. Network access remains open. CPU and memory are bounded only by timeouts. Node permission support is probed and execution fails closed if unavailable.

`workspace.git.status()` returns `{ clean, changed }` for tracked changes and untracked files using read-only Git status with optional locks disabled. Paths are workspace-relative and preserve names from Git's NUL-delimited output.
