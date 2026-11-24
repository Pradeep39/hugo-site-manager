#!/usr/bin/env node
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream';
import { loadConfig, config, getSite, loadState, CONFIG_FILE, DATA_DIR } from './lib/config.js';
import * as auth from './lib/auth.js';
import * as content from './lib/content.js';
import * as build from './lib/build.js';
import * as git from './lib/git.js';
import * as hugo from './lib/hugo.js';
import { startJob, getJob, listJobs, siteBusy } from './lib/jobs.js';
import { HttpError, mimeFor, safeJoin } from './lib/util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(HERE, 'public');
const MAX_JSON = 6 * 1024 * 1024;
const MAX_UPLOAD = 60 * 1024 * 1024;

// ------------------------------------------------------------------ helpers

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf || typeof body === 'string' ? headers['Content-Type'] || 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, `request body larger than ${Math.round(limit / 1e6)} MB`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function json(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

/**
 * Mark the session cookie Secure when the browser is on HTTPS. Behind the TLS ingress that's
 * X-Forwarded-Proto=https; a plain-HTTP LAN address (e.g. a MetalLB IP) gets a non-Secure
 * cookie, otherwise the browser would drop it and login would silently fail.
 */
function secureRequest(req) {
  if (!config().secureCookies) return false;
  if (!config().trustProxy) return true; // no proxy info configured: honour the setting as-is
  // This server only speaks plain HTTP, so a request that didn't come through a trusted
  // (TLS-terminating) proxy is plain HTTP — a Secure cookie would just be dropped.
  if (!fromTrustedProxy(req)) return !!req.socket.encrypted;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/**
 * trustProxy: true trusts forwarding headers from anyone; a list of CIDRs (e.g. the pod network,
 * where ingress-nginx runs) trusts them only from those peers, so a client reaching the app
 * directly (say via a MetalLB LAN IP) can't spoof X-Forwarded-For to dodge the login throttle.
 */
let trustList = null;
function fromTrustedProxy(req) {
  const tp = config().trustProxy;
  if (!tp) return false;
  if (tp === true) return true;
  if (!trustList) {
    trustList = new net.BlockList();
    for (const cidr of tp) {
      const [addr, bits] = cidr.split('/');
      const type = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
      trustList.addSubnet(addr, Number(bits ?? (type === 'ipv6' ? 128 : 32)), type);
    }
  }
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return net.isIP(ip) ? trustList.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4') : false;
}

function clientIp(req) {
  if (fromTrustedProxy(req) && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

async function serveFile(req, res, abs, { cache = false, csp = true } = {}) {
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    return send(res, 404, 'Not found');
  }
  if (st.isDirectory()) {
    abs = path.join(abs, 'index.html');
    try {
      st = await fsp.stat(abs);
    } catch {
      return send(res, 404, 'Not found');
    }
  }
  const headers = {
    'Content-Type': mimeFor(abs),
    'Cache-Control': cache ? 'public, max-age=300' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (csp) Object.assign(headers, securityHeaders());
  sendRange(req, res, abs, st.size, headers);
}

/** Stream a file, honouring a single "Range: bytes=a-b" (Safari won't play mp4 without 206s). */
function sendRange(req, res, abs, size, headers) {
  headers['Accept-Ranges'] = 'bytes';
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return streamFile(fs.createReadStream(abs, { start, end }), res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  streamFile(fs.createReadStream(abs), res);
}

/** pipeline() destroys the file stream on client abort (video seeks) and swallows ENOENT races
 *  (preview rebuilt mid-request) instead of crashing the server. */
function streamFile(rs, res) {
  pipeline(rs, res, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && !res.headersSent) res.writeHead(500);
    if (err) res.destroy();
  });
}

function securityHeaders() {
  return {
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  };
}

// ------------------------------------------------------------------ routes

const routes = [];
function route(method, pattern, handler, { open = false } = {}) {
  const keys = [];
  const re = new RegExp(
    '^' + pattern.replace(/\/:(\w+)/g, (_, k) => (keys.push(k), '/([^/]+)')) + '$',
  );
  routes.push({ method, re, keys, handler, open });
}

async function siteSummary(s, st) {
  const exists = fs.existsSync(s.path);
  return {
    id: s.id,
    name: s.name,
    path: s.path,
    exists,
    publicURL: s.publicURL || null,
    baseURL: s.build.baseURL,
    deploy: { type: s.deploy.type, target: s.deploy.target || null, removeExtraneous: !!s.deploy.removeExtraneous },
    postsSection: s.postsSection,
    mathMarkdownEscapes: s.mathMarkdownEscapes !== false,
    git: exists ? await git.status(s).catch((e) => ({ error: e.message })) : null,
    state: st.sites?.[s.id] || {},
    busy: siteBusy(s.id),
  };
}

route('POST', '/api/login', async (req, res) => {
  const ip = clientIp(req);
  if (!auth.loginAllowed(ip)) throw new HttpError(429, 'Too many failed logins; try again in 15 minutes.');
  const { username, password } = await json(req);
  const cfg = config();
  if (!cfg.auth.passwordHash) throw new HttpError(503, 'No password set. Run "npm run set-password" on the server.');
  const ok = username === cfg.auth.username && auth.verifyPassword(password, cfg.auth.passwordHash);
  if (!ok) {
    auth.recordLoginFailure(ip);
    throw new HttpError(401, 'Wrong username or password');
  }
  auth.clearLoginFailures(ip);
  const hours = cfg.auth.sessionHours;
  send(res, 200, { username }, {
    'Set-Cookie': auth.sessionCookie(auth.issueSession(username, hours), { secure: secureRequest(req), maxAgeSeconds: hours * 3600 }),
  });
}, { open: true });

route('POST', '/api/logout', async (req, res) => {
  send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie('', { secure: secureRequest(req), maxAgeSeconds: 0 }) });
}, { open: true });

route('GET', '/api/me', async (req, res, p, session) => send(res, 200, { username: session.u }));

route('GET', '/api/sites', async (req, res) => {
  const st = await loadState();
  send(res, 200, await Promise.all(config().sites.map((s) => siteSummary(s, st))));
});

route('GET', '/api/sites/:id', async (req, res, p) => {
  send(res, 200, await siteSummary(getSite(p.id), await loadState()));
});

// --- content
route('GET', '/api/sites/:id/tree', async (req, res, p) => send(res, 200, await content.tree(getSite(p.id))));

route('GET', '/api/sites/:id/file', async (req, res, p, s, url) => {
  send(res, 200, await content.readFile(getSite(p.id), url.searchParams.get('path') || ''));
});

route('PUT', '/api/sites/:id/file', async (req, res, p) => {
  const b = await json(req);
  send(res, 200, await content.writeFile(getSite(p.id), b.path, b.content, b.baseHash, { force: !!b.force }));
});

route('DELETE', '/api/sites/:id/file', async (req, res, p, s, url) => {
  send(res, 200, await content.remove(getSite(p.id), url.searchParams.get('path') || ''));
});

route('POST', '/api/sites/:id/rename', async (req, res, p) => {
  const b = await json(req);
  send(res, 200, await content.rename(getSite(p.id), b.from, b.to));
});

route('POST', '/api/sites/:id/mkdir', async (req, res, p) => {
  send(res, 200, await content.mkdir(getSite(p.id), (await json(req)).path));
});

route('POST', '/api/sites/:id/upload', async (req, res, p, s, url) => {
  const site = getSite(p.id);
  const buf = await readBody(req, MAX_UPLOAD);
  send(res, 200, await content.upload(site, url.searchParams.get('dir') || '', url.searchParams.get('name') || '', buf));
});

route('GET', '/api/sites/:id/raw', async (req, res, p, s, url) => {
  const abs = content.rawPath(getSite(p.id), url.searchParams.get('path') || '');
  // Serve as an attachment unless it is an image, so uploaded HTML/SVG can't run as this origin.
  const type = mimeFor(abs);
  // images and media play in place (live preview); anything else downloads, so uploaded HTML/SVG can't run here
  const inline = /^(image\/(png|jpeg|gif|webp|avif|x-icon|svg\+xml)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav))$/.test(type);
  sendRange(req, res, abs, fs.statSync(abs).size, {
    'Content-Type': inline ? type : 'application/octet-stream',
    'Content-Disposition': inline ? 'inline' : `attachment; filename="${path.basename(abs).replace(/"/g, '')}"`,
    'X-Content-Type-Options': 'nosniff',
    // SVG may be shown inline, but sandboxed: no scripts, no same-origin access
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': 'no-cache',
    'Last-Modified': fs.statSync(abs).mtime.toUTCString(),
  });
});

