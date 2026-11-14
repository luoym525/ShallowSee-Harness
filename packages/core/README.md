# Six-role project coordinator

`packages/core/index.mjs` exports a synchronous, dependency-free coordinator for one owning Node process. It manages a set of projects, versioned plans, role profiles, task claims, runs, candidate artifacts and handoffs. Use Node.js 20+.

## State and commands

Every mutating command takes a globally unique `commandId` and a `projectId`. An exact replay returns the original result snapshot. Reusing an ID with different input raises `COMMAND_CONFLICT`. A rejected command can be retried after its prerequisites change. Use `getProject(projectId)` for the current state and history. `dispatch({projectId, kind})` reports the configured role, agent ID and stage gate for an explicit task kind. `claimTask` checks the task, dependencies, versions and workspace before a runner starts.

| Command | Required inputs beyond command and project IDs |
| --- | --- |
| `createProject` | `goal`, `profiles` with one `{id, role, backend, model, tools}` per role, optional `constraints` and `maxRework` |
| `definePlan` | `plan` with `summary`, `scope`, `architecture`, `sources`, `workItems` and `acceptanceCriteria`. Returns an immutable-by-value version and digest. |
| `confirmPlan` | `planVersion`, `planDigest`, `confirmationRef` and the separate operator authority |
| `createTask` | `taskId`, `title`, `kind`, optional `dependencies`, existing `workspace` for development or an accepted `deliveryId` for support |
| `claimTask` | `taskId`, `agentId`, `expectedTaskVersion`, `leaseMs` (1 ms to 1 hour). Returns a run ID, task and project execution versions, expiry, and applicable artifact version bindings. |
| `recordRunEnd` | Run identity plus `outcome` of `completed`, `failed` or `cancelled` once the runner confirms the execution has stopped |
| `completeTask` | Run identity plus `evidenceRef` for presales, planning, coordination or support work |
| `submitCandidate` | Development run identity plus `contentRef` in the form `git:<40 lowercase hex>` or `sha256:<64 lowercase hex>` |
| `recordGuide` | Documentation run identity plus exact `candidateVersion`, `contentRef`, `guideVersion` and `guideRef` |
| `recordTestResult` | Tester run identity plus exact `candidateVersion`, `contentRef`, `guideVersion`, Boolean `passed` and `reportRef` |
| `acceptDelivery` | Exact `candidateVersion`, `contentRef`, `guideVersion`, passing `reportRef`, `confirmationRef` and operator authority |
| `pause`, `resume` | Operator authority. Pause fences earlier execution versions. |

Pass `taskId`, `runId`, `agentId`, `taskVersion` and `executionVersion` from the recorded claim as run identity. The runner records a successful execution end before submitting its outcome. A successful execution end releases the writer reservation and records execution history. Task completion still requires the appropriate evidence submission. Late outcomes for recognized runs are retained with `applied: false` and leave project progress and rework counts alone.

| Task kind | Role |
| --- | --- |
| `presales` | `presales` |
| `planning` | `planner` |
| `coordination`, `documentation` | `project_manager` |
| `development` | `developer` |
| `testing` | `tester` |
| `support` | `support` |

A confirmed plan applies to one version. Defining a new one fences prior execution, restores the confirmation gate and preserves past candidates, deliverables and handoffs. A development claim records the project's current candidate version as its base. The first valid submission against a base advances the candidate. Later submissions against that base go to history, and an ended development task can be reclaimed against the new base. Each new candidate needs a guide and independent test before delivery. The default `maxRework = 1` allows one revision after the first failed independent test. A second failure blocks production for that plan. The project manager receives the failure handoff when the limit is exhausted.

## Runner boundary

Initialize with `createCoordinator({operatorId, operatorAuthority})`. Keep the opaque authority object or symbol within the trusted user-facing control path. Resolve the authenticated operator before confirming a plan, pausing, resuming or accepting delivery. Execution callbacks and tool requests likewise need a trusted binding from the runner to the claimed agent and run. Invoke `authorizeTool` with the run identity and a canonical `tool` on each execution-side tool request. Capabilities are `search`, `read_files`, `write_files`, `run_command` and `read_artifacts`. Search requires presales, planning or project management plus the profile capability. Source-file writes require a reserved development workspace. Adapters are responsible for mediating provider tool aliases and built-in tools, command sandboxing, controlling the actual process and checking its exit.

The coordinator canonicalizes existing development directories and reserves each writer's directory and its subtree across projects in the same coordinator. Parent and child paths overlap, and sibling directories can run in parallel. A writer retains its reservation through expiry and pause until the runner reports it stopped. Compare task and project versions and use the returned canonical workspace when starting an execution. To deduplicate runner launch, key on the returned run ID as well as using a stable command ID for retries.

This version stores state and command receipts in process memory. Process restart requires an external record or reconstruction after draining prior writers. Multi-process leases, durable recovery, recognized intent parsing, provider dispatch, artifact content verification and live tool isolation belong to the integration layer. Existing room JSONL event schemas remain compatible and the coordinator exposes evidence and handoffs for later persistence.

Run the targeted checks with `node --test packages/core/index.test.mjs`.
