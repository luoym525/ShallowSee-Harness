import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { postJson, ProviderError } from './providers.mjs';

// Publishes an already validated one-line-per-fact patch as a branch and,
// when a token is available, a pull request. It never touches the caller's
// working tree, index or branches: the commit is built with a temporary
// index and pushed by object id. Nothing is merged and nothing is forced.

const GIT_TIMEOUT_MS = 60000;
export const PUBLISH_TIMEOUT_MS = 90000;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REF_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const SHA = /^[0-9a-f]{40}$/;
const DOC_PATH = /^(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)*[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function defaultGit(args, { cwd, env, input, timeoutMs } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile('git', args, {
      cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
      timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'buffer',
    }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
    if (input !== undefined) child.stdin.end(input);
  });
}

const text = buffer => buffer.toString('utf8').trim();
const mdText = s => String(s).replace(/[\\`*_{}\[\]()<>#|!~]/gu, c => '\\' + c).replace(/\s+/gu, ' ').trim().slice(0, 120);
const mdCode = s => '`' + String(s).replace(/[`|\r\n]/gu, ' ').trim().slice(0, 80) + '`';
const mdLink = source => '[' + mdText(source.name || source.domain) + '](<' + String(source.url).replace(/[<>\s]/gu, '') + '>)';

export function repoFromRemote(url) {
  if (typeof url !== 'string') return null;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(url);
  return match && REPO.test(match[1]) && !/\/(?:\.|\.\.)$/u.test(match[1]) ? match[1] : null;
}

// The receiver compares the old object ID sent by Git to the ref's current
// value. A zero old ID therefore makes a concurrent create fail atomically.
const CREATE_ONLY_HOOK = String.raw`#!/bin/sh
set -eu
[ "$2" = "$SHELFLIFE_PUSH_URL" ] || exit 1
IFS=' ' read -r local_ref local_oid remote_ref old_oid extra || exit 1
[ "$local_ref" = "$SHELFLIFE_PUSH_OID" ] || exit 1
[ "$local_oid" = "$SHELFLIFE_PUSH_OID" ] || exit 1
[ "$remote_ref" = "$SHELFLIFE_PUSH_REF" ] || exit 1
[ "$old_oid" = '0000000000000000000000000000000000000000' ] || exit 1
[ -z "$extra" ] || exit 1
tail_line=
if IFS= read -r tail_line || [ -n "$tail_line" ]; then exit 1; fi
if [ -x "$SHELFLIFE_ORIGINAL_HOOK" ]; then
  printf '%s %s %s %s\n' "$local_ref" "$local_oid" "$remote_ref" "$old_oid" | "$SHELFLIFE_ORIGINAL_HOOK" "$SHELFLIFE_REMOTE_NAME" "$2"
fi
`;

function isSameRepo(a, b) {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
}

export function pullRequestText({ doc, roomId, documentSha256, corrections }) {
  const n = corrections.length;
  const title = 'Shelf Life: update ' + n + ' out-of-date value' + (n === 1 ? '' : 's') + ' in ' + doc;
  const rows = corrections.map(c => '| ' + c.line + ' | ' + mdCode(c.oldValue) + ' | ' + mdCode(c.currentValue) + ' | '
    + c.sources.slice(0, 4).map(mdLink).join(', ') + ' |');
  const body = [
    'Shelf Life audited `' + doc + '` against the live web and found ' + n + ' value' + (n === 1 ? '' : 's') + ' that look out of date.',
    '',
    'Each change replaces one value on one line. Before this pull request was opened, code checked that the quoted text is in the document, that two searches each returned a source containing the new value, and that those sources come from different sites.',
    '',
    '**Nothing has been merged.** A person should open the sources, confirm that they are independent and say what the line says, then approve or close this pull request.',
    '',
    '| Line | Was | Now | Sources |',
    '|---|---|---|---|',
    ...rows,
    '',
    'Audit room `' + mdText(roomId) + '` · audited file SHA-256 `' + documentSha256 + '` · direct workflow run',
  ].join('\n');
  return { title, body };
}

export function createGitPublisher({
  repoDir, repo = null, token = null, remote = 'origin', baseBranch = 'main',
  fetchImpl = fetch, git = defaultGit, gitEnv = {},
}) {
  if (typeof repoDir !== 'string' || !repoDir.trim()) throw new Error('Set the checkout directory of the handbook repository.');
  if (!REF_PART.test(remote) || !REF_PART.test(baseBranch)) throw new Error('Remote and base branch names must be simple names.');
  if (typeof repo !== 'string' || !REPO.test(repo) || /\/(?:\.|\.\.)$/u.test(repo)) throw new Error('Set SHELFLIFE_HANDBOOK_REPO as owner/name.');

  return async function publish({ roomId, doc, documentSha256, diff, corrections, timeoutMs = PUBLISH_TIMEOUT_MS, synthetic = false }) {
    if (synthetic) throw new ProviderError('publish_synthetic', 'Synthetic audits cannot publish corrections.');
    if (!Array.isArray(corrections) || corrections.length === 0 || typeof diff !== 'string' || !diff) {
      throw new ProviderError('publish_empty', 'There is no validated correction to publish.');
    }
    if (typeof doc !== 'string' || !DOC_PATH.test(doc) || !SHA256.test(documentSha256 ?? '')) {
      throw new ProviderError('publish_input', 'Publication requires a repository-relative Markdown path and its SHA-256.');
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ProviderError('publish_timeout', 'Publication time limit reached.');
    const deadline = performance.now() + Math.min(PUBLISH_TIMEOUT_MS, timeoutMs);
    function remainingTime() {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining < 1) throw new ProviderError('publish_timeout', 'Publication time limit reached.');
      return remaining;
    }
    function run(args, options = {}) {
      return git(['-c', 'http.followRedirects=false', ...args], {
        cwd: repoDir, ...options, env: { ...gitEnv, ...options.env }, timeoutMs: Math.min(GIT_TIMEOUT_MS, remainingTime()),
      });
    }
    async function checkedRemote() {
      const fetchUrls = text(await run(['remote', 'get-url', '--all', remote])).split(/\r?\n/u);
      const pushUrls = text(await run(['remote', 'get-url', '--push', '--all', remote])).split(/\r?\n/u);
      if (fetchUrls.length !== 1 || pushUrls.length !== 1 || !isSameRepo(repoFromRemote(fetchUrls[0]), repo)
          || !isSameRepo(repoFromRemote(pushUrls[0]), repo)) {
        throw new ProviderError('publish_repo', 'The remote needs exactly one fetch URL and one push URL for the configured GitHub repository.');
      }
      return { fetchUrl: fetchUrls[0], pushUrl: pushUrls[0] };
    }
    const slug = doc.replace(/\.md$/iu, '').replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'page';
    const suffix = String(roomId).replace(/[^A-Za-z0-9]/gu, '').slice(-10) || 'audit';
    const branch = 'shelf-life/' + slug + '-' + suffix;
    const ref = 'refs/heads/' + branch;
    const temp = await mkdtemp(join(tmpdir(), 'shelf-life-publish-'));
    try {
      let baseCommit;
      let urls;
      try {
        urls = await checkedRemote();
        if (text(await run(['ls-remote', '--get-url', urls.fetchUrl])) !== urls.fetchUrl) {
          throw new ProviderError('publish_repo', 'The fetch URL is rewritten to another destination.');
        }
        const advertised = text(await run(['ls-remote', '--refs', urls.fetchUrl, 'refs/heads/' + baseBranch, ref]));
        const refs = new Map(advertised.split(/\r?\n/u).filter(Boolean).map(line => line.split('\t').reverse()));
        if (refs.has(ref)) throw new ProviderError('publish_branch_exists', 'The destination branch already exists. Use a new room ID.');
        baseCommit = refs.get('refs/heads/' + baseBranch);
        if (!SHA.test(baseCommit ?? '')) throw new ProviderError('publish_git', 'The base branch did not resolve to a commit.');
        await run(['fetch', '--quiet', '--no-tags', '--recurse-submodules=no', '--no-write-fetch-head', urls.fetchUrl, 'refs/heads/' + baseBranch]);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('publish_git', 'Could not read the base branch of the handbook repository.', true);
      }

      let published;
      try { published = await run(['show', baseCommit + ':' + doc]); }
      catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('publish_base_mismatch', 'The audited file does not exist on the base branch.');
      }
      if (createHash('sha256').update(published).digest('hex') !== documentSha256) {
        throw new ProviderError('publish_base_mismatch', 'The audited file differs from the base branch, so the patch was not published.');
      }

      const env = { GIT_INDEX_FILE: join(temp, 'index') };
      const diffPath = join(temp, 'audit.diff');
      const { title, body } = pullRequestText({ doc, roomId, documentSha256, corrections });
      let commit;
      try {
        await writeFile(diffPath, diff);
        await run(['read-tree', baseCommit], { env });
        await run(['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', diffPath], { env });
        const changed = await run(['diff', '--cached', '--name-only', '-z', baseCommit, '--'], { env });
        if (!Buffer.from(changed).equals(Buffer.from(doc + '\0'))) {
          throw new ProviderError('publish_apply', 'The patch must change only the audited file.');
        }
        const tree = text(await run(['write-tree'], { env }));
        const message = title + '\n\n' + corrections.map(c => 'Line ' + c.line + ': ' + c.oldValue + ' -> ' + c.currentValue).join('\n')
          + '\n\nProposed by a Shelf Life audit (room ' + roomId + '). Review the sources in the pull request before merging.\n';
        commit = text(await run(['commit-tree', tree, '-p', baseCommit], { env, input: message }));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('publish_apply', 'The patch did not apply cleanly to the base branch.');
      }
      if (!SHA.test(commit)) throw new ProviderError('publish_git', 'Git did not return a commit for the patch.');

      try {
        if ((await checkedRemote()).pushUrl !== urls.pushUrl) throw new ProviderError('publish_repo', 'The push URL changed during publication.');
        const originalHook = text(await run(['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push']));
        await writeFile(join(temp, 'pre-push'), CREATE_ONLY_HOOK, { mode: 0o700 });
        await run(['-c', 'core.hooksPath=' + temp, '-c', 'push.followTags=false', 'push', '--quiet', '--recurse-submodules=no', urls.pushUrl, commit + ':' + ref], {
          env: { SHELFLIFE_PUSH_URL: urls.pushUrl, SHELFLIFE_PUSH_OID: commit, SHELFLIFE_PUSH_REF: ref, SHELFLIFE_ORIGINAL_HOOK: originalHook, SHELFLIFE_REMOTE_NAME: remote },
        });
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('publish_push', 'Git did not confirm creation of the new branch. Check the remote before retrying.');
      }

      const compareUrl = 'https://github.com/' + repo + '/compare/' + baseBranch + '...' + encodeURIComponent(branch).replace(/%2F/gu, '/') + '?expand=1';
      const result = { repo, branch, commit, baseCommit, compareUrl, number: null, url: null, prError: null };
      if (typeof token !== 'string' || !token.trim()) return result;
      try {
        const raw = await postJson(fetchImpl, 'https://api.github.com/repos/' + repo + '/pulls', {
          Authorization: 'Bearer ' + token.trim(), Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'shelf-life-audit',
        }, { title, head: branch, base: baseBranch, body }, 'github', remainingTime());
        const url = typeof raw?.html_url === 'string' ? raw.html_url : '';
        if (!Number.isSafeInteger(raw?.number) || raw.number < 1 || url.toLowerCase() !== ('https://github.com/' + repo + '/pull/' + raw.number).toLowerCase()) {
          throw new ProviderError('github_output', 'GitHub did not return a pull request.');
        }
        return { ...result, number: raw.number, url };
      } catch (error) {
        return { ...result, prError: error instanceof ProviderError ? { code: error.code, message: error.message } : { code: 'github_output', message: 'GitHub did not return a pull request.' } };
      }
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => {});
    }
  };
}
