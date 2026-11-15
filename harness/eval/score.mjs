import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { RUN_ID_PATTERN } from '../engine/index.mjs';
import { DEFAULT_DATA_DIR, WISHES } from './run-bench.mjs';
import { isCommit, scoreCandidate } from './candidate.mjs';

class ScoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScoreError';
    this.code = code;
  }
}

const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const last = (events, type) => events.findLast(event => event.type === type)?.payload;
const MARKS = ['delivered', 'partial', 'failed', 'cancelled', 'timed_out', 'error', 'interrupted'];

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readEvents(dataDir, runId) {
  const text = await readFile(join(dataDir, 'rooms', runId, 'events.jsonl'), 'utf8');
  const events = text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  if (events[0]?.type !== 'room.created' || events.some(event => event.roomId !== runId)) throw new Error('Invalid event log.');
  return events;
}

function metadata(events, state, trial) {
  const finish = last(events, 'harness.run.finished');
  const budget = last(events, 'harness.budget.updated');
  const models = new Map();
  for (const event of events) {
    if (event.type !== 'run.started') continue;
    const role = event.payload?.role ?? event.provenance?.role;
    const model = event.payload?.model ?? event.provenance?.model;
    if (typeof role !== 'string' || typeof model !== 'string') continue;
    if (!models.has(role)) models.set(role, new Set());
    models.get(role).add(model);
  }
  const plans = new Set(events.filter(event => event.type === 'harness.plan.ready').map(event => event.payload?.specVersion));
  const source = state?.spend?.usdSource ?? budget?.usdSource;
  const total = number(state?.spend?.usd ?? finish?.spentUsd ?? budget?.spentUsd);
  return {
    date: date(state?.startedAt) ?? date(trial.startedAt),
    engineScore: number(finish?.finalScore),
    minutes: number(finish?.minutes ?? trial.wallMinutes),
    minutesSource: number(finish?.minutes) !== null ? 'run' : number(trial.wallMinutes) !== null ? 'wall' : null,
    costUsd: ['provider', 'estimated'].includes(source) ? total : null,
    costSource: total !== null && ['provider', 'estimated'].includes(source) ? source : null,
    knownSpendUsd: total,
    iterations: number(state?.iteration ?? budget?.iterations),
    escalations: events.length ? events.filter(event => event.type === 'harness.route.selected' && event.payload?.escalated).length : null,
    planRevisions: events.length ? Math.max(0, plans.size - 1) : null,
    keepBestReverts: events.length ? events.filter(event => event.type === 'harness.candidate.best' && event.payload?.reverted).length : null,
    models: Object.fromEntries([...models].map(([role, refs]) => [role, [...refs]])),
  };
}

const noChecks = (status, total, message) => ({
  heldOutStatus: status, passed: null, total, evidence: [{ status, message }],
});

