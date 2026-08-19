/* A small TTL cache in front of the GMGN API.
 *
 * The API budget is the scarce resource here: it is shared between local
 * scanning and the hosted page, and a 429 puts the whole key into cooldown.
 * Most of what the dashboard asks for does not change every few seconds —
 * a token's daily candle history certainly does not — so repeat calls are
 * served from here instead of spending budget.
 *
 * Backed by the OS temp dir, which works both locally and inside a serverless
 * container (where it survives for the life of a warm instance). Falls back to
 * memory alone if the disk is unavailable.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(os.tmpdir(), 'gmgn-scan-cache');
const mem = new Map();

let diskOk = true;
try { fs.mkdirSync(DIR, { recursive: true }); } catch { diskOk = false; }

const keyFor = (k) => crypto.createHash('sha1').update(k).digest('hex').slice(0, 20) + '.json';

/* Returns the record whether or not it has expired; callers decide. */
function record(k) {
  const hit = mem.get(k);
  if (hit) return hit;
  if (!diskOk) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, keyFor(k)), 'utf8'));
    mem.set(k, raw);
    return raw;
  } catch { return undefined; }
}

function read(k) {
  const rec = record(k);
  return rec && rec.exp > Date.now() ? rec.v : undefined;
}

function write(k, v, ttlMs) {
  const rec = { exp: Date.now() + ttlMs, v };
  mem.set(k, rec);
  if (!diskOk) return;
  try { fs.writeFileSync(path.join(DIR, keyFor(k)), JSON.stringify(rec)); } catch { /* best effort */ }
}

/* Serve from cache when fresh; otherwise call through. If the call fails and a
 * stale copy exists, return the stale copy rather than nothing — an old number
 * with a note beats an empty panel. */
async function through(key, ttlMs, fn) {
  const fresh = read(key);
  if (fresh !== undefined) return { value: fresh, stale: false };
  try {
    const value = await fn();
    write(key, value, ttlMs);
    return { value, stale: false };
  } catch (e) {
    // Fall back to an expired copy from memory *or* disk. On a warm serverless
    // instance the disk copy is usually the only one there is.
    const stale = record(key);
    if (stale) return { value: stale.v, stale: true, error: e, age: Date.now() - (stale.exp - 1) };
    throw e;
  }
}

module.exports = { through, read, write, record, DIR };
