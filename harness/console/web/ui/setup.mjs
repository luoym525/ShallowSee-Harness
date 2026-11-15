// setup.mjs: Setup → Providers (#/setup) and Setup → Routing & budget (#/routing).
// The Add / Edit provider form lives in provider-form.mjs. Keys are never shown: the server only
// sends { hasKey, preview }, and this file never asks for more.

import { keyStatusLabel, providerKindBadge, isModelKind, fetchModelsOutcome, testOutcome, modelOptions, shortModelName, roleLabel, formatUsd } from "../model.mjs";
import { h, add, icon, chip, button, clear, toast } from "./dom.mjs";
import { get, post, put, del } from "./api.mjs";

export { mountProviderForm } from "./provider-form.mjs";

export function setupTabs(active) {
  return h("div", { class: "tabs setup-tabs", role: "navigation", "aria-label": "Setup sections" },
    h("a", { class: `tab${active === "providers" ? " active" : ""}`, href: "#/setup", "aria-current": active === "providers" ? "page" : null }, "Providers"),
    h("a", { class: `tab${active === "routing" ? " active" : ""}`, href: "#/routing", "aria-current": active === "routing" ? "page" : null }, "Routing & budget"));
}

export function letterOf(name) {
  const ch = String(name || "?").trim()[0] || "?";
  return ch.toUpperCase();
}

// ---------------------------------------------------------------- fetch models dialog (shared with the form)

/**
 * Opens a dialog that fetches the provider's model ids and lets the user tick which to add.
 * existingIds: ids already configured (shown ticked and locked). onAdd(ids) is called with the newly ticked ids.
 * A failed fetch changes nothing: the dialog says so in plain English.
 */
