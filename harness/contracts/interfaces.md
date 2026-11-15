# Contract: module interfaces

This is the integration contract between the nine workstreams. Each module's `index.mjs` must export **exactly these names with these shapes**. More exports are fine; fewer or different ones break integration. Types are written in TypeScript notation for clarity; the code is plain JavaScript (`.mjs`). JSDoc type comments are welcome.

Shared types used below come from [api-config.md](api-config.md) (`ApiConfig`, `ModelRef`, `RoleName`, `Capability`) and [artifacts.md](artifacts.md) (`Brief`, `Research`, `Spec`, `WorkItem`, `AcceptanceCheck`, `TestReport`, `Reflection`, `PlanReview`, `FinalReview`).

```ts
interface Source { name: string; url: string; domain: string; snippet: string; retrievedAt: string }
interface Usage { inputTokens: number | null; outputTokens: number | null; costUsd: number | null; source: "provider" | "estimated" | "unknown" }
```

---

## 1. `harness/providers/index.mjs` (workstream 01)

### Config

```ts
export const DEFAULT_CONFIG_PATH: string;        // <repo root>/apiConfig.json (or $SHALLOWSEE_API_CONFIG)
export const PROVIDER_PRESETS: Preset[];          // see api-config.md "Presets"
interface Preset { id: string; name: string; kind: ProviderEntry["kind"]; baseUrl: string; website: string;
                   keyRequired: boolean; keyHint: string; models: ModelEntry[] }

export async function loadApiConfig(opts?: { path?: string }): Promise<ApiConfig>;
  // Missing file → an empty default config (no providers), not an error. Invalid JSON → throws ConfigError("invalid_json").
export async function saveApiConfig(config: ApiConfig, opts?: { path?: string }): Promise<void>;
  // Validates first (throws ConfigError("invalid_config", errors) on errors); atomic write.
export function validateApiConfig(config: unknown): { ok: boolean; errors: Issue[]; warnings: Issue[] };
export function redactApiConfig(config: ApiConfig): RedactedApiConfig;    // safe to send anywhere
export function applyProviderInput(config: ApiConfig, input: ProviderInput, opts?: { id?: string }): ApiConfig;
  // Pure. Creates (no id) or updates (id) one provider following the "missing = keep, null = clear" key rule.
export function removeProvider(config: ApiConfig, id: string): ApiConfig;  // pure
export function listConfiguredModels(config: ApiConfig): ModelInfo[];
  // Every enabled model of every enabled provider that has a key (or needs none). Catalog values NOT merged here (router does that).
export function redact(text: string, config?: ApiConfig): string;

interface ProviderInput { name?: string; preset?: string; kind?: string; enabled?: boolean; notes?: string; website?: string;
                          baseUrl?: string; apiKey?: string | null; headers?: Record<string,string> | null; models?: ModelEntry[] }
interface ModelInfo { ref: ModelRef; providerId: string; providerKind: "anthropic" | "openai_compatible"; vendor: string;  // vendor = preset id or "custom"
                      modelId: string; label: string; tier?: 1|2|3; capabilities?: Capability[];
                      inputUsdPerMTok?: number | null; outputUsdPerMTok?: number | null }
interface Issue { path: string; message: string }
export class ConfigError extends Error { code: string; issues?: Issue[] }
```

### Model client

```ts
export function createModelClient(opts: { config: ApiConfig; fetchImpl?: typeof fetch; pricing?: (ref: ModelRef) => { input: number | null; output: number | null } }): ModelClient;

interface ModelClient {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

interface CompletionRequest {
  model: ModelRef;
  system?: string;
  messages: Message[];
  tools?: ToolSpec[];                    // function tools; the model may return toolCalls
  responseSchema?: { name: string; schema: object };   // ask for JSON matching this JSON Schema
  maxTokens?: number;                    // default 4096; includes any thinking tokens
  temperature?: number;                  // omitted when the provider/model rejects it
  timeoutMs?: number;                    // default 120000
  signal?: AbortSignal;
}
type Message = { role: "user" | "assistant"; content: string | ContentPart[] };
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/png" | "image/jpeg"; dataBase64: string }
  | { type: "tool_call"; id: string; name: string; input: object }            // only in assistant messages
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };  // only in user messages
interface ToolSpec { name: string; description: string; inputSchema: object }

interface CompletionResult {
  model: ModelRef;
  text: string;                          // all text parts joined
  json: unknown | null;                  // parsed JSON when responseSchema was given and parsing succeeded, else null
  toolCalls: { id: string; name: string; input: object }[];
  stopReason: "end" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: Usage;                          // costUsd from pricing when tokens are known; otherwise null
  durationMs: number;
  assistantMessage: Message;             // append this to messages to continue a tool loop
}

export class ProviderError extends Error {
  code: "not_configured" | "auth" | "rate_limit" | "timeout" | "bad_request" | "server" | "network" | "refusal" | "invalid_response";
  retryable: boolean; status: number | null;   // message is always redacted
}
```

