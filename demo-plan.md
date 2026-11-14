# Shelf Life: 20-hour demo plan

> **Updated Sat 14 Nov, 14:10.** This plan was written before the team merged it with the harness design and before the official judging rules were checked.
>
> - **Still valid:** the Shelf Life workflow, the planted-fact evaluation, the fallbacks and the Databricks notes.
> - **No longer valid:** the Python-only build, the slides and the 3-minute live pitch.
> - **Judging (Devpost rules page):** a demo video of up to 2 minutes, then 6 minutes of questions. No slides and no live demo in round one; the top two per panel run live at about 15:50. Scoring: does it work 30, technical depth 25, usefulness 20, video and answers 15, originality 10.
> - **Bounties:** a team may enter 2 from its track (Linkup and Databricks), plus Figma, which does not count toward the 2.
>
> The merged plan is in [coordination-notes.md](coordination-notes.md) and the shared interface is [docs/CONTRACT.md](docs/CONTRACT.md).

*Autonomous Agents track, Imperial AI Hack. Written Sat 14 Nov 2026, 13:00. "Shelf Life" is a working name. The idea is a recommendation, picked from the three sketches in [autonomous-agents-track.md](autonomous-agents-track.md).*

## Outline

**In one line:** an agent that checks a knowledge base against the live web, finds the facts that have gone out of date, and opens a pull request with the corrections, each backed by sources.

**The problem, as said on stage:** every company is pointing a chatbot at its documentation. The documentation went stale months ago, so the chatbot is confidently wrong.

**What the agent does:**

1. Reads a folder of documents: a small company handbook kept in a GitHub repository.
2. Pulls out the claims that can go out of date, such as prices, version numbers, rates, limits and dates.
3. Searches the live web for each claim with Linkup.
4. Gives each claim a verdict (fresh, stale or unsure) with at least two sources.
5. Checks its own correction with a second search. If the sources disagree it rewords the search and tries again, and if it still can't tell it marks the claim "unsure" for a person.
6. Rewrites the stale lines and opens a pull request listing every change with its sources.
7. Logs every step to Databricks, where a dashboard shows how reliable it is.

**Why this idea:**

- It verifies and then acts, which covers Linkup's whole scoring line ("researches, verifies or acts on fresh information, citing its sources").
- A regular check over a table of documents is a real Databricks pipeline, not a token API call.
- Tavily's bounty text names "a stale-answer detector" as an example.
- It comes with its own reliability test: plant facts you know are stale and count how many it catches. That number is the proof of "reliably finishes".

**Prizes targeted:** track placing (£500 / £200), Databricks (£960), Linkup (£560), Figma (£960). Tavily credits only as a stretch.

**Built with:** Python; Claude Opus 5.5 (`claude-opus-5-5`, on the $50 Anthropic credit) to extract claims and write verdicts; Linkup as the agent's only search tool; Databricks for the run log, tables and dashboard; an interface designed in Figma Make.

**Real and staged.** Real: the agent loop, the searches, the sources, the pull request, the logging and the evaluation numbers. Staged: you write the handbook and plant the stale facts yourself (say so on stage: "we aged a handbook by 18 months"), it runs on your laptop only, and it reads one kind of input, a folder of Markdown files. Left out: logins, deployment, other document sources, MongoDB, Synthesia and Adaption.

## Plan

The clock runs from 13:00 Saturday (hour 0) to 09:00 Sunday (hour 20). Submissions close at 12:00 Sunday, so hours 20 to 23 are spare. About 11 of the 20 hours are working time; the rest is dinner, travel and sleep.

Two lanes run side by side from the first hour:

- **Build** is the code: the agent, the Databricks pipeline, the wiring.
- **Show** is everything the judges see: the script, the design, the numbers, the slides, the rehearsal.

If you are solo, you take the Show lane and drive Claude Code on the Build lane. With teammates, split the same way.

Three rules keep it a demo: write the script first and build only what appears in it; stop adding features when the building closes at 21:00; spend everything after that on proof, slides, backup and rehearsal.

### Hours 0–1.5 (Sat 13:00–14:30): lock the story, test the risky parts

Show
- [ ] Write the 3-minute script (the five beats under "The pitch").
- [ ] Claim credits under My Pass: Anthropic, Databricks Free Edition, Figma Education, Tavily coupon.
- [ ] Create the public GitHub repository and a Devpost draft.
- [ ] Ask the Help Desk: how long a judging slot is, whether there is a scoring sheet, whether one project can win the track and several bounties, and whether choosing this track ends your poker entry.
- [ ] Ask the Databricks rep how the bounty is judged, and whether hackers can get a full workspace (one without the Free Edition network limit).

Build
- [ ] Set up the repository. Add `.env` to `.gitignore` before the first commit, because the repository is public and will hold API keys locally.
- [ ] Three tests, 20 minutes each: Linkup returns an answer with sources; Claude returns a list of claims in a fixed JSON shape; a row written from your laptop appears in a Databricks table.

**Gate:** all three tests pass, or you have switched to the fallback for the one that failed.

### Hours 1.5–4 (14:30–17:00): one claim, end to end

Build
- [ ] One command takes one document and prints its claims, the Linkup sources and a verdict for each claim. The same run writes rows to Databricks.

