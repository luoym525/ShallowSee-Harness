import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHarness } from './index.mjs';
import { runAgent } from './agent-runtime.mjs';
import { createWorkspaceTools } from './workspace-tools.mjs';

export async function runWorkflow({ idea, root, reportsDir, writer, modelFor, search, confirm, synthetic = false, profiles = {} }) {
  if (!idea?.trim() || typeof modelFor !== 'function' || typeof search !== 'function' || typeof confirm !== 'function') throw new Error('Idea, models, search and confirmation are required');
  if (reportsDir) await mkdir(reportsDir, { recursive: true });
  const saveReport = async (name, value) => { if (reportsDir) await writeFile(join(reportsDir, name), value); };
  const harness = createHarness({ writer, profiles });
  const ws = await createWorkspaceTools(root);
  const sources = new Map();
  const searchTool = async ({ query }) => {
    if (typeof query !== 'string' || !query.trim() || query.length > 1000) throw new Error('Invalid search query');
    const result = await search({ query, depth: 'standard', timeoutMs: 20000 });
    for (const source of result.sources ?? []) {
      try { const url = new URL(source.url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) sources.set(url.href, { url: url.href, retrievedAt: new Date().toISOString() }); } catch {}
    }
    return result;
  };
  const agent = async (role, stage, task, tools = {}, taskId, skillText = '') => {
    const result = await runAgent({ role, task, model: modelFor(role, stage), tools, writer, taskId, skillText, synthetic, modelId: profiles[role]?.model ?? null });
    if (result.status !== 'completed') throw new Error(`${role} reached its step limit`);
    return result.output;
  };
  const firstTask = await harness.start(idea, { synthetic });
  const brief = await agent('presales', 'brief', `Clarify this project wish into a practical brief. State assumptions: ${idea}`, { search: searchTool, 'read-file': ws.read }, firstTask);
  const draft = await agent('planner', 'plan', `Create a concrete, testable implementation plan for the wish and brief. Work within a small Node.js workspace with no package installation or shell tools. Wish: ${idea}\nBrief: ${brief}`, { search: searchTool, 'read-file': ws.read });
  const plan = await harness.proposePlan(draft);
  const skill = await readFile(fileURLToPath(new URL('../../skills/shelf-life/SKILL.md', import.meta.url)), 'utf8');
  const researchText = await agent('planner', 'research', `Review this exact plan using Shelf Life. Use search for material decisions; missing or unverified evidence must be unresolved. Return only JSON with assessment (current_supported, update_required, unresolved), summary, proposedChanges array, and sourceURLs array of actual search result URLs. Plan digest ${plan.digest}\nPlan: ${plan.text}\nWish: ${idea}`, { search: searchTool, 'read-file': ws.read }, undefined, skill);
  let report;
  try { report = JSON.parse(researchText); } catch { report = { assessment: 'unresolved', summary: 'Research response was not valid JSON.', sourceURLs: [] }; }
  if (!report || typeof report !== 'object' || Array.isArray(report)) report = { assessment: 'unresolved', summary: 'Research response was not an object.', sourceURLs: [] };
  const urls = Array.isArray(report.sourceURLs) ? report.sourceURLs : [];
  const selected = urls.map(url => sources.get(url)).filter(Boolean);
  const allSourcesKnown = urls.length === selected.length;
  const valid = allSourcesKnown && ['current_supported', 'update_required', 'unresolved'].includes(report.assessment);
  let assessment = valid && (report.assessment !== 'current_supported' || selected.length) ? report.assessment : 'unresolved';
  if (assessment === 'current_supported' && Array.isArray(report.proposedChanges) && report.proposedChanges.length) assessment = 'update_required';
  await saveReport('research.json', JSON.stringify({ ...report, assessment, sources: selected, planDigest: plan.digest }, null, 2));
  await harness.recordResearch({ planDigest: plan.digest, assessment, sources: selected, summary: String(report.summary ?? ''), proposedChanges: Array.isArray(report.proposedChanges) ? report.proposedChanges : [] });
  if (assessment !== 'current_supported') return { phase: harness.snapshot().phase, plan, research: { ...report, assessment, sources: selected }, reason: 'Research requires revision or remains unresolved.' };
  if (await confirm({ plan, research: { ...report, assessment, sources: selected }, synthetic }) !== true) return { phase: harness.snapshot().phase, plan, reason: 'Plan was not approved.' };
  let taskId = await harness.confirmPlan(plan.digest);
  let manual, evidence;
  for (let attempt = 0; attempt < 2; attempt++) {
    await agent('developer', 'code', `Implement the approved plan in workspace files using write-code. Tool arguments: {path,content}; read-file: {path}; run-tests: {}. Do not write tests. Plan: ${plan.text}\n${attempt ? 'Fix this failed test evidence: ' + JSON.stringify(evidence) : ''}`, ws.developer, taskId);
    const candidate = await ws.candidate();
    taskId = await harness.submitCode(candidate);
    manual = await agent('project_manager', 'manual', `Write concise usage instructions for this plan and candidate. Plan: ${plan.text}`, { 'read-file': ws.read, 'list-files': ws.list }, taskId);
    await saveReport('manual.txt', manual);
    taskId = await harness.submitManual(manual);
    ws.beginTester();
    ws.beginTester();
    await agent('tester', 'test', `Independently write and run meaningful Node tests for the approved plan and candidate. write-test requires {path:'tests/name.test.mjs',content}; read-file requires {path}; run-tests takes {}. Tests must actually execute. Plan: ${plan.text}\nManual: ${manual}`, ws.tester, taskId);
    evidence = ws.getLastTest();
    const current = await ws.candidate();
    const passed = Boolean(evidence?.passed && evidence.candidate === candidate && current === candidate);
    taskId = await harness.submitTest({ candidate, passed, evidence: JSON.stringify(evidence ?? { passed: false, reason: 'Tester did not execute tests' }) });
    if (passed) return { phase: harness.snapshot().phase, plan: harness.snapshot().plan, manual, evidence, candidate };
  }
  return { phase: harness.snapshot().phase, plan, manual, evidence, reason: 'Tests did not pass within the fix limit.' };
}
