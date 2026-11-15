// api.mjs: the only module that talks to the console server (contracts/http-api.md).
// Responses are { ok, status, data, error }. Network failures never throw: they come back as
// { ok: false, status: 0, error: { code: "network", message } }. Keys never pass through here
// except the one the user types into the Add/Edit form on its way to PUT/POST.

export async function api(path, { method = "GET", body, signal } = {}) {
  try {
    const res = await fetch(path, {
      method,
      signal,
      // The server requires Content-Type: application/json on every non-GET request, even without a body.
      headers: method !== "GET" ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (res.ok) return { ok: true, status: res.status, data, text };
    const err = data && data.error ? data.error : { code: "http_error", message: `The server answered ${res.status}.` };
    return { ok: false, status: res.status, data, text, error: err };
  } catch (e) {
    if (e && e.name === "AbortError") return { ok: false, status: 0, aborted: true, error: { code: "aborted", message: "Cancelled." } };
    return { ok: false, status: 0, error: { code: "network", message: "Couldn't reach the console server. Is it still running?" } };
  }
}

export const get = (path, opts) => api(path, { ...opts, method: "GET" });
export const post = (path, body = {}, opts) => api(path, { ...opts, method: "POST", body });
export const put = (path, body = {}, opts) => api(path, { ...opts, method: "PUT", body });
export const del = (path, opts) => api(path, { ...opts, method: "DELETE" });

export function artifactPath(runId, name) {
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${String(name).split("/").map(encodeURIComponent).join("/")}`;
}

export function filePath(runId, rel) {
  return `/api/runs/${encodeURIComponent(runId)}/files/${String(rel).split("/").map(encodeURIComponent).join("/")}`;
}

/** The separate preview origin (never embedded in the console page). */
export function previewUrl(runId, previewPath = "") {
  const rel = String(previewPath || "").replace(/^\/+/, "");
  return `http://127.0.0.1:4321/${encodeURIComponent(runId)}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Follows a run's SSE stream with automatic reconnect. EventSource resends Last-Event-ID itself;
 * when the browser gives up (readyState CLOSED) we reopen with ?after=<last seq> after a short backoff.
 * handlers: { onEvent(envelope), onState("live" | "reconnecting" | "ended"), getLastSeq() }.
 * Returns { close() }.
 */
export function followRun(runId, handlers) {
  let es = null;
  let closed = false;
  let retry = 0;
  let timer = null;
  const open = () => {
    if (closed) return;
    const after = handlers.getLastSeq ? handlers.getLastSeq() : 0;
    es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream?after=${after}`);
    es.addEventListener("open", () => { retry = 0; handlers.onState("live"); });
    es.addEventListener("harness", (e) => {
      let env = null;
      try { env = JSON.parse(e.data); } catch { return; }
      handlers.onEvent(env);
    });
    es.addEventListener("end", () => { closed = true; es.close(); handlers.onState("ended"); });
    es.addEventListener("error", () => {
      if (closed) return;
      handlers.onState("reconnecting");
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        retry += 1;
        timer = setTimeout(open, Math.min(8000, 500 * 2 ** Math.min(retry, 4)));
      }
    });
  };
  open();
  return { close() { closed = true; clearTimeout(timer); if (es) es.close(); } };
}
