import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [algo, N, r, p, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(key, expected);
}

let secret = null;
function sessionSecret() {
  if (secret) return secret;
  if (process.env.HSM_SESSION_SECRET) {
    secret = Buffer.from(process.env.HSM_SESSION_SECRET);
    return secret;
  }
  const file = path.join(DATA_DIR, 'session.secret');
  try {
    secret = fs.readFileSync(file);
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    secret = crypto.randomBytes(32);
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  return secret;
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export const COOKIE = 'hsm_session';

export function issueSession(username, hours) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + hours * 3600e3 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readSession(cookieHeader) {
  const raw = parseCookies(cookieHeader)[COOKIE];
  if (!raw) return null;
  const [payload, mac] = raw.split('.');
  if (!payload || !mac) return null;
  const good = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export function parseCookies(h) {
  const out = {};
  for (const part of (h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(value, { secure, maxAgeSeconds }) {
  const attrs = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

// Simple in-memory brute-force throttle: 10 failures per 15 minutes per IP.
const failures = new Map();
export function loginAllowed(ip) {
  const rec = failures.get(ip);
  if (!rec) return true;
  if (Date.now() - rec.first > 15 * 60e3) {
    failures.delete(ip);
    return true;
  }
  return rec.count < 10;
}
export function recordLoginFailure(ip) {
  const rec = failures.get(ip);
  if (!rec || Date.now() - rec.first > 15 * 60e3) failures.set(ip, { first: Date.now(), count: 1 });
  else rec.count++;
}
export function clearLoginFailures(ip) {
  failures.delete(ip);
}
