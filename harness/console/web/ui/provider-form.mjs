// provider-form.mjs: Setup → Add provider (#/setup/new) and Edit provider (#/setup/:id).
// Layout follows CC Switch: back arrow and title, a large letter avatar, preset chips, then
// Provider name, Notes, Website, API Key, Request URL, Models, and a sticky Cancel / + Add footer.
// The API key lives only in this form's input until it is sent; the server never returns it.

import { orderPresets, presetChipLabel, isModelKind, keyStatusLabel, testOutcome } from "../model.mjs";
import { h, add, icon, chip, button, clear, toast } from "./dom.mjs";
import { get, post, put } from "./api.mjs";
import { openFetchDialog, letterOf } from "./setup.mjs";

const CAPABILITIES = ["reasoning", "coding", "vision", "tools", "json", "long_context"];
const CAP_LABEL = { reasoning: "reasoning", coding: "coding", vision: "vision", tools: "tools", json: "json", long_context: "long context" };

export async function mountProviderForm(root, id, { navigate, ticket }) {
  clear(root).append(h("p", { class: "muted pad" }, "Loading…"));
  const [cfg, pre] = await Promise.all([get("/api/config", { signal: ticket.signal }), get("/api/presets", { signal: ticket.signal })]);
  if (!ticket.isCurrent()) return;
  const editing = id !== null;
  const presets = orderPresets(pre.ok ? pre.data.presets || [] : []);
  const existing = cfg.ok && editing ? cfg.data.config.providers.find((p) => p.id === id) : null;
  if (!cfg.ok || (editing && !existing)) {
    clear(root).append(h("div", { class: "form-page" }, h("div", { class: "card empty-card" }, h("h2", null, editing && cfg.ok ? "That provider doesn't exist" : "Couldn't load your setup"), h("p", { class: "muted" }, cfg.error?.message || "It may have been deleted."), h("a", { class: "btn primary", href: "#/setup" }, "Back to providers"))));
    return;
  }

  // ---- form state
  const f = existing
    ? { preset: existing.preset || "custom", kind: existing.kind, name: existing.name, notes: existing.notes || "", website: existing.website || "", baseUrl: existing.baseUrl, apiKey: "", clearKey: false, enabled: existing.enabled !== false, models: (existing.models || []).map((m) => ({ ...m })), headerRows: Object.keys(existing.headers || {}).map((k) => ({ name: k, value: "" })), headersTouched: false }
    : { preset: null, kind: "openai_compatible", name: "", notes: "", website: "", baseUrl: "", apiKey: "", clearKey: false, enabled: true, models: [], headerRows: [], headersTouched: false };
  let saved = null;
  let fieldErrors = {};
  let generalError = "";
  let showKey = false;

  const presetById = (pid) => presets.find((p) => p.id === pid) || null;
  const currentPreset = () => presetById(f.preset);
  const keyOptional = () => { const p = currentPreset(); return p ? p.keyRequired === false : false; };

  function pickPreset(p) {
    f.preset = p.id;
    f.kind = p.kind;
    f.name = p.id === "custom" ? f.name : p.name;
    f.baseUrl = p.baseUrl || f.baseUrl;
    f.website = p.website || "";
    f.models = (p.models || []).map((m) => ({ ...m }));
    fieldErrors = {};
    generalError = "";
    draw();
    const key = document.getElementById("pf-key");
    if (key) key.focus();
  }

  // ---- pieces
  const body = h("div", { class: "form-page" });
  clear(root).append(body);

  function field(label, input, { hint, error, forId } = {}) {
    return h("div", { class: "field" }, h("label", { for: forId }, label), input, hint ? h("div", { class: "hint" }, hint) : null, error ? h("div", { class: "form-error", role: "alert" }, error) : null);
  }
  const textInput = (idv, key, placeholder, type = "text") => h("input", { id: idv, type, value: f[key], placeholder, autocomplete: "off", spellcheck: "false", "aria-invalid": fieldErrors[key] ? "true" : null, oninput: (e) => { f[key] = e.target.value; if (key === "name") avatarEl.textContent = letterOf(e.target.value || currentPreset()?.name); } });

  let avatarEl = h("div", { class: "letter big", "aria-hidden": "true" }, letterOf(f.name || currentPreset()?.name));

  function modelsSection() {
    if (!isModelKind(f.kind)) return null;
    const rows = h("div", { class: "mrows" });
    const newId = h("input", { type: "text", id: "pf-newmodel", placeholder: "Add a model by id, e.g. claude-sonnet-5-5", "aria-label": "Model id to add", onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); addModel(); } } });
    function addModel() {
      const v = newId.value.trim();
      if (!v) return;
      if (f.models.some((m) => m.id === v)) { toast("That model is already in the list.", "warn"); return; }
      f.models.push({ id: v, enabled: true });
      newId.value = "";
      drawRows();
    }
    function drawRows() {
      clear(rows);
      if (!f.models.length) rows.append(h("p", { class: "muted sm" }, f.preset && f.preset !== "custom" && !currentPreset()?.models?.length ? "No models yet. Save the provider, then use Fetch models to pick from its list, or type a model id below." : "No models yet. Type a model id below."));
      f.models.forEach((m, i) => {
        const caps = new Set(m.capabilities || []);
        rows.append(h("div", { class: "mrow", "data-model": m.id },
          h("input", { type: "text", value: m.id, "aria-label": `Model id ${i + 1}`, oninput: (e) => { m.id = e.target.value.trim(); } }),
          h("input", { type: "text", value: m.label || "", placeholder: "Label (optional)", "aria-label": `Label for ${m.id}`, oninput: (e) => { m.label = e.target.value || undefined; } }),
          h("label", { class: "switch" }, h("input", { type: "checkbox", checked: m.enabled !== false, "aria-label": `Enabled: ${m.id}`, onchange: (e) => { m.enabled = e.target.checked; } }), h("span", null, "Enabled")),
          h("select", { "aria-label": `Tier for ${m.id}`, onchange: (e) => { m.tier = e.target.value ? Number(e.target.value) : undefined; drawRows(); } },
            h("option", { value: "" }, "Tier: Auto"), [1, 2, 3].map((t) => h("option", { value: t, selected: m.tier === t }, `Tier ${t}`))),
          button("", { variant: "ghost danger sm", "aria-label": `Remove ${m.id}`, onclick: () => { f.models.splice(i, 1); drawRows(); } }, "trash"),
          h("div", { class: "caps" },
            m.tier === undefined && m.catalogMatched === false ? chip("Estimated tier", "warn", { title: "Not in the router's catalog, so its tier is a guess. Set a tier to be exact." }) : null,
            CAPABILITIES.map((c) => h("button", { type: "button", class: `cap${caps.has(c) ? " on" : ""}`, "aria-pressed": caps.has(c) ? "true" : "false", onclick: () => { if (caps.has(c)) caps.delete(c); else caps.add(c); m.capabilities = caps.size ? [...caps] : undefined; drawRows(); } }, CAP_LABEL[c])))));
      });
    }
    const fetchBtn = button("Fetch models", { variant: "secondary sm", disabled: !existing && !saved, title: existing || saved ? "Ask the provider for its model list" : "Add the provider first, then fetch its models", onclick: () => {
      const p = saved || existing;
      openFetchDialog({ provider: p, existingIds: f.models.map((m) => m.id), onAdd: (ids) => { for (const mid of ids) if (!f.models.some((m) => m.id === mid)) f.models.push({ id: mid, enabled: true }); drawRows(); toast(`${ids.length} model${ids.length === 1 ? "" : "s"} added to the list. Save to keep them.`, "good"); } });
    } }, "download");
    const section = h("section", { class: "models-section", "data-testid": "models-section" },
      h("div", { class: "inline" }, h("div", null, h("div", { class: "label" }, "Models"), h("div", { class: "hint" }, "Which models the harness may use from this provider. Fetching is manual and never changes the list on its own.")), fetchBtn),
      rows,
      h("div", { class: "add-model" }, newId, button("Add", { variant: "secondary sm", onclick: addModel }, "plus")));
    drawRows();
    return section;
  }

  function headersSection() {
    const rows = h("div");
    function drawRows() {
      clear(rows);
      f.headerRows.forEach((r, i) => rows.append(h("div", { class: "hrow" },
        h("input", { type: "text", value: r.name, placeholder: "Header name", "aria-label": `Header name ${i + 1}`, oninput: (e) => { r.name = e.target.value; f.headersTouched = true; } }),
        h("input", { type: "password", value: r.value, placeholder: existing && r.value === "" && existing.headers?.[r.name] ? "••• (re-enter to keep)" : "Value", autocomplete: "off", "aria-label": `Header value ${i + 1}`, oninput: (e) => { r.value = e.target.value; f.headersTouched = true; } }),
        button("", { variant: "ghost danger sm", "aria-label": "Remove header", onclick: () => { f.headerRows.splice(i, 1); f.headersTouched = true; drawRows(); } }, "trash"))));
      if (!f.headerRows.length) rows.append(h("p", { class: "muted sm" }, "No extra headers."));
    }
    drawRows();
    return h("details", { class: "adv" }, h("summary", null, "Advanced: extra request headers"),
      h("p", { class: "hint" }, "Rarely needed. Header values are treated like keys: they are never shown again. Saving changed headers replaces all of them."),
      rows, button("Add header", { variant: "ghost sm", onclick: () => { f.headerRows.push({ name: "", value: "" }); f.headersTouched = true; drawRows(); } }, "plus"));
  }

  function keyField() {
    const p = currentPreset();
    const optional = keyOptional();
    const input = h("input", { id: "pf-key", type: showKey ? "text" : "password", value: f.apiKey, autocomplete: "off", spellcheck: "false", "data-testid": "api-key",
      placeholder: existing ? (existing.apiKey?.hasKey ? `Leave empty to keep the stored key (${keyStatusLabel(existing.apiKey)})` : "Paste an API key") : (optional ? "Not needed for this provider" : "Only this is required; the rest fills in automatically"),
      "aria-invalid": fieldErrors.apiKey ? "true" : null, oninput: (e) => { f.apiKey = e.target.value; if (f.clearKey && f.apiKey) f.clearKey = false; } });
    const toggle = h("button", { type: "button", "aria-label": showKey ? "Hide API key" : "Show API key", title: showKey ? "Hide" : "Show", onclick: () => { showKey = !showKey; input.type = showKey ? "text" : "password"; toggle.replaceChildren(icon(showKey ? "eyeOff" : "eye", 17)); toggle.setAttribute("aria-label", showKey ? "Hide API key" : "Show API key"); } }, icon(showKey ? "eyeOff" : "eye", 17));
    const label = h("div", { class: "inline" }, h("label", { for: "pf-key" }, "API Key"),
      existing && existing.apiKey?.hasKey ? h("button", { type: "button", class: "linklike", onclick: () => { f.clearKey = !f.clearKey; f.apiKey = ""; draw(); } }, f.clearKey ? "Undo clear" : "Clear key") : null);
    return h("div", { class: "field" }, label, h("div", { class: "key-wrap" }, input, toggle),
      f.clearKey ? h("div", { class: "hint warn-text" }, "The stored key will be removed when you save.") : null,
      p?.keyHint && !existing ? h("div", { class: "hint" }, p.keyHint) : null,
      fieldErrors.apiKey ? h("div", { class: "form-error", role: "alert" }, fieldErrors.apiKey) : null);
  }

  // ---- main draw
  function draw() {
    avatarEl = h("div", { class: "letter big", "aria-hidden": "true" }, letterOf(f.name || currentPreset()?.name));
    const submitLabel = editing ? "Save" : "Add";
    const testRes = h("div", { class: "test-result", role: "status", hidden: true, "data-testid": "saved-test" });
    const savedCard = saved ? h("div", { class: "saved-card", "data-testid": "saved-card", role: "status" },
      h("div", null, h("b", null, editing ? `Saved ${saved.name}.` : `Added ${saved.name}.`), h("div", { class: "muted sm" }, "Check that the key works before you start a run.")),
      h("div", { class: "pactions", style: "justify-content:flex-start" },
        button("Test connection", { variant: "primary", onclick: async (e) => {
          const btn = e.currentTarget; btn.disabled = true; testRes.hidden = false; testRes.className = "test-result"; testRes.textContent = "Testing…";
          const res = await post(`/api/providers/${encodeURIComponent(saved.id)}/test`, {});
          btn.disabled = false;
          const o = res.ok ? testOutcome(res.data) : { tone: "bad", text: res.error?.message || "The test failed." };
          testRes.className = `test-result ${o.tone}`; testRes.textContent = o.text;
        } }, "bolt"),
        isModelKind(saved.kind) ? button("Fetch models", { variant: "secondary", onclick: () => openFetchDialog({ provider: saved, existingIds: (saved.models || []).map((m) => m.id), onAdd: async (ids) => {
          const next = [...(saved.models || []).map(({ catalogMatched, ...m }) => m), ...ids.map((mid) => ({ id: mid, enabled: true }))];
          const res = await put(`/api/providers/${encodeURIComponent(saved.id)}`, { models: next });
          if (res.ok) { saved = res.data.provider; f.models = (saved.models || []).map((m) => ({ ...m })); toast("Models added.", "good"); draw(); } else toast(res.error?.message || "Couldn't add the models.", "bad");
        } }) }, "download") : null,
        h("a", { class: "btn secondary", href: "#/setup" }, "Back to providers")),
      testRes) : null;

    const presetRow = !editing ? h("div", { class: "chips-row", role: "group", "aria-label": "Provider presets", "data-testid": "presets" }, presets.map((p) => h("button", { type: "button", class: `preset${f.preset === p.id ? " on" : ""}`, "aria-pressed": f.preset === p.id ? "true" : "false", onclick: () => pickPreset(p) }, presetChipLabel(p)))) : null;
    clear(body);
    add(body,
      h("div", { class: "form-top" }, h("a", { class: "back", href: "#/setup", "aria-label": "Back to providers" }, icon("back", 18)), h("h1", null, editing ? "Edit provider" : "Add provider"), avatarEl),
      savedCard,
      generalError ? h("div", { class: "notice bad", role: "alert" }, generalError) : null,
      presetRow,
      field("Provider name", textInput("pf-name", "name", "e.g. Claude official"), { forId: "pf-name", error: fieldErrors.name }),
      field("Notes", textInput("pf-notes", "notes", "e.g. company account"), { forId: "pf-notes" }),
      field("Website", textInput("pf-site", "website", "https://example.com (optional)", "url"), { forId: "pf-site", error: fieldErrors.website }),
      keyField(),
      field("Request URL", textInput("pf-url", "baseUrl", "https://your-api-endpoint.com", "url"), { forId: "pf-url", hint: "The address requests are sent to, without a trailing slash.", error: fieldErrors.baseUrl }),
      modelsSection(),
      headersSection(),
      h("div", { class: "sticky-foot" }, h("div", null,
        h("span", { class: "hint" }, "💡 After picking a preset, just fill in the API key"),
        saved ? h("a", { class: "btn primary", href: "#/setup" }, "Done") : [
          h("a", { class: "btn secondary", href: "#/setup", "data-testid": "cancel" }, "Cancel"),
          button(editing ? "Save" : "+ Add", { variant: "primary", id: "pf-submit", "data-testid": "submit", onclick: submit }),
        ])));
  }

  function issuesToFields(issues) {
    const map = {};
    const rest = [];
    for (const i of issues || []) {
      const p = String(i.path || "");
      const key = /baseUrl/i.test(p) ? "baseUrl" : /apiKey/i.test(p) ? "apiKey" : /(^|\.)name$/i.test(p) ? "name" : /website/i.test(p) ? "website" : null;
      if (key) map[key] = map[key] ? `${map[key]} ${i.message}` : i.message; else rest.push(i.message);
    }
    return { map, rest };
  }

  async function submit(ev) {
    const btn = ev.currentTarget;
    fieldErrors = {}; generalError = "";
    const p = currentPreset();
    const input = {
      name: f.name.trim() || p?.name || "",
      preset: f.preset || "custom",
      kind: f.kind,
      enabled: f.enabled,
      notes: f.notes.trim(),
      website: f.website.trim(),
      baseUrl: f.baseUrl.trim().replace(/\/+$/, ""),
    };
    if (isModelKind(f.kind)) input.models = f.models.filter((m) => m.id).map(({ catalogMatched, ...m }) => m);
    if (f.apiKey) input.apiKey = f.apiKey; else if (f.clearKey) input.apiKey = null;
    if (f.headersTouched) { const hs = {}; for (const r of f.headerRows) if (r.name.trim() && r.value) hs[r.name.trim()] = r.value; input.headers = Object.keys(hs).length ? hs : null; }
    // client-side checks that save a round trip
    if (!input.baseUrl) fieldErrors.baseUrl = f.preset ? "Enter the request URL." : "Pick a preset above, or enter the request URL.";
    if (!input.name) fieldErrors.name = "Give the provider a name.";
    if (!editing && !f.apiKey && !keyOptional()) fieldErrors.apiKey = "Paste the API key. It stays on this computer.";
    if (Object.keys(fieldErrors).length) { draw(); const first = document.querySelector('[aria-invalid="true"]'); if (first) first.focus(); return; }
    btn.disabled = true;
    const res = editing ? await put(`/api/providers/${encodeURIComponent(id)}`, input) : await post("/api/providers", input);
    if (res.ok) {
      saved = res.data.provider;
      f.apiKey = ""; f.clearKey = false; f.headersTouched = false;
      f.models = (saved.models || []).map((m) => ({ ...m }));
      draw();
      window.scrollTo(0, 0);
      return;
    }
    const { map, rest } = issuesToFields(res.data?.error?.issues || res.data?.issues);
    fieldErrors = map;
    generalError = rest.length ? rest.join(" ") : Object.keys(map).length ? "" : res.error?.message || "Couldn't save the provider.";
    draw();
    window.scrollTo(0, 0);
  }

  draw();
}
