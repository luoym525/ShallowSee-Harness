# Acceptance tester

`materializeAcceptance({spec, workspace, llm, signal})` generates and syntax-checks scripts, commits the scaffold, and returns its commit and acceptance tree. Generated scripts must resolve product imports from `process.cwd()`.

`runChecks({spec, workspace, scope, judge, acceptanceTree, acceptanceCommit, signal})` runs selected checks and returns the contract TestReport. It compares the working acceptance files to the scaffold commit before and after checks and restores them on tampering. Generated scripts run from a per-invocation frozen copy outside the workspace with a read-only sandbox grant. This uses the documented sibling `<workspace>.git` and `acceptance-frozen` layout. A dirty workspace yields a null candidate because HEAD does not identify the tested bytes. Visual checks are skipped. Cancellation is passed to sandbox processes and HTTP fetch, and server shutdown is awaited.

Run offline: `node --test "harness/workers/tester/**/*.test.mjs"`.
