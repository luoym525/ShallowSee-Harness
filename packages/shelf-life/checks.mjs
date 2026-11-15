import { isIP } from 'node:net';

export const CATEGORIES = new Set(['price', 'version', 'rate', 'limit', 'date', 'policy', 'other']);
export const isText = (s, max) => typeof s === 'string' && !!s.trim() && s.length <= max && !/[\u0000-\u001f\u007f]/u.test(s);
const compact = (s, max) => typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max) : '';
const FACT_TOKEN = /^[\p{L}\p{N}.$%+\-–—/(),: €£¥]+$/u;
const DOCUMENT = /^(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)*[A-Za-z0-9][A-Za-z0-9_.-]*\.md$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const plainMarkdownLine = line => !/[\[\]`<>|\\]/u.test(line) && !/^\s*(?:[#>]|[-+*]\s|\d+[.)]\s)/u.test(line);

export function documentLines(doc, markdown) {
  if (typeof doc !== 'string' || !DOCUMENT.test(doc) || doc.length > 250) throw new Error('Document label must be a safe repository-relative .md path.');
  if (typeof markdown !== 'string' || !markdown.trim() || Buffer.byteLength(markdown) > 48000 || /[\x00\r](?!\n)/u.test(markdown)) throw new Error('Expected a nonempty UTF-8 Markdown input of up to 48000 bytes.');
  if (markdown.includes('\r\n') && /(?<!\r)\n/u.test(markdown)) throw new Error('Mixed line endings are not supported.');
  if (markdown.includes('\x00') || markdown.includes('\uFEFF')) throw new Error('Markdown contains unsupported characters.');
  const lines = markdown.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function uniqueAt(haystack, needle) {
  const start = haystack.indexOf(needle);
  return start >= 0 && haystack.indexOf(needle, start + 1) < 0 ? start : -1;
}

export function normalizeClaims(input, doc, lines, maxClaims) {
  if (!input || !Array.isArray(input.claims)) throw new Error('Extraction is missing a claim list.');
  const proposed = input.claims;
  if (proposed.length > maxClaims) throw new Error('Extraction exceeded the claim limit.');
  const claims = [];
  const seen = new Set();
  let rejected = 0;
  let fence = null;
  const blockedLines = new Set();
  for (const [i, line] of lines.entries()) {
    const marker = FENCE.exec(line);
    if (fence || marker || /^ {4,}|^\t|^\s*\|/u.test(line)) blockedLines.add(i + 1);
    if (marker && !fence) fence = marker[1];
    else if (marker && fence[0] === marker[1][0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
  }
  for (const raw of proposed) {
    if (!raw || !Number.isSafeInteger(raw.line) || raw.line < 1 || raw.line > lines.length
        || !isText(raw.quote, 600) || !isText(raw.statement, 400) || !isText(raw.oldValue, 100)
        || !CATEGORIES.has(raw.category) || blockedLines.has(raw.line)
        || uniqueAt(lines[raw.line - 1], raw.quote) < 0 || uniqueAt(raw.quote, raw.oldValue) < 0) {
      rejected++;
      continue;
    }
    const key = JSON.stringify([raw.line, raw.quote, raw.oldValue]);
    if (seen.has(key)) { rejected++; continue; }
    seen.add(key);
    claims.push({
      claimId: 'claim_' + String(claims.length + 1),
      doc, lineStart: raw.line, lineEnd: raw.line,
      quote: raw.quote, statement: raw.statement, category: raw.category, oldValue: raw.oldValue,
    });
  }
  return { claims, rejected };
}

export function cleanSources(raw) {
  const result = [];
  const seen = new Set();
  for (const s of Array.isArray(raw) ? raw.slice(0, 8) : []) {
    if (!s || !isText(s.url, 2000)) continue;
    let url;
    try { url = new URL(s.url); } catch { continue; }
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.port || !host.includes('.') || isIP(host) || /(?:^|\.)(?:local|internal|localhost)$/u.test(host)) continue;
    url.hash = '';
    for (const key of url.searchParams.keys()) {
      if (/token|secret|auth|signature|key|password|credential/i.test(key)) { url = null; break; }
    }
    if (!url || seen.has(url.href)) continue;
    const snippet = compact(s.snippet, 1100);
    if (!snippet) continue;
    seen.add(url.href);
    const retrievedAt = typeof s.retrievedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(s.retrievedAt) &&
      Number.isFinite(Date.parse(s.retrievedAt)) ? { retrievedAt: s.retrievedAt } : {};
    result.push({ name: compact(s.name, 160) || host, url: url.href, domain: host.replace(/^www\./u, ''), snippet, ...retrievedAt });
  }
  return result;
}

function comparable(s) {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function includesValue(snippet, value) {
  const haystack = comparable(snippet);
  const needle = comparable(value);
  if (!needle) return false;
  const word = ch => !!ch && /[\p{L}\p{N}.]/u.test(ch);
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = haystack[index - 1];
    const tail = index + needle.length;
    const after = haystack[tail];
    // Do not confuse '10' with '110' or a prefix of '10.2'.
    const dotSeparator = (ch, next) => ch === '.' && (next == null || /\s/u.test(next));
    if ((!word(before) || dotSeparator(before, haystack[index - 2])) &&
        (!word(after) || dotSeparator(after, haystack[tail + 1]))) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function separateSites(a, b) {
  if (a === b || a.endsWith('.' + b) || b.endsWith('.' + a)) return false;
  const conservativeSuffix = host => host.split('.').slice(-2).join('.');
  return conservativeSuffix(a) !== conservativeSuffix(b);
}

export function assessment(raw, claim, sources, originalSources, confirmedSources, line, uniqueLine) {
  if (!raw || !['fresh', 'stale', 'unsure'].includes(raw.verdict)
      || !(raw.currentValue === null || isText(raw.currentValue, 100))
      || !isText(raw.rationale, 600) || !Array.isArray(raw.sourceIndexes)
      || raw.sourceIndexes.length > 8 || raw.sourceIndexes.some(i => !Number.isSafeInteger(i) || i < 0 || i >= sources.length)) {
    throw new Error('Verification response did not match the expected shape.');
  }
  const selected = [...new Set(raw.sourceIndexes)].map(i => sources[i]);
  const currentValue = raw.currentValue;
  const quoteOk = uniqueAt(line, claim.quote) >= 0;
  const tokenOk = currentValue != null && FACT_TOKEN.test(currentValue)
    && FACT_TOKEN.test(claim.oldValue) && currentValue.trim() === currentValue;
  const editOk = uniqueLine && tokenOk && comparable(claim.oldValue) !== comparable(currentValue)
    && plainMarkdownLine(line) && uniqueAt(line, claim.oldValue) >= 0 && includesValue(line, claim.oldValue)
    && plainMarkdownLine(line.replace(claim.oldValue, () => currentValue));
  const replacement = editOk ? claim.quote.replace(claim.oldValue, () => currentValue) : null;
  const patch = isText(replacement, 600) ? replacement : null;
  const support = currentValue ? selected.filter(s => includesValue(s.snippet, currentValue)) : [];
  const originalSupport = originalSources.filter(s => support.some(c => c.url === s.url) && includesValue(s.snippet, currentValue));
  const confirmSupport = confirmedSources.filter(s => support.some(c => c.url === s.url) && includesValue(s.snippet, currentValue));
  const pair = originalSupport.some(a => confirmSupport.some(b =>
    separateSites(a.domain, b.domain) && comparable(a.snippet) !== comparable(b.snippet)));
  const checks = [
    { check: 'quote_in_doc', passed: quoteOk, detail: 'The exact quote is unique on the named line.' },
    { check: 'independent_sources', passed: pair, detail: 'The two searches returned differing excerpts from separate sites. Editorial independence requires human review.' },
    { check: 'correction_supported', passed: originalSupport.length > 0 && confirmSupport.length > 0, detail: 'A selected snippet from each search contains the proposed value.' },
    { check: 'patch_scope', passed: quoteOk && patch !== null, detail: 'Replace the exact old value within one anchored quote in a plain Markdown line.' },
  ];
  const fresh = raw.verdict === 'fresh' && currentValue !== null && comparable(currentValue) === comparable(claim.oldValue) && support.length > 0;
  const stale = raw.verdict === 'stale' && checks.every(check => check.passed);
  return { proposed: { verdict: raw.verdict, currentValue, correction: raw.verdict === 'stale' ? patch : null, rationale: raw.rationale, sources: selected },
    final: { verdict: stale ? 'stale' : fresh ? 'fresh' : 'unsure', currentValue: stale || fresh ? currentValue : null, correction: stale ? patch : null, sources: stale || fresh ? support : selected },
    checks: raw.verdict === 'stale' ? checks : checks.slice(0, 1),
  };
}

export function makeDiff(doc, lines, edits, markdown) {
  if (!edits.length) return '';
  const hunks = [];
  const editedLines = new Set();
  for (const edit of [...edits].sort((a, b) => a.line - b.line)) {
    if (editedLines.has(edit.line)) throw new Error('Overlapping edits.');
    editedLines.add(edit.line);
    const line = lines[edit.line - 1];
    const index = uniqueAt(line, edit.quote);
    if (index < 0 || !isText(edit.correction, 600)) throw new Error('Unsafe patch scope.');
    const newLine = line.slice(0, index) + edit.correction + line.slice(index + edit.quote.length);
    const oldEnding = edit.line === lines.length && !markdown.endsWith('\n') ? '\n\\ No newline at end of file' : '';
    const cr = !oldEnding && markdown.includes('\r\n') ? '\r' : '';
    hunks.push('@@ -' + edit.line + ' +' + edit.line + ' @@\n-' + line + cr + oldEnding + '\n+' + newLine + cr + oldEnding + '\n');
  }
  return 'diff --git a/' + doc + ' b/' + doc + '\n--- a/' + doc + '\n+++ b/' + doc + '\n' + hunks.join('');
}

export function queryFor(claim, stage) {
  const question = claim.statement.replace(/[^\p{L}\p{N}\s.,:%$€£¥()/_+\-]/gu, '');
  return ['Find up-to-date original sources about: ', 'Independently verify the current scope, units and date for: ', 'Look for contradictory or newer official documentation about: '][stage] + question;
}

export const cleanAnswer = raw => compact(raw, 1000) || null;
