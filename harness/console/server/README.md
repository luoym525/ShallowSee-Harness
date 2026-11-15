# Local console server

Run from the repository root with Node.js 20 or newer.

```sh
node harness/console/server/index.mjs
```

Open `http://127.0.0.1:4320` to set up providers, submit a wish, and watch the run. Product previews open at `http://127.0.0.1:4321`. Both listeners bind to IPv4 loopback. If the web console is absent from the checkout, the control listener serves a placeholder and the API remains available.

Control routes match [the HTTP contract](../../contracts/http-api.md). Provider configuration is saved atomically, with writes queued within the server process. Run history and files come from the engine's data directory. The server can cancel or confirm runs it started. A CLI-started run is visible through state, artifact and event reads.

For tests or embedding, call `createConsoleServer({ port, previewPort, dataDir, configPath, webDir, providers, router, engine })`. `listen()` returns `{ url, previewUrl }` and `close()` ends open streams and releases both listeners. Passing port `0` requests an ephemeral port.

The control server only serves console files. It returns workspace files as bounded plain text and only serves the named run artifacts. The preview listener refuses Git paths, symlinks and traversal, and has no API routes. SSE waits for complete JSON Lines, supports reconnection cursors and closes after `room.closed`.

```sh
node --test "harness/console/server/**/*.test.mjs"
```
