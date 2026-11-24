import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { readJSON, writeJSON, HttpError } from './util.js';

export const DATA_DIR = path.resolve(
  process.env.HSM_DATA_DIR || path.join(os.homedir(), '.hugo-site-manager'),
);
export const CONFIG_FILE = path.resolve(process.env.HSM_CONFIG || path.join(DATA_DIR, 'config.json'));
export const STATE_FILE = path.join(DATA_DIR, 'state.json');

const SITE_DEFAULTS = {
  editable: ['content', 'data', 'static', 'assets', 'archetypes', 'layouts', 'i18n'],
  rootFiles: ['hugo.yaml', 'hugo.yml', 'hugo.toml', 'config.yaml', 'config.toml', 'README.md', '.gitignore'],
  postsSection: 'posts',
  frontMatterStyle: 'toha', // 'toha' adds menu.sidebar entries; 'plain' does not
  // Math goes through Markdown escaping before KaTeX (no goldmark passthrough): \\\\ is a row break.
  mathMarkdownEscapes: true,
  build: { baseURL: null, environment: 'production', args: [] },
  postProcess: { relativizeHTML: true, directoryIndexLinks: true },
  deploy: { type: 'none' },
  git: { remote: 'origin', branch: 'main' },
};

function normalizeSite(s) {
  if (!s.id || !/^[a-z0-9][a-z0-9-]*$/.test(s.id)) {
    throw new Error(`site id "${s.id}" must be lowercase letters, digits and dashes`);
  }
  if (!s.path) throw new Error(`site ${s.id} has no path`);
  return {
    ...SITE_DEFAULTS,
    ...s,
    name: s.name || s.id,
    path: path.resolve(s.path.replace(/^~(?=$|\/)/, os.homedir())),
    build: { ...SITE_DEFAULTS.build, ...(s.build || {}) },
    postProcess: { ...SITE_DEFAULTS.postProcess, ...(s.postProcess || {}) },
    deploy: { ...SITE_DEFAULTS.deploy, ...(s.deploy || {}) },
    git: { ...SITE_DEFAULTS.git, ...(s.git || {}) },
  };
}

let current = null;

export async function loadConfig() {
  const raw = await readJSON(CONFIG_FILE, null);
  if (!raw) {
    throw new Error(
      `No config at ${CONFIG_FILE}. Copy config.example.json there (or set HSM_CONFIG) and run "npm run set-password".`,
    );
  }
  const cfg = {
    listen: { host: '127.0.0.1', port: 8787, ...(raw.listen || {}) },
    auth: { username: 'admin', passwordHash: null, sessionHours: 24 * 14, ...(raw.auth || {}) },
    secureCookies: raw.secureCookies ?? false,
    // true, false, or a list of CIDRs whose X-Forwarded-* headers are believed
    trustProxy: raw.trustProxy ?? (process.env.HSM_TRUST_PROXY ? (process.env.HSM_TRUST_PROXY === 'true' || process.env.HSM_TRUST_PROXY.split(',')) : false),
    hugo: { binary: null, ...(raw.hugo || {}) },
    sites: (raw.sites || []).map(normalizeSite),
  };
  if (process.env.HSM_HOST) cfg.listen.host = process.env.HSM_HOST;
  if (process.env.HSM_PORT) cfg.listen.port = Number(process.env.HSM_PORT);
  if (process.env.HSM_USERNAME) cfg.auth.username = process.env.HSM_USERNAME;
  if (process.env.HSM_PASSWORD_HASH) cfg.auth.passwordHash = process.env.HSM_PASSWORD_HASH;
  if (process.env.HSM_SECURE_COOKIES) cfg.secureCookies = process.env.HSM_SECURE_COOKIES === 'true';
  if (process.env.HSM_HUGO_BINARY) cfg.hugo.binary = process.env.HSM_HUGO_BINARY;
  const ids = new Set();
  for (const s of cfg.sites) {
    if (ids.has(s.id)) throw new Error(`duplicate site id ${s.id}`);
    ids.add(s.id);
  }
  current = cfg;
  return cfg;
}

export function config() {
  if (!current) throw new Error('config not loaded');
  return current;
}

export function getSite(id) {
  const s = config().sites.find((x) => x.id === id);
  if (!s) throw new HttpError(404, `unknown site ${id}`);
  if (!fs.existsSync(s.path)) throw new HttpError(409, `site directory ${s.path} does not exist`);
  return s;
}

export async function updateRawConfig(mutator) {
  const raw = await readJSON(CONFIG_FILE, {});
  mutator(raw);
  await writeJSON(CONFIG_FILE, raw, 0o600);
  return loadConfig();
}

export async function loadState() {
  return readJSON(STATE_FILE, {});
}

export async function saveState(mutator) {
  const st = await loadState();
  mutator(st);
  await writeJSON(STATE_FILE, st);
  return st;
}
