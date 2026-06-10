/**
 * Host-side ccusage cost calculator.
 *
 * WHY THIS LIVES IN MAIN (not the Django backend): the cost figures come from
 * `npx ccusage`, which reads the Claude Code session logs under
 * `~/.claude/projects`. The default deployment runs the backend in Docker, and
 * that container ships NO Node/npx AND does not mount the host's `~/.claude` —
 * so the backend `POST /api/ccusage/` endpoint structurally cannot work (it
 * returns `ccusage unavailable (npx/Node not found on PATH)`). The Electron main
 * process, by contrast, runs on the host where both `npx` and the logs exist.
 * Running ccusage here is the only layer that actually has the data.
 *
 * This mirrors the JSON shape that backend/pricing/views.py used to return, so
 * the renderer's pricing view is unchanged apart from the call site.
 */

const { execFile } = require('child_process');

/** Local-calendar YYYY-MM-DD (ccusage `period` is a local date string). */
function localDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const intOf = (n) => Math.trunc(Number(n) || 0);

/**
 * Pure parser: shape ccusage's `daily --json` payload into the pricing
 * response. `today`/`weekStart` are YYYY-MM-DD strings; lexicographic compare
 * is chronological for ISO dates, so no date math is needed here.
 */
function parseCcusagePayload(payload, today, weekStart) {
  const daily = (payload && Array.isArray(payload.daily)) ? payload.daily : [];
  const totals = (payload && payload.totals) || {};

  let todayCost = 0;
  let weekCost = 0;
  for (const entry of daily) {
    const period = (entry && entry.period) || '';
    const cost = Number(entry && entry.totalCost) || 0;
    if (period === today) todayCost += cost;
    if (period >= weekStart) weekCost += cost;
  }

  return {
    success: true,
    estimate: true, // renderer shows the "notional API-equivalent" disclaimer
    source: 'ccusage',
    daily: round2(todayCost),
    weekly: round2(weekCost),
    total: round2(totals.totalCost),
    tokens: {
      total: intOf(totals.totalTokens),
      input: intOf(totals.inputTokens),
      output: intOf(totals.outputTokens),
      cacheRead: intOf(totals.cacheReadTokens),
      cacheCreation: intOf(totals.cacheCreationTokens),
    },
    days: daily.length,
  };
}

/**
 * Run ccusage on the host and return the shaped pricing response.
 * Never throws — failures are returned as `{ success:false, error }` so the
 * renderer can surface a clean message.
 *
 * @param {object} [opts]
 * @param {(cmd,args,options)=>Promise<{stdout,stderr}>} [opts.run] injectable
 *        runner (for tests). Defaults to execFile.
 * @param {Date} [opts.now] injectable clock (for tests).
 */
async function runCcusage(opts = {}) {
  const now = opts.now || new Date();
  const today = localDateISO(now);
  const weekStart = localDateISO(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));

  const run = opts.run || ((cmd, args, options) => new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  }));

  let stdout;
  try {
    // `-y` skips the first-run install prompt; bare `ccusage` uses the cached
    // package. 60s covers a cold download on first use.
    const res = await run('npx', ['-y', 'ccusage', 'daily', '--json'], {
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
    });
    stdout = res.stdout;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { success: false, error: 'ccusage unavailable (npx/Node not found on PATH)' };
    }
    if (err && err.killed) {
      return { success: false, error: 'ccusage timed out' };
    }
    const msg = ((err && (err.stderr || err.message)) || 'unknown error').toString().trim();
    const friendly = /invalid api key|authentication/i.test(msg)
      ? 'Authentication error — run `claude auth status` to verify Claude Code is logged in.'
      : `ccusage failed: ${msg}`;
    return { success: false, error: friendly };
  }

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (e) {
    return { success: false, error: `Could not parse ccusage JSON: ${e.message}` };
  }

  const shaped = parseCcusagePayload(payload, today, weekStart);
  shaped.timestamp = now.toISOString();
  return shaped;
}

module.exports = { runCcusage, parseCcusagePayload, localDateISO };
