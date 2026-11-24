import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { HttpError, safeJoin, isTextFile, sha1, writeFileAtomic, slugify } from './util.js';

const SKIP = new Set(['.DS_Store', 'node_modules', '.git', '.hugo_build.lock', 'Thumbs.db']);
const MAX_TEXT = 5 * 1024 * 1024;

function topSegment(rel) {
  return rel.replace(/^\/+/, '').split('/')[0];
}

/** Writes are confined to the site's editable directories and named root files. */
function assertEditable(site, rel) {
  const clean = rel.replace(/^\/+/, '');
  if (!clean) throw new HttpError(400, 'empty path');
  if (clean.split('/').some((seg) => seg === '..' || seg === '.git' || seg === 'node_modules')) {
    throw new HttpError(400, 'path not allowed');
  }
  if (site.rootFiles.includes(clean)) return;
  if (site.editable.includes(topSegment(clean)) && clean.includes('/')) return;
  throw new HttpError(403, `"${clean}" is outside the editable folders (${site.editable.join(', ')})`);
}

async function walk(root, rel, depth) {
  const abs = path.join(root, rel);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({
        name: e.name, path: childRel, type: 'dir',
        children: depth > 0 ? await walk(root, childRel, depth - 1) : [],
      });
    } else if (e.isFile()) {
      const st = await fsp.stat(path.join(abs, e.name));
      out.push({ name: e.name, path: childRel, type: 'file', size: st.size, text: isTextFile(e.name) });
    }
  }
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
}

export async function tree(site) {
  const nodes = [];
  for (const d of site.editable) {
    const abs = path.join(site.path, d);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      nodes.push({ name: d, path: d, type: 'dir', children: await walk(site.path, d, 12) });
    }
  }
  for (const f of site.rootFiles) {
    const abs = path.join(site.path, f);
    if (fs.existsSync(abs)) nodes.push({ name: f, path: f, type: 'file', size: fs.statSync(abs).size, text: true });
  }
  return nodes;
}

export async function readFile(site, rel) {
  const abs = safeJoin(site.path, rel);
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    throw new HttpError(404, `${rel} not found`);
  }
  if (!st.isFile()) throw new HttpError(400, `${rel} is not a file`);
  if (!isTextFile(abs) || st.size > MAX_TEXT) {
    return { path: rel, binary: true, size: st.size, mtime: st.mtimeMs };
  }
  const buf = await fsp.readFile(abs);
  return { path: rel, binary: false, content: buf.toString('utf8'), hash: sha1(buf), size: st.size, mtime: st.mtimeMs };
}

export function rawPath(site, rel) {
  const abs = safeJoin(site.path, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, 'not found');
  return abs;
}

export async function writeFile(site, rel, content, baseHash, { force = false } = {}) {
  assertEditable(site, rel);
  const abs = safeJoin(site.path, rel);
  if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
  if (fs.existsSync(abs) && !force) {
    const cur = sha1(await fsp.readFile(abs));
    if (baseHash !== undefined && baseHash !== null && cur !== baseHash) {
      throw new HttpError(409, 'This file changed on disk since you opened it (another device or editor?). Reload it, or save again to overwrite.');
    }
  }
  const buf = Buffer.from(content, 'utf8');
  await writeFileAtomic(abs, buf);
  return { path: rel, hash: sha1(buf), size: buf.length };
}

function cleanFileName(name) {
  const base = path.basename(String(name || '')).replace(/[\0/\\]/g, '').trim();
  if (!base || base === '.' || base === '..' || base.startsWith('.')) throw new HttpError(400, 'bad file name');
  return base.replace(/\s+/g, '-');
}

export async function upload(site, dirRel, name, buf) {
  const fname = cleanFileName(name);
  const rel = `${dirRel.replace(/\/+$/, '')}/${fname}`;
  assertEditable(site, rel);
  const abs = safeJoin(site.path, rel);
  let final = abs;
  let finalRel = rel;
  // Never clobber an existing file on upload; add a counter instead.
  for (let i = 1; fs.existsSync(final); i++) {
    const ext = path.extname(fname);
    const stem = path.basename(fname, ext);
    finalRel = `${dirRel.replace(/\/+$/, '')}/${stem}-${i}${ext}`;
    final = safeJoin(site.path, finalRel);
  }
  await writeFileAtomic(final, buf);
  return { path: finalRel, name: path.basename(finalRel), size: buf.length };
}

export async function mkdir(site, rel) {
  assertEditable(site, `${rel.replace(/\/+$/, '')}/x`);
  await fsp.mkdir(safeJoin(site.path, rel), { recursive: true });
  return { path: rel };
}

export async function rename(site, from, to) {
  assertEditable(site, from);
  assertEditable(site, to);
  const a = safeJoin(site.path, from);
  const b = safeJoin(site.path, to);
  if (!fs.existsSync(a)) throw new HttpError(404, `${from} not found`);
  if (fs.existsSync(b)) throw new HttpError(409, `${to} already exists`);
  await fsp.mkdir(path.dirname(b), { recursive: true });
  await fsp.rename(a, b);
  return { path: to };
}

