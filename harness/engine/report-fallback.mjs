// REPORT.md written by the engine itself (no model) when the reporter role cannot run:
// the brief was refused, the plan was not approved, the run was cancelled or failed early,
// or the reporter call itself failed. Same section order as artifacts.md "REPORT.md".

const line = s => String(s ?? '').replace(/\s+/g, ' ').trim();

function factCheckSection(label, fc) {
  if (!fc) return [`- ${label}: not verified (the check did not run).`];
  if (fc.status !== 'completed') return [`- ${label}: not verified (${line(fc.reason) || fc.status}).`];
  const stale = (fc.findings ?? []).filter(f => f.verdict === 'stale');
  const out = [`- ${label}: ${fc.findings?.length ?? 0} claim(s) audited, ${stale.length} proposed correction(s) (proposed, unreviewed).`];
  for (const f of stale) {
    out.push(`  - "${line(f.statement)}" may now be ${line(f.currentValue)}. Sources: ${(f.sources ?? []).map(s => s.url).join(', ') || 'none'}. Two different sites contained the value (mechanical check); editorial independence not reviewed.`);
  }
  for (const f of (fc.findings ?? []).filter(x => x.verdict === 'unsure')) out.push(`  - "${line(f.statement)}": not verified (evidence was insufficient).`);
  return out;
}

export function fallbackReport({ wish, brief, spec, status, reason, finalReport, finalReview, planCheck, factCheck, planReview,
  spend, minutes, models, iterations, fileList }) {
  const out = [];
  out.push('# Report', '', `_This report was written by the engine without a model, because ${line(reason) || 'the reporter did not run'}._`, '');
  out.push('## What you asked for', '', line(wish), '');
  out.push('## What you got', '');
  const statusText = { delivered: 'The product was delivered and passed every check.', partial: 'A partial product was built; some checks did not pass.',
    failed: 'No working product was delivered.', cancelled: 'The run was cancelled before it finished.' }[status] ?? `Status: ${status}.`;
  out.push(`${statusText}${spec?.title ? ` Product: ${line(spec.title)}.` : brief?.title ? ` Product idea: ${line(brief.title)}.` : ''} ${reason ? `Reason: ${line(reason)}.` : ''}`.trim(), '');
  out.push('## How to use it', '');
  if (spec?.entry?.kind === 'open_html') out.push(`Open \`workspace/${spec.entry.path}\` in a browser.`);
  else if (spec?.entry?.kind === 'command') out.push(`In the \`workspace\` folder run: \`${(spec.entry.run ?? []).join(' ')}\``);
  else if (spec?.entry?.kind === 'server') out.push(`In the \`workspace\` folder run \`${(spec.entry.run ?? []).join(' ')}\`, then open http://127.0.0.1:${spec.entry.port}${spec.entry.path}`);
  else out.push('Nothing to run yet.');
  out.push('');
  out.push('## What was checked', '');
  if (finalReport?.results?.length) {
    out.push('| Check | Item | Result | Why |', '|---|---|---|---|');
    for (const r of finalReport.results) out.push(`| ${r.checkId} | ${r.itemId} | ${r.status} | ${line(r.message).replace(/\|/g, '/')} |`);
    out.push('', `${finalReport.summary?.passed ?? 0} of ${finalReport.summary?.total ?? 0} checks passed.`);
  } else out.push('No checks were run.');
  out.push('');
  out.push('## Known gaps', '');
  const gaps = [...(finalReview?.gaps ?? []), ...(finalReport?.results ?? []).filter(r => r.status !== 'pass').map(r => `${r.checkId}: ${r.message}`)];
  const blockers = (planReview?.issues ?? []).filter(i => i.severity === 'blocker').map(i => `Plan reviewer blocker: ${i.text}`);
  const all = [...blockers, ...gaps];
  out.push(...(all.length ? all.map(g => `- ${line(g)}`) : ['- None recorded.']), '');
  out.push('## Fact check', '', ...factCheckSection('Plan facts', planCheck), ...factCheckSection('README', factCheck), '');
  out.push('## Assumptions we made for you', '');
  const assumptions = brief?.assumptions ?? [];
  out.push(...(assumptions.length ? assumptions.map(a => `- ${line(a.topic)}: ${line(a.assumed)} (${line(a.why)})`) : ['- None recorded.']), '');
  out.push('## Sources', '');
  const sources = spec?.sources ?? [];
  out.push(...(sources.length ? sources.map(s => `- ${line(s.name)}: ${s.url}`) : ['- None recorded.']), '');
  out.push('## How it was built', '');
  const modelLines = Object.entries(models ?? {}).map(([role, ref]) => `${role}: ${ref}`);
  out.push(`- Models: ${modelLines.length ? modelLines.join('; ') : 'none used'}`);
  out.push(`- Build iterations: ${iterations ?? 0}`);
  out.push(`- Time: ${typeof minutes === 'number' ? minutes.toFixed(1) : 'unknown'} minutes`);
  out.push(`- Cost: ${spend?.usd == null ? 'unknown' : `$${spend.usd.toFixed(4)}`}${spend?.usdSource === 'unknown' && spend?.usd != null ? ' (lower bound; some calls had unknown cost)' : ''}`);
  if (fileList?.length) out.push(`- Files: ${fileList.slice(0, 40).join(', ')}`);
  out.push('');
  return out.join('\n');
}
