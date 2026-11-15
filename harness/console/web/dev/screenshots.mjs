// screenshots.mjs: takes the hand-back screenshots at 1280x720 with headless Edge or Chrome (see cdp.mjs).
// It starts the mock server itself, so the data is the SYNTHETIC fixture and the UI labels it.
//
//   node harness/console/web/dev/screenshots.mjs            all shots
//   node harness/console/web/dev/screenshots.mjs live       only shots whose key contains "live"
//   BROWSER="C:\path\to\msedge.exe" node …                  pick a browser
//
// Output: harness/console/web/screenshots/NN-name.png

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMockServer } from "./mock-server.mjs";
import { launch, sleep } from "./cdp.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "screenshots");
mkdirSync(OUT, { recursive: true });
const filter = process.argv[2] || "";
const wanted = (key) => !filter || key.includes(filter);

const mock = createMockServer({ speed: 10 });
const { url } = await mock.listen(0, 0);
const b = await launch();
const shot = async (name, opts) => { await b.screenshot(join(OUT, `${name}.png`), opts); console.log(`saved screenshots/${name}.png`); };

try {
  if (wanted("setup")) { await b.go(url, "#/setup"); await b.waitFor("document.querySelector('.pcard')"); await shot("01-setup-providers"); }
  if (wanted("add-provider")) {
    await b.go(url, "#/setup/new");
    await b.waitFor("document.querySelector('.preset')");
    await b.evaluate(`[...document.querySelectorAll('.preset')].find(x => x.textContent.startsWith('Anthropic')).click()`);
    await sleep(250);
    await shot("02-add-provider");
    await shot("02b-add-provider-full", { full: true, height: 1500 });
  }
  if (wanted("routing")) { await b.go(url, "#/routing"); await b.waitFor("document.querySelector('.routing-table tbody tr')"); await shot("03-routing-budget", { height: 900 }); }
  if (wanted("wish")) {
    await b.go(url, "#/new");
    await b.waitFor("document.querySelector('#wish')");
    await b.evaluate(`document.querySelector('.example').click()`);
    await sleep(200);
    await shot("04-make-a-wish");
  }
  if (wanted("live")) {
    await b.go(url, "#/new");
    await b.waitFor("document.querySelector('#wish')");
    const runId = await b.evaluate(`fetch('/api/runs', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({wish:'I want a page that tells me if I need an umbrella tomorrow'})}).then(r => r.json()).then(j => j.runId)`);
    await b.evaluate(`location.hash = '#/runs/${runId}'`);
    await b.waitFor("document.querySelector('[data-testid=escalation]')", 120000);
    await sleep(250);
    await shot("05-live-run-mid-run");
    await shot("05b-live-run-mid-run-full", { full: true, height: 1500 });
    await b.waitFor("document.querySelector('[data-testid=result-banner]')", 120000);
    await sleep(800);
    await shot("06-result-delivered");
    await b.evaluate(`location.hash = '#/runs/${runId}/report'`);
    await b.waitFor("document.querySelector('[data-testid=report]')");
    await shot("07-result-report", { full: true, height: 1400 });
    await b.evaluate(`location.hash = '#/runs'`);
    await b.waitFor("document.querySelector('.runs-table tbody tr')");
    await shot("08-runs");
  }
  if (wanted("light")) {
    await b.go(url, "#/runs/" + mock.sampleRunId);
    await b.waitFor("document.querySelector('[data-testid=result-banner]')");
    await b.evaluate(`document.documentElement.setAttribute('data-theme','light')`);
    await shot("09-result-light-theme");
  }
  if (wanted("phone")) {
    await b.setViewport(390, 844, 2, true);
    await b.go(url, "#/runs/" + mock.sampleRunId);
    await b.waitFor("document.querySelector('[data-testid=result-banner]')");
    await shot("10-phone-run");
  }
  if (b.errors.length) console.log("Browser errors:", b.errors);
} finally {
  await b.close();
  await mock.close();
}
