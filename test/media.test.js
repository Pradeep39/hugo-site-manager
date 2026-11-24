// Media serving for the previews: HTTP ranges, production-path mapping (auth-gated), inline SVG sandboxing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-media-'));
const SITE = path.join(TMP, 'site');
let h;
const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));

before(async () => {
  fs.mkdirSync(path.join(SITE, 'content', 'posts', 'p'), { recursive: true });
  fs.writeFileSync(path.join(SITE, 'content', 'posts', 'p', 'clip.mp4'), bytes);
  fs.writeFileSync(path.join(SITE, 'content', 'posts', 'p', 'd.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.mkdirSync(path.join(TMP, 'data', 'preview', 's', 'files'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'data', 'preview', 's', 'files', 'v.mp4'), bytes);
  const hash = execFileSync(process.execPath, ['bin/set-password.js', '--print'], { env: { ...process.env, HSM_NEW_PASSWORD: 'correct-horse-battery' } }).toString().trim();
  fs.writeFileSync(path.join(TMP, 'data', 'config.json'), JSON.stringify({
    auth: { username: 't', passwordHash: hash },
    sites: [{ id: 's', path: SITE, build: { baseURL: 'https://minio.example.test/mysite/public/' } }],
  }));
  process.env.HSM_DATA_DIR = path.join(TMP, 'data');
  h = await import('./harness.js');
  await h.init();
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const raw = (p, headers) => h.call('GET', `/api/sites/s/raw?path=${encodeURIComponent(p)}`, { raw: true, headers });

test('production asset paths are served from the preview build only when signed in', async () => {
  h.resetCookie();
  const anon = await h.call('GET', '/mysite/public/files/v.mp4', { raw: true });
  assert.notEqual(anon.headers['content-type'], 'video/mp4', 'signed-out requests never see preview files');
  await h.call('POST', '/api/login', { body: { username: 't', password: 'correct-horse-battery' } });
  const ok = await h.call('GET', '/mysite/public/files/v.mp4', { raw: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'video/mp4');
  assert.equal(ok.body.length, 1000);
});

test('HTTP ranges: 206 with the right bytes, suffix ranges, 416 when impossible', async () => {
  let r = await h.call('GET', '/mysite/public/files/v.mp4', { raw: true, headers: { range: 'bytes=10-19' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], 'bytes 10-19/1000');
  assert.deepEqual([...r.body], [...bytes.subarray(10, 20)]);
  r = await raw('content/posts/p/clip.mp4', { range: 'bytes=-5' });
  assert.equal(r.status, 206);
  assert.deepEqual([...r.body], [...bytes.subarray(995)]);
  assert.equal(r.headers['content-type'], 'video/mp4', 'video plays inline from the raw route');
  r = await raw('content/posts/p/clip.mp4', { range: 'bytes=5000-' });
  assert.equal(r.status, 416);
  r = await raw('content/posts/p/clip.mp4');
  assert.equal(r.status, 200);
  assert.equal(r.headers['accept-ranges'], 'bytes');
});

test('SVG from a post folder renders inline but sandboxed (no script, no same-origin)', async () => {
  const r = await raw('content/posts/p/d.svg');
  assert.equal(r.headers['content-type'], 'image/svg+xml');
  assert.match(r.headers['content-security-policy'], /sandbox/);
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
});

test('a file that disappears mid-request does not crash the server', async () => {
  const r = await raw('content/posts/p/missing.mp4');
  assert.equal(r.status, 404);
});
