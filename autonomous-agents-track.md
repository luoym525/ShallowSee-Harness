# Imperial AI Hack: Autonomous Agents Track (summary)

> **Correction, Sat 14 Nov 14:10, from the Devpost rules page.** Lines below that say otherwise are out of date.
>
> - **Submission:** a demo video of up to 2 minutes and a public GitHub repository. The video and the last commit must both be before Sun 12:00.
> - **Round one, 13:00–16:30:** a 10-minute slot. The judges watch the video, then ask questions for 6 minutes. No slides and no live demo. The top two per panel run their product live at about 15:50.
> - **Scoring for this track (each marked 0 to 3, then weighted):** does it work 30, technical depth 25, usefulness 20, video and answers 15, originality 10.
> - **Bounties:** up to 2 from your own track, judged on how central the partner's tool is to the product. Figma and Adaption are open to every track and do not count toward the 2.
> - **Code:** work must start after 12:10 on Saturday.

*Source: imperialaihack.com (event data in `data.js`), read Sat 14 Nov 2026. Check anything marked "unconfirmed" at the Help Desk (Huxley, floor 2).*

## The brief
> Agents that research, write and run code, and **reliably finish real multi-step tasks**.

- **Sponsors:** Databricks · Linkup · Synthesia · Tavily · MongoDB
- **Judging:** live presentation to judges. Sun 13:00–16:30, **Blackett LT1**. Your slot will be announced. No demo video needed.
- **Finals:** track winners present on the main stage. Sun 17:00, Clore Lecture Theatre. Prizes follow at 17:30 in Blackett LT1.

## Prizes
All cash prizes are paid as Amazon vouchers. Credits and merch come from partners.

| Prize | Award | What they want |
|---|---|---|
| **1st place** | £500 | Best project in the track |
| **2nd place** | £200 | |
| **Databricks bounty** | **£960 + swag** | Build on the Databricks Data Intelligence Platform: a pipeline, agent or app. Scored on **creativity, technical depth and real-world impact**. |
| **Best use of Linkup** | **£560 + credits** | An agent built around Linkup live web search that **researches, verifies or acts on fresh information, citing its sources**. |
| Best use of Synthesia | 50,000 credits | The best product built with Synthesia's Interactive Avatar API. |
| Best use of Tavily | 30K / 20K / 10K credits | Best use of the Tavily search API, for example a stale-answer detector or a pre-meeting briefing agent. |
| MongoDB | Atlas voucher | An AI app or agent with MongoDB Atlas at its core, such as Vector Search or agent memory. |

**Extra prizes, open to every track (on top of your main track):**

| Prize | Award | How to qualify |
|---|---|---|
| **Best-Designed AI Product (Figma)** | **£960 + merch** | Design it in Figma or build it with Figma Make. In the presentation, explain why you qualify and show evidence of using Figma. |
| Best Use of Adaption | $1,000 inference credits **per team member** + merch | Fine-tune a model with Adaption. Ranked on Adaption's leaderboard by win rate against the base model. Show evidence in the presentation. |

### Most cash one project can win
£500 (1st) + £960 (Databricks) + £560 (Linkup) + £960 (Figma) = **£2,980**, plus credits. That's the highest cash ceiling at the event. The poker track tops out at £500 plus speakers and AirPods.

Unconfirmed: whether one project can win the track prize *and* several bounties. The site says teams "may also pursue any bounty within that track", which suggests yes.

## Free credits and perks
Claim them by logging in under **My Pass** on the site.
- **Everyone:** Anthropic $50, Databricks Free Edition, MongoDB $50 Atlas, Adaption 1,250 credits, fal $25, ElevenLabs Creator, Lovable Pro (100 credits), Tamarind Bio 200 jobs, Figma Education.
- **Track perks:** Synthesia workspace, LiveKit keys, **Tavily coupon**, MongoDB Student Pack, Anam API access.

