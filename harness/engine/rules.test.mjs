import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindingProblem, decideStatus, isCommitSha, overrideReflection, reportAllPassed } from './rules.mjs';

const SHA = 'b'.repeat(40);
const report = (extra = {}) => ({
  scope: { kind: 'all' }, candidate: SHA, acceptanceIntact: true, allPassed: true,
  summary: { total: 2, passed: 2, failed: 0, errored: 0, skipped: 0 },
  results: [{ status: 'pass' }, { status: 'pass' }], ...extra,
});
const good = (extra = {}) => ({
  finalReport: report(), finalReview: { verdict: 'ship', candidate: SHA, specVersion: 1 }, approvedSpecVersion: 1, specVersion: 1,
  limitHit: null, fatal: false, candidateCheck: { ok: true, candidate: SHA, reason: null }, ...extra,
});

test('decideStatus: delivered only with a valid SHA bound across report, review and workspace check', () => {
  assert.equal(decideStatus(good()), 'delivered');
});

test('decideStatus (P1 regression): null candidates on both the report and the review never deliver', () => {
  const nulls = good({ finalReport: report({ candidate: null }), finalReview: { verdict: 'ship', candidate: null, specVersion: 1 }, candidateCheck: { ok: true, candidate: null, reason: null } });
  assert.equal(decideStatus(nulls), 'partial');
  assert.match(bindingProblem(nulls), /no valid candidate commit/);
  const undef = good({ finalReport: report({ candidate: undefined }), finalReview: { verdict: 'ship', specVersion: 1 } });
  assert.equal(decideStatus(undef), 'partial');
});

test('decideStatus: every binding link is required', () => {
  const cases = {
    'review names another commit': good({ finalReview: { verdict: 'ship', candidate: 'c'.repeat(40), specVersion: 1 } }),
    'review for another spec version': good({ finalReview: { verdict: 'ship', candidate: SHA, specVersion: 2 } }),
    'approval for another spec version': good({ approvedSpecVersion: 2 }),
    'no approval': good({ approvedSpecVersion: null }),
    'null spec version everywhere': good({ specVersion: null, approvedSpecVersion: null, finalReview: { verdict: 'ship', candidate: SHA, specVersion: null } }),
    'report is item scope': good({ finalReport: report({ scope: { kind: 'item', itemId: 'W1', includeRegression: true } }) }),
    'report has no scope': good({ finalReport: report({ scope: undefined }) }),
    'workspace check missing': good({ candidateCheck: null }),
    'workspace check failed': good({ candidateCheck: { ok: false, candidate: SHA, reason: 'dirty' } }),
    'workspace check for another commit': good({ candidateCheck: { ok: true, candidate: 'c'.repeat(40), reason: null } }),
    'no review': good({ finalReview: null }),
    'review says iterate': good({ finalReview: { verdict: 'iterate', candidate: SHA, specVersion: 1 } }),
    'a limit was hit': good({ limitHit: 'usd' }),
    'a check skipped': good({ finalReport: report({ summary: { total: 2, passed: 1, failed: 0, errored: 0, skipped: 1 }, results: [{ status: 'pass' }, { status: 'skipped' }] }) }),
    'acceptance tampered': good({ finalReport: report({ acceptanceIntact: false }) }),
  };
  for (const [name, input] of Object.entries(cases)) assert.notEqual(decideStatus(input), 'delivered', name);
  assert.equal(decideStatus(good({ finalReport: report({ candidate: 'zz' }) })), 'partial');
  const failing = report({ summary: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0 }, results: [{ status: 'fail' }], allPassed: false });
  assert.equal(decideStatus({ ...good(), finalReport: failing }), 'failed');
  assert.equal(decideStatus(good({ fatal: true })), 'partial');
});

test('isCommitSha accepts only 40 lowercase hex characters', () => {
  assert.equal(isCommitSha(SHA), true);
  for (const bad of [null, undefined, '', 'B'.repeat(40), 'b'.repeat(39), 'b'.repeat(41), 'g'.repeat(40), 123, {}]) assert.equal(isCommitSha(bad), false);
});

test('reportAllPassed re-derives the verdict from summary and results, not from the tester flag', () => {
  assert.equal(reportAllPassed(report()), true);
  assert.equal(reportAllPassed(report({ results: [{ status: 'pass' }] })), false);
  assert.equal(reportAllPassed(report({ summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 }, results: [] })), false);
});

test('overrideReflection: passed → next/finish, exhausted → next, limit → stop, replan budget respected', () => {
  const base = { itemPassed: false, attempt: 1, maxAttempts: 3, isLastItem: false, limitHit: false, replansLeft: 1 };
  assert.deepEqual(overrideReflection({ decision: 'retry' }, { ...base, itemPassed: true }), { decision: 'next', overriddenBy: 'all_checks_pass' });
  assert.equal(overrideReflection({ decision: 'retry' }, { ...base, itemPassed: true, isLastItem: true }).decision, 'finish');
  assert.deepEqual(overrideReflection({ decision: 'escalate' }, { ...base, attempt: 3 }), { decision: 'next', overriddenBy: 'attempts_exhausted' });
  assert.equal(overrideReflection({ decision: 'retry' }, { ...base, limitHit: true }).decision, 'stop');
  assert.equal(overrideReflection({ decision: 'replan' }, base).decision, 'replan');
  assert.equal(overrideReflection({ decision: 'replan' }, { ...base, replansLeft: 0 }).decision, 'retry');
});
