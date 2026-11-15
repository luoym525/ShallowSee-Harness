import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { materializeAcceptance, runChecks } from './index.mjs';
const execFile = promisify(execFileCb);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'harness', 'workers', 'tester', 'tmp-')); const dir = path.join(root, 'workspace');
  await fs.mkdir(dir); await execFile('git', ['init', '--bare', `${dir}.git`]);
  const g = async (...args) => (await execFile('git', [`--git-dir=${dir}.git`, `--work-tree=${dir}`, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args])).stdout.trim();
  const ws = { dir, async writeFile(p, s) { const f = path.join(dir, p); await fs.mkdir(path.dirname(f), {recursive:true}); await fs.writeFile(f,s); }, async readFile(p) { return fs.readFile(path.join(dir,p),'utf8'); }, git: {
    async commit(m) { await g('add','-A'); try { await g('commit','-m',m); } catch {} return this.head(); },
    async head() { try { return await g('rev-parse','HEAD'); } catch { return null; } },
    async treeHash(p) { try { return await g('rev-parse', `HEAD:${p}`); } catch { return null; } },
    async restorePath(sha,p) { await g('checkout',sha,'--',p); await this.commit('restore'); }
  }, async exec(cmd,args,opts) { const start=Date.now(); try { const r=await execFile(process.execPath, ['--permission',`--allow-fs-read=${dir}`,`--allow-fs-write=${dir}`, ...(opts.readOnlyPaths ?? []).map(p=>`--allow-fs-read=${p}`), ...args], { cwd:dir, timeout:opts.timeoutMs, signal:opts.signal }); return {exitCode:0,stdout:r.stdout,stderr:r.stderr,timedOut:false,cancelled:false,durationMs:Date.now()-start}; } catch(e) { return {exitCode:typeof e.code==='number'?e.code:null,stdout:e.stdout??'',stderr:e.stderr??'',timedOut:!!e.killed,cancelled:e.name==='AbortError',durationMs:Date.now()-start}; } } };
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  return ws;
}
const base = {workItems:[{id:'W1'},{id:'W2'}],acceptance:[]};
const opts = (ws, spec, scaffold) => ({spec,workspace:ws,scope:{kind:'all'},judge:null,acceptanceTree:scaffold.acceptanceTree,acceptanceCommit:scaffold.commit,signal:new AbortController().signal});
test('frozen script runs, blocks transient modification, and tampering is restored', async t => {
  const ws=await fixture(t); const check={id:'A1',itemId:'W1',type:'command',run:['node','acceptance/a.mjs'],generate:true,expectExitCode:0,expectStdoutIncludes:['PASS A1']}; const spec={...base,acceptance:[check]};
  const source=`import fs from 'node:fs'; import assert from 'node:assert'; assert.throws(() => fs.writeFileSync(new URL(import.meta.url), 'changed'), {code:'ERR_ACCESS_DENIED'}); console.log('PASS A1');`;
  const scaffold=await materializeAcceptance({spec,workspace:ws,llm:async()=>({text:source})});
  const passed=await runChecks(opts(ws,spec,scaffold)); assert.equal(passed.allPassed,true); assert.equal(passed.candidate,scaffold.commit);
  await ws.writeFile('acceptance/a.mjs','tampered'); await ws.writeFile('acceptance/extra.mjs','extra');
  const failed=await runChecks(opts(ws,spec,scaffold)); assert.equal(failed.acceptanceIntact,false); assert.equal(failed.results[0].message,'acceptance tests were modified'); assert.match(await ws.readFile('acceptance/a.mjs'),/ERR_ACCESS_DENIED/); await assert.rejects(ws.readFile('acceptance/extra.mjs'));
});
test('invalid generated syntax fails before commit', async t=>{ const ws=await fixture(t); const spec={...base,acceptance:[{id:'A',type:'command',generate:true,run:['node','acceptance/a.mjs']}]}; await assert.rejects(materializeAcceptance({spec,workspace:ws,llm:async()=>({text:'const = ;'})}),{code:'invalid_script'}); assert.equal(await ws.git.head(),null); });
test('judge requires verbatim evidence and skipped prevents allPassed', async t=>{ const ws=await fixture(t); await ws.writeFile('product.txt','actual text'); await ws.git.commit('product'); const scaffold={commit:await ws.git.head(),acceptanceTree:null}; const spec={...base,acceptance:[{id:'J',itemId:'W1',type:'llm_judge',files:['product.txt'],rubric:'quality'},{id:'V',itemId:'W1',type:'visual'}]}; const input=opts(ws,spec,scaffold); input.judge=async()=>({json:{pass:true,quotes:[{file:'product.txt',text:'fiction'}]}}); let r=await runChecks(input); assert.equal(r.results[0].message,'unsupported pass'); assert.equal(r.allPassed,false); input.judge=async()=>({json:{pass:true,quotes:[{file:'product.txt',text:'actual'}]}}); r=await runChecks(input); assert.equal(r.results[0].status,'pass'); assert.equal(r.score,1); assert.equal(r.allPassed,false); });
test('HTTP server stops even on response failure', async t=>{ const ws=await fixture(t); await ws.git.commit('empty'); let stopped=false; ws.startProcess=async()=>({url:'http://127.0.0.1:1',stop:async()=>{stopped=true;}}); const spec={...base,acceptance:[{id:'H',itemId:'W1',type:'http',start:['node','server.mjs'],port:4450,request:{method:'GET',path:'/'},expectStatus:200}]}; const r=await runChecks(opts(ws,spec,{commit:null,acceptanceTree:null})); assert.equal(r.results[0].status,'error'); assert.equal(stopped,true); });

