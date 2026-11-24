// End-to-end API test against a throwaway copy of a real site.
// Usage: HSM_TEST_SITE=~/pradeepr.cloud npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SRC = (process.env.HSM_TEST_SITE || path.join(os.homedir(), 'pradeepr.cloud')).replace(/^~/, os.homedir());
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-e2e-'));
const SITE = path.join(TMP, 'site');
const REMOTE = path.join(TMP, 'remote.git');
const DEPLOYED = path.join(TMP, 'deployed');
let h;

before(async () => {
  // Copy the site minus heavy/generated folders; share node_modules via symlink.
  await fsp.cp(SRC, SITE, {
    recursive: true,
    filter: (p) => !/\/(node_modules|public|public copy|resources|\.git)(\/|$)/.test(p.slice(SRC.length)),
  });
  if (fs.existsSync(path.join(SRC, 'node_modules'))) fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(SITE, 'node_modules'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', REMOTE]);
  const hash = execFileSync(process.execPath, ['bin/set-password.js', '--print'], {
    env: { ...process.env, HSM_NEW_PASSWORD: 'correct-horse-battery' },
  }).toString().trim();
  const cfg = {
    auth: { username: 'tester', passwordHash: hash },
    sites: [{
      id: 'test-site', name: 'Test', path: SITE,
      build: { baseURL: 'https://minio.example.test/mysite/public/' },
      deploy: { type: 'command', command: 'rm -rf "$DEST" && cp -R "$HSM_BUILD_DIR" "$DEST"' },
      git: { remote: 'origin', branch: 'main', author: { name: 'HSM Test', email: 'hsm@example.test' } },
    }],
  };
  cfg.sites[0].deploy.command = cfg.sites[0].deploy.command.replaceAll('$DEST', DEPLOYED);
  fs.mkdirSync(path.join(TMP, 'data'));
  fs.writeFileSync(path.join(TMP, 'data', 'config.json'), JSON.stringify(cfg));
  process.env.HSM_DATA_DIR = path.join(TMP, 'data');
  h = await import('./harness.js');
  await h.init();
});

after(() => {
  if (!process.env.HSM_KEEP) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log('kept', TMP);
});

test('auth and CSRF guards', async () => {
  assert.equal((await h.call('GET', '/api/sites')).status, 401);
  assert.equal((await h.call('POST', '/api/login', { headers: { 'x-hsm': '' }, body: {} })).status, 403);
  assert.equal((await h.call('POST', '/api/login', { body: { username: 'tester', password: 'wrong' } })).status, 401);
  const ok = await h.call('POST', '/api/login', { body: { username: 'tester', password: 'correct-horse-battery' } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['set-cookie'], /HttpOnly; SameSite=Strict/);
  assert.equal((await h.call('GET', '/api/sites')).status, 200);
});

test('path traversal and write scope are enforced', async () => {
  for (const p of ['../../etc/passwd', '/etc/passwd', 'content/../../x']) {
    const r = await h.call('GET', `/api/sites/test-site/file?path=${encodeURIComponent(p)}`);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  fs.symlinkSync('/etc', path.join(SITE, 'content', 'evil'));
  assert.equal((await h.call('GET', '/api/sites/test-site/file?path=content/evil/hosts')).status, 400);
  fs.unlinkSync(path.join(SITE, 'content', 'evil'));
  const w = await h.call('PUT', '/api/sites/test-site/file', { body: { path: 'generate-and-publish.sh', content: 'rm -rf /' } });
  assert.equal(w.status, 403);
  const g = await h.call('PUT', '/api/sites/test-site/file', { body: { path: 'content/.git/config', content: 'x' } });
  assert.equal(g.status, 400);
});

test('create section + post, edit with conflict detection', async () => {
  const secs = (await h.call('GET', '/api/sites/test-site/sections')).body;
  const la = secs.find((s) => s.path === 'Math Foundations for AI/Linear Algebra');
  assert.equal(la.identifier, 'linalg');

  const sec = await h.call('POST', '/api/sites/test-site/sections', { body: { title: 'Probability', section: 'Math Foundations for AI' } });
  assert.equal(sec.status, 200, JSON.stringify(sec.body));
  const secText = fs.readFileSync(path.join(SITE, sec.body.path), 'utf8');
  assert.match(secText, /parent: math-ai-foundations/);

  const post = await h.call('POST', '/api/sites/test-site/posts', {
    body: { title: 'E2E: Eigen Things', section: 'Math Foundations for AI/Linear Algebra', tags: ['Math'], draft: true },
  });
  assert.equal(post.status, 200, JSON.stringify(post.body));
  assert.equal(post.body.path, 'content/posts/Math Foundations for AI/Linear Algebra/E2E Eigen Things/index.md');
  const f = (await h.call('GET', `/api/sites/test-site/file?path=${encodeURIComponent(post.body.path)}`)).body;
  assert.match(f.content, /parent: linalg/);
  assert.match(f.content, /weight: 1[5-9]|weight: 2\d/); // after existing siblings
  assert.match(f.content, /draft: true/);

  const dup = await h.call('POST', '/api/sites/test-site/posts', { body: { title: 'E2E: Eigen Things', section: 'Math Foundations for AI/Linear Algebra' } });
  assert.equal(dup.status, 409);

  const content = f.content.replace('draft: true', 'draft: false').replace('Start writing here.', 'Eigen body text E2E-MARKER.\n\n![diagram](diagram.png)');
  const saved = await h.call('PUT', '/api/sites/test-site/file', { body: { path: f.path, content, baseHash: f.hash } });
  assert.equal(saved.status, 200);
  const stale = await h.call('PUT', '/api/sites/test-site/file', { body: { path: f.path, content: 'x', baseHash: f.hash } });
  assert.equal(stale.status, 409);

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d30000000049454e44ae426082', 'hex');
  const up = await h.call('POST', `/api/sites/test-site/upload?dir=${encodeURIComponent(path.dirname(f.path))}&name=diagram.png`, { body: png });
  assert.equal(up.body.name, 'diagram.png');
  const up2 = await h.call('POST', `/api/sites/test-site/upload?dir=${encodeURIComponent(path.dirname(f.path))}&name=diagram.png`, { body: png });
  assert.equal(up2.body.name, 'diagram-1.png', 'uploads never overwrite');
  const bad = await h.call('POST', `/api/sites/test-site/upload?dir=content&name=${encodeURIComponent('../../x.sh')}`, { body: 'x' });
  assert.equal(bad.body.name, 'x.sh', 'directory parts are stripped from upload names');
  await h.call('DELETE', '/api/sites/test-site/file?path=content/x.sh');
});

test('preview build serves drafts and maps files to URLs', async () => {
  const job = (await h.call('POST', '/api/sites/test-site/preview')).body;
  const done = await h.waitFor(job.id);
  assert.equal(done.status, 'succeeded', done.lines.map((l) => l.m).join('\n'));
  const pages = (await h.call('GET', '/api/sites/test-site/pages')).body;
  const pg = pages.find((p) => p.path.includes('E2E Eigen Things'));
  assert.ok(pg, 'new post is listed');
  assert.ok(pg.url.startsWith('/preview/test-site/'), pg.url);
  const html = await h.call('GET', pg.url, { raw: true });
  assert.equal(html.status, 200);
  assert.match(html.body.toString(), /E2E-MARKER/);
});

test('publish builds, fixes folder links for MinIO, and deploys', async () => {
  const job = (await h.call('POST', '/api/sites/test-site/publish', { body: {} })).body;
  const done = await h.waitFor(job.id);
  assert.equal(done.status, 'succeeded', done.lines.map((l) => l.m).join('\n'));
  const index = fs.readFileSync(path.join(DEPLOYED, 'index.html'), 'utf8');
  assert.doesNotMatch(index, /href="https:\/\/minio\.example\.test\/mysite\/public/, 'hrefs are relativized');
  assert.match(index, /href="\/mysite\/public\/posts\/index\.html"/);
  assert.match(index, /href="\/mysite\/public\/index\.html#about"/);
  assert.doesNotMatch(index, /href="\/mysite\/public\/posts"/);
  assert.doesNotMatch(index, /href="\/mysite\/public\/"/);
  const sitemap = fs.readFileSync(path.join(DEPLOYED, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/minio\.example\.test\/mysite\/public\//);
  assert.doesNotMatch(sitemap, /localhost/);
  // Every internal folder link must resolve to a real file in the build.
  const links = [...index.matchAll(/href="\/mysite\/public(\/[^"#?]*)/g)].map((m) => m[1]);
  for (const l of links) assert.ok(fs.existsSync(path.join(DEPLOYED, l)) && fs.statSync(path.join(DEPLOYED, l)).isFile(), `dangling ${l}`);
  // Whole-site sweep: every internal href/src (URL-decoded) must hit a file, incl. non-ASCII tags and search.
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const broken = new Set();
  for (const f of walk(DEPLOYED).filter((x) => x.endsWith('.html'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:href|src)="(?:https:\/\/minio\.example\.test)?\/mysite\/public(\/[^"#?]*)?/g)) {
      const rel = decodeURIComponent((m[1] || '/').replace(/%22$/, ''));
      const target = path.join(DEPLOYED, rel);
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) broken.add(`${rel} (in ${path.relative(DEPLOYED, f)})`);
    }
  }
  // The one known content typo (a stray quote inside a link in the Part 3 post) is excluded above via %22.
  assert.deepEqual([...broken], []);
  console.log('SEARCHFILES', walk(DEPLOYED).filter((x) => /search/.test(x)).map((x) => path.relative(DEPLOYED, x)));
  const st = (await h.call('GET', '/api/sites/test-site')).body;
  assert.ok(st.state.lastDeploy);
});

test('github backup: connect, commit, push', async () => {
  let r = (await h.call('GET', '/api/sites/test-site/git')).body;
  assert.equal(r.isRepo, false);
  let job = (await h.call('POST', '/api/sites/test-site/git/connect', { body: { remoteUrl: REMOTE } })).body;
  let done = await h.waitFor(job.id);
  assert.equal(done.status, 'succeeded', done.lines.map((l) => l.m).join('\n'));
  assert.match(fs.readFileSync(path.join(SITE, '.gitignore'), 'utf8'), /public\//);
  // Files over GitHub's 100 MB limit are caught before pushing (sparse file, no real disk use).
  const big = path.join(SITE, 'static', 'huge.bin');
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, 96 * 1024 * 1024);
  job = (await h.call('POST', '/api/sites/test-site/git/backup', { body: {} })).body;
  done = await h.waitFor(job.id);
  assert.equal(done.status, 'failed', JSON.stringify(done.lines.slice(-4)));
  assert.match(done.error, /huge\.bin.* larger than GitHub's 100 MB limit/);
  // node_modules is a symlink in this fixture, which the site's "node_modules/*" pattern doesn't cover.
  fs.appendFileSync(path.join(SITE, '.gitignore'), '\nstatic/huge.bin\nnode_modules\n');
  for (const f of execFileSync('find', [SITE, '-path', `${SITE}/node_modules`, '-prune', '-o', '-type', 'f', '-size', '+95M', '-print']).toString().split('\n').filter(Boolean)) {
    if (f !== big) fs.appendFileSync(path.join(SITE, '.gitignore'), `${path.relative(SITE, f)}\n`);
  }
  job = (await h.call('POST', '/api/sites/test-site/git/backup', { body: { message: 'e2e backup' } })).body;
  done = await h.waitFor(job.id);
  assert.equal(done.status, 'succeeded', done.lines.map((l) => l.m).join('\n'));
  const log = execFileSync('git', ['--git-dir', REMOTE, 'log', '--oneline', 'main']).toString();
  assert.match(log, /e2e backup/);
  const files = execFileSync('git', ['--git-dir', REMOTE, 'ls-tree', '-r', '--name-only', 'main']).toString();
  assert.match(files, /E2E Eigen Things\/index\.md/);
  assert.doesNotMatch(files, /node_modules/);
  r = (await h.call('GET', '/api/sites/test-site/git')).body;
  assert.equal(r.changes.length, 0);
  assert.equal(r.ahead, 0);
  // second backup with nothing to commit succeeds
  job = (await h.call('POST', '/api/sites/test-site/git/backup', { body: {} })).body;
  assert.equal((await h.waitFor(job.id)).status, 'succeeded');
});

test('one job per site at a time', async () => {
  const a = await h.call('POST', '/api/sites/test-site/preview');
  const b = await h.call('POST', '/api/sites/test-site/preview');
  assert.equal(a.status, 202);
  assert.equal(b.status, 409);
  await h.waitFor(a.body.id);
});

test('delete moves to trash', async () => {
  const p = 'content/posts/Math Foundations for AI/Probability';
  const r = await h.call('DELETE', `/api/sites/test-site/file?path=${encodeURIComponent(p)}`);
  assert.equal(r.status, 200);
  assert.ok(!fs.existsSync(path.join(SITE, p)));
  assert.ok(fs.existsSync(path.join(r.body.trashedTo, '_index.md')));
});
