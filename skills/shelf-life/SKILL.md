---
name: shelf-life
description: Research and check whether a software plan uses current, factually supported industry approaches. Use when a ShallowSee planner or project manager selects technologies, compares production workflows, checks a proposal before handoff, or revalidates an older plan. Presales may use it for feasibility research within its existing search permissions. Return version-bound evidence and updates for the caller; code implementation and publication remain with their assigned roles.
---

# Shelf Life

Give the calling planner or project manager an evidence-backed view of the newest relevant industry solutions and the changes a plan needs. Check both factual freshness and whether the proposed workflow still matches current production practice.

This is a repository-owned Harness skill. It can be performed in the caller's context or by a dedicated research agent dispatched through the Harness. Loading these instructions does not register an executable tool, enforce permissions or demonstrate that the existing audit runner implements this research workflow.

## Invocation and boundaries

- Work on a specified draft or confirmed plan version, project requirements and deployment constraints. Use the actual current time or the caller's explicit historical cutoff; never hard-code a present-day version or year into reusable guidance.
- Search is available only on behalf of `planner`, `project_manager`, or `presales` within their assigned tasks. A research agent inherits its authorized parent task's search scope, budget and cancellation. A developer, tester or support task cannot acquire search access by requesting this skill directly; send its information request through the project manager.
- Use the live search and source-reading tools actually supplied by the Harness. The current project search adapter is Linkup; do not assume it or any browser is available or authenticated. If tools or sources are unavailable, report what remains unverified rather than claiming a fresh check.
- Return findings and proposed plan changes to the caller. Do not change confirmed architecture, edit implementation files, initiate development, publish a PR or accept a project through this skill. Existing user authorization and the caller's plan-confirmation process govern subsequent action.

## What to research

Identify decisions whose answers could have changed: viable architectural options, supported releases, lifecycle and deprecations, compatibility, APIs, operational requirements, pricing/licensing where relevant, and current production workflows. Prioritize decisions that would materially change the implementation or cost.

Actively look for newer viable approaches and credible current industry use, rather than merely finding a citation for the first proposed option. Compare relevant alternatives against the user's scale, deployment environment, team, migration constraints and budget. The planner retains responsibility for the overall design.

Distinguish:

- **Newest available:** recently released or emerging approaches, with release and availability evidence.
- **Current production practice:** approaches supported by up-to-date maintenance information and credible first-party operational or adoption evidence.
- **Older but still current:** established approaches with present-day evidence that they remain supported and appropriate.
- **Superseded or unsupported:** approaches whose assumptions, lifecycle or interfaces no longer fit the task.

Do not silently replace the user's preference for current industry solutions with an outdated familiar stack. Equally, label preview status or missing production evidence instead of presenting novelty as established practice. An old publication alone cannot substantiate a claim about what industry uses today; a recent article alone cannot establish accuracy or adoption.

## Evidence and synthesis

Read primary material supporting each consequential claim: official documentation, lifecycle and release records, maintained reference architectures, and named organizations' own engineering or operations reports. Vendor feature documentation supports feature claims; it does not by itself establish broad industry adoption. Treat comparison summaries and search answers as leads to inspect.

Match evidence to the same version, scope, date, units and deployment conditions. Record actual retrieval time separately from publication, update, release and effective dates. Keep unavailable dates unknown. Distinguish a currently maintained page from an old page newly indexed by search.

For material recommendations, investigate contradictory or superseding evidence. Identify shared publishers and copied sources; different URLs, domains, snippet wording, or a value appearing in text are not proof of independent support. Report a bounded conclusion such as evidence from named deployments rather than inventing an industry consensus.

Assess operational workflow where relevant: build and deployment, testing, observability, rollback, maintenance and other requirements that affect this project. Select checks based on the task rather than forcing every project through a universal architecture checklist.

Use the caller's request/time limits. Reuse evidence only while it remains applicable under the task's freshness policy. Recheck volatile facts and changed decisions; avoid paying to repeat unaffected research. If a material conflict remains after the allowed research, mark it unresolved and return it to the caller.

## Return to the caller

Use the [report contract](references/report.md) when preparing a plan check or machine-readable handoff. Bind findings to the reviewed plan version and content digest. Include the current preferred approach, relevant newer alternatives, production-readiness evidence, actionable plan changes, sources, unresolved issues and recheck conditions.

An overall `current_supported` assessment needs support for the material decisions in the reviewed scope. Mark a known necessary change `update_required`; use `unresolved` when critical evidence is missing or contradictory. Report assessment is bounded research judgment, not a guarantee of truth or future freshness.

The planner revises its proposal using the report. The project manager checks that the report still matches the plan and its freshness conditions before development handoff. Changed material assumptions require another check of affected decisions; confirmed scope changes follow the existing user-confirmation process. Neither a skill invocation nor a completed research run substitutes for plan approval.