export async function openFetchDialog({ provider, existingIds = [], onAdd }) {
  const dlg = h("dialog", { "aria-labelledby": "fm-title", "data-testid": "fetch-dialog" });
  const body = h("div", null, h("p", { class: "muted" }, "Asking the provider for its model list…"));
  const actions = h("div", { class: "dialog-actions" });
  add(dlg, h("h2", { id: "fm-title" }, `Fetch models · ${provider.name}`), body, actions);
  document.body.append(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  add(actions, button("Close", { variant: "ghost", onclick: close }));
  dlg.showModal();

  const res = await post(`/api/providers/${encodeURIComponent(provider.id)}/fetch-models`, {});
  const outcome = fetchModelsOutcome(res.ok ? { ok: true, models: res.data?.models } : { ok: false, status: res.status, code: res.error?.code });
  clear(body).append(h("div", { class: `outcome ${outcome.tone}`, role: "status", "data-testid": "fetch-outcome" }, outcome.text));
  if (!outcome.ok) return;
  const have = new Set(existingIds);
  const ids = res.data.models;
  const boxes = [];
  const list = h("div", { class: "checklist", role: "group", "aria-label": "Models to add" }, ids.map((id) => {
    const existing = have.has(id);
    const box = h("input", { type: "checkbox", checked: existing, disabled: existing, value: id });
    if (!existing) boxes.push(box);
    return h("label", null, box, h("span", { class: "mono" }, id), existing ? chip("already added", "muted") : null);
  }));
  const addBtn = button("Add selected", { variant: "primary", disabled: true, onclick: () => { onAdd(boxes.filter((b) => b.checked).map((b) => b.value)); close(); } });
  const update = () => { const n = boxes.filter((b) => b.checked).length; addBtn.querySelector("span").textContent = n ? `Add ${n} selected` : "Add selected"; addBtn.disabled = n === 0; };
  boxes.forEach((b) => b.addEventListener("change", update));
  const all = button("Select all new", { variant: "ghost sm", onclick: () => { boxes.forEach((b) => { b.checked = true; }); update(); } });
  body.append(boxes.length ? h("div", { class: "inline-row" }, all) : h("p", { class: "muted sm" }, "Every listed model is already added."), list);
  actions.prepend(addBtn);
}

// ---------------------------------------------------------------- providers list

export async function mountSetup(root, { navigate }) {
  clear(root).append(h("p", { class: "muted pad" }, "Loading providers…"));
  const cfg = await get("/api/config");
  const page = h("div", { class: "page-narrow" });
  if (!cfg.ok) {
    page.append(setupTabs("providers"), h("div", { class: "card empty-card" }, h("h2", null, "Couldn't load your setup"), h("p", { class: "muted" }, cfg.error?.message || ""), button("Try again", { variant: "primary", onclick: () => mountSetup(root, { navigate }) })));
    clear(root).append(page);
    return;
  }
  let config = cfg.data.config;
  const warnings = cfg.data.validation?.warnings || [];
  const list = h("div", { class: "provider-list", "data-testid": "provider-list" });

  const reload = async () => {
    const r = await get("/api/config");
    if (r.ok) { config = r.data.config; draw(); }
  };

  function draw() {
    clear(list);
    if (!config.providers.length) {
      add(list, h("div", { class: "card empty-card", "data-testid": "no-providers" }, h("h2", null, "No providers yet"), h("p", { class: "muted" }, "Add a model provider (like Anthropic or OpenRouter) and paste its API key. Add Linkup too if you want live web research."), h("a", { class: "btn primary", href: "#/setup/new" }, icon("plus", 15), h("span", null, "Add provider"))));
      return;
    }
    for (const p of config.providers) list.append(providerCard(p));
  }

  function providerCard(p) {
    const model = isModelKind(p.kind);
    const models = Array.isArray(p.models) ? p.models : [];
    const estimated = models.filter((m) => m.catalogMatched === false && m.tier === undefined).length;
    const result = h("div", { class: "test-result", role: "status", hidden: true, "data-testid": "test-result" });
    const testBtn = button("Test", { variant: "secondary sm", onclick: async () => {
      testBtn.disabled = true;
      result.hidden = false; result.className = "test-result"; result.textContent = "Testing…";
      const res = await post(`/api/providers/${encodeURIComponent(p.id)}/test`, {});
      testBtn.disabled = false;
      const o = res.ok ? testOutcome(res.data) : { ok: false, tone: "bad", text: res.error?.message || "The test failed." };
      result.className = `test-result ${o.tone}`;
      result.textContent = o.text;
    } }, "bolt");
    const fetchBtn = model ? button("Fetch models", { variant: "secondary sm", onclick: () => openFetchDialog({
      provider: p, existingIds: models.map((m) => m.id),
      onAdd: async (ids) => {
        if (!ids.length) return;
        const next = [...models.map(({ catalogMatched, ...m }) => m), ...ids.map((id) => ({ id, enabled: true }))];
        const res = await put(`/api/providers/${encodeURIComponent(p.id)}`, { models: next });
        if (res.ok) { toast(`Added ${ids.length} model${ids.length === 1 ? "" : "s"} to ${p.name}.`, "good"); reload(); } else toast(res.error?.message || "Couldn't add the models.", "bad");
      },
    }) }, "download") : null;
    const toggle = h("label", { class: "switch" }, h("input", { type: "checkbox", checked: p.enabled !== false, "aria-label": `Enabled: ${p.name}`, onchange: async (e) => {
      const res = await put(`/api/providers/${encodeURIComponent(p.id)}`, { enabled: e.target.checked });
      if (res.ok) { p.enabled = e.target.checked; card.classList.toggle("disabled", !p.enabled); } else { e.target.checked = !e.target.checked; toast(res.error?.message || "Couldn't change that.", "bad"); }
    } }), h("span", null, "Enabled"));
    const card = h("article", { class: `pcard${p.enabled === false ? " disabled" : ""}`, "data-provider": p.id },
      h("div", { class: "letter", "aria-hidden": "true" }, letterOf(p.name)),
      h("div", { class: "pbody" },
        h("div", { class: "pname" }, h("h2", null, p.name), chip(providerKindBadge(p.kind), p.kind === "linkup" ? "info" : p.kind === "github" ? "muted" : "model")),
        h("div", { class: "pmeta" },
          h("span", { class: "mono", title: "Request URL" }, p.baseUrl),
          h("span", { "data-testid": "key-status" }, p.apiKey?.hasKey ? h("span", null, "Key ", h("b", { class: "mono" }, keyStatusLabel(p.apiKey))) : h("span", { class: "nokey" }, "No key")),
          model ? h("span", null, `${models.length} model${models.length === 1 ? "" : "s"}`) : null,
          estimated ? chip(`${estimated} estimated tier`, "warn", { title: "These models aren't in the router's catalog, so their tier was guessed. Set a tier on the Edit page." }) : null),
        p.notes ? h("p", { class: "muted sm" }, p.notes) : null),
      h("div", { class: "pactions" }, toggle, testBtn, fetchBtn, h("a", { class: "btn secondary sm", href: `#/setup/${encodeURIComponent(p.id)}` }, icon("edit", 14), h("span", null, "Edit")), button("Delete", { variant: "ghost danger sm", onclick: () => confirmDelete(p) }, "trash")),
      result);
    return card;
  }

  function confirmDelete(p) {
    const dlg = h("dialog", { "aria-labelledby": "del-title", "data-testid": "delete-dialog" });
    const close = () => { dlg.close(); dlg.remove(); };
    add(dlg,
      h("h2", { id: "del-title" }, `Delete ${p.name}?`),
      h("p", { class: "muted" }, "Its API key and models are removed from your local setup. Runs that need it will use another provider, or won't start. This can't be undone."),
      h("div", { class: "dialog-actions" }, button("Cancel", { variant: "ghost", onclick: close }), button("Delete provider", { variant: "primary danger-solid", onclick: async () => {
        const res = await del(`/api/providers/${encodeURIComponent(p.id)}`);
        close();
        if (res.ok) { toast(`Deleted ${p.name}.`, "good"); reload(); } else toast(res.error?.message || "Couldn't delete it.", "bad");
      } })));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    document.body.append(dlg);
    dlg.showModal();
  }

  add(page,
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "Setup"), h("p", { class: "muted" }, "Connect the models and web search the harness may use. API keys stay on this computer.")),
      h("div", { class: "head-btns" }, h("a", { class: "btn primary", href: "#/setup/new", "data-testid": "add-provider" }, icon("plus", 15), h("span", null, "Add provider")))),
    setupTabs("providers"),
    warnings.length ? h("div", { class: "notice warn", role: "note" }, h("b", null, "Heads up: "), warnings.slice(0, 3).map((w) => w.message).join(" · ")) : null,
    list);
  clear(root).append(page);
  draw();
}