route('GET', '/api/sites/:id/sections', async (req, res, p) => send(res, 200, await content.sections(getSite(p.id))));

route('POST', '/api/sites/:id/posts', async (req, res, p) => {
  send(res, 200, await content.newPost(getSite(p.id), await json(req)));
});

route('POST', '/api/sites/:id/sections', async (req, res, p) => {
  send(res, 200, await content.newSection(getSite(p.id), await json(req)));
});

// --- preview / publish
route('POST', '/api/sites/:id/preview', async (req, res, p) => {
  const site = getSite(p.id);
  const job = startJob({ type: 'preview', siteId: site.id, title: `Preview build: ${site.name}` }, (j) => build.previewBuild(j, site));
  send(res, 202, job.summary());
});

route('GET', '/api/sites/:id/pages', async (req, res, p) => send(res, 200, await build.previewPages(getSite(p.id))));

route('POST', '/api/sites/:id/publish', async (req, res, p) => {
  const site = getSite(p.id);
  const { dryRun = false, backupFirst = false, message } = await json(req);
  const job = startJob(
    { type: 'publish', siteId: site.id, title: `${dryRun ? 'Dry-run publish' : 'Publish'}: ${site.name}` },
    async (j) => {
      if (backupFirst && !dryRun) {
        j.log('— backing up to GitHub first —');
        await git.backup(j, site, { message: message || 'Backup before publish' });
      }
      j.log('— build & deploy —');
      return build.publish(j, site, { dryRun });
    },
  );
  send(res, 202, job.summary());
});

