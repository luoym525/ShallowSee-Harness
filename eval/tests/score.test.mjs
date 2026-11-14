import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate, goldDigest, scoreFiles } from '../score.mjs';

const logPath = new URL('../../samples/shelf-life-room.sample.jsonl', import.meta.url);
const goldPath = new URL('../fixtures/synthetic-gold.json', import.meta.url);
const reviewPath = new URL('../fixtures/synthetic-review.json', import.meta.url);
const input = () => ({
  events: readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse),
  gold: JSON.parse(readFileSync(goldPath)), review: JSON.parse(readFileSync(reviewPath)),
});
const encode = events => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const score = ({ events, gold, review }) => evaluate(encode(events), gold, review);
const append = (data, type, payload, extra = {}) => {
  const last = data.events.at(-1);
  data.events.push({ ...last, ...extra, seq: last.seq + 1, eventId: `test-${last.seq + 1}`, type, payload });
  return data.events.at(-1);
};

test('synthetic report has counts, provenance, unknown usage and input hashes', () => {
  const report = scoreFiles(logPath, goldPath, reviewPath);
  assert.deepEqual(report.metrics.staleRecall, { numerator: 1, denominator: 1, rate: 1 });
  assert.equal(report.metrics.safeCorrectionRecall.numerator, 1);
  assert.equal(report.confusion.unverifiable.unsure, 1);
  assert.equal(report.driver, 'harness');
  assert.equal(report.synthetic, true);
  assert.equal(report.publishable, false);
  assert.equal(report.operations.usage.costUsd.unknownRuns, 2);
  assert.equal(report.operations.usage.costUsd.completeMeasured, false);
  assert.match(report.inputs.events.sha256, /^[a-f0-9]{64}$/);
});

test('missing extraction is distinct from unsure, and zero denominator is null', () => {
  const data = input();
  data.gold.claims.push({ ...data.gold.claims[0], id: 'not-extracted' });
  data.review.goldDigest = goldDigest(data.gold);
  const report = score(data);
  assert.equal(report.confusion.stale.missing, 1);
  assert.equal(report.confusion.unverifiable.unsure, 1);
  assert.equal(report.metrics.staleRecall.rate, 0.5);
  assert.equal(report.metrics.extractionCoverage.rate, 0.75);
  data.gold.claims = data.gold.claims.filter(c => c.label !== 'fresh');
  data.review.findings = data.review.findings.filter(f => f.claimId !== 'c2');
  data.review.goldDigest = goldDigest(data.gold);
  assert.equal(score(data).metrics.freshFalsePositiveRate.rate, null);
});

test('extras block final precision and one-to-one matching is enforced', () => {
  const data = input();
  data.review.findings = data.review.findings.filter(f => f.claimId !== 'c1');
  const report = score(data);
  assert.equal(report.extras[0].claimId, 'c1');
  assert.equal(report.metrics.stalePrecision.denominator, 1);
  assert.equal(report.metrics.stalePrecision.rate, null);
  assert.equal(report.confusion.stale.missing, 1);
  data.review.findings[1].goldId = data.review.findings[0].goldId;
  assert.throws(() => score(data), /Multiple findings/);
});

test('latest final verdict and gold changes invalidate prior human reviews', () => {
  const data = input();
  const previous = data.events.find(e => e.eventId === 'evt_0033');
  append(data, previous.type, previous.payload);
  assert.throws(() => score(data), /finalEventId/);
  data.review.findings[0].finalEventId = data.events.at(-1).eventId;
  data.gold.claims[0].label = 'fresh';
  assert.throws(() => score(data), /goldDigest/);
  data.review.goldDigest = goldDigest(data.gold);
  const report = score(data);
  assert.equal(report.metrics.unsafeCorrections, 1);
  assert.equal(report.metrics.safeCorrectionRecall.rate, null);
});

test('latest extraction invalidates the mapping and real/synthetic mixing fails', () => {
  const data = input();
  const extracted = data.events.find(e => e.eventId === 'evt_0017');
  append(data, extracted.type, { ...extracted.payload, quote: 'Changed quote' });
  assert.throws(() => score(data), /extractedEventId/);
  data.review.findings[0].extractedEventId = data.events.at(-1).eventId;
  data.events[0].payload.synthetic = false;
  assert.throws(() => score(data), /cohorts/);
});

