import { test } from "node:test";
import assert from "node:assert/strict";
import { createNavigator } from "./nav.mjs";
import { connectAfterLoad } from "./session.mjs";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("navigator: a new navigation aborts the previous one and only the newest ticket is current", () => {
  const nav = createNavigator();
  const first = nav.begin();
  assert.equal(first.isCurrent(), true);
  assert.equal(first.signal.aborted, false);
  const second = nav.begin();
  assert.equal(first.isCurrent(), false);
  assert.equal(first.signal.aborted, true, "the old page's pending fetches are cancelled");
  assert.equal(second.isCurrent(), true);
  assert.equal(second.signal.aborted, false);
});

// This is the pattern every mount follows: await the load, then check the ticket before touching the DOM.
async function fakeMount(ticket, output, label, loadMs) {
  const data = await new Promise((resolve) => setTimeout(() => resolve(label), loadMs));
  if (!ticket.isCurrent()) return;
  output.page = data;
}

test("regression: an older slow load (Setup) cannot overwrite a newer page (Make a wish)", async () => {
  const nav = createNavigator();
  const output = { page: null };
  const setup = fakeMount(nav.begin(), output, "setup", 40); // slow: the user navigates away while it is in flight
  await tick(5);
  const wish = fakeMount(nav.begin(), output, "wish", 5);
  await Promise.all([setup, wish]);
  assert.equal(output.page, "wish", "the page stays on the newest navigation");
  // and the other order (newest finishes last) still renders the newest
  const out2 = { page: null };
  const a = fakeMount(nav.begin(), out2, "old", 5);
  const b = fakeMount(nav.begin(), out2, "new", 30);
  await Promise.all([a, b]);
  assert.equal(out2.page, "new");
});

test("regression: a run screen unmounted before its first GET returns never opens the stream", async () => {
  const ac = new AbortController();
  let opened = 0;
  let loadedCalled = 0;
  let sawSignal = null;
  const pending = connectAfterLoad({
    signal: ac.signal,
    load: (signal) => { sawSignal = signal; return new Promise((resolve) => setTimeout(() => resolve({ ok: true, data: {} }), 30)); },
    onLoaded: () => { loadedCalled += 1; },
    openStream: () => { opened += 1; return { close() {} }; },
  });
  await tick(5);
  ac.abort(); // unmount while the GET is in flight
  const { stream } = await pending;
  assert.equal(sawSignal, ac.signal, "the pending GET receives the abort signal");
  assert.equal(stream, null);
  assert.equal(opened, 0, "no EventSource is created after unmount");
  assert.equal(loadedCalled, 0, "the stale result is not rendered either");
});

test("connectAfterLoad: normal order is load → onLoaded → open once; a 404 stops before opening", async () => {
  const ac = new AbortController();
  const order = [];
  const ok = await connectAfterLoad({ signal: ac.signal, load: async () => { order.push("load"); return { ok: true }; }, onLoaded: () => { order.push("loaded"); }, openStream: () => { order.push("open"); return { close() { order.push("close"); } }; } });
  assert.deepEqual(order, ["load", "loaded", "open"]);
  ok.stream.close();
  assert.equal(order.at(-1), "close");
  let opened = 0;
  const missing = await connectAfterLoad({ signal: ac.signal, load: async () => ({ ok: false, status: 404 }), onLoaded: (res) => res.status !== 404, openStream: () => { opened += 1; return { close() {} }; } });
  assert.equal(missing.stream, null);
  assert.equal(opened, 0);
  // aborted inside onLoaded (unmount during render) also stops
  const ac2 = new AbortController();
  const late = await connectAfterLoad({ signal: ac2.signal, load: async () => ({ ok: true }), onLoaded: () => { ac2.abort(); }, openStream: () => { opened += 1; return { close() {} }; } });
  assert.equal(late.stream, null);
  assert.equal(opened, 0);
});
