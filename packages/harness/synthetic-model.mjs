const action = (type, content = '', name = '', args = {}) => ({ value: { type, content, name, argumentsJson: JSON.stringify(args) } });
// Scripted fixture: all content and research are synthetic, while tests actually run.
export function syntheticModel(role, stage) {
  let step = 0;
  return async () => {
    const i = step++;
    if (stage === 'research') return i === 0 ? action('tool', '', 'search', { query: 'Node.js test runner documentation' }) : action('final', JSON.stringify({ assessment: 'current_supported', summary: 'Synthetic fixture evidence only.', proposedChanges: [], sourceURLs: ['https://example.org/synthetic-node-docs'] }));
    if (role === 'presales') return action('final', 'Build a small cart total calculator with input validation.');
    if (stage === 'plan') return action('final', 'Implement a Node.js cart total function accepting nonnegative prices, with independent node:test coverage and usage instructions.');
    if (role === 'developer') return i === 0 ? action('tool', '', 'write-code', { path: 'cart.mjs', content: "export function total(prices) {\n  if (!Array.isArray(prices) || prices.some(p => !Number.isFinite(p) || p < 0)) throw new TypeError('Invalid prices');\n  return prices.reduce((sum, p) => sum + p, 0);\n}\n" }) : action('final', 'Implemented cart total.');
    if (role === 'tester') {
      if (i === 0) return action('tool', '', 'write-test', { path: 'tests/cart.test.mjs', content: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../cart.mjs';\ntest('sums cart and handles empty cart', () => { assert.equal(total([2, 3]), 5); assert.equal(total([]), 0); });\ntest('rejects invalid prices', () => { assert.throws(() => total([-1])); assert.throws(() => total([NaN])); });\n" });
      if (i === 1) return action('tool', '', 'run-tests');
      return action('final', 'Executed independent cart tests.');
    }
    return action('final', 'Import total from cart.mjs and call total([2, 3]). Run tests with node --test tests/cart.test.mjs.');
  };
}
