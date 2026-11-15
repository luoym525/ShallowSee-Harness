import { validateJson } from '../providers/index.mjs';
import { asWebUrl, bool, callJson, choice, integer, list, nullable, object, sourceSchema, string, text } from './shared.mjs';

const argv = list(string, 2);
const port = { ...integer, minimum: 4400, maximum: 4499 };
const entry = {
  anyOf: [
    object({ kind: choice('open_html'), path: text }),
    object({ kind: choice('command'), run: argv }),
    object({ kind: choice('server'), run: argv, port, path: text }),
  ],
};

const common = { id: text, itemId: text, description: text };
const acceptanceCheck = {
  anyOf: [
    object({ ...common, type: choice('command'), run: argv, expectExitCode: integer,
      expectStdoutIncludes: list(text), timeoutMs: { ...integer, minimum: 1 }, generate: bool },
    ['expectStdoutIncludes', 'timeoutMs']),
    object({ ...common, type: choice('file'), path: text, mustContain: list(text), mustMatch: text }, ['mustContain', 'mustMatch']),
    object({ ...common, type: choice('http'), start: argv, port,
      request: object({ method: choice('GET', 'POST'), path: text, body: string, headers: { type: 'object' } }, ['body', 'headers']),
      expectStatus: { ...integer, minimum: 100, maximum: 599 }, expectBodyIncludes: list(text) }, ['expectBodyIncludes']),
    object({ ...common, type: choice('llm_judge'), rubric: text, files: list(text, 1) }),
    object({ ...common, type: choice('visual'), page: text, rubric: text }),
  ],
};

export const specSchema = object({
  specVersion: { ...integer, minimum: 1 }, title: text, summary: text,
  stack: choice('static-web', 'node'), entry, architecture: text,
  assumptions: list(text), outOfScope: list(text), sources: list(sourceSchema),
  workItems: list(object({
    id: text, title: text, description: text, difficulty: choice('easy', 'medium', 'hard'),
    suggestedModel: nullable(text), modelReason: nullable(text), dependsOn: list(text), files: list(text), checkIds: list(text, 1),
  }), 2, 8),
  acceptance: list(acceptanceCheck, 1),
});

const SYSTEM = `Design the smallest complete product that solves the Brief. Use its research findings and sources as evidence,
and name important assumptions. Keep the plan at what and why, plus a short file-level architecture.
Choose static-web with a relative HTML entry or node with a relative .mjs CLI or server entry. Use zero dependencies.
Plan two to eight small work items W1 through Wn in dependency order and give each at least one distinct acceptance check.
List each check on its owning item. Commands execute node with a relative .mjs path. Use direct CLI checks with
expected stdout when feasible. Use loopback HTTP checks for servers on ports 4400–4499. At least 60% of checks
must be command, file, or HTTP checks. Make all expectations observable and specific.
Only generate an acceptance script under acceptance/ when needed. Describe its input and exact assertions.
It may read workspace files or import product modules using pathToFileURL(path.resolve(process.cwd(), productFile)).
It cannot spawn a child process or touch files outside the workspace. Avoid visual checks if a program can verify the behavior.
For each work item, choose a suitable builder from the supplied roster only and briefly explain the fit.
Prefer a cheaper capable coding/tool model for simple work and a stronger capable model for tricky work.
Use null for suggestedModel and modelReason when no listed model fits.
Copy any source entries you rely on from Research. Treat model-knowledge claims as assumptions.
When revision is present address every required change or the replan reason and increment the previous specVersion.
You have no tools in this call. Return one Spec in the supplied JSON schema and stop.`;

