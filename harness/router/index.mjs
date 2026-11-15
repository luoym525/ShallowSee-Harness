import { listConfiguredModels } from '../providers/index.mjs';
import { DEFAULT_CATALOG, UNKNOWN_MODEL, findCatalogEntry } from './catalog.mjs';
import { DEFAULT_POLICY, baseTier, escalatedTier, orderCandidates } from './policy.mjs';

export { DEFAULT_CATALOG, DEFAULT_POLICY };

export class RouterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
  }
}

export function buildRoster(config, { catalog = DEFAULT_CATALOG } = {}) {
  return listConfiguredModels(config).map(model => {
    const entry = findCatalogEntry(model.modelId, catalog);
    const defaults = entry ?? UNKNOWN_MODEL;
    return {
      ref: model.ref, providerId: model.providerId, providerKind: model.providerKind,
      vendor: model.vendor, modelId: model.modelId, label: model.label,
      tier: model.tier ?? defaults.tier,
      capabilities: [...(model.capabilities ?? defaults.capabilities)],
      inputUsdPerMTok: model.inputUsdPerMTok === undefined ? defaults.inputUsdPerMTok : model.inputUsdPerMTok,
      outputUsdPerMTok: model.outputUsdPerMTok === undefined ? defaults.outputUsdPerMTok : model.outputUsdPerMTok,
      catalogMatched: Boolean(entry),
    };
  });
}

function invalidChoice(ref, roster, required, avoided) {
  const model = roster.find(entry => entry.ref === ref);
  if (!model) return 'is not configured';
  const missing = required.filter(capability => !model.capabilities.includes(capability));
  if (missing.length) return 'lacks ' + missing.join(', ');
  if (avoided.has(ref)) return 'is excluded for this task';
  return null;
}

export function selectModel(req, roster, {
  policy = DEFAULT_POLICY, overrides = {}, preferVendorDiversity = true,
} = {}) {
  if (!roster.length) throw new RouterError('no_models', 'Add a model provider on the Setup page to get started.');

  const { role, attempt = 1, difficulty, needs = [], avoidModels = [], avoidVendors = [], budgetRemainingUsd } = req;
  const rolePolicy = Object.hasOwn(policy, role) ? policy[role] : null;
  if (!rolePolicy) throw new RouterError('no_match', 'No routing policy exists for this role.');
  const required = [...new Set([...rolePolicy.requires, ...needs])];
  const avoided = new Set(avoidModels);
  const candidates = roster.filter(model =>
    !avoided.has(model.ref) && required.every(capability => model.capabilities.includes(capability)));
  if (!candidates.length) throw new RouterError('no_match', 'No available model meets the requirements for ' + role + '.');

  const pin = overrides[role];
  const pinIssue = pin ? invalidChoice(pin, roster, required, avoided) : null;
  const suggestion = role === 'builder' ? req.suggested : null;
  const suggestionIssue = suggestion ? invalidChoice(suggestion, roster, required, avoided) : null;
  const validSuggestion = suggestion && !suggestionIssue ? candidates.find(model => model.ref === suggestion) : null;
  const initialTier = validSuggestion?.tier ?? baseTier(role, difficulty, rolePolicy);
  const increasedTier = escalatedTier(initialTier, attempt, rolePolicy.escalation);
  const lowBudget = Number.isFinite(budgetRemainingUsd) && budgetRemainingUsd < 0.5
    && !['planner', 'reviewer'].includes(role);
  const targetTier = lowBudget ? Math.min(increasedTier, 2) : increasedTier;
  const pinnedModel = pin && !pinIssue ? candidates.find(model => model.ref === pin) : null;
  const suggestedModel = attempt === 1 ? validSuggestion : null;

  const avoidedVendors = preferVendorDiversity ? new Set(avoidVendors) : new Set();
  const diverseTiers = avoidedVendors.size
    ? new Set(candidates.filter(model => !avoidedVendors.has(model.vendor)).map(model => model.tier))
    : new Set();
  const eligible = candidates.filter(model => !diverseTiers.has(model.tier) || !avoidedVendors.has(model.vendor));
  const ordered = orderCandidates(eligible, targetTier, rolePolicy);
  const chosen = pinnedModel ?? suggestedModel ?? ordered[0];
  const fallbacks = ordered.filter(model => model.ref !== chosen.ref).slice(0, 2).map(model => model.ref);

  if (pinnedModel) {
    return {
      model: chosen.ref, tier: chosen.tier, rule: role + '.pinned', suggested: false,
      reason: 'Pinned by you in Setup: ' + chosen.label + '.', escalated: false, pinned: true, fallbacks,
    };
  }

  const explanations = [];
  if (pinIssue) explanations.push('Pinned model ' + pin + ' ' + pinIssue);
  function decision(rule, reason, { suggested = false, escalated = false } = {}) {
    return {
      model: chosen.ref, tier: chosen.tier, rule, suggested, escalated, pinned: false, fallbacks,
      reason: [...explanations, reason].join('. ') + '.',
    };
  }

  if (suggestedModel) return decision('builder.planner_suggested', 'Chosen by the planner: ' + chosen.label, { suggested: true });
  if (suggestionIssue) explanations.push('Planner suggested ' + suggestion + ', which ' + suggestionIssue);
  if (targetTier < increasedTier) explanations.push('Remaining budget is below $0.50, so the target is tier ' + targetTier);
  if (diverseTiers.has(chosen.tier)) explanations.push('Preferred a different vendor within tier ' + chosen.tier);
  if (chosen.tier !== targetTier) explanations.push('No eligible tier-' + targetTier + ' model available, using tier ' + chosen.tier);

  const escalated = targetTier > initialTier;
  if (escalated) {
    return decision(role + '.escalate.attempt' + attempt,
      'Escalated on attempt ' + attempt + ' from tier ' + initialTier + ' to target tier ' + targetTier + ': ' + chosen.label,
      { escalated });
  }
  const preferred = rolePolicy.prefer.filter(capability => chosen.capabilities.includes(capability));
  const reason = rolePolicy.pick === 'strongest'
    ? 'Selected the strongest available reasoning model: ' + chosen.label
    : preferred.length
      ? 'Selected ' + chosen.label + ' with ' + preferred.map(capability => capability.replace('_', ' ')).join(' and ') + ' support'
      : 'Selected the cheapest eligible model at tier ' + chosen.tier + ': ' + chosen.label;
  return decision(role + '.default', reason);
}

export function describeRouting(roster, options = {}) {
  return Object.keys(DEFAULT_POLICY).map(role => {
    try {
      const { model, tier, reason, pinned } = selectModel({ role }, roster, options);
      return { role, model, tier, reason, pinned };
    } catch (error) {
      if (!(error instanceof RouterError)) throw error;
      return { role, model: null, tier: null, reason: error.message, pinned: false };
    }
  });
}
