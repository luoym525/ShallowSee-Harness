import { callJson, choice, list, nullable, object, text } from './shared.mjs';

export const briefSchema = object({
  title: text, restatedGoal: text, targetUser: text,
  productKind: choice('web_page', 'web_app', 'cli_tool', 'script', 'data_report', 'other'),
  mustHaves: list(text, 2, 8),
  niceToHaves: list(text),
  assumptions: list(object({ topic: text, assumed: text, why: text })),
  constraints: list(text),
  researchQuestions: list(text, 1, 5),
  refused: nullable(object({ reason: text })),
});

const SYSTEM = `Turn the user's wish into a Brief for a small, useful, finished product. The input contains the original wish.
State the user and goal plainly. List two to eight visible capabilities, separate extras from essentials,
and write one to five concise research questions that resolve actual implementation uncertainty.
Never ask the user a question. Record significant ambiguities as assumptions with a choice and a reason.
Prefer a small local tool that works without credentials, payments, or private accounts.
Set refused only for an unsafe or impossible wish, such as weapons, malware, harassment, or a task
that requires private accounts or payment. For a refusal, keep the other fields brief and neutral and avoid harmful detail.
You have no tools in this call. Stop after returning one Brief in the supplied JSON schema.`;

export const intake = {
  name: 'intake',
  run(input, ctx) {
    return callJson(ctx, { system: SYSTEM, user: { wish: input.wish }, schema: briefSchema, name: 'brief' });
  },
};
