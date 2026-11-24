import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, saveState } from './config.js';
import { hugoBinary, addSassToPath } from './hugo.js';
import { HttpError, isoNow } from './util.js';

export const previewDir = (site) => path.join(DATA_DIR, 'preview', site.id);
export const buildDir = (site) => path.join(DATA_DIR, 'build', site.id);

async function ensureNodeDeps(job, site) {
  const pkg = path.join(site.path, 'package.json');
  if (fs.existsSync(pkg) && !fs.existsSync(path.join(site.path, 'node_modules'))) {
    job.log('node_modules is missing; installing theme dependencies');
    await job.exec('npm', fs.existsSync(path.join(site.path, 'package-lock.json')) ? ['ci'] : ['install'], { cwd: site.path });
  }
}

/**
 * Run `hugo` for a site. mode: preview (drafts, served by this app),
 * production (configured baseURL), or test (production settings into a temp dir).
 */
export async function hugoBuild(job, site, { mode, dest, bin }) {
  const hugo = bin || (await hugoBinary());
  addSassToPath(); // a Dart Sass installed by another process (e.g. an upgrade) is picked up without a restart
  await ensureNodeDeps(job, site);
  const args = ['--destination', dest, '--cleanDestinationDir', '--logLevel', 'warn'];
  if (mode === 'preview') {
    args.push('--buildDrafts', '--buildFuture', '--baseURL', `/preview/${site.id}/`);
  } else {
    if (!site.build.baseURL) throw new HttpError(400, `site ${site.id} has no build.baseURL configured`);
    args.push('--baseURL', site.build.baseURL, '--environment', site.build.environment, ...site.build.args);
  }
  await fsp.mkdir(dest, { recursive: true });
  const t0 = Date.now();
  await job.exec(hugo, args, { cwd: site.path });
  if (!fs.existsSync(path.join(dest, 'index.html'))) throw new Error('build produced no index.html');
  job.log(`hugo build finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

export async function previewBuild(job, site) {
  const dest = previewDir(site);
  await hugoBuild(job, site, { mode: 'preview', dest });
  const pages = await listPages(job, site);
  await fsp.writeFile(path.join(DATA_DIR, 'preview', `${site.id}.pages.json`), JSON.stringify(pages));
  await saveState((st) => {
    st.sites ??= {};
    st.sites[site.id] = { ...(st.sites[site.id] || {}), lastPreview: isoNow() };
  });
  return { url: `/preview/${site.id}/`, pages: pages.length };
}

/** Map content files to the URLs Hugo rendered them at, so the editor can show "this page". */
async function listPages(job, site) {
  const hugo = await hugoBinary();
  const { stdout } = await job.exec(
    hugo, ['list', 'all'],
    { cwd: site.path, quiet: true, allowFail: true, env: { HUGO_BASEURL: `/preview/${site.id}/` } },
  );
  const rows = parseCSV(stdout);
  if (!rows.length) return [];
  const head = rows[0];
  const ip = head.indexOf('path');
  const iu = head.indexOf('permalink');
  const it = head.indexOf('title');
  const id = head.indexOf('draft');
  if (ip < 0 || iu < 0) return [];
  // Theme-provided pages live in the module cache; only the site's own files are useful here.
  return rows.slice(1).filter((r) => r[ip] && !path.isAbsolute(r[ip])).map((r) => ({
    path: r[ip], url: r[iu], title: r[it], draft: r[id] === 'true',
  }));
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export async function previewPages(site) {
  try {
    return JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'preview', `${site.id}.pages.json`), 'utf8'));
  } catch {
    return [];
  }
}

// ---------------------------- post-processing ----------------------------

async function* walkFiles(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else if (e.isFile()) yield p;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Make a Hugo build work when served straight out of an object store (MinIO/S3),
 * which does not resolve "/dir/" to "/dir/index.html". This is the generic form
 * of the sed lines in the old generate-and-publish.sh scripts:
 *   - relativizeHTML: href/src="https://host/prefix/..." -> "/prefix/..." so the
 *     same files work on every hostname that fronts the bucket.
 *   - directoryIndexLinks: any link to a folder that has an index.html gets
 *     "/index.html" appended (checked against the actual build output).
 */
export async function postProcess(job, site, dest) {
  const pp = site.postProcess;
  if (!pp.relativizeHTML && !pp.directoryIndexLinks) return { changedFiles: 0 };
  const base = new URL(site.build.baseURL, 'http://placeholder.invalid');
  const absolute = /^https?:\/\//.test(site.build.baseURL);
  const origin = absolute ? base.origin : '';
  const prefix = base.pathname.replace(/\/+$/, ''); // e.g. /mysite/public
  const absRe = new RegExp(`((?:href|src)=["'])${escapeRe(origin + prefix)}(?=[/"'#?])`, 'g');
  const linkRe = new RegExp(
    `(["'(>\\s])((?:https?://[^/"'\\s<>]+)?)(${escapeRe(prefix)}(?:/[^"'\\s<>#?()]*)?)(?=[#?"'<)\\s])`, 'g',
  );
  const cache = new Map();
  const exists = (rel) => {
    if (!cache.has(rel)) cache.set(rel, fs.existsSync(path.join(dest, rel)));
    return cache.get(rel);
  };
  // Links are URL-encoded (e.g. non-ASCII tag names); files on disk are not.
  const decode = (rel) => {
    try { return decodeURIComponent(rel); } catch { return rel; }
  };
  let changed = 0;
  let links = 0;
  for await (const file of walkFiles(dest)) {
    const ext = path.extname(file);
    if (!['.html', '.xml', '.json'].includes(ext)) continue;
    if ((await fsp.stat(file)).size > 20 * 1024 * 1024) continue;
    const before = await fsp.readFile(file, 'utf8');
    let text = before;
    if (pp.relativizeHTML && absolute && ext === '.html') text = text.replace(absRe, `$1${prefix}`);
    if (pp.directoryIndexLinks) {
      text = text.replace(linkRe, (m, lead, host, p) => {
        if (host && host !== origin) return m; // someone else's site with the same path
        const rel = p.slice(prefix.length).replace(/^\/+|\/+$/g, '');
        const disk = decode(rel);
        if (disk && exists(disk) && !fs.statSync(path.join(dest, disk)).isDirectory()) return m; // already a file
        if (exists(path.join(disk, 'index.html'))) {
          links++;
          return `${lead}${host}${prefix}/${rel ? `${rel}/` : ''}index.html`;
        }
        // uglyURLs builds: "/search" or "/search/" is really "search.html"
        if (rel && exists(`${disk}.html`)) {
          links++;
          return `${lead}${host}${prefix}/${rel}.html`;
        }
        return m; // a path we did not build; leave it alone
      });
    }
    if (text !== before) {
      changed++;
      await fsp.writeFile(file, text);
    }
  }
  job.log(`post-processed ${changed} files (${links} folder links now point at index.html)`);
  return { changedFiles: changed, links };
}

// ---------------------------- deploy ----------------------------

export async function deploy(job, site, dest, { dryRun = false } = {}) {
  const d = site.deploy;
  if (d.type === 'none') {
    job.log('deploy.type is "none": build only, nothing uploaded');
    return { uploaded: false };
  }
  if (d.type === 'mc') {
    if (!d.target) throw new HttpError(400, 'deploy.target is required for mc deploys (e.g. minio/mysite/public)');
    const args = ['--no-color', '--quiet', 'mirror', '--overwrite'];
    if (d.removeExtraneous) args.push('--remove');
    if (dryRun) args.push('--dry-run');
    args.push(`${dest}/`, `${d.target.replace(/\/+$/, '')}/`);
    await job.exec(d.mc || 'mc', args);
    return { uploaded: !dryRun, target: d.target };
  }
  if (d.type === 'command') {
    if (!d.command) throw new HttpError(400, 'deploy.command is required');
    await job.exec('/bin/sh', ['-c', d.command], {
      cwd: site.path,
      env: { HSM_BUILD_DIR: dest, HSM_SITE_DIR: site.path, HSM_SITE_ID: site.id, HSM_DRY_RUN: dryRun ? '1' : '0' },
    });
    return { uploaded: !dryRun };
  }
  throw new HttpError(400, `unknown deploy.type ${d.type}`);
}

export async function publish(job, site, { dryRun = false } = {}) {
  const dest = buildDir(site);
  job.log(`building ${site.name} for ${site.build.baseURL}`);
  await hugoBuild(job, site, { mode: 'production', dest });
  await postProcess(job, site, dest);
  if (site.deploy.syncPublicDir) {
    job.log('copying build into the site public/ folder');
    const pub = path.join(site.path, 'public');
    await fsp.rm(pub, { recursive: true, force: true });
    await fsp.cp(dest, pub, { recursive: true });
  }
  const res = await deploy(job, site, dest, { dryRun });
  if (!dryRun && res.uploaded) {
    await saveState((st) => {
      st.sites ??= {};
      st.sites[site.id] = { ...(st.sites[site.id] || {}), lastDeploy: isoNow() };
    });
  }
  if (site.publicURL) job.log(`live at ${site.publicURL}`);
  return res;
}

/** Production build into a throwaway folder — used to vet Hugo/theme upgrades. */
export async function testBuild(job, site, bin) {
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), `hsm-test-${site.id}-`));
  try {
    await hugoBuild(job, site, { mode: 'test', dest, bin });
    return true;
  } finally {
    await fsp.rm(dest, { recursive: true, force: true });
  }
}

