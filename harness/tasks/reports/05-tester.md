# 05 — Tester hand-back

Implemented generated scaffold scripts, trusted host syntax checks, frozen commit extraction, workspace tamper detection and restoration, command/file/HTTP/judge checks, scope and report scoring. Generated scripts execute with only the frozen directory granted as an extra read path. A dirty worktree produces a null candidate rather than attributing uncommitted bytes to HEAD. Visual checks are skipped.

Offline: `node --test "harness/workers/tester/**/*.test.mjs"` — 9 passed, 0 failed, Node 24.14.0, Windows. Tests use an independent fake Workspace and real Git repositories and exercise permission-denied writes to frozen scripts, tampering before and during execution, restoration and a clean rerun, fabricated quotes, skipped checks, timeout, cancellation, HTTP stop on error, and item regression. Live run not performed; no live keys or calls authorized.

## Contract requests

The interface does not provide a public scaffold extraction operation, nor expose the external git directory. The tester relies on the documented sibling `<workspace>.git` and `<runDir>/acceptance-frozen` layout and calls host Git with that explicit directory. `treeHash` reports committed HEAD, so the tester independently compares all working acceptance files with scaffold blobs to detect uncommitted and untracked tampering. The brief's `node --check` cannot be issued through the restricted Workspace command API; syntax validation runs as a trusted host Node invocation on a temporary sibling file. Integration with the real 04 Workspace remains to be verified.

The tester repeats the integrity comparison after all checks have settled, fails every selected check and clears candidate attribution if execution modified acceptance files, then restores the scaffold bytes. This also handles checks that return errors or cancellation.

After checks settle, the tester rechecks HEAD and Git worktree status; a moved HEAD or dirty worktree clears candidate attribution. allPassed retains the artifacts contract formula, so delivery additionally requires a non-null candidate (engine guard). The frozen-copy test executes a generated script under Node permission flags with the frozen directory read-only and verifies an attempted self-write raises ERR_ACCESS_DENIED.