Requirements: maps the neutral format to Anthropic Messages API and to OpenAI-compatible Chat Completions in both directions (including tool calls and tool results); retries `rate_limit`/`server`/`network` up to 2 times with backoff; honours `signal`; structured output via the provider's JSON-schema mode when available, falling back to JSON mode or prompt-only plus parsing the first JSON object (the caller validates the schema).

### Search client

```ts
export function createSearchClient(opts: { config: ApiConfig; fetchImpl?: typeof fetch }): SearchClient;
interface SearchClient {
  available: boolean;                    // false when no enabled linkup provider with a key
  search(req: { query: string; depth?: "standard" | "deep"; maxResults?: number; signal?: AbortSignal }):
    Promise<{ answer: string | null; sources: Source[]; durationMs: number }>;
}
```

### Utilities

```ts
export async function testProvider(config: ApiConfig, providerId: string, opts?: { fetchImpl?: typeof fetch }):
  Promise<{ ok: boolean; latencyMs: number | null; detail: string; models?: string[] }>;   // detail is redacted, human-readable
export async function fetchRemoteModels(config: ApiConfig, providerId: string, opts?: { fetchImpl?: typeof fetch }): Promise<string[]>;
export function validateJson(schema: object, value: unknown): { ok: boolean; errors: string[] };
  // JSON Schema subset: type, properties, required, additionalProperties:false, items, enum, const, anyOf, minItems, maxItems, minLength, maxLength, minimum, maximum.
```

---

## 2. `harness/router/index.mjs` (workstream 02)

```ts
export const DEFAULT_CATALOG: CatalogEntry[];
interface CatalogEntry { match: string;            // exact model id, or a regex source string starting with "^"
                         tier: 1|2|3; capabilities: Capability[]; inputUsdPerMTok: number | null; outputUsdPerMTok: number | null }
export const DEFAULT_POLICY: Record<RoleName, RolePolicy>;
interface RolePolicy { baseTier: 1|2|3; hardBaseTier?: 1|2|3; requires: Capability[]; prefer: Capability[];
                       pick: "cheapest" | "strongest";   // tie-break inside a tier; planner and reviewer use "strongest" (the best model provided)
                       escalation: "per_attempt" | "after_two" | "none" }

export function buildRoster(config: ApiConfig, opts?: { catalog?: CatalogEntry[] }): RosterModel[];
interface RosterModel extends ModelInfo { tier: 1|2|3; capabilities: Capability[]; inputUsdPerMTok: number | null; outputUsdPerMTok: number | null;
                                          catalogMatched: boolean }

export function selectModel(req: RouteRequest, roster: RosterModel[], opts?: { policy?: typeof DEFAULT_POLICY;
                            overrides?: ApiConfig["routing"]["overrides"]; preferVendorDiversity?: boolean }): RouteDecision;
interface RouteRequest {
  role: RoleName;
  difficulty?: "easy" | "medium" | "hard";     // from the work item; builder only
  attempt?: number;                            // 1-based; failed attempts escalate
  needs?: Capability[];                        // extra requirements, e.g. ["vision"]
  avoidModels?: ModelRef[];                    // e.g. tester avoids the builder's model
  avoidVendors?: string[];                     // soft: used when preferVendorDiversity
  budgetRemainingUsd?: number | null;          // when low, prefer cheaper within the allowed tier range
  suggested?: ModelRef | null;                 // the planner's choice for this work item (builder only). Used on attempt 1 when it is
                                               // in the roster, has every required capability and is not avoided; escalation on later
                                               // attempts starts from its tier. Invalid → ignored, and the reason says why.
}
interface RouteDecision {
  model: ModelRef; tier: 1|2|3; rule: string;  // rule id, e.g. "builder.escalate.attempt2", "builder.planner_suggested"
  suggested: boolean;                          // true when the planner's suggestion was used
  reason: string;                              // one plain-English line for the UI, e.g. "Attempt 2 failed tests, escalated coder from tier 1 to tier 2 (claude-sonnet-5-5)"
  escalated: boolean; pinned: boolean;
  fallbacks: ModelRef[];                       // next choices if the call fails with a non-retryable provider error
}
export class RouterError extends Error { code: "no_models" | "no_match" }

export function describeRouting(roster: RosterModel[], opts?: { overrides?: object; preferVendorDiversity?: boolean }):
  { role: RoleName; model: ModelRef | null; tier: number | null; reason: string; pinned: boolean }[];   // for the Setup → Routing table
```

