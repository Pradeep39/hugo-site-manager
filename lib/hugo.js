import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR, config, loadState, saveState } from './config.js';
import { HttpError } from './util.js';

const execFileP = promisify(execFile);
const HUGO_DIR = path.join(DATA_DIR, 'hugo');
const GH = 'https://api.github.com/repos/gohugoio/hugo';

function ghHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'hugo-site-manager' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

/** Absolute path (or PATH name) of the Hugo binary in use. */
export async function hugoBinary() {
  const cfg = config();
  if (cfg.hugo.binary) return cfg.hugo.binary;
  const st = await loadState();
  if (st.activeHugo && st.activeHugo !== 'system') {
    const p = path.join(HUGO_DIR, st.activeHugo, 'hugo');
    if (fs.existsSync(p)) return p;
  }
  return 'hugo';
}

export async function versionOf(bin) {
  try {
    const { stdout } = await execFileP(bin, ['version'], { timeout: 20000 });
    const m = stdout.match(/v(\d+\.\d+\.\d+)(\S*)/);
    return { ok: true, version: m ? m[1] : null, flavor: m ? m[2] : '', raw: stdout.trim() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function installedVersions() {
  let entries = [];
  try {
    entries = await fsp.readdir(HUGO_DIR);
  } catch {}
  const out = [];
  for (const v of entries) {
    if (fs.existsSync(path.join(HUGO_DIR, v, 'hugo'))) out.push(v);
  }
  return out.sort(cmpVersion).reverse();
}

export function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

let releaseCache = { at: 0, data: null };
export async function releases({ refresh = false } = {}) {
  if (!refresh && releaseCache.data && Date.now() - releaseCache.at < 3600e3) return releaseCache.data;
  const r = await fetch(`${GH}/releases?per_page=15`, { headers: ghHeaders() }).catch((e) => {
    throw new HttpError(502, `cannot reach GitHub: ${e.cause?.message || e.message}`);
  });
  if (!r.ok) throw new HttpError(502, `GitHub API returned ${r.status}`);
  const list = (await r.json())
    .filter((x) => !x.draft && !x.prerelease)
    .map((x) => ({
      version: x.tag_name.replace(/^v/, ''),
      publishedAt: x.published_at,
      url: x.html_url,
      notes: (x.body || '').slice(0, 4000),
      assets: x.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
    }));
  releaseCache = { at: Date.now(), data: list };
  return list;
}

/** Pick the best download for this OS/arch, preferring extended+deploy builds and tarballs. */
export function pickAsset(release, platform = process.platform, arch = process.arch) {
  const v = release.version;
  const plats =
    platform === 'darwin'
      ? ['darwin-universal', `darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}`]
      : platform === 'linux'
        ? [`linux-${arch === 'arm64' ? 'arm64' : arch === 'arm' ? 'arm' : 'amd64'}`]
        : [];
  if (!plats.length) throw new HttpError(400, `unsupported platform ${platform}/${arch}`);
  const flavors = ['hugo_extended_withdeploy', 'hugo_extended', 'hugo_withdeploy', 'hugo'];
  const exts = ['tar.gz', 'pkg'];
  for (const flavor of flavors) {
    for (const plat of plats) {
      for (const ext of exts) {
        const name = `${flavor}_${v}_${plat}.${ext}`;
        const a = release.assets.find((x) => x.name === name);
        if (a) return a;
      }
    }
  }
  throw new HttpError(404, `no Hugo ${v} download for ${platform}/${arch}`);
}

async function download(url, dest, job) {
  job.log(`downloading ${url}`);
  const r = await fetch(url, { headers: { 'User-Agent': 'hugo-site-manager' }, redirect: 'follow' }).catch((e) => {
    throw new Error(`download failed: ${e.cause?.message || e.message}`);
  });
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fsp.writeFile(dest, buf);
  job.log(`downloaded ${(buf.length / 1e6).toFixed(1)} MB`);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Download, checksum-verify and unpack a Hugo release into DATA_DIR/hugo/<version>/hugo. */
export async function installHugo(job, version) {
  const rel = (await releases()).find((r) => r.version === version);
  if (!rel) throw new HttpError(404, `Hugo ${version} is not in the recent release list`);
  const asset = pickAsset(rel);
  const sums = rel.assets.find((a) => a.name === `hugo_${version}_checksums.txt`);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hsm-hugo-'));
  try {
    const file = path.join(tmp, asset.name);
    const digest = await download(asset.url, file, job);
    if (sums) {
      const r = await fetch(sums.url, { headers: { 'User-Agent': 'hugo-site-manager' } });
      const text = await r.text();
      const line = text.split('\n').find((l) => l.trim().endsWith(asset.name));
      if (!line) throw new Error(`${asset.name} missing from checksums file`);
      if (line.split(/\s+/)[0] !== digest) throw new Error(`checksum mismatch for ${asset.name}`);
      job.log('sha256 checksum verified');
    } else {
      job.log('warning: no checksums file published; skipping verification', 'err');
    }
    const target = path.join(HUGO_DIR, version);
    await fsp.mkdir(target, { recursive: true });
    if (asset.name.endsWith('.tar.gz')) {
      await job.exec('tar', ['-xzf', file, '-C', target, 'hugo']);
    } else if (asset.name.endsWith('.pkg')) {
      const x = path.join(tmp, 'expanded');
      await job.exec('pkgutil', ['--expand-full', file, x]);
      const found = await findFile(x, 'hugo');
      if (!found) throw new Error('hugo binary not found inside the .pkg');
      await fsp.copyFile(found, path.join(target, 'hugo'));
    }
    await fsp.chmod(path.join(target, 'hugo'), 0o755);
    const v = await versionOf(path.join(target, 'hugo'));
    if (!v.ok) throw new Error(`installed binary does not run: ${v.error}`);
    job.log(v.raw);
    return { version, binary: path.join(target, 'hugo'), raw: v.raw };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function findFile(dir, name) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const f = await findFile(p, name);
      if (f) return f;
    }
  }
  return null;
}

export async function activate(version) {
  if (version !== 'system' && !fs.existsSync(path.join(HUGO_DIR, version, 'hugo'))) {
    throw new HttpError(404, `Hugo ${version} is not installed`);
  }
  await saveState((st) => {
    if (st.activeHugo !== version) st.previousHugo = st.activeHugo || 'system';
    st.activeHugo = version;
  });
}

export async function removeVersion(version) {
  const st = await loadState();
  if (st.activeHugo === version) throw new HttpError(409, 'cannot remove the active Hugo version');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new HttpError(400, 'bad version');
  await fsp.rm(path.join(HUGO_DIR, version), { recursive: true, force: true });
}

export async function hugoStatus() {
  const st = await loadState();
  const bin = await hugoBinary();
  const systemV = await versionOf('hugo');
  return {
    active: st.activeHugo || 'system',
    previous: st.previousHugo || null,
    pinnedByConfig: !!config().hugo.binary,
    binary: bin,
    current: await versionOf(bin),
    system: systemV,
    installed: await installedVersions(),
    sass: await sassVersion(),
  };
}

// ---------------------------- Dart Sass ----------------------------
// Hugo releases from ~0.16x no longer bundle LibSass ("+extended" disappears from `hugo version`),
// so themes that compile SCSS (Toha does) need the external Dart Sass `sass` binary on PATH.
const SASS_DIR = path.join(DATA_DIR, 'dart-sass');

/** Put the newest app-managed Dart Sass on PATH (no-op if none). Safe to call often. */
export function addSassToPath() {
  let versions = [];
  try {
    versions = fs.readdirSync(SASS_DIR).filter((v) => fs.existsSync(path.join(SASS_DIR, v, 'dart-sass', 'sass')));
  } catch {
    return null;
  }
  if (!versions.length) return null;
  const bin = path.join(SASS_DIR, versions.sort(cmpVersion).at(-1), 'dart-sass');
  const parts = (process.env.PATH || '').split(path.delimiter);
  if (!parts.includes(bin)) process.env.PATH = [bin, ...parts].join(path.delimiter);
  return bin;
}

export async function sassVersion() {
  addSassToPath();
  try {
    const { stdout } = await execFileP('sass', ['--version'], { timeout: 20000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export function needsDartSass(hugoVersionRaw) {
  return !/\+extended/.test(hugoVersionRaw || '');
}

/** Install the latest Dart Sass into DATA_DIR/dart-sass/<version>/ unless `sass` already works. */
export async function ensureDartSass(job) {
  const have = await sassVersion();
  if (have) {
    job.log(`Dart Sass ${have} found`);
    return have;
  }
  const r = await fetch('https://api.github.com/repos/sass/dart-sass/releases/latest', { headers: ghHeaders() }).catch((e) => {
    throw new Error(`cannot reach GitHub for Dart Sass: ${e.cause?.message || e.message}`);
  });
  if (!r.ok) throw new Error(`GitHub API returned ${r.status} for Dart Sass`);
  const rel = await r.json();
  const v = rel.tag_name.replace(/^v/, '');
  const os_ = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null;
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!os_ || !arch) throw new Error(`no Dart Sass build for ${process.platform}/${process.arch}`);
  const name = `dart-sass-${v}-${os_}-${arch}.tar.gz`;
  const asset = rel.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`Dart Sass ${v} has no ${name}`);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hsm-sass-'));
  try {
    const file = path.join(tmp, name);
    await download(asset.browser_download_url, file, job);
    const target = path.join(SASS_DIR, v);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.mkdir(target, { recursive: true });
    await job.exec('tar', ['-xzf', file, '-C', target]);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  const now = await sassVersion();
  if (!now) throw new Error('Dart Sass installed but `sass --version` does not run');
  job.log(`Dart Sass ${now} installed`);
  return now;
}

addSassToPath();
