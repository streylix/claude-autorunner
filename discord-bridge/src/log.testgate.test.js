'use strict';

// Under `node --test`, the logger must not forward anything to the production
// backend on 127.0.0.1:8123 (T636 c6 — it has happened before). Run:
//   node --test src/log.testgate.test.js

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'test-guild';

const { config } = require('../config');
const log = require('./log');

test('forwardLogsToBackend defaults OFF under the test runner', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this test must run under node --test');
  assert.equal(config.forwardLogsToBackend, false);
});

test('log.* performs no fetch under the test runner', async () => {
  const real = global.fetch;
  const calls = [];
  global.fetch = async (url) => { calls.push(url); return { ok: true }; };
  try {
    log.info('probe'); log.warn('probe'); log.error('probe'); log.success('probe');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, []);
  } finally { global.fetch = real; }
});
