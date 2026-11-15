export const DEFAULT_POLICY = {
  intake: { baseTier: 2, requires: ['json'], prefer: [], pick: 'cheapest', escalation: 'none' },
  researcher: { baseTier: 2, requires: ['json', 'tools'], prefer: ['long_context'], pick: 'cheapest', escalation: 'none' },
  planner: { baseTier: 3, requires: ['reasoning', 'json'], prefer: [], pick: 'strongest', escalation: 'none' },
  reviewer: { baseTier: 3, requires: ['reasoning', 'json'], prefer: [], pick: 'strongest', escalation: 'none' },
  builder: { baseTier: 1, hardBaseTier: 2, requires: ['coding', 'tools'], prefer: [], pick: 'cheapest', escalation: 'per_attempt' },
  tester: { baseTier: 2, requires: ['json'], prefer: ['reasoning'], pick: 'cheapest', escalation: 'none' },
  reflector: { baseTier: 2, requires: ['reasoning', 'json'], prefer: [], pick: 'cheapest', escalation: 'after_two' },
  reporter: { baseTier: 2, requires: ['json'], prefer: [], pick: 'cheapest', escalation: 'none' },
  vision: { baseTier: 2, requires: ['vision'], prefer: [], pick: 'cheapest', escalation: 'none' },
};

export function baseTier(role, difficulty, policy) {
  if (role === 'builder' && (difficulty === 'medium' || difficulty === 'hard')) {
    return policy.hardBaseTier ?? policy.baseTier;
  }
  return policy.baseTier;
}

export function escalatedTier(tier, attempt, escalation) {
  if (attempt >= 3 && escalation !== 'none') return 3;
  if (attempt === 2 && escalation === 'per_attempt') return Math.min(3, tier + 1);
  return tier;
}

function comparePrice(left, right, pick) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return pick === 'strongest' ? right - left : left - right;
}

function countPreferences(model, preferences) {
  return preferences.filter(capability => model.capabilities.includes(capability)).length;
}

export function orderCandidates(candidates, tier, policy) {
  return [...candidates].sort((left, right) => {
    return Math.abs(left.tier - tier) - Math.abs(right.tier - tier)
      || right.tier - left.tier
      || countPreferences(right, policy.prefer) - countPreferences(left, policy.prefer)
      || comparePrice(left.outputUsdPerMTok, right.outputUsdPerMTok, policy.pick)
      || (left.ref < right.ref ? -1 : Number(left.ref > right.ref));
  });
}