Pure and deterministic: same input → same output. No I/O.

---

## 3. `harness/roles/index.mjs` (workstream 03)

Every role has the same call shape and returns one artifact that has already passed `validateJson` against its schema (one repair retry with the validation errors fed back; then throw `RoleError("invalid_output")`).

```ts
export const intake:     Role<{ wish: string }, Brief>;
export const researcher: Role<{ brief: Brief }, Research>;
export const planner:    Role<{ brief: Brief; research: Research; roster: RosterSummary[];
                                revision?: { previous: Spec; review: PlanReview } | { previous: Spec; replanReason: string } }, Spec>;
  // RosterSummary = { ref, label, tier, capabilities, inputUsdPerMTok, outputUsdPerMTok }: the models actually configured.
  // The planner picks WorkItem.suggestedModel only from this list; the router validates it in code.
export const reviewer: {
  reviewPlan:  Role<{ brief: Brief; research: Research; spec: Spec; planCheck: FactCheck | null }, PlanReview>;
  reviewFinal: Role<{ brief: Brief; spec: Spec; testReport: TestReport; fileList: string[]; readmeExcerpt: string | null }, FinalReview>;
};
export const reflector:  Role<{ spec: Spec; item: WorkItem; attempt: number; build: BuildResult; testReport: TestReport;
                                progress: string; best: { commit: string; score: number } | null }, Reflection>;
export const reporter:   Role<{ wish: string; brief: Brief; spec: Spec; finalReport: TestReport; finalReview: FinalReview; factCheck: FactCheck | null;
                                status: RunStatus; spend: { usd: number | null; minutes: number }; fileList: string[] }, string>;  // Markdown

export const SCHEMAS: { brief: object; research: object; spec: object; planReview: object; finalReview: object; reflection: object };

type Role<I, O> = { name: RoleName; run(input: I, ctx: RoleContext): Promise<O> };

interface RoleContext {
  llm(req: Omit<CompletionRequest, "model">): Promise<CompletionResult>;   // engine binds the routed model, logs events, enforces budget
  search: SearchClient["search"] | null;    // non-null ONLY for intake, researcher, planner
  note(text: string): void;                 // short public progress note → harness.note event
  signal: AbortSignal;
  now(): string;                            // ISO time (injectable for tests)
}
export class RoleError extends Error { code: "invalid_output" | "refusal" | "no_search" }
```

---

## 4. `harness/workers/sandbox/index.mjs` (workstream 04)

