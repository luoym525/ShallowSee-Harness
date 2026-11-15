// dom.mjs: tiny DOM helpers. Everything goes in through textContent or setAttribute, never innerHTML,
// except setMarkdown(), which only accepts output of markdown.mjs (HTML-escaped by construction).

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * h("div", { class: "x", onclick: fn, "aria-label": "…" }, child, [children], "text")
 * Props: class, text, html is NOT supported. on* are listeners. false/null/undefined props are skipped.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else if (k === "disabled") el.disabled = !!v;
      else if (k === "dataset") Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Like el.append(...) but skips null, undefined and false (native append would print "null"). */
export function add(el, ...children) {
  return append(el, children);
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

const ICONS = {
  back: "M15 5l-7 7 7 7",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  eye: "M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  eyeOff: "M3 3l18 18M10.6 6.2A9.7 9.7 0 0112 6c6.4 0 10 6 10 6a17 17 0 01-3.1 3.8M6.2 7.6A16.6 16.6 0 002 12s3.6 6 10 6c1.4 0 2.7-.3 3.8-.8M9.9 9.9a3 3 0 004.2 4.2",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3",
  edit: "M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4",
  bolt: "M13 3L5 14h6l-1 7 8-11h-6l1-7z",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5",
  refresh: "M20 11a8 8 0 10-2.3 5.7M20 5v6h-6",
  sun: "M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z",
  auto: "M12 3v2M12 19v2M3 12h2M19 12h2M12 8a4 4 0 100 8 4 4 0 000-8z",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5",
  download: "M12 4v11M7 11l5 5 5-5M5 20h14",
  copy: "M9 9h10v10H9zM5 15V5h10",
  stop: "M7 7h10v10H7z",
  file: "M7 3h7l5 5v13H7zM14 3v5h5",
  folder: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  chevron: "M9 6l6 6-6 6",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  layers: "M12 4l8.5 4.5L12 13 3.5 8.5zM3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5",
};

export function icon(name, size = 16) {
  const s = svg("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "icon" });
  s.append(svg("path", { d: ICONS[name] || ICONS.spark }));
  return s;
}

/** Sets Markdown HTML produced by markdown.mjs (everything in it is already escaped). */
export function setMarkdown(el, html) {
  el.innerHTML = html;
  return el;
}

export function toast(message, tone = "info") {
  const box = document.getElementById("toasts");
  if (!box) return;
  const t = h("div", { class: `toast ${tone}`, role: "status" }, message);
  box.append(t);
  setTimeout(() => t.remove(), tone === "bad" ? 7000 : 3800);
}

/** A plain-text button with an optional icon. */
export function button(label, props = {}, iconName = null) {
  const { variant = "secondary", ...rest } = props;
  return h("button", { type: "button", ...rest, class: `btn ${variant}${rest.class ? ` ${rest.class}` : ""}` }, iconName ? icon(iconName, 15) : null, h("span", null, label));
}

export function chip(text, tone = "muted", extra = {}) {
  return h("span", { ...extra, class: `chip ${tone}${extra.class ? ` ${extra.class}` : ""}` }, text);
}

export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function onReducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}
