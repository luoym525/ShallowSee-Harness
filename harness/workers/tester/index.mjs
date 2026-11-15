import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const execFileAsync = promisify(execFile);

export class TesterError extends Error { constructor(code, message) { super(message); this.code = code; } }
const abort = signal => { if (signal?.aborted) throw new TesterError('cancelled', 'Operation cancelled'); };
const scriptPath = check => {
  const p = check.run?.[1];
  if (check.run?.[0] !== 'node' || typeof p !== 'string' || !/^acceptance\/(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_./-]+\.mjs$/.test(p)) throw new TesterError('invalid_script', 'Invalid acceptance script path');
  return p;
};
export async function materializeAcceptance({ spec, workspace, llm, signal }) {
  const files = [];
  for (const check of spec.acceptance.filter(c => c.type === 'command' && c.generate)) {
    abort(signal);
    const file = scriptPath(check);
    const response = await llm({ system: 'Write only a complete deterministic Node.js .mjs acceptance script, using node:assert and no dependencies. Do not spawn processes or access files outside the workspace. Import product modules using pathToFileURL(path.resolve(process.cwd(), "...")), not relative to the script. Print PASS <checkId> or FAIL <checkId>: <why>.', messages: [{ role: 'user', content: JSON.stringify({ check, spec }) }], signal });
    abort(signal);
    let source = response.text?.trim() ?? '';
    const fence = source.match(/^```(?:javascript|js|mjs)?\s*\n([\s\S]*?)\n```\s*$/i);
    if (fence) source = fence[1];
    if (!source) throw new TesterError('invalid_script', 'Empty acceptance script');
    const tmp = path.join(path.dirname(workspace.dir), `.acceptance-syntax-${process.pid}-${randomUUID()}.mjs`);
    try {
      await fs.writeFile(tmp, source, { flag: 'wx' });
      await execFileAsync(process.execPath, ['--check', tmp]);
    } catch { throw new TesterError('invalid_script', `Acceptance script ${file} has invalid syntax`); }
    finally { await fs.rm(tmp, { force: true }); }
    abort(signal);
    await workspace.writeFile(file, source + '\n');
    files.push(file);
  }
  abort(signal);
  const commit = await workspace.git.commit('scaffold: acceptance tests');
  return { files, commit: commit ?? await workspace.git.head(), acceptanceTree: await workspace.git.treeHash('acceptance') };
}

