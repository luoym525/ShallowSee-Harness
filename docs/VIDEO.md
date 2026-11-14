# The 2-minute video

**Status: draft script, written Sat 14 Nov 17:35.** Nothing has been recorded. Every number in ⟨angle brackets⟩ is a blank to fill from a real run and a human-checked answer key. If a number does not exist by recording time, cut the sentence; never estimate it.

## Why the video carries most of the score

In round one the judges only see this video and then ask questions for 6 minutes. There are no slides and no live demo. The table below is the team's planning summary of the judging criteria; confirm the current organizer rules and deadline before submission:

| Criterion | Weight | What in the video earns it |
|---|---|---|
| Does it work | 30 | One real run from start to finish, with real searches and a real pull request |
| Technical depth | 25 | Checks done in code, the single event log, the evaluation against a human-checked key |
| Usefulness | 20 | A stale fact in a handbook turned into a cited one-line fix a person can approve |
| Video and answers | 15 | Clear story, honest labels, and a team that can answer the questions below |
| Originality | 10 | The agent refuses to edit when its evidence is weak, and says so |

The video must be uploaded, and the last commit made, before **Sun 15 Nov 12:00**. Aim to finish by 11:00.

## Script

Target duration: 2:00. Time the final spoken text and actual footage; shorten it as needed.

| Time | On screen | Voice |
|---|---|---|
| 0:00–0:12 | A handbook page. One line is highlighted: "The latest stable release of Python is Python 3.11." | "Every team's documentation goes stale quietly. Now assistants read those documents and repeat the stale facts with confidence." |
| 0:12–0:24 | Title: Shelf Life. A strip of six steps: read, extract, search, verdict, check, patch. | "Shelf Life is an agent that audits a document against the live web, finds what has gone out of date, and proposes a cited fix for a person to review." |
| 0:24–0:50 | The real command in a terminal, then the workbench timeline filling up. Caption on screen: "Real run at ⟨N⟩× speed. Actual time ⟨m:ss⟩." | "This is a real run. It pulls out each checkable claim, searches twice with Linkup, and asks Claude for a verdict using only those sources." |
| 0:50–1:12 | The findings page: an old value and its replacement, two sources from different sites, four passed checks. Then one claim marked "unsure". | "Code checks whether the quote is in the document, two different sites have snippets containing the new value, and the edit changes one value on one line. A person still checks the meaning and source independence. When the evidence is weak, it says 'unsure' and leaves the line alone." |
| 1:12–1:25 | The pull request on GitHub: one-line changes, and a description listing the sources. | "Proposed corrections can become a pull request, with their sources listed for a person to check and approve." |
| 1:25–1:45 | The evaluation table. Caption: "24 facts, 14 deliberately aged. Answer key checked by hand." | "We tested it on a handbook where we deliberately aged fourteen facts. It caught ⟨X⟩, raised ⟨Y⟩ false alarms and left ⟨Z⟩ for a person. A human-checked answer key decides those numbers, not the agent." |
| 1:45–1:57 | One diagram: a single event log feeding the live view, replay and evaluation. Add a dashboard only after its integration has been implemented and demonstrated. | "Everything the agent does is one append-only event log. The live view, the replay and the evaluation read that same log." |
| 1:57–2:00 | Closing card: Shelf Life, team ShallowSee, the repository address. | "Shelf Life. Keep your docs true." |

## Rules for recording

1. **Real means real.** The run in the video uses real Linkup searches and a real model, on the pages in `handbook/`. A synthetic or sample log never appears as a result.
2. **Label what is changed.** Sped-up footage shows its speed and the true duration on screen. A replay of a saved run is labelled "replay of a saved run".
3. **Say what the run is.** The current runner is a direct workflow. Do not call it multi-agent orchestration, and do not show the router or the collaboration platform, which are deferred.
4. **Show one honest miss.** Keep the "unsure" claim in. It is the most persuasive ten seconds in the video.
5. **No keys on screen.** Record the terminal after the keys are loaded, and never open `.env`.
6. **Record twice.** Take the first full recording on Saturday night as soon as a real run and a pull request exist. Re-record on Sunday morning only if something improved.

7. **Get version-specific owner approval before uploading or publishing.** This document authorizes no recording, upload or publication. The owner's review workflow and any active platform pause remain in force.

## What must exist before recording

- [ ] A completed real run on at least one handbook page, visible in the workbench
- [ ] A pull request opened from that run, with sources in its description
- [ ] The answer key checked by a person, and the evaluation run against it
- [ ] The three numbers ⟨X⟩, ⟨Y⟩, ⟨Z⟩ taken from that evaluation report
- [ ] Optional: the Databricks dashboard, only if it reads real run data

## Questions to prepare for

The team gets 6 minutes of questions. Each person should be able to answer these in two sentences.

1. Is this an agent or a pipeline? What does it decide for itself?
2. What stops it from "correcting" a fact that was right?
3. How do you know two sources are independent and not copies of each other?
4. Where do the evaluation numbers come from, and who checked the answer key?
5. What does one claim cost in time and tokens?
6. Why is Linkup central to it? What would break without it?
7. What did you plan and not build? (The model router and the multi-agent platform.)
8. How would this work on a company's private documents?
