import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEventLog } from '../apps/server/log-reader.mjs';
import { goldDigest, validateGold } from './score.mjs';

// This is a mechanical draft, not a claim match or evidence review.
export function prepareReview(logBytes, gold) {
  validateGold(gold);
  const { events, room, warnings } = parseEventLog(logBytes);
  if (!events.length) throw new Error('No committed events to prepare.');
  if (room.synthetic !== gold.synthetic) throw new Error('Synthetic and real gold/log cohorts must not be mixed.');
  const claims = new Map();
  for (const event of events) {
    if (!['shelflife.claim.extracted', 'shelflife.verdict.final'].includes(event.type)) continue;
    const { claimId } = event.payload;
    if (typeof claimId !== 'string' || !claimId.trim()) throw new Error(`${event.eventId}: claimId is required.`);
    const claim = claims.get(claimId) ?? { claimId, extractedEventId: null, finalEventId: null, sourceReviews: [] };
    if (event.type === 'shelflife.claim.extracted') claim.extractedEventId = event.eventId;
    else {
      const p = event.payload;
      if (!['fresh', 'stale', 'unsure'].includes(p.verdict) || !Array.isArray(p.sources) || !(p.correction === null || (typeof p.correction === 'string' && p.correction.trim()))) throw new Error(`${event.eventId}: invalid final verdict, correction or sources.`);
      const urls = new Set();
      for (const source of p.sources) {
        if (!source || !['name', 'domain'].every(k => typeof source[k] === 'string' && source[k].trim()) || typeof source.snippet !== 'string') throw new Error(`${event.eventId}: malformed citation source.`);
        let url;
        try { url = new URL(source.url); } catch { throw new Error(`${event.eventId}: invalid source URL.`); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${event.eventId}: invalid source URL.`);
        urls.add(url.href);
      }
      claim.finalEventId = event.eventId;
      claim.sourceReviews = [...urls].map(url => ({ url, source_group_id: null, supportsVerdict: 'unreviewed', supportsReplacement: 'unreviewed', reviewedBy: null }));
    }
    claims.set(claimId, claim);
  }
  const findings = [...claims.values()].map(claim => {
    if (!claim.extractedEventId) throw new Error(`Final verdict ${claim.claimId} has no extracted claim.`);
    return { claimId: claim.claimId, goldId: null, extractedEventId: claim.extractedEventId, finalEventId: claim.finalEventId,
      citationSupport: 'unreviewed', independentSources: 'unreviewed', correctionSafety: 'unreviewed', reviewedBy: null,
      sourceReviews: claim.sourceReviews };
  });
  return {
    schemaVersion: 1, roomId: room.roomId, datasetVersion: gold.datasetVersion, goldDigest: goldDigest(gold),
    preparation: { notice: 'UNREVIEWED DRAFT. A human must match gold IDs and review evidence before scoring.',
      synthetic: room.synthetic, driver: room.driver, lastSeq: room.lastSeq, warnings }, findings,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error('Usage: node eval/prepare-review.mjs <events.jsonl> <gold.json>');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(prepareReview(readFileSync(args[0]), JSON.parse(readFileSync(args[1]))), null, 2)); }
    catch (error) { console.error(`Preparation failed: ${error.message}`); process.exitCode = 1; }
  }
}
