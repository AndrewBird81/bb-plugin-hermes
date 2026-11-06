#!/usr/bin/env node
// Fails if a tracked file holds a private value or a personal-data pattern.
// Values come from ~/.config/bb-plugin-hermes/private.env (KEY=value), when it exists.
// Usage: node scripts/check-private.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const envPath = join(homedir(), '.config/bb-plugin-hermes/private.env');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const checks = [];
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m) checks.push([`value of ${m[1]}`, new RegExp(`(?<![A-Za-z0-9])${escape(m[2].trim())}(?![A-Za-z0-9])`, 'gi')]);
  }
} else {
  console.warn(`note: ${envPath} not found; checking generic patterns only`);
}
checks.push(
  ['tailnet IP', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g],
  ['*.ts.net name', /[a-z0-9-]+\.ts\.net\b/gi],
  ['/Users/<name>/ path', /\/Users\/[^/\s"'`<>]+\//g],
  ['email', /(?<![\w.+-])[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi],
  ['Hermes session id', /\b\d{8}_\d{6}_[0-9a-f]{6,}\b/g],
);
const allowedEmail = /^(git@github\.com|[\w.+-]+@users\.noreply\.github\.com)$/i;

// Archify pages embed copies of other files as base64 or gzip+base64.
function* embedded(text) {
  for (const m of text.matchAll(/"contentBase64":"([A-Za-z0-9+/=]+)"/g)) yield Buffer.from(m[1], 'base64').toString('utf8');
  for (const m of text.matchAll(/"htmlGzip":"([A-Za-z0-9+/=]+)"/g)) yield gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8');
}

function scan(text, where, out) {
  for (const [name, rx] of checks) {
    for (const m of text.matchAll(rx)) {
      if (name === 'email' && allowedEmail.test(m[0])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      out.push(`${where}:${line}: ${name}`);
    }
  }
}

const hits = [];
// In a jj workspace the git index can lag behind new files, so ask jj (in UTC, since its snapshot stamps @).
const files = existsSync('.jj')
  ? execFileSync('jj', ['file', 'list'], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).split('\n').filter(Boolean)
  : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of files) {
  if (!existsSync(file)) continue;
  const buf = readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) continue;
  const text = buf.toString('utf8');
  scan(text, file, hits);
  for (const inner of embedded(text)) scan(inner, `${file} (embedded copy)`, hits);
}

if (hits.length) {
  console.error(`check-private: ${hits.length} hit(s); use docs/variables.md names instead:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-private: ${files.length} tracked files clean`);
