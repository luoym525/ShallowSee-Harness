import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createWorkspace } from '../workers/sandbox/index.mjs';
import { runChecks } from '../workers/tester/index.mjs';

const exec = promisify(execFile);
const sha = /^[0-9a-f]{40}$/;
const gitEnv = {
  ...Object.fromEntries(['PATH', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'LANG']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0',
};

const windowsDevice = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

export const isCommit = value => typeof value === 'string' && sha.test(value);

function relativePath(path) {
  return typeof path === 'string' && !/[\\:\x00-\x1f]/.test(path)
    && path.split('/').every(part => part && !['.', '..', '.git'].includes(part.toLowerCase())
      && (process.platform !== 'win32' || (!/[<>"|?*]|[ .]$/.test(part) && !windowsDevice.test(part))));
}

async function git(gitDir, ...args) {
  return (await exec('git', ['--no-optional-locks', '--git-dir=' + gitDir, ...args], {
    encoding: 'buffer', env: gitEnv, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  })).stdout;
}

async function filesAtCommit(gitDir, commit) {
  const directory = await lstat(gitDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid run Git directory.');
  if ((await git(gitDir, 'cat-file', '-t', commit)).toString().trim() !== 'commit') throw new Error('Candidate is not a commit.');
  const listing = (await git(gitDir, 'ls-tree', '-r', '-z', commit)).toString('utf8');
  const files = new Map();
  const paths = new Set();
  for (const line of listing.split('\0').filter(Boolean)) {
    const match = /^(?:100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match || !relativePath(match[2])) throw new Error('Candidate contains an unsupported file.');
    const key = process.platform === 'win32' ? match[2].toLowerCase() : match[2];
    if (paths.has(key)) throw new Error('Candidate contains conflicting paths.');
    paths.add(key);
    files.set(match[2], match[1]);
  }
  return files;
}

function visibleHtml(html) {
  return html.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|#160|#xA0);/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

const NUMERIC_LITERAL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;
const NUMERIC_TOKEN = /(?<![\p{L}\p{N}_.+-])[+-]?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?(?![\p{L}\p{N}_]|\.\d)/giu;
const MULTIPLICATION_ROW = /^\d+ x \d+ = \d+$/;

function heldOutOutputMatches(expected, output) {
  if (!expected.length) return true;

  const lines = new Set(output.split(/\r?\n/).map(line => line.trim()));
  const numbers = output.match(NUMERIC_TOKEN) ?? [];
  return expected.every(value => {
    if (MULTIPLICATION_ROW.test(value)) return lines.has(value);
    if (!NUMERIC_LITERAL.test(value)) return true;
    return numbers.some(actual => value.includes('.') ? value === actual
      : Number(value) === Number(actual.replaceAll(',', '')));
  });
}

function bindChecks(sample, spec, files, fixtureDir) {
  const entry = spec?.entry;
  return sample.checks.map(check => {
    if (check.type === 'file' && check.path === '$entry') {
      if (entry?.kind !== 'open_html' || !relativePath(entry.path) || !files.has(entry.path)) return null;
      return { ...check, path: fixtureDir + '/visible-entry.txt' };
    }
    if (check.type === 'command' && check.run[1] === '$entry') {
      const script = entry?.run?.[1];
      if (entry?.kind !== 'command' || entry?.run?.[0] !== 'node' || !relativePath(script) || !script.endsWith('.mjs')
        || script.startsWith('-') || !files.has(script)) return null;
      const args = check.run.slice(2).map(value => {
        if (!value.startsWith('$fixture:')) return value;
        const name = value.slice('$fixture:'.length);
        if (!Object.hasOwn(sample.fixtures ?? {}, name)) throw new Error('Benchmark fixture is missing.');
        return fixtureDir + '/' + name;
      });
      return { ...check, run: ['node', script, ...args] };
    }
    return check;
  });
}

export async function scoreCandidate({ sample, spec, runDir, commit }) {
  if (!isCommit(commit)) throw new Error('Missing candidate commit.');
  const gitDir = join(runDir, 'workspace.git');
  const files = await filesAtCommit(gitDir, commit);
  const fixtureDir = '.shallowsee-bench-' + randomUUID();
  const acceptance = bindChecks(sample, spec, files, fixtureDir);
  if (acceptance.some(check => !check)) {
    return {
      heldOutStatus: 'fail', passed: 0, total: sample.checks.length,
      evidence: [{ status: 'fail', message: 'The candidate lacks the launch interface required by the held-out checks.' }],
    };
  }

  const root = await mkdtemp(join(tmpdir(), 'shallowsee-bench-'));
  try {
    const workspace = await createWorkspace({ dir: join(root, 'workspace') });
    for (const [path, blob] of files) {
      const dest = workspace.resolvePath(path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, await git(gitDir, 'cat-file', 'blob', blob), { flag: 'wx' });
    }
    if (acceptance.some(check => check.path === fixtureDir + '/visible-entry.txt')) {
      const html = (await git(gitDir, 'cat-file', 'blob', files.get(spec.entry.path))).toString('utf8');
      await workspace.writeFile(fixtureDir + '/visible-entry.txt', visibleHtml(html));
    }
    for (const [name, value] of Object.entries(sample.fixtures ?? {})) {
      if (!relativePath(name)) throw new Error('Invalid benchmark fixture name.');
      await workspace.writeFile(fixtureDir + '/' + name, value);
    }
    const acceptanceCommit = await workspace.git.commit('Prepare isolated benchmark candidate.');
    const acceptanceTree = await workspace.git.treeHash('acceptance');
    const signal = AbortSignal.timeout(30_000);
    const report = await runChecks({
      spec: { workItems: [], acceptance }, workspace, scope: { kind: 'all' },
      acceptanceTree, acceptanceCommit, signal,
    });
    const evidence = report.results.map(({ checkId, status, message, evidence }, index) => {
      const expected = acceptance[index].expectStdoutIncludes ?? [];
      if (status === 'pass' && !heldOutOutputMatches(expected, evidence.stdoutTail ?? '')) {
        return { checkId, status: 'fail', message: 'Expected result did not appear as a complete output line or numeric value.' };
      }
      return { checkId, status, message };
    });
    const passed = evidence.filter(item => item.status === 'pass').length;
    const timedOut = signal.aborted || evidence.some(item => /timed out/i.test(item.message));
    const heldOutStatus = timedOut ? 'timed_out' : report.allPassed && passed === evidence.length ? 'pass'
      : evidence.some(item => item.status === 'error') ? 'error' : 'fail';
    return { heldOutStatus, passed, total: report.summary.total, evidence };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
