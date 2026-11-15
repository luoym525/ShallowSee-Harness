// wish.mjs: Make a wish (#/new) and the Runs history list (#/runs).

import { hasUsableModels, formatUsd, formatPercent, statusLabel, statusTone, isFinishedStatus } from "../model.mjs";
import { h, icon, chip, button, clear, formatDate, toast } from "./dom.mjs";
import { get, post } from "./api.mjs";

const EXAMPLES = [
  "I want a page that tells me if I need an umbrella tomorrow",
  "A tiny tip calculator I can use on my phone when splitting a restaurant bill",
  "A command-line tool that turns a list of names into a neat alphabetical contact sheet",
  "A web page with a countdown to my next birthday, with a different colour each month",
];

export async function mountWish(root, { navigate, ticket }) {
  clear(root).append(h("p", { class: "muted pad" }, "Loading…"));
  const [cfg, presets] = await Promise.all([get("/api/config", { signal: ticket.signal }), get("/api/presets", { signal: ticket.signal })]);
  if (!ticket.isCurrent()) return; // a newer page took over while this load was in flight
  const config = cfg.ok ? cfg.data.config : null;
  const ready = cfg.ok && hasUsableModels(config, presets.ok ? presets.data.presets : []);
  const budget = config?.budget || null;
  const autonomy = config?.routing?.autonomy || "full";

  const area = h("textarea", { id: "wish", rows: 5, maxlength: 2000, placeholder: "Describe what you want, in your own words", "aria-label": "Describe what you want, in your own words", "data-testid": "wish-input" });
  const count = h("span", { class: "muted sm" }, "0 / 2000");
  const startBtn = button("Start", { variant: "primary big", type: "submit", "data-testid": "start" }, "bolt");
  const error = h("p", { class: "form-error", role: "alert", hidden: true });
  area.addEventListener("input", () => { count.textContent = `${area.value.length} / 2000`; });
  area.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") form.requestSubmit(); });

  const form = h("form", { class: "wish-form", onsubmit: async (e) => {
    e.preventDefault();
    const wish = area.value.trim();
    error.hidden = true;
    if (!wish) { error.textContent = "Type what you want first. A sentence is enough."; error.hidden = false; area.focus(); return; }
    startBtn.disabled = true;
    const res = await post("/api/runs", { wish });
    if (res.ok) { navigate(`#/runs/${res.data.runId}`); return; }
    startBtn.disabled = false;
    error.textContent = res.status === 409 ? "No models are set up yet. Add a provider on the Setup page first." : (res.error?.message || "Couldn't start the run.");
    error.hidden = false;
    if (res.status === 409) toast("No models yet: open Setup to add one.", "warn");
  } },
    area,
    h("div", { class: "wish-foot" }, count, h("span", { class: "muted sm" }, "Ctrl+Enter to start")),
    error,
    h("div", { class: "examples", role: "group", "aria-label": "Example wishes" }, h("span", { class: "muted sm" }, "Try:"), EXAMPLES.map((ex) => h("button", { type: "button", class: "example", onclick: () => { area.value = ex; count.textContent = `${ex.length} / 2000`; area.focus(); } }, ex.length > 46 ? `${ex.slice(0, 44)}…` : ex))),
    h("div", { class: "wish-actions" }, startBtn),
  );

  // One quiet line next to Start: the limits this run may use and who approves the plan.
  const summary = h("div", { class: "wish-summary", "data-testid": "budget-summary", title: autonomy === "full" ? "An independent model approves the plan. Nothing is asked of you during the run." : "You will be asked to confirm the plan before building starts." },
    budget ? [
      h("span", null, "Up to ", h("b", null, formatUsd(budget.maxUsdPerRun))),
      h("span", null, `${budget.maxMinutesPerRun} min`),
      h("span", null, `${budget.maxBuildIterations} build attempts`),
    ] : h("span", null, "Budget unknown"),
    h("span", null, autonomy === "full" ? "Full autopilot" : "You confirm the plan"),
    h("a", { class: "link", href: "#/routing" }, "Change"));
  form.querySelector(".wish-actions").prepend(summary);

  const how = h("ol", { class: "how-line", "aria-label": "What happens next" },
    h("li", null, h("b", null, "Research")), h("li", null, h("b", null, "Plan"), " and fact-check"), h("li", null, h("b", null, "Build"), " and test"), h("li", null, h("b", null, "Deliver"), " with a report"));

  const page = h("div", { class: "wish-page" },
    h("h1", { class: "hero" }, "What do you want made?"),
    h("p", { class: "lead muted" }, "Describe it like you would to a friend. The harness does the rest."),
    ready ? form : h("div", { class: "card empty-card", "data-testid": "no-models" },
      h("h2", null, "Add a model provider to get started"),
      h("p", { class: "muted" }, "The harness needs at least one model with an API key. Pick a preset, paste the key, done."),
      h("a", { class: "btn primary", href: "#/setup" }, "Open Setup")),
    how);
  clear(root).append(page);
  if (ready) area.focus();
}

export async function mountRuns(root, { ticket }) {
  clear(root).append(h("p", { class: "muted pad" }, "Loading runs…"));
  const res = await get("/api/runs", { signal: ticket.signal });
  if (!ticket.isCurrent()) return;
  const page = h("div", { class: "page-narrow" }, h("div", { class: "page-head" }, h("h1", null, "Runs"), h("a", { class: "btn primary", href: "#/new" }, icon("plus", 15), h("span", null, "New wish"))));
  if (!res.ok) {
    page.append(h("div", { class: "card empty-card" }, h("h2", null, "Couldn't load the runs"), h("p", { class: "muted" }, res.error?.message || "")));
    clear(root).append(page);
    return;
  }
  const runs = res.data.runs || [];
  if (!runs.length) {
    page.append(h("div", { class: "card empty-card" }, h("h2", null, "No runs yet"), h("p", { class: "muted" }, "Make a wish and its run will show up here."), h("a", { class: "btn primary", href: "#/new" }, "Make a wish")));
  } else {
    page.append(h("div", { class: "card table-card" }, h("table", { class: "runs-table", "data-testid": "runs-table" },
      h("thead", null, h("tr", null, ["Status", "Product", "Score", "Spend", "Started"].map((c) => h("th", { scope: "col" }, c)))),
      h("tbody", null, runs.map((r) => {
        const finished = isFinishedStatus(r.status);
        const synthetic = r.synthetic;
        return h("tr", { class: "run-row" },
          h("td", null, h("span", { class: `pill ${statusTone(r.status)}` }, statusLabel(r.status))),
          h("td", null, h("a", { class: "run-link", href: `#/runs/${r.runId}` }, h("b", null, r.title || "Untitled"), h("span", { class: "muted sm" }, r.wish)), synthetic ? chip("Synthetic", "warn") : null),
          h("td", null, finished || r.best ? formatPercent(r.finalScore ?? r.best?.score ?? null) : "—"),
          h("td", null, r.spend?.usd === null || r.spend?.usd === undefined ? "unknown" : formatUsd(r.spend.usd)),
          h("td", { class: "muted" }, formatDate(r.startedAt)));
      })))));
  }
  clear(root).append(page);
}
