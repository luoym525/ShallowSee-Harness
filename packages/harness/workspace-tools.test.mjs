import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceTools } from './workspace-tools.mjs';

test('workspace confines roles and requires a newly written executed test', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-workspace-'));
  try {
    const ws = await createWorkspaceTools(root);
    await assert.rejects(ws.developer['write-code']({ path: '../escape', content: '' }));
    await assert.rejects(ws.developer['write-code']({ path: 'tests/a.test.mjs', content: '' }));
    await assert.rejects(ws.tester['write-test']({ path: 'app.mjs', content: '' }));
    await ws.developer['write-code']({ path: 'app.mjs', content: 'export const x = 1;' });
    const candidate = await ws.candidate();
    ws.beginTester();
    await ws.tester['write-test']({ path: 'tests/a.test.mjs', content: "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { x } from '../app.mjs'; test('x', () => assert.equal(x, 1));" });
    const result = await ws.tester['run-tests']({});
    assert.equal(result.passed, true); assert.equal(result.candidate, candidate);
    ws.beginTester(); assert.equal(ws.getLastTest(), null);
    assert.equal((await ws.tester['run-tests']({})).passed, false);
    await ws.tester['write-test']({ path: 'tests/a.test.mjs', content: '' });
    assert.equal((await ws.tester['run-tests']({})).passed, false);
    try { await symlink(tmpdir(), join(root, 'link'), 'dir'); await assert.rejects(ws.developer['read-file']({ path: 'link/a' })); } catch (e) { if (e.code !== 'EPERM') throw e; }
  } finally { await rm(root, { recursive: true, force: true }); }
});
