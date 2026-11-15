import { callJson, choice, list, nullable, object, text } from './shared.mjs';

export const reflectionSchema = object({
  itemId: text,
  decision: choice('next', 'retry', 'escalate', 'replan', 'finish', 'stop'),
  reason: text,
  fixInstructions: nullable(text),
  lessons: list(text, 0, 3),
});

const SYSTEM = `Decide the next useful action for the current work item. The TestReport is evidence, the BuildResult is
the builder's account, and progress notes record earlier attempts. Use the TestReport to identify the failure and quote
brief exact evidence in concrete fixInstructions for retry, escalation, or replan. State which item or file needs a
change and what the check expects. Use escalate when the same failure repeats or the builder lacked capability.
Use replan only when a requirement or check is impossible or contradicts the wish. If the current item passes its
checks, move on or finish. Record zero to three durable lessons. The engine owns budget and stopping rules.
You have no tools. Return one Reflection for the supplied item in the given JSON schema and stop.`;

export const reflector = {
  name: 'reflector',
  run(input, ctx) {
    const user = { ...input, progress: input.progress?.slice(-6000) };
    return callJson(ctx, {
      system: SYSTEM, user, schema: reflectionSchema, name: 'reflection',
      check: value => {
        if (value.itemId !== input.item.id) return ['Use the exact ID of the current work item.'];
        if (['retry', 'escalate', 'replan'].includes(value.decision) && !value.fixInstructions?.trim()) {
          return ['The repair decision requires concrete fixInstructions that refer to test evidence.'];
        }
        return [];
      },
    });
  },
};
