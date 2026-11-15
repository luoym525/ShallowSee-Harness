import { asWebUrl, callJson, list, object, text } from './shared.mjs';

const schema = object({ highlightItemIds: list(text, 0, 3) });
const SYSTEM = `Choose up to three verified work items to highlight in a report for a non-technical reader.
Input wish states what the user asked for and verifiedItems lists only work items whose frozen checks passed.
Choose the IDs of items that best describe the user's requested outcome, in order of importance.
Use the IDs exactly as provided. Do not claim a check passed or add facts, numbers, cost, prose or citations.
The host will render the report from machine-recorded evidence. You have no tools.
Return only the highlightItemIds JSON object in the supplied schema and stop.`;

const line = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const markdown = value => line(value).replace(/[\\`*_[\]<>~|]/g, '\\$&');
const listOrNone = values => values.length ? values : ['- None recorded.'];

function code(value) {
  const s = String(value);
  const delimiter = '`'.repeat(1 + Math.max(0, ...(s.match(/`+/g) ?? []).map(part => part.length)));
  return delimiter + ' ' + s + ' ' + delimiter;
}

function argvLines(args) {
  if (args.every(arg => /^[a-zA-Z0-9_./=:+-]+$/.test(arg))) return ['Run ' + code(args.join(' ')) + '.'];
  const powershell = args.map(arg => "'" + arg.replaceAll("'", "''") + "'").join(' ');
  const posix = args.map(arg => "'" + arg.replaceAll("'", "'\"'\"'") + "'").join(' ');
  return ['On PowerShell, run ' + code('& ' + powershell) + '.', 'On a POSIX shell, run ' + code(posix) + '.'];
}

function usage(entry) {
  if (entry.kind === 'open_html') return ['Open ' + code('workspace/' + entry.path) + ' in a browser.'];
  const steps = ['Open a terminal in the workspace folder.', ...argvLines(entry.run)];
  if (entry.kind === 'server') steps.push('In a browser, open http://127.0.0.1:' + entry.port + entry.path + ' while the command is running.');
  return steps.map((step, index) => (index + 1) + '. ' + step);
}

function sourceLabel(source) {
  const url = asWebUrl(source?.url);
  return url ? [markdown(source.name || url.hostname), url.href] : null;
}

function audit(label, factCheck) {
  if (!factCheck) return ['- ' + label + ' — not verified (the check did not run).'];
  if (factCheck.status !== 'completed') {
    return ['- ' + label + ' — not verified (' + markdown(factCheck.reason || factCheck.status) + ').'];
  }
  const stale = factCheck.findings.filter(finding => finding.verdict === 'stale');
  const output = ['- ' + label + ' — audit completed. Proposed corrections are unreviewed.'];
  for (const finding of stale) {
    const urls = finding.sources.map(sourceLabel).filter(Boolean).map(([, url]) => url);
    output.push('  - ' + markdown(finding.statement) + ' → ' + markdown(finding.currentValue) + ' (proposed, unreviewed).');
    if (urls.length) output.push('    Sources — ' + urls.join(', '));
    if (finding.checks.some(check => check.check === 'independent_sources' && check.passed)) {
      output.push('    Two different sites contained the value (mechanical check). Editorial independence has not been reviewed.');
    }
  }
  for (const finding of factCheck.findings.filter(value => value.verdict === 'unsure')) {
    output.push('  - ' + markdown(finding.statement) + ' was not verified (insufficient evidence).');
  }
  return output;
}

function verifiedItems(spec, report) {
  if (!report?.acceptanceIntact) return [];
  const results = new Map(report.results.map(check => [check.checkId, check]));
  return spec.workItems.filter(item => item.checkIds.length
    && item.checkIds.every(id => {
      const check = results.get(id);
      return check?.itemId === item.id && check.status === 'pass';
    })).map(({ id, title }) => ({ id, title }));
}

function buildReport(input, highlights) {
  const { wish, brief, spec, finalReport, finalReview, planCheck, factCheck, status, spend, fileList } = input;
  const output = ['# Report', ''];
  const section = (label, contents) => output.push('## ' + label, '', ...contents, '');
  const resultStatus = {
    delivered: 'The product was delivered.',
    partial: 'The run produced a partial result.',
    failed: 'The run did not deliver a working product.',
    cancelled: 'The run was cancelled.',
  };
  section('What you asked for', [markdown(wish)]);
  section('What you got', [[resultStatus[status], markdown(spec.title) + '.', highlights.length
    ? 'Work verified by acceptance checks — ' + highlights.map(item => markdown(item.title)).join(', ') + '.' : ''].filter(Boolean).join(' ')]);
  section('How to use it', status === 'delivered' || status === 'partial' ? usage(spec.entry) : ['No finished product is available to run.']);

  const results = finalReport?.results ?? [];
  const used = results.length ? [
    '| Check | Item | Result | Evidence |', '|---|---|---|---|',
    ...results.map(row => '| ' + [row.checkId, row.itemId, row.status, row.message].map(markdown).join(' | ') + ' |'),
    '', results.filter(row => row.status === 'pass').length + ' of ' + results.length + ' checks passed.',
  ] : ['No checks were run.'];
  section('What was checked', used);
  const gaps = new Set([...(finalReview?.gaps ?? []), ...results.filter(row => row.status !== 'pass')
    .map(row => row.checkId + ' — ' + row.message)]);
  section('Known gaps', listOrNone([...gaps].map(gap => '- ' + markdown(gap))));
  section('Fact check', [...audit('Plan facts', planCheck), ...audit('README', factCheck)]);
  section('Assumptions we made for you', listOrNone([
    ...brief.assumptions.map(item => '- ' + markdown(item.topic) + ' — ' + markdown(item.assumed) + ' (' + markdown(item.why) + ')'),
    ...spec.assumptions.map(assumption => '- ' + markdown(assumption)),
  ]));
  section('Sources', listOrNone(spec.sources.map(sourceLabel).filter(Boolean).map(([name, url]) => '- ' + name + ' — ' + url)));

  const models = { ...input.models };
  if (finalReport?.testerModel) models.tester = finalReport.testerModel;
  if (finalReview?.reviewerModel) models.reviewer = finalReview.reviewerModel;
  const modelNames = Object.entries(models).map(([role, ref]) => markdown(role) + ' — ' + markdown(ref));
  const cost = Number.isFinite(spend?.usd) ? '$' + spend.usd : 'unknown';
  section('How it was built', [
    '- Recorded models — ' + (modelNames.length ? modelNames.join(', ') : 'unknown'),
    '- Build iterations — ' + (input.iterations ?? 'unknown'),
    '- Time — ' + (Number.isFinite(spend?.minutes) ? spend.minutes + ' minutes' : 'unknown'),
    '- Recorded model cost — ' + cost,
    ...(fileList.length ? ['- Files — ' + fileList.slice(0, 40).map(markdown).join(', ')] : []),
  ]);
  return output.join('\n');
}

export const reporter = {
  name: 'reporter',
  async run(input, ctx) {
    const items = verifiedItems(input.spec, input.finalReport);
    const lookup = new Map(items.map(item => [item.id, item]));
    const { highlightItemIds } = items.length ? await callJson(ctx, {
      system: SYSTEM, user: { wish: input.wish, verifiedItems: items }, schema, name: 'report_highlights',
      check: value => value.highlightItemIds.some(id => !lookup.has(id))
        ? ['Choose only IDs from verifiedItems.'] : [],
    }) : { highlightItemIds: [] };
    return buildReport(input, [...new Set(highlightItemIds)].map(id => lookup.get(id)));
  },
};
