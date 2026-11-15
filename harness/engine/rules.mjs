// Hard rules the engine applies in code, whatever a model says (ARCHITECTURE §1, artifacts.md).

/** Normalises whatever roles.checkSpecRules returns into a list of plain-English violation strings. */
export function normalizeViolations(result) {
  const list = Array.isArray(result) ? result
    : Array.isArray(result?.violations) ? result.violations
    : Array.isArray(result?.errors) ? result.errors
    : Array.isArray(result?.issues) ? result.issues
    : [];
  return list.map(v => (typeof v === 'string' ? v : v?.message ?? v?.text ?? JSON.stringify(v))).filter(Boolean);
}

const sourceList = sources => (Array.isArray(sources) ? sources.map(s => s?.url).filter(Boolean) : []);
const passed = (finding, name) => Array.isArray(finding?.checks) && finding.checks.some(c => c?.check === name && c.passed === true);

/** Confirmed stale plan facts: verdict stale with independent_sources AND correction_supported passed. */
export function confirmedStaleFindings(planCheck) {
  if (planCheck?.status !== 'completed' || !Array.isArray(planCheck.findings)) return [];
  return planCheck.findings.filter(f => f?.verdict === 'stale' && passed(f, 'independent_sources') && passed(f, 'correction_supported'));
}

export function staleRequiredChange(finding) {
  const urls = sourceList(finding.sources);
  return `Update ${finding.statement} to ${finding.currentValue} (sources: ${urls.length ? urls.join(', ') : 'none listed'})`;
}

/**
 * Applies the plan-review hard rules to the reviewer's raw verdict.
 * Returns { review, approved, overrides } where review has engine-added issues and required changes.
 */
export function applyPlanReviewRules(raw, { violations = [], planCheck = null } = {}) {
  const review = {
    verdict: raw?.verdict === 'approve' ? 'approve' : 'revise',
    scores: { ...(raw?.scores ?? {}) },
    issues: Array.isArray(raw?.issues) ? raw.issues.map(i => ({ ...i })) : [],
    requiredChanges: Array.isArray(raw?.requiredChanges) ? [...raw.requiredChanges] : [],
  };
  const overrides = [];
  const scoreNames = ['coversWish', 'feasible', 'testable', 'scoped'];
  if (review.verdict === 'approve') {
    const low = scoreNames.filter(k => !(typeof review.scores[k] === 'number' && review.scores[k] >= 2));
    const blockers = review.issues.filter(i => i?.severity === 'blocker');
    if (low.length || blockers.length) {
      review.verdict = 'revise';
      overrides.push(low.length ? `approve_rule: scores below 2 (${low.join(', ')})` : 'approve_rule: a blocker issue was listed');
    }
  }
  for (const v of violations) {
    review.issues.push({ severity: 'blocker', text: `Spec rule violation: ${v}` });
    review.requiredChanges.push(`Fix spec rule violation: ${v}`);
  }
  if (violations.length) { review.verdict = 'revise'; overrides.push(`spec_rules: ${violations.length} violation(s)`); }
  const stale = confirmedStaleFindings(planCheck);
  for (const f of stale) {
    review.issues.push({ severity: 'blocker', text: `Plan check: "${f.statement}" is out of date; current value ${f.currentValue}.` });
    review.requiredChanges.push(staleRequiredChange(f));
  }
  if (stale.length) { review.verdict = 'revise'; overrides.push(`plan_check: ${stale.length} confirmed stale fact(s)`); }
  if (review.verdict === 'approve') review.requiredChanges = [];
  return { review, approved: review.verdict === 'approve', overrides };
}

/** Every check of `itemId` in this report passed (and the acceptance tree is intact). */
export function itemChecksPass(report, itemId, spec) {
  if (!report || report.acceptanceIntact !== true) return false;
  const expected = (spec?.acceptance ?? []).filter(c => c.itemId === itemId).map(c => c.id);
  const results = (report.results ?? []).filter(r => r.itemId === itemId);
  if (!results.length) return false;
  const ids = new Set(results.map(r => r.checkId));
  return results.every(r => r.status === 'pass') && expected.every(id => ids.has(id));
}

/**
 * Reflection overrides (artifacts.md): all item checks pass → next (finish on the last item);
 * attempts exhausted → next with the item failed; budget exhausted → stop; a second replan → retry or next.
 */
