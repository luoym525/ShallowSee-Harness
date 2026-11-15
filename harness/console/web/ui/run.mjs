// run.mjs: the Live run screen (#/runs/:id, #/runs/:id/report, #/runs/:id/files).
// Everything shown is derived from the event stream through model.mjs. No HTML is ever built from data.

import {
  createRunView, applyEvent, LOOP_STAGES, loopStageForPhase, roleLabel, statusLabel, statusTone, isFinishedStatus,
  shortModelName, modelFamilyName, formatUsd, formatDuration, formatPercent, elapsedMs, offsetLabel, spendLabel, iterationLabel,
  approvalBadge, whoIsWorking, modelsTable, itemStatusLabel, factCheckRows, factCheckSummary, safeUrl, domainOf,
} from "../model.mjs";
import { renderMarkdown } from "../markdown.mjs";
import { h, icon, chip, button, clear, setMarkdown, toast, add } from "./dom.mjs";
import { get, post, artifactPath, filePath, previewUrl, followRun } from "./api.mjs";

// The Live run shows one loop stage at a time. By default it follows the stage that is running;
// clicking a stage pins it until "Follow live". Activity (the timeline) and Models are one click away.
const STAGE_INFO = {
  plan: { label: "Plan", empty: "Researching the wish and writing a plan." },
  build: { label: "Build", empty: "Work items appear here once the plan is approved." },
  test: { label: "Test", empty: "Each work item is tested by a different model after it is built." },
  reflect: { label: "Reflect", empty: "After each test, a model decides what happens next: move on, retry, or use a stronger model." },
};
const DECISION_LABEL = { next: "Move on", retry: "Retry with fixes", escalate: "Retry with a stronger model", replan: "Revise the plan", finish: "Finish", stop: "Stop" };
const OVERRIDE_NOTE = { all_checks_pass: "Set by the harness: all checks pass.", attempts_exhausted: "Set by the harness: attempts used up.", budget: "Set by the harness: budget used up." };

