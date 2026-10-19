'use strict';

// Routing tests for the Codex stand-in (T636): while a stand-in is active,
// every inbound message that would have gone to the manager (999) is typed into
// the stand-in terminal instead; Claude Code's own raw slash commands (/clear)
// stay pinned to 999. Run:
//   node --test src/linkManager.standIn.test.js

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'test-guild';

const LinkManager = require('./linkManager');
const { config } = require('../config');

function withFetch(fn) {
  const calls = [];
  const real = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  return fn(calls).finally(() => { global.fetch = real; });
}

function linked(standInId) {
  const lm = new LinkManager();
  lm.target = { host: '127.0.0.1', port: 36319, token: 'tok', managerId: 999 };
  lm.standIn = { activeTerminalId: () => standInId, status: () => ({ active: !!standInId, terminalId: standInId }) };
  return lm;
}

test('forward() goes to 999 when no stand-in is active', () => withFetch(async (calls) => {
  config.submitDelayMs = 0;
  const lm = linked(null);
  const r = await lm.forward('hello', { source: 'typed' });
  assert.equal(r.ok, true);
  const keys = calls.filter((c) => c.url.endsWith('/terminal/keys'));
  assert.ok(keys.length >= 2);
  assert.ok(keys.every((c) => c.body.terminalId === 999));
}));

test('forward() is typed into the stand-in terminal while one is active', () => withFetch(async (calls) => {
  config.submitDelayMs = 0;
  const lm = linked(42);
  const r = await lm.forward('hello codex', { source: 'typed' });
  assert.equal(r.ok, true);
  const keys = calls.filter((c) => c.url.endsWith('/terminal/keys'));
  assert.ok(keys.length >= 2);
  assert.ok(keys.every((c) => c.body.terminalId === 42), 'all keystrokes go to the stand-in');
  assert.match(keys[0].body.keys[0], /Typed message from the user/);
  assert.equal(calls.filter((c) => c.url.endsWith('/queue/add')).length, 0, 'never via the 999-refusing queue');
}));

test('sendRaw() (Claude Code slash commands like /clear) stays pinned to 999 during a stand-in', () => withFetch(async (calls) => {
  config.submitDelayMs = 0;
  const lm = linked(42);
  await lm.sendRaw('/clear');
  const keys = calls.filter((c) => c.url.endsWith('/terminal/keys'));
  assert.ok(keys.length >= 2);
  assert.ok(keys.every((c) => c.body.terminalId === 999));
}));

test('status() reports the delivery terminal and the stand-in', () => {
  const lm = linked(42);
  const s = lm.status();
  assert.equal(s.managerId, 999);
  assert.equal(s.deliveryTerminalId, 42);
  assert.equal(s.standIn.active, true);
  const none = linked(null).status();
  assert.equal(none.deliveryTerminalId, 999);
});

test('a LinkManager without a standIn wired behaves exactly as before', () => withFetch(async (calls) => {
  config.submitDelayMs = 0;
  const lm = new LinkManager();
  lm.target = { host: '127.0.0.1', port: 36319, token: 'tok', managerId: 999 };
  await lm.forward('hi', { source: 'typed' });
  assert.ok(calls.filter((c) => c.url.endsWith('/terminal/keys')).every((c) => c.body.terminalId === 999));
  assert.equal(lm.status().deliveryTerminalId, 999);
}));

test("source 'synthetic' is framed as a self-test and logged with meta.synthetic (never as the user's words)", () => withFetch(async (calls) => {
  config.submitDelayMs = 0;
  const conversationLog = require('./conversationLog');
  const realRecord = conversationLog.recordInbound;
  const rows = [];
  conversationLog.recordInbound = (row) => { rows.push(row); return Promise.resolve(null); };
  try {
    const lm = linked(42);
    const r = await lm.forward('T636 routing test', { source: 'synthetic' });
    assert.equal(r.ok, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.synthetic, true);
    assert.equal(rows[0].meta.source, 'synthetic');
    const typed = calls.filter((c) => c.url.endsWith('/terminal/keys'))[0].body.keys[0];
    assert.match(typed, /Synthetic bridge self-test/);
    assert.match(typed, /NOT a message from the user/);
    assert.doesNotMatch(typed, /Typed message from the user/);
    // A real typed message is NOT flagged.
    rows.length = 0;
    await lm.forward('hi', { source: 'typed' });
    assert.equal(rows[0].meta.synthetic, undefined);
  } finally { conversationLog.recordInbound = realRecord; }
}));
