import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve `rel` inside `root` and refuse anything that escapes it, including
 * via symlinks. Returns the absolute path (which may not exist yet).
 */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string') throw new HttpError(400, 'path must be a string');
  if (rel.includes('\0')) throw new HttpError(400, 'invalid path');
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel.replace(/^\/+/, ''));
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new HttpError(400, 'path escapes site root');
  }
  // Walk up to the nearest existing ancestor and make sure its real path is
  // still under the real root (defeats symlinks pointing outside).
  const realRoot = fs.realpathSync(rootAbs);
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
    throw new HttpError(400, 'path escapes site root');
  }
  return abs;
}

export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}

export async function writeFileAtomic(file, data, mode) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data, mode ? { mode } : undefined);
  await fsp.rename(tmp, file);
}

export async function writeJSON(file, obj, mode) {
  await writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', mode);
}

export function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'post';
}

export function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

export const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.html', '.htm', '.yaml', '.yml', '.toml', '.json', '.txt',
  '.css', '.scss', '.sass', '.js', '.ts', '.svg', '.xml', '.csv', '.org', '.adoc',
  '.rst', '.gitignore', '.env', '.sh', '',
]);

export function isTextFile(p) {
  return TEXT_EXTENSIONS.has(path.extname(p).toLowerCase());
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.map': 'application/json',
};

export function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

export function isoNow() {
  return new Date().toISOString();
}
