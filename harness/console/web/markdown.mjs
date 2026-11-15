// markdown.mjs: a tiny, safe Markdown renderer for REPORT.md and README files.
// Supports headings, paragraphs, bullet and numbered lists (nested by indent), task boxes,
// GFM tables, fenced code, inline code, bold, italic, links, bare URLs, blockquotes and rules.
// ALL text is HTML-escaped; raw HTML in the source is shown as text, never rendered.
// Links are kept only for http(s) and mailto URLs; anything else becomes plain text.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

export function safeHref(url) {
  const u = String(url ?? "").trim();
  if (/^https?:\/\/[^\s"'<>]+$/i.test(u)) return u;
  if (/^mailto:[^\s"'<>]+$/i.test(u)) return u;
  return null;
}

function link(href, textHtml) {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${textHtml}</a>`;
}

function emphasis(escaped) {
  return escaped
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~([^~]+?)~~/g, "<del>$1</del>");
}

function plainWithAutolinks(raw) {
  let out = "";
  let last = 0;
  const re = /https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;
  let m;
  while ((m = re.exec(raw))) {
    out += emphasis(escapeHtml(raw.slice(last, m.index)));
    const href = safeHref(m[0]);
    out += href ? link(href, escapeHtml(m[0])) : escapeHtml(m[0]);
    last = m.index + m[0].length;
  }
  out += emphasis(escapeHtml(raw.slice(last)));
  return out;
}

function withLinks(raw) {
  let out = "";
  let last = 0;
  const re = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(raw))) {
    out += plainWithAutolinks(raw.slice(last, m.index));
    const href = safeHref(m[2]);
    const text = emphasis(escapeHtml(m[1]));
    out += href ? link(href, text) : text;
    last = m.index + m[0].length;
  }
  out += plainWithAutolinks(raw.slice(last));
  return out;
}

/** Inline Markdown → safe HTML. */
export function renderInline(raw) {
  const s = String(raw ?? "");
  let out = "";
  let last = 0;
  const re = /(`+)([\s\S]*?[^`])\1(?!`)/g;
  let m;
  while ((m = re.exec(s))) {
    out += withLinks(s.slice(last, m.index));
    out += `<code>${escapeHtml(m[2].trim())}</code>`;
    last = m.index + m[0].length;
  }
  out += withLinks(s.slice(last));
  return out;
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") { cur += "|"; i++; continue; }
    if (t[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

function renderList(lines, start, opts) {
  // Builds nested lists from consecutive list lines. Returns [html, nextIndex].
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (m) {
      items.push({ indent: m[1].replace(/\t/g, "  ").length, ordered: /\d/.test(m[2]), text: m[3] });
      i++;
      continue;
    }
    // a continuation line (indented, non-blank) joins the previous item
    if (items.length && /^\s{2,}\S/.test(lines[i]) && !LIST_ITEM.test(lines[i])) {
      items[items.length - 1].text += ` ${lines[i].trim()}`;
      i++;
      continue;
    }
    break;
  }
  let html = "";
  const stack = []; // { indent, tag }
  for (const it of items) {
    const tag = it.ordered ? "ol" : "ul";
    while (stack.length && it.indent < stack[stack.length - 1].indent) {
      html += `</li></${stack.pop().tag}>`;
    }
    if (!stack.length || it.indent > stack[stack.length - 1].indent) {
      stack.push({ indent: it.indent, tag });
      html += `<${tag}>`;
    } else {
      html += "</li>";
    }
    let text = it.text;
    let box = "";
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (task) {
      box = task[1] === " " ? '<span class="md-box" aria-label="not done">☐</span> ' : '<span class="md-box done" aria-label="done">☑</span> ';
      text = task[2];
    }
    html += `<li>${box}${renderInline(text)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return [html, i];
}

/**
 * Markdown → safe HTML string. `headingOffset` shifts heading levels (1 → h2 when offset is 1)
 * so a document's "# Title" doesn't compete with the page's own h1.
 */
export function renderMarkdown(md, opts = {}) {
  const offset = Number.isInteger(opts.headingOffset) ? opts.headingOffset : 1;
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let para = [];
  const flush = () => {
    if (para.length) {
      html += `<p>${renderInline(para.join(" "))}</p>`;
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const close = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++; // skip the closing fence (or run past the end)
      const lang = fence[2] ? ` data-lang="${escapeHtml(fence[2])}"` : "";
      html += `<pre class="md-code"${lang}><code>${escapeHtml(body.join("\n"))}</code></pre>`;
      continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(6, heading[1].length + offset);
      html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html += "<hr>"; i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const cell = (tag, text, idx) => `<${tag}${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ""}>${renderInline(text)}</${tag}>`;
      html += `<div class="md-table"><table><thead><tr>${head.map((c, idx) => cell("th", c, idx)).join("")}</tr></thead><tbody>`;
      for (const r of rows) {
        const cells = head.map((_, idx) => r[idx] ?? "");
        html += `<tr>${cells.map((c, idx) => cell("td", c, idx)).join("")}</tr>`;
      }
      html += "</tbody></table></div>";
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      html += `<blockquote>${renderMarkdown(body.join("\n"), { headingOffset: offset })}</blockquote>`;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      const [listHtml, next] = renderList(lines, i, opts);
      html += listHtml;
      i = next;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return html;
}
