// cdp.mjs: a minimal headless Edge/Chrome driver over the DevTools protocol (no dependencies, Node's
// built-in WebSocket). Used by screenshots.mjs and ui-smoke.mjs. Not part of the product.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [process.env.BROWSER, "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);

export function findBrowser() {
  return CANDIDATES.find((p) => existsSync(p)) || null;
}

/** Launches a headless browser and returns { evaluate, waitFor, go, screenshot, setViewport, close, errors }. */
export async function launch({ width = 1280, height = 720 } = {}) {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error("No Edge or Chrome found. Set BROWSER=<path to the executable>.");
  const profile = mkdtempSync(join(tmpdir(), "shallowsee-cdp-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(browserPath, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--force-color-profile=srgb", "about:blank"], { stdio: "ignore" });
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl || null;
    } catch { /* still starting */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) { proc.kill(); throw new Error("The browser did not start."); }
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "exception");
    else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push((m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))); ws.send(JSON.stringify({ id: n, method, params })); });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  const setViewport = (w, h, scale = 1, mobile = false) => cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: scale, mobile });
  await setViewport(width, height);

  const evaluate = async (expression) => {
    const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed");
    return r.result.value;
  };
  const waitFor = async (expr, ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await sleep(120); }
    throw new Error(`timed out waiting for: ${expr}`);
  };
  async function go(base, hash) {
    await cdp("Page.navigate", { url: `${base}/` });
    await sleep(250);
    await waitFor("document.readyState === 'complete'");
    await evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await sleep(450);
  }
  async function screenshot(file, { full = false, height: h2 } = {}) {
    if (h2) await setViewport(1280, h2);
    await sleep(300);
    const r = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
    writeFileSync(file, Buffer.from(r.data, "base64"));
    if (h2) await setViewport(width, height);
  }
  async function close() {
    try { ws.close(); } catch { /* already closed */ }
    proc.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold the profile */ }
  }
  return { cdp, evaluate, waitFor, go, screenshot, setViewport, close, errors };
}