test('unknown zero values remain unknown; estimates are separate; direct is retained', () => {
  const data = input();
  data.events[0].payload.driver = 'direct';
  for (const e of data.events.filter(e => e.type === 'run.completed')) e.payload.usage = { source: 'unknown', inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let report = score(data);
  assert.equal(report.driver, 'direct');
  assert.equal(report.operations.usage.costUsd.measuredSubtotal, null);
  assert.equal(report.operations.usage.costUsd.unknownRuns, 5);
  data.events.find(e => e.type === 'run.completed').payload.usage = { source: 'estimated', inputTokens: 10, outputTokens: 20, costUsd: 0.1 };
  report = score(data);
  assert.equal(report.operations.usage.costUsd.measuredSubtotal, null);
  assert.equal(report.operations.usage.costUsd.estimatedSubtotal, 0.1);
  assert.equal(report.operations.usage.costUsd.unknownRuns, 4);
});

test('log validation rejects gaps and reports incomplete tails without inventing results', () => {
  const data = input();
  const report = evaluate(encode(data.events) + '{"seq":82', data.gold, data.review);
  assert.equal(report.lastSeq, 81);
  assert.ok(report.reasons.some(r => r.includes('uncommitted tail')));
  data.events[1].seq = 10;
  assert.throws(() => score(data), /seq/);
});

test('task acceptance is revoked by a later review; model completion is separate', () => {
  const data = input();
  const before = score(data).operations;
  append(data, 'task.review', { version: 6, requestedBy: 'm_reviewer', artifactIds: [] }, { taskId: 'task_patch' });
  const after = score(data).operations;
  assert.equal(after.acceptedTasks, before.acceptedTasks - 1);
  assert.equal(after.runs, before.runs);
});

test('positive human labels cannot invent absent or duplicate citations', () => {
  const data = input();
  const final = data.events.find(e => e.eventId === 'evt_0033');
  const sources = final.payload.sources;
  final.payload.sources = [];
  assert.throws(() => score(data), /without citations/);
  final.payload.sources = [sources[0], sources[0]];
  assert.throws(() => score(data), /two distinct citations/);
  final.payload.sources = [null];
  assert.throws(() => score(data), /malformed citation/);
});

test('mirror domains from one publisher receive no independent/safe correction credit', () => {
  const data = input();
  const row = data.review.findings[0];
  row.sourceReviews[1].source_group_id = row.sourceReviews[0].source_group_id;
  const report = score(data);
  assert.equal(report.metrics.independentSupport.numerator, 0);
  assert.equal(report.metrics.safeCorrectionRecall.numerator, 0);
  assert.equal(report.evidenceReviews[0].verdictSourceGroups, 1);
  assert.ok(report.reasons.some(r => r.includes('two positively reviewed source groups')));
});

test('two groups need positive reviews for both verdict and replacement', () => {
  const data = input();
  data.review.findings[0].sourceReviews[1].supportsReplacement = 'unreviewed';
  let report = score(data);
  assert.equal(report.metrics.independentSupport.numerator, 1);
  assert.equal(report.metrics.safeCorrectionRecall.numerator, 0);
  data.review.findings[0].sourceReviews[1].supportsVerdict = 'unclear';
  report = score(data);
  assert.equal(report.metrics.independentSupport.numerator, 0);
  for (const source of data.review.findings[0].sourceReviews) { source.source_group_id = null; source.supportsVerdict = 'yes'; }
  report = score(data);
  assert.equal(report.metrics.citationSupport.numerator, 2);
  assert.equal(report.metrics.independentSupport.numerator, 0);
});

test('source review bindings reject uncited, missing, duplicated and unsigned entries', () => {
  const data = input();
  const row = data.review.findings[0];
  row.sourceReviews[0].url = 'https://uncited.example/page';
  assert.throws(() => score(data), /must be cited/);
  row.sourceReviews[0].url = data.events.find(e => e.eventId === 'evt_0033').payload.sources[0].url;
  row.sourceReviews[0].reviewedBy = null;
  assert.throws(() => score(data), /needs a reviewer/);
  row.sourceReviews[0].reviewedBy = 'test-reviewer';
  row.sourceReviews.push(row.sourceReviews[0]);
  assert.throws(() => score(data), /reviewed once/);
  row.sourceReviews = [];
  assert.throws(() => score(data), /bind every cited URL/);
});