/** Deletes move into DATA_DIR/trash so nothing is lost by a mis-click. */
export async function remove(site, rel) {
  assertEditable(site, rel);
  const abs = safeJoin(site.path, rel);
  if (!fs.existsSync(abs)) throw new HttpError(404, `${rel} not found`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(DATA_DIR, 'trash', site.id, stamp, rel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(abs, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.cp(abs, dest, { recursive: true });
    await fsp.rm(abs, { recursive: true, force: true });
  }
  return { trashedTo: dest };
}

// ---------- Front matter helpers (just enough YAML for Hugo menus) ----------

export function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = m[1];
  const get = (key) => {
    const r = fm.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : undefined;
  };
  return {
    title: get('title'),
    identifier: get('identifier'),
    weight: get('weight') !== undefined ? Number(get('weight')) : undefined,
    draft: get('draft') === 'true',
    date: get('date'),
  };
}

const q = (s) => JSON.stringify(String(s));
const list = (arr) => `[${arr.map(q).join(', ')}]`;

function contentRoot(site) {
  return path.join(site.path, 'content');
}

/** Sections = folders under content/<postsSection> that have an _index.md. */
export async function sections(site) {
  const root = path.join(contentRoot(site), site.postsSection);
  const out = [];
  async function visit(dirAbs, rel, depth) {
    const idx = path.join(dirAbs, '_index.md');
    if (fs.existsSync(idx)) {
      const fm = parseFrontMatter(await fsp.readFile(idx, 'utf8'));
      out.push({ path: rel, title: fm.title || rel || site.postsSection, identifier: fm.identifier || null, depth });
    }
    if (depth > 6) return;
    for (const e of await fsp.readdir(dirAbs, { withFileTypes: true })) {
      if (e.isDirectory() && !SKIP.has(e.name) && fs.existsSync(path.join(dirAbs, e.name, '_index.md'))) {
        await visit(path.join(dirAbs, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      }
    }
  }
  if (fs.existsSync(root)) await visit(root, '', 0);
  return out;
}

async function nextWeight(dirAbs) {
  let max = 0;
  for (const e of await fsp.readdir(dirAbs, { withFileTypes: true })) {
    const f = e.isDirectory()
      ? ['index.md', '_index.md'].map((n) => path.join(dirAbs, e.name, n)).find((p) => fs.existsSync(p))
      : e.name.endsWith('.md') && e.name !== '_index.md' ? path.join(dirAbs, e.name) : null;
    if (!f) continue;
    const w = parseFrontMatter(await fsp.readFile(f, 'utf8')).weight;
    if (Number.isFinite(w)) max = Math.max(max, w);
  }
  return max + 1;
}

function folderName(title) {
  const n = String(title).replace(/[\/\\:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) throw new HttpError(400, 'title is required');
  return n.slice(0, 120);
}

async function parentInfo(site, sectionRel) {
  const dirRel = path.posix.join('content', site.postsSection, sectionRel || '');
  const dirAbs = safeJoin(site.path, dirRel);
  if (!fs.existsSync(dirAbs)) throw new HttpError(404, `section ${sectionRel} not found`);
  const idx = path.join(dirAbs, '_index.md');
  const fm = fs.existsSync(idx) ? parseFrontMatter(await fsp.readFile(idx, 'utf8')) : {};
  // The top-level posts/_index.md is not a sidebar menu entry, so it has no parent identifier.
  return { dirRel, dirAbs, parentId: sectionRel ? fm.identifier : null };
}

export async function newPost(site, { title, section = '', description = '', tags = [], categories = [], draft = true }) {
  const { dirRel, dirAbs, parentId } = await parentInfo(site, section);
  const folder = folderName(title);
  const rel = `${dirRel}/${folder}/index.md`;
  if (fs.existsSync(safeJoin(site.path, rel))) throw new HttpError(409, `a post named "${folder}" already exists there`);
  const date = new Date().toISOString().slice(0, 10);
  const lines = ['---', `title: ${q(title)}`, `date: ${date}`, `description: ${q(description || title)}`, `draft: ${!!draft}`];
  if (site.frontMatterStyle === 'toha') {
    lines.push('menu:', '  sidebar:', `    name: ${q(title)}`, `    identifier: ${slugify(title)}`);
    if (parentId) lines.push(`    parent: ${parentId}`);
    lines.push(`    weight: ${await nextWeight(dirAbs)}`);
  }
  lines.push(`tags: ${list(tags)}`, `categories: ${list(categories)}`, '---', '', '## Introduction', '', 'Start writing here.', '');
  await writeFile(site, rel, lines.join('\n'), null);
  return { path: rel };
}

export async function newSection(site, { title, section = '' }) {
  const { dirRel, dirAbs, parentId } = await parentInfo(site, section);
  const folder = folderName(title);
  const rel = `${dirRel}/${folder}/_index.md`;
  if (fs.existsSync(safeJoin(site.path, rel))) throw new HttpError(409, `section "${folder}" already exists`);
  const lines = ['---', `title: ${q(title)}`];
  if (site.frontMatterStyle === 'toha') {
    lines.push('menu:', '  sidebar:', `    name: ${q(title)}`, `    identifier: ${slugify(title)}`);
    if (parentId) lines.push(`    parent: ${parentId}`);
    lines.push(`    weight: ${await nextWeight(dirAbs)}`);
  }
  lines.push('---', '');
  await writeFile(site, rel, lines.join('\n'), null);
  return { path: rel };
}
