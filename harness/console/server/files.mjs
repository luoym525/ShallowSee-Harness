import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError, notFound, safeSegment } from './http.mjs';

const TEXT_LIMIT = 500 * 1024;
const types = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

export const mimeType = name => types[extname(name).toLowerCase()] ?? 'application/octet-stream';

const fixedArtifacts = new Set([
  'wish.txt', 'brief.json', 'research.json', 'spec.json', 'plan-review.json',
  'progress.md', 'final-review.json', 'REPORT.md', 'fact-check.json',
]);

export function artifactAllowed(parts) {
  const rel = parts.join('/');
  return fixedArtifacts.has(rel) || /^(?:tests\/(?:\d+|final)\.json|reflections\/\d+\.json|plan-check-v[1-9]\d*\.json|plan-facts-v[1-9]\d*\.md)$/.test(rel);
}

function missing(error) {
  return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code);
}

function within(root, candidate) {
  const los = relative(root, candidate);
  return !isAbsolute(los) && los !== '..' && !los.startsWith('..' + sep);
}

export async function locate(root, parts, kind = 'file') {
  if (parts.some(part => !safeSegment(part))) return null;
  try {
    const base = resolve(root);
    const baseStat = await lstat(base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) return null;
    const physicalBase = await realpath(base);
    let path = base;
    let stat = baseStat;
    for (const [index, part] of parts.entries()) {
      path = join(path, part);
      stat = await lstat(path);
      const directory = index < parts.length - 1 || kind === 'dir';
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) return null;
    }
    const physical = await realpath(path);
    if (!within(physicalBase, physical)) return null;
    return { path, stat };
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function openChecked(file) {
  if (!file) throw notFound('No such file.');
  try {
    const fd = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let keep = false;
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.dev !== file.stat.dev || stat.ino !== file.stat.ino) {
        throw notFound('No such file.');
      }
      keep = true;
      return { fd, size: stat.size };
    } finally {
      if (!keep) await fd.close();
    }
  } catch (error) {
    if (missing(error)) throw notFound('No such file.');
    throw error;
  }
}

export async function readSmallFile(file, { limit = TEXT_LIMIT } = {}) {
  const { fd, size } = await openChecked(file);
  try {
    if (size > limit) throw new HttpError(413, 'file_too_large', 'That file is too large to display.');
    const buffer = Buffer.alloc(Math.min(size + 1, limit + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > size) {
      throw new HttpError(409, 'file_changed', 'That file changed while it was being opened. Try again.');
    }
    const bytes = buffer.subarray(0, offset);
    try {
      if (bytes.includes(0)) throw new Error('binary');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new HttpError(415, 'binary', 'Binary files cannot be displayed here.');
    }
  } finally {
    await fd.close();
  }
}

export async function serveFile(req, res, file, contentType, extra = {}) {
  const { fd, size } = await openChecked(file);
  try {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    });
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    await pipeline(fd.createReadStream({ end: size - 1, autoClose: false }), res);
  } finally {
    await fd.close();
  }
}

export async function runFiles(dataDir, runParts, { artifact = false } = {}) {
  const root = await locate(dataDir, runParts, 'dir');
  if (!root) return [];
  const result = [];
  async function walk(relativeParts) {
    const parent = await locate(dataDir, [...runParts, ...relativeParts], 'dir');
    if (!parent) return;
    const entries = await readdir(parent.path, { withFileTypes: true });
    for (const entry of entries) {
      if (!safeSegment(entry.name) || entry.isSymbolicLink()) continue;
      const parts = [...relativeParts, entry.name];
      if (entry.isDirectory()) {
        if (!artifact || (parts.length === 1 && ['tests', 'reflections'].includes(entry.name))) await walk(parts);
      } else if (entry.isFile() && (!artifact || artifactAllowed(parts))) {
        result.push(parts.join('/'));
      }
    }
  }
  await walk([]);
  return result.sort();
}

export function webAsset(parts) {
  if (parts.length === 1) return ['index.html', 'app.js', 'styles.css', 'model.mjs', 'markdown.mjs'].includes(parts[0]);
  return parts.length === 2 && parts[0] === 'ui' && /^[a-z0-9-]+\.mjs$/i.test(parts[1]);
}
