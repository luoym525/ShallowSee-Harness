// Small, dependency-free helpers shared by the engine modules.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const RUN_ID_PATTERN = /^hr-\d{8}-\d{6}-[a-z0-9]{4}$/;

export class EngineError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Thrown inside the run when handle.cancel() was called. */
export class CancelledError extends EngineError {
  constructor(reason) { super('cancelled', reason || 'The run was cancelled.'); this.name = 'CancelledError'; }
}

/** Thrown when a hard limit (USD, minutes, build iterations) is reached outside wrap-up. */
export class LimitExceededError extends EngineError {
  constructor(limit) { super('limit_exceeded', `The ${limit} limit for this run was reached.`, { limit }); this.name = 'LimitExceededError'; }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function makeRunId(ms, random = randomBytes(4)) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += ALPHABET[random[i] % ALPHABET.length];
  return `hr-${date}-${time}-${suffix}`;
}

export const pad = (n, width) => String(n).padStart(width, '0');
export const sha256 = text => createHash('sha256').update(text).digest('hex');
export const json = value => JSON.stringify(value, null, 2) + '\n';
export const iso = ms => new Date(ms).toISOString();

/** Atomic write: temp file in the same folder, then rename (retried briefly for Windows readers). */
export async function writeAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, content, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (error) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
      await delay(15 * (attempt + 1));
    }
  }
}

/** Normalises a provider Usage so the team validator accepts it (unknown → every number null). */
export function normalizeUsage(value) {
  const num = n => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);
  const source = ['provider', 'estimated', 'unknown'].includes(value?.source) ? value.source : 'unknown';
  if (source === 'unknown') return { inputTokens: null, outputTokens: null, costUsd: null, source };
  const usage = { inputTokens: num(value.inputTokens), outputTokens: num(value.outputTokens), costUsd: num(value.costUsd), source };
  if (usage.inputTokens === null && usage.outputTokens === null && usage.costUsd === null) usage.source = 'unknown';
  return usage;
}

/** Engine-side redaction. Uses providers.redact when available; always also strips configured secrets and key-shaped text. */
export function makeRedactor(config, providerRedact) {
  const secrets = [];
  for (const p of Array.isArray(config?.providers) ? config.providers : []) {
    if (typeof p?.apiKey === 'string' && p.apiKey.length >= 4) secrets.push(p.apiKey);
    for (const v of Object.values(p?.headers ?? {})) if (typeof v === 'string' && v.length >= 4) secrets.push(v);
  }
  return text => {
    let out = String(text ?? '');
    if (typeof providerRedact === 'function') {
      try { out = String(providerRedact(out)); } catch { /* fall through to local redaction */ }
    }
    for (const s of secrets) out = out.split(s).join('[redacted]');
    return out
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
      .slice(0, 500);
  };
}

export const providerOf = ref => (typeof ref === 'string' && ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : null);
export const truncate = (text, max) => {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
};
export const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
