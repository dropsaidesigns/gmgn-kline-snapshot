/* Shared helpers for gmgn-scan / gmgn-dash. */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const num = (v) => Number(v) || 0;
const med = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const short = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
  return '$' + Math.round(n);
};

let _entry;
function cliEntry() {
  if (_entry) return _entry;
  const nodeDir = path.dirname(process.execPath);
  const roots = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
    path.join(nodeDir, 'node_modules'),
    path.join(nodeDir, '..', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ].filter(Boolean);
  try {
    _entry = require.resolve('gmgn-cli', { paths: roots });
  } catch {
    throw new Error('cannot find gmgn-cli — install with: npm i -g gmgn-cli');
  }
  return _entry;
}

function cli(args) {
  return JSON.parse(execFileSync(process.execPath, [cliEntry(), ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }));
}

/* gmgn's CDN sits behind Cloudflare and 403s a default client, so every
 * outbound request here wears a normal browser's headers. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function fetchBuf(url, { timeout = 8000, maxBytes = 400_000, referer = 'https://gmgn.ai/', depth = 0 } = {}) {
  return new Promise((resolve) => {
    if (depth > 3) return resolve(null);
    let u;
    try { u = new URL(url); } catch { return resolve(null); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return resolve(null);
    const mod = u.protocol === 'https:' ? https : http;
    // TLS on this machine is intercepted by Avast, so the interceptor's root
    // has to be trusted. That is done by running node with --use-system-ca
    // (see dash.bat / ensureSystemCA) rather than by disabling verification.
    const req = mod.get(u, {
      timeout,
      headers: { 'User-Agent': UA, Accept: '*/*', Referer: referer },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchBuf(new URL(res.headers.location, u).href,
          { timeout, maxBytes, referer, depth: depth + 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > maxBytes) { req.destroy(); return resolve(null); }
        chunks.push(d);
      });
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: res.headers['content-type'] || '' }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/* Node's TLS fingerprint gets 403'd by Cloudflare on gmgn's CDN, and Node
 * doesn't trust the Avast interception root by default. curl solves both: it
 * uses Schannel (the Windows cert store, which already trusts the Avast root)
 * and presents a handshake Cloudflare accepts. Verification stays ON. */
function curlFetch(url, { timeout = 10, maxBytes = 400_000, referer = 'https://gmgn.ai/' } = {}) {
  try {
    new URL(url);
  } catch { return null; }
  try {
    const buf = execFileSync('curl', [
      '-s', '--max-time', String(timeout),
      '--max-filesize', String(maxBytes),
      '-L', '--max-redirs', '3',
      '-H', `User-Agent: ${UA}`,
      '-H', `Referer: ${referer}`,
      '-H', 'Accept: */*',
      url,
    ], { maxBuffer: maxBytes * 2, timeout: (timeout + 5) * 1000 });
    return buf && buf.length ? buf : null;
  } catch { return null; }
}

async function pool(items, worker, width = 6) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await worker(items[idx], idx); } catch { out[idx] = null; }
    }
  }));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Read+parse a JSON file, tolerating "doesn't exist yet" (silent fallback —
 * nothing on disk to lose) very differently from "exists but is corrupt"
 * (loud — backs the corrupt bytes up to <path>.corrupt-<timestamp> BEFORE
 * returning fallback). Without the split, a transient truncated write (crash
 * mid-save, disk full) reads back as "empty", and the NEXT write silently
 * overwrites the only copy of whatever was really in there — for a journal
 * like my-launches.json that is unrecoverable data loss with zero signal it
 * happened. If the backup write itself fails, this throws rather than
 * returning fallback, since a caller writing fallback back over a corrupt
 * original with no safety copy is exactly the failure mode being closed. */
function readJsonSafe(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback; // file absent — nothing to back up, nothing lost
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    const backupPath = `${file}.corrupt-${Date.now()}`;
    try {
      fs.writeFileSync(backupPath, raw);
    } catch (backupErr) {
      throw new Error(`${file} is corrupt JSON (${e.message}) AND backing it up to ` +
        `${backupPath} failed (${backupErr.message}) — refusing to continue without a ` +
        `safety copy. Fix or manually back up ${file} before retrying.`);
    }
    console.error(`WARNING: ${file} is corrupt JSON (${e.message}). Backed up to ` +
      `${backupPath} before falling back to defaults — the corrupt original is left ` +
      `untouched by this run, but a later write to ${file} WILL replace it. Recover ` +
      `from the backup first if this data mattered.`);
    return fallback;
  }
}

module.exports = { num, med, esc, short, cli, cliEntry, fetchBuf, curlFetch, pool, sleep, readJsonSafe, UA };