test('file and command failures, timeout, and cancellation are reported', async t=>{
  const ws=await fixture(t); await ws.writeFile('cli.mjs',"console.log('hello')"); await ws.writeFile('slow.mjs','setInterval(() => {}, 1000)'); await ws.git.commit('product');
  const spec={...base,acceptance:[{id:'C',itemId:'W1',type:'command',run:['node','cli.mjs'],expectExitCode:0,expectStdoutIncludes:['missing']},{id:'F',itemId:'W1',type:'file',path:'missing.txt'},{id:'T',itemId:'W2',type:'command',run:['node','slow.mjs'],expectExitCode:0,timeoutMs:100}]};
  let r=await runChecks(opts(ws,spec,{commit:await ws.git.head(),acceptanceTree:null})); assert.deepEqual(r.results.map(x=>x.status),['fail','error','fail']); assert.equal(r.results[2].message,'Command timed out');
  const controller=new AbortController(); const o=opts(ws,{...base,acceptance:[spec.acceptance[2]]},{commit:await ws.git.head(),acceptanceTree:null}); o.signal=controller.signal; const originalExec=ws.exec; ws.exec=async (...args)=>{ setTimeout(()=>controller.abort(),100); return originalExec(...args); }; r=await runChecks(o); assert.equal(r.results[0].message,'Command cancelled');
});
test('item regression selects earlier items', async t=>{ const ws=await fixture(t); await ws.writeFile('p.txt','yes'); await ws.git.commit('product'); const spec={...base,acceptance:['W1','W2'].map((itemId,i)=>({id:`A${i}`,itemId,type:'file',path:'p.txt',mustContain:['yes']}))}; const o=opts(ws,spec,{commit:await ws.git.head(),acceptanceTree:null}); o.scope={kind:'item',itemId:'W2',includeRegression:true}; const r=await runChecks(o); assert.equal(r.summary.passed,2); assert.equal(r.allPassed,true); });

test('direct command tampering fails every check, restores scaffold, and permits a clean rerun', async t => {
  const ws = await fixture(t);
  const generated = { id:'A', itemId:'W1', type:'command', run:['node','acceptance/seed.mjs'], generate:true, expectExitCode:0 };
  const mutation = { id:'B', itemId:'W1', type:'command', run:['node','mutate.mjs'], generate:false, expectExitCode:0 };
  const spec = {...base, acceptance:[generated, mutation]};
  const scaffold = await materializeAcceptance({spec, workspace:ws, llm:async()=>({text:"console.log('PASS A')"})});
  await ws.writeFile('mutate.mjs', "import fs from 'node:fs'; fs.writeFileSync('acceptance/seed.mjs', 'changed'); console.log('done');");
  const original = await ws.git.commit('add mutating candidate');
  const failed = await runChecks(opts(ws, spec, scaffold));
  assert.equal(failed.candidate, null);
  assert.equal(failed.acceptanceIntact, false);
  assert.equal(failed.allPassed, false);
  assert.deepEqual(failed.results.map(r => [r.status, r.message]), [['fail','acceptance tests were modified'], ['fail','acceptance tests were modified']]);
  assert.equal(await ws.readFile('acceptance/seed.mjs'), "console.log('PASS A')\n");
  await ws.writeFile('mutate.mjs', "console.log('done');");
  const cleanCandidate = await ws.git.commit('remove mutation');
  assert.notEqual(cleanCandidate, original);
  const passed = await runChecks(opts(ws, spec, scaffold));
  assert.equal(passed.candidate, cleanCandidate);
  assert.equal(passed.acceptanceIntact, true);
  assert.equal(passed.allPassed, true);
});
test('product mutation during a passing command cannot be attributed to the original commit', async t => {
  const ws = await fixture(t);
  await ws.writeFile('product.txt', 'before');
  await ws.writeFile('mutate.mjs', "import fs from 'node:fs'; fs.writeFileSync('product.txt', 'after'); console.log('ok');");
  const original = await ws.git.commit('candidate');
  const spec = {...base, acceptance:[{id:'M',itemId:'W1',type:'command',run:['node','mutate.mjs'],generate:false,expectExitCode:0,expectStdoutIncludes:['ok']}]};
  const report = await runChecks(opts(ws,spec,{commit:original,acceptanceTree:null}));
  assert.equal(report.results[0].status, 'pass');
  assert.equal(report.acceptanceIntact, true);
  assert.equal(report.candidate, null);
  assert.equal(report.allPassed, true); // The engine must additionally require a bound candidate for delivery.
  assert.equal(await ws.readFile('product.txt'), 'after');
});
test('a changed HEAD clears candidate attribution', async t => {
  const ws = await fixture(t);
  await ws.writeFile('ok.mjs', "console.log('ok')");
  const original = await ws.git.commit('candidate');
  const exec = ws.exec;
  ws.exec = async (...args) => { const value = await exec(...args); ws.git.head = async () => 'a'.repeat(40); return value; };
  const spec = {...base, acceptance:[{id:'H',itemId:'W1',type:'command',run:['node','ok.mjs'],generate:false,expectExitCode:0}]};
  const report = await runChecks(opts(ws,spec,{commit:original,acceptanceTree:null}));
  assert.equal(report.results[0].status, 'pass');
  assert.equal(report.candidate, null);
});
