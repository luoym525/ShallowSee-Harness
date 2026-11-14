# Shelf Life direct audit

> Current Harness role: Shelf Life is a [research and freshness skill](../skills/shelf-life/SKILL.md) for planning and project management. This page describes the existing Markdown claim-audit CLI, which is a reusable implementation starting point. It does not yet implement industry-solution comparison, plan-version reports or skill dispatch; see [the target architecture](WISH-CODING.md).

The direct runner reads one public Markdown file, extracts time-sensitive claims, searches Linkup and proposes narrow corrections. It writes a v1 event log that the workbench can display. It leaves the original file untouched and places the audit in review. It does not apply patches or open pull requests.

Node.js 20 or later; no packages need installation. Git is used only by tests that check patch compatibility.

## Try it offline

    node packages/shelf-life/cli.mjs --synthetic
    node apps/server/index.mjs

Open the workbench at http://127.0.0.1:4318 and select the new audit room. This fixture writes a new log through the real writer; the extracted claims and search responses are fictional. The room is marked synthetic and direct, and does not evidence real searches or a multi-agent scheduler.

## Run on a public document

Use `ANTHROPIC_API_KEY`, `SHELFLIFE_ANTHROPIC_MODEL` (a model available to your account with structured-output support), and `LINKUP_API_KEY` in your environment. Do not include keys in the command or write them into a log. The driver sends the selected document text to Anthropic and the extracted public fact queries to Linkup; use only a document meant for those providers.

    node packages/shelf-life/cli.mjs --doc-label handbook/developer-tooling.md handbook/developer-tooling.md

To use a local untracked `.env` on Node.js 20.6 or later, invoke `node --env-file=.env` before the script path. The CLI limits the input to 48,000 bytes and defaults to at most four extracted claims. Select a different cap with `--max-claims` (1–12) and a new room with `--room-id`. Each claim uses one initial search and one corroboration search, plus a single reworded retry when the verdict is unresolved. Calls are bounded by a request timeout and an overall time budget. Provider charges are not inferred. Provider integrations should be verified with your own small live audit; the automated tests do not use accounts or incur search charges.

The JSON report contains the path of the new event log and any proposed unified diff. `--rooms-dir` overrides the default `data/rooms`. The workbench uses `SHELF_LIFE_ROOMS_DIR` to read a non-default directory. The report may end with open `unsure` claims. A completed driver process does not certify that any proposed correction is true or accepted.

Each provider response is limited to 1 MiB of body bytes delivered by Fetch, after any HTTP decompression. An oversized response is cancelled and logged as a provider error without its contents.

## Review an edit

Each proposed stale correction replaces one exact value in a plain Markdown line. Two separate queries must each supply a selected excerpt containing the proposed value. The excerpts must differ and come from distinct sites. Human review establishes editorial independence, and whether the excerpts support the same claim, scope, date and units. Ambiguous or overlapping edits stay unresolved.

A validated diff uses zero lines of context to show the exact intended edits. Before applying it, compare the checkout's file hash with the report's `documentSha256` and inspect the proposed edits. For an independent mechanical check (no edit), save the report's decoded `diff` value and use `git apply --check --unidiff-zero reviewed.diff` from the audited checkout. Verify source dates, original publishers, accepted wording, and final patch scope before recording a human review.

Primary API references: [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Linkup Search](https://docs.linkup.so/pages/documentation/endpoints/search/overview).
