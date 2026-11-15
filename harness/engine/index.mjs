// Public entry of the engine (interfaces.md §7).
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_DATA_DIR, startRun } from './engine.mjs';
import { RUN_ID_PATTERN } from './util.mjs';

export { startRun, RUN_ID_PATTERN };
export { renderPlanFacts } from './plan-facts.mjs';

const runsDir = dataDir => join(resolve(dataDir ?? DEFAULT_DATA_DIR), 'harness', 'runs');

/** readRun(runId) → RunState from state.json, or null when the run does not exist or the id is not valid. */
export async function readRun(runId, { dataDir } = {}) {
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return null;
  try {
    return JSON.parse(await readFile(join(runsDir(dataDir), runId, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** listRuns() → RunState[] newest first (ids sort chronologically). Unreadable state files are skipped. */
export async function listRuns({ dataDir } = {}) {
  let names;
  try { names = await readdir(runsDir(dataDir)); } catch { return []; }
  const states = await Promise.all(names.filter(n => RUN_ID_PATTERN.test(n)).sort().reverse().map(n => readRun(n, { dataDir })));
  return states.filter(Boolean);
}
