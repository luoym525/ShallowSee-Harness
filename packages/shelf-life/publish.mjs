import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postJson, ProviderError } from './providers.mjs';

// Publishes an already validated one-line-per-fact patch as a branch and,
// when a token is available, a pull request. It never touches the caller's
// working tree, index or branches: the commit is built with a temporary
// index and pushed by object id. Nothing is merged and nothing is forced.

const GIT_TIMEOUT_MS = 60000;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REF_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const SHA = /^[0-9a-f]{40}$/;

function defaultGit(args, { cwd, env, input } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile('git', args, {
      cwd, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
      timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'buffer',
    }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
    if (input !== undefined) child.stdin.end(input);
  });
}

const text = buffer => buffer.toString('utf8').trim();
const mdText = s => String(s).replace(/[\\`*_{}\[\]()<>#|!~]/gu, c => '\\' + c).replace(/\s+/gu, ' ').trim().slice(0, 120);
const mdCode = s => '`' + String(s).replace(/[`|\r\n]/gu, ' ').trim().slice(0, 80) + '`';
const mdLink = source => '[' + mdText(source.name || source.domain) + '](<' + String(source.url).replace(/[<>\s]/gu, '') + '>)';

export function repoFromRemote(url) {
  const match = /github\.com[:/]([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/u.exec(String(url).trim());
  return match && REPO.test(match[1]) ? match[1] : null;
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
  apiBase = 'https://api.github.com', fetchImpl = fetch, git = defaultGit, gitEnv = {},
}) {
  if (typeof repoDir !== 'string' || !repoDir.trim()) throw new Error('Set the checkout directory of the handbook repository.');
  if (!REF_PART.test(remote) || !REF_PART.test(baseBranch)) throw new Error('Remote and base branch names must be simple names.');
  if (repo !== null && !REPO.test(repo)) throw new Error('Repository must be written as owner/name.');
  const run = (args, options = {}) => git(args, { cwd: repoDir, ...options, env: { ...gitEnv, ...options.env } });

  return async function publish({ roomId, doc, documentSha256, diff, corrections }) {
    if (!Array.isArray(corrections) || corrections.length === 0 || typeof diff !== 'string' || !diff) {
      throw new ProviderError('publish_empty', 'There is no validated correction to publish.');
    }
    const slug = doc.replace(/\.md$/iu, '').replace(/[^A-Za-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'page';
    const suffix = String(roomId).replace(/[^A-Za-z0-9]/gu, '').slice(-10) || 'audit';
    const branch = 'shelf-life/' + slug + '-' + suffix;
    const temp = await mkdtemp(join(tmpdir(), 'shelf-life-publish-'));
    try {
      let target = repo;
      let baseCommit;
      try {
        if (!target) target = repoFromRemote(text(await run(['remote', 'get-url', remote])));
        await run(['fetch', '--quiet', remote, baseBranch]);
        baseCommit = text(await run(['rev-parse', '--verify', '--quiet', 'refs/remotes/' + remote + '/' + baseBranch + '^{commit}']));
      } catch {
        throw new ProviderError('publish_git', 'Could not read the base branch of the handbook repository.', true);
      }
      if (!target) throw new ProviderError('publish_repo', 'Could not tell which GitHub repository to publish to.');
      if (!SHA.test(baseCommit)) throw new ProviderError('publish_git', 'The base branch did not resolve to a commit.');

      let published;
      try { published = await run(['show', baseCommit + ':' + doc]); }
      catch { throw new ProviderError('publish_base_mismatch', 'The audited file does not exist on the base branch.'); }
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
        const tree = text(await run(['write-tree'], { env }));
        const message = title + '\n\n' + corrections.map(c => 'Line ' + c.line + ': ' + c.oldValue + ' -> ' + c.currentValue).join('\n')
          + '\n\nProposed by a Shelf Life audit (room ' + roomId + '). Review the sources in the pull request before merging.\n';
        commit = text(await run(['commit-tree', tree, '-p', baseCommit], { env, input: message }));
      } catch {
        throw new ProviderError('publish_apply', 'The patch did not apply cleanly to the base branch.');
      }
      if (!SHA.test(commit)) throw new ProviderError('publish_git', 'Git did not return a commit for the patch.');

      try { await run(['push', '--quiet', remote, commit + ':refs/heads/' + branch]); }
      catch { throw new ProviderError('publish_push', 'The branch could not be pushed. Check write access to the repository.', true); }

      const compareUrl = 'https://github.com/' + target + '/compare/' + baseBranch + '...' + encodeURIComponent(branch).replace(/%2F/gu, '/') + '?expand=1';
      const result = { repo: target, branch, commit, baseCommit, compareUrl, number: null, url: null, prError: null };
      if (typeof token !== 'string' || !token.trim()) return result;
      try {
        const raw = await postJson(fetchImpl, apiBase + '/repos/' + target + '/pulls', {
          Authorization: 'Bearer ' + token.trim(), Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'shelf-life-audit',
        }, { title, head: branch, base: baseBranch, body }, 'github');
        const url = typeof raw?.html_url === 'string' ? raw.html_url : '';
        if (!Number.isSafeInteger(raw?.number) || raw.number < 1 || !url.startsWith('https://github.com/' + target + '/pull/')) {
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
