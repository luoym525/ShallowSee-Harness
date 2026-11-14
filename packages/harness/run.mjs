import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createEventLog } from '../event-log/index.mjs';
import { createLinkupProvider } from '../shelf-life/providers.mjs';
import { createClaudeModel } from './claude.mjs';
import { syntheticModel } from './synthetic-model.mjs';
import { runWorkflow } from './workflow.mjs';

const args = process.argv.slice(2);
const synthetic = args.length === 1 && args[0] === '--synthetic';
const live = args.length === 2 && args[0] === '--idea' && args[1].trim();
if (!synthetic && !live) { console.error('Usage: node packages/harness/run.mjs --synthetic | --idea "your project idea"'); process.exit(1); }
const roles = ['presales', 'planner', 'project_manager', 'developer', 'tester', 'support'];
const profiles = {};
let modelFor, search;
if (synthetic) {
  console.log('SYNTHETIC FIXTURE: model decisions, research and approval are simulated; tests execute locally.');
  modelFor = syntheticModel;
  search = async () => ({ answer: 'Synthetic fixture only.', sources: [{ url: 'https://example.org/synthetic-node-docs' }] });
} else {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.LINKUP_API_KEY) throw new Error('Live mode requires ANTHROPIC_API_KEY and LINKUP_API_KEY in the environment.');
  for (const role of roles) {
    const model = process.env['HARNESS_MODEL_' + role.toUpperCase()] || process.env.HARNESS_MODEL;
    if (!model) throw new Error(`Configure HARNESS_MODEL or HARNESS_MODEL_${role.toUpperCase()}.`);
    profiles[role] = { mode: 'api', provider: 'anthropic', model };
  }
  modelFor = role => createClaudeModel({ apiKey: process.env.ANTHROPIC_API_KEY, model: profiles[role].model });
  search = createLinkupProvider({ apiKey: process.env.LINKUP_API_KEY });
}
const id = 'wish_' + randomUUID();
const projectDir = resolve('data/harness-projects', id);
const root = resolve(projectDir, 'workspace');
const reportsDir = resolve(projectDir, 'reports');
const writer = await createEventLog({ rootDir: resolve('data/rooms'), roomId: id });
try {
  const result = await runWorkflow({ idea: synthetic ? 'Build a small cart total calculator.' : args[1], root, reportsDir, writer, modelFor, search, profiles, synthetic,
    confirm: async ({ plan, research }) => {
      console.log(`\nPlan (SHA-256 ${plan.digest}):\n${plan.text}\nResearch: ${JSON.stringify(research, null, 2)}`);
      if (synthetic) { console.log('SYNTHETIC: approval simulated.'); return true; }
      if (!process.stdin.isTTY) { console.log('Interactive approval required; stopping.'); return false; }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return (await rl.question('Type approve to approve this exact plan: ')).trim() === 'approve'; } finally { rl.close(); }
    },
  });
  console.log(JSON.stringify({ synthetic, projectDir, workspaceDir: root, logPath: writer.logPath, ...result }, null, 2));
  if (result.phase !== 'delivery') process.exitCode = 1;
} finally { await writer.close(); }
