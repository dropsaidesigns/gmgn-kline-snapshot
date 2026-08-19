/* Local tool: bakes every kline-derived figure the live dashboard needs
 * (hour-of-day profile, today's hourly series, the week-behind-us chart, and
 * the exit-profile samples) into kline-snapshot.json, so the deployed
 * serverless render (KLINE_FROM_SNAPSHOT=1 on Vercel) can hydrate them
 * without ever calling /v1/market/token_kline itself.
 *
 * Run locally only (second API key), via snapshot.bat every 6h:
 *   runners.js -> kline-snapshot.js (this file) -> audit.js gate -> deploy
 * which keeps the baked series never more than ~6h old on the live site.
 *
 * Pace: kline calls cost weight GMGN_KLINE_WEIGHT (10 by default) against a
 * rate-10/s leaky bucket (gmgn.js) — that combination already caps kline
 * calls at ~1/s with only a couple of calls' burst allowance, which is the
 * "≈1/s max locally" ceiling this ticket asks for; nothing here overrides
 * gmgn.js's own pacing constants. A 429 sets `rateLimited` below and STOPS
 * every further kline call for the rest of this run (never retried — a retry
 * during cooldown only extends the ban) — whatever chains/tokens were
 * already captured are still written to disk rather than the run producing
 * nothing at all. Same hard-stop shape as data.js's tokenInfoRateLimited.
 */

const fs = require('fs');
const path = require('path');
const gmgn = require('./gmgn');
const { num, med } = require('./lib');

const OUT = path.join(__dirname, 'kline-snapshot.json');
// Local default is all three — deliberately NOT data.js's CHAINS constant
// (which defaults the same way but can be trimmed via env for the live
// site's own collect()). This tool always bakes every chain it's given
// unless CHAINS is explicitly set for this run, same convention runners.js
// already uses for its own always-all-three default.
const CHAINS = (process.env.CHAINS || 'sol,robinhood,bsc')
  .split(',').map((s) => s.trim()).filter(Boolean);
const DEEP = 8; // matches data.js's DEEP — same "how many tokens define the hourly shape" count

let rateLimited = false;

/* Mirrors data.js's dailyVolume(), minus the parts render.js never reads
 * (hours/spanH/closes — see data.js's daysFromRaw() comment) and stripped
 * down to just the {time,volume} pairs hourProfile()/hoursToday()/
 * dailySeries() actually consume. `days` is intentionally NOT stored here —
 * data.js's daysFromRaw() rebuilds it locally from `raw` at hydrate time, so
 * the file only carries one representation of each candle, not two. */
async function dailyVolumeRaw(chain, address) {
  if (rateLimited) return null;
  const to = Math.floor(Date.now() / 1000);
  const from = to - 7 * 86400;
  let list;
  try {
    list = await gmgn.kline(chain, address, '1h', from, to);
  } catch (e) {
    if (e && e.rateLimited) {
      rateLimited = true;
      console.error(`  RATE LIMITED on ${chain}:${address} kline (1h) — stopping all further kline calls this run`);
    } else {
      console.error(`  kline (1h) failed for ${chain}:${address}: ${e.message}`);
    }
    return null;
  }
  if (!list || !list.length) return null;
  return list.map((c) => ({ time: c.time, volume: num(c.volume) }));
}

/* Mirrors data.js's exitProfile(), with one deliberate difference: each
 * sample stores the token's absolute launch time (`createdAt`, epoch
 * seconds) instead of a pre-baked `ageH`. data.js's
 * hydrateSnapshotExitProfile() recomputes ageH against the real render-time
 * "now" from that — the age shown on the live page is always honest, never
 * frozen at bake time, even though medMinsToPeak/medRetention (real
 * historical measurements) are. */