// ---------------------------------------------------------------- routing & budget

const ROLE_HELP = {
  intake: "Turns your wish into a clear brief",
  researcher: "Searches the web for what the plan needs",
  planner: "Writes the plan and the acceptance checks",
  reviewer: "Independently approves the plan and the result",
  builder: "Writes the code (escalates after failed tests)",
  tester: "Runs the checks; never the model that built it",
  reflector: "Decides to retry, escalate or move on",
  reporter: "Writes the final report",
  vision: "Looks at screenshots (optional)",
};

export async function mountRouting(root, { navigate }) {
  clear(root).append(h("p", { class: "muted pad" }, "Loading routing…"));
  const [cfg, prev] = await Promise.all([get("/api/config"), get("/api/routing/preview")]);
  const page = h("div", { class: "page-narrow" });
  if (!cfg.ok) {
    add(page, setupTabs("routing"), h("div", { class: "card empty-card" }, h("h2", null, "Couldn't load your setup"), h("p", { class: "muted" }, cfg.error?.message || "")));
    clear(root).append(page);
    return;
  }
  const config = cfg.data.config;
  let rows = prev.ok ? prev.data.rows || [] : [];
  const options = modelOptions(config);
  const tableBody = h("tbody");

  async function savePins(role, ref) {
    const overrides = { ...(config.routing?.overrides || {}) };
    if (ref) overrides[role] = ref; else delete overrides[role];
    const res = await put("/api/routing", { overrides });
    if (!res.ok) { toast(res.error?.message || "Couldn't save that pin.", "bad"); return; }
    config.routing = res.data.routing;
    const r = await get("/api/routing/preview");
    if (r.ok) { rows = r.data.rows || []; drawRows(); }
    toast(ref ? `${roleLabel(role)} pinned to ${shortModelName(ref)}.` : `${roleLabel(role)} is back on Auto.`, "good");
  }

  function drawRows() {
    clear(tableBody);
    if (!rows.length) { tableBody.append(h("tr", null, h("td", { colspan: 5, class: "muted" }, "Routing appears once a provider with models is set up."))); return; }
    for (const r of rows) {
      const pinned = config.routing?.overrides?.[r.role] || "";
      const sel = h("select", { "aria-label": `Model for ${roleLabel(r.role)}`, onchange: (e) => savePins(r.role, e.target.value) },
        h("option", { value: "" }, "Auto"), options.map((o) => h("option", { value: o.ref, selected: o.ref === pinned }, `Pin: ${o.label}`)));
      tableBody.append(h("tr", { "data-role": r.role },
        h("td", null, h("b", null, roleLabel(r.role)), h("div", { class: "muted sm" }, ROLE_HELP[r.role] || "")),
        h("td", null, r.model ? h("span", { class: "model-name sm-name" }, shortModelName(r.model)) : h("span", { class: "muted" }, "none"), r.pinned ? chip("Pinned", "info") : null),
        h("td", null, r.tier ? `Tier ${r.tier}` : "—"),
        h("td", { class: "muted why-cell" }, r.reason || ""),
        h("td", null, sel)));
    }
  }

  const autonomy = config.routing?.autonomy || "full";
  const radio = (value, title, text) => h("label", { class: "radio-card" }, h("input", { type: "radio", name: "autonomy", value, checked: autonomy === value, onchange: async () => {
    const res = await put("/api/routing", { autonomy: value });
    if (res.ok) toast("Saved.", "good"); else toast(res.error?.message || "Couldn't save.", "bad");
  } }), h("div", null, h("b", null, title), h("span", { class: "muted sm" }, text)));

  const b = config.budget || { maxUsdPerRun: 5, maxMinutesPerRun: 40, maxBuildIterations: 12 };
  const inputs = {
    maxUsdPerRun: h("input", { type: "number", id: "b-usd", min: "0.1", step: "0.1", value: b.maxUsdPerRun }),
    maxMinutesPerRun: h("input", { type: "number", id: "b-min", min: "1", step: "1", value: b.maxMinutesPerRun }),
    maxBuildIterations: h("input", { type: "number", id: "b-it", min: "1", step: "1", value: b.maxBuildIterations }),
  };
  const budgetMsg = h("span", { class: "muted sm", role: "status" });
  const saveBudget = button("Save budget", { variant: "primary", onclick: async () => {
    const body = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, Number(el.value)]));
    if (Object.values(body).some((v) => !(v > 0))) { budgetMsg.textContent = "Every limit must be greater than zero."; return; }
    const res = await put("/api/budget", body);
    budgetMsg.textContent = res.ok ? `Saved: up to ${formatUsd(res.data.budget.maxUsdPerRun)}, ${res.data.budget.maxMinutesPerRun} min, ${res.data.budget.maxBuildIterations} build attempts per run.` : (res.error?.message || "Couldn't save.");
  } });

  const diversity = h("label", { class: "switch" }, h("input", { type: "checkbox", checked: config.routing?.preferVendorDiversity !== false, onchange: async (e) => {
    const res = await put("/api/routing", { preferVendorDiversity: e.target.checked });
    if (!res.ok) { e.target.checked = !e.target.checked; toast("Couldn't save.", "bad"); }
  } }), h("span", null, "Prefer a different vendor for the tester than for the builder"));

  add(page,
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "Setup"), h("p", { class: "muted" }, "Which model does each job, how much a run may spend, and who approves the plan."))),
    setupTabs("routing"),
    h("section", { class: "section" }, h("h2", null, "Who does what"), h("p", { class: "muted sm" }, "The router picks a model for every job from the models you've set up. Pin one to override it."),
      h("div", { class: "card table-card" }, h("table", { class: "routing-table", "data-testid": "routing-table" }, h("thead", null, h("tr", null, ["Role", "Model", "Tier", "Why", "Auto / pin a model"].map((c) => h("th", { scope: "col" }, c)))), tableBody)),
      h("div", { class: "inline-row" }, diversity)),
    h("section", { class: "section" }, h("h2", null, "Autonomy"), h("p", { class: "muted sm" }, "Either way, an independent model reviews the plan first."),
      h("div", { class: "two-col" }, radio("full", "Full autopilot (recommended)", "An independent model approves the plan, and the run goes ahead without asking you anything."), radio("confirm_plan", "Ask me to confirm the plan", "After the independent review, the run waits for your Confirm before it builds."))),
    h("section", { class: "section" }, h("h2", null, "Budget per run"), h("p", { class: "muted sm" }, "The harness stops and hands over its best result when any limit is reached."),
      h("div", { class: "three-col" },
        h("div", { class: "field" }, h("label", { for: "b-usd" }, "Spend limit (USD)"), inputs.maxUsdPerRun),
        h("div", { class: "field" }, h("label", { for: "b-min" }, "Time limit (minutes)"), inputs.maxMinutesPerRun),
        h("div", { class: "field" }, h("label", { for: "b-it" }, "Build attempts"), inputs.maxBuildIterations)),
      h("div", { class: "inline-row" }, saveBudget, budgetMsg)));
  clear(root).append(page);
  drawRows();
}
