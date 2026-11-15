import { ProviderError } from '../providers/index.mjs';
import { asWebUrl, bool, callJson, choice, integer, list, object, sourceSchema, text } from './shared.mjs';

export const researchSchema = object({
  findings: list(object({
    question: text, answer: text, sources: list(sourceSchema),
    confidence: choice('high', 'medium', 'low'), basis: choice('search', 'model_knowledge'),
  })),
  recommendedApproach: text,
  externalServices: list(object({ name: text, url: text, needsKey: bool, notes: text })),
  risks: list(text),
  searchesUsed: { ...integer, minimum: 0, maximum: 6 },
});

const SYSTEM = `Answer each Brief research question in order, exactly once. Input searchEvidence contains retrieved answers
and source records by question. Prefer official API documentation and primary publishers. Identify keyless public APIs,
their documented endpoints and parameters where material, and any limits, permissions, or unresolved risks.
For a search-based finding, copy only source URLs supplied for that question. Treat search answers as leads, not authority.
If you cannot cite relevant retrieved sources, use basis model_knowledge, confidence low, and an empty source list.
Summarize the recommended stack, data source and why in two to five sentences.
Include a service URL only when it is literally present in retrieved evidence. Do not invent URLs.
Searches have already been run by the host. You have no tools. Return one Research artifact and stop.`;

function collectSources(result, ctx) {
  const sources = new Map();
  for (const source of result?.sources ?? []) {
    const parsed = asWebUrl(source?.url);
    if (!parsed || sources.has(parsed.href)) continue;
    sources.set(parsed.href, {
      name: typeof source.name === 'string' ? source.name.slice(0, 240) : '',
      url: parsed.href,
      domain: parsed.hostname,
      snippet: typeof source.snippet === 'string' ? source.snippet.slice(0, 1200) : '',
      retrievedAt: typeof source.retrievedAt === 'string' && Number.isFinite(Date.parse(source.retrievedAt))
        ? source.retrievedAt : ctx.now(),
    });
    if (sources.size >= 6) break;
  }
  return sources;
}

async function searchEvidence(questions, ctx) {
  const entries = questions.map(question => ({ question, answers: [], sources: new Map() }));
  if (!ctx.search) return { entries, searchesUsed: 0 };
  let searchesUsed = 0;
  async function find(entry, query, depth) {
    ctx.signal?.throwIfAborted();
    searchesUsed++;
    let result;
    try {
      result = await ctx.search({ query: query.slice(0, 400), depth, maxResults: 5, signal: ctx.signal });
    } catch (error) {
      ctx.signal?.throwIfAborted();
      if (!(error instanceof ProviderError)) throw error;
      ctx.note?.('A research search failed. The role will use any remaining evidence or label the answer as model knowledge.');
      return;
    }
    ctx.signal?.throwIfAborted();
    if (typeof result?.answer === 'string' && result.answer) entry.answers.push(result.answer.slice(0, 3000));
    for (const [url, source] of collectSources(result, ctx)) entry.sources.set(url, source);
  }
  for (const entry of entries) await find(entry, entry.question, 'standard');
  let usedDeep = false;
  for (const entry of entries) {
    if (searchesUsed >= 6) break;
    if (entry.sources.size >= 2) continue;
    await find(entry, entry.question + ' official documentation', usedDeep ? 'standard' : 'deep');
    usedDeep = true;
  }
  return { entries, searchesUsed };
}

function allowedService(service, entries) {
  const url = asWebUrl(service.url);
  return url && entries.some(entry => {
    if (entry.sources.has(url.href)) return true;
    // Service endpoints may be quoted inside official docs instead of being the document URL.
    const evidence = [...entry.answers, ...Array.from(entry.sources.values(), source => source.snippet)];
    return evidence.some(value => value.match(/https?:\/\/[^\s<>"'`]+/g)
      ?.some(match => asWebUrl(match.replace(/[).,;]+$/, ''))?.href === url.href));
  });
}

export const researcher = {
  name: 'researcher',
  async run({ brief }, ctx) {
    const { entries, searchesUsed } = await searchEvidence(brief.researchQuestions, ctx);
    const user = {
      brief,
      searchEvidence: entries.map(entry => ({ ...entry, sources: [...entry.sources.values()] })),
      searchesUsed,
    };
    const result = await callJson(ctx, {
      system: SYSTEM, user, schema: researchSchema, name: 'research',
      check: ({ findings }) => findings.length !== entries.length
        || findings.some((finding, i) => finding.question !== entries[i].question)
        ? ['Return one finding for each input question, using the exact questions in the supplied order.'] : [],
    });
    const findings = result.findings.map((finding, index) => {
      const known = entries[index].sources;
      const urls = new Set(finding.sources.map(source => asWebUrl(source.url)?.href));
      const sources = finding.basis === 'search' ? [...urls].flatMap(url => known.has(url) ? [known.get(url)] : []) : [];
      return {
        ...finding, sources,
        basis: sources.length ? 'search' : 'model_knowledge',
        confidence: sources.length ? finding.confidence : 'low',
      };
    });
    return {
      ...result, findings, searchesUsed,
      externalServices: result.externalServices.filter(service => allowedService(service, entries)),
    };
  },
};
