// CLI logic for harness/bin/shallowsee.mjs (kept separate so it can be tested without spawning a process).
//   run "<wish>" [--budget-usd N] [--minutes N] [--autonomy full|confirm_plan]   streams one line per event
//   runs                                                                          lists runs, newest first
//   config check [--offline]                                                      validates apiConfig and prints the routing table
// Exit code: 0 delivered, 1 partial / failed / cancelled / config problem, 2 usage error.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadProviders, loadRouter } from '../engine/deps.mjs';
import { listRuns, startRun } from '../engine/index.mjs';

export const USAGE = `ShallowSee Autopilot

Usage:
  node harness/bin/shallowsee.mjs run "<wish>" [--budget-usd N] [--minutes N] [--autonomy full|confirm_plan]
  node harness/bin/shallowsee.mjs runs
  node harness/bin/shallowsee.mjs config check [--offline]

Options:
  --config PATH     use this apiConfig.json (default: apiConfig.json at the repository root, or $SHALLOWSEE_API_CONFIG)
  --data-dir PATH   where runs and event logs are written (default: <repo>/data)
  --offline         config check: do not call the providers
`;

export class UsageError extends Error {}

const VALUE_FLAGS = new Set(['budget-usd', 'minutes', 'autonomy', 'config', 'data-dir']);
const BOOL_FLAGS = new Set(['offline', 'help']);

/** parseArgs(argv) → { command, sub, wish, flags } or throws UsageError. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOL_FLAGS.has(name)) { flags[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`Unknown option --${name}.`);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) throw new UsageError(`Option --${name} needs a value.`);
    flags[name] = value;
  }
  if (flags['budget-usd'] !== undefined) {
    const n = Number(flags['budget-usd']);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError('--budget-usd must be a positive number.');
    flags['budget-usd'] = n;
  }
  if (flags.minutes !== undefined) {
    const n = Number(flags.minutes);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError('--minutes must be a positive number.');
    flags.minutes = n;
  }
  if (flags.autonomy !== undefined && !['full', 'confirm_plan'].includes(flags.autonomy)) throw new UsageError('--autonomy must be "full" or "confirm_plan".');
  const [command, sub, ...rest] = positional;
  if (flags.help || !command) return { command: 'help', flags };
  if (command === 'run') {
    const wish = positional.slice(1).join(' ').trim();
    if (!wish) throw new UsageError('run needs a wish in quotes, for example: run "I want a page that tells me if I need an umbrella tomorrow"');
    if (wish.length > 2000) throw new UsageError('The wish is longer than 2000 characters.');
    return { command, wish, flags };
  }
  if (command === 'runs') return { command, flags };
  if (command === 'config' && sub === 'check' && rest.length === 0) return { command: 'config-check', flags };
  throw new UsageError(`Unknown command: ${positional.join(' ')}`);
}

const short = (sha, n = 7) => (typeof sha === 'string' ? sha.slice(0, n) : 'none');
const one = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const scopeLabel = scope => (scope?.kind === 'item' ? `item ${scope.itemId}${scope.includeRegression ? ' + regression' : ''}` : 'all checks');

/** One printable line (or null) per event: phase, model and reason, test score, decision. ASCII only. */
export function formatEvent(e) {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'room.created': return `Run ${e.roomId} started (autonomy: ${p.autonomy ?? 'full'}; limits: $${p.limits?.maxUsd}, ${p.limits?.maxMinutes} min, ${p.limits?.maxRuns} build iterations)`;
    case 'harness.phase.changed': return `==> ${p.phase}${p.itemId ? ` ${p.itemId}` : ''}`;
    case 'harness.route.selected': return `    model for ${p.role}${p.purpose ? ` (${p.purpose})` : ''}: ${p.model} - ${one(p.reason)}`;
    case 'harness.note': return `    note (${p.role}): ${one(p.text)}`;
    case 'harness.brief.ready': return `    brief: "${one(p.title)}"${p.refused ? ` REFUSED: ${one(p.refused.reason)}` : ''}`;
    case 'harness.research.ready': return `    research: ${p.findingCount} findings, ${p.searchesUsed} searches (${p.basis})`;
    case 'harness.plan.ready': return `    plan v${p.specVersion}: "${one(p.title)}", ${p.items?.length ?? 0} items, ${p.checkCount} checks (${p.executableCheckCount} executable)`;
    case 'harness.plan.reviewed': return `    plan review v${p.specVersion}: ${p.verdict}${p.approval ? ` (auto-approved by ${p.approval.model})` : ''}${p.engineOverrides?.length ? ` [engine: ${p.engineOverrides.join('; ')}]` : ''}`;
    case 'harness.plan.confirmed': return `    plan v${p.specVersion} confirmed by the user`;
    case 'harness.skill.completed': return `    skill ${p.skillId} (${p.phase}): ${p.status === 'completed' ? `completed, ${p.findingCount} claim(s), ${p.staleCount} stale` : `NOT VERIFIED (${p.status}${p.reason ? `: ${one(p.reason)}` : ''})`}`;
    case 'harness.build.completed': return `    built ${p.itemId} attempt ${p.attempt}: ${p.status}, ${p.filesChanged?.length ?? 0} file(s), commit ${short(p.commit)}`;
    case 'harness.test.completed': return `    tests (${scopeLabel(p.scope)}): ${p.passed}/${p.total} passed, score ${Number(p.score).toFixed(2)}${p.failures?.length ? `; failing: ${p.failures.map(f => f.checkId).join(', ')}` : ''}`;
    case 'harness.candidate.best': return p.reverted ? `    score dropped: workspace reset to the best commit ${short(p.commit)} (score ${Number(p.score).toFixed(2)})` : `    best so far: ${short(p.commit)} (score ${Number(p.score).toFixed(2)})`;
    case 'harness.reflect.decided': return `    decision for ${p.itemId}: ${p.decision}${p.overriddenBy ? ` (engine rule: ${p.overriddenBy})` : ''} - ${one(p.reason)}`;
    case 'harness.final.reviewed': return `    final review: ${p.verdict}${p.gaps?.length ? `, ${p.gaps.length} gap(s)` : ''}`;
    case 'harness.budget.updated': return p.exceeded ? `    LIMIT REACHED: ${p.exceeded} (spent ${p.spentUsd === null ? 'unknown' : `$${p.spentUsd}`}, ${p.elapsedMinutes} min, ${p.iterations} build iterations)` : null;
    case 'run.failed': return `    model call failed: ${one(p.error?.message)}`;
    case 'harness.run.finished': return `Finished: ${p.status} - ${one(p.summary)}`;
    default: return null;
  }
}

