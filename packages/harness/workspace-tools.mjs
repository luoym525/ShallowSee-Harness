import { mkdir, lstat, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const LIMIT = 100_000;

// Path checks prevent ordinary traversal and links; this is not an OS sandbox.
export async function createWorkspaceTools(root) {
  root = resolve(root);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Workspace cannot be a symlink');
  let lastTest = null, testerWrote = false;
  async function checked(path, create = false) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid workspace path');
    const parts = path.split('/'); let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinks are forbidden'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; if (!create) throw e; if (i < parts.length - 1) await mkdir(current); }
    }
    return current;
  }
  async function write(path, content, tests) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > LIMIT) throw new Error('Invalid or oversized content');
    if (tests ? !/^tests\/[^/]+\.test\.mjs$/.test(path) : path === 'tests' || path.startsWith('tests/')) throw new Error('Path outside role write scope');
    await writeFile(await checked(path, true), content, { flag: 'w' }); lastTest = null; if (tests) testerWrote = true;
    return `Wrote ${path}`;
  }
  async function files(dir = '', out = []) {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Symlinks are forbidden');
      if (entry.isDirectory()) { if (path !== 'tests') await files(path, out); }
      else if (entry.isFile()) out.push(path);
      else throw new Error('Unsupported workspace entry');
    }
    return out;
  }
  async function candidate() {
    const hash = createHash('sha256');
    for (const path of (await files()).sort()) { const data = await readFile(await checked(path)); if (data.length > LIMIT) throw new Error('Oversized file'); hash.update(JSON.stringify(path)).update('\0').update(data).update('\0'); }
    return hash.digest('hex');
  }
  const read = async ({ path }) => { const data = await readFile(await checked(path)); if (data.length > LIMIT) throw new Error('File too large'); return data.toString('utf8'); };
  const run = async () => {
    const dir = await checked('tests');
    const names = (await readdir(dir)).filter(n => /^[^/\\]+\.test\.mjs$/.test(n)).sort();
    if (!names.length) throw new Error('No test files');
    let hasTestDeclaration = false;
    for (const name of names) { const path = await checked(`tests/${name}`); const content = await readFile(path, 'utf8'); if (Buffer.byteLength(content) > LIMIT) throw new Error('Test file too large'); if (/\b(?:test|it)\s*\(/.test(content)) hasTestDeclaration = true; }
    const before = await candidate(); let passed = false, output;
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
    try { const result = await exec(process.execPath, ['--test', '--test-reporter=tap', ...names.map(n => `tests/${n}`)], { cwd: root, env, timeout: 10000, maxBuffer: 100_000 }); passed = true; output = result.stdout + result.stderr; }
    catch (e) { output = String(e.stdout ?? '') + String(e.stderr ?? '') + `\n${e.message}`; }
    const after = await candidate();
    const count = Number(output.match(/# tests (\d+)/)?.[1] ?? 0);
    lastTest = { candidate: after, passed: passed && hasTestDeclaration && count > 0 && /type: 'test'/.test(output) && Number(output.match(/# pass (\d+)/)?.[1] ?? 0) > 0 && testerWrote && before === after, testCount: count, output: output.slice(0, 12000), sourceChanged: before !== after };
    return lastTest;
  };
  const list = async () => { const all = []; async function walk(dir = '') { for (const ent of await readdir(join(root, dir), { withFileTypes: true })) { const path = dir ? `${dir}/${ent.name}` : ent.name; if (ent.isSymbolicLink()) throw new Error('Symlinks are forbidden'); if (ent.isDirectory()) await walk(path); else if (ent.isFile()) all.push(path); } } await walk(); return all.sort(); };
  return { developer: { 'list-files': list, 'read-file': read, 'write-code': ({ path, content }) => write(path, content, false), 'run-tests': run }, tester: { 'list-files': list, 'read-file': read, 'write-test': ({ path, content }) => write(path, content, true), 'run-tests': run }, read, list, candidate, beginTester: () => { lastTest = null; testerWrote = false; }, getLastTest: () => lastTest };
}

