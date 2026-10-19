'use strict';

// Tests for /dump — the raw terminal-screen dump. Run:
//   node --test src/commands.dump.test.js
//
// The two things that must never break: the reply always fits inside Discord's
// 2000-char cap, and the control-API read never throws raw at the user.

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'test-guild';

const { formatDump, definitions } = require('./commands');
const controlApi = require('./controlApi');

const DISCORD_CAP = 2000;

test('/dump is registered with a required terminal_id and an optional chars', () => {
  const dump = definitions.find((d) => d.name === 'dump');
  assert.ok(dump, '/dump must be in the registered definitions');
  const byName = Object.fromEntries(dump.options.map((o) => [o.name, o]));
  assert.equal(byName.terminal_id.required, true);
  assert.ok(!byName.chars.required);
});

test('takes the LAST chars of the screen, fenced', () => {
  const screen = 'A'.repeat(5000) + 'THE-END';
  const out = formatDump(screen, 999);
  assert.match(out, /Terminal 999/);
  assert.ok(out.endsWith('THE-END\n```'), 'the dump must end at the newest output');
  assert.ok(out.includes('```\n'), 'body is a code block');
});

test('a huge screen still fits inside the Discord message cap', () => {
  const out = formatDump('x'.repeat(100000), 5);
  assert.ok(out.length <= DISCORD_CAP, `length ${out.length} must be <= ${DISCORD_CAP}`);
});

test('a chars override is honoured but clamped to a deliverable size', () => {
  const screen = 'y'.repeat(50000);
  const small = formatDump(screen, 3, 200);
  assert.ok(small.length < 400, 'a small request stays small');

  const huge = formatDump(screen, 3, 99999);
  assert.ok(huge.length <= DISCORD_CAP, 'an absurd request is clamped, not sent oversized');

  const negative = formatDump(screen, 3, -5);
  assert.ok(negative.length <= DISCORD_CAP && negative.length > 400, 'nonsense falls back to the default');
});

test('backtick fences in the output cannot break out of the code block', () => {
  const out = formatDump('before ``` after', 1);
  const fences = out.split('```').length - 1;
  assert.equal(fences, 2, 'only the opening and closing fences survive');
  assert.ok(out.length <= DISCORD_CAP);
});

test('an empty or whitespace-only screen says so instead of posting an empty block', () => {
  assert.match(formatDump('', 7), /screen is empty/);
  assert.match(formatDump('   \n\n  ', 7), /screen is empty/);
  assert.match(formatDump(null, 7), /screen is empty/);
});

test('getScreen posts the documented control-API request', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true, screen: 'hello', rows: 40, cols: 100 }) };
  };
  try {
    const r = await controlApi.getScreen({ host: '127.0.0.1', port: 44073, token: 'tok' }, 999);
    assert.equal(r.screen, 'hello');
    assert.equal(calls[0].url, 'http://127.0.0.1:44073/terminal/screen');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['X-CCBOT-Token'], 'tok');
    assert.deepEqual(JSON.parse(calls[0].init.body), { terminalId: '999', scrollback: false });
  } finally { global.fetch = realFetch; }
});

test('getScreen turns API failures into readable errors, never a crash', async () => {
  const realFetch = global.fetch;

  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error: 'terminal not found' }) });
  await assert.rejects(
    () => controlApi.getScreen({ port: 1, token: 't' }, 42),
    /terminal not found/);

  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    () => controlApi.getScreen({ port: 44073, token: 't' }, 999),
    /unreachable .*is the app running/);

  global.fetch = realFetch;
});

test('getScreen refuses when the bridge is not linked', async () => {
  await assert.rejects(() => controlApi.getScreen(null, 999), /not linked/);
});

// ---- the authorization gate, exercised through handle() ---------------------

const { config } = require('../config');
const commands = require('./commands');

// Minimal stand-ins for the discord.js interaction + the bridge's link manager.
function fakeInteraction(userId, opts = { terminal_id: 999 }) {
  const sent = [];
  return {
    sent,
    isChatInputCommand: () => true,
    commandName: 'dump',
    user: { id: userId, tag: 'someone#0001' },
    deferred: false,
    replied: false,
    options: { getInteger: (n) => (n in opts ? opts[n] : null) },
    async deferReply() { this.deferred = true; },
    async reply(p) { this.replied = true; sent.push(p.content ?? p); },
    async editReply(p) { sent.push(p.content ?? p); },
  };
}
const linkedManager = (screen) => ({
  isLinked: () => true,
  readScreen: async () => ({ screen }),
});

test('/dump is REFUSED for a user outside the allow-list', async () => {
  config.allowedUserIds = ['100000000000000001']; // the one allow-listed user
  const i = fakeInteraction('999999999999999999');
  await commands.handle(i, { linkManager: linkedManager('secret screen'), session: {} });
  assert.equal(i.sent.length, 1);
  assert.match(i.sent[0], /not authorized/i, 'gets the standard deny message');
  assert.ok(!/secret screen/.test(i.sent[0]), 'never leaks terminal contents');
});

test('/dump returns the screen for the allow-listed user', async () => {
  config.allowedUserIds = ['100000000000000001'];
  const i = fakeInteraction('100000000000000001');
  await commands.handle(i, { linkManager: linkedManager('line one\nline two'), session: {} });
  assert.equal(i.sent.length, 1);
  assert.match(i.sent[0], /Terminal 999/);
  assert.match(i.sent[0], /line two/);
});

test('/dump reports a control-API failure instead of throwing', async () => {
  config.allowedUserIds = ['100000000000000001'];
  const i = fakeInteraction('100000000000000001', { terminal_id: 42 });
  const broken = { isLinked: () => true, readScreen: async () => { throw new Error('terminal not found'); } };
  await commands.handle(i, { linkManager: broken, session: {} });
  assert.match(i.sent[0], /Couldn't read terminal 42: terminal not found/);
});

test('/dump tells an unlinked bridge to link first', async () => {
  config.allowedUserIds = ['100000000000000001'];
  const i = fakeInteraction('100000000000000001');
  await commands.handle(i, { linkManager: { isLinked: () => false }, session: {} });
  assert.match(i.sent[0], /Not linked/);
});

test('/dump with a missing terminal id answers with the usage hint', async () => {
  config.allowedUserIds = ['100000000000000001'];
  const i = fakeInteraction('100000000000000001', {}); // no terminal_id
  await commands.handle(i, { linkManager: linkedManager('x'), session: {} });
  assert.match(i.sent[0], /Usage: \*\*\/dump terminal_id/);
});