const money = usd => (usd === null || usd === undefined ? 'unknown' : `$${Number(usd).toFixed(4)}`);

async function loadConfig(providers, flags, io) {
  const path = flags.config ?? providers.DEFAULT_CONFIG_PATH;
  if (flags.config && !existsSync(path)) { io.err(`Config file not found: ${path}\n`); return null; }
  return providers.loadApiConfig({ path });
}

async function commandRun(parsed, io, engineDeps) {
  let providers;
  try { providers = io.modules?.providers ?? await loadProviders(); } catch (error) { io.err(`${error.message}\n`); return 1; }
  let config;
  try { config = await loadConfig(providers, parsed.flags, io); } catch (error) { io.err(`Could not read the configuration: ${error.message}\n`); return 1; }
  if (!config) return 1;
  const overrides = {
    ...(parsed.flags['budget-usd'] !== undefined || parsed.flags.minutes !== undefined ? { budget: {
      ...(parsed.flags['budget-usd'] !== undefined ? { maxUsdPerRun: parsed.flags['budget-usd'] } : {}),
      ...(parsed.flags.minutes !== undefined ? { maxMinutesPerRun: parsed.flags.minutes } : {}),
    } } : {}),
    ...(parsed.flags.autonomy ? { autonomy: parsed.flags.autonomy } : {}),
  };
  const dataDir = parsed.flags['data-dir'] ? resolve(parsed.flags['data-dir']) : undefined;
  let handle;
  try {
    handle = startRun({
      wish: parsed.wish, config, overrides, ...(dataDir ? { dataDir } : {}), ...(engineDeps ? { deps: engineDeps } : {}),
      onEvent: e => { const line = formatEvent(e); if (line) io.out(line + '\n'); },
    });
  } catch (error) { io.err(`${error.message}\n`); return 2; }
  const onSignal = () => { io.out('\nStopping: waiting for work in progress to finish...\n'); handle.cancel('Interrupted from the terminal.'); };
  io.onInterrupt?.(onSignal);
  const summary = await handle.done.catch(error => { io.err(`The run crashed: ${error.message}\n`); return null; });
  io.offInterrupt?.(onSignal);
  if (!summary) return 1;
  const runDir = join(dataDir ?? io.defaultDataDir ?? 'data', 'harness', 'runs', summary.runId);
  io.out(`\nStatus: ${summary.status}\n`);
  io.out(`Score: ${summary.finalScore === null ? 'unknown' : summary.finalScore.toFixed(2)}   Spent: ${money(summary.spentUsd)}   Time: ${summary.minutes} min\n`);
  io.out(`Run folder: ${runDir}\n`);
  io.out(`Report: ${summary.reportPath ?? 'none written'}\n`);
  if (summary.previewPath) io.out(`Product entry: ${join(summary.workspaceDir, summary.previewPath)}\n`);
  return summary.status === 'delivered' ? 0 : 1;
}

