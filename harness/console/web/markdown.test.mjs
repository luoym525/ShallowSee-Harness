import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown, renderInline, escapeHtml, safeHref } from "./markdown.mjs";

test("escapes all HTML, including raw tags and attributes", () => {
  const html = renderMarkdown('# <img src=x onerror=alert(1)>\n\n<script>alert("x")</script> and <b>bold</b>\n\n`<div>`');
  assert.doesNotMatch(html, /<script|<img|<b>|<div>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<h2>&lt;img src=x onerror=alert\(1\)&gt;<\/h2>/);
  assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
});

test("links: only http(s) and mailto survive; javascript: and data: become plain text", () => {
  assert.match(renderInline("[ok](https://example.com/a?b=1&c=2)"), /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html;base64,AAAA", "vbscript:x", "//evil.example/x", "/relative"]) {
    const out = renderInline(`[click](${bad})`);
    assert.doesNotMatch(out, /<a /, bad);
    assert.match(out, /click/);
  }
  assert.equal(safeHref('https://x.y/"onmouseover="alert(1)'), null);
  assert.match(renderInline("see https://open-meteo.com/en/docs."), /<a href="https:\/\/open-meteo\.com\/en\/docs"[^>]*>https:\/\/open-meteo\.com\/en\/docs<\/a>\./);
});

test("headings (offset), lists, nested lists, task boxes, rules, quotes", () => {
  const html = renderMarkdown("# Title\n\n## Sub\n\n- one\n  - nested\n- two\n\n1. first\n2. second\n\n- [x] done\n- [ ] todo\n\n---\n\n> quoted **bold**");
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<h3>Sub<\/h3>/);
  assert.match(html, /<ul><li>one<ul><li>nested<\/li><\/ul><\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /md-box done/);
  assert.match(html, /<hr>/);
  assert.match(html, /<blockquote><p>quoted <strong>bold<\/strong><\/p><\/blockquote>/);
  assert.match(renderMarkdown("# T", { headingOffset: 0 }), /<h1>T<\/h1>/);
});

test("tables with alignment and escaped cells", () => {
  const html = renderMarkdown("| A | B |\n|:--|--:|\n| <i>x</i> | `y\\|z` |\n| 2 |");
  assert.match(html, /<table>/);
  assert.match(html, /<th style="text-align:left">A<\/th>/);
  assert.match(html, /<th style="text-align:right">B<\/th>/);
  assert.match(html, /&lt;i&gt;x&lt;\/i&gt;/);
  assert.doesNotMatch(html, /<i>/);
  assert.match(html, /<td style="text-align:right"><\/td>/);
});

test("fenced code keeps its text verbatim (escaped) and ends at the fence", () => {
  const html = renderMarkdown("```js\nconst a = '<b>';\n# not a heading\n```\n\nafter");
  assert.match(html, /<pre class="md-code" data-lang="js"><code>const a = &#39;&lt;b&gt;&#39;;\n# not a heading<\/code><\/pre>/);
  assert.match(html, /<p>after<\/p>/);
  // an unclosed fence runs to the end without throwing
  assert.match(renderMarkdown("```\nopen"), /<code>open<\/code>/);
});

test("emphasis and inline code", () => {
  const html = renderInline("**b** *i* `c*d*` ~~s~~ snake_case_word");
  assert.match(html, /<strong>b<\/strong>/);
  assert.match(html, /<em>i<\/em>/);
  assert.match(html, /<code>c\*d\*<\/code>/);
  assert.match(html, /<del>s<\/del>/);
  assert.match(html, /snake_case_word/);
});

test("the synthetic REPORT.md fixture renders safely with its sections and table", () => {
  const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-run", "REPORT.md"), "utf8");
  const html = renderMarkdown(md, { headingOffset: 0 });
  for (const h of ["What you asked for", "What you got", "How to use it", "What was checked", "Known gaps", "Fact check", "Assumptions we made for you", "Sources", "How it was built"]) assert.match(html, new RegExp(`<h2>${h}</h2>`));
  assert.match(html, /<table>/);
  assert.match(html, /Synthetic sample/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /href="https:\/\/open-meteo\.com\/en\/docs"/);
  assert.match(html, /<pre class="md-code" data-lang="text">/);
});
