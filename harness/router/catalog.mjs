const full = ['reasoning', 'coding', 'vision', 'tools', 'json', 'long_context'];
const coder = ['coding', 'tools', 'json'];

export const DEFAULT_CATALOG = [
  { match: 'claude-fable-5-2', tier: 3, capabilities: full, inputUsdPerMTok: 8, outputUsdPerMTok: 40 },
  { match: 'claude-opus-5-5', tier: 3, capabilities: full, inputUsdPerMTok: 4, outputUsdPerMTok: 20 },
  { match: 'claude-sonnet-5-5', tier: 2, capabilities: full, inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
  { match: 'claude-haiku-5-5', tier: 1, capabilities: [...coder, 'vision'], inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 },
  { match: '^.*(mini|nano|flash|lite|haiku|small).*$', tier: 1, capabilities: coder, inputUsdPerMTok: null, outputUsdPerMTok: null },
  { match: '^.*(opus|fable|pro|sol|large|reasoner).*$', tier: 3, capabilities: ['reasoning', ...coder], inputUsdPerMTok: null, outputUsdPerMTok: null },
  { match: '^.*(vision|vl|tera|terra).*$', tier: 2, capabilities: ['vision', 'tools', 'json'], inputUsdPerMTok: null, outputUsdPerMTok: null },
];

export const UNKNOWN_MODEL = {
  tier: 2, capabilities: ['tools', 'json'], inputUsdPerMTok: null, outputUsdPerMTok: null,
};

export function findCatalogEntry(modelId, catalog) {
  const exact = catalog.find(({ match }) => match === modelId && !match.startsWith('^'));
  return exact ?? catalog.find(({ match }) => match.startsWith('^') && new RegExp(match, 'i').test(modelId));
}
