/* Local tool: pushes the just-baked kline-snapshot.json to a dedicated public
 * GitHub repo (dropsaidesigns/gmgn-kline-snapshot) so the deployed site can
 * fetch fresh candle-derived figures at runtime WITHOUT calling GMGN's kline
 * route and WITHOUT a redeploy — see data.js's loadKlineSnapshot() for the
 * read side, and NOTES.md ("Part B: hourly fresh series") for why this
 * mechanism was chosen over an hourly redeploy.
 *
 * The file contains only aggregated candle numbers and public token
 * addresses/symbols already visible on GMGN — no API keys, no wallet data, no
 * secrets — so a public repo is fine and is in fact the point: the live site
 * fetches https://raw.githubusercontent.com/... with zero auth.
 *
 * Uses `gh api` (already authed as dropsaidesigns) against the Contents API
 * rather than a git push, so this can run unattended from a scheduled task
 * with no working tree / git-credential setup — same "gh does the talking"
 * approach the alert-pinger workflow publishing used (see NOTES.md).
 *
 * The body is written to a temp file and sent via `--input <file>` instead of
 * `-f content=<base64>` on the command line: kline-snapshot.json is ~100KB,
 * which base64-inflates to ~140KB — comfortably past what's safe to hand a
 * child process as a single argv entry on Windows. --input streams the exact
 * JSON body from disk instead.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = process.env.KLINE_SNAPSHOT_REPO || 'dropsaidesigns/gmgn-kline-snapshot';
const BRANCH = process.env.KLINE_SNAPSHOT_BRANCH || 'main';
const FILE_PATH = 'kline-snapshot.json';
const LOCAL = path.join(__dirname, 'kline-snapshot.json');

function ghApi(args) {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8' });
}

/* The Contents API requires the current file's blob sha to update it (and
 * must NOT be sent when creating it for the first time). Returns null on any
 * failure (typically 404 — file doesn't exist yet), which the caller reads as
 * "create, don't update". */
function currentSha() {
  try {
    const out = ghApi(['-H', 'Accept: application/vnd.github+json',
      `repos/${REPO}/contents/${FILE_PATH}?ref=${BRANCH}`]);
    const json = JSON.parse(out);
    return typeof json.sha === 'string' ? json.sha : null;
  } catch {
    return null;
  }
}

function publish() {
  if (!fs.existsSync(LOCAL)) {
    throw new Error(`${LOCAL} does not exist — run kline-snapshot.js first`);
  }
  const bytes = fs.readFileSync(LOCAL);
  const sha = currentSha();
  const body = {
    message: `snapshot ${new Date().toISOString()}`,
    content: bytes.toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const tmp = path.join(os.tmpdir(), `gmgn-kline-publish-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(body));
  try {
    const out = ghApi(['-X', 'PUT', `repos/${REPO}/contents/${FILE_PATH}`, '--input', tmp]);
    const json = JSON.parse(out);
    const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${FILE_PATH}`;
    console.log(`published ${bytes.length} bytes to ${REPO} (commit ${json.commit && json.commit.sha ? json.commit.sha.slice(0, 8) : '?'})`);
    console.log(`raw URL: ${url}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

if (require.main === module) {
  try {
    publish();
  } catch (e) {
    console.error('publish-kline-snapshot.js failed:', e.message);
    process.exitCode = 1;
  }
}

module.exports = { publish, currentSha, REPO, BRANCH, FILE_PATH };
