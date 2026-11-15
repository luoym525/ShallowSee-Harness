// nav.mjs: one ticket per navigation, so a slow load from an older page can never overwrite a newer one.
// begin() aborts the previous ticket's signal (cancelling its pending fetches) and marks it stale.
// Mounts check `ticket.isCurrent()` after every await before they touch the DOM. DOM-free and tested.

export function createNavigator() {
  let current = null;
  return {
    begin() {
      if (current) current.abort();
      const ac = new AbortController();
      const ticket = { signal: ac.signal, isCurrent: () => current === ticket, abort: () => ac.abort() };
      current = ticket;
      return ticket;
    },
  };
}
