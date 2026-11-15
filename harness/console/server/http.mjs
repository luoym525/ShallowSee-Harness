const JSON_LIMIT = 256 * 1024;

export class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badInput = (message, code = 'bad_request') => new HttpError(400, code, message);
export const notFound = message => new HttpError(404, 'not_found', message);
export const badMethod = () => new HttpError(405, 'method_not_allowed', 'That method is unavailable for this endpoint.');
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(json);
}

export function sendError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof HttpError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message, ...error.details } });
  } else {
    sendJson(res, 500, { error: { code: 'internal', message: 'The console could not complete the request.' } });
  }
}

export function checkHost(req, port) {
  if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host)) {
    throw new HttpError(403, 'bad_host', 'Use this console through its local address.');
  }
}

export function checkMutation(req) {
  const { origin, 'content-type': contentType } = req.headers;
  if (origin !== undefined && origin !== 'http://' + req.headers.host) {
    throw new HttpError(403, 'forbidden_origin', 'Requests from other origins are not allowed.');
  }
  if (!/^application\/json\s*(?:;|$)/i.test(contentType ?? '')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
  }
}

export function safeSegment(value) {
  return typeof value === 'string' && value.length > 0
    && value !== '.' && value !== '..' && value.toLowerCase() !== '.git' && !/[. ]$/.test(value)
    && !/[\\/:<>|?*"\x00-\x1f\x7f]/.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value);
}

export function parseTarget(target) {
  if (!target?.startsWith('/') || target.startsWith('//')) throw badInput('Invalid request path.', 'bad_path');
  const question = target.indexOf('?');
  const pathname = question < 0 ? target : target.slice(0, question);
  const trailingSlash = pathname.endsWith('/');
  const raw = pathname.slice(1, trailingSlash && pathname !== '/' ? -1 : undefined);
  let parts;
  try {
    parts = raw ? raw.split('/').map(part => decodeURIComponent(part)) : [];
  } catch {
    throw badInput('Invalid path encoding.', 'bad_path');
  }
  if (parts.some(part => !safeSegment(part))) throw badInput('Invalid request path.', 'bad_path');
  const query = new URLSearchParams(question < 0 ? '' : target.slice(question + 1));
  return { parts, query, trailingSlash };
}

export async function readJson(req) {
  if (Number(req.headers['content-length']) > JSON_LIMIT) {
    req.resume();
    throw new HttpError(413, 'body_too_large', 'JSON must be at most 256 KB.');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > JSON_LIMIT) {
        chunks.length = 0;
        reject(new HttpError(413, 'body_too_large', 'JSON must be at most 256 KB.'));
      } else {
        chunks.push(chunk);
      }
    });
    req.once('error', () => reject(badInput('The request body was interrupted.')));
    req.once('end', () => {
      if (size > JSON_LIMIT) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const value = text.trim() ? JSON.parse(text) : {};
        if (!isRecord(value)) throw badInput('Expected a JSON object.');
        resolve(value);
      } catch {
        reject(badInput('Expected a valid JSON object.'));
      }
    });
  });
}

export function integerCursor(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n)) throw badInput('The event cursor must be a non-negative integer.');
  return n;
}

export function redactFields(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(entry => redactFields(entry, redact));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key), redactFields(entry, redact)]));
  }
  return value;
}
