import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createEventLog } from '../event-log/index.mjs';
import { documentLines } from './checks.mjs';
import { createAnthropicProvider, createLinkupProvider } from './providers.mjs';
import { createGitPublisher } from './publish.mjs';
import { runDirect } from './runner.mjs';

const usage = 'Usage: node packages/shelf-life/cli.mjs [--rooms-dir data/rooms] [--room-id NEW_ID] [--max-claims 4] [--doc-label handbook/page.md] [--open-pr [--repo-dir .]] <public-markdown-file>\n       node packages/shelf-life/cli.mjs [--rooms-dir data/rooms] --synthetic\nLive mode needs ANTHROPIC_API_KEY, SHELFLIFE_ANTHROPIC_MODEL and LINKUP_API_KEY.\n--open-pr pushes a new branch with the validated patch and, when GITHUB_TOKEN is set, opens a pull request. It never merges.';

async function readMarkdown(path) {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 48000) throw new Error('Input must be an ordinary file of at most 48000 bytes.');
    const buffer = Buffer.alloc(48001);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > 48000) throw new Error('Markdown input grew beyond 48000 bytes.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await file.close(); }
}

export const syntheticFixture = {
  doc: 'handbook/acme-example.md',
  markdown: '# Acme example (synthetic)\nAcme Tools requires version 8.0.\nAcme Tools supports 60 projects.\nAcme Tools has a 5 day grace period.\n',
  modelProvider: {
    async extract() {
      return { value: { claims: [
        { line: 2, quote: 'Acme Tools requires version 8.0.', statement: 'The minimum Acme Tools version is 8.0.', oldValue: '8.0', category: 'version' },
        { line: 3, quote: 'Acme Tools supports 60 projects.', statement: 'Acme Tools supports up to 60 projects.', oldValue: '60', category: 'limit' },
        { line: 4, quote: 'Acme Tools has a 5 day grace period.', statement: 'The Acme Tools grace period is 5 days.', oldValue: '5', category: 'policy' },
      ] } };
    },
    async verify({ claim, sources }) {
      const verdicts = { version: ['stale', '9.2'], limit: ['fresh', '60'], policy: ['unsure', null] };
      const [verdict, currentValue] = verdicts[claim.category];
      return { value: { verdict, currentValue, sourceIndexes: sources.map((_, i) => i), rationale: 'Fabricated fixture evidence for software testing.' } };
    },
  },
  async searchProvider({ claim, stage }) {
    if (claim.category === 'version') return { answer: null, sources: stage === 0 ? [
      { name: 'Fictional Acme manual', url: 'https://acme.example/manual', snippet: 'The current minimum version for Acme Tools is 9.2.' },
    ] : [
      { name: 'Fictional review', url: 'https://tools.example/acme', snippet: 'Acme Tools now requires version 9.2 on every supported operating system.' },
    ] };
    if (claim.category === 'limit') return { sources: [
      { name: 'Fictional Acme limit', url: 'https://acme.example/limits', snippet: 'Acme Tools supports up to 60 projects.' },
    ] };
    return { sources: [
      { name: 'Fictional Acme support', url: 'https://acme.example/support', snippet: 'Grace periods depend on account policy.' },
    ] };
  },
};

export async function main(args, env = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, synthetic: { type: 'boolean' },
    'rooms-dir': { type: 'string' }, 'room-id': { type: 'string' }, 'max-claims': { type: 'string' }, 'doc-label': { type: 'string' },
    'open-pr': { type: 'boolean' }, 'repo-dir': { type: 'string' },
  } });
  if (values.help) { console.log(usage); return 0; }
  const synthetic = values.synthetic === true;
  const openPr = values['open-pr'] === true;
  if (synthetic ? positionals.length !== 0 || values['doc-label'] || values['max-claims'] || openPr || values['repo-dir']
    : positionals.length !== 1 || (values['repo-dir'] && !openPr)) {
    console.error(usage);
    return 2;
  }
  let config = syntheticFixture;
  if (!synthetic) {
    const file = positionals[0];
    const doc = values['doc-label'] ?? basename(file);
    const modelProvider = createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.SHELFLIFE_ANTHROPIC_MODEL });
    const searchProvider = createLinkupProvider({ apiKey: env.LINKUP_API_KEY });
    const publisher = openPr ? createGitPublisher({ repoDir: resolve(values['repo-dir'] ?? '.'),
      repo: env.SHELFLIFE_HANDBOOK_REPO || null, token: env.GITHUB_TOKEN || null }) : null;
    config = { doc, markdown: await readMarkdown(file), modelProvider, searchProvider, publisher };
  }
  documentLines(config.doc, config.markdown);
  const maxClaims = Number(values['max-claims'] ?? '4');
  if (!Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > 12) throw new Error('--max-claims must be an integer from 1 to 12.');
  const rootDir = values['rooms-dir'] ?? env.SHELF_LIFE_ROOMS_DIR ?? 'data/rooms';
  const roomId = values['room-id'] ?? ('shelf_' + randomUUID());
  const writer = await createEventLog({ rootDir, roomId });
  try {
    const report = await runDirect({ ...config, writer, synthetic, maxClaims });
    console.log(JSON.stringify({ ...report, logPath: writer.logPath }, null, 2));
    return report.status === 'completed' ? 0 : 1;
  } finally { await writer.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { console.error('Shelf Life could not run: ' + error.message); process.exitCode = 1; }
}
