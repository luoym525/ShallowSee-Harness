import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareReview } from '../prepare-review.mjs';
import { evaluate, goldDigest } from '../score.mjs';

const gold = JSON.parse(readFileSync(new URL('../fixtures/synthetic-gold.json', import.meta.url)));
const log = readFileSync(new URL('../../samples/shelf-life-room.sample.jsonl', import.meta.url));
const events = () => log.toString().trim().split('\n').map(JSON.parse);
const encode = rows => rows.map(e => JSON.stringify(e)).join('\n') + '\n';

test('draft binds current IDs and cited URLs but cannot masquerade as human review', () => {
  const draft = prepareReview(log, gold);
  assert.equal(draft.goldDigest, goldDigest(gold));
  assert.equal(draft.preparation.synthetic, true);
  assert.equal(draft.findings.length, 3);
  assert.equal(draft.findings[0].extractedEventId, 'evt_0017');
  assert.equal(draft.findings[0].finalEventId, 'evt_0033');
  for (const row of draft.findings) {
    assert.equal(row.goldId, null);
    assert.equal(row.reviewedBy, null);
    assert.equal(row.citationSupport, 'unreviewed');
    assert.equal(row.independentSources, 'unreviewed');
    assert.equal(row.correctionSafety, 'unreviewed');
    for (const source of row.sourceReviews) {
      assert.equal(source.source_group_id, null);
      assert.equal(source.reviewedBy, null);
      assert.equal(source.supportsVerdict, 'unreviewed');
      assert.equal(source.supportsReplacement, 'unreviewed');
    }
  }
  assert.throws(() => evaluate(log, gold, draft), /needs reviewedBy/);
});

test('latest final replaces prior URL bindings and canonical duplicates appear once', () => {
  const data = events();
  const final = structuredClone(data.find(e => e.eventId === 'evt_0033'));
  Object.assign(final, { eventId: 'replacement-final', seq: data.length + 1, timestamp: data.at(-1).timestamp });
  final.payload.sources = [{ ...final.payload.sources[0], url: 'https://NEW.example:443/page' }, { ...final.payload.sources[0], url: 'https://new.example/page' }];
  data.push(final);
  const row = prepareReview(encode(data), gold).findings[0];
  assert.equal(row.finalEventId, 'replacement-final');
  assert.deepEqual(row.sourceReviews.map(s => s.url), ['https://new.example/page']);
});

test('extracted-only claims stay unresolved and incomplete tails are disclosed', () => {
  const data = events();
  const extraction = structuredClone(data.find(e => e.eventId === 'evt_0017'));
  Object.assign(extraction, { eventId: 'unresolved', seq: data.length + 1, timestamp: data.at(-1).timestamp });
  extraction.payload.claimId = 'new-claim';
  data.push(extraction);
  const draft = prepareReview(encode(data) + '{"torn":', gold);
  assert.equal(draft.findings.at(-1).finalEventId, null);
  assert.deepEqual(draft.findings.at(-1).sourceReviews, []);
  assert.equal(draft.preparation.warnings[0].code, 'incomplete_tail');
});

test('invalid logs, cohort mismatch and credential-bearing URLs are rejected', () => {
  const data = events();
  assert.throws(() => prepareReview(log, { ...gold, synthetic: false }), /needs source references/);
  data[0].payload.synthetic = false;
  assert.throws(() => prepareReview(encode(data), gold), /cohorts/);
  data[0].payload.synthetic = true;
  const final = data.find(e => e.eventId === 'evt_0033');
  final.payload.sources = [{ ...final.payload.sources[0], url: 'https://secret@example.com/page' }];
  assert.throws(() => prepareReview(encode(data), gold), /invalid source URL/);
  data[1].seq = 8;
  assert.throws(() => prepareReview(encode(data), gold), /seq/);
});

test('a draft becomes scoreable only after explicit fixture review fields are filled', () => {
  const reviewed = JSON.parse(readFileSync(new URL('../fixtures/synthetic-review.json', import.meta.url)));
  const draft = prepareReview(log, gold);
  for (const row of draft.findings) Object.assign(row, reviewed.findings.find(r => r.claimId === row.claimId));
  const report = evaluate(log, gold, draft);
  assert.equal(report.metrics.safeCorrectionRecall.numerator, 1);
  assert.equal(report.publishable, false);
  assert.equal(report.synthetic, true);
});

test('empty/no-claim inputs fail and preparing never mutates input bytes or gold', () => {
  const beforeLog = Buffer.from(log);
  const beforeGold = structuredClone(gold);
  prepareReview(log, gold);
  assert.deepEqual(log, beforeLog);
  assert.deepEqual(gold, beforeGold);
  assert.throws(() => prepareReview('', gold), /No committed events/);
  assert.throws(() => prepareReview(encode(events().slice(0, 1)), gold), /No extracted claims/);
});

test('new extraction bindings supersede prior IDs without matching to gold', () => {
  const data = events();
  const extraction = structuredClone(data.find(e => e.eventId === 'evt_0017'));
  Object.assign(extraction, { eventId: 'new-extraction', seq: data.length + 1, timestamp: data.at(-1).timestamp });
  data.push(extraction);
  const row = prepareReview(encode(data), gold).findings[0];
  assert.equal(row.extractedEventId, 'new-extraction');
  assert.equal(row.goldId, null);
});