```ts
export async function createWorkspace(opts: { dir: string }): Promise<Workspace>;   // creates dir if needed; runs `git init` if not a repo
export async function openWorkspace(opts: { dir: string }): Promise<Workspace>;      // existing workspace

interface Workspace {
  dir: string;                                              // absolute, real path
  resolvePath(rel: string): string;                         // throws SandboxError("path_escape") for absolute paths, "..", links outside, .git/
  readFile(rel: string, opts?: { maxBytes?: number }): Promise<string>;         // default 200 KB, utf-8
  writeFile(rel: string, content: string): Promise<{ bytes: number }>;          // creates folders; max 1 MB
  editFile(rel: string, oldText: string, newText: string): Promise<void>;       // oldText must occur exactly once
  listFiles(opts?: { maxEntries?: number }): Promise<string[]>;                 // relative POSIX paths; skips .git and node_modules
  exec(cmd: "node", args: string[], opts?: { timeoutMs?: number; input?: string; env?: Record<string,string>; signal?: AbortSignal;
                                              readOnlyPaths?: string[] }):   // harness-trusted absolute dirs added as extra --allow-fs-read
                                                                              // (never derived from model output); used for frozen acceptance copies
    Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; durationMs: number }>;
    // no shell; cwd = workspace; scrubbed env (no keys); output truncated to the last 20 KB each; default timeout 60 s.
    // OS boundary: always runs `node --permission --allow-fs-read=<ws> --allow-fs-write=<ws> ...` (see "Sandbox boundary" below).
    // Settles ONLY after the whole process tree has exited, including on timeout and abort.
  startProcess(cmd: "node", args: string[], opts: { port: number; readyPath?: string; timeoutMs?: number; signal?: AbortSignal; readOnlyPaths?: string[] }):
    Promise<{ url: string; stop(): Promise<void> }>;        // same permission flags; waits until http://127.0.0.1:<port><readyPath> answers;
                                                            // stop() and abort resolve only after the process tree has exited
  git: {
    commit(message: string): Promise<string | null>;        // stages everything; returns new sha or null when nothing changed
    head(): Promise<string | null>;
    resetHard(sha: string): Promise<void>;
    tag(name: string, sha?: string): Promise<void>;
    changedFiles(fromSha: string, toSha?: string): Promise<string[]>;
    treeHash(path: string): Promise<string | null>;         // git hash of a subtree, used for the acceptance tamper check
    restorePath(sha: string, path: string): Promise<void>;  // `git checkout <sha> -- <path>` then commit "restore <path>"; used to undo tampering
  };
}

export const SANDBOX_TOOLS: ToolSpec[];   // read_file, write_file, edit_file, list_files, run_command
export async function executeTool(ws: Workspace, name: string, input: object, opts?: { readOnly?: boolean; denyPaths?: string[]; signal?: AbortSignal }): Promise<string>;
  // The ONLY way models touch the workspace. Returns a short text result (errors as "ERROR <code>: <message>", never throws for tool misuse).
  // readOnly / denyPaths are TOOL-LEVEL guards on write_file and edit_file only (builder: denyPaths ["acceptance/"]).
  // They are not an OS boundary: code run through run_command can still write anywhere inside the workspace. See below.
  // Resolves only after any process it started has exited.
export async function sandboxSupport(): Promise<{ ok: boolean; flag: "--permission" | "--experimental-permission" | null;
                                                  testIsolationFlag: "--test-isolation=none" | "--experimental-test-isolation=none" | null; detail: string }>;
  // Probes the local Node once (cached). The engine refuses to start a run when ok is false (fail closed).
  // testIsolationFlag: `node --test` spawns child processes, which the sandbox denies; when args contain "--test" the sandbox inserts
  // this flag (Node 22.23 on this machine: only "--experimental-test-isolation=none" works; "--test-isolation=none" is "bad option").
  // If it is null, "--test" commands are refused with command_not_allowed. Never grant --allow-child-process to make tests run.
export class SandboxError extends Error { code: "path_escape" | "too_large" | "not_found" | "not_unique" | "command_not_allowed" | "timeout" | "cancelled" | "git_failed" | "sandbox_unavailable" }
```

### Sandbox boundary (what is and is not guaranteed)

