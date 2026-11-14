import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseEventLog } from '../apps/server/log-reader.mjs';
import { buildAudit } from '../apps/web/model.mjs';

const labels = ['fresh', 'stale', 'unverifiable'];
const verdicts = ['fresh', 'stale', 'unsure'];
const support = ['yes', 'no', 'unclear', 'unreviewed'];
const safety = ['safe', 'unsafe', 'not_applicable', 'unreviewed'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const measured = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sourceUrl = value => {
  if (!object(value) || !text(value.url)) return null;
  try { const url = new URL(value.url); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
};
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const fraction = (numerator, denominator, blocked = false) => ({ numerator, denominator, rate: denominator && !blocked ? numerator / denominator : null });
export const goldDigest = gold => createHash('sha256').update(JSON.stringify(gold)).digest('hex');
const reviewedGroups = (review, replacement = false) => new Set((review?.sourceReviews ?? [])
  .filter(s => text(s.source_group_id) && text(s.reviewedBy) && s.supportsVerdict === 'yes' && (!replacement || s.supportsReplacement === 'yes'))
  .map(s => s.source_group_id)).size;

export function validateGold(gold) {
  requireValue(object(gold) && gold.schemaVersion === 1, 'Gold schemaVersion must be 1.');
  requireValue(text(gold.datasetVersion) && text(gold.handbookRef) && typeof gold.synthetic === 'boolean', 'Gold needs datasetVersion, handbookRef and explicit synthetic flag.');
  requireValue(Array.isArray(gold.claims) && gold.claims.length > 0, 'Gold claims must be a nonempty array.');
  const ids = new Set();
  for (const row of gold.claims) {
    requireValue(object(row) && text(row.id) && !ids.has(row.id), 'Gold claim IDs must be unique nonempty strings.');
    ids.add(row.id);
    requireValue(labels.includes(row.label), `Invalid gold label for ${row.id}.`);
    requireValue(text(row.doc) && text(row.quote) && text(row.verifiedBy), `Gold ${row.id} needs doc, quote and verifiedBy.`);
    for (const key of ['asOfUtc', 'verifiedAtUtc']) {
      requireValue(text(row[key]) && row[key].endsWith('Z') && Number.isFinite(Date.parse(row[key])), `Gold ${row.id} needs a UTC ${key}.`);
    }
    requireValue(Array.isArray(row.referenceUrls) && row.referenceUrls.every(url => {
      try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
    }), `Gold ${row.id} needs HTTP(S) referenceUrls without credentials.`);
    if (!gold.synthetic && row.label !== 'unverifiable') requireValue(row.referenceUrls.length > 0, `Real gold ${row.id} needs source references.`);
  }
}

/** Offline scoring only: human mappings and evidence judgments are inputs. */
export function evaluate(logBytes, gold, review) {
  validateGold(gold);
  const { events, room, warnings } = parseEventLog(logBytes);
  requireValue(events.length > 0, 'No committed events to evaluate.');
  requireValue(object(review) && review.schemaVersion === 1 && review.roomId === room.roomId && review.datasetVersion === gold.datasetVersion, 'Review must name this room and gold dataset version.');
  requireValue(Array.isArray(review.findings), 'Review findings must be an array.');
  requireValue(review.goldDigest === goldDigest(gold), 'Review goldDigest is stale or missing; re-review the frozen gold snapshot.');
  requireValue(room.synthetic === gold.synthetic, 'Synthetic and real gold/log cohorts must not be mixed.');
  const audit = buildAudit(events);
  const findings = new Map();
  for (const event of events) {
    if (!['shelflife.claim.extracted', 'shelflife.verdict.final'].includes(event.type)) continue;
    const p = event.payload;
    requireValue(text(p.claimId), `${event.eventId}: claimId is required.`);
    const finding = findings.get(p.claimId) ?? { claimId: p.claimId, extracted: false, final: null };
    if (event.type === 'shelflife.claim.extracted') { finding.extracted = true; finding.extractedEventId = event.eventId; }
    else {
      requireValue(verdicts.includes(p.verdict) && Array.isArray(p.sources) && (p.correction === null || text(p.correction)), `${event.eventId}: invalid final verdict, sources or correction.`);
      requireValue(p.sources.every(s => sourceUrl(s) && text(s.name) && text(s.domain) && typeof s.snippet === 'string'), `${event.eventId}: malformed citation source.`);
      finding.final = event;
    }
    findings.set(p.claimId, finding);
  }
  for (const finding of findings.values()) requireValue(finding.extracted, `Final verdict ${finding.claimId} has no extracted claim.`);
  const goldById = new Map(gold.claims.map(row => [row.id, row]));
  const matched = new Map();
  const reviewed = new Map();
  for (const row of review.findings) {
    requireValue(object(row) && findings.has(row.claimId) && !reviewed.has(row.claimId), 'Review claimId must exist and appear only once.');
    requireValue(text(row.reviewedBy), `Review ${row.claimId} needs reviewedBy, including for the mapping.`);
    requireValue(row.goldId === null || goldById.has(row.goldId), `Unknown goldId for ${row.claimId}.`);
    if (row.goldId !== null) {
      requireValue(!matched.has(row.goldId), `Multiple findings map to gold ${row.goldId}; adjudicate the duplicate explicitly.`);
      matched.set(row.goldId, row.claimId);
    }
    requireValue(row.finalEventId === (findings.get(row.claimId).final?.eventId ?? null), `Review ${row.claimId} is stale: finalEventId must match the latest final verdict.`);
    requireValue(row.extractedEventId === findings.get(row.claimId).extractedEventId, `Review ${row.claimId} is stale: extractedEventId must match the latest extraction.`);
    requireValue(support.includes(row.citationSupport) && support.includes(row.independentSources) && safety.includes(row.correctionSafety), `Invalid evidence review for ${row.claimId}.`);
    const citedUrls = new Set((findings.get(row.claimId).final?.payload.sources ?? []).map(sourceUrl));
    if (row.citationSupport === 'yes') requireValue(citedUrls.size > 0, `Review ${row.claimId} claims citation support without citations.`);
    if (row.independentSources === 'yes') requireValue(citedUrls.size >= 2, `Review ${row.claimId} claims independent sources without two distinct citations.`);
    requireValue(Array.isArray(row.sourceReviews), `Review ${row.claimId} needs sourceReviews for every cited URL.`);
    const reviewedUrls = new Set();
    for (const source of row.sourceReviews) {
      const url = sourceUrl(source);
      requireValue(url && citedUrls.has(url) && !reviewedUrls.has(url), `Review ${row.claimId}: source URL must be cited and reviewed once.`);
      requireValue(source.source_group_id === null || text(source.source_group_id), `Review ${row.claimId}: source_group_id must be a string or null.`);
      requireValue(support.includes(source.supportsVerdict) && support.includes(source.supportsReplacement), `Review ${row.claimId}: invalid per-source support labels.`);
      requireValue(source.reviewedBy === null || text(source.reviewedBy), `Review ${row.claimId}: invalid source reviewer.`);
      if ([source.supportsVerdict, source.supportsReplacement].includes('yes')) requireValue(text(source.reviewedBy), `Review ${row.claimId}: positive source support needs a reviewer.`);
      reviewedUrls.add(url);
    }
    requireValue(reviewedUrls.size === citedUrls.size, `Review ${row.claimId} must bind every cited URL to a source group/review.`);
    if (findings.get(row.claimId).final?.payload.correction) requireValue(row.correctionSafety !== 'not_applicable', `Correction ${row.claimId} needs a safety judgment.`);
    reviewed.set(row.claimId, row);
  }
  const rows = gold.claims.map(g => {
    const claimId = matched.get(g.id) ?? null;
    const finding = findings.get(claimId);
    return { goldId: g.id, goldLabel: g.label, claimId, extracted: finding?.extracted === true, predicted: finding?.final?.payload.verdict ?? 'missing', finalEventId: finding?.final?.eventId ?? null };
  });
  const extras = [...findings.values()].filter(f => !reviewed.get(f.claimId)?.goldId).map(f => ({ claimId: f.claimId, predicted: f.final?.payload.verdict ?? 'missing', finalEventId: f.final?.eventId ?? null }));
  const confusion = Object.fromEntries(labels.map(label => [label, Object.fromEntries([...verdicts, 'missing'].map(predicted => [predicted, 0]))]));
  for (const row of rows) confusion[row.goldLabel][row.predicted]++;
  const finals = [...findings.values()].filter(f => f.final);
  const stale = finals.filter(f => f.final.payload.verdict === 'stale');
  const cited = finals.filter(f => f.final.payload.sources.length > 0);
  const corrections = finals.filter(f => text(f.final.payload.correction));
  const count = predicate => rows.filter(predicate).length;
  const trueStale = confusion.stale.stale;
  const goldStale = count(r => r.goldLabel === 'stale');
  const isSafe = f => {
    const r = reviewed.get(f.claimId);
    return r?.goldId && goldById.get(r.goldId).label === 'stale' && f.final.payload.verdict === 'stale' && r.citationSupport === 'yes' && r.independentSources === 'yes' && r.correctionSafety === 'safe' && reviewedGroups(r, true) >= 2;
  };
  const reasons = [];
  if (room.synthetic) reasons.push('Synthetic fixture: these are software checks, not real workflow scores.');
  if (room.status !== 'completed') reasons.push('Room did not complete successfully.');
  if (warnings.some(w => w.code === 'incomplete_tail')) reasons.push('Log has an uncommitted tail.');
  if (extras.length) reasons.push('Unmatched extra findings require adjudication and a versioned gold update.');
  if (rows.some(r => r.extracted && r.predicted === 'missing')) reasons.push('Some extracted claims have no final verdict.');
  if (cited.some(f => !['yes', 'no'].includes(reviewed.get(f.claimId)?.citationSupport))) reasons.push('Citation support review is incomplete or inconclusive.');
  if (stale.some(f => !['yes', 'no'].includes(reviewed.get(f.claimId)?.independentSources))) reasons.push('Independent-source review is incomplete or inconclusive.');
  if (stale.some(f => reviewed.get(f.claimId)?.independentSources === 'yes' && reviewedGroups(reviewed.get(f.claimId)) < 2)) reasons.push('Positive independence labels lack two positively reviewed source groups.');
  if (corrections.some(f => reviewed.get(f.claimId)?.correctionSafety === 'safe' && reviewedGroups(reviewed.get(f.claimId), true) < 2)) reasons.push('Safe-correction labels lack two source groups supporting the verdict and replacement.');
  if (corrections.some(f => !['safe', 'unsafe'].includes(reviewed.get(f.claimId)?.correctionSafety))) reasons.push('Correction safety review is incomplete.');
  const usage = {};
  for (const key of ['inputTokens', 'outputTokens', 'costUsd']) {
    const known = audit.runs.filter(r => r.usage?.source === 'provider' && measured(r.usage[key]));
    const estimates = audit.runs.filter(r => r.usage?.source === 'estimated' && measured(r.usage[key]));
    usage[key] = { measuredSubtotal: known.length ? known.reduce((n, r) => n + r.usage[key], 0) : null, measuredRuns: known.length,
      estimatedSubtotal: estimates.length ? estimates.reduce((n, r) => n + r.usage[key], 0) : null, estimatedRuns: estimates.length,
      unknownRuns: audit.runs.length - known.length - estimates.length, completeMeasured: audit.runs.length > 0 && known.length === audit.runs.length };
  }
  return {
    schemaVersion: 1, roomId: room.roomId, datasetVersion: gold.datasetVersion, handbookRef: gold.handbookRef,
    driver: room.driver, synthetic: room.synthetic, transport: 'offline_log', roomStatus: room.status, lastSeq: room.lastSeq,
    publishable: reasons.length === 0, reasons, warnings,
    metrics: {
      stalePrecision: fraction(trueStale, stale.length, extras.length > 0),
      staleRecall: fraction(trueStale, goldStale),
      freshFalsePositiveRate: fraction(confusion.fresh.stale, count(r => r.goldLabel === 'fresh')),
      extractionCoverage: fraction(count(r => r.extracted), rows.length),
      finalVerdictCoverage: fraction(count(r => r.predicted !== 'missing'), rows.length),
      abstentionRate: fraction(count(r => r.predicted === 'unsure'), rows.length),
      abstentionByGold: Object.fromEntries(labels.map(l => [l, fraction(confusion[l].unsure, count(r => r.goldLabel === l))])),
      citationSupport: fraction(cited.filter(f => reviewed.get(f.claimId)?.citationSupport === 'yes' && reviewed.get(f.claimId).sourceReviews.some(s => s.supportsVerdict === 'yes' && text(s.reviewedBy))).length, cited.length),
      independentSupport: fraction(stale.filter(f => reviewed.get(f.claimId)?.independentSources === 'yes' && reviewedGroups(reviewed.get(f.claimId)) >= 2).length, stale.length),
      safeCorrectionRecall: fraction(corrections.filter(isSafe).length, goldStale),
      unsafeCorrections: corrections.filter(f => reviewed.get(f.claimId)?.correctionSafety === 'unsafe' || reviewed.get(f.claimId)?.citationSupport === 'no' || (reviewed.get(f.claimId)?.goldId && goldById.get(reviewed.get(f.claimId).goldId).label !== 'stale')).length,
      unreviewedCorrections: corrections.filter(f => !['safe', 'unsafe'].includes(reviewed.get(f.claimId)?.correctionSafety)).length,
    },
    operations: { attemptedTasks: audit.metrics.totalTasks, acceptedTasks: audit.metrics.acceptedTasks, runs: audit.runs.length,
      failedRuns: audit.runs.filter(r => r.status === 'failed').length, unfinishedRuns: audit.runs.filter(r => r.status === 'running').length,
      searchRetries: audit.metrics.retries, usage },
    confusion, rows, extras,
    evidenceReviews: [...reviewed.values()].map(r => ({ ...r, verdictSourceGroups: reviewedGroups(r), replacementSourceGroups: reviewedGroups(r, true) })),
  };
}

export function scoreFiles(eventsPath, goldPath, reviewPath) {
  const paths = [eventsPath, goldPath, reviewPath].map(path => path instanceof URL ? fileURLToPath(path) : path);
  const buffers = paths.map(path => readFileSync(path));
  const report = evaluate(buffers[0], JSON.parse(buffers[1]), JSON.parse(buffers[2]));
  report.inputs = Object.fromEntries(['events', 'gold', 'review'].map((name, i) => [name, { path: resolve(paths[i]), sha256: createHash('sha256').update(buffers[i]).digest('hex') }]));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    console.error('Usage: node eval/score.mjs <events.jsonl> <gold.json> <review.json>');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(scoreFiles(...args), null, 2)); }
    catch (error) { console.error(`Evaluation failed: ${error.message}`); process.exitCode = 1; }
  }
}
