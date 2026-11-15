// app.js: hash router and shell. Screens live in ui/*.mjs; all state comes from the console server.
//   #/new            Make a wish            #/runs            Run history
//   #/runs/:id[/report|/files]   Live run   #/setup           Providers
//   #/setup/new, #/setup/:id     Add / edit provider            #/routing   Routing & budget

import { h, clear, icon } from "./ui/dom.mjs";
import { mountWish, mountRuns } from "./ui/wish.mjs";
import { mountRun } from "./ui/run.mjs";
import { mountSetup, mountProviderForm, mountRouting } from "./ui/setup.mjs";

const app = document.getElementById("app");
const conn = document.getElementById("connection");
let current = null;

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function setConnection(text, tone = "muted") {
  conn.replaceChildren();
  if (!text) return;
  conn.className = `conn ${tone}`;
  conn.append(h("span", { class: "dot" }), text);
}

function setNav(name) {
  for (const a of document.querySelectorAll("#nav a")) {
    const on = a.dataset.nav === name;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

function parse() {
  const raw = (location.hash || "#/new").replace(/^#/, "");
  const [path] = raw.split("?");
  return path.split("/").filter(Boolean).map(decodeURIComponent);
}

async function route() {
  const parts = parse();
  const [a, b, c] = parts;
  setConnection("", "muted");

  // Moving between tabs of the same run keeps the stream open.
  if (current && current.kind === "run" && a === "runs" && b === current.id && b) {
    current.api.setTab(c === "report" ? "report" : c === "files" ? "files" : "run");
    return;
  }
  if (current && current.api && current.api.unmount) current.api.unmount();
  current = null;
  window.scrollTo(0, 0);

  if (a === "runs" && b && /^hr-\d{8}-\d{6}-[a-z0-9]{4}$/.test(b)) {
    setNav("runs");
    const api = mountRun(app, b, { tab: c === "report" ? "report" : c === "files" ? "files" : "run", setConnection });
    current = { kind: "run", id: b, api };
    document.title = "Run · ShallowSee Autopilot";
    return;
  }
  if (a === "runs") { setNav("runs"); document.title = "Runs · ShallowSee Autopilot"; await mountRuns(app); return; }
  if (a === "setup" && b) { setNav("setup"); document.title = "Provider · ShallowSee Autopilot"; await mountProviderForm(app, b === "new" ? null : b, { navigate }); return; }
  if (a === "setup") { setNav("setup"); document.title = "Setup · ShallowSee Autopilot"; await mountSetup(app, { navigate }); return; }
  if (a === "routing") { setNav("setup"); document.title = "Routing & budget · ShallowSee Autopilot"; await mountRouting(app, { navigate }); return; }
  if (!a || a === "new") { setNav("new"); document.title = "Make a wish · ShallowSee Autopilot"; await mountWish(app, { navigate }); return; }
  setNav("");
  clear(app).append(h("div", { class: "page-narrow" }, h("div", { class: "card empty-card" }, h("h2", null, "That page doesn't exist"), h("a", { class: "btn primary", href: "#/new" }, "Make a wish"))));
}

// ---- theme: light by default; "system" follows the OS; the choice is remembered when storage allows
const THEMES = ["light", "dark", "system"];
const themeBtn = document.getElementById("theme-toggle");
function currentTheme() {
  const t = document.documentElement.getAttribute("data-theme");
  return THEMES.includes(t) ? t : "light";
}
function paintThemeButton() {
  const t = currentTheme();
  themeBtn.replaceChildren(icon(t === "dark" ? "moon" : t === "light" ? "sun" : "auto", 18));
  const label = `Theme: ${t}. Click to change.`;
  themeBtn.setAttribute("aria-label", label);
  themeBtn.title = label;
}
themeBtn.addEventListener("click", () => {
  const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("shallowsee.theme", next); } catch { /* storage blocked: the choice lasts until reload */ }
  paintThemeButton();
});
paintThemeButton();

window.addEventListener("hashchange", route);
route();