// --- git
route('GET', '/api/sites/:id/git', async (req, res, p) => send(res, 200, await git.status(getSite(p.id))));

route('POST', '/api/sites/:id/git/backup', async (req, res, p) => {
  const site = getSite(p.id);
  const b = await json(req);
  const job = startJob({ type: 'backup', siteId: site.id, title: `Back up to GitHub: ${site.name}` }, (j) => git.backup(j, site, b));
  send(res, 202, job.summary());
});

route('POST', '/api/sites/:id/git/pull', async (req, res, p) => {
  const site = getSite(p.id);
  const job = startJob({ type: 'pull', siteId: site.id, title: `Pull from GitHub: ${site.name}` }, (j) => git.pull(j, site));
  send(res, 202, job.summary());
});

route('POST', '/api/sites/:id/git/connect', async (req, res, p) => {
  const site = getSite(p.id);
  const b = await json(req);
  const job = startJob({ type: 'connect', siteId: site.id, title: `Connect to GitHub: ${site.name}` }, (j) => git.connect(j, site, b));
  send(res, 202, job.summary());
});

// --- theme modules
route('POST', '/api/sites/:id/theme/update', async (req, res, p) => {
  const site = getSite(p.id);
  const job = startJob({ type: 'theme', siteId: site.id, title: `Update theme modules: ${site.name}` }, (j) => build.updateTheme(j, site));
  send(res, 202, job.summary());
});

route('POST', '/api/sites/:id/theme/graph', async (req, res, p) => {
  const site = getSite(p.id);
  const job = startJob({ type: 'theme', siteId: site.id, title: `List theme modules: ${site.name}`, lockSite: false }, async (j) => {
    const g = await build.moduleGraph(j, site);
    j.log(g.join('\n') || '(no modules)');
    return { modules: g };
  });
  send(res, 202, job.summary());
});

// --- hugo
route('GET', '/api/hugo', async (req, res) => send(res, 200, await hugo.hugoStatus()));

route('GET', '/api/hugo/releases', async (req, res, p, s, url) => {
  const list = await hugo.releases({ refresh: url.searchParams.has('refresh') });
  send(res, 200, list.map(({ assets, ...r }) => r));
});

route('POST', '/api/hugo/upgrade', async (req, res) => {
  const { version, force = false, activate = true } = await json(req);
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new HttpError(400, 'version like 0.170.1 required');
  const job = startJob({ type: 'hugo', siteId: null, title: `Install Hugo ${version}` }, async (j) => {
    const inst = await hugo.installHugo(j, version);
    if (hugo.needsDartSass(inst.raw)) {
      j.log('this Hugo build has no built-in Sass; making sure Dart Sass is available');
      await hugo.ensureDartSass(j);
    }
    const failures = [];
    for (const site of config().sites.filter((x) => fs.existsSync(x.path))) {
      j.log(`— test build of ${site.name} with Hugo ${version} —`);
      try {
        await build.testBuild(j, site, inst.binary);
        j.log(`${site.name}: OK`);
      } catch (e) {
        failures.push(site.name);
        j.log(`${site.name}: FAILED — ${e.message}`, 'err');
      }
    }
    if (failures.length && !force) {
      throw new Error(`Hugo ${version} installed but NOT activated: test builds failed for ${failures.join(', ')}. The current version stays in use.`);
    }
    if (activate) {
      await hugo.activate(version);
      j.log(`Hugo ${version} is now the active version`);
    }
    return { ...inst, failures };
  });
  send(res, 202, job.summary());
});

route('POST', '/api/hugo/activate', async (req, res) => {
  const { version } = await json(req);
  await hugo.activate(version);
  send(res, 200, await hugo.hugoStatus());
});

route('DELETE', '/api/hugo/:version', async (req, res, p) => {
  await hugo.removeVersion(p.version);
  send(res, 200, await hugo.hugoStatus());
});

// --- jobs
route('GET', '/api/jobs', async (req, res, p, s, url) => send(res, 200, listJobs(url.searchParams.get('site'))));

