import { buildAudit, safeUrl } from './model.mjs';

const $ = (id) => document.getElementById(id);
const state = { rooms: [], roomId: '', room: null, events: [], ids: new Set(), cursor: 0, generation: 0, stream: null, controller: null, mode: null, listWarnings: [], warnings: [], connectionWarning: '', renderPending: false };
const count = new Intl.NumberFormat('en-GB');
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/London' });
const date = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
function node(tag, className = '', value = undefined) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.textContent = String(value);
  return element;
}
function add(parent, ...children) { for (const child of children.flat()) if (child) parent.append(child); return parent; }
function label(value, style = 'gray') { return node('span', `badge ${style}`, value); }
function human(value = '') { return String(value).replaceAll('_', ' ').replaceAll('.', ' · '); }
function formatDate(value, short = false) {
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? (short ? clock : date).format(time) : 'Time unavailable';
}
function duration(value) { return typeof value === 'number' && value >= 0 ? value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s` : 'Duration unknown'; }
function externalLink(text, href, className = '') {
  const safe = safeUrl(href);
  if (!safe) return node('strong', className, text);
  const link = node('a', className, text);
  link.href = safe; link.target = '_blank'; link.rel = 'noopener noreferrer';
  return link;
}
function empty(title, description) { return add(node('div', 'empty'), node('span', 'empty-symbol', '∴'), node('strong', '', title), node('p', '', description)); }
function metric(title, value, note, tone = '') { return add(node('div', `metric ${tone}`), node('span', 'metric-label', title), node('strong', 'metric-value', value), node('span', 'metric-note', note)); }
function setConnection(text, warning = false) {
  $('connection').replaceChildren(node('i'), document.createTextNode(text));
  $('connection').classList.toggle('error-state', warning);
}
function setError(message) { $('error').hidden = !message; $('error').textContent = message || ''; }
function scheduleRender() {
  if (state.renderPending) return;
  state.renderPending = true;
  requestAnimationFrame(() => { state.renderPending = false; render(); });
}
function acceptEvent(event) {
  if (!event || event.roomId !== state.roomId || !Number.isInteger(event.seq) || event.seq <= 0) throw new Error('The stream returned an invalid event identity.');
  if (event.seq <= state.cursor || state.ids.has(event.eventId)) return;
  if (event.seq !== state.cursor + 1) throw new Error(`The event log has a gap after ${state.cursor}. Refresh to reload a complete record.`);
  state.cursor = event.seq;
  if (event.eventId) state.ids.add(event.eventId);
  if (event.schemaVersion === 1) state.events.push(event);
  else state.warnings.push(`Event ${event.seq} uses an unsupported schema and is not displayed.`);
}
async function getJson(url, signal) {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' }, cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `Request failed (${response.status}).`);
  if (!data) throw new Error('The service returned an unreadable response.');
  return data;
}
async function loadRooms() {
  const refresh = $('refresh'); refresh.disabled = true;
  try {
    const data = await getJson('/api/rooms');
    if (!Array.isArray(data.rooms)) throw new Error('The service did not return a run list.');
    state.rooms = data.rooms;
    state.listWarnings = Array.isArray(data.warnings) ? data.warnings : [];
    const picker = $('room-picker'); picker.replaceChildren();
    if (!state.rooms.length) {
      add(picker, new Option('No recorded runs yet', ''));
      state.controller?.abort(); state.stream?.close(); state.generation++;
      Object.assign(state, { roomId: '', room: null, events: [], ids: new Set(), cursor: 0, warnings: [], connectionWarning: '' });
      setConnection('No recorded runs'); setError(''); render();
      return;
    }
    for (const room of state.rooms) {
      const prefix = room.synthetic ? 'Sample · ' : '';
      const title = room.title || room.goal || room.roomId;
      add(picker, new Option(prefix + String(title).slice(0, 80), room.roomId));
    }
    const selected = state.rooms.some(room => room.roomId === state.roomId) ? state.roomId : state.rooms[0].roomId;
    picker.value = selected;
    await selectRoom(selected);
  } catch (error) {
    setError(`Unable to load audits. ${error.message}`);
    setConnection('Service unavailable', true);
  } finally { refresh.disabled = false; }
}
async function selectRoom(roomId) {
  state.controller?.abort(); state.stream?.close();
  const generation = ++state.generation;
  const controller = new AbortController();
  Object.assign(state, { roomId, room: state.rooms.find(room => room.roomId === roomId) || null, events: [], ids: new Set(), cursor: 0, controller, stream: null, mode: null, warnings: [], connectionWarning: '' });
  setError(''); setConnection('Loading record'); render();
  try {
    let hasMore = true;
    while (hasMore) {
      const before = state.cursor;
      const data = await getJson(`/api/rooms/${encodeURIComponent(roomId)}/events?after=${before}&limit=1000`, controller.signal);
      if (generation !== state.generation) return;
      if (!Array.isArray(data.events)) throw new Error('The service did not return events.');
      if (data.room) state.room = data.room;
      if (Array.isArray(data.warnings)) state.warnings.push(...data.warnings);
      for (const event of data.events) acceptEvent(event);
      hasMore = data.hasMore === true;
      if (hasMore && state.cursor <= before) throw new Error('The log cursor did not advance.');
    }
    render(); connectStream(generation);
  } catch (error) {
    if (error.name === 'AbortError' || generation !== state.generation) return;
    setError(`Unable to read this audit. ${error.message}`); setConnection('Record unavailable', true);
    scheduleRender();
  }
}
function connectStream(generation) {
  const source = new EventSource(`/api/rooms/${encodeURIComponent(state.roomId)}/stream?after=${state.cursor}`);
  state.stream = source;
  source.onopen = () => {
    if (generation !== state.generation) return;
    state.connectionWarning = ''; setConnection(state.mode === 'replay' ? 'Reading saved record' : 'Connected'); scheduleRender();
  };
  source.addEventListener('stream-info', (message) => {
    if (generation !== state.generation) return;
    try {
      const info = JSON.parse(message.data);
      if (info.roomId !== state.roomId) throw new Error('Wrong room in stream metadata.');
      state.mode = info.mode;
      state.room = { ...state.room, synthetic: state.room?.synthetic || info.synthetic, driver: info.driver || state.room?.driver };
      setConnection(info.mode === 'replay' ? 'Reading saved record' : 'Live feed connected'); scheduleRender();
    } catch (error) { streamFailure(source, error.message); }
  });
  source.addEventListener('room-event', (message) => {
    if (generation !== state.generation) return;
    try { acceptEvent(JSON.parse(message.data)); scheduleRender(); }
    catch (error) { streamFailure(source, error.message); }
  });
  source.addEventListener('stream-end', () => {
    if (generation !== state.generation) return;
    source.close(); state.connectionWarning = '';
    setConnection('Saved record loaded'); scheduleRender();
  });
  source.addEventListener('stream-warning', (message) => {
    if (generation !== state.generation) return;
    try { const info = JSON.parse(message.data); if (Array.isArray(info.warnings)) state.warnings = info.warnings; scheduleRender(); }
    catch { streamFailure(source, 'The stream returned an unreadable warning.'); }
  });
  source.addEventListener('stream-error', (message) => {
    if (generation !== state.generation) return;
    let detail = 'The log stream reported an error.';
    try { const error = JSON.parse(message.data); detail = error.message || error.error || detail; } catch {}
    streamFailure(source, detail);
  });
  source.onerror = () => {
    if (generation !== state.generation || source.readyState === EventSource.CLOSED) return;
    state.connectionWarning = 'Connection interrupted. Showing the last received events while the feed reconnects.';
    setConnection('Reconnecting', true); scheduleRender();
  };
}
function streamFailure(source, detail) {
  source.close(); state.connectionWarning = 'Live updates stopped. The visible record may be incomplete.';
  setError(detail); setConnection('Feed stopped', true); scheduleRender();
}
function render() {
  const audit = buildAudit(state.events), meta = state.room || {};
  const synthetic = audit.room.synthetic || meta.synthetic;
  const driver = audit.room.driver || meta.driver;
  const status = audit.room.status === 'waiting' ? meta.status || 'waiting' : audit.room.status;
  $('goal').textContent = audit.room.goal || meta.goal || 'Select a run to inspect its findings, sources and review history.';
  $('room-id').textContent = state.roomId || 'No run selected';
  $('run-meta').replaceChildren();
  if (state.roomId) add($('run-meta'), node('span', '', `Started ${formatDate(audit.room.createdAt || meta.createdAt)} · London`), node('span', '', `${count.format(audit.metrics.eventCount)} recorded events`), node('span', '', `${audit.members.size} recorded members`));
  $('badges').replaceChildren();
  if (synthetic) add($('badges'), label('Synthetic sample', 'gold'));
  if (state.mode === 'replay') add($('badges'), label('Saved replay', 'gray'));
  if (driver === 'direct') add($('badges'), label('Direct workflow', 'gray'));
  if (driver === 'harness') add($('badges'), label('Harness record', 'gray'));
  if (state.roomId) add($('badges'), label(status === 'completed' ? 'Run closed' : human(status), ['failed', 'cancelled'].includes(status) ? 'orange' : 'teal'));
  const banner = $('provenance-banner'); banner.hidden = !synthetic && driver !== 'direct' && state.mode !== 'replay';
  banner.textContent = synthetic ? 'Synthetic sample — the claims, sources, model names and usage below are example data. No live model or search produced this record.' : driver === 'direct' ? 'Direct workflow record — this run demonstrates the verification workflow; it does not demonstrate multi-agent scheduling.' : 'Saved replay — inspecting recorded events rather than a new execution.';
  const warnings = [...new Set([...state.listWarnings, ...state.warnings, ...audit.warnings, state.connectionWarning].filter(Boolean).map(warning => typeof warning === 'string' ? warning : warning.message || JSON.stringify(warning)))];
  $('warnings').hidden = warnings.length === 0; $('warnings').textContent = warnings.join(' ');
  $('summary').replaceChildren(metric('CLAIMS CHECKED', audit.metrics.claimCount - audit.metrics.counts.pending, `${audit.metrics.claimCount} extracted · ${audit.metrics.counts.pending} awaiting a verdict`), metric('OUTDATED', audit.metrics.counts.stale, 'Final stale verdicts', 'orange'), metric('NEEDS HUMAN REVIEW', audit.metrics.counts.unsure, 'Uncertain facts remain open', 'gold'), metric('TASKS ACCEPTED', `${audit.metrics.acceptedTasks} / ${audit.metrics.totalTasks}`, 'Recorded passing evidence', 'teal'));
  $('timeline-count').textContent = count.format(audit.entries.length); $('finding-count').textContent = count.format(audit.claims.length);
  $('cursor').textContent = `Cursor ${state.cursor}`;
  $('footer-meta').textContent = state.roomId ? `Read-only record · cursor ${state.cursor}${synthetic ? ' · synthetic data' : ''}` : 'Read-only audit viewer';
  renderTimeline(audit); renderFindings(audit); renderReliability(audit);
}
function renderTimeline(audit) {
  const container = $('timeline'); container.replaceChildren();
  if (!audit.entries.length) { add(container, empty('A clear trail starts here', state.roomId ? 'No displayable activity has been recorded for this audit yet.' : 'Choose a saved run, or wait for the workflow to write its first event.')); return; }
  const runs = new Map(audit.runs.map(run => [run.id, run]));
  for (const entry of audit.entries) {
    if (entry.kind === 'run') add(container, runCard(runs.get(entry.runId), audit));
    else if (entry.kind === 'message') {
      const e = entry.event, p = e.payload, author = audit.members.get(p.author)?.displayName || p.author || 'System';
      const card = node('article', 'card message');
      add(card, add(node('div', 'card-heading'), add(node('div', 'identity'), node('span', 'avatar', p.kind === 'user' ? 'U' : '↗'), add(node('div'), node('strong', '', author), node('small', '', p.recipients?.length ? `To ${p.recipients.map(id => audit.members.get(id)?.displayName || id).join(', ')}` : 'Shared with the room'))), node('time', 'card-time', formatDate(e.timestamp, true))), node('p', 'message-body', p.content));
      add(container, card);
    } else if (entry.kind === 'acceptance') {
      const task = audit.tasks.find(task => task.id === entry.taskId);
      const card = node('article', `card ${entry.accepted ? 'acceptance' : ''}`);
      add(card, node('h3', '', entry.accepted ? 'Task accepted · evidence recorded' : 'Task marked done · evidence incomplete'), node('p', 'message-body', task?.title || entry.taskId));
      if (entry.evidence.length) {
        const list = node('ul', 'evidence-list');
        for (const evidence of entry.evidence) add(list, add(node('li'), document.createTextNode(evidence.summary || evidence.kind), node('span', 'evidence-ref', ` · ${evidence.ref || 'No reference'}`)));
        add(card, list);
      }
      add(container, card);
    }
  }
}
function runCard(run, audit) {
  const card = node('article', 'card run');
  if (!run) return card;
  const member = audit.members.get(run.memberId || run.provenance.memberId), role = member?.role || run.provenance.role || 'agent';
  const status = { running: ['Executing', 'gray'], completed: ['Execution ended', 'teal'], failed: ['Execution failed', 'orange'], cancelled: ['Cancelled', 'orange'] }[run.status] || [human(run.status), 'gray'];
  const metadata = [run.provider || run.provenance.provider || member?.provider || 'Provider unknown', run.model || run.provenance.model || member?.model || 'Model unknown', run.provenance.mode || member?.mode].filter(Boolean).join(' · ');
  add(card, add(node('div', 'card-heading'), add(node('div', 'identity'), node('span', `avatar ${role}`, role.slice(0, 1).toUpperCase()), add(node('div'), node('strong', '', member?.displayName || human(role)), node('small', '', metadata))), add(node('div'), label(status[0], status[1]), node('div', 'card-time', formatDate(run.timestamp, true)))));
  for (const channel of ['answer', 'progress', 'summary']) if (run.output[channel]) add(card, add(node('div', 'run-output'), node('span', 'channel-label', channel === 'summary' ? 'Public provider summary' : human(channel)), document.createTextNode(run.output[channel])));
  if (!Object.values(run.output).some(Boolean)) add(card, node('p', 'muted small', run.status === 'running' ? 'Waiting for public output or tool activity…' : 'No public text output was recorded for this execution.'));
  if (run.error) add(card, node('p', 'run-note', `${run.error.code || 'Error'}: ${run.error.message || 'Execution failed.'}`));
  if (run.tools.size) {
    const tools = node('div', 'tool-list');
    for (const tool of run.tools.values()) {
      const detail = node('details', `tool ${['error', 'timeout'].includes(tool.status) ? 'error' : ''}`);
      add(detail, node('summary', '', `${tool.name || 'Tool'} · ${human(tool.status)}`), node('p', '', tool.summary || 'No result summary recorded.'), node('p', '', duration(tool.durationMs)));
      if (tool.args) add(detail, node('pre', 'tool-detail', JSON.stringify(tool.args, null, 2)));
      add(tools, detail);
    }
    add(card, tools);
  }
  for (const review of run.notes) {
    const issues = Array.isArray(review.findings) ? review.findings.map(finding => finding.issue).filter(Boolean).join(' ') : '';
    const reviewStatus = review.passed === true ? 'Review passed' : review.passed === false ? 'Revision requested' : 'Review status unknown';
    add(card, node('p', `run-note ${review.passed === true ? 'good' : ''}`, `${reviewStatus} at ${review.commit || 'unknown commit'}.${issues ? ` ${issues}` : ''}`));
  }
  return card;
}
function renderFindings(audit) {
  const container = $('findings'); container.replaceChildren();
  if (!audit.claims.length) add(container, empty('No claims extracted yet', 'The workflow’s exact quotes, final verdicts and cited sources will appear here.'));
  for (const claim of audit.claims) {
    const verdict = claim.final?.verdict || 'pending', conclusion = claim.final || claim.proposed;
    const status = { stale: ['Outdated', 'orange'], fresh: ['Current', 'teal'], unsure: ['Needs human review', 'gold'], pending: ['Awaiting final verdict', 'gray'] }[verdict] || ['Unrecognized verdict', 'gray'];
    const card = node('article', 'card finding');
    add(card, add(node('div', 'card-heading'), node('span', 'eyebrow', `${human(claim.category || 'fact')} / ${claim.id}`), label(status[0], status[1])), node('h3', '', claim.statement || claim.quote || claim.id), node('p', 'finding-meta', `${claim.doc || 'Document unknown'}${claim.lineStart ? `:${claim.lineStart}${claim.lineEnd !== claim.lineStart ? `–${claim.lineEnd}` : ''}` : ''}`));
    const comparisons = node('div', 'comparison');
    add(comparisons, add(node('div', 'quote'), node('label', '', 'Document says'), document.createTextNode(claim.quote || 'No exact quote recorded.')));
    const after = verdict === 'stale' ? conclusion.correction || 'No supported replacement recorded.' : verdict === 'fresh' ? conclusion.currentValue || claim.quote || 'Recorded as current.' : verdict === 'unsure' ? 'Keep the document unchanged until a person resolves the evidence.' : claim.proposed ? `Proposed ${human(claim.proposed.verdict)} — awaiting a final decision.` : 'Verification is still pending.';
    add(comparisons, add(node('div', `quote ${verdict !== 'unsure' ? 'after' : ''}`), node('label', '', verdict === 'stale' ? 'Proposed replacement' : verdict === 'fresh' ? 'Recorded result' : 'Next step'), document.createTextNode(after)));
    add(card, comparisons);
    const sources = Array.isArray(conclusion?.sources) ? conclusion.sources : [];
    add(card, node('h4', 'source-heading', `${sources.length} cited source${sources.length === 1 ? '' : 's'}${claim.final ? '' : ' · provisional'}`));
    if (sources.length) {
      const list = node('div', 'source-list');
      for (const source of sources) {
        const item = node('div', 'source');
        add(item, externalLink(`${source.name || 'Source'} ↗`, source.url), node('div', 'domain', source.domain || (safeUrl(source.url) ? new URL(source.url).hostname : 'URL unavailable')), node('p', '', source.snippet || 'No snippet recorded.'));
        add(list, item);
      }
      add(card, list);
    } else add(card, node('p', 'muted small', 'No source evidence recorded for this conclusion yet.'));
    if (claim.checks.length || claim.searches.length) {
      const checks = node('details', 'check-list');
      const failures = claim.checks.filter(check => check.passed === false).length;
      add(checks, node('summary', '', `${claim.searches.length} searches · ${claim.checks.length} recorded checks${failures ? ` · ${failures} failed before or during review` : ''}`));
      for (const check of claim.checks) add(checks, add(node('div', 'check-row'), node('span', check.passed === true ? 'pass' : check.passed === false ? 'fail' : 'muted', check.passed === true ? '✓' : check.passed === false ? '!' : '?'), add(node('div'), node('p', '', `${human(check.check)} · attempt ${check.attempt ?? '?'}`), node('p', 'muted', check.detail || 'No detail recorded.'), node('small', '', check.eventId))));
      add(card, checks);
    }
    add(container, card);
  }
  const changes = $('changes'); changes.replaceChildren();
  if (audit.patches.length || audit.prs.length) add(changes, node('h2', 'changes-header', 'Proposed changes & review artifacts'));
  for (const patch of audit.patches) add(changes, add(node('article', 'card section-card'), node('h3', '', patch.doc || 'Document patch'), node('p', 'muted small', `Claims: ${(patch.claimIds || []).join(', ') || 'Not recorded'} · proposed patch`), node('pre', 'diff', patch.diff || 'No diff recorded.')));
  for (const pr of audit.prs) add(changes, add(node('div', 'pr-link'), externalLink(`${pr.repo || 'Repository'} · PR #${pr.number ?? '?'} ↗`, pr.url), node('small', '', `Commit ${pr.commit || 'unknown'}`)));
}
function renderReliability(audit) {
  const target = $('reliability'); target.replaceChildren();
  const m = audit.metrics;
  add(target, add(node('div', 'reliability-grid'), metric('ACCEPTED TASKS', `${m.acceptedTasks} / ${m.totalTasks}`, 'With recorded passing evidence', 'teal'), metric('CHECKS FAILED', m.failedChecks, 'Includes failures later resolved', m.failedChecks ? 'orange' : ''), metric('SEARCH RETRIES', m.retries, 'Observed additional attempts'), metric('REVISIONS REQUESTED', m.requestedRevisions, 'Reviewer’s recorded decisions'), metric('TOOL ERRORS / TIMEOUTS', m.failedTools, 'Recorded tool result failures', m.failedTools ? 'orange' : ''), metric('OPEN UNCERTAINTY', m.counts.unsure, 'Facts still requiring a person', m.counts.unsure ? 'gold' : '')));
  const usage = add(node('article', 'card section-card'), node('h3', '', 'Usage in the execution record'));
  const usageGrid = node('div', 'usage-grid');
  for (const [key, name] of [['inputTokens', 'Input tokens'], ['outputTokens', 'Output tokens'], ['costUsd', 'Cost (USD)']]) {
    const total = m.totals[key];
    const value = total.known ? key === 'costUsd' ? `$${total.value.toFixed(3)}` : count.format(total.value) : 'Unknown';
    add(usageGrid, add(node('div', 'usage-stat'), node('span', '', name), node('strong', '', value), node('small', '', total.missing ? `Known subtotal · ${total.missing} ended execution${total.missing === 1 ? '' : 's'} unknown` : total.known ? 'All ended executions reported this value' : 'No measured usage recorded'), total.estimated ? node('small', '', 'Includes explicitly estimated values') : null));
  }
  add(usage, usageGrid, node('p', '', `${m.completedRuns} ended executions. Active runs are not included in subtotals.${audit.room.synthetic || state.room?.synthetic ? ' This sample contains synthetic usage, not billed usage.' : ''}`));
  add(target, usage);
  const accepted = add(node('article', 'card section-card'), node('h3', '', 'Acceptance is a separate step'), node('p', '', 'An ended execution is not a completed task. These statuses reflect the latest task events and their attached evidence.'));
  if (!audit.tasks.length) add(accepted, node('p', '', 'No task acceptance events have been recorded.'));
  for (const task of audit.tasks) add(accepted, add(node('div', 'task-row'), add(node('div'), node('strong', '', task.title || task.id), node('p', '', task.accepted ? `${task.evidence.length} passing evidence reference${task.evidence.length === 1 ? '' : 's'} · verified by ${task.verifiedBy || 'unknown'}` : (task.acceptance || []).join(' · ') || task.reason || 'Awaiting acceptance evidence.')), label(task.accepted ? 'Accepted' : human(task.status || 'pending'), task.accepted ? 'teal' : ['failed', 'unverified'].includes(task.status) ? 'orange' : 'gray')));
  add(target, accepted, add(node('article', 'card section-card'), node('h3', '', 'How to read this evidence'), node('p', '', 'Source counts and different domains describe the recorded citations. They do not establish that sources are editorially independent or that a claim is true. Inspect the snippets, dates, checks and linked artifacts. No accuracy percentage is inferred from this run.')));
}
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => {
  for (const tab of document.querySelectorAll('[data-tab]')) { const selected = tab === button; tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; $(`panel-${tab.dataset.tab}`).hidden = !selected; }
});
document.querySelector('[role="tablist"]').addEventListener('keydown', event => {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click(); tabs[next].focus();
});
$('room-picker').addEventListener('change', event => selectRoom(event.target.value));
$('refresh').addEventListener('click', loadRooms);
window.addEventListener('pagehide', () => { state.stream?.close(); state.controller?.abort(); });
render(); loadRooms();