async function scoreTrial(manifest, trial, sample, dataDir) {
  const total = sample.checks.length;
  let state = null;
  let events = [];
  let candidate = null;
  const base = {
    wishId: trial.wishId, trial: trial.trial, runId: trial.runId, engineStatus: trial.status,
    harnessCommit: manifest.harnessCommit, harnessTreeDirty: manifest.harnessTreeDirty === true,
    synthetic: manifest.synthetic === true,
  };
  if (typeof trial.runId !== 'string' || !RUN_ID_PATTERN.test(trial.runId)) {
    return { ...base, candidate: null, ...metadata(events, state, trial),
      ...noChecks(trial.status === 'timed_out' ? 'timed_out' : 'error', total,
        trial.status === 'interrupted' ? 'The benchmark did not record the end of this trial.' : 'No valid run ID was recorded.') };
  }
  const runDir = join(dataDir, 'harness', 'runs', trial.runId);
  try {
    events = await readEvents(dataDir, trial.runId);
    state = await readJson(join(runDir, 'state.json'));
    const finish = last(events, 'harness.run.finished');
    const status = events.some(event => event.type === 'harness.budget.updated' && event.payload?.exceeded === 'minutes')
      ? 'timed_out' : trial.status;
    candidate = [state?.best?.commit, finish?.candidate].find(isCommit) ?? null;
    const observed = { ...base, engineStatus: status, candidate, ...metadata(events, state, trial),
      synthetic: base.synthetic || events[0].payload?.synthetic === true || state?.synthetic === true };
    if (['timed_out', 'failed', 'cancelled', 'error', 'interrupted'].includes(status)) {
      const outcome = ['failed', 'cancelled'].includes(status) ? 'fail' : status === 'interrupted' ? 'error' : status;
      return { ...observed, ...noChecks(outcome, total, 'The run did not produce a scoreable completion.') };
    }
    if (!finish || !state || state.runId !== trial.runId || finish.status !== status || state.status !== status
      || events[0].payload?.goal !== sample.wish) {
      return { ...observed, ...noChecks('error', total, 'Terminal artifacts are missing or do not agree.') };
    }
    if (!candidate) return { ...observed, ...noChecks('fail', total, 'No committed candidate was recorded.') };
    const spec = await readJson(join(runDir, 'spec.json'));
    return { ...observed, ...await scoreCandidate({ sample, spec, runDir, commit: candidate }) };
  } catch {
    return { ...base, synthetic: base.synthetic || events[0]?.payload?.synthetic === true || state?.synthetic === true,
      candidate, ...metadata(events, state, trial),
      ...noChecks(trial.status === 'timed_out' ? 'timed_out' : 'error', total, 'Run evidence could not be read or evaluated.') };
  }
}

function validateManifest(manifest, samples) {
  if (!manifest || manifest.schemaVersion !== 1 || !isCommit(manifest.harnessCommit)
    || !Number.isSafeInteger(manifest.k) || manifest.k < 1 || !Array.isArray(manifest.wishIds)
    || !Array.isArray(manifest.trials)) throw new ScoreError('invalid_manifest', 'Invalid benchmark manifest.');
  if (!manifest.wishIds.length || new Set(manifest.wishIds).size !== manifest.wishIds.length
    || manifest.wishIds.some(id => !samples.has(id))) throw new ScoreError('invalid_manifest', 'Invalid benchmark wish list.');
  const seen = new Set();
  const runs = new Set();
  for (const row of manifest.trials) {
    if (!row || !samples.has(row.wishId) || !manifest.wishIds.includes(row.wishId) || !Number.isSafeInteger(row.trial)
      || row.trial < 1 || row.trial > manifest.k || !MARKS.includes(row.status)) {
      throw new ScoreError('invalid_manifest', 'Invalid benchmark trial.');
    }
    const key = row.wishId + ':' + row.trial;
    if (seen.has(key) || (row.runId && runs.has(row.runId))) throw new ScoreError('invalid_manifest', 'Duplicate benchmark trial.');
    seen.add(key);
    if (row.runId) runs.add(row.runId);
  }
}

export async function scoreManifest(manifest, { dataDir = DEFAULT_DATA_DIR, samples = WISHES } = {}) {
  const lookup = new Map(samples.map(sample => [sample.id, sample]));
  validateManifest(manifest, lookup);
  const rows = [];
  for (const trial of manifest.trials) rows.push(await scoreTrial(manifest, trial, lookup.get(trial.wishId), dataDir));
  const requested = manifest.wishIds.length * manifest.k;
  const complete = rows.length === requested && !rows.some(row => row.engineStatus === 'interrupted');
  return { rows, groups: summarize(rows, manifest.k), k: manifest.k, requested, complete };
}

function probabilityAll(n, matching, k) {
  if (n < k) return null;
  if (matching < k) return 0;
  let probability = 1;
  for (let offset = 0; offset < k; offset++) probability *= (matching - offset) / (n - offset);
  return probability;
}

export function summarize(rows, k) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.wishId + ':' + (row.synthetic ? 'synthetic' : 'real');
    const group = groups.get(key) ?? { wishId: row.wishId, synthetic: row.synthetic === true, sampleSize: 0, successes: 0 };
    group.sampleSize++;
    if (row.heldOutStatus === 'pass') group.successes++;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const { sampleSize: n, successes: pass } = group;
    const missAll = probabilityAll(n, n - pass, k);
    return { ...group, passRate: pass / n, passAtK: missAll === null ? null : 1 - missAll, passToK: probabilityAll(n, pass, k) };
  });
}