// ---------------------------- theme / module updates ----------------------------

const MOD_FILES = ['go.mod', 'go.sum', 'package.json', 'package-lock.json', 'package.hugo.json'];

export async function moduleGraph(job, site) {
  const { stdout } = await job.exec(await hugoBinary(), ['mod', 'graph'], { cwd: site.path, quiet: true, allowFail: true });
  return stdout.trim().split('\n').filter(Boolean);
}

export async function updateTheme(job, site) {
  const hugo = await hugoBinary();
  const snap = path.join(DATA_DIR, 'snapshots', site.id, new Date().toISOString().replace(/[:.]/g, '-'));
  await fsp.mkdir(snap, { recursive: true });
  for (const f of MOD_FILES) {
    const p = path.join(site.path, f);
    if (fs.existsSync(p)) await fsp.copyFile(p, path.join(snap, f));
  }
  job.log(`saved go.mod/package files to ${snap}`);
  const before = await moduleGraph(job, site);
  try {
    await job.exec(hugo, ['mod', 'get', '-u'], { cwd: site.path });
    await job.exec(hugo, ['mod', 'tidy'], { cwd: site.path });
    if (fs.existsSync(path.join(site.path, 'package.hugo.json'))) {
      await job.exec(hugo, ['mod', 'npm', 'pack'], { cwd: site.path });
      await job.exec('npm', ['install'], { cwd: site.path });
    }
    job.log('test-building with the updated theme');
    await testBuild(job, site);
  } catch (e) {
    job.log(`update failed (${e.message}); restoring previous go.mod/package files`, 'err');
    for (const f of MOD_FILES) {
      const p = path.join(snap, f);
      if (fs.existsSync(p)) await fsp.copyFile(p, path.join(site.path, f));
    }
    if (fs.existsSync(path.join(snap, 'package.json'))) {
      await job.exec('npm', ['install'], { cwd: site.path, allowFail: true });
    }
    throw new Error(`theme update rolled back: ${e.message}`);
  }
  const after = await moduleGraph(job, site);
  job.log('modules before:\n  ' + before.join('\n  '));
  job.log('modules after:\n  ' + after.join('\n  '));
  return { before, after, snapshot: snap };
}
