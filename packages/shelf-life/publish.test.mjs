import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEventLog } from '../event-log/index.mjs';
import { parseEventLog } from '../../apps/server/log-reader.mjs';
import { createGitPublisher, pullRequestText, repoFromRemote } from './publish.mjs';
import { runDirect } from './runner.mjs';
import { main, syntheticFixture } from './cli.mjs';

// Every test uses a throwaway repository with a local bare remote and an
// injected fetch. Nothing here touches the network, GitHub or a real account.

const validator = fileURLToPath(new URL('../../samples/validate-events.mjs', import.meta.url));
const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8' }).trim();

async function withRepo(fn, markdown = syntheticFixture.markdown) {
  const root = await mkdtemp(join(tmpdir(), 'shelf-life-publish-test-'));
  try {
    const remote = join(root, 'remote.git');
    const work = join(root, 'work');
    await mkdir(remote);
    await mkdir(join(work, 'handbook'), { recursive: true });
    git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
    git(work, 'init', '--quiet', '--initial-branch=main');
    git(work, 'config', 'core.autocrlf', 'false');
    await writeFile(join(work, syntheticFixture.doc), markdown);
    git(work, 'add', '.');
    git(work, 'commit', '--quiet', '-m', 'handbook');
    git(work, 'remote', 'add', 'origin', remote);
    git(work, 'push', '--quiet', 'origin', 'main');
    return await fn({ root, remote, work, base: git(work, 'rev-parse', 'HEAD') });
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function audit(root, publisher) {
  const writer = await createEventLog({ rootDir: join(root, 'rooms'), roomId: 'test_publish' });
  let report;
  try { report = await runDirect({ ...syntheticFixture, writer, modelProvider: { ...syntheticFixture.modelProvider, model: 'mock-model' }, publisher }); }
  finally { await writer.close(); }
  return { report, logPath: writer.logPath, ...parseEventLog(await readFile(writer.logPath)) };
}

const githubOrigin = 'https://github.com/acme/handbook.git';
const repo = 'acme/handbook';
const publishRef = 'refs/heads/shelf-life/handbook-acme-example-estpublish';

// Let Git use a real local receive-pack while the adapter exposes the effective
// GitHub URL. Only the transport is substituted, including the hook's URL.
function localGit(remote, intercept = () => undefined) {
  return async (args, options) => {
    const action = args.findIndex(arg => ['remote', 'ls-remote', 'fetch', 'show', 'read-tree', 'apply', 'diff', 'write-tree', 'commit-tree', 'rev-parse', 'push'].includes(arg));
    const command = args[action];
    const fixture = await intercept(command, args.slice(action + 1), options);
    if (fixture !== undefined) return Buffer.from(fixture);
    if (command === 'remote' || (command === 'ls-remote' && args.includes('--get-url'))) return Buffer.from(githubOrigin + '\n');
    const localArgs = args.map(arg => arg === githubOrigin ? remote : arg);
    return execFileSync('git', localArgs, {
      cwd: options.cwd, input: options.input, timeout: options.timeoutMs,
      env: { ...process.env, ...options.env, SHELFLIFE_PUSH_URL: remote }, stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}

function fakeGitHub(response) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return response(); };
  return { calls, fetchImpl };
}

test('a validated patch becomes a pushed branch and a recorded pull request', async () => {
  await withRepo(async ({ root, remote, work, base }) => {
    const github = fakeGitHub(() => new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/acme/handbook/pull/7' }), { status: 201 }));
    const publisher = createGitPublisher({ repoDir: work, repo, token: 'test-token', fetchImpl: github.fetchImpl, git: localGit(remote), gitEnv: identity });
    const { report, events, logPath } = await audit(root, publisher);

    assert.equal(report.status, 'completed');
    assert.equal(report.publication.number, 7);
    const { branch, commit } = report.publication;
    assert.match(branch, /^shelf-life\/handbook-acme-example-/);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/' + branch), commit);
    assert.equal(git(remote, 'rev-parse', commit + '^'), base);
    assert.match(git(remote, 'show', commit + ':' + syntheticFixture.doc), /^Acme Tools requires version 9\.2\.$/m);
    assert.equal(git(remote, 'diff', '--stat', base, commit).split('\n').at(-1).trim(), '1 file changed, 1 insertion(+), 1 deletion(-)');

    // The caller's checkout is untouched: same branch, same commit, clean tree, no new local branch.
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), base);
    assert.equal(git(work, 'rev-parse', 'HEAD'), base);
    assert.equal(git(work, 'branch', '--show-current'), 'main');
    assert.equal(git(work, 'status', '--porcelain'), '');
    assert.equal(git(work, 'branch', '--list', 'shelf-life/*'), '');
    assert.equal(await readFile(join(work, syntheticFixture.doc), 'utf8'), syntheticFixture.markdown);

    assert.equal(github.calls.length, 1);
    const call = github.calls[0];
    assert.equal(call.url, 'https://api.github.com/repos/acme/handbook/pulls');
    assert.equal(call.init.headers.Authorization, 'Bearer test-token');
    assert.deepEqual([call.body.head, call.body.base], [branch, 'main']);
    assert.match(call.body.body, /`8\.0` \| `9\.2`/);
    assert.match(call.body.body, /https:\/\/acme\.example\/manual/);
    assert.match(call.body.body, /Nothing has been merged/);

    const opened = events.filter(e => e.type === 'shelflife.pr.opened');
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0].payload, { repo: 'acme/handbook', number: 7, url: 'https://github.com/acme/handbook/pull/7', branch, commit, claimIds: ['claim_1'] });
    const artifact = events.find(e => e.type === 'artifact.registered');
    assert.equal(artifact.payload.kind, 'pull_request');
    assert.equal(artifact.payload.version, commit);
    assert.equal(artifact.payload.evidence[0].ref, events.find(e => e.type === 'shelflife.patch.proposed').eventId);
    assert.deepEqual(events.find(e => e.type === 'task.review').payload.artifactIds, ['pr_7']);
    assert.match(events[0].payload.constraints[1], /new branch and optional pull request for human review/);
    assert.equal(events[0].payload.limits.maxMinutes, 7.5);
    assert.equal(events.filter(e => e.type === 'task.done').length, 0);
    assert.equal(events.at(-1).type, 'room.closed');
    assert.ok(!JSON.stringify(events).includes('test-token'));
    execFileSync(process.execPath, [validator, logPath]);
  });
});

