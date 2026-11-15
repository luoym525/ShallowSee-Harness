// session.mjs: the order of "load the run, then follow its stream" for the Live run screen.
// If the screen is unmounted (signal aborted) before the first GET returns, the stream is never opened,
// so no EventSource can be left running on a page nobody is looking at. DOM-free and tested.

/**
 * load(signal) → result of the first GET; onLoaded(result) may return false to stop (e.g. a 404);
 * openStream() → { close() }. Returns { stream, res }; stream is null when nothing was opened.
 */
export async function connectAfterLoad({ load, onLoaded, openStream, signal }) {
  const res = await load(signal);
  if (signal.aborted) return { stream: null, res };
  if (onLoaded && onLoaded(res) === false) return { stream: null, res };
  if (signal.aborted) return { stream: null, res };
  return { stream: openStream(), res };
}