async function exitProfileRaw(chain, feed) {
  if (!feed) return null;
  const nowS = Math.floor(Date.now() / 1000);
  const cutoff = nowS - 12 * 3600;

  const pool = [].concat(feed.new_creation || [], feed.near_completion || [], feed.completed || []);
  const candidates = pool
    .filter((t) => t.address && num(t.created_timestamp) >= cutoff
      && num(t.holder_count) >= 100 && num(t.volume_24h) >= 10000)
    .sort((a, b) => num(b.created_timestamp) - num(a.created_timestamp))
    .slice(0, 4);

  const samples = [];
  for (const t of candidates) {
    if (rateLimited) break;
    const from = num(t.created_timestamp);
    const to = Math.min(from + 5400, nowS);
    let list;
    try {
      list = await gmgn.kline(chain, t.address, '1m', from, to);
    } catch (e) {
      if (e && e.rateLimited) {
        rateLimited = true;
        console.error(`  RATE LIMITED on ${chain}:${t.address} kline (1m, exit profile) — stopping all further kline calls this run`);
      } else {
        console.error(`  exit-profile kline (1m) failed for ${chain}:${t.symbol || t.address}: ${e.message}`);
      }
      break;
    }
    if (!list || list.length < 5) continue;

    let peakIdx = 0;
    for (let i = 1; i < list.length; i++) if (num(list[i].high) > num(list[peakIdx].high)) peakIdx = i;
    const peakHigh = num(list[peakIdx].high);
    if (!peakHigh) continue;

    const minsToPeak = (list[peakIdx].time - list[0].time) / 60000;
    const lastClose = num(list[list.length - 1].close);
    const retention = lastClose / peakHigh;

    samples.push({
      createdAt: num(t.created_timestamp),
      sym: t.symbol || t.address.slice(0, 6),
      mins: Math.round(minsToPeak),
      ret: retention,
    });
  }

  if (samples.length < 2) return null;
  return {
    n: samples.length,
    medMinsToPeak: Math.round(med(samples.map((s) => s.mins))),
    medRetention: med(samples.map((s) => s.ret)),
    samples,
  };
}

async function run() {
  const out = { generatedAt: Date.now(), chains: {} };

  for (const chain of CHAINS) {
    console.log(`== ${chain} ==`);
    if (rateLimited) { console.log(`  skipped — rate limited earlier this run`); continue; }

    // Cheap, weight-1/3 calls — same rank()/trenches() this tool needs to
    // pick "which 8 tokens define the hourly shape" and "which recent
    // launches feed the exit profile", exactly the selection data.js's own
    // processChain() makes for the live (non-snapshot) path.
    let rank = [];
    try { rank = await gmgn.rank(chain, '24h'); } catch (e) { console.error(`  rank() failed: ${e.message}`); }
    let trenchFeed = {};
    try { trenchFeed = await gmgn.trenches(chain, ['new_creation', 'near_completion', 'completed'], 80); }
    catch (e) { console.error(`  trenches() failed: ${e.message}`); }

    const historyTokens = rank
      .slice(0, 50)
      .filter((t) => t.creation_timestamp > 0 && t.address)
      .sort((a, b) => a.creation_timestamp - b.creation_timestamp)
      .slice(0, DEEP);

    const series = [];
    for (const t of historyTokens) {
      if (rateLimited) break;
      const raw = await dailyVolumeRaw(chain, t.address);
      if (raw) series.push({ sym: t.symbol || null, raw });
    }

    const exitP = await exitProfileRaw(chain, trenchFeed);

    out.chains[chain] = {
      historyFrom: historyTokens.map((t) => t.symbol).filter(Boolean),
      series,
      exitP,
    };
    console.log(`  ${series.length}/${historyTokens.length} history series captured (${series.reduce((s, x) => s + x.raw.length, 0)} candles total), exit profile ${exitP ? `${exitP.n} samples` : 'unavailable (<2 measurable launches)'}`);
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  const bytes = fs.statSync(OUT).size;
  console.log(`\nwrote ${OUT} (${bytes} bytes, ${(bytes / 1024).toFixed(1)}KB)`);
  if (rateLimited) {
    console.error('STOPPED EARLY due to a 429 — this run\'s snapshot may be missing some chains/tokens. It is still written; the next scheduled run fills in the rest.');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error('kline-snapshot.js failed:', e.message);
    process.exit(1);
  });
}

module.exports = { run, OUT };
