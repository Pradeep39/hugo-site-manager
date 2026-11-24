// Hugo upgrade pipeline test with a stubbed GitHub (fake releases repackaging the local hugo binary).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-hugo-'));
const SRC = path.join(os.homedir(), 'pradeepr.cloud');
const files = new Map(); // url -> Buffer
let h;

function addAsset(rel, name, buf) {
  const url = `https://fake.test/${rel.version}/${name}`;
  files.set(url, buf);
  rel.assets.push({ name, browser_download_url: url, size: buf.length });
  return crypto.createHash('sha256').update(buf).digest('hex');
}

before(async () => {
  const hugoBin = execFileSync('which', ['hugo']).toString().trim();
  const stage = path.join(TMP, 'stage');
  fs.mkdirSync(path.join(stage, 'root', 'usr', 'local', 'bin'), { recursive: true });
  fs.copyFileSync(fs.realpathSync(hugoBin), path.join(stage, 'hugo'));
  fs.copyFileSync(fs.realpathSync(hugoBin), path.join(stage, 'root', 'usr', 'local', 'bin', 'hugo'));
  execFileSync('tar', ['-czf', path.join(stage, 'h.tgz'), '-C', stage, 'hugo']);
  execFileSync('pkgbuild', ['--quiet', '--root', path.join(stage, 'root'), '--identifier', 'test.hugo', '--version', '1', path.join(stage, 'h.pkg')]);
  const plat = process.platform === 'darwin' ? 'darwin-universal' : `linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;

  const mk = (version) => ({ version, tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-11-17T00:00:00Z', html_url: 'https://fake.test', body: 'notes', assets: [] });
  const tarRel = mk('9.9.8');
  const pkgRel = mk('9.9.9');
  const badRel = mk('9.9.7');
  const sums = (rel, name, digest) => addAsset(rel, `hugo_${rel.version}_checksums.txt`, Buffer.from(`${digest}  ${name}\n`));
  sums(tarRel, `hugo_extended_9.9.8_${plat}.tar.gz`, addAsset(tarRel, `hugo_extended_9.9.8_${plat}.tar.gz`, fs.readFileSync(path.join(stage, 'h.tgz'))));
  if (process.platform === 'darwin') {
    sums(pkgRel, `hugo_withdeploy_9.9.9_${plat}.pkg`, addAsset(pkgRel, `hugo_withdeploy_9.9.9_${plat}.pkg`, fs.readFileSync(path.join(stage, 'h.pkg'))));
  }
  addAsset(badRel, `hugo_extended_9.9.7_${plat}.tar.gz`, fs.readFileSync(path.join(stage, 'h.tgz')));
  sums(badRel, `hugo_extended_9.9.7_${plat}.tar.gz`, '0'.repeat(64));
  const releasesJSON = JSON.stringify([pkgRel, tarRel, badRel]);

  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('api.github.com/repos/gohugoio/hugo/releases')) return new Response(releasesJSON, { status: 200 });
    if (files.has(url)) return new Response(files.get(url), { status: 200 });
    return new Response('nope', { status: 404 });
  };

  const SITE = path.join(TMP, 'site');
  fs.cpSync(SRC, SITE, { recursive: true, filter: (p) => !/\/(node_modules|public|public copy|resources|\.git)(\/|$)/.test(p.slice(SRC.length)) });
  fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(SITE, 'node_modules'));
  const hash = execFileSync(process.execPath, ['bin/set-password.js', '--print'], { env: { ...process.env, HSM_NEW_PASSWORD: 'correct-horse-battery' } }).toString().trim();
  fs.mkdirSync(path.join(TMP, 'data'));
  fs.writeFileSync(path.join(TMP, 'data', 'config.json'), JSON.stringify({
    auth: { username: 't', passwordHash: hash },
    sites: [{ id: 's', path: SITE, build: { baseURL: 'https://x.test/mysite/public/' } }],
  }));
  process.env.HSM_DATA_DIR = path.join(TMP, 'data');
  h = await import('./harness.js');
  await h.init();
  await h.call('POST', '/api/login', { body: { username: 't', password: 'correct-horse-battery' } });
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('releases are listed newest first without asset noise', async () => {
  const r = await h.call('GET', '/api/hugo/releases');
  assert.deepEqual(r.body.map((x) => x.version), ['9.9.9', '9.9.8', '9.9.7']);
  assert.equal(r.body[0].assets, undefined);
});

test('tarball install: verify checksum, test-build, activate', async () => {
  const job = (await h.call('POST', '/api/hugo/upgrade', { body: { version: '9.9.8' } })).body;
  const done = await h.waitFor(job.id);
  const log = done.lines.map((l) => l.m).join('\n');
  assert.equal(done.status, 'succeeded', log);
  assert.match(log, /sha256 checksum verified/);
  assert.match(log, /: OK/);
  const st = (await h.call('GET', '/api/hugo')).body;
  assert.equal(st.active, '9.9.8');
  assert.equal(st.previous, 'system');
  assert.ok(st.binary.endsWith('/hugo/9.9.8/hugo'));
});

test('pkg install (macOS) and rollback', { skip: process.platform !== 'darwin' }, async () => {
  const job = (await h.call('POST', '/api/hugo/upgrade', { body: { version: '9.9.9' } })).body;
  const done = await h.waitFor(job.id);
  assert.equal(done.status, 'succeeded', done.lines.map((l) => l.m).join('\n'));
  let st = (await h.call('GET', '/api/hugo')).body;
  assert.equal(st.active, '9.9.9');
  assert.deepEqual(st.installed, ['9.9.9', '9.9.8']);
  assert.equal((await h.call('DELETE', '/api/hugo/9.9.9')).status, 409, 'cannot delete the active version');
  st = (await h.call('POST', '/api/hugo/activate', { body: { version: 'system' } })).body;
  assert.equal(st.active, 'system');
  assert.equal((await h.call('DELETE', '/api/hugo/9.9.9')).status, 200);
});

test('checksum mismatch aborts and nothing is activated', async () => {
  const before = (await h.call('GET', '/api/hugo')).body.active;
  const job = (await h.call('POST', '/api/hugo/upgrade', { body: { version: '9.9.7' } })).body;
  const done = await h.waitFor(job.id);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /checksum mismatch/);
  assert.equal((await h.call('GET', '/api/hugo')).body.active, before);
});

test('a version whose test build fails is installed but not activated', async () => {
  // Break the site so any Hugo fails to build it.
  const st0 = (await h.call('GET', '/api/hugo')).body;
  const cfgPath = path.join(TMP, 'site', 'hugo.yaml');
  const orig = fs.readFileSync(cfgPath, 'utf8');
  fs.writeFileSync(cfgPath, orig + '\nmodule: [this is: not valid\n');
  try {
    await h.call('DELETE', '/api/hugo/9.9.8').catch(() => {});
    const job = (await h.call('POST', '/api/hugo/upgrade', { body: { version: '9.9.8' } })).body;
    const done = await h.waitFor(job.id);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /NOT activated/);
    assert.equal((await h.call('GET', '/api/hugo')).body.active, st0.active);
  } finally {
    fs.writeFileSync(cfgPath, orig);
  }
});

test('Dart Sass is installed into the data dir when missing and put on PATH', async () => {
  const hugoMod = await import('../lib/hugo.js');
  const { startJob, waitJob } = await import('../lib/jobs.js');
  // Hide any system sass so the download path is exercised.
  const savedPath = process.env.PATH;
  process.env.PATH = savedPath.split(':').filter((d) => !fs.existsSync(path.join(d, 'sass'))).join(':');
  const stage = path.join(TMP, 'sass-stage');
  fs.mkdirSync(path.join(stage, 'dart-sass'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'dart-sass', 'sass'), '#!/bin/sh\necho 9.8.7-test\n', { mode: 0o755 });
  execFileSync('tar', ['-czf', path.join(stage, 's.tgz'), '-C', stage, 'dart-sass']);
  const os_ = process.platform === 'darwin' ? 'macos' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const name = `dart-sass-9.8.7-${os_}-${arch}.tar.gz`;
  files.set(`https://fake.test/sass/${name}`, fs.readFileSync(path.join(stage, 's.tgz')));
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes('repos/sass/dart-sass/releases/latest')
    ? new Response(JSON.stringify({ tag_name: '9.8.7', assets: [{ name, browser_download_url: `https://fake.test/sass/${name}` }] }))
    : prev(url);
  try {
    assert.equal(hugoMod.needsDartSass('hugo v0.170.1-c8b03de linux/arm64'), true);
    assert.equal(hugoMod.needsDartSass('hugo v0.162.1+extended+withdeploy darwin/arm64'), false);
    const job = startJob({ type: 't', title: 'sass', lockSite: false }, (j) => hugoMod.ensureDartSass(j));
    const done = await waitJob(job.id);
    assert.equal(done.status, 'succeeded', done.lines.map((l) => l.m).join('\n'));
    assert.equal(done.result, '9.8.7-test');
    assert.match(process.env.PATH, /dart-sass\/9\.8\.7\/dart-sass/);
    assert.equal((await h.call('GET', '/api/hugo')).body.sass, '9.8.7-test');
    // second call finds it and does not download again
    const again = startJob({ type: 't', title: 'sass2', lockSite: false }, (j) => hugoMod.ensureDartSass(j));
    assert.match((await waitJob(again.id)).lines.map((l) => l.m).join('\n'), /found/);
  } finally {
    globalThis.fetch = prev;
    process.env.PATH = savedPath;
  }
});
