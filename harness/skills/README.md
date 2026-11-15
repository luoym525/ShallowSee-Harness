# Built-in skills

Register a skill in `SKILLS` in `index.mjs`.
Export its ID, name, description, version, needs, allowed phases, input and output schemas, and asynchronous `run(input, ctx)`.
Keep phase and role dispatch in the engine.
Accept the routed model and optional search through the trusted context.
Use a distinct child room for every invocation that writes audit evidence.
Pass cancellation into providers and await settlement before closing evidence.
Return a typed result with a redacted reason on failure.
[Read the Shelf Life skill](shelf-life/SKILL.md).

Run offline checks with `node --test harness/skills/shelf-life/index.test.mjs`.