export function overrideReflection(reflection, { itemPassed, attempt, maxAttempts, isLastItem, limitHit, replansLeft }) {
  const asked = reflection?.decision;
  let decision = ['next', 'retry', 'escalate', 'replan', 'finish', 'stop'].includes(asked) ? asked : 'retry';
  let overriddenBy = null;
  if (limitHit) { decision = 'stop'; overriddenBy = 'budget'; }
  else if (itemPassed) {
    const want = isLastItem ? 'finish' : 'next';
    if (decision !== want && decision !== 'next' && decision !== 'finish') overriddenBy = 'all_checks_pass';
    decision = want;
  } else if (decision === 'replan' && replansLeft <= 0) {
    decision = attempt >= maxAttempts ? 'next' : 'retry';
    overriddenBy = attempt >= maxAttempts ? 'attempts_exhausted' : 'replan_limit';
  } else if ((decision === 'retry' || decision === 'escalate') && attempt >= maxAttempts) {
    decision = 'next'; overriddenBy = 'attempts_exhausted';
  } else if ((decision === 'next' || decision === 'finish') && !itemPassed && attempt < maxAttempts) {
    // The model may move on from a failing item; code allows it (the item is recorded as failed).
  }
  return { decision, overriddenBy };
}

/** True iff the tester's report really shows every check executed and passed. Re-derived, not trusted. */
export function reportAllPassed(report) {
  if (!report || report.allPassed !== true || report.acceptanceIntact !== true) return false;
  const s = report.summary ?? {};
  const results = Array.isArray(report.results) ? report.results : [];
  return s.total > 0 && s.passed === s.total && !s.failed && !s.errored && !s.skipped
    && results.length === s.total && results.every(r => r.status === 'pass');
}

/**
 * Run status (brief 06 §7): delivered iff the final all-scope report passed everything, the final
 * review says ship, and both are bound to the same candidate commit and the approved spec version.
 */
export const isCommitSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

/**
 * Why a final candidate is (not) deliverable, from facts only. `candidateCheck` is the engine's own look at the
 * workspace after the last test: { ok, candidate, reason } where ok means "HEAD equals candidate and the tree is clean".
 * A null or malformed candidate never binds (null === null must not pass), the report must be the scope-"all" one,
 * and the review, the report, the workspace and the approved spec version must all name the same things.
 */
export function bindingProblem({ finalReport, finalReview, approvedSpecVersion, specVersion, candidateCheck }) {
  if (!finalReport) return 'there is no final test report';
  if (finalReport.scope?.kind !== 'all') return 'the final test report does not cover all checks';
  if (!isCommitSha(finalReport.candidate)) return 'the final test report names no valid candidate commit';
  if (!finalReview) return 'there is no final review';
  if (finalReview.candidate !== finalReport.candidate) return 'the final review and the final test report describe different commits';
  if (!Number.isSafeInteger(specVersion) || finalReview.specVersion !== specVersion || approvedSpecVersion !== specVersion) {
    return 'the final review or the approval is not bound to the current spec version';
  }
  if (candidateCheck?.ok !== true || candidateCheck.candidate !== finalReport.candidate) {
    return candidateCheck?.reason ?? 'the workspace was not checked against the tested candidate';
  }
  return null;
}

export function decideStatus({ finalReport, finalReview, approvedSpecVersion, specVersion, limitHit, fatal, candidateCheck }) {
  const anyPassed = (finalReport?.summary?.passed ?? 0) > 0;
  if (fatal) return anyPassed ? 'partial' : 'failed';
  const bound = bindingProblem({ finalReport, finalReview, approvedSpecVersion, specVersion, candidateCheck }) === null;
  if (!limitHit && reportAllPassed(finalReport) && finalReview?.verdict === 'ship' && bound) return 'delivered';
  return anyPassed ? 'partial' : 'failed';
}

/** Build order respecting dependsOn; ties keep the planner's order. Unknown deps are ignored; cycles fall back to spec order. */
export function orderItems(items) {
  const list = Array.isArray(items) ? items : [];
  const ids = new Set(list.map(i => i.id));
  const done = new Set();
  const out = [];
  while (out.length < list.length) {
    const next = list.find(i => !done.has(i.id) && (i.dependsOn ?? []).every(d => !ids.has(d) || done.has(d)));
    const pick = next ?? list.find(i => !done.has(i.id));
    done.add(pick.id);
    out.push(pick);
  }
  return out;
}
