# Shelf Life workbench

The workbench consumes the [v1 event contract](CONTRACT.md). It is a read-only view of the producer's log; it does not own the Shelf Life workflow, make model calls or create pull requests.

## Start

Run from the repository root with Node.js 20 or later:

```sh
node apps/server/index.mjs
```

The default address is `http://127.0.0.1:4318`. No package installation or provider account is needed to inspect the bundled synthetic sample.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4318` | Local listening port |
| `SHELF_LIFE_ROOMS_DIR` | `data/rooms` relative to the working directory | Real workflow log root |
| `SHELF_LIFE_SAMPLE_FILE` | `samples/shelf-life-room.sample.jsonl` | Optional synthetic example |
| `SHELF_LIFE_PUBLIC_DIR` | `apps/web` next to `apps/server` | Static UI assets |

The server listens on loopback. It checks local Host and Origin headers and serves an allowlist of UI assets. It does not expose arbitrary file paths or an endpoint for running commands.

## Views and provenance

- **Run timeline:** groups output by execution, with tool activity and the distinction between an ended run and accepted task evidence.
- **Findings:** extracted statements, final `fresh` / `stale` / `unsure` verdicts, corrections, sources and recorded checks. The interface shows the producer's conclusions; it does not independently prove that those conclusions are true.
- **Reliability:** observed checks, retries, review revisions and available usage. Missing usage remains unknown. A subtotal is not presented as a complete bill.

`synthetic: true` in `room.created` and the registered sample identify generated demonstrations. Replay is transport metadata. `driver: direct` indicates a standalone workflow producer; `driver: harness` indicates the recorded use of the harness. These labels remain visible, so replay and direct runs cannot be mistaken for evidence of orchestration.

Different source domains alone do not prove editorial independence. Likewise, a value appearing in a snippet does not independently establish support for an entire correction. The workbench displays these as recorded checks and preserves `unsure` cases for review.

## Producer integration

Write one UTF-8 JSON envelope per line to:

```text
data/rooms/<roomId>/events.jsonl
```

Use `schemaVersion: 1`, a globally unique `eventId`, and a contiguous per-room `seq` starting at 1. Start with `room.created`. Flush a complete record, including its newline, before treating it as available to readers. The workbench never edits, repairs or truncates the file.

The server waits for an incomplete final record to finish and reports that it was not displayed. Malformed committed records, conflicting IDs or changed committed content are reported as log errors. A damaged optional sample must not prevent reading an otherwise valid real workflow log.

## HTTP and streaming

| Method and path | Response |
| --- | --- |
| `GET /api/health` | Local service status and read-only flag |
| `GET /api/rooms` | `{ rooms, warnings }` |
| `GET /api/rooms/:roomId/events?after=0&limit=1000` | `{ events, nextAfter, hasMore, room, warnings }` |
| `GET /api/rooms/:roomId/stream?after=0` | Server-sent events after the cursor |

Pagination limits range from 1 to 5,000. `after` is the per-room sequence, not an offset into a task or run. `Last-Event-ID` is supported for streaming reconnection. A cursor ahead of the log produces an explicit conflict; clients should reload that room rather than silently discard its history.

SSE messages:

| Event | Meaning |
| --- | --- |
| `stream-info` | Transport mode, room, synthetic flag and recorded driver |
| `room-event` | One contract envelope; SSE ID is its `seq` |
| `stream-warning` | Current log warnings |
| `stream-error` | Log reading stopped with a reported error |
| `stream-end` | Finite replay completed; close the subscription |

Clients deduplicate by the per-room cursor, close the previous subscription when switching rooms, and display connection errors. A requested replay can use `mode=replay`; the registered sample is always replay. For a replay, clients must handle `stream-end` rather than continuously reconnecting to the completed stream.

## Validation and limits

The initial delivery passed 12 server tests and 11 UI projection tests on Node.js 24.19.0. Server tests cover cursor pagination, appended events and reconnection, immutable committed content, incomplete tails, corrupted logs, sample isolation and path/origin restrictions. UI tests cover acceptance revocation, malformed evidence, unknown-field isolation, usage and safe links.

Browser verification covered the timeline, findings, source-check expansion and reliability views at narrow and desktop widths, with no observed horizontal overflow or console errors. A separately labeled synthetic QA log was appended from sequence 20 to 81; the open page updated without reloading. The QA log was then removed from runtime discovery and preserved in the local work area. This validates transport and display behavior, not a real model/search workflow.

This initial implementation bounds each log to 32 MiB and caches a limited number of parsed files. It is intended for local hackathon runs. It does not implement authenticated remote hosting, a workflow queue, a task scheduler, or an audit-start endpoint.