## Key times
| When | What |
|---|---|
| Sat 15:00–15:30 | Reply workshop, Huxley 308 |
| **Sat 15:30–15:55** | **Linkup talk, Huxley 308**. Go: it's a £560 bounty, and you can ask them what they're looking for. |
| Sat 19:00 | Dinner (Domino's), Huxley 341/342 |
| **Sat 21:00** | **Building closes. No overnight hacking.** |
| Sun 10:00 | Doors reopen, breakfast |
| **Sun 12:00** | **Submissions close** (Devpost). Nothing can change after this. |
| Sun 13:00–16:30 | Judging, Blackett LT1 |
| Sun 17:00 / 17:30 | Finals (Clore) / prizes (Blackett LT1) |

**Real build time left (from about 13:00 Sat): about 8 h Saturday + 2 h Sunday morning ≈ 10 hours.** Plan the scope for that.

## Submission (Devpost)
Submit at https://imperial-ai-hackathon.devpost.com/
- A public GitHub repository with a README
- A short description: the problem, what you built, how it works
- A list of the APIs, models and datasets you used

**Rules:**
- All code must be written during the hackathon.
- Pretrained models, public APIs and open-source libraries are allowed; say which ones you used.
- Teams of 1–4.
- Projects must follow the code of conduct.
- You pick **one** main track (01–05). The Figma and Adaption prizes stack on top of it.

## How to win as much as possible

**Build one project that genuinely qualifies for several bounties:**
1. **Linkup as the agent's eyes.** Live web search for research and verification, and **show citations** in the UI. This is exactly their scoring line.
2. **Databricks as the backbone.** Store the agent's runs, findings and evaluation results in Delta tables, and run the pipeline or job there. You could add a Databricks app or dashboard. Their criteria reward *technical depth and real-world impact*, so show a real data pipeline, not a token API call.
3. **Figma Make for the front end.** Design the UI in Figma and keep screenshots of the process as evidence for the £960 design prize.
4. Optional extras:
   - **MongoDB Atlas** as agent memory or vector search (voucher).
   - **Tavily** as a second search source (credits). Linkup and Tavily overlap, so make Linkup the hero.

**Win the main track by proving "reliably finishes multi-step tasks":**
- Run a small evaluation: N real tasks → success rate, time taken, cost. Put the numbers on a slide.
- Do a live demo end to end, with the agent visibly planning, using tools, checking its own work and recovering from an error.
- Have a recorded backup run in case Wi-Fi or an API fails on stage.

### Idea sketches that fit all the bounties
- **Claim / fact verifier agent:** paste a claim, article or report. The agent breaks it into sub-claims, researches each with Linkup, gives a verdict with sources, and logs everything to Databricks. A dashboard shows reliability across many runs.
- **Stale-knowledge detector:** points at a knowledge base (docs, a FAQ, a course wiki), finds answers that are now out of date using fresh web results, drafts fixes with citations, and runs as a scheduled Databricks job.
- **Pre-meeting or due-diligence briefing agent:** give it a company or person and a goal. It researches, cross-checks, and writes a cited one-page brief, with memory of past briefs (MongoDB) and run analytics (Databricks).

## Risks and trade-offs
- **Crowded and judged on the pitch.** Expect this to be the most popular track. Polish and a clear story matter as much as the code.
- **Little time.** About 10 build hours. Keep the core loop small and make it reliable.
- **One main track only.** Going for Agents means the poker bot (already built) is no longer your team's main entry. Confirm at the Help Desk whether a team can still enter the poker tournament alongside another track; the rules suggest not.
- **Bounty rules unconfirmed.** Ask the Databricks and Linkup reps exactly what counts as "best use", and how they judge (separately, or during track judging).

## To do in the next hour
- [ ] Decide on the idea and the bounties to target (Linkup + Databricks + Figma recommended).
- [ ] Claim credits under My Pass: Anthropic, Databricks Free Edition, MongoDB, Tavily coupon.
- [ ] Create the GitHub repo (public) and the Devpost project.
- [ ] Assign roles: agent core / Databricks pipeline / Figma UI / evaluation + pitch.
- [ ] Attend the Linkup talk, 15:30, Huxley 308.
