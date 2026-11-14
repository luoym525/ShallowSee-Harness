# Shelf Life direct audit

The direct runner reads one public Markdown file, extracts time-sensitive claims, searches Linkup and proposes narrow corrections. It writes a v1 event log that the workbench can display. By default it leaves the original file untouched and places the audit in review. With `--open-pr` it also publishes the validated patch as a new branch and a pull request for a person to approve. It never merges anything.

Node.js 20 or later; no packages need installation. Git is used only by tests that check patch compatibility.

## Try it offline

    node packages/shelf-life/cli.mjs --synthetic
    node apps/server/index.mjs

Open the workbench at http://127.0.0.1:4318 and select the new audit room. This fixture writes a new log through the real writer; the extracted claims and search responses are fictional. The room is marked synthetic and direct, and does not evidence real searches or a multi-agent scheduler.

## Run on a public document

Use `ANTHROPIC_API_KEY`, `SHELFLIFE_ANTHROPIC_MODEL` (a model available to your account with structured-output support), and `LINKUP_API_KEY` in your environment. Do not include keys in the command or write them into a log. The driver sends the selected document text to Anthropic and the extracted public fact queries to Linkup; use only a document meant for those providers.

    node packages/shelf-life/cli.mjs --doc-label handbook/developer-tooling.md handbook/developer-tooling.md

To use a local untracked `.env` on Node.js 20.6 or later, invoke `node --env-file=.env` before the script path. The CLI limits the input to 48,000 bytes and defaults to at most four extracted claims. Select a different cap with `--max-claims` (1–12) and a new room with `--room-id`. Each claim uses one initial search and one corroboration search, plus a single reworded retry when the verdict is unresolved. Calls are bounded by a request timeout and an overall time budget. Provider charges are not inferred. Provider integrations should be verified with your own small live audit; the automated tests do not use accounts or incur search charges.

The JSON report contains the path of the new event log, any proposed unified diff and, with `--open-pr`, a `publication` entry (branch, commit and pull request address). `--rooms-dir` overrides the default `data/rooms`. The workbench uses `SHELF_LIFE_ROOMS_DIR` to read a non-default directory. The report may end with open `unsure` claims. A completed driver process does not certify that any proposed correction is true or accepted.

Each provider response is limited to 1 MiB of body bytes delivered by Fetch, after any HTTP decompression. An oversized response is cancelled and logged as a provider error without its contents.

## Open a pull request

Add `--open-pr` to publish the validated patch for review:

    node --env-file=.env packages/shelf-life/cli.mjs --open-pr --max-claims 8 --doc-label handbook/developer-tooling.md handbook/developer-tooling.md

The publisher works on the Git checkout in the current directory, or the one named by `--repo-dir`. It fetches the base branch `main`, checks that the audited file is byte for byte the file on that branch, builds one commit with a temporary index, and pushes it to a new branch named `shelf-life/<page>-<room>`. It does not check out, switch, stage or change anything in your working tree. It never pushes to `main` and never forces.

With `GITHUB_TOKEN` set to a token that may open pull requests on the repository, it then opens a pull request whose description lists each change with its sources. `SHELFLIFE_HANDBOOK_REPO=owner/name` selects the repository; without it, the `origin` remote decides. Without a token only the branch is pushed, and the report gives a compare link so a person can open the pull request by hand.

The log records `shelflife.pr.opened` only when GitHub returned a pull request number. A branch without a pull request is registered as a patch. If the audited file differs from the base branch, nothing is pushed. `--open-pr` cannot be combined with `--synthetic`. A pull request is a proposal: the task stays in review until a person accepts it.

This path is tested against a local Git remote and a simulated GitHub API. It has not yet been run against GitHub itself.

## Review an edit

Each proposed stale correction replaces one exact value in a plain Markdown line. Two separate queries must each supply a selected excerpt containing the proposed value. The excerpts must differ and come from distinct sites. Human review establishes editorial independence, and whether the excerpts support the same claim, scope, date and units. Ambiguous or overlapping edits stay unresolved.

A validated diff uses zero lines of context to show the exact intended edits. Before applying it, compare the checkout's file hash with the report's `documentSha256` and inspect the proposed edits. For an independent mechanical check (no edit), save the report's decoded `diff` value and use `git apply --check --unidiff-zero reviewed.diff` from the audited checkout. Verify source dates, original publishers, accepted wording, and final patch scope before recording a human review.

Primary API references: [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Linkup Search](https://docs.linkup.so/pages/documentation/endpoints/search/overview).
