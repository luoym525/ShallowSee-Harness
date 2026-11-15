import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { startRun } from '../engine/index.mjs';
import { loadApiConfig, validateApiConfig } from '../providers/index.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_DATA_DIR = join(ROOT, 'data');
export const WISHES = JSON.parse(await readFile(new URL('./wishes.json', import.meta.url), 'utf8'));

class BenchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BenchError';
    this.code = code;
  }
}

function readGit(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  } catch {
    throw new BenchError('git_failed', 'Could not determine the harness checkout revision.');
  }
}

function readRevision() {
  return {
    harnessCommit: readGit(ROOT, ['rev-parse', 'HEAD']),
    harnessTreeDirty: readGit(ROOT, ['status', '--porcelain', '--untracked-files=normal']).length > 0,
  };
}

async function writeManifest(path, manifest) {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), '.' + basename(path) + '.' + randomUUID() + '.tmp');
  await writeFile(temp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await rename(temp, path);
}

async function attempt({ sample, config, start, dataDir, maxUsdPerRun, maxMinutesPerRun }) {
  const startedAt = new Date().toISOString();
  const clock = performance.now();
  let runId = null;
  let status = 'error';
  let timedOut = false;
  let timer;
  try {
    // Only the public wish crosses into the engine. The benchmark definitions stay here.
    const handle = start({
      wish: sample.wish,
      config,
      dataDir,
      overrides: { autonomy: 'full', budget: { maxUsdPerRun, maxMinutesPerRun } },
    });
    runId = handle.runId;
    timer = setTimeout(() => {
      timedOut = true;
      handle.cancel('Benchmark elapsed-time limit reached.');
    }, Math.ceil(maxMinutesPerRun * 60_000));
    const result = await handle.done;
    status = result.status;
  } catch {
    status = 'error';
  } finally {
    clearTimeout(timer);
  }
  return {
    wishId: sample.id, runId, status: timedOut ? 'timed_out' : status, startedAt,
    finishedAt: new Date().toISOString(), wallMinutes: (performance.now() - clock) / 60_000,
  };
}

export async function runBench({
  samples = WISHES,
  k = 1,
  start = startRun,
  config,
  dataDir = DEFAULT_DATA_DIR,
  outputPath,
  maxUsdPerRun,
  maxMinutesPerRun,
  revision = readRevision(),
  synthetic = false,
  onTrial = () => {},
}) {
  const manifest = {
    schemaVersion: 1, ...revision, createdAt: new Date().toISOString(), synthetic,
    k, wishIds: samples.map(sample => sample.id), budget: { maxUsdPerRun, maxMinutesPerRun }, trials: [],
  };
  await writeManifest(outputPath, manifest);
  for (const sample of samples) {
    for (let trial = 1; trial <= k; trial++) {
      const index = manifest.trials.length;
      manifest.trials.push({ wishId: sample.id, trial, runId: null, status: 'interrupted', startedAt: new Date().toISOString() });
      await writeManifest(outputPath, manifest);
      const result = await attempt({ sample, config, start, dataDir, maxUsdPerRun, maxMinutesPerRun });
      const row = { ...result, trial };
      manifest.trials[index] = row;
      await writeManifest(outputPath, manifest);
      onTrial(row);
    }
  }
  return manifest;
}

function positive(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new BenchError('usage', label + ' must be a positive number.');
  return n;
}

async function main() {
  const { values } = parseArgs({ options: {
    only: { type: 'string' }, k: { type: 'string', default: '1' }, 'budget-usd': { type: 'string' },
    minutes: { type: 'string' }, 'data-dir': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Run the configured providers on benchmark wishes. Uses model/search allowance.');
    console.log('Usage: run-bench.mjs [--only <id>] [--k <n>] [--budget-usd <n>] [--minutes <n>] [--data-dir <dir>]');
    console.log('Wishes: ' + WISHES.map(sample => sample.id).join(', '));
    return;
  }
  const samples = values.only ? WISHES.filter(sample => sample.id === values.only) : WISHES;
  if (!samples.length) throw new BenchError('usage', 'Unknown wish ID. Use --help to list available wishes.');
  const k = positive(values.k, '--k');
  if (!Number.isSafeInteger(k)) throw new BenchError('usage', '--k must be a positive integer.');
  const config = await loadApiConfig();
  if (!validateApiConfig(config).ok) throw new BenchError('invalid_config', 'The provider config is invalid. Run config check --offline for diagnostics.');
  const maxUsdPerRun = positive(values['budget-usd'] ?? config.budget.maxUsdPerRun, '--budget-usd');
  const maxMinutesPerRun = positive(values.minutes ?? config.budget.maxMinutesPerRun, '--minutes');
  if (maxMinutesPerRun * 60_000 > 2_147_483_647) throw new BenchError('usage', '--minutes exceeds the supported timer range.');
  const dataDir = resolve(values['data-dir'] ?? DEFAULT_DATA_DIR);
  const date = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = join(dataDir, 'harness', 'eval', date + '-' + randomUUID().slice(0, 8) + '.json');
  console.log('Benchmark log: ' + outputPath);
  await runBench({ samples, k, config, dataDir, outputPath, maxUsdPerRun, maxMinutesPerRun,
    onTrial: row => console.log(row.wishId + ' #' + row.trial + ' ' + row.status + ' ' + (row.runId ?? 'no run ID')) });
  console.log('Score with: node harness/eval/score.mjs "<benchmark log>" --data-dir "<data dir>"');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof BenchError ? error.message : 'Unable to run the benchmark. Check the usage and local provider setup.');
    process.exitCode = error?.code === 'usage' || String(error?.code).startsWith('ERR_PARSE_ARGS') ? 2 : 1;
  });
}
