// ui-smoke.mjs: clicks through every screen in headless Edge/Chrome against the mock server and checks
// the results. Not part of `node --test` (needs a browser); skips cleanly when none is installed.
//
//   node harness/console/web/dev/ui-smoke.mjs        exit 0 = all checks passed, 1 = a check failed, 0 + "SKIPPED" = no browser

import { createMockServer } from "./mock-server.mjs";
import { findBrowser, launch, sleep } from "./cdp.mjs";

if (!findBrowser()) { console.log("SKIPPED: no Edge or Chrome found (set BROWSER=<path> to run the UI smoke test)."); process.exit(0); }

const mock = createMockServer({ speed: 60 });
const { url } = await mock.listen(0, 0);
const b = await launch();
let failed = 0;
const ok = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failed += 1; };
const text = (sel) => b.evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
const exists = (sel) => b.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
const clickText = (sel, t) => b.evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.trim().startsWith(${JSON.stringify(t)})); if (!e) throw new Error('no ${sel} starting with ${t}'); e.click(); })()`);
const click = (sel) => b.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
const setValue = (sel, v) => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const hash = (h) => b.evaluate(`location.hash = ${JSON.stringify(h)}`).then(() => sleep(400));
const FAKE_KEY = "smoke-test-key-0123456789";

try {
  // ---- Setup list
  await b.go(url, "#/setup");
  await b.waitFor("document.querySelectorAll('.pcard').length === 4");
  ok(true, "Setup lists 4 provider cards");
  ok((await text('[data-provider="anthropic"] [data-testid=key-status]')).includes("sk-…ab12"), "Anthropic card shows the key preview sk-…ab12");
  ok((await text('[data-provider="github"] [data-testid=key-status]')).includes("No key"), "GitHub card shows No key");
  ok((await text('[data-provider="anthropic"]')).includes("4 models"), "Anthropic card shows its model count");
  ok((await text('[data-provider="openrouter"]')).includes("1 estimated tier"), "OpenRouter shows an Estimated tier chip (catalogMatched false)");
  ok(await b.evaluate(`document.querySelector('[data-provider="github"] input[type=checkbox]').checked === false`), "GitHub is disabled (toggle off)");
  await b.evaluate(`[...document.querySelectorAll('[data-provider="anthropic"] button')].find(x => x.textContent.trim() === 'Test').click()`);
  await b.waitFor(`document.querySelector('[data-provider="anthropic"] [data-testid=test-result]').innerText.startsWith('Connected')`);
  ok((await text('[data-provider="anthropic"] [data-testid=test-result]')).includes(" ms"), "Test shows latency inline");

  // ---- Add provider: DeepSeek preset (mock answers 401 for it)
  await click("[data-testid=add-provider]");
  await b.waitFor("document.querySelector('[data-testid=presets]')");
  ok((await text("[data-testid=presets]")).includes("Ollama (local)"), "Preset chips include Ollama (local)");
  await clickText(".preset", "DeepSeek");
  ok(await b.evaluate(`document.getElementById('pf-name').value === 'DeepSeek' && document.getElementById('pf-url').value === 'https://api.deepseek.com'`), "Choosing a preset fills name and request URL");
  ok(await b.evaluate(`document.getElementById('pf-key').placeholder === 'Only this is required; the rest fills in automatically'`), "API key placeholder matches the CC Switch wording");
  await click("[data-testid=submit]");
  await b.waitFor("document.body.innerText.includes('Paste the API key')");
  ok(true, "Adding without a key shows an inline error");
  await setValue("#pf-key", FAKE_KEY);
  await click("[data-testid=submit]");
  await b.waitFor("document.querySelector('[data-testid=saved-card]')");
  ok(true, "Adding with a key shows the saved card");
  ok(!(await b.evaluate(`document.documentElement.outerHTML.includes(${JSON.stringify(FAKE_KEY)})`)), "The typed key is not in the page markup after saving");
  ok(!(await b.evaluate(`fetch('/api/config').then(r => r.text()).then(t => t.includes(${JSON.stringify(FAKE_KEY)}))`)), "The typed key is not in GET /api/config");
  await clickText("[data-testid=saved-card] button", "Test connection");
  await b.waitFor("document.querySelector('[data-testid=saved-test]').innerText.includes('Key rejected')");
  ok(true, "Test connection after saving reports 'Key rejected (401)' inline");
  await clickText("[data-testid=saved-card] button", "Fetch models");
  await b.waitFor("document.querySelector('[data-testid=fetch-outcome]')");
  ok((await text("[data-testid=fetch-outcome]")).startsWith("Key rejected (401/403)"), "Fetch models: key rejected is distinct");
  ok((await text("[data-testid=fetch-outcome]")).endsWith("Your configured models were kept."), "…and says the configured models were kept");
  await clickText("dialog button", "Close");

  // ---- Custom provider with no list endpoint; Ollama unreachable
  await hash("#/setup"); await hash("#/setup/new");
  await b.waitFor("document.querySelector('.preset')");
  await clickText(".preset", "Custom");
  await setValue("#pf-name", "Nolist example");
  await setValue("#pf-url", "https://example.com/v1");
  await setValue("#pf-key", FAKE_KEY);
  await click("[data-testid=submit]");
  await b.waitFor("document.querySelector('[data-testid=saved-card]')");
  await clickText("[data-testid=saved-card] button", "Fetch models");
  await b.waitFor("document.querySelector('[data-testid=fetch-outcome]')");
  ok((await text("[data-testid=fetch-outcome]")).startsWith("This provider has no model list endpoint"), "Fetch models: no list endpoint is distinct");
  await clickText("dialog button", "Close");
  await hash("#/setup"); await hash("#/setup/new");
  await b.waitFor("document.querySelector('.preset')");
  await clickText(".preset", "Ollama");
  await click("[data-testid=submit]");
  await b.waitFor("document.querySelector('[data-testid=saved-card]')");
  ok(true, "Ollama (local) can be added without a key");
  await clickText("[data-testid=saved-card] button", "Fetch models");
  await b.waitFor("document.querySelector('[data-testid=fetch-outcome]')");
  ok((await text("[data-testid=fetch-outcome]")).startsWith("Couldn't reach the provider"), "Fetch models: unreachable is distinct");
  await clickText("dialog button", "Close");

  // ---- Edit: OpenRouter, fetch and add a model, set a tier
  await hash("#/setup/openrouter");
  await b.waitFor("document.querySelector('[data-testid=models-section] .mrow')");
  ok(await b.evaluate(`document.querySelectorAll('.mrow').length === 2 && !!document.querySelector('.mrow .chip.warn')`), "Edit shows 2 models, one marked Estimated tier");
  ok(await b.evaluate(`document.getElementById('pf-key').placeholder.includes('Leave empty to keep the stored key (sk-…9f3c)')`), "Edit: empty key field means keep the stored key");
  ok(await exists("button.linklike"), "Edit offers a Clear key link");
  await clickText("[data-testid=models-section] button", "Fetch models");
  await b.waitFor("document.querySelector('.checklist')");
  ok(await b.evaluate(`document.querySelectorAll('.checklist input:disabled:checked').length === 2`), "Fetch checklist locks the 2 models already added");
  await b.evaluate(`document.querySelector('.checklist input:not(:disabled)').click()`);
  await clickText("dialog button", "Add 1 selected");
  await b.waitFor("document.querySelectorAll('.mrow').length === 3");
  await b.evaluate(`document.querySelector('.mrow select').value = '2'; document.querySelector('.mrow select').dispatchEvent(new Event('change'))`);
  await click("[data-testid=submit]");
  await b.waitFor("document.querySelector('[data-testid=saved-card]')");
  await hash("#/setup");
  await b.waitFor("document.querySelectorAll('.pcard').length >= 5");
  ok((await text('[data-provider="openrouter"]')).includes("3 models"), "After saving, the list shows 3 models for OpenRouter");

  // ---- Delete with confirmation
  await b.evaluate(`[...document.querySelectorAll('[data-provider="nolist-example"] button')].find(x => x.textContent.trim() === 'Delete').click()`);
  await b.waitFor("document.querySelector('[data-testid=delete-dialog]')");
  ok((await text("[data-testid=delete-dialog]")).includes("Delete Nolist example?"), "Delete asks for confirmation");
  await clickText("dialog button", "Delete provider");
  await b.waitFor("!document.querySelector('[data-provider=\"nolist-example\"]')");
  ok(true, "Confirming removes the card");

  // ---- Routing & budget
  await hash("#/routing");
  await b.waitFor("document.querySelectorAll('.routing-table tbody tr').length === 9");
  ok(true, "Routing table has a row for every role");
  const plannerModel = await text('[data-role="planner"] td:nth-child(2)');
  const reviewerModel = await text('[data-role="reviewer"] td:nth-child(2)');
  ok(plannerModel !== reviewerModel, `Planner (${plannerModel.trim()}) and reviewer (${reviewerModel.trim()}) differ`);
  await b.evaluate(`(() => { const s = document.querySelector('[data-role="planner"] select'); s.value = [...s.options].find(o => o.value.endsWith('claude-opus-5-5')).value; s.dispatchEvent(new Event('change')); })()`);
  await b.waitFor(`document.querySelector('[data-role="planner"]').innerText.includes('Pinned')`);
  ok(true, "Pinning a model for the planner shows Pinned");
  await b.evaluate(`document.querySelector('input[name=autonomy][value=confirm_plan]').click()`);
  await setValue("#b-usd", "3");
  await clickText("button", "Save budget");
  await b.waitFor("document.body.innerText.includes('Saved: up to $3.00')");
  ok(true, "Budget saves and reads back");

  // ---- Make a wish in confirm mode, then confirm
  await hash("#/new");
  await b.waitFor("document.querySelector('#wish')");
  ok((await text("[data-testid=budget-summary]")).includes("$3.00"), "Make a wish shows the saved budget");
  ok((await text("[data-testid=budget-summary]")).includes("confirm the plan"), "…and the confirm-mode wording");
  await click("[data-testid=start]");
  await b.waitFor("!!document.querySelector('.form-error:not([hidden])')");
  ok(true, "Start with an empty wish shows a friendly message");
  await click(".example");
  await click("[data-testid=start]");
  await b.waitFor("location.hash.startsWith('#/runs/hr-')");
  await b.waitFor("document.querySelector('[data-testid=confirm-plan]')", 60000);
  ok((await text("[data-testid=approval-badge]")).startsWith("Approved by Claude Opus 5.5"), "Confirm mode: badge says Approved by <model>, waiting for you");
  ok(!(await text("[data-testid=approval]")).includes("Auto-approved"), "…and never says Auto-approved");
  ok(await exists("[data-testid=synthetic-label]"), "The run is labelled Synthetic replay");
  ok(await b.evaluate(`document.querySelector('[data-stage-tab=plan]').getAttribute('aria-pressed') === 'true'`), "The Live run follows the running stage: Plan is shown while waiting for you");
  await click("[data-stage-tab=plan]"); // pin Plan, so the badge stays in view after building starts
  await click("[data-testid=confirm-plan]");
  await b.waitFor("document.querySelector('[data-testid=approval-badge]').innerText === 'Confirmed by you'", 20000);
  ok(true, "After Confirm plan the badge says Confirmed by you");
  await b.waitFor("document.querySelector('[data-testid=result-banner]')", 90000);
  ok(await b.evaluate(`document.querySelector('[data-testid=open-product]').href.startsWith('http://127.0.0.1:4321/hr-') && document.querySelector('[data-testid=open-product]').target === '_blank' && document.querySelector('[data-testid=open-product]').rel.includes('noopener')`), "Open the product links to the separate preview origin in a new tab");
  ok(!(await exists("iframe")), "The product is never embedded in the console page");

  // ---- Full autopilot, escalation card, evidence expansion, report, files
  await hash("#/setup"); await hash("#/routing");
  await b.waitFor("document.querySelector('input[name=autonomy]')");
  await b.evaluate(`document.querySelector('input[name=autonomy][value=full]').click()`);
  await sleep(300);
  await b.go(url, "#/runs/" + mock.sampleRunId);
  await b.waitFor("document.querySelector('[data-testid=result-banner]')");
  ok(await exists("[data-testid=panel-test] [data-testid=latest-test]"), "A finished run opens on Test, with the final test");
  await b.waitFor("document.querySelector('[data-testid=latest-test] .ev-row')");
  ok((await text("[data-testid=latest-test]")).includes("Final test"), "…showing the final test and its checks");
  await click("[data-stage-tab=plan]");
  ok((await text("[data-testid=approval-badge]")) === "Auto-approved by Claude Opus 5.5", "Sample run: Auto-approved by Claude Opus 5.5");
  ok((await text("[data-testid=plan-check]")).includes("1 stale"), "Plan fact check shows the stale fact that forced a revision");
  await b.waitFor("document.querySelector('[data-testid=plan-check] .shift')");
  ok((await text("[data-testid=plan-check] .shift")).includes("16 days"), "…with the old → proposed values");
  await click("[data-stage-tab=reflect]");
  ok((await text("[data-testid=fact-check]")).includes("Proposed, unreviewed"), "README fact check is labelled Proposed, unreviewed");
  ok(!/confirmed/i.test(await text("[data-testid=fact-check]")), "…and never says Confirmed");
  ok(await exists("[data-testid=latest-decision]"), "Reflect shows the latest decision");
  await click("[data-stage-tab=build]");
  ok((await text("[data-testid=work-items]")).includes("80% → 100%"), "Work item W2 shows its score history 80% → 100%");
  await click("[data-view-btn=models]");
  ok(await exists("[data-testid=models] .mini-table"), "Models opens the models used in this run");
  await click("[data-view-btn=activity]");
  await b.evaluate(`[...document.querySelectorAll('.tl-details summary')].find(s => s.innerText.includes('W2: 4/5 checks passed')).click()`);
  await b.waitFor("document.querySelector('.tl-details[open] .ev-row.fail')");
  ok((await text(".tl-details[open] .evidence-table")).includes("expected \"Take an umbrella\""), "Expanding a failed test shows the tester's evidence");
  await hash(`#/runs/${mock.sampleRunId}/report`);
  await b.waitFor("document.querySelector('[data-testid=report] table')");
  ok(await b.evaluate(`!document.querySelector('[data-testid=report] script') && document.querySelectorAll('[data-testid=report] h2').length >= 8`), "Report renders as safe Markdown with its sections");
  await hash(`#/runs/${mock.sampleRunId}/files`);
  await b.waitFor("document.querySelector('.file-btn')");
  await b.evaluate(`[...document.querySelectorAll('.file-btn')].find(x => x.textContent.includes('forecast.mjs')).click()`);
  await b.waitFor("document.querySelector('[data-testid=file-view]').innerText.includes('Take an umbrella')");
  ok(true, "File browser opens a product file");

  // ---- Regression: a slow older page load must not overwrite a newer page (reviewer P2, room #379)
  // Setup is slow (its /api/config answer is held for 1.8 s); the user moves on to Runs, which loads from a different URL right away.
  await hash("#/new");
  await b.waitFor("document.querySelector('#wish')");
  mock.setDelay((path) => (path === "/api/config" ? 1800 : 0));
  await b.evaluate("location.hash = '#/setup'");
  await sleep(150);
  await b.evaluate("location.hash = '#/runs'");
  await b.waitFor("document.querySelector('.runs-table')");
  await sleep(2400); // the stale Setup load answers now; before the fix it replaced the Runs page
  ok(await exists(".runs-table") && !(await exists(".provider-list")), "A slow older Setup load does not overwrite the newer Runs page");
  ok((await text("h1")).trim() === "Runs", "…and the page still reads Runs");
  mock.setDelay(null);

  // ---- Regression: leaving a run before its first GET returns must not leave an EventSource open (reviewer P2, room #379)
  const liveId = await b.evaluate(`fetch('/api/runs', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({wish:'regression'})}).then(r => r.json()).then(j => j.runId)`);
  await sleep(600);
  const before = mock.openStreams();
  mock.setDelay((path) => (/^\/api\/runs\/hr-[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/.test(path) ? 1500 : 0)); // slow first GET of the run
  await b.evaluate(`location.hash = '#/runs/${liveId}'`);
  await sleep(200);
  await b.evaluate("location.hash = '#/new'"); // unmount while that GET is still in flight
  await b.waitFor("document.querySelector('#wish')");
  await sleep(2600);
  ok(mock.openStreams() === before, `Leaving the run before its first GET returned opened no stream (${mock.openStreams()} open, ${before} before)`);
  mock.setDelay(null);
  await b.evaluate(`location.hash = '#/runs/${liveId}'`); // and a normal visit still streams
  await b.waitFor("document.querySelector('[data-testid=whos-working]')");
  await sleep(500);
  ok(mock.openStreams() === before + 1, "A normal visit to the live run opens exactly one stream");
  await b.evaluate("location.hash = '#/new'");
  await sleep(500);
  ok(mock.openStreams() === before, "…and leaving the run closes it");

  // ---- Regression: keyboard repeats cannot submit two runs, and a stale response cannot navigate
  await hash("#/new");
  await b.waitFor("document.querySelector('#wish')");
  const staleWish = "single-flight navigation regression";
  await setValue("#wish", staleWish);
  let startRequests = 0;
  mock.setDelay((path, method) => {
    if (path !== "/api/runs" || method !== "POST") return 0;
    startRequests += 1;
    return 900;
  });
  await b.evaluate(`(() => {
    const wish = document.querySelector('#wish');
    for (let i = 0; i < 2; i++) {
      wish.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    }
    location.hash = '#/setup';
  })()`);
  await b.waitFor("document.querySelector('[data-testid=provider-list]')");
  await sleep(1100);
  const matchingRuns = await b.evaluate(`fetch('/api/runs').then(r => r.json()).then(({ runs }) =>
    runs.filter(run => run.wish === ${JSON.stringify(staleWish)}).length)`);
  ok(startRequests === 1 && matchingRuns === 1, `A double Ctrl+Enter starts exactly one run (${startRequests} POSTs, ${matchingRuns} runs)`);
  ok(await b.evaluate("location.hash === '#/setup'") && await exists(".provider-list"), "The delayed successful POST does not pull the user back to the run");
  mock.setDelay(null);

  // ---- A failed current-page start must re-enable the same wish for retry
  await hash("#/new");
  await b.waitFor("document.querySelector('#wish')");
  await setValue("#wish", "start retry regression");
  await b.evaluate(`(() => {
    const originalFetch = window.fetch;
    window.fetch = (path, options) => {
      if (path !== '/api/runs' || options?.method !== 'POST') return originalFetch(path, options);
      window.fetch = originalFetch;
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 'fixture_failure', message: 'Try the start again.' } }), { status: 503 }));
    };
  })()`);
  await click("[data-testid=start]");
  await b.waitFor("document.querySelector('.form-error:not([hidden])')?.textContent === 'Try the start again.'");
  ok(await b.evaluate("!document.querySelector('[data-testid=start]').disabled"), "A failed start displays its error and re-enables the button");
  await click("[data-testid=start]");
  await b.waitFor("location.hash.startsWith('#/runs/hr-')");
  ok(true, "Retrying the unchanged wish opens the new run");

  // ---- Runs list and theme toggle
  await hash("#/runs");
  await b.waitFor("document.querySelectorAll('.runs-table tbody tr').length >= 2");
  ok((await text(".runs-table")).includes("Synthetic"), "Runs history marks synthetic runs");
  await click("#theme-toggle");
  ok(await b.evaluate(`document.documentElement.getAttribute('data-theme') === 'dark'`), "Theme toggle switches light → dark");

  ok(b.errors.length === 0, `No browser console errors${b.errors.length ? `: ${b.errors.slice(0, 3).join(" | ")}` : ""}`);
} catch (e) {
  ok(false, `unexpected error: ${e.message}`);
} finally {
  await b.close();
  await mock.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll UI smoke checks passed");
process.exit(failed ? 1 : 0);