function safeRelativePath(path) {
  return typeof path === 'string' && !/[\\:\x00-\x1f]/.test(path)
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

function safeScript(path) {
  return safeRelativePath(path) && !path.startsWith('-') && path.endsWith('.mjs');
}

function commandFits(args, allowTests = false) {
  if (args[0] !== 'node' || args.some(arg => /[\x00\r\n]/.test(arg))) return false;
  if (allowTests && args[1] === '--test') return args.length > 2 && args.slice(2).every(safeScript);
  return safeScript(args[1]);
}

function localHttpPath(path) {
  return path.startsWith('/') && !path.startsWith('//') && !/[\\\x00-\x1f]/.test(path);
}

function checkEntry(spec) {
  const { entry, stack } = spec;
  if (stack === 'static-web') {
    return entry.kind === 'open_html' && safeRelativePath(entry.path) && /\.html?$/i.test(entry.path)
      ? [] : ['A static-web entry must open a workspace-relative HTML file.'];
  }
  if (entry.kind === 'open_html' || !commandFits(entry.run)) return ['A node entry must run node with a workspace-relative .mjs script.'];
  if (entry.kind === 'server' && !localHttpPath(entry.path)) return ['The server entry path must be a local HTTP path.'];
  return [];
}

function checkAcceptanceRule(check) {
  const { type } = check;
  if (type === 'command') {
    if (!commandFits(check.run, !check.generate)) return 'Run node with a workspace-relative .mjs script or node --test with relative .mjs files.';
    const inAcceptance = check.run.slice(1).some(value => value.startsWith('acceptance/'));
    if (check.generate && !/^acceptance\/[a-zA-Z0-9_./-]+\.mjs$/.test(check.run[1])) {
      return 'Place generated scripts under acceptance/. Use letters, numbers, underscores, periods and hyphens in paths.';
    }
    if (!check.generate && inAcceptance
      && (check.run[1].startsWith('acceptance/') || check.run[1] === '--test')) return 'Mark generated acceptance scripts with generate: true.';
  } else if (type === 'file') {
    if (!safeRelativePath(check.path)) return 'Use a workspace-relative file path.';
    if (check.mustMatch) {
      try { new RegExp(check.mustMatch); } catch { return 'Use a valid regular expression for mustMatch.'; }
    }
  } else if (type === 'http') {
    if (!commandFits(check.start)) return 'Start the server with node and a workspace-relative .mjs script.';
    if (!localHttpPath(check.request.path)) return 'Use a local request path beginning with one slash.';
    if (check.request.method === 'GET' && check.request.body !== undefined) return 'Omit the request body on GET.';
    if (Object.values(check.request.headers ?? {}).some(value => typeof value !== 'string')) return 'Use strings for HTTP header values.';
  } else if (type === 'llm_judge' && !check.files.every(safeRelativePath)) {
    return 'Use workspace-relative file paths for judge evidence.';
  }
  return null;
}

export function checkSpecRules(spec) {
  const { errors: shape } = validateJson(specSchema, spec);
  if (shape.length) return shape;
  const violations = checkEntry(spec);
  const checks = new Map();
  const generated = new Set();
  for (const check of spec.acceptance) {
    if (checks.has(check.id)) violations.push('Duplicate acceptance check ' + check.id + '.');
    checks.set(check.id, check);
    const issue = checkAcceptanceRule(check);
    if (issue) violations.push(check.id + ': ' + issue);
    if (check.type === 'command' && check.generate) {
      const path = check.run[1].toLowerCase();
      if (generated.has(path)) violations.push(check.id + ': Generated checks must have distinct scripts.');
      generated.add(path);
    }
  }
  const earlier = new Set();
  const linked = new Set();
  for (const [index, item] of spec.workItems.entries()) {
    if (item.id !== 'W' + (index + 1)) violations.push(item.id + ': Work items must be numbered W1 through Wn in build order.');
    for (const depends of item.dependsOn) {
      if (!earlier.has(depends)) violations.push(item.id + ': Dependency ' + depends + ' must be an earlier work item.');
    }
    if (item.files.some(path => !safeRelativePath(path))) violations.push(item.id + ': Use workspace-relative file paths.');
    earlier.add(item.id);
    for (const id of item.checkIds) {
      if (linked.has(id)) violations.push(id + ': Link each acceptance check only once.');
      linked.add(id);
      if (checks.get(id)?.itemId !== item.id) violations.push(item.id + ': Check ' + id + ' must exist and point back to this item.');
    }
  }
  for (const check of spec.acceptance) {
    if (!linked.has(check.id)) violations.push(check.id + ': Link the check from its owning work item.');
  }
  const executable = spec.acceptance.filter(check => ['command', 'file', 'http'].includes(check.type)).length;
  if (executable * 5 < spec.acceptance.length * 3) violations.push('At least 60% of acceptance checks must be executable.');
  return violations;
}

export const planner = {
  name: 'planner',
  async run(input, ctx) {
    const result = await callJson(ctx, { system: SYSTEM, user: input, schema: specSchema, name: 'spec' });
    const roster = new Set(input.roster.map(model => model.ref));
    const knownSources = new Map(input.research.findings.flatMap(finding => finding.sources)
      .map(source => [asWebUrl(source.url)?.href, source]).filter(([url]) => url));
    const urls = new Set(result.sources.map(source => asWebUrl(source.url)?.href));
    return {
      ...result,
      specVersion: (input.revision?.previous.specVersion ?? 0) + 1,
      sources: [...urls].flatMap(url => knownSources.has(url) ? [knownSources.get(url)] : []),
      workItems: result.workItems.map(item => roster.has(item.suggestedModel)
        ? item : { ...item, suggestedModel: null, modelReason: null }),
    };
  },
};
