# Providers

Import from `./index.mjs`. Load `apiConfig.json` with `loadApiConfig()` and edit it with `applyProviderInput` and `saveApiConfig`. Use `redactApiConfig` for UI output. `listConfiguredModels` lists enabled models.

Create a model client with `createModelClient({ config })`; call `complete` with a model reference and neutral messages. Create a search client with `createSearchClient({ config })`; check `available` before calling `search`. `validateJson` checks the contract's JSON Schema subset.

`fetchRemoteModels` and `testProvider` make on-demand network requests. All clients accept `fetchImpl` for offline testing. Run tests with `node --test "harness/providers/**/*.test.mjs"`. `node harness/providers/live-check.mjs` is an optional paid live smoke check; it skips unconfigured providers.
