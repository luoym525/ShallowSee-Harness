import { authorizeTool } from './index.mjs';

// The host supplies the model adapter and scoped tools. The model never receives
// ambient filesystem or search access from this loop.
export async function runCodingAgent({ model, tools, task, maxSteps = 12 }) {
  if (typeof model !== 'function' || !tools || typeof task !== 'string' || !task.trim()) throw new Error('Model, scoped tools and task are required');
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error('Invalid step limit');
  const history = [{ role: 'user', content: task }];
  const allowed = new Set(['read-file', 'write-code', 'run-tests']);
  for (let step = 0; step < maxSteps; step++) {
    const response = await model(structuredClone(history));
    if (response?.type === 'final' && typeof response.content === 'string' && response.content.trim()) return { status: 'completed', output: response.content, steps: step + 1, history };
    if (response?.type !== 'tool' || !allowed.has(response.name) || typeof tools[response.name] !== 'function'
        || (response.name !== 'read-file' && !authorizeTool('developer', response.name))) throw new Error('Invalid or unauthorized coding tool');
    history.push({ role: 'assistant', content: structuredClone(response) });
    try {
      const result = await tools[response.name](structuredClone(response.arguments ?? {}));
      history.push({ role: 'tool', name: response.name, content: String(result) });
    } catch (error) {
      history.push({ role: 'tool', name: response.name, content: 'Tool failed: ' + String(error.message ?? error) });
    }
  }
  return { status: 'step_limit', output: null, steps: maxSteps, history };
}