| Threat | Guarantee | Mechanism |
|---|---|---|
| Model-run code reads keys (`apiConfig.json`, `.env`) or other files outside the workspace | **Blocked by the OS-level Node permission model** | Every child is `node --permission --allow-fs-read=<real workspace path> --allow-fs-write=<real workspace path>`; verified on this machine (Node 22.23.1, Windows): reads and writes outside return `ERR_ACCESS_DENIED` |
| Keys in environment variables | Blocked | scrubbed environment (allow-list only) |
| Model-run code spawns an unsandboxed process or worker | Blocked | no `--allow-child-process`, no `--allow-worker` |
| Model-run code edits the acceptance tests **while they run** | **Blocked** (room #305; verified on Node 22.23: a write to the frozen copy gets `ERR_ACCESS_DENIED`) | the tester runs acceptance scripts from a **frozen copy outside the workspace** (`<runDir>/acceptance-frozen/NNN/`, extracted from the scaffold commit), passed as `readOnlyPaths`; the workspace stays the only writable path |
| Model-run code edits `acceptance/` inside the workspace between runs | **Detected and undone** (not prevented) | tree-hash check before every run → all results fail + restore from the scaffold commit. A hash check alone only proves the final bytes, which is why execution uses the frozen copy above |
| Network access | **Not restricted** (products may call key-less public APIs) | documented limitation |
| CPU and memory | Bounded only by timeouts | documented limitation |
| Python | **Not supported this sprint** (no equivalent OS boundary here) | `cmd` must be `node`; `python` returns `command_not_allowed` |

Cancellation: every call that starts a process accepts `signal`. On abort the sandbox kills the process tree (Windows: `taskkill /pid <pid> /T /F`; POSIX: kill the process group) and resolves with `cancelled: true` **only after the processes have exited**. Callers (builder, tester, engine) must await these settlements before any `git` operation, `resetHard`, writing a terminal run status or closing the event log.

## 5. `harness/workers/builder/index.mjs` (workstream 04)

```ts
export async function buildItem(opts: {
  spec: Spec; item: WorkItem; attempt: number;
  fixInstructions: string | null;           // from the reflector on retries
  progress: string;                         // progress.md content (latest ~4 KB)
  workspace: Workspace;
  llm: RoleContext["llm"];                  // routed coding model
  maxTurns?: number;                        // default 30
  signal: AbortSignal;
  onTool?: (e: { phase: "call" | "result"; name: string; summary: string; status?: "ok" | "error"; durationMs?: number }) => void;
}): Promise<BuildResult>;

interface BuildResult {
  status: "done" | "gave_up" | "max_turns" | "error";
  summary: string;                          // builder's own short account (not evidence)
  commit: string | null;                    // sha of "W2 attempt 1: <summary>" or null when nothing changed
  filesChanged: string[];
  turns: number; toolCalls: number;
  error?: { code: string; message: string };
}
```

## 6. `harness/workers/tester/index.mjs` (workstream 05)

```ts
export async function materializeAcceptance(opts: { spec: Spec; workspace: Workspace; llm: RoleContext["llm"]; signal: AbortSignal }):
  Promise<{ files: string[]; commit: string | null; acceptanceTree: string | null }>;
  // Writes workspace/acceptance/** test scripts for every check with type "command" and generate:true, commits "scaffold: acceptance tests".
  // The returned commit is the scaffold commit used to restore acceptance/ after tampering.

export async function runChecks(opts: {
  spec: Spec; workspace: Workspace;
  scope: { kind: "item"; itemId: string; includeRegression: boolean } | { kind: "all" };
  judge: RoleContext["llm"] | null;         // routed tester model, never the builder's; null → llm_judge checks are "skipped"
  vision?: RoleContext["llm"] | null;       // optional, for "visual" checks
  acceptanceTree: string | null;            // expected tree hash from materializeAcceptance; mismatch → tamper failure
  acceptanceCommit: string | null;          // scaffold commit; on tamper the tester restores acceptance/ from it after reporting
  signal: AbortSignal;                      // passed to every exec/startProcess; resolves only after all started processes exited
}): Promise<TestReport>;
```

---

## 7. `harness/engine/index.mjs` (workstream 06)

```ts
export function startRun(opts: {
  wish: string;
  config: ApiConfig;
  overrides?: { budget?: Partial<ApiConfig["budget"]>; autonomy?: "full" | "confirm_plan" };
  dataDir?: string;                         // default "<repo root>/data"
  deps?: Partial<EngineDeps>;               // tests inject fakes; defaults wire the real modules
}): RunHandle;

interface RunHandle {
  runId: string;                            // "hr-20261115-013012-a1b2"
  done: Promise<RunSummary>;
  cancel(reason?: string): void;            // aborts; `done` resolves "cancelled" only after every in-flight model call, tool and process has settled
  confirmPlan(): boolean;                   // only meaningful in confirm_plan mode while awaiting_confirmation
}
interface RunSummary { runId: string; status: RunStatus; finalScore: number | null; spentUsd: number | null; minutes: number;
                       reportPath: string | null; workspaceDir: string; previewPath: string | null }
type RunStatus = "delivered" | "partial" | "failed" | "cancelled";

export async function listRuns(opts?: { dataDir?: string }): Promise<RunState[]>;           // newest first, from state.json files
export async function readRun(runId: string, opts?: { dataDir?: string }): Promise<RunState | null>;
export const RUN_ID_PATTERN: RegExp;                                                         // /^hr-\d{8}-\d{6}-[a-z0-9]{4}$/

interface EngineDeps {
  modelClient: ModelClient; searchClient: SearchClient;
  router: { buildRoster: typeof buildRoster; selectModel: typeof selectModel };
  roles: typeof import("../roles/index.mjs");
  sandbox: typeof import("../workers/sandbox/index.mjs");
  builder: { buildItem: typeof buildItem };
  tester: { materializeAcceptance: typeof materializeAcceptance; runChecks: typeof runChecks };
  createEventLog: typeof import("../../packages/event-log/index.mjs").createEventLog;
  now(): number;
}
```

`RunState` is the `state.json` format in [artifacts.md](artifacts.md).

CLI (`harness/bin/shallowsee.mjs`): `run "<wish>" [--budget-usd N] [--minutes N] [--autonomy full|confirm_plan]`, `runs`, `config check`. Exit code 0 for delivered, 1 for partial or failed, 2 for usage errors.

---

## 8. `harness/console/server/index.mjs` (workstream 07)

```ts
export function createConsoleServer(opts?: { port?: number; previewPort?: number; host?: "127.0.0.1"; configPath?: string; dataDir?: string;
                                             webDir?: string; engine?: typeof import("../../engine/index.mjs") }):
  { listen(): Promise<{ url: string; previewUrl: string }>; close(): Promise<void> };
```

Run with `node harness/console/server/index.mjs` → control UI and API on `http://127.0.0.1:4320`, product preview on the separate origin `http://127.0.0.1:4321`. Endpoints: [http-api.md](http-api.md).

## 10. `harness/skills/index.mjs` — built-in skills (workstream 10, owner: Lynx's Sol; task authorised by Lynx in room #254)

A skill is a reusable capability the engine can invoke inside a phase, with the same permission discipline as roles. The first one is **Shelf Life** (stale-fact audit of a Markdown document, reusing `packages/shelf-life`).

```ts
export const SKILLS: Record<string, Skill>;          // { "shelf-life": shelfLife }

interface Skill<I = unknown, O = unknown> {
  id: string;                                        // "shelf-life"
  name: string; description: string;                // shown in the UI and usable in prompts
  version: string;                                   // e.g. "1.0.0"
  needs: { search: boolean; llm: boolean };
  allowedPhases: string[];                           // shelf-life: ["plan_check", "fact_check"]
  inputSchema: object; outputSchema: object;         // JSON Schema (validateJson subset)
  run(input: I, ctx: SkillContext): Promise<O>;
}

interface SkillContext {
  llm: RoleContext["llm"];                           // routed by the engine (role "researcher", purpose "plan_check" | "fact_check")
  search: SearchClient["search"] | null;             // injected only when the skill declares needs.search
  providerIdentity: { provider: string; model: ModelRef };   // trusted, from the engine's routing; recorded in the skill's events.
                                                     // ctx.llm is PINNED to exactly this model: no provider fallback inside one skill call
                                                     // (room #292). On a non-retryable failure the engine may rerun the whole skill once with
                                                     // the next fallback model, in a NEW unique child room with the new providerIdentity.
  childRoom: { rootDir: string; roomId: string; parentRoomId: string };
                                                     // the skill writes its OWN event log here; roomId is UNIQUE per invocation:
                                                     // "<runId>-sl-01", "<runId>-sl-02", ... (event logs cannot be reopened),
                                                     // e.g. via packages/shelf-life runDirect; never into the parent run's log
  note(text: string): void;
  signal: AbortSignal;                               // checked before every model/search call and after each one settles
  now(): string;
}
```

**Invocation rules (engine-enforced):** skills are **never exposed as model-callable tools**. Only the engine invokes a skill, only in a phase listed in `allowedPhases`, and it records the executing role (`researcher`, which has search permission) in `harness.skill.started`. No model output can choose a skill, its role, keys or a publisher. A skill gets no `apiConfig`, no environment, no path outside the document text it is given.

### Shelf Life skill I/O

```ts
type ShelfLifeInput = { doc: { label: string; markdown: string };   // label = workspace-relative path, e.g. "README.md"; ≤ 48,000 bytes
                        maxClaims?: number };                        // 1–12, default 4
type ShelfLifeOutput = FactCheck;                                    // artifacts.md "fact-check.json"
```

Rules: no publisher, git push, PR or file write inside a run, other than the skill's own child-room event log (the patch is returned as text for review only); no keys in input or output; search queries contain only the extracted public facts; `reviewStatus` is always `"unreviewed"` (a person, not a model, accepts corrections); provider charges are recorded as `null` unless measured. If `search` is null the skill returns `{ status: "skipped", reason: "no search provider" }` without calling the model.

## 9. `harness/console/web/` (workstream 08)

Static files served by the console server at `/`: `index.html`, `app.js`, `styles.css`, `model.mjs` (pure event → view-state functions with node tests). No exports consumed by other workstreams.
