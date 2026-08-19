/* GMGN OpenAPI over plain HTTP.
 *
 * Replaces shelling out to gmgn-cli so the same code runs locally and inside a
 * serverless function. Auth for the market routes is "exist" auth: an X-APIKEY
 * header plus a timestamp and a fresh client_id on every request. The server
 * allows ±5s of clock drift and rejects a replayed client_id within 7s.
 */

const crypto = require('crypto');
const cache = require('./cache');
const BASE = 'https://openapi.gmgn.ai';

function apiKey() {
  if (process.env.GMGN_API_KEY) return process.env.GMGN_API_KEY.trim();
  // Local fallback: the CLI's own config file.
  try {
    const os = require('os'), path = require('path'), fs = require('fs');
    const p = path.join(os.homedir(), '.config', 'gmgn', '.env');
    const m = fs.readFileSync(p, 'utf8').match(/^GMGN_API_KEY=(.*)$/m);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  throw new Error('GMGN_API_KEY is not set');
}

/* The service uses a leaky bucket: rate 20, capacity 20, and each route costs a
 * different weight. Requests are queued and paced so a burst can't trip a 429,
 * because a 429 during cooldown extends the ban. */
// The key is free; the constraint is the server's leaky bucket (rate 20,
// capacity 20) and its multi-minute ban on 429. Run near the ceiling but not
// at it — the headroom is for the ban, not the bill.
const RATE = Number(process.env.GMGN_RATE || 10);
const CAPACITY = Number(process.env.GMGN_BURST || 16);
let tokens = CAPACITY, last = Date.now(), chain = Promise.resolve();

function take(weight) {
  const now = Date.now();
  tokens = Math.min(CAPACITY, tokens + ((now - last) / 1000) * RATE);
  last = now;
  if (tokens >= weight) { tokens -= weight; return 0; }
  const waitMs = Math.ceil(((weight - tokens) / RATE) * 1000);
  tokens = 0;
  return waitMs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function queue(weight, run) {
  const next = chain.then(async () => {
    const wait = take(weight);
    if (wait) await sleep(wait);
    return run();
  });
  // Keep the queue alive even when a call rejects.
  chain = next.then(() => {}, () => {});
  return next;
}

async function request(method, path, query = {}, body, weight = 1, tries = 2) {
  return queue(weight, async () => {
    for (let attempt = 0; ; attempt++) {
      const u = new URL(BASE + path);
      for (const [k, v] of Object.entries(query)) {
        if (v == null) continue;
        for (const one of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(one));
      }
      u.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
      u.searchParams.set('client_id', crypto.randomUUID());

      let res;
      try {
        res = await fetch(u, {
          method,
          headers: {
            'X-APIKEY': apiKey(),
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: body == null ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        if (attempt < tries) { await sleep(400 * (attempt + 1)); continue; }
        throw new Error(`${path}: ${e.message}`);
      }

      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = null; }
      if (process.env.GMGN_DEBUG_HEADERS) {
        console.error(`[headers] ${path} remaining=${res.headers.get('x-ratelimit-remaining')} limit=${res.headers.get('x-ratelimit-limit')} reset=${res.headers.get('x-ratelimit-reset')}`);
      }

      if (res.status === 429 || json?.code === 429) {
        const resetAt = Number(json?.reset_at || res.headers.get('x-ratelimit-reset') || 0);
        const waitMs = resetAt ? Math.max(0, resetAt * 1000 - Date.now()) : 3000;
        // Don't hammer: repeated calls during cooldown extend the ban.
        if (attempt < tries && waitMs < 15_000) { await sleep(waitMs + 500); continue; }
        const err = new Error(`rate limited on ${path}`);
        err.rateLimited = true;
        err.resetAt = resetAt || null;
        throw err;
      }
      if (!res.ok || (json && json.code && json.code !== 0)) {
        if (attempt < tries && res.status >= 500) { await sleep(400 * (attempt + 1)); continue; }
        throw new Error(`${path}: ${json?.error || res.status} ${json?.message || text.slice(0, 120)}`);
      }
      return json;
    }
  });
}

/* Responses arrive wrapped, sometimes twice: {code,data:{code,data:{...}}}.
 * Peel envelopes until the payload appears. */
function unwrap(j, key) {
  let node = j;
  for (let i = 0; i < 4 && node && typeof node === 'object'; i++) {
    if (key && node[key] !== undefined) return node[key];
    if (!key && !('code' in node) && !('data' in node)) return node;
    node = node.data;
  }
  return key ? undefined : j;
}

/* Route wrappers. Weights come from the published limiter table; TTLs come from
 * how fast each thing actually moves. Trending shifts by the minute, a token's
 * daily candle history barely shifts at all. */
const KLINE_WEIGHT = Number(process.env.GMGN_KLINE_WEIGHT || 10);

const TTL = {
  rank: Number(process.env.TTL_RANK || 30_000),
  trenches: Number(process.env.TTL_TRENCHES || 120_000),
  kline: Number(process.env.TTL_KLINE || 600_000),
};

// Set when a call came back from cache after the live attempt failed, so the
// page can say the numbers are a few minutes old instead of pretending.
// klineCalls is a separate, narrower counter than `calls` — it counts every
// invocation of kline() below specifically (cache hit or not), so callers
// (audit.js under KLINE_FROM_SNAPSHOT=1) can assert "zero token_kline usage"
// precisely, rather than inferring it from the aggregate call count which
// also includes rank/trenches/token_info.
const stats = { stale: 0, calls: 0, klineCalls: 0, lastError: null, rateLimited: false, reset() { this.stale = 0; this.calls = 0; this.klineCalls = 0; this.lastError = null; this.rateLimited = false; } };

async function cached(key, ttl, weight, run) {
  stats.calls++;
  const r = await cache.through(key, ttl, run);
  if (r.stale) {
    stats.stale++;
    stats.lastError = r.error && r.error.message;
    if (r.error && r.error.rateLimited) stats.rateLimited = true;
  }
  return r.value;
}

const rank = (chainName, interval, extra = {}) =>
  cached(`rank:${chainName}:${interval}:${JSON.stringify(extra)}`, TTL.rank, 1, () =>
    request('GET', '/v1/market/rank',
      { chain: chainName, interval, limit: 100, order_by: 'volume', direction: 'desc', ...extra }, null, 1)
      .then((j) => unwrap(j, 'rank') || []));

// from/to are taken in seconds for convenience; the API wants milliseconds.
// The cache key is rounded to the hour so a shifting "now" doesn't miss.
const kline = (chainName, address, resolution, from, to) => {
  stats.klineCalls++;
  const bucket = Math.floor(to / 3600);
  return cached(`kline:${chainName}:${address}:${resolution}:${bucket}`, TTL.kline, 2, () =>
    request('GET', '/v1/market/token_kline',
      { chain: chainName, address, resolution, from: from * 1000, to: to * 1000 }, null, KLINE_WEIGHT)
      .then((j) => unwrap(j, 'list') || []));
};

const trenches = (chainName, types, limit = 80) =>
  cached(`trenches:${chainName}:${(types || []).join(',')}:${limit}`, TTL.trenches, 3, () =>
    request('POST', '/v1/trenches', { chain: chainName }, {
      chain: chainName,
      ...Object.fromEntries((types || ['new_creation', 'near_completion', 'completed'])
        .map((t) => [t, { filters: ['offchain', 'onchain'], launchpad_platform_v2: true, limit }])),
    }, 3).then((j) => unwrap(j) || {}));

/* /v1/user/wallet_activity — extracted from gmgn-cli (portfolio.js /
 * OpenApiClient.js): "exist" auth like token/info and rank, NOT the signed
 * auth wallet_holdings needs (no GMGN_PRIVATE_KEY required). Returns a
 * wallet's own historical buy/sell/transfer events, each with a timestamp —
 * this is the ONLY route that turns a dev-hold claim into something anchored
 * to a moment in time instead of "whatever the balance reads right now".
 * Weight observed live 2026-08-17 (see NOTES.md): x-ratelimit-remaining
 * dropped by 1 per call, same as token/info/rank — costs 1, not looked up in
 * a published table (none is public), so WALLET_ACTIVITY_WEIGHT defaults to
 * 1 and stays overridable. Never cached: each call is a one-off historical
 * reconstruction the caller persists itself (my-launches.json's devHistory),
 * not a value that benefits from a shared TTL.
 * type accepts an array (buy/sell/transferIn/transferOut/add/remove);
 * cursor supports pagination via the response's `next` field. */
const WALLET_ACTIVITY_WEIGHT = Number(process.env.GMGN_WALLET_ACTIVITY_WEIGHT || 1);
const walletActivity = (chainName, walletAddress, extra = {}) => {
  stats.calls++;
  return request('GET', '/v1/user/wallet_activity',
    { chain: chainName, wallet_address: walletAddress, ...extra }, null, WALLET_ACTIVITY_WEIGHT)
    .then((j) => unwrap(j) || {});
};

module.exports = { request, rank, kline, trenches, walletActivity, apiKey, unwrap, stats, TTL };