test('without a token the branch is pushed and no pull request is claimed', async () => {
  await withRepo(async ({ root, remote, work }) => {
    const github = fakeGitHub(() => { throw new Error('must not be called'); });
    const publisher = createGitPublisher({ repoDir: work, repo, fetchImpl: github.fetchImpl, git: localGit(remote), gitEnv: identity });
    const { report, events, logPath } = await audit(root, publisher);
    assert.equal(github.calls.length, 0);
    assert.equal(report.publication.number, null);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/' + report.publication.branch), report.publication.commit);
    assert.equal(events.filter(e => e.type === 'shelflife.pr.opened').length, 0);
    const artifact = events.find(e => e.type === 'artifact.registered');
    assert.equal(artifact.payload.kind, 'patch');
    assert.match(artifact.payload.location, /^https:\/\/github\.com\/acme\/handbook\/compare\/main\.\.\.shelf-life\//);
    assert.match(events.find(e => e.type === 'tool.result' && e.payload.name === 'open_pull_request').payload.summary, /no pull request was opened/);
    execFileSync(process.execPath, [validator, logPath]);
  });
});

test('a rejected token leaves the pushed branch on record as a patch, not a pull request', async () => {
  await withRepo(async ({ root, remote, work }) => {
    const github = fakeGitHub(() => new Response('{"message":"Bad credentials"}', { status: 401 }));
    const publisher = createGitPublisher({ repoDir: work, repo, token: 'wrong', fetchImpl: github.fetchImpl, git: localGit(remote), gitEnv: identity });
    const { report, events } = await audit(root, publisher);
    assert.equal(report.status, 'completed');
    assert.equal(report.publication.number, null);
    assert.ok(git(remote, 'rev-parse', 'refs/heads/' + report.publication.branch));
    assert.equal(events.filter(e => e.type === 'shelflife.pr.opened').length, 0);
    assert.equal(events.find(e => e.type === 'artifact.registered').payload.kind, 'patch');
    const failed = events.filter(e => e.type === 'run.failed');
    assert.equal(failed.at(-1).payload.error.code, 'github_auth');
    assert.ok(!JSON.stringify(events).includes('Bad credentials'));
  });
});

test('nothing is published when the audited file differs from the base branch', async () => {
  await withRepo(async ({ root, remote, work, base }) => {
    const publisher = createGitPublisher({ repoDir: work, repo, token: 't', fetchImpl: fakeGitHub(() => { throw new Error('unused'); }).fetchImpl, git: localGit(remote), gitEnv: identity });
    const { report, events } = await audit(root, publisher);
    assert.equal(report.status, 'completed');
    assert.equal(report.publication, null);
    assert.ok(report.diff.length > 0);
    assert.equal(git(remote, 'branch', '--list', 'shelf-life/*'), '');
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), base);
    assert.equal(events.filter(e => e.type === 'artifact.registered').length, 0);
    assert.equal(events.filter(e => e.type === 'run.failed').at(-1).payload.error.code, 'publish_base_mismatch');
    assert.deepEqual(events.find(e => e.type === 'task.review').payload.artifactIds, []);
  }, syntheticFixture.markdown.replace('60 projects', '61 projects'));
});