export function mountRun(root, runId, { tab = "run", setConnection }) {
  const view = createRunView(runId);
  const ui = { showTools: false, open: new Set(), reports: new Map(), loading: new Set(), serverState: null, artifacts: [], notFound: false, streamState: "connecting", files: null, fileView: null, reportMd: undefined, tab, view: null };
  let raf = 0;
  let stream = null;
  let ticker = null;
  const tl = { map: new Map() };

  // ---------------------------------------------------------------- skeleton
  const els = {};
  const page = h("div", { class: "run" });
  els.head = h("section", { class: "run-head" });
  els.tabs = h("nav", { class: "tabs", "aria-label": "Run views" });
  els.body = h("div", { class: "run-body" });
  page.append(els.head, els.tabs, els.body);
  clear(root).append(page);

  const stableTimeline = h("ol", { class: "timeline", "aria-live": "polite" });
  const timelineCard = buildTimelineCard();

  // ---------------------------------------------------------------- data
  (async () => {
    const res = await get(`/api/runs/${encodeURIComponent(runId)}`);
    if (res.ok) {
      ui.serverState = res.data.state;
      ui.artifacts = res.data.artifacts || [];
    } else if (res.status === 404) {
      ui.notFound = true;
      render();
      return;
    }
    render();
    stream = followRun(runId, {
      getLastSeq: () => view.lastSeq,
      onEvent: (env) => { applyEvent(view, env); schedule(); },
      onState: (s) => { ui.streamState = s; updateConnection(); schedule(); },
    });
  })();
  ticker = setInterval(updateClock, 1000);

  function updateConnection() {
    if (!setConnection) return;
    if (ui.streamState === "live") setConnection(isFinishedStatus(view.status) ? "Run finished" : "Live", isFinishedStatus(view.status) ? "muted" : "good");
    else if (ui.streamState === "ended") setConnection("Run finished", "muted");
    else setConnection("Reconnecting…", "warn");
  }

  // Render at most once per frame. A timeout backs up requestAnimationFrame, which never fires in a hidden tab.
  let timer = 0;
  function schedule() {
    if (raf || timer) return;
    const run = () => {
      if (!raf && !timer) return;
      cancelAnimationFrame(raf); clearTimeout(timer); raf = 0; timer = 0;
      render(); updateConnection(); loadReports();
    };
    raf = requestAnimationFrame(run);
    timer = setTimeout(run, 120);
  }

  function loadReports() {
    for (const c of view.planChecks) if (c.reportPath && c.status !== "running") loadReport(c.reportPath);
    if (view.factCheck?.reportPath && view.factCheck.status !== "running") loadReport(view.factCheck.reportPath);
  }

  // Run records are JSON artifacts; each is fetched once. undefined = not asked yet, null = not available.
  function loadReport(name) {
    if (!name || ui.reports.has(name) || ui.loading.has(name)) return;
    ui.loading.add(name);
    get(artifactPath(runId, name)).then((res) => {
      ui.loading.delete(name);
      ui.reports.set(name, res.ok && res.data ? res.data : null);
      schedule();
    });
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (ui.notFound) {
      clear(els.head);
      clear(els.tabs);
      clear(els.body).append(h("div", { class: "empty-card" }, h("h2", null, "We couldn't find this run"), h("p", { class: "muted" }, "It may have been deleted, or the link is wrong."), h("a", { class: "btn primary", href: "#/runs" }, "See all runs")));
      return;
    }
    renderHead();
    renderTabs();
    if (ui.tab === "report") renderReportTab();
    else if (ui.tab === "files") renderFilesTab();
    else renderRunTab();
    updateClock();
  }

  const wishText = () => view.wish || ui.serverState?.wish || "…";
  const status = () => (view.eventCount ? view.status : ui.serverState?.status || view.status);

  function renderHead() {
    const st = status();
    const tone = statusTone(st);
    const spend = spendLabel(view);
    const best = view.best?.score ?? ui.serverState?.best?.score ?? null;
    const finalScore = view.finished?.finalScore ?? view.finalTest?.score ?? null;
    const running = !isFinishedStatus(st);
    const head = clear(els.head);
    add(head,
      h("div", { class: "run-title" },
        h("div", { class: "eyebrow" }, "Your wish"),
        h("h1", { class: "wish" }, `“${wishText()}”`),
        h("div", { class: "badges" },
          h("span", { class: `pill ${tone}${running && st === "running" ? " pulse" : ""}`, "data-testid": "status-pill" }, statusLabel(st)),
          view.synthetic ? chip("Synthetic replay", "warn", { title: "Canned sample data from the mock server, not a real run. Whatever you type, it replays the same umbrella example.", "data-testid": "synthetic-label" }) : null,
          chip(view.autonomy === "confirm_plan" ? "You confirm the plan" : "Full autopilot", "muted"),
          view.title ? chip(view.title, "muted") : null,
          running && view.eventCount ? button("Cancel run", { variant: "ghost danger sm", class: "cancel-btn", onclick: cancelRun }, "stop") : null,
        ),
      ),
      h("div", { class: "metrics" },
        metric("Elapsed", h("span", { id: "elapsed" }, "—"), null, "elapsed"),
        metric("Spend", spend.text, spend.note || null, "spend"),
        metric("Iteration", iterationLabel(view), "build attempts", "iteration"),
        metric(finalScore !== null && isFinishedStatus(st) ? "Final score" : "Best score", formatPercent(finalScore !== null && isFinishedStatus(st) ? finalScore : best), view.best?.commit ? `commit ${String(view.best.commit).slice(0, 7)}` : null, "score"),
      ),
    );
  }

  function metric(label, value, note, testid) {
    return h("div", { class: "metric", "data-testid": testid }, h("div", { class: "metric-label" }, label), h("div", { class: "metric-value" }, value), note ? h("div", { class: "metric-note" }, note) : null);
  }

  function updateClock() {
    const el = document.getElementById("elapsed");
    if (!el) return;
    el.textContent = formatDuration(elapsedMs(view, Date.now()));
  }

  async function cancelRun() {
    const res = await post(`/api/runs/${encodeURIComponent(runId)}/cancel`, {});
    toast(res.ok ? "Cancelling…" : "Couldn't cancel the run.", res.ok ? "info" : "bad");
  }

  function renderTabs() {
    const finished = isFinishedStatus(status());
    const hasReport = ui.artifacts.includes("REPORT.md") || view.artifacts.includes("REPORT.md") || !!view.finished?.reportPath;
    const t = clear(els.tabs);
    const mk = (id, label, enabled, href) => h("a", { class: `tab${ui.tab === id ? " active" : ""}${enabled ? "" : " disabled"}`, href: enabled ? href : null, "aria-current": ui.tab === id ? "page" : null, "aria-disabled": enabled ? null : "true", title: enabled ? null : "Available when the run has finished" }, label);
    t.append(mk("run", "Live run", true, `#/runs/${runId}`), mk("report", "Report", hasReport || finished, `#/runs/${runId}/report`), mk("files", "Files", finished || view.artifacts.length > 0, `#/runs/${runId}/files`));
  }

  // ---- Run tab: the stage bar (Plan · Build · Test · Reflect, Activity, Models) and one panel
  let runShell = null;
  function renderRunTab() {
    if (!runShell || !els.body.contains(runShell)) {
      clear(els.body);
      els.banner = h("div", { class: "banner-slot" });
      els.stagebar = h("div", { class: "stagebar" });
      els.panel = h("div", { class: "panel" });
      els.panelView = null;
      runShell = h("div", { class: "run-shell" }, els.banner, els.stagebar, els.panel);
      els.body.append(runShell);
    }
    renderBanner();
    const shown = shownView();
    renderStagebar(shown);
    syncTimeline();
    if (shown === "activity") {
      // The timeline is updated in place; re-attaching it every frame would reset its scroll and open rows.
      if (els.panelView !== "activity") { clear(els.panel).append(timelineCard); els.panelView = "activity"; }
      return;
    }
    els.panelView = shown;
    let { main, side } = panelParts(shown);
    main = main.filter(Boolean); side = side.filter(Boolean);
    if (!main.length) { main = side; side = []; }
    if (!main.length) main = [h("p", { class: "panel-empty" }, STAGE_INFO[shown]?.empty || "Nothing here yet.")];
    const grid = h("div", { class: `panel-grid${side.length ? "" : " single"}`, "data-view": shown, "data-testid": `panel-${shown}` }, h("div", { class: "panel-col" }, main));
    if (side.length) grid.append(h("div", { class: "panel-col side" }, side));
    clear(els.panel).append(grid);
  }

  // The stage that is running now (null once the run has finished).
  function liveStage() {
    if (view.status === "awaiting_confirmation") return "plan";
    if (isFinishedStatus(status())) return null;
    return loopStageForPhase(view.phase) || "plan";
  }

  function shownView() {
    if (ui.view) return ui.view;
    return liveStage() || "test";
  }

  function pick(next) {
    ui.view = next;
    render();
  }

  // Has this stage run at least once? Stages repeat each iteration, so earlier ones stay "done".
  function stageHappened(id) {
    if (id === "plan") return !!(view.plan || view.reviews.length || view.approval);
    if (id === "build") return view.builds.length > 0 || view.items.some((i) => i.attempts > 0);
    if (id === "test") return view.tests.length > 0;
    return view.reflections.length > 0 || !!view.finalReview;
  }

  function stageMeta(id) {
    if (id === "plan") {
      const b = approvalBadge(view);
      if (b.state === "auto") return "Auto-approved";
      if (b.state === "confirmed") return "Confirmed by you";
      if (b.state === "awaiting") return "Waiting for you";
      if (b.state === "model") return "Approved";
      if (b.state === "revise") return "Being revised";
      if (b.state === "pending") return "In review";
      return liveStage() === "plan" ? (PHASE_WORD[view.phase] || "Working") : "Not started";
    }
    if (id === "build") {
      const items = view.items;
      if (!items.length) return "Not started";
      const done = items.filter((i) => i.status === "passed").length;
      return `${done} of ${items.length} passed`;
    }
    if (id === "test") {
      const t = view.tests[view.tests.length - 1];
      if (!t) return "Not started";
      return `${t.scope === "all" ? "Final" : t.itemId}: ${t.passed}/${t.total} checks`;
    }
    const r = view.reflections[view.reflections.length - 1];
    if (r) return `${r.itemId ? `${r.itemId}: ` : ""}${DECISION_LABEL[r.decision] || "Continue"}`;
    return view.finalReview ? "Final review done" : "Not started";
  }
  const PHASE_WORD = { intake: "Reading the wish", research: "Researching", plan: "Planning", plan_check: "Checking facts", plan_review: "In review", scaffold: "Setting up" };

  function renderStagebar(shown) {
    const finished = isFinishedStatus(status());
    const live = liveStage();
    const tabs = h("div", { class: "stage-tabs", role: "group", "aria-label": "Loop stages" });
    for (const id of LOOP_STAGES) {
      const state = id === live ? "now" : stageHappened(id) ? "done" : "";
      const selected = shown === id;
      tabs.append(h("button", { type: "button", class: `stage-tab${selected ? " selected" : ""}`, "aria-pressed": selected ? "true" : "false", "data-stage-tab": id, onclick: () => pick(id) },
        h("span", { class: `stage-bar ${state}`, "aria-hidden": "true" }),
        h("span", { class: "stage-name" }, STAGE_INFO[id].label, state === "now" ? h("span", { class: "stage-now" }, "now") : null),
        h("span", { class: "stage-meta" }, stageMeta(id))));
    }
    const viewBtn = (id, label, iconName) => h("button", { type: "button", class: `view-btn${shown === id ? " on" : ""}`, "aria-pressed": shown === id ? "true" : "false", "data-view-btn": id, onclick: () => pick(shown === id ? null : id) }, icon(iconName, 14), h("span", null, label));
    clear(els.stagebar).append(tabs, h("div", { class: "view-btns" },
      ui.view && !finished && ui.view !== live ? h("button", { type: "button", class: "follow-btn", onclick: () => pick(null), title: "Show the stage that is running now" }, h("span", { class: "dot", "aria-hidden": "true" }), "Follow live") : null,
      viewBtn("activity", "Activity", "list"),
      viewBtn("models", "Models", "layers")));
  }

  // What each view shows: the main column and a narrower side column (dropped when empty).
  function panelParts(id) {
    const who = id === liveStage() ? whoCard() : null;
    switch (id) {
      case "plan": return { main: [approvalCard(), planCheckCard()], side: [who, sourcesCard()] };
      case "build": return { main: [itemsCard()], side: [who] };
      case "test": return { main: [latestTestCard()], side: [who, testsHistoryCard()] };
      case "reflect": return { main: [latestDecisionCard(), finalReviewCard()], side: [who, factCheckCard()] };
      case "models": return { main: [modelsCard()], side: [] };
      default: return { main: [], side: [] };
    }
  }

  // ---- Test: the latest test with its evidence, and every test so far
  function latestTestCard() {
    const t = view.tests[view.tests.length - 1];
    if (!t) return null;
    const ok = t.total > 0 && t.passed === t.total && t.acceptanceIntact;
    const card = h("section", { class: "card", "aria-label": "Latest test", "data-testid": "latest-test" },
      h("div", { class: "card-head" }, h("h2", null, "Latest test")),
      h("div", { class: "big-line" }, h("span", { class: `result-mark ${ok ? "good" : "bad"}`, "aria-hidden": "true" }, icon(ok ? "check" : "x", 13)), `${t.scope === "all" ? "Final test" : t.itemId} · ${t.passed} of ${t.total} checks passed`),
      h("p", { class: "muted sm", style: "margin-top:6px" }, [`Tested by ${shortModelName(t.testerModel)}`, t.candidate ? `candidate ${String(t.candidate).slice(0, 7)}` : null, t.acceptanceIntact ? null : "acceptance tests were modified, so every result counts as failed"].filter(Boolean).join(" · ")));
    const holder = h("div", { class: "evidence" });
    card.append(holder);
    const report = t.reportPath ? ui.reports.get(t.reportPath) : null;
    if (report) holder.append(evidenceTable(report, { compact: true }));
    else if (t.reportPath && report === undefined) { holder.append(h("p", { class: "muted sm" }, "Loading the evidence…")); loadReport(t.reportPath); }
    else if (t.failures.length) holder.append(h("ul", { class: "fail-list" }, t.failures.map((f) => h("li", null, h("b", { class: "mono" }, `${f.checkId} `), f.message))));
    return card;
  }

  function testsHistoryCard() {
    if (view.tests.length < 2) return null;
    return h("section", { class: "card", "aria-label": "All tests" },
      h("div", { class: "card-head" }, h("h2", null, "All tests"), h("span", { class: "muted sm num" }, String(view.tests.length))),
      h("ul", { class: "test-list" }, view.tests.slice().reverse().map((t) => {
        const ok = t.total > 0 && t.passed === t.total && t.acceptanceIntact;
        return h("li", null,
          h("span", { class: `result-mark ${ok ? "good" : "bad"}`, "aria-hidden": "true" }, icon(ok ? "check" : "x", 10)),
          h("span", null, t.scope === "all" ? "Final test" : t.itemId),
          h("span", { class: "muted num" }, `${t.passed}/${t.total}`),
          h("span", { class: "num" }, formatPercent(t.score)));
      })));
  }

  // ---- Reflect: the latest decision, earlier ones, and the final review
  function latestDecisionCard() {
    const rs = view.reflections;
    if (!rs.length) return null;
    const last = rs[rs.length - 1];
    const card = h("section", { class: "card", "aria-label": "Latest decision", "data-testid": "latest-decision" },
      h("div", { class: "card-head" }, h("h2", null, "Latest decision")),
      h("div", { class: "big-line" }, `${DECISION_LABEL[last.decision] || "Continue"}${last.itemId ? ` · ${last.itemId}` : ""}`),
      last.reason ? h("p", { class: "reason" }, last.reason) : null,
      OVERRIDE_NOTE[last.overriddenBy] ? h("p", { class: "muted sm", style: "margin-top:6px" }, OVERRIDE_NOTE[last.overriddenBy]) : null);
    if (rs.length > 1) {
      card.append(h("ul", { class: "decision-list", "aria-label": "Earlier decisions" }, rs.slice(0, -1).reverse().map((r) => h("li", null,
        h("span", { class: "d-item" }, r.itemId || "Run"),
        h("span", null, DECISION_LABEL[r.decision] || "Continue"),
        r.reason ? h("span", { class: "muted d-reason" }, r.reason) : null))));
    }
    return card;
  }

  function finalReviewCard() {
    const f = view.finalReview;
    if (!f) return null;
    const verdict = f.verdict ? String(f.verdict).replace(/_/g, " ") : "Done";
    return h("section", { class: "card", "aria-label": "Final review", "data-testid": "final-review" },
      h("div", { class: "card-head" }, h("h2", null, "Final review"), f.reviewerModel ? h("span", { class: "muted sm" }, shortModelName(f.reviewerModel)) : null),
      h("div", { class: "big-line" }, verdict.charAt(0).toUpperCase() + verdict.slice(1)),
      f.gaps.length ? [h("p", { class: "muted sm", style: "margin-top:12px" }, "Known gaps"), h("ul", { class: "gap-list" }, f.gaps.map((g) => h("li", null, g)))] : null);
  }

  function renderBanner() {
    const slot = clear(els.banner);
    const st = status();
    if (view.status === "awaiting_confirmation") {
      const b = approvalBadge(view);
      slot.append(h("div", { class: "banner warn" },
        h("div", { class: "banner-text" }, h("strong", null, "Your confirmation is needed"), h("span", null, `${b.label}. Building starts when you confirm plan v${b.specVersion ?? "?"}.`)),
        button("Confirm plan", { variant: "primary", onclick: confirmPlan, "data-testid": "confirm-plan" }, "check")));
      return;
    }
    if (!isFinishedStatus(st) || !view.finished) return;
    const f = view.finished;
    const tone = statusTone(st);
    const hasProduct = !!(f.previewPath || ui.serverState?.previewPath);
    const checks = view.finalTest ? `${view.finalTest.passed}/${view.finalTest.total} checks passed` : null;
    const headline = st === "delivered" ? "Delivered" : st === "partial" ? "Partly delivered" : st === "cancelled" ? "Cancelled" : "The run didn't finish";
    slot.append(h("div", { class: `banner ${tone}`, "data-testid": "result-banner" },
      h("div", { class: "banner-text" },
        h("strong", null, `${headline}${checks ? ` · ${checks}` : ""}`),
        h("span", null, f.summary || ""),
        h("span", { class: "banner-meta" }, [f.minutes !== null ? `${f.minutes.toFixed(1)} min` : null, f.spentUsd !== null ? `${formatUsd(f.spentUsd)}${view.spend.source === "estimated" ? " (estimated)" : ""}` : "cost unknown", `${view.iteration} build attempts`].filter(Boolean).join(" · "))),
      h("div", { class: "banner-actions" },
        hasProduct ? h("a", { class: "btn primary big", href: previewUrl(runId), target: "_blank", rel: "noopener noreferrer", "data-testid": "open-product" }, icon("external", 16), h("span", null, "Open the product")) : null,
        h("a", { class: "btn secondary", href: `#/runs/${runId}/report` }, icon("file", 15), h("span", null, "Read the report")),
        h("a", { class: "btn secondary", href: `#/runs/${runId}/files` }, icon("folder", 15), h("span", null, "Browse files")))));
  }

  async function confirmPlan() {
    const res = await post(`/api/runs/${encodeURIComponent(runId)}/confirm`, {});
    if (!res.ok || !res.data?.ok) toast("The plan couldn't be confirmed right now.", "bad");
  }

  // ---- work items
  function itemsCard() {
    const items = view.items;
    const done = items.filter((i) => i.status === "passed").length;
    const card = h("section", { class: "card", "aria-label": "Work items", "data-testid": "work-items" },
      h("div", { class: "card-head" }, h("h2", null, "Work items"), items.length ? chip(`${done} of ${items.length} passed`, done === items.length && items.length ? "good" : "muted") : null));
    if (!items.length) {
      card.append(h("p", { class: "muted empty-line" }, "The work items appear here once the plan is approved."));
      return card;
    }
    const list = h("ul", { class: "items" });
    for (const it of items) {
      const active = view.currentItemId === it.id && !isFinishedStatus(status()) && (it.status === "building" || it.status === "testing" || it.status === "built" || it.status === "retrying" || view.phase === "reflect");
      const score = it.lastScore;
      const tone = it.status === "passed" ? "good" : it.status === "failed" ? "bad" : it.status === "retrying" ? "warn" : "info";
      list.append(h("li", { class: `item ${it.status}${active ? " current" : ""}`, "data-item": it.id },
        h("span", { class: `item-dot ${tone}`, "aria-hidden": "true" }, it.status === "passed" ? icon("check", 12) : it.status === "failed" ? icon("x", 12) : null),
        h("div", { class: "item-main" },
          h("div", { class: "item-title" }, h("b", null, it.id), h("span", null, it.title)),
          h("div", { class: "item-meta" },
            chip(itemStatusLabel(it.status), tone),
            it.difficulty ? chip(it.difficulty, "muted") : null,
            it.attempts > 0 ? chip(`${it.attempts} attempt${it.attempts === 1 ? "" : "s"}`, it.attempts > 1 ? "warn" : "muted") : null,
            it.model ? chip(modelFamilyName(it.model), "model") : null),
        ),
        h("div", { class: "item-score", title: score === null ? "Not tested yet" : `Latest test: ${it.lastTest?.passed ?? "?"}/${it.lastTest?.total ?? "?"} checks` },
          h("div", { class: "bar" }, h("i", { class: score === null ? "" : score >= 1 ? "good" : "warn", style: `width:${score === null ? 0 : Math.round(score * 100)}%` })),
          h("div", { class: "item-score-text" }, score === null ? "not tested" : `${formatPercent(score)}${it.scores.length > 1 ? ` (${it.scores.map((s) => formatPercent(s)).join(" → ")})` : ""}`))));
    }
    card.append(list);
    return card;
  }

  // ---- who's working
  function whoCard() {
    const w = whoIsWorking(view);
    const card = h("section", { class: `card who${w.active ? " active" : ""}`, "aria-label": "Who's working", "data-testid": "whos-working" }, h("div", { class: "card-head" }, h("h2", null, "Now working")));
    if (w.idle) {
      card.append(h("p", { class: "muted" }, w.title === "Starting up" ? "Starting up…" : `Nobody: the run is ${w.title.toLowerCase()}.`));
      return card;
    }
    const esc = w.escalation;
    add(card,
      h("div", { class: "who-top" },
        h("span", { class: `avatar role-${w.role}`, "aria-hidden": "true" }, (roleLabel(w.role) || "?")[0]),
        h("div", { class: "who-id" }, h("div", { class: "who-role" }, roleLabel(w.role), w.active ? h("span", { class: "live-dot", title: "A model call is running" }) : null), h("div", { class: "who-purpose muted" }, w.purpose ? w.purpose : "")),
      ),
      h("div", { class: "who-model" }, h("span", { class: "model-name", "data-testid": "current-model" }, w.modelName), w.tier ? chip(`Tier ${w.tier}`, "muted") : null, w.pinned ? chip("Pinned by you", "info") : null),
      esc ? h("div", { class: "escalation", role: "note", "data-testid": "escalation" }, icon("bolt", 15), h("div", null, h("b", null, esc.text))) : null,
      w.reason ? h("blockquote", { class: "why" }, h("span", { class: "why-label" }, "Why this model"), w.reason) : null,
      w.tool ? h("div", { class: "tool-line" }, h("span", { class: "tool-arrow" }, "›"), w.tool) : null,
    );
    return card;
  }

  // ---- plan fact check
  function planCheckCard() {
    const checks = view.planChecks;
    if (!checks.length) return null;
    const card = h("section", { class: "card", "aria-label": "Plan fact check", "data-testid": "plan-check" },
      h("div", { class: "card-head" }, h("h2", null, "Plan fact check"), h("span", { class: "muted sm" }, "Shelf Life")),
      h("p", { class: "muted sm", style: "margin-bottom:10px" }, "The plan's facts, checked against live web sources before building."));
    checks.forEach((c, idx) => {
      const report = c.reportPath ? ui.reports.get(c.reportPath) : null;
      const sum = factCheckSummary(c, report);
      const rows = report ? factCheckRows(report) : [];
      const stale = report ? rows.filter((r) => r.verdict === "stale").length : c.staleCount || 0;
      const tone = !sum.verified ? "muted" : stale > 0 ? "warn" : "good";
      const wasRevised = stale > 0 && idx < checks.length - 1;
      const label = `Plan v${c.specVersion ?? idx + 1}`;
      const key = `pc:${c.key}`;
      const det = h("details", { class: "check-block", open: ui.open.has(key) || (stale > 0 && !ui.open.has(`${key}:closed`)) || null, "data-key": key },
        h("summary", null, h("span", { class: "check-title" }, label), chip(sum.verified ? (stale > 0 ? `${stale} stale${wasRevised ? " · plan revised" : ""}` : "none stale") : c.status === "running" ? "checking…" : "not verified", tone), h("span", { class: "check-sum muted" }, sum.text)));
      det.querySelector("summary").addEventListener("click", () => setTimeout(() => { if (det.open) { ui.open.add(key); ui.open.delete(`${key}:closed`); } else { ui.open.delete(key); ui.open.add(`${key}:closed`); } }));
      if (c.status === "running") det.append(h("p", { class: "muted sm" }, "Checking against live sources…"));
      else if (!sum.verified) det.append(h("p", { class: "muted sm" }, `Not verified: ${report?.reason || c.reason || c.status}. A skipped check is never shown as "checked" or "current".`));
      else if (rows.length) det.append(factRows(rows), rows.some((r) => r.independentNote) ? h("p", { class: "muted sm foot" }, "Two different sites contained each stated value (mechanical check); editorial independence not reviewed.") : null);
      else det.append(h("p", { class: "muted sm" }, "Loading the findings…"));
      card.append(det);
    });
    return card;
  }

  function factRows(rows, { proposed = false } = {}) {
    const list = h("ul", { class: "facts" });
    for (const r of rows) {
      list.append(h("li", { class: `fact ${r.verdict}` },
        h("div", { class: "fact-top" }, h("span", { class: `verdict ${r.verdict}` }, r.verdictLabel), h("span", { class: "fact-text" }, r.statement)),
        r.verdict === "stale" ? h("div", { class: "shift" }, h("span", { class: "old" }, r.oldValue || r.statement), h("span", { class: "arrow", "aria-hidden": "true" }, "→"), h("span", { class: "new" }, r.proposedValue || "(no correction proposed)")) : null,
        r.forcedRevision ? h("div", { class: "fact-note warn" }, "Stale with a supported correction: this forced a plan revision.") : null,
        h("div", { class: "fact-sources" }, r.sources.length ? r.sources.slice(0, 2).map((s) => sourceLink(s)) : h("span", { class: "muted sm" }, "No source links")),
        (r.checks.some((c) => c.check === "independent_sources" && !c.passed) ? h("div", { class: "fact-note muted" }, "Only one site stated the value, so it stays unsure.") : null),
      ));
    }
    return list;
  }

  function sourceLink(s) {
    const href = safeUrl(s.url);
    const label = domainOf(s) || s.name;
    return href ? h("a", { class: "src", href, target: "_blank", rel: "noopener noreferrer", title: s.name }, h("span", { class: "favicon", "aria-hidden": "true" }, (label[0] || "•").toUpperCase()), label, icon("external", 12)) : h("span", { class: "src" }, label);
  }

  // ---- approval
  function approvalCard() {
    if (!view.plan && !view.reviews.length) return null;
    const b = approvalBadge(view);
    const lastReview = view.reviews[view.reviews.length - 1];
    const card = h("section", { class: `card approval ${b.tone}`, "aria-label": "Plan approval", "data-testid": "approval" }, h("div", { class: "card-head" }, h("h2", null, "Plan approval")));
    card.append(h("div", { class: `approval-badge ${b.tone}`, "data-testid": "approval-badge" }, icon(b.tone === "good" ? "check" : b.tone === "warn" ? "refresh" : "spark", 18), h("span", null, b.label)));
    if (b.state === "auto") {
      card.append(h("p", { class: "muted sm" }, `Plan v${b.specVersion}: reviewed by a model that isn't the one that wrote it${lastReview?.sameModelAsPlanner ? " (same model: only one top-tier model is configured)" : ""}. Nobody was asked.`));
    } else if (b.state === "confirmed") {
      card.append(h("p", { class: "muted sm" }, `You confirmed plan v${b.specVersion}.`));
    } else if (b.state === "awaiting") {
      card.append(h("p", { class: "muted sm" }, "The independent review passed. Building starts when you confirm."), button("Confirm plan", { variant: "primary", onclick: confirmPlan }, "check"));
    } else if (b.state === "revise") {
      card.append(h("p", { class: "muted sm" }, "The reviewer asked for changes, so the plan is being revised. No code is written before approval."));
    } else if (b.state === "pending") {
      card.append(h("p", { class: "muted sm" }, "An independent model reviews every plan before building starts."));
    }
    if (lastReview?.scores && (b.state === "auto" || b.state === "awaiting" || b.state === "confirmed")) {
      const s = lastReview.scores;
      card.append(h("div", { class: "scores" }, Object.entries(s).map(([k, v]) => h("span", { class: "score-pill" }, h("i", null, k.replace(/([A-Z])/g, " $1").toLowerCase()), h("b", null, `${v}/3`)))));
    }
    if (b.sha) card.append(h("div", { class: "sha mono", title: "SHA-256 of the exact plan that was approved. A changed plan voids the approval." }, `spec v${b.specVersion} · sha ${String(b.sha).slice(0, 12)}…`));
    return card;
  }

  // ---- README fact check
  function factCheckCard() {
    const c = view.factCheck;
    if (!c) return null;
    const report = c.reportPath ? ui.reports.get(c.reportPath) : null;
    const sum = factCheckSummary(c, report);
    const rows = report ? factCheckRows(report) : [];
    const card = h("section", { class: "card", "aria-label": "Fact check", "data-testid": "fact-check" },
      h("div", { class: "card-head" }, h("h2", null, "Fact check"), chip("Proposed, unreviewed", "warn")),
      h("p", { class: "muted sm" }, `Claims in ${c.docLabel || "the README"} were checked against live sources. Corrections are proposals only; a person decides.`),
      h("p", { class: "check-sum" }, sum.text));
    if (c.status === "running") card.append(h("p", { class: "muted sm" }, "Checking…"));
    else if (!sum.verified) card.append(h("p", { class: "muted sm" }, "Not verified."));
    else if (rows.length) card.append(factRows(rows));
    if (report?.diff) {
      const key = "fc:diff";
      const det = h("details", { class: "diff", open: ui.open.has(key) || null }, h("summary", null, "Proposed change (diff)"), h("pre", null, report.diff));
      det.addEventListener("toggle", () => (det.open ? ui.open.add(key) : ui.open.delete(key)));
      card.append(det);
    }
    return card;
  }

  // ---- sources
  function sourcesCard() {
    const r = view.research;
    if (!r) return null;
    return h("section", { class: "card", "aria-label": "Sources", "data-testid": "sources" },
      h("div", { class: "card-head" }, h("h2", null, "Sources"), r.basis === "model_knowledge" ? chip("model knowledge", "warn") : h("span", { class: "muted sm" }, `${r.searchesUsed ?? "?"} web searches`)),
      r.sources.length ? h("div", { class: "src-row" }, r.sources.map((s) => sourceLink(s))) : h("p", { class: "muted sm" }, "No sources: this research came from the model's own knowledge."));
  }

  // ---- models table
  function modelsCard() {
    const rows = modelsTable(view);
    if (!rows.length) return null;
    return h("section", { class: "card", "aria-label": "Models in this run", "data-testid": "models" },
      h("div", { class: "card-head" }, h("h2", null, "Models in this run"), view.escalations.length ? h("span", { class: "muted sm" }, `${view.escalations.length} escalation${view.escalations.length === 1 ? "" : "s"}`) : null),
      h("table", { class: "mini-table" }, h("tbody", null, rows.map((r) => h("tr", { title: r.reason },
        h("th", { scope: "row" }, r.label),
        h("td", null, r.models.map((m, i) => h("span", { class: "model-seq" }, i > 0 ? h("span", { class: "arrow" }, "→") : null, chip(modelFamilyName(m), i === r.models.length - 1 && r.escalated ? "warn" : "model")))),
        h("td", { class: "tier" }, r.tier ? `T${r.tier}` : "")))) ),
      h("p", { class: "muted sm models-note" }, "The router picks a model for each job. ", h("a", { class: "link", href: "#/routing" }, "Change routing")));
  }

  // ---------------------------------------------------------------- timeline (incremental)
  function buildTimelineCard() {
    const toggle = h("input", { type: "checkbox", id: "show-tools", onchange: (e) => { ui.showTools = e.target.checked; stableTimeline.classList.toggle("show-tools", ui.showTools); } });
    return h("section", { class: "card timeline-card", "aria-label": "Timeline", "data-testid": "timeline" },
      h("div", { class: "card-head" }, h("h2", null, "Activity"), h("label", { class: "toggle-inline", for: "show-tools" }, toggle, h("span", null, "Show tool calls"))),
      stableTimeline);
  }

  function syncTimeline() {
    stableTimeline.classList.toggle("show-tools", ui.showTools);
    const cb = document.getElementById("show-tools");
    if (cb) cb.checked = ui.showTools;
    for (const e of view.timeline) {
      const known = tl.map.get(e.key);
      if (known && known.rev === e.rev) continue;
      const el = timelineItem(e);
      if (known) { known.el.replaceWith(el); }
      else stableTimeline.prepend(el);
      tl.map.set(e.key, { el, rev: e.rev });
    }
  }

  function timelineItem(e) {
    const time = h("span", { class: "tl-time mono" }, offsetLabel(view, e.at));
    if (e.tone === "phase") return h("li", { class: "tl phase", "data-key": e.key }, h("span", { class: "tl-line" }), h("span", { class: "tl-phase" }, e.text), time);
    const role = e.role && e.role !== "engine" ? h("span", { class: `role-chip role-${e.role}` }, roleLabel(e.role)) : null;
    const head = h("div", { class: "tl-head" }, h("span", { class: `tl-icon ${e.tone}`, "aria-hidden": "true" }, e.icon), role, h("span", { class: "tl-text" }, e.text), time);
    const cls = `tl ${e.tone}${e.tone === "tool" ? " tl-tool" : ""}`;
    if (!e.detail) return h("li", { class: cls, "data-key": e.key }, head);
    const det = h("details", { class: "tl-details", open: ui.open.has(e.key) || null }, h("summary", null, head), h("div", { class: "tl-body" }));
    const body = det.querySelector(".tl-body");
    const fill = () => { if (!body.dataset.filled) { body.dataset.filled = "1"; renderDetail(body, e.detail); } };
    det.addEventListener("toggle", () => { if (det.open) { ui.open.add(e.key); fill(); } else ui.open.delete(e.key); });
    if (det.open) fill();
    return h("li", { class: cls, "data-key": e.key }, det);
  }

  function renderDetail(body, d) {
    switch (d.kind) {
      case "text": d.lines.forEach((l) => body.append(h("p", null, l))); break;
      case "route":
        body.append(h("p", null, h("b", null, "Why: "), d.reason || "No reason recorded."), h("p", { class: "muted sm" }, `${shortModelName(d.model)} · tier ${d.tier ?? "?"}${d.rule ? ` · rule ${d.rule}` : ""}${d.pinned ? " · pinned by you" : ""}`));
        break;
      case "brief":
        add(body, h("p", { class: "muted sm" }, "What the product must do:"), h("ul", null, d.mustHaves.map((m) => h("li", null, m))), d.assumptions.length ? [h("p", { class: "muted sm" }, "Assumed for you instead of asking:"), h("ul", null, d.assumptions.map((a) => h("li", null, h("b", null, `${a.topic}: `), a.assumed)))] : null);
        break;
      case "sources":
        body.append(h("div", { class: "src-list" }, d.sources.map((s) => h("div", { class: "src-item" }, sourceLink(s), s.snippet ? h("p", { class: "muted sm" }, s.snippet) : null))));
        break;
      case "plan":
        add(body, h("ul", null, d.items.map((i) => h("li", null, h("b", null, `${i.id} `), i.title, i.difficulty ? h("span", { class: "muted" }, ` (${i.difficulty})`) : null))), d.stack ? h("p", { class: "muted sm" }, `Stack: ${d.stack}`) : null);
        break;
      case "review":
        add(body, d.scores ? h("p", null, Object.entries(d.scores).map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()} ${v}/3`).join(" · ")) : null, d.sameModelAsPlanner ? h("p", { class: "muted sm" }, "Same model as the planner (only one top-tier model is configured).") : null, d.issues.length ? h("ul", null, d.issues.map((i) => h("li", null, h("span", { class: `sev ${i.severity}` }, i.severity), ` ${i.text}`))) : h("p", { class: "muted sm" }, "No issues raised."));
        break;
      case "files":
        add(body, h("p", { class: "muted sm" }, `${d.turns ?? "?"} turns · ${d.toolCalls ?? "?"} tool calls`), h("ul", { class: "filelist" }, d.files.map((f) => h("li", { class: "mono" }, f))));
        break;
      case "list":
        body.append(h("p", { class: "muted sm" }, d.title), h("ul", null, d.lines.map((l) => h("li", null, l))));
        break;
      case "report":
        body.append(h("p", { class: "muted sm" }, `Findings are under ${d.phase === "plan_check" ? "Plan" : "Reflect"}.`));
        break;
      case "test": {
        if (d.failures?.length) body.append(h("ul", null, d.failures.map((f) => h("li", null, h("b", { class: "mono" }, `${f.checkId} `), f.message))));
        const holder = h("div", { class: "evidence" });
        body.append(holder);
        if (d.reportPath) {
          holder.append(h("p", { class: "muted sm" }, "Loading the test evidence…"));
          get(artifactPath(runId, d.reportPath)).then((res) => { clear(holder); if (res.ok && res.data) holder.append(evidenceTable(res.data)); else holder.append(h("p", { class: "muted sm" }, "The test report isn't available.")); });
        }
        break;
      }
      default: break;
    }
  }

  // compact: the Test panel shows raw evidence only for checks that didn't pass.
  function evidenceTable(report, { compact = false } = {}) {
    const wrap = h("div", { class: "evidence-table" });
    if (!compact) wrap.append(h("p", { class: "muted sm" }, `Tested by ${shortModelName(report.testerModel)} · candidate ${String(report.candidate || "").slice(0, 7)} · acceptance tests ${report.acceptanceIntact ? "intact" : "modified"}`));
    for (const r of report.results || []) {
      const ev = r.evidence || {};
      const lines = [ev.command ? `$ ${ev.command.join(" ")}` : null, Number.isFinite(ev.exitCode) ? `exit code ${ev.exitCode}` : null, ev.stdoutTail ? ev.stdoutTail.trim() : null, ev.stderrTail ? ev.stderrTail.trim() : null, ...(ev.quotes || []).map((q) => `${q.file}: “${q.text}”`)].filter(Boolean);
      const showLines = lines.length && (!compact || r.status !== "pass");
      wrap.append(h("div", { class: `ev-row ${r.status}` },
        h("div", { class: "ev-head" }, h("span", { class: `verdict ${r.status === "pass" ? "pass" : "fail"}` }, r.status === "pass" ? "Pass" : r.status === "fail" ? "Fail" : String(r.status || "?")), h("b", { class: "mono" }, r.checkId), h("span", null, r.message)),
        showLines ? h("pre", { class: "ev-pre" }, lines.join("\n")) : null));
    }
    return wrap;
  }

  // ---------------------------------------------------------------- report and files tabs
  function renderReportTab() {
    if (ui.reportMd === undefined) {
      ui.reportMd = null;
      clear(els.body).append(h("p", { class: "muted pad" }, "Loading the report…"));
      get(artifactPath(runId, "REPORT.md")).then((res) => { ui.reportMd = res.ok ? res.text : false; render(); });
      return;
    }
    if (ui.reportMd === null) return;
    const body = clear(els.body);
    if (ui.reportMd === false) { body.append(h("div", { class: "empty-card" }, h("h2", null, "The report isn't ready yet"), h("p", { class: "muted" }, "REPORT.md is written at the end of the run."))); return; }
    const doc = h("article", { class: "card markdown", "data-testid": "report" });
    setMarkdown(doc, renderMarkdown(ui.reportMd, { headingOffset: 0 }));
    add(body, view.synthetic ? h("p", { class: "synthetic-note" }, icon("shield", 15), h("span", null, "Synthetic replay: this report comes from the mock fixture.")) : null, doc);
  }

  function renderFilesTab() {
    const body = clear(els.body);
    if (ui.files === null) {
      ui.files = { product: undefined };
      get(`/api/runs/${encodeURIComponent(runId)}/files`).then((res) => { ui.files = { product: res.ok ? res.data.files || [] : [] }; render(); });
      body.append(h("p", { class: "muted pad" }, "Loading files…"));
      return;
    }
    if (ui.files.product === undefined) { body.append(h("p", { class: "muted pad" }, "Loading files…")); return; }
    const records = (ui.artifacts.length ? ui.artifacts : view.artifacts).filter((n) => n !== "wish.txt");
    const viewer = h("pre", { class: "file-view", "aria-live": "polite", "data-testid": "file-view" }, ui.fileView?.text ?? "Pick a file to read it.");
    const open = async (label, url) => {
      ui.fileView = { text: "Loading…" };
      viewer.textContent = "Loading…";
      title.textContent = label;
      const res = await get(url);
      viewer.textContent = res.ok ? (res.text ?? "") : res.status === 415 ? "This file isn't text, so it can't be shown here." : "Couldn't load this file.";
    };
    const title = h("div", { class: "file-title mono" }, "No file selected");
    const group = (name, files, urlFor) => h("div", { class: "file-group" }, h("div", { class: "eyebrow" }, name), files.length ? h("ul", null, files.map((f) => h("li", null, h("button", { type: "button", class: "file-btn mono", onclick: () => open(f, urlFor(f)) }, icon("file", 13), f)))) : h("p", { class: "muted sm" }, "Nothing here."));
    body.append(h("div", { class: "files" },
      h("div", { class: "card file-list" }, group("The product", ui.files.product, (f) => filePath(runId, f)), group("Run records", records, (f) => artifactPath(runId, f))),
      h("div", { class: "card file-pane" }, title, viewer)));
  }

  return {
    unmount() {
      cancelAnimationFrame(raf); clearTimeout(timer);
      clearInterval(ticker);
      if (stream) stream.close();
      if (setConnection) setConnection("", "muted");
    },
    setTab(next) { if (ui.tab !== next) { ui.tab = next; runShell = null; tl.map.clear(); stableTimeline.replaceChildren(); render(); } },
  };
}