route('GET', '/api/jobs/:jid', async (req, res, p, s, url) => {
  const j = getJob(p.jid);
  const since = Number(url.searchParams.get('since') || 0);
  send(res, 200, { ...j.summary(), lines: j.lines.slice(Math.max(0, since - j.dropped)), next: j.dropped + j.lines.length });
});

// ------------------------------------------------------------------ server

/** "/mysite/public/" for build.baseURL https://host/mysite/public/ (null for root sites, which can't be told apart). */
function sitePrefix(site) {
  try {
    const p = new URL(site.build.baseURL, 'http://x').pathname;
    return p.length > 1 ? p.replace(/\/?$/, '/') : null;
  } catch {
    return null;
  }
}

let katexDistCache;
function katexDist() {
  if (katexDistCache && fs.existsSync(katexDistCache)) return katexDistCache;
  for (const site of config().sites) {
    const d = path.join(site.path, 'node_modules', 'katex', 'dist');
    if (fs.existsSync(path.join(d, 'katex.min.js'))) return (katexDistCache = d);
  }
  const bundled = path.join(STATIC, 'vendor', 'katex');
  return fs.existsSync(path.join(bundled, 'katex.min.js')) ? (katexDistCache = bundled) : null;
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const pathname = decodeURIComponent(url.pathname);
  const session = auth.readSession(req.headers.cookie);

  if (pathname === '/healthz') return send(res, 200, 'ok');

  if (pathname.startsWith('/api/')) {
    // CSRF defence: SameSite=Strict cookie + a custom header no cross-site form can send.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-hsm'] !== '1') {
      throw new HttpError(403, 'missing X-HSM header');
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      if (!r.open && !session) throw new HttpError(401, 'login required');
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      return r.handler(req, res, params, session, url);
    }
    throw new HttpError(404, 'no such API route');
  }

  if (pathname.startsWith('/preview/')) {
    if (!session) return send(res, 302, '', { Location: '/' });
    const [, , id, ...rest] = pathname.split('/');
    const site = getSite(id);
    const root = build.previewDir(site);
    if (!fs.existsSync(root)) return send(res, 404, 'No preview yet — click "Build preview" first.');
    // Preview is the site's own theme; it needs its own scripts, so no app CSP, but it may only be framed by us.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    return serveFile(req, res, safeJoin(root, rest.join('/')), { csp: false });
  }

  // Posts reference assets by their production path (e.g. /mysite/public/files/x.mp4). In the
  // preview those requests land here; serve them from that site's preview build.
  if (session && req.method === 'GET') {
    for (const site of config().sites) {
      const prefix = sitePrefix(site);
      if (prefix && pathname.startsWith(prefix)) {
        const root = build.previewDir(site);
        if (fs.existsSync(root)) return serveFile(req, res, safeJoin(root, pathname.slice(prefix.length)), { csp: false });
      }
    }
  }

  if (pathname.startsWith('/vendor/katex/')) {
    // KaTeX for the editor's math preview, taken from a site's own node_modules so the editor
    // renders with exactly the version the published site uses (Toha bundles it).
    const dist = katexDist();
    if (!dist) return send(res, 404, 'KaTeX not found in any site node_modules');
    return serveFile(req, res, safeJoin(dist, pathname.slice('/vendor/katex/'.length)), { cache: true });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const abs = safeJoin(STATIC, rel);
  if (!fs.existsSync(abs)) return serveFile(req, res, path.join(STATIC, 'index.html'));
  return serveFile(req, res, abs);
}

export function requestListener(req, res) {
  handle(req, res).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message });
    else res.end();
  });
}

async function main() {
  // Let fetch() (Hugo release downloads, GitHub API) honour HTTPS_PROXY like git/curl do.
  if ((process.env.HTTPS_PROXY || process.env.https_proxy) && typeof http.setGlobalProxyFromEnv === 'function') {
    http.setGlobalProxyFromEnv();
  }
  const cfg = await loadConfig();
  if (process.env.HOME) fs.mkdirSync(process.env.HOME, { recursive: true });
  for (const s of cfg.sites) {
    try {
      await git.ensureCloned(s);
    } catch (e) {
      console.error(`could not clone ${s.id}: ${e.message}`);
    }
  }
  const server = http.createServer(requestListener);
  server.requestTimeout = 10 * 60e3;
  server.listen(cfg.listen.port, cfg.listen.host, () => {
    console.log(`Hugo Site Manager on http://${cfg.listen.host}:${cfg.listen.port}`);
    console.log(`config: ${CONFIG_FILE}`);
    console.log(`data:   ${DATA_DIR}`);
    for (const s of cfg.sites) console.log(`  site ${s.id}: ${s.path}${fs.existsSync(s.path) ? '' : '  (MISSING)'}`);
    if (!cfg.auth.passwordHash) console.warn('WARNING: no password set — run "npm run set-password"');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
