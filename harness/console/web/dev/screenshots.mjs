// screenshots.mjs: takes the hand-back screenshots at 1280x720 with headless Edge or Chrome over the
// DevTools protocol (no dependencies; uses Node's built-in WebSocket). It starts the mock server itself.
//
//   node harness/console/web/dev/screenshots.mjs            all shots
//   node harness/console/web/dev/screenshots.mjs live       only shots whose name contains "live"
//   BROWSER="C:\path\to\msedge.exe" node …                  pick a browser
//
// Output: harness/console/web/screenshots/NN-name.png. The data is the SYNTHETIC fixture; the UI labels it.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockServer } from "./mock-server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "screenshots");
const CANDIDATES = [process.env.BROWSER, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean);
const browserPath = CANDIDATES.find((p) => existsSync(p));
if (!browserPath) { console.error("No Edge or Chrome found. Set BROWSER=<path>."); process.exit(2); }

const filter = process.argv[2] || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const mock = createMockServer({ speed: 10 });
const { url } = await mock.listen(0, 0);
const profile = mkdtempSync(join(tmpdir(), "shallowsee-shots-"));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(browserPath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--force-color-profile=srgb", "about:blank"], { stdio: "ignore" });

async function targetWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* browser still starting */ }
    await sleep(250);
  }
  throw new Error("browser did not start");
}

const ws = new WebSocket(await targetWs());
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => { const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed"); return r.result.value; };
const waitFor = async (expr, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(150); } throw new Error(`timed out waiting for: ${expr}`); };

await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });

async function go(hash) {
  await cdp("Page.navigate", { url: `${url}/${hash}` });
  await sleep(300);
  await waitFor("document.readyState === 'complete'");
  if (!hash.includes("#")) return;
  await evaluate(`location.hash = ${JSON.stringify(hash.slice(hash.indexOf("#")))}`);
  await sleep(500);
}
async function shot(name, { full = false, height } = {}) {
  if (height) await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height, deviceScaleFactor: 1, mobile: false });
  await sleep(350);
  const r = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  if (height) await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  console.log(`saved screenshots/${name}.png`);
}
const wanted = (name) => !filter || name.includes(filter);

try {
  if (wanted("setup-providers")) { await go("#/setup"); await waitFor("document.querySelector('.pcard')"); await shot("01-setup-providers"); }
  if (wanted("add-provider")) {
    await go("#/setup/new");
    await waitFor("document.querySelector('.preset')");
    await evaluate(`[...document.querySelectorAll('.preset')].find(b => b.textContent.startsWith('Anthropic')).click()`);
    await sleep(300);
    await shot("02-add-provider");
  }
  if (wanted("routing")) { await go("#/routing"); await waitFor("document.querySelector('.routing-table tbody tr')"); await shot("03-routing-budget", { height: 900 }); }
  if (wanted("make-a-wish")) {
    await go("#/new");
    await waitFor("document.querySelector('#wish')");
    await evaluate(`document.querySelector('.example').click()`);
    await sleep(200);
    await shot("04-make-a-wish");
  }
  if (wanted("live-run")) {
    await go("#/new");
    await waitFor("document.querySelector('#wish')");
    const runId = await evaluate(`fetch('/api/runs', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({wish:'I want a page that tells me if I need an umbrella tomorrow'})}).then(r => r.json()).then(j => j.runId)`);
    await evaluate(`location.hash = '#/runs/${runId}'`);
    await waitFor("document.querySelector('[data-testid=escalation]')", 120000);
    await sleep(1800);
    await shot("05-live-run-mid-run");
    await shot("05b-live-run-mid-run-full", { full: true, height: 1500 });
    await evaluate(`document.getElementById('show-tools').click()`);
    await waitFor("document.querySelector('[data-testid=result-banner]')", 120000);
    await sleep(800);
    await shot("06-result-delivered");
    await evaluate(`location.hash = '#/runs/${runId}/report'`);
    await waitFor("document.querySelector('[data-testid=report]')");
    await shot("07-result-report", { full: true, height: 1400 });
    await evaluate(`location.hash = '#/runs'`);
    await waitFor("document.querySelector('.runs-table tbody tr')");
    await shot("08-runs");
  }
  if (wanted("light")) {
    await go("#/runs/" + mock.sampleRunId);
    await waitFor("document.querySelector('[data-testid=result-banner]')");
    await evaluate(`document.documentElement.setAttribute('data-theme','light')`);
    await shot("09-result-light-theme");
  }
  if (wanted("phone")) {
    await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await go("#/runs/" + mock.sampleRunId);
    await waitFor("document.querySelector('[data-testid=result-banner]')");
    await sleep(300);
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, "10-phone-run.png"), Buffer.from(r.data, "base64"));
    console.log("saved screenshots/10-phone-run.png");
  }
} finally {
  try { ws.close(); } catch { /* already closed */ }
  proc.kill();
  await mock.close();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold the profile */ }
}