test('pull request text escapes untrusted source names and repository names are parsed strictly', () => {
  const { title, body } = pullRequestText({ doc: 'handbook/a.md', roomId: 'room_1', documentSha256: 'ab'.repeat(32), corrections: [
    { claimId: 'claim_1', line: 4, oldValue: '1|2`', currentValue: '3', sources: [
      { name: 'Evil](https://x.example) | <b>', domain: 'a.example', url: 'https://a.example/p?q=(1)' },
      { name: '', domain: 'b.example', url: 'https://b.example/' },
    ] },
  ] });
  assert.equal(title, 'Shelf Life: update 1 out-of-date value in handbook/a.md');
  const row = body.split('\n').find(line => line.startsWith('| 4 |'));
  assert.equal(row.split(' | ').length, 4);
  assert.ok(!row.includes('](https://x.example)'));
  assert.ok(row.includes('(<https://a.example/p?q=(1)>)'));
  assert.ok(row.includes('[b.example](<https://b.example/>)'));
  assert.equal(repoFromRemote('https://github.com/acme/handbook.git'), 'acme/handbook');
  assert.equal(repoFromRemote('git@github.com:acme/handbook.git'), 'acme/handbook');
  assert.equal(repoFromRemote('https://example.org/acme/handbook.git'), null);
  assert.equal(repoFromRemote('https://notgithub.com/acme/handbook.git'), null);
  assert.equal(repoFromRemote('https://github.com@other.example/acme/handbook.git'), null);
  assert.equal(repoFromRemote('https://github.com/acme/handbook.git#fragment'), null);
  assert.equal(repoFromRemote('C:/tmp/remote.git'), null);
  assert.throws(() => createGitPublisher({ repoDir: '.', repo: 'not a repo' }), /owner\/name/);
});

test('the command line refuses to publish a synthetic audit', async () => {
  const errors = [];
  const original = console.error;
  console.error = message => errors.push(String(message));
  try { assert.equal(await main(['--synthetic', '--open-pr'], {}), 2); }
  finally { console.error = original; }
  assert.match(errors.join('\n'), /Usage:/);
});

test('the runner and publisher reject synthetic publication before invoking Git', async () => {
  const fail = () => assert.fail('Publication should never be invoked for synthetic input');
  await assert.rejects(runDirect({ ...syntheticFixture, writer: { append: fail }, synthetic: true, publisher: fail }), /Synthetic audits/);
  const publisher = createGitPublisher({ repoDir: '.', repo, git: fail });
  await assert.rejects(publisher({ synthetic: true }), { code: 'publish_synthetic' });
});

test('mismatched or multiple effective remote URLs fail before any remote operation', async () => {
  for (const [fetchUrl, pushUrl] of [
    [githubOrigin, 'https://github.com/other/handbook'],
    ['https://notgithub.com/acme/handbook.git', githubOrigin],
    [githubOrigin, githubOrigin + '\n' + githubOrigin],
    [githubOrigin + '\n' + githubOrigin, githubOrigin],
  ]) {
    const git = async args => {
      assert.ok(args.includes('remote'), 'A network operation ran on an unbound remote');
      return Buffer.from((args.includes('--push') ? pushUrl : fetchUrl) + '\n');
    };
    const publisher = createGitPublisher({ repoDir: '.', repo, git });
    await assert.rejects(publisher({ doc: 'handbook/a.md', documentSha256: 'a'.repeat(64), diff: 'not reached', corrections: [{}] }), { code: 'publish_repo' });
  }
});

test('the existing destination branch stays at its original commit', async () => {
  await withRepo(async ({ root, remote, work, base }) => {
    git(remote, 'update-ref', publishRef, base);
    const publisher = createGitPublisher({ repoDir: work, repo, git: localGit(remote), gitEnv: identity });
    const { report, events } = await audit(root, publisher);
    assert.equal(report.publication, null);
    assert.equal(events.findLast(e => e.type === 'run.failed').payload.error.code, 'publish_branch_exists');
    assert.equal(git(remote, 'rev-parse', publishRef), base);
  });
});

