import { callJson, choice, integer, list, object, text } from './shared.mjs';

const score = { ...integer, minimum: 0, maximum: 3 };
export const planReviewSchema = object({
  verdict: choice('approve', 'revise'),
  scores: object({ coversWish: score, feasible: score, testable: score, scoped: score }),
  issues: list(object({ severity: choice('blocker', 'major', 'minor'), text })),
  requiredChanges: list(text),
});

export const finalReviewSchema = object({
  verdict: choice('ship', 'iterate'),
  scores: object({ meetsWish: score, works: score, quality: score }),
  gaps: list(text),
  iterateItems: list(text),
});

const PLAN_SYSTEM = `Independently review the Brief, Research, Spec and Shelf Life planCheck. Compare the outcomes to what
the user wanted. Check feasibility in the workspace, the source evidence, the scope and the acceptance tests.
Score coversWish, feasible, testable and scoped from 0 (missing) to 3 (strong).
List concrete issues with severity and exact changes to request. Approve only when every score is at least 2,
there is no blocker, and the checks objectively verify the promised behavior. Keep requiredChanges empty on approval.
For a completed planCheck, treat uncertain evidence as a major issue to weigh. Require revision when the plan relies
on a stale fact supported by the completed checks. A missing or skipped check provides no factual confirmation.
Calibration example, approve: a local tip calculator covers the requested split, tests exact totals and a zero-person
error, and needs no credentials. Each score is at least 2 and requiredChanges is empty.
Calibration example, revise: a page promises a working forecast but the only check says “the page looks good.”
Testable is 0, the issue is a blocker, and requiredChanges asks for an exact output with known inputs.
You have no tools. Return one PlanReview in the supplied schema and stop. The engine owns identity and version binding.`;

const FINAL_SYSTEM = `Independently review the built product against the original goal captured in the Brief.
Use the Spec, final TestReport, file list, and README excerpt. Base working claims on actual TestReport evidence,
never on the README alone. Score meetsWish, works, and quality from 0 (missing) to 3 (strong).
List remaining gaps honestly. Recommend iterate only when an additional bounded pass on specific existing work items
could close the gaps. Name those item IDs. A ship decision has no iterateItems and is not a declaration of delivery.
You have no tools. Return one FinalReview in the supplied schema and stop. The engine owns reviewer identity.`;

const reviewPlan = {
  name: 'reviewer',
  run({ brief, research, spec, planCheck }, ctx) {
    return callJson(ctx, {
      system: PLAN_SYSTEM, user: { brief, research, spec, planCheck },
      schema: planReviewSchema, name: 'plan_review',
      check: review => review.verdict === 'approve' && review.requiredChanges.length
        ? ['An approval must have an empty requiredChanges array.'] : [],
    });
  },
};

const reviewFinal = {
  name: 'reviewer',
  run(input, ctx) {
    const workItems = new Set(input.spec.workItems.map(item => item.id));
    return callJson(ctx, {
      system: FINAL_SYSTEM, user: input, schema: finalReviewSchema, name: 'final_review',
      check: review => {
        if (review.verdict === 'ship' && review.iterateItems.length) return ['A ship review must have an empty iterateItems array.'];
        if (review.verdict === 'iterate' && (!review.iterateItems.length
          || review.iterateItems.some(itemId => !workItems.has(itemId)))) {
          return ['An iterate review must name existing work items that would repair the gaps.'];
        }
        return [];
      },
    });
  },
};

export const reviewer = { reviewPlan, reviewFinal };
