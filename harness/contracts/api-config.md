# Contract: `apiConfig.json`

All API keys and model settings live in one local file, **`apiConfig.json` at the repository root**. It is ignored by git. The committed template is [`apiConfig.example.json`](../../apiConfig.example.json). Environment variable `SHALLOWSEE_API_CONFIG` may point to another path (used by tests).

People set it up the way CC Switch works: open the console's **Setup** page → **Add provider** → pick a preset → paste the API key → (optionally) adjust the base URL and models → **Test connection** → **Add**. Editing the JSON by hand is also supported.

## Shape

```ts
interface ApiConfig {
  version: 1;
  providers: ProviderEntry[];
  routing: {
    autonomy: "full" | "confirm_plan";            // default "full"
    overrides: Partial<Record<RoleName, ModelRef>>; // user pins, e.g. { "planner": "anthropic/claude-opus-5-5" }
    preferVendorDiversity: boolean;               // default true: tester prefers a different vendor from the builder
  };
  budget: {
    maxUsdPerRun: number;        // default 5
    maxMinutesPerRun: number;    // default 40
    maxBuildIterations: number;  // default 12 (total build attempts across all items)
  };
}

interface ProviderEntry {
  id: string;                // unique slug [a-z0-9-]{1,40}; part of ModelRef
  name: string;              // display name, e.g. "Anthropic (official)"
  preset: PresetId | "custom";
  kind: "anthropic" | "openai_compatible" | "linkup" | "github";
  enabled: boolean;
  notes: string;             // free text ("company account")
  website: string;           // optional link shown in the UI ("" if none)
  baseUrl: string;           // request address, no trailing slash
  apiKey: string;            // "" when not set. NEVER leaves the server process.
  headers: Record<string, string>;  // extra request headers (rare; treated as secret like apiKey)
  models: ModelEntry[];      // empty for linkup/github
}

interface ModelEntry {
  id: string;                // provider's model id, e.g. "claude-opus-5-5"
  label?: string;
  enabled: boolean;
  // Optional overrides; when absent the router's catalog fills them in.
  tier?: 1 | 2 | 3;
  capabilities?: Capability[];
  inputUsdPerMTok?: number | null;
  outputUsdPerMTok?: number | null;
}

type Capability = "reasoning" | "coding" | "vision" | "tools" | "json" | "long_context";
type RoleName = "intake" | "researcher" | "planner" | "reviewer" | "builder" | "tester" | "reflector" | "reporter" | "vision";
type ModelRef = `${string}/${string}`;   // "<providerId>/<modelId>"; split on the FIRST "/"
```

## Presets

Owned and implemented by workstream 01 (`providers/presets.mjs`), shown by the UI as chips at the top of **Add provider**. Picking a preset fills `name`, `kind`, `baseUrl`, `website` and suggested models; the user only has to paste the key.

| `preset` | `kind` | Default `baseUrl` | Suggested models |
|---|---|---|---|
| `anthropic` | anthropic | `https://api.anthropic.com` | `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` |
| `openai` | openai_compatible | `https://api.openai.com/v1` | none; use **Fetch models** |
| `deepseek` | openai_compatible | `https://api.deepseek.com` | none; use **Fetch models** |
| `gemini` | openai_compatible | `https://generativelanguage.googleapis.com/v1beta/openai` | none; use **Fetch models** |
| `openrouter` | openai_compatible | `https://openrouter.ai/api/v1` | none; use **Fetch models** |
| `ollama` | openai_compatible | `http://127.0.0.1:11434/v1` (no key needed) | none; use **Fetch models** |
| `custom` | openai_compatible | user-entered | user-entered |
| `linkup` | linkup | `https://api.linkup.so/v1` | — |
| `github` | github | `https://api.github.com` | — (optional; nothing in a run pushes) |

Only the Anthropic model ids are pre-filled, because they are the only ones verified for this project. Every other provider's models come from its live `GET {baseUrl}/models` listing (**Fetch models**) or are typed in by the user. Never hard-code unverified model ids.

## Key-handling rules (all workstreams)

1. Keys and `headers` values are read only by `providers/` inside the server or CLI process.
2. Anything that leaves that process (HTTP responses, events, logs, errors, test reports, UI) uses the **redacted view**: `apiKey` replaced by `{ hasKey: boolean, preview: "sk-…ab12" | "" }` (first 3 and last 4 characters, only when the key is at least 12 characters long; otherwise `"set"`), and header values replaced by `"•••"`.
3. Updates: a missing `apiKey` field means **keep the stored key**; `null` means **clear it**; a string replaces it. The same applies to `headers`.
4. Writes are atomic (write a temp file in the same folder, then rename). Pretty-printed JSON, 2-space indent, trailing newline.
5. Error messages from providers are passed through `redact()`, which removes the configured keys, `Bearer …` tokens and anything matching `sk-[A-Za-z0-9_-]{8,}`.
6. The sandbox's child processes never inherit keys (see `workers/sandbox`).

## Validation rules (`validateApiConfig`)

- `version === 1`; provider `id`s unique and matching `[a-z0-9-]{1,40}`; `kind` and `preset` from the lists above.
- `baseUrl` is `https://…`, or `http://` only for `127.0.0.1` / `localhost`.
- Model ids unique within a provider; `tier` ∈ {1,2,3} when present.
- `routing.overrides` values are `ModelRef`s that resolve to an enabled model, otherwise a **warning** (not an error), so a half-configured file still loads.
- Returns `{ ok, errors: [{ path, message }], warnings: [{ path, message }] }`. Never throws for validation problems.

## Migration note

The local, never-committed `config.yaml` from the previous session is superseded. Keys in `.env` are still read by the older `packages/shelf-life` code only. The harness reads `apiConfig.json` alone.
