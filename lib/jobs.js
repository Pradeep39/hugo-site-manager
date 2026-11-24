import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { HttpError, isoNow } from './util.js';

const jobs = new Map();
const order = [];
const siteLocks = new Map(); // siteId -> jobId
const MAX_JOBS = 60;
const MAX_LINES = 5000;

const secrets = new Set();
export function registerSecret(s) {
  if (s && s.length >= 6) secrets.add(s);
}
function redact(line) {
  let out = line;
  for (const s of secrets) out = out.split(s).join('***');
  return out.replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***:***@');
}

class Job {
  constructor(type, siteId, title) {
    this.id = crypto.randomBytes(6).toString('hex');
    this.type = type;
    this.siteId = siteId;
    this.title = title;
    this.status = 'running';
    this.lines = [];
    this.dropped = 0; // lines trimmed from the front, so clients can use absolute offsets
    this.startedAt = isoNow();
    this.endedAt = null;
    this.result = null;
    this.error = null;
  }

  log(text, stream = 'info') {
    for (const l of String(text).split(/\r?\n/)) {
      if (l === '' && stream !== 'info') continue;
      this.lines.push({ t: Date.now(), s: stream, m: redact(l) });
    }
    if (this.lines.length > MAX_LINES) {
      const n = this.lines.length - MAX_LINES;
      this.lines.splice(0, n);
      this.dropped += n;
    }
  }

  /** Run a command without a shell; resolves with captured stdout. */
  exec(cmd, args, opts = {}) {
    const { cwd, env, quiet = false, allowFail = false, input } = opts;
    if (!quiet) this.log(`$ ${[cmd, ...args].map(shellQuote).join(' ')}`, 'cmd');
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const pump = (stream, kind) => {
        let buf = '';
        stream.on('data', (d) => {
          const s = d.toString();
          if (kind === 'out') out += s;
          else err += s;
          if (quiet) return;
          buf += s;
          const parts = buf.split(/\r?\n/);
          buf = parts.pop();
          for (const p of parts) this.log(p, kind);
        });
        stream.on('end', () => {
          if (buf && !quiet) this.log(buf, kind);
        });
      };
      pump(child.stdout, 'out');
      pump(child.stderr, 'err');
      if (input) child.stdin.end(input);
      else child.stdin.end();
      child.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
      child.on('close', (code) => {
        if (code === 0 || allowFail) resolve({ code, stdout: out, stderr: err });
        else {
          const e = new Error(`${cmd} exited with code ${code}${quiet && err ? `: ${err.trim().slice(-500)}` : ''}`);
          e.code = code;
          e.stdout = out;
          e.stderr = err;
          reject(e);
        }
      });
    });
  }

  summary() {
    return {
      id: this.id, type: this.type, siteId: this.siteId, title: this.title, status: this.status,
      startedAt: this.startedAt, endedAt: this.endedAt, result: this.result, error: this.error,
    };
  }
}

function shellQuote(a) {
  return /^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`;
}

/**
 * Start a background job. With `lockSite`, only one job per site runs at a time
 * (builds/deploys/git operations share the working tree).
 */
export function startJob({ type, siteId = null, title, lockSite = true }, fn) {
  const lockKey = lockSite ? siteId || '__global__' : null;
  if (lockKey && siteLocks.has(lockKey)) {
    const other = jobs.get(siteLocks.get(lockKey));
    throw new HttpError(409, `"${other?.title}" is still running for this site`);
  }
  const job = new Job(type, siteId, title);
  jobs.set(job.id, job);
  order.push(job.id);
  while (order.length > MAX_JOBS) jobs.delete(order.shift());
  if (lockKey) siteLocks.set(lockKey, job.id);
  job.log(`${title} — started ${job.startedAt}`);
  (async () => {
    try {
      job.result = (await fn(job)) ?? null;
      job.status = 'succeeded';
      job.log('✔ done');
    } catch (e) {
      job.status = 'failed';
      job.error = redact(e.message || String(e));
      job.log(`✖ ${job.error}`, 'err');
    } finally {
      job.endedAt = isoNow();
      if (lockKey) siteLocks.delete(lockKey);
    }
  })();
  return job;
}

/** Wait for a job (used by tests and the CLI). */
export async function waitJob(id) {
  while (jobs.get(id)?.status === 'running') await new Promise((r) => setTimeout(r, 100));
  return jobs.get(id);
}

export function getJob(id) {
  const j = jobs.get(id);
  if (!j) throw new HttpError(404, 'job not found');
  return j;
}

export function listJobs(siteId) {
  return order
    .map((id) => jobs.get(id))
    .filter((j) => j && (!siteId || j.siteId === siteId || j.siteId === null))
    .reverse()
    .map((j) => j.summary());
}

export function siteBusy(siteId) {
  const id = siteLocks.get(siteId);
  return id ? jobs.get(id)?.summary() : null;
}
