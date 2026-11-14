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
}
interface RouteDecision {
  model: ModelRef; tier: 1|2|3; rule: string;  // rule id, e.g. "builder.escalate.attempt2"
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
export const planner:    Role<{ brief: Brief; research: Research; revision?: { previous: Spec; review: PlanReview } | { previous: Spec; replanReason: string } }, Spec>;
export const reviewer: {
  reviewPlan:  Role<{ brief: Brief; research: Research; spec: Spec }, PlanReview>;
  reviewFinal: Role<{ brief: Brief; spec: Spec; testReport: TestReport; fileList: string[]; readmeExcerpt: string | null }, FinalReview>;
};
export const reflector:  Role<{ spec: Spec; item: WorkItem; attempt: number; build: BuildResult; testReport: TestReport;
                                progress: string; best: { commit: string; score: number } | null }, Reflection>;
export const reporter:   Role<{ wish: string; brief: Brief; spec: Spec; finalReport: TestReport; finalReview: FinalReview;
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
  exec(cmd: "node" | "python", args: string[], opts?: { timeoutMs?: number; input?: string; env?: Record<string,string> }):
    Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }>;
    // no shell; cwd = workspace; scrubbed env (no keys); output truncated to the last 20 KB each; default timeout 60 s
  startProcess(cmd: "node" | "python", args: string[], opts: { port: number; readyPath?: string; timeoutMs?: number }):
    Promise<{ url: string; stop(): Promise<void> }>;        // waits until http://127.0.0.1:<port><readyPath> answers
  git: {
    commit(message: string): Promise<string | null>;        // stages everything; returns new sha or null when nothing changed
    head(): Promise<string | null>;
    resetHard(sha: string): Promise<void>;
    tag(name: string, sha?: string): Promise<void>;
    changedFiles(fromSha: string, toSha?: string): Promise<string[]>;
    treeHash(path: string): Promise<string | null>;         // git hash of a subtree, used for the acceptance tamper check
  };
}

export const SANDBOX_TOOLS: ToolSpec[];   // read_file, write_file, edit_file, list_files, run_command
export async function executeTool(ws: Workspace, name: string, input: object, opts?: { readOnly?: boolean; denyPaths?: string[] }): Promise<string>;
  // The ONLY way models touch the workspace. Returns a short text result (errors as "ERROR <code>: <message>", never throws for tool misuse).
  // readOnly: write_file/edit_file refused. denyPaths: prefixes the caller may not write (builder: ["acceptance/"]).
export class SandboxError extends Error { code: "path_escape" | "too_large" | "not_found" | "not_unique" | "command_not_allowed" | "timeout" | "git_failed" }
```

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

export async function runChecks(opts: {
  spec: Spec; workspace: Workspace;
  scope: { kind: "item"; itemId: string; includeRegression: boolean } | { kind: "all" };
  judge: RoleContext["llm"] | null;         // routed tester model, never the builder's; null → llm_judge checks are "skipped"
  vision?: RoleContext["llm"] | null;       // optional, for "visual" checks
  acceptanceTree: string | null;            // expected tree hash from materializeAcceptance; mismatch → tamper failure
  signal: AbortSignal;
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
  cancel(reason?: string): void;
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
export function createConsoleServer(opts?: { port?: number; host?: "127.0.0.1"; configPath?: string; dataDir?: string;
                                             webDir?: string; engine?: typeof import("../../engine/index.mjs") }):
  { listen(): Promise<{ url: string }>; close(): Promise<void> };
```

Run with `node harness/console/server/index.mjs` → `http://127.0.0.1:4320`. Endpoints: [http-api.md](http-api.md).

## 9. `harness/console/web/` (workstream 08)

Static files served by the console server at `/`: `index.html`, `app.js`, `styles.css`, `model.mjs` (pure event → view-state functions with node tests). No exports consumed by other workstreams.
