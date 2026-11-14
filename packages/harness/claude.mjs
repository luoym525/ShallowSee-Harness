const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const measured = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function createClaudeModel({ apiKey, model, fetchImpl = fetch, timeoutMs = 120000, maxResponseBytes = 1048576, maxTokens = 16000 } = {}) {
  if (!nonempty(apiKey) || !nonempty(model) || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new Error('Invalid Claude model configuration.');
  }

  return async ({ system, input, schema } = {}) => {
    if (typeof system !== 'string' || input === undefined || !schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new Error('Invalid Claude request.');
    }
    let body;
    try {
      const content = JSON.stringify(input);
      if (content === undefined) throw new Error();
      body = JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema } } });
    } catch {
      throw new Error('Invalid Claude request.');
    }
    const controller = new AbortController();
    let timer;
    let activeReader;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        try { if (activeReader) void activeReader.cancel().catch(() => {}); } catch {}
        reject(new Error('Claude request timed out.'));
      }, timeoutMs);
    });
    const request = async () => {
      let response;
      try {
        response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body, signal: controller.signal });
      } catch {
        throw new Error('Claude request failed.');
      }
      if (!response.ok) {
        try { void response.body?.cancel().catch(() => {}); } catch {}
        throw new Error(`Claude returned HTTP ${Number.isInteger(response.status) ? response.status : 'error'}.`);
      }
      if (!response.body || typeof response.body.getReader !== 'function') throw new Error('Claude returned an invalid response.');
      const reader = response.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      const parts = [];
      let bytes = 0;
      try {
        while (true) {
          let chunk;
          try { chunk = await reader.read(); } catch { throw new Error('Claude response failed.'); }
          const { value, done } = chunk;
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxResponseBytes) {
            void reader.cancel().catch(() => {});
            throw new Error('Claude response exceeded the byte limit.');
          }
          parts.push(decoder.decode(value, { stream: true }));
        }
        parts.push(decoder.decode());
      } finally { activeReader = null; reader.releaseLock(); }
      let raw;
      try { raw = JSON.parse(parts.join('')); } catch { throw new Error('Claude returned invalid JSON.'); }
      if (raw?.stop_reason !== 'end_turn') throw new Error('Claude did not finish the structured answer.');
      const blocks = Array.isArray(raw.content) ? raw.content : [];
      if (blocks.some(block => block?.type === 'refusal')) throw new Error('Claude refused the structured answer.');
      const answer = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
      let value;
      try { value = JSON.parse(answer); } catch { throw new Error('Claude returned an invalid structured answer.'); }
      const regular = measured(raw?.usage?.input_tokens);
      const created = measured(raw?.usage?.cache_creation_input_tokens) ?? 0;
      const read = measured(raw?.usage?.cache_read_input_tokens) ?? 0;
      const inputTokens = regular === null ? null : measured(regular + created + read);
      const outputTokens = measured(raw?.usage?.output_tokens);
      return { value, model: nonempty(raw?.model) ? raw.model : null,
        usage: { inputTokens, outputTokens, costUsd: null, source: inputTokens === null && outputTokens === null ? 'unknown' : 'provider' },
        stopReason: raw.stop_reason };
    };
    try { return await Promise.race([request(), deadline]); }
    finally { clearTimeout(timer); }
  };
}