async function git(ws, args, encoding = 'utf8') {
  return (await execFileAsync('git', [`--git-dir=${ws.dir}.git`, ...args], { encoding, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' } })).stdout;
}
async function frozenCopy(ws, commit, expected) {
  if (!commit) { if (expected !== null) throw new TesterError('invalid_scaffold', 'Missing scaffold commit'); return null; }
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new TesterError('invalid_scaffold', 'Invalid scaffold commit');
  let tree = null;
  try { tree = (await git(ws, ['rev-parse', `${commit}:acceptance`])).trim(); } catch {}
  if (tree !== expected) throw new TesterError('invalid_scaffold', 'Scaffold tree does not match acceptance hash');
  const base = path.join(path.dirname(ws.dir), 'acceptance-frozen');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'run-'));
  try {
    if (tree) {
      const listing = await git(ws, ['ls-tree', '-r', '-z', commit, '--', 'acceptance']);
      for (const entry of listing.split('\0').filter(Boolean)) {
        const match = /^(100644|100755) blob ([a-f0-9]+)\tacceptance\/(.+)$/.exec(entry);
        if (!match || match[3].split('/').some(x => !x || x === '.' || x === '..' || x.includes('\\'))) throw new TesterError('invalid_scaffold', 'Unsafe acceptance tree');
        const dest = path.join(dir, ...match[3].split('/'));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, await git(ws, ['cat-file', 'blob', match[2]], 'buffer'));
      }
    }
    return dir;
  } catch (e) { await fs.rm(dir, { recursive: true, force: true }); throw e; }
}
async function filesAt(dir) {
  const out = new Map();
  async function walk(current, prefix = '') {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT' && !prefix) return; throw e; }
    for (const ent of entries) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(path.join(current, ent.name), rel);
      else if (ent.isFile()) out.set(rel, await fs.readFile(path.join(current, ent.name)));
      else throw new TesterError('tampered', 'Acceptance tree contains a link or special file');
    }
  }
  try { if (!(await fs.lstat(dir)).isDirectory()) throw new TesterError('tampered', 'Acceptance root is not a directory'); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  await walk(dir); return out;
}
async function intact(ws, dir, expected) {
  if (await ws.git.treeHash('acceptance') !== expected) return false;
  try {
    const a = await filesAt(path.join(ws.dir, 'acceptance'));
    const b = dir ? await filesAt(dir) : new Map();
    return a.size === b.size && [...a].every(([name, data]) => b.has(name) && data.equals(b.get(name)));
  } catch { return false; }
}
const tail = s => String(s ?? '').slice(-20000);
function selected(spec, scope) {
  if (scope.kind === 'all') return spec.acceptance;
  const index = spec.workItems.findIndex(w => w.id === scope.itemId);
  const ids = new Set([scope.itemId]);
  if (scope.includeRegression && index >= 0) for (const w of spec.workItems.slice(0, index)) ids.add(w.id);
  return spec.acceptance.filter(c => ids.has(c.itemId));
}
function report(scope, candidate, results, acceptanceIntact, testerModel) {
  const summary = { total: results.length, passed: 0, failed: 0, errored: 0, skipped: 0 };
  const key = { pass: 'passed', fail: 'failed', error: 'errored', skipped: 'skipped' };
  for (const r of results) summary[key[r.status]]++;
  return { scope, candidate, results, summary, score: summary.total === summary.skipped ? 0 : summary.passed / (summary.total - summary.skipped), acceptanceIntact, allPassed: summary.total > 0 && summary.passed === summary.total && acceptanceIntact, testerModel: testerModel ?? null };
}
const result = (c, status, message, evidence = {}, durationMs = 0) => ({ checkId: c.id, itemId: c.itemId, type: c.type, status, evidence, message, durationMs });
async function runOne(c, ws, frozen, judge, signal) {
  const start = Date.now(); let status = 'fail', message = 'Check failed', evidence = {};
  try {
    abort(signal);
    if (c.type === 'command') {
      let args = c.run.slice(1), extra = {};
      if (c.generate) { const p = scriptPath(c); if (!frozen) throw new TesterError('invalid_scaffold', 'Missing frozen script'); args = [path.join(frozen, ...p.slice('acceptance/'.length).split('/')), ...args.slice(1)]; extra = { readOnlyPaths: [frozen] }; }
      const r = await ws.exec(c.run[0], args, { timeoutMs: c.timeoutMs, signal, ...extra });
      evidence = { command: c.run, exitCode: r.exitCode, stdoutTail: tail(r.stdout), stderrTail: tail(r.stderr) };
      status = !r.timedOut && !r.cancelled && r.exitCode === c.expectExitCode && (c.expectStdoutIncludes ?? []).every(s => r.stdout.includes(s)) ? 'pass' : 'fail';
      message = r.cancelled ? 'Command cancelled' : r.timedOut ? 'Command timed out' : status === 'pass' ? 'Command passed' : 'Command did not meet expectations';
    } else if (c.type === 'file') {
      const content = await ws.readFile(c.path); const terms = c.mustContain ?? [];
      const ok = terms.every(s => content.includes(s)) && (!c.mustMatch || new RegExp(c.mustMatch).test(content));
      status = ok ? 'pass' : 'fail'; message = ok ? 'File matched' : 'File did not match';
      const needles = [...terms]; if (c.mustMatch) { const match = content.match(new RegExp(c.mustMatch)); if (match?.[0]) needles.push(match[0]); }
      evidence = { bodyExcerpt: (needles.length ? needles.map(needle => { const i = content.indexOf(needle); return i < 0 ? '' : content.slice(Math.max(0, i - 60), i + needle.length + 60); }).join(' ... ') : content).slice(0, 500) };
    } else if (c.type === 'http') {
      let server;
      try {
        if (!c.request.path.startsWith('/') || c.request.path.startsWith('//') || c.request.path.includes('\\')) throw new TesterError('invalid_request', 'Invalid HTTP path');
        server = await ws.startProcess(c.start[0], c.start.slice(1), { port: c.port, readyPath: c.request.path, signal });
        const response = await fetch(new URL(c.request.path, server.url), { method: c.request.method, headers: c.request.headers, body: c.request.body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
        const body = await response.text(); evidence = { httpStatus: response.status, bodyExcerpt: body.slice(0, 500) };
        status = response.status === c.expectStatus && (c.expectBodyIncludes ?? []).every(s => body.includes(s)) ? 'pass' : 'fail'; message = status === 'pass' ? 'HTTP response matched' : 'HTTP response did not match';
      } finally { if (server) await server.stop(); }
    } else if (c.type === 'llm_judge') {
      if (!judge) { status = 'skipped'; message = 'No judge configured'; }
      else {
        const contents = Object.fromEntries(await Promise.all(c.files.map(async f => [f, await ws.readFile(f)])));
        const numbered = Object.fromEntries(Object.entries(contents).map(([f, text]) => [f, text.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n')]));
        const response = await judge({ system: 'Return JSON {"pass":boolean,"quotes":[{"file":string,"text":string}],"reason":string}. Quote exact evidence from the supplied files.', messages: [{ role: 'user', content: JSON.stringify({ rubric: c.rubric, files: numbered }) }], signal });
        abort(signal);
        let verdict = response.json; if (!verdict) { try { verdict = JSON.parse(response.text); } catch {} }
        const quotes = verdict?.quotes;
        const supported = Array.isArray(quotes) && quotes.length > 0 && quotes.every(q => typeof q?.text === 'string' && q.text.length > 0 && Object.hasOwn(contents, q.file) && contents[q.file].includes(q.text));
        evidence = { quotes: Array.isArray(quotes) ? quotes : [], ...(response.model ? { judgeModel: response.model } : {}) };
        status = verdict?.pass === true && supported ? 'pass' : 'fail'; message = verdict?.pass === true && !supported ? 'unsupported pass' : status === 'pass' ? 'Judge passed with evidence' : 'Judge did not pass';
      }
    } else { status = 'skipped'; message = 'Visual checks are unavailable'; }
  } catch (e) { status = 'error'; message = e?.code === 'cancelled' || signal?.aborted ? 'Check cancelled' : 'Check could not be completed'; }
  return result(c, status, message, evidence, Date.now() - start);
}
export async function runChecks({ spec, workspace, scope, judge, acceptanceTree, acceptanceCommit, signal }) {
  const checks = selected(spec, scope);
  let candidate = await workspace.git.head();
  if (candidate) {
    const dirty = await git(workspace, ['--work-tree=' + workspace.dir, 'status', '--porcelain', '--untracked-files=all']);
    if (dirty.trim()) candidate = null;
  }
  const frozen = await frozenCopy(workspace, acceptanceCommit, acceptanceTree);
  try {
    if (!await intact(workspace, frozen, acceptanceTree)) {
      const results = checks.map(c => result(c, 'fail', 'acceptance tests were modified'));
      await fs.rm(path.join(workspace.dir, 'acceptance'), { recursive: true, force: true });
      if (acceptanceCommit && acceptanceTree) {
        await workspace.git.restorePath(acceptanceCommit, 'acceptance');
        await fs.rm(path.join(workspace.dir, 'acceptance'), { recursive: true, force: true });
        await fs.cp(frozen, path.join(workspace.dir, 'acceptance'), { recursive: true });
      }
      return report(scope, candidate, results, false, null);
    }
    const results = [];
    for (const c of checks) results.push(await runOne(c, workspace, frozen, judge, signal));
    if (!await intact(workspace, frozen, acceptanceTree)) {
      await fs.rm(path.join(workspace.dir, 'acceptance'), { recursive: true, force: true });
      if (acceptanceCommit && acceptanceTree) {
        await workspace.git.restorePath(acceptanceCommit, 'acceptance');
        await fs.rm(path.join(workspace.dir, 'acceptance'), { recursive: true, force: true });
        await fs.cp(frozen, path.join(workspace.dir, 'acceptance'), { recursive: true });
      }
      return report(scope, null, checks.map(c => result(c, 'fail', 'acceptance tests were modified')), false, null);
    }
    if (candidate) {
      const afterHead = await workspace.git.head();
      const dirty = await git(workspace, ['--work-tree=' + workspace.dir, 'status', '--porcelain', '--untracked-files=all']);
      if (afterHead !== candidate || dirty.trim()) candidate = null;
    }
    return report(scope, candidate, results, true, results.find(r => r.evidence.judgeModel)?.evidence.judgeModel ?? null);
  } finally { if (frozen) await fs.rm(frozen, { recursive: true, force: true }); }
}
