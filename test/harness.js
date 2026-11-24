// In-process HTTP harness: drives server.js's request listener with mock
// req/res objects, so the API can be tested where opening sockets is not allowed.
import { Readable, Writable } from 'node:stream';
import { loadConfig } from '../lib/config.js';
import { requestListener } from '../server.js';

let cookie = '';

export async function init() {
  await loadConfig();
}

export function call(method, url, { body, headers = {}, raw = false } = {}) {
  let payload = body;
  if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') payload = JSON.stringify(body);
  const req = Readable.from(payload !== undefined ? [Buffer.from(payload)] : []);
  Object.assign(req, {
    method,
    url,
    headers: { cookie, ...(method !== 'GET' ? { 'x-hsm': '1' } : {}), ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return new Promise((resolve) => {
    const chunks = [];
    const res = new Writable({
      write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); },
    });
    res.statusCode = 200;
    res._headers = {};
    res.headersSent = false;
    res.setHeader = (k, v) => { res._headers[k.toLowerCase()] = v; };
    res.writeHead = (status, h = {}) => {
      res.statusCode = status;
      for (const [k, v] of Object.entries(h)) res._headers[k.toLowerCase()] = v;
      res.headersSent = true;
      return res;
    };
    const origEnd = res.end.bind(res);
    res.end = (d) => {
      if (d) chunks.push(Buffer.from(d));
      origEnd();
      return res;
    };
    res.on('finish', () => {
      const buf = Buffer.concat(chunks);
      const sc = res._headers['set-cookie'];
      if (sc) cookie = String(sc).split(';')[0];
      let parsed = buf;
      if (!raw) {
        try { parsed = JSON.parse(buf.toString()); } catch { parsed = buf.toString(); }
      }
      resolve({ status: res.statusCode, headers: res._headers, body: parsed });
    });
    requestListener(req, res);
  });
}

export async function waitFor(jobId) {
  for (;;) {
    const r = await call('GET', `/api/jobs/${jobId}?since=0`);
    if (r.body.status !== 'running') return r.body;
    await new Promise((x) => setTimeout(x, 200));
  }
}

export function resetCookie() {
  cookie = '';
}
