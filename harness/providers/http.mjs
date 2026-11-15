import { redact } from './config.mjs';
export class ProviderError extends Error {
  constructor(code, message, retryable = false, status = null, resetAt = null) {
    super(message);
    Object.assign(this, { name: 'ProviderError', code, retryable, status, resetAt });
  }
}
export function headers(p) {return {'content-type':'application/json',...(p.headers || {}),...(p.apiKey ? (p.kind==='anthropic'?{'x-api-key':p.apiKey}:{authorization:`Bearer ${p.apiKey}`}):{}),...(p.kind==='anthropic'?{'anthropic-version':'2023-06-01'}:{})};}

function retryAfter(headers, now) {
  const raw = headers?.get('retry-after');
  if (!raw || !raw.trim()) return null;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}
function resetTime(headers, now, delay) {
  const resetNames = ['anthropic-ratelimit-requests-reset','anthropic-ratelimit-tokens-reset','anthropic-ratelimit-input-tokens-reset','anthropic-ratelimit-output-tokens-reset'];
  const times = resetNames.map(name => Date.parse(headers?.get(name) || '')).filter(Number.isFinite);
  const time = times.length ? Math.max(...times) : delay === null ? null : now + delay;
  return time === null || !Number.isFinite(time) || !Number.isFinite(new Date(time).getTime()) ? null : new Date(time).toISOString();
}
function exhausted(detail) {
  return /(?:insufficient|exhausted|depleted|zero|out of|no)\s+(?:(?:your|the|account|available|current)\s+)*(?:credit|balance|funds|quota)|(?:credit|balance|funds|quota|spend(?:ing)?\s*(?:cap|limit))[^.\n]{0,80}(?:exhausted|depleted|exceeded|reached|insufficient|too low|run out)|(?:exceeded|reached)\s+(?:(?:your|the|current)\s+)*(?:spend(?:ing)?\s*(?:cap|limit)|quota)/i.test(detail);
}
export async function request(fetchImpl, url, init, config, signal, timeoutMs = 120000, includeHeaders = false) {
  const timeout = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let attempt = 0; ; attempt++) {
    let response, err, delayHint = null;
    try {
      if (combined.aborted) throw new DOMException('Aborted', 'AbortError');
      response = await fetchImpl(url, {...init, signal: combined, redirect: 'error'});
      if (!response.ok) {
        const status = response.status, now = Date.now();
        let detail = ''; try { detail = (await response.text()).slice(0, 1000); } catch {}
        delayHint = retryAfter(response.headers, now);
        const quota = exhausted(detail) || ([429, 529].includes(status) && delayHint !== null && delayHint > 60000);
        const code = quota ? 'quota_exhausted' : [401,403].includes(status) ? 'auth' : status === 404 ? 'not_found' : [429,529].includes(status) ? 'rate_limit' : status >= 500 ? 'server' : 'bad_request';
        err = new ProviderError(code, redact(`HTTP ${status}: ${detail}`, config), ['rate_limit','server'].includes(code), status, resetTime(response.headers, now, delayHint));
      } else {
        try { const data = await response.json(); return includeHeaders ? {data, headers: response.headers} : data; }
        catch { throw new ProviderError('invalid_response', 'Provider returned invalid JSON.'); }
      }
    } catch(e) {
      err = e instanceof ProviderError ? e : combined.aborted || e?.name === 'AbortError' || e?.name === 'TimeoutError' ? new ProviderError('timeout','Request cancelled or timed out.') : new ProviderError('network','Network request failed.',true);
    }
    if (!err.retryable || attempt >= 2 || combined.aborted) throw err;
    const base = delayHint ?? [1000,3000][attempt];
    const delay = Math.min(60000, Math.max(0, base) + Math.random() * Math.min(1000, Math.max(0, 60000 - base)));
    await new Promise((resolve,reject)=>{const onAbort=()=>{clearTimeout(timer); reject(new ProviderError('timeout','Request cancelled or timed out.'));}; const timer=setTimeout(()=>{combined.removeEventListener('abort',onAbort); resolve();},delay); combined.addEventListener('abort',onAbort,{once:true}); if(combined.aborted) onAbort();});
  }
}
export function provider(config,id) {const p=config.providers.find(p=>p.id===id && p.enabled); if(!p) throw new ProviderError('not_configured','Provider is not configured.'); return p;}