Show
- [ ] Write the handbook: about 10 short documents holding about 40 checkable facts. Make half of them stale on purpose by using the value from a year or two ago. Check every fact by hand and record the truth in an answer-key file. Put the handbook in its own public repository.
- [ ] 15:30–15:55, Huxley 308: Linkup talk. Ask what "best use" means to them, whether they judge separately, and what the rate limits are.
- [ ] Open Figma Make and generate the first screen. Screenshot your prompts and frames as you go; the Figma prize needs evidence.

**Gate (17:00):** a real claim has a cited verdict, visible in the terminal and in Databricks.

### Hours 4–6 (17:00–19:00): make it an agent

Build
- [ ] Run across the whole handbook.
- [ ] Self-check: a correction needs two sources that agree. If they disagree, search again with a reworded query; if it is still unclear, mark the claim "unsure".
- [ ] Retry when a search fails or comes back empty.
- [ ] Rewrite the stale lines and open the pull request on the handbook repository.
- [ ] Write every step as an event to one log file. The interface, Databricks and the backup replay all read that same log.

Show
- [ ] Finish three screens in Figma Make: the live run, the findings with their sources, and reliability.
- [ ] Lay out the Databricks dashboard: stale facts per document, the mix of verdicts, time and cost per claim, and the evaluation score.

**Gate (19:00):** the agent opens a pull request from a full run.

*19:00–19:30: dinner.*

### Hours 6.5–8 (19:30–21:00): make it visible

Build and Show together
- [ ] Connect the interface to the event log, both live and as a replay (a saved run played back with no internet).
- [ ] Add the Databricks job that turns raw events into the tables behind the dashboard.
- [ ] Do one full run-through of the script with the real interface, and save that run's log as the replay.

**Gate (21:00, building closes):** the scripted demo works once from start to finish. No new features after this.

### Hours 8.5–11 (21:30–00:00, at home): proof and pitch

- [ ] Start the evaluation: the whole handbook, three times. It runs unattended while you do the rest.
- [ ] Five slides: hook, demo, numbers, how it works and why you qualify, close.
- [ ] Write the README with a diagram and the list of APIs, models and datasets (Devpost asks for these), then the Devpost description.
- [ ] Record the whole demo as a screen recording. This is the last-resort backup.
- [ ] Screenshot the Databricks dashboard.

**Gate:** evaluation numbers are on a slide and the backup is recorded.

*00:00–08:00: sleep. You are judged on a live talk, so this is part of the plan.*

### Hours 19–20 (Sun 08:00–09:00): rehearse

- [ ] Two timed run-throughs, out loud. Fix only what breaks the demo.

**Done at hour 20.**

### Spare (Sun 09:00–13:00)

- [ ] 10:00, doors open: test on the venue Wi-Fi, then test the replay with Wi-Fi off.
- [ ] Submit on Devpost by 11:00. It closes at 12:00 and nothing can change afterwards.
- [ ] 12:00–13:00: rehearse once more.

## The pitch

The site gives no slot length and no scoring sheet. Plan for 3 minutes, and keep a 5-minute version that adds a second finding and the Figma process.

| Beat | Time | What happens |
|---|---|---|
| Hook | 20 s | One stale fact on screen, and the line about the confidently wrong chatbot. |
| Live demo | 90 s | Run on one handbook page. Claims appear, sources stream in, a verdict turns "stale" with two sources, one search comes back unclear and the agent tries again, then the pull request opens on GitHub. |
| Proof | 30 s | The Databricks dashboard: "40 planted facts, 3 full runs: caught X of 20 stale, Y false alarms, Z seconds and £C per claim." |
| How it works | 30 s | One diagram. Say out loud why you qualify for Linkup, Databricks and Figma, and show the Figma file beside the running app. |
| Close | 10 s | "Point it at your real wiki and it runs every night." |

For the live part: one click to start, nothing typed on stage, large text, and the replay open in a second tab. Put one deliberately hard claim on the demo page so the retry is visible.

## If you fall behind

Cut in this order:

1. Stretch items. Only start these if the 21:00 gate was passed early: a run on a real public set of documents with one real finding to show; Tavily as a second opinion when Linkup's sources disagree; letting a judge supply a fact.
2. The pull request. Show the corrected text and its sources in the interface instead.
3. The Databricks job. Keep the tables and the dashboard and write to them directly.

Do not cut the sources on screen, the evaluation numbers, the replay and recording, or the rehearsals.

## Risks and fallbacks

| Risk | Fallback |
|---|---|
| Databricks Free Edition limits its compute to "a limited set of trusted domains", so an agent running inside it may not reach Linkup or Claude. | The agent runs on your laptop and only writes results to Databricks. Don't run the agent inside a Databricks job unless the rep gives you a full workspace. |
| Writing to Databricks from your laptop with a token is untested on Free Edition. | Upload the log file through the Databricks web page and load it with the job. |
| Free Edition shuts compute down for the rest of the day if you exceed its quota. | Screenshot the dashboard on Saturday night. Use Databricks lightly on Sunday before your slot. |
| The stage Wi-Fi or an API fails. | Play the saved run in the same interface. The screen recording sits behind that. |
| A live run is too slow. | The live run covers one page. The dashboard shows the full overnight run. |
| The Figma Make output won't connect to your code within 45 minutes. | Keep the Figma design as your evidence and rebuild the page by hand from it. |
| The Anthropic credit runs low. | A rough estimate is $3 for one full handbook run on Opus 5.5. Check the balance after the first full run and size the evaluation to fit. |
| A planted fact turns out to be wrong. | The answer key is checked by hand on Saturday afternoon, before any evaluation run. |