async function commandRuns(parsed, io) {
  const runs = await listRuns(parsed.flags['data-dir'] ? { dataDir: resolve(parsed.flags['data-dir']) } : {});
  if (!runs.length) { io.out('No runs yet.\n'); return 0; }
  for (const r of runs) io.out(`${r.runId}  ${String(r.status).padEnd(21)} ${String(r.phase).padEnd(15)} ${money(r.spend?.usd).padEnd(9)} ${r.title ?? one(r.wish).slice(0, 50)}\n`);
  return 0;
}

async function commandConfigCheck(parsed, io) {
  let providers;
  try { providers = io.modules?.providers ?? await loadProviders(); } catch (error) { io.err(`${error.message}\n`); return 1; }
  const path = parsed.flags.config ?? providers.DEFAULT_CONFIG_PATH;
  io.out(`Config file: ${path}\n`);
  if (!existsSync(path)) {
    io.out('No apiConfig.json was found, so no models are configured yet.\n');
    io.out('Fix: copy apiConfig.example.json to apiConfig.json and add a provider and its API key, or start the console and use the Setup page.\n');
    io.out('Then run this check again.\n');
    return 1;
  }
  let config;
  try { config = await providers.loadApiConfig({ path }); } catch (error) { io.err(`The configuration could not be read: ${error.message}\n`); return 1; }
  const validation = providers.validateApiConfig(config);
  for (const issue of validation.errors) io.out(`ERROR   ${issue.path}: ${issue.message}\n`);
  for (const issue of validation.warnings) io.out(`warning ${issue.path}: ${issue.message}\n`);
  io.out(`Configuration: ${validation.ok ? 'valid' : 'INVALID'}\n`);
  io.out(`Budget: $${config.budget?.maxUsdPerRun} / ${config.budget?.maxMinutesPerRun} min / ${config.budget?.maxBuildIterations} build iterations   Autonomy: ${config.routing?.autonomy ?? 'full'}\n`);
  io.out('Providers:\n');
  if (!config.providers?.length) io.out('  (none)\n');
  for (const p of config.providers ?? []) io.out(`  ${p.id}  ${p.kind}  ${p.enabled ? 'enabled' : 'disabled'}  key: ${p.apiKey ? 'set' : 'missing'}  models: ${(p.models ?? []).filter(m => m.enabled).length}\n`);
  let ok = validation.ok;
  let router;
  try { router = io.modules?.router ?? await loadRouter(); } catch (error) { io.err(`${error.message}\n`); return 1; }
  let roster = [];
  try { roster = router.buildRoster(config); } catch { roster = []; }
  io.out('Routing (which model each role would get right now):\n');
  if (!roster.length) { io.out('  No usable models. Add a provider with a key and at least one enabled model.\n'); ok = false; } else {
    const rows = router.describeRouting(roster, { overrides: config.routing?.overrides, preferVendorDiversity: config.routing?.preferVendorDiversity });
    for (const r of rows) io.out(`  ${String(r.role).padEnd(10)} ${r.model ?? '(none)'}${r.tier ? ` (tier ${r.tier})` : ''}${r.pinned ? ' [pinned]' : ''} - ${one(r.reason)}\n`);
  }
  let searchAvailable = false;
  try { searchAvailable = providers.createSearchClient({ config }).available === true; } catch { searchAvailable = false; }
  io.out(`Search (Linkup): ${searchAvailable ? 'configured' : 'NOT configured: research falls back to model knowledge and the Shelf Life fact checks are skipped (reported as "not verified")'}\n`);
  if (parsed.flags.offline) io.out('Provider connection tests skipped (--offline).\n');
  else {
    io.out('Provider connection tests:\n');
    for (const p of (config.providers ?? []).filter(x => x.enabled)) {
      try {
        const r = await providers.testProvider(config, p.id);
        io.out(`  ${p.id}: ${r.ok ? 'ok' : 'FAILED'}${r.latencyMs !== null && r.latencyMs !== undefined ? ` (${r.latencyMs} ms)` : ''} - ${one(r.detail)}\n`);
        if (!r.ok) ok = false;
      } catch (error) { io.out(`  ${p.id}: FAILED - ${one(error.message)}\n`); ok = false; }
    }
  }
  io.out(ok ? 'Config check passed.\n' : 'Config check found problems (see above).\n');
  return ok ? 0 : 1;
}

/** runCli(argv, io, engineDeps?) → exit code. io = { out, err, onInterrupt?, offInterrupt?, defaultDataDir?, modules?: { providers?, router? } } */
export async function runCli(argv, io, engineDeps) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.command === 'help') { io.out(USAGE); return 0; }
  if (parsed.command === 'run') return commandRun(parsed, io, engineDeps);
  if (parsed.command === 'runs') return commandRuns(parsed, io);
  return commandConfigCheck(parsed, io);
}
