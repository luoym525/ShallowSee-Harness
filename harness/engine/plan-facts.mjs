// Deterministic rendering of the facts a plan relies on, for the Shelf Life plan check.
// No model is involved: same spec + research → same bytes.
//
// Format (room #284, measured against Shelf Life's checks.assessment): every fact is ONE plain
// text line with no Markdown decoration (no bullet, heading, quote, link, code or table syntax)
// and no URL. Its sources follow on separate lines that start with "Source: ". Facts are
// separated by a blank line. Decorated fact lines or same-line URLs make the patch_scope check
// fail, and a stale fact would then degrade to "unsure".

const MAX_BYTES = 46000;          // Shelf Life accepts at most 48,000 bytes; keep headroom.
const MAX_FACT_CHARS = 400;
const MAX_SOURCES_PER_FACT = 4;
const URL_RE = /\bhttps?:\/\/[^\s)\]>"']+/giu;

/** One fact line: single line, no URL, no Markdown control characters, no leading list/heading marker. */
export function plainFactLine(text) {
  let s = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f\u{2028}\u{2029}]+/gu, ' ')
    .replace(URL_RE, '(see sources)')
    .replace(/[[{<]/gu, '(')
    .replace(/[\]}>]/gu, ')')
    .replace(/[`|\\]/gu, "'")
    .replace(/\*\*|__/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  // Strip leading Markdown block markers: headings, quotes, bullets, ordered-list numbers, rules.
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/^(?:#+\s*|>\s*|[-+*]\s+|\d+[.)]\s+|[-*_=]{3,}\s*)/u, '').trim();
    if (next === s) break;
    s = next;
  }
  if (s.length > MAX_FACT_CHARS) s = s.slice(0, MAX_FACT_CHARS - 1).trimEnd() + '…';
  return s;
}

function sourceUrls(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const raw = typeof item === 'string' ? item : item?.url;
    if (typeof raw !== 'string') continue;
    let url;
    try { url = new URL(raw.trim()); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    const href = url.href.replace(/[\s|`<>\\[\]]/gu, '');
    if (!out.includes(href)) out.push(href);
    if (out.length >= MAX_SOURCES_PER_FACT) break;
  }
  return out;
}

const sentence = s => (/[.!?…]$/u.test(s) ? s : s + '.');

/**
 * Collects { text, sources } facts from the spec and research, in a stable order:
 * research findings, external services, the plan's own cited sources, documented limits/risks.
 */
export function collectPlanFacts(spec, research) {
  const facts = [];
  for (const f of Array.isArray(research?.findings) ? research.findings : []) {
    const answer = plainFactLine(f?.answer);
    if (!answer) continue;
    facts.push({ kind: 'finding', text: sentence(answer), sources: sourceUrls(f?.sources) });
  }
  for (const svc of Array.isArray(research?.externalServices) ? research.externalServices : []) {
    const name = plainFactLine(svc?.name);
    if (!name) continue;
    const notes = plainFactLine(svc?.notes);
    const key = svc?.needsKey === true ? 'needs an API key' : svc?.needsKey === false ? 'needs no API key' : 'API key requirement not stated';
    facts.push({ kind: 'service', text: sentence(`External service ${name} ${key}${notes ? '; ' + notes.replace(/[.!?…]$/u, '') : ''}`), sources: sourceUrls([svc?.url]) });
  }
  for (const src of Array.isArray(spec?.sources) ? spec.sources : []) {
    const snippet = plainFactLine(src?.snippet);
    if (!snippet) continue;
    facts.push({ kind: 'spec_source', text: sentence(snippet), sources: sourceUrls([src?.url]) });
  }
  for (const risk of Array.isArray(research?.risks) ? research.risks : []) {
    const text = plainFactLine(risk);
    if (text) facts.push({ kind: 'limit', text: sentence(text), sources: [] });
  }
  // Drop duplicate fact lines (Shelf Life needs each anchored line to be unique in the document).
  const seen = new Set();
  return facts.filter(f => (seen.has(f.text) ? false : (seen.add(f.text), true)));
}

/** renderPlanFacts(spec, research) → Markdown text for plan-facts-v<N>.md (deterministic). */
export function renderPlanFacts(spec, research) {
  const version = Number.isSafeInteger(spec?.specVersion) ? spec.specVersion : 1;
  const title = plainFactLine(spec?.title) || 'Untitled plan';
  const stack = spec?.stack === 'node' ? 'Node.js scripts using only built-in modules'
    : spec?.stack === 'static-web' ? 'static HTML, CSS and JavaScript opened in a browser' : 'an unstated stack';
  const header = [
    `Plan facts for spec version ${version}: ${title}`,
    '',
    `The plan builds ${stack}. Each fact below is one line, followed by the sources it came from.`,
    '',
  ];
  const out = [...header];
  let bytes = Buffer.byteLength(out.join('\n'));
  let included = 0;
  const facts = collectPlanFacts(spec, research);
  for (const fact of facts) {
    const block = [fact.text, ...fact.sources.map(url => `Source: ${url}`), ''];
    const size = Buffer.byteLength(block.join('\n') + '\n');
    if (bytes + size > MAX_BYTES) break;
    out.push(...block);
    bytes += size;
    included++;
  }
  if (included === 0) out.push('No checkable external facts were listed in the plan or research.', '');
  if (included < facts.length) out.push(`${facts.length - included} further facts were left out to stay within the audit size limit.`, '');
  return out.join('\n');
}
