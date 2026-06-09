const { test } = require('node:test');
const assert = require('node:assert');
const { runCcusage, parseCcusagePayload, localDateISO } = require('./ccusage');

const PAYLOAD = {
  daily: [
    { period: '2026-06-09', totalCost: 1.25 },
    { period: '2026-06-08', totalCost: 2.0 },
    { period: '2026-06-01', totalCost: 0.5 },   // 8 days before today -> outside 7-day window
    { period: '2026-05-15', totalCost: 9.0 },   // old, outside week
  ],
  totals: {
    totalCost: 12.5,
    totalTokens: 1234,
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 30,
    cacheCreationTokens: 4,
  },
};

test('parse: today/week/total are computed and rounded', () => {
  const r = parseCcusagePayload(PAYLOAD, '2026-06-09', '2026-06-03');
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.estimate, true);
  assert.strictEqual(r.daily, 1.25);             // only the 06-09 entry
  assert.strictEqual(r.weekly, 3.25);            // 06-09 + 06-08 (06-01 is before week_start 06-03)
  assert.strictEqual(r.total, 12.5);             // from totals.totalCost
  assert.deepStrictEqual(r.tokens, {
    total: 1234, input: 1000, output: 200, cacheRead: 30, cacheCreation: 4,
  });
  assert.strictEqual(r.days, 4);
});

test('parse: empty/garbage payload is safe', () => {
  const r = parseCcusagePayload({}, '2026-06-09', '2026-06-03');
  assert.strictEqual(r.daily, 0);
  assert.strictEqual(r.weekly, 0);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.days, 0);
});

test('localDateISO formats local calendar date', () => {
  assert.strictEqual(localDateISO(new Date(2026, 5, 9)), '2026-06-09'); // month is 0-based
  assert.strictEqual(localDateISO(new Date(2026, 0, 3)), '2026-01-03');
});

test('runCcusage: injected runner returns shaped data with timestamp', async () => {
  const fakeRun = async () => ({ stdout: JSON.stringify(PAYLOAD), stderr: '' });
  const r = await runCcusage({ run: fakeRun, now: new Date(2026, 5, 9) });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.daily, 1.25);
  assert.strictEqual(r.weekly, 3.25);
  assert.ok(typeof r.timestamp === 'string' && r.timestamp.length > 0);
});

test('runCcusage: npx missing -> clean error, no throw', async () => {
  const fakeRun = async () => { const e = new Error('spawn npx ENOENT'); e.code = 'ENOENT'; throw e; };
  const r = await runCcusage({ run: fakeRun });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /npx\/Node not found/);
});

test('runCcusage: timeout -> clean error', async () => {
  const fakeRun = async () => { const e = new Error('timeout'); e.killed = true; throw e; };
  const r = await runCcusage({ run: fakeRun });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /timed out/);
});

test('runCcusage: auth failure -> friendly message', async () => {
  const fakeRun = async () => { const e = new Error('boom'); e.stderr = 'Invalid API key provided'; throw e; };
  const r = await runCcusage({ run: fakeRun });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /Authentication error/);
});

test('runCcusage: non-JSON stdout -> parse error', async () => {
  const fakeRun = async () => ({ stdout: 'not json', stderr: '' });
  const r = await runCcusage({ run: fakeRun });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /Could not parse/);
});
