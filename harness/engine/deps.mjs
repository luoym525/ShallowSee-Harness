// The ONLY file in the repository that wires every module's real implementation together.
// Dynamic import() so a module that is not merged yet gives a clear "module X not merged yet" error
// instead of a crash at load time. Tests pass fakes for everything and never reach these imports.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MODULE_PATHS = Object.freeze({
  providers: '../providers/index.mjs',
  router: '../router/index.mjs',
  roles: '../roles/index.mjs',
  sandbox: '../workers/sandbox/index.mjs',
  builder: '../workers/builder/index.mjs',
  tester: '../workers/tester/index.mjs',
  skills: '../skills/index.mjs',
  eventLog: '../../packages/event-log/index.mjs',
});

const LABELS = {
  providers: 'harness/providers (workstream 01)', router: 'harness/router (workstream 02)', roles: 'harness/roles (workstream 03)',
  sandbox: 'harness/workers/sandbox (workstream 04)', builder: 'harness/workers/builder (workstream 04)',
  tester: 'harness/workers/tester (workstream 05)', skills: 'harness/skills (workstream 10)', eventLog: 'packages/event-log',
};

export class ModuleNotMergedError extends Error {
  constructor(key) {
    super(`Module ${LABELS[key] ?? key} is not merged yet (expected ${MODULE_PATHS[key]?.replace(/^\.\.\//, 'harness/')}).`);
    this.name = 'ModuleNotMergedError';
    this.code = 'module_not_merged';
    this.module = key;
  }
}

/** Imports one module by key; a missing file becomes ModuleNotMergedError, any other error is rethrown. */
export async function importModule(key) {
  const url = new URL(MODULE_PATHS[key], import.meta.url);
  if (!existsSync(fileURLToPath(url))) throw new ModuleNotMergedError(key);
  return import(url.href);
}

/**
 * Fills every missing EngineDeps field with the real module. Only missing fields are imported, so a
 * test that passes complete fakes never touches the file system here.
 */
export async function resolveDeps(partial = {}, config = {}) {
  const deps = { ...partial };
  const missing = key => deps[key] === undefined || deps[key] === null;

  if (missing('router')) {
    const m = await importModule('router');
    deps.router = { buildRoster: m.buildRoster, selectModel: m.selectModel, describeRouting: m.describeRouting };
  }
  if (missing('roles')) deps.roles = await importModule('roles');
  if (missing('sandbox')) deps.sandbox = await importModule('sandbox');
  if (missing('builder')) deps.builder = { buildItem: (await importModule('builder')).buildItem };
  if (missing('tester')) {
    const m = await importModule('tester');
    deps.tester = { materializeAcceptance: m.materializeAcceptance, runChecks: m.runChecks };
  }
  if (missing('modelClient') || missing('searchClient')) {
    const providers = await importModule('providers');
    if (missing('modelClient')) {
      let roster = [];
      try { roster = deps.router.buildRoster(config); } catch { roster = []; }
      const pricing = ref => {
        const m = roster.find(r => r.ref === ref);
        return { input: m?.inputUsdPerMTok ?? null, output: m?.outputUsdPerMTok ?? null };
      };
      deps.modelClient = providers.createModelClient({ config, pricing });
    }
    if (missing('searchClient')) deps.searchClient = providers.createSearchClient({ config });
    if (missing('redact') && typeof providers.redact === 'function') deps.redact = text => providers.redact(text, config);
  }
  if (missing('createEventLog')) deps.createEventLog = (await importModule('eventLog')).createEventLog;
  if (deps.skills === undefined) {
    try {
      deps.skills = (await importModule('skills')).SKILLS ?? null;
    } catch (error) {
      if (error?.code !== 'module_not_merged') throw error;
      deps.skills = null;
      deps.skillsMissingReason = 'Shelf Life skill not merged';
    }
  }
  if (missing('now')) deps.now = Date.now;
  return deps;
}

/** Loads the providers module for the CLI's `config check` (same not-merged handling). */
export const loadProviders = () => importModule('providers');
export const loadRouter = () => importModule('router');