test('a branch created after discovery but before push advertisement is rejected by the hook', async () => {
  await withRepo(async ({ root, remote, work, base }) => {
    const adapter = localGit(remote, command => {
      if (command === 'push') git(remote, 'update-ref', publishRef, base);
    });
    const publisher = createGitPublisher({ repoDir: work, repo, git: adapter, gitEnv: identity });
    const { report, events } = await audit(root, publisher);
    assert.equal(report.publication, null);
    assert.equal(events.findLast(e => e.type === 'run.failed').payload.error.code, 'publish_push');
    assert.equal(git(remote, 'rev-parse', publishRef), base);
  });
});

test('an up-to-date branch created by a competing publisher is not claimed as this publication', async () => {
  await withRepo(async ({ root, remote, work }) => {
    let competingCommit;
    const adapter = localGit(remote, (command, args) => {
      if (command === 'push') {
        competingCommit = args.at(-1).split(':', 1)[0];
        git(work, 'push', '--quiet', '--no-verify', remote, competingCommit + ':' + publishRef);
      }
    });
    const publisher = createGitPublisher({ repoDir: work, repo, git: adapter, gitEnv: identity });
    const { report, events } = await audit(root, publisher);
    assert.equal(report.publication, null);
    assert.equal(events.findLast(e => e.type === 'run.failed').payload.error.code, 'publish_push');
    assert.equal(git(remote, 'rev-parse', publishRef), competingCommit);
  });
});

test('receive-pack refuses a competing branch creation after the push advertised zero', async () => {
  await withRepo(async ({ root, remote, work, base }) => {
    const hook = '#!/bin/sh\nset -eu\ngit -C "$RACE_REPOSITORY" update-ref "$RACE_REF" "$RACE_BASE"\n';
    await writeFile(join(work, '.git', 'hooks', 'pre-push'), hook, { mode: 0o700 });
    const gitEnv = { ...identity, RACE_REPOSITORY: remote, RACE_REF: publishRef, RACE_BASE: base };
    const publisher = createGitPublisher({ repoDir: work, repo, git: localGit(remote), gitEnv });
    const { report, events } = await audit(root, publisher);
    assert.equal(report.publication, null);
    assert.equal(events.findLast(e => e.type === 'run.failed').payload.error.code, 'publish_push');
    assert.equal(git(remote, 'rev-parse', publishRef), base);
  });
});

test('the publication deadline prevents later Git operations or a PR request', async t => {
  t.mock.method(performance, 'now', () => fakeTime);
  let fakeTime = 0;
  const commands = [];
  const publisher = createGitPublisher({ repoDir: '.', repo, token: 'fixture',
    fetchImpl: () => assert.fail('A PR request ran after the deadline'),
    git: async (args, { timeoutMs }) => {
      commands.push(args[3]);
      assert.equal(timeoutMs, 20);
      fakeTime = 21;
      return Buffer.from(githubOrigin + '\n');
    },
  });
  try {
    await assert.rejects(publisher({ doc: 'handbook/a.md', documentSha256: 'a'.repeat(64), diff: 'not reached', corrections: [{}], timeoutMs: 20 }), { code: 'publish_timeout' });
    assert.deepEqual(commands, ['get-url']);
  } finally { t.mock.restoreAll(); }
});

test('an exhausted budget after a confirmed push preserves the branch without claiming a PR', async t => {
  await withRepo(async ({ root, remote, work }) => {
    const fakeTime = { value: 0 };
    const wallClock = performance.now.bind(performance);
    const start = wallClock();
    t.mock.method(performance, 'now', () => wallClock() - start + fakeTime.value);
    const runGit = localGit(remote);
    const publisher = createGitPublisher({ repoDir: work, repo, token: 'fixture', gitEnv: identity,
      fetchImpl: () => assert.fail('Attempted to open a PR beyond the deadline'),
      git: async (args, options) => {
        const result = await runGit(args, options);
        if (args.includes('push')) fakeTime.value += 91000;
        return result;
      },
    });
    try {
      const { report, events } = await audit(root, publisher);
      assert.equal(git(remote, 'rev-parse', publishRef), report.publication.commit);
      assert.equal(report.publication.number, null);
      assert.equal(events.findLast(e => e.type === 'run.failed').payload.error.code, 'publish_timeout');
      assert.equal(events.find(e => e.type === 'artifact.registered').payload.kind, 'patch');
      assert.ok(!events.some(e => e.type === 'shelflife.pr.opened'));
    } finally { t.mock.restoreAll(); }
  });
});
