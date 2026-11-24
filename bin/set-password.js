#!/usr/bin/env node
// Usage: npm run set-password            (prompts, writes the hash into config.json)
//        npm run set-password -- --print (prints a hash for HSM_PASSWORD_HASH / a k8s Secret)
import readline from 'node:readline';
import { CONFIG_FILE } from '../lib/config.js';
import { hashPassword } from '../lib/auth.js';
import { readJSON, writeJSON } from '../lib/util.js';

const print = process.argv.includes('--print');
const userArg = process.argv.find((a) => a.startsWith('--user='));

function ask(q, hidden) {
  // Prompts go to stderr so `$(npm run -s set-password -- --print)` captures only the hash.
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) process.stderr.write(s); };
  return new Promise((r) => rl.question(q, (a) => { rl.close(); if (hidden) process.stderr.write('\n'); r(a); }));
}

const pw = process.env.HSM_NEW_PASSWORD || (await ask('New password: ', true));
if (!process.env.HSM_NEW_PASSWORD && pw !== (await ask('Repeat password: ', true))) {
  console.error('Passwords do not match'); process.exit(1);
}
if (pw.length < 10) { console.error('Use at least 10 characters — this app can publish your sites.'); process.exit(1); }
const hash = hashPassword(pw);
if (print) { console.log(hash); process.exit(0); }
const raw = await readJSON(CONFIG_FILE, {});
raw.auth = { ...(raw.auth || {}), passwordHash: hash, ...(userArg ? { username: userArg.slice(7) } : {}) };
await writeJSON(CONFIG_FILE, raw, 0o600);
console.log(`Password saved to ${CONFIG_FILE} (user "${raw.auth.username || 'admin'}")`);