const safe = value => (value === null || value === undefined ? 'unknown' : String(value)).replace(/[\r\n]+/g, ' ').replaceAll('|', '\\|');
const ratio = value => value === null ? 'unknown' : (value * 100).toFixed(1) + '%';

export function renderScore(result) {
  const groups = new Map(result.groups.map(group => [group.wishId + ':' + group.synthetic, group]));
  const output = [
    '# ShallowSee Autopilot benchmark',
    '',
    'Success means every independent held-out check passed. Failed, errored, cancelled, interrupted and timed-out attempts count as misses. Browser checks cover static entry text and do not execute JavaScript.',
    '',
    ...(!result.complete ? ['Incomplete benchmark. ' + result.rows.length + ' of ' + result.requested
      + ' scheduled attempts were recorded. Some attempts may have been interrupted. The rates below cover recorded attempts only.', ''] : []),
    '| Evidence | Wish | Trial | Group n | Harness commit | UTC date | Run ID | Candidate | Run status | Held-out | Engine score | Iterations | Escalations | Plan revisions | Keep-best reverts | Minutes | Model cost | Models used |',
    '|---|---|---:|---:|---|---|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|',
  ];
  for (const row of result.rows) {
    const elapsed = row.minutes === null ? null : row.minutes.toFixed(3) + (row.minutesSource === 'wall' ? ' (wall)' : '');
    const cost = row.costUsd === null ? (row.knownSpendUsd === null ? null : '$' + row.knownSpendUsd.toFixed(6) + ' known; total unknown')
      : '$' + row.costUsd.toFixed(6) + (row.costSource === 'estimated' ? ' (estimated)' : ' (provider)');
    const used = Object.entries(row.models).map(([role, refs]) => role + ': ' + refs.join(', ')).join('; ') || null;
    output.push('| ' + [
      row.synthetic ? 'synthetic' : 'recorded', row.wishId, row.trial,
      groups.get(row.wishId + ':' + row.synthetic).sampleSize, row.harnessCommit + (row.harnessTreeDirty ? ' + dirty tree' : ''),
      row.date, row.runId, row.candidate, row.engineStatus,
      row.heldOutStatus + (row.passed === null ? '' : ' (' + row.passed + '/' + row.total + ')'), ratio(row.engineScore),
      row.iterations, row.escalations, row.planRevisions, row.keepBestReverts, elapsed, cost, used,
    ].map(safe).join(' | ') + ' |');
  }
  const extra = result.k > 1;
  output.push('', '## Success by wish', '',
    '| Evidence | Wish | Successes | Attempts | Pass rate |' + (extra ? ' pass@' + result.k + ' | pass^' + result.k + ' |' : ''),
    '|---|---|---:|---:|---:|' + (extra ? '---:|---:|' : ''));
  for (const group of result.groups) {
    output.push('| ' + [
      group.synthetic ? 'synthetic' : 'recorded', group.wishId, group.successes, group.sampleSize, ratio(group.passRate),
      ...(extra ? [ratio(group.passAtK), ratio(group.passToK)] : []),
    ].map(safe).join(' | ') + ' |');
  }
  if (extra) output.push('', 'pass@k measures at least one success in k draws. pass^k measures success on all k draws. Both use draws without replacement from each wish group.');
  return output.join('\n') + '\n';
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true, options: { 'data-dir': { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('Usage: score.mjs <benchmark manifest> [--data-dir <dir>]');
    return;
  }
  if (positionals.length !== 1) throw new ScoreError('usage', 'Pass one benchmark manifest. See --help.');
  const manifest = await readJson(resolve(positionals[0]));
  const result = await scoreManifest(manifest, { dataDir: resolve(values['data-dir'] ?? DEFAULT_DATA_DIR) });
  process.stdout.write(renderScore(result));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof ScoreError ? error.message : 'Unable to read the benchmark manifest.');
    process.exitCode = error?.code === 'usage' || String(error?.code).startsWith('ERR_PARSE_ARGS') ? 2 : 1;
  });
}
