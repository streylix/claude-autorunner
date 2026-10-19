'use strict';

// Tests for /terminals — lists every terminal known to the manager app: id,
// title, status. Run:
//   node --test src/commands.terminals.test.js

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'test-guild';

const { formatTerminals, definitions } = require('./commands');
const { config } = require('../config');
const commands = require('./commands');

test('/terminals is registered with no required options', () => {
  const d = definitions.find((x) => x.name === 'terminals');
  assert.ok(d, '/terminals must be in the registered definitions');
});

test('formats one line per terminal, sorted by id', () => {
  const out = formatTerminals([
    { id: 24, title: 'Auditor', status: 'prompted' },
    { id: 4, title: 'jade web polish', status: 'running' },
    { id: 999, title: 'Manager', status: '...' },
  ]);
  const lines = out.split('\n').slice(1);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^`4` — jade web polish — running$/);
  assert.match(lines[1], /^`24` — Auditor — prompted$/);
  assert.match(lines[2], /^`999` — Manager — \.\.\.$/);
});

test('a terminal with status "..." is shown as-is, not blank or mangled', () => {
  const out = formatTerminals([{ id: 999, title: 'Manager', status: '...' }]);
  assert.match(out, /`999` — Manager — \.\.\./);
});

test('an empty terminal list says so, with 0 of 0 — never crashes', () => {
  const out = formatTerminals([]);
  assert.match(out, /0 of 0/);
  assert.doesNotThrow(() => formatTerminals(null));
  assert.doesNotThrow(() => formatTerminals(undefined));
});

test('the row count matches the /state terminal count, both shown', () => {
  const terminals = [
    { id: 1, title: 'a', status: 'running' },
    { id: 2, title: 'b', status: '...' },
  ];
  const out = formatTerminals(terminals);
  const rowCount = out.split('\n').length - 1;
  assert.equal(rowCount, terminals.length);
  assert.match(out, new RegExp(`${terminals.length} of ${terminals.length}`));
});

// ---- the authorization + link gates, exercised through handle() -----------

function fakeInteraction(userId, opts = {}) {
  const sent = [];
  return {
    sent,
    isChatInputCommand: () => true,
    commandName: 'terminals',
    user: { id: userId, tag: 'someone#0001' },
    deferred: false,
    replied: false,
    options: {
      getInteger: (n) => (n in opts ? opts[n] : null),
      getString: () => null,
      getAttachment: () => null,
    },
    async deferReply() { this.deferred = true; },
    async reply(p) { this.replied = true; sent.push(p.content ?? p); },
    async editReply(p) { sent.push(p.content ?? p); },
  };
}

test('/terminals is REFUSED for a user outside the allow-list', async () => {
  config.allowedUserIds = ['100000000000000001'];
  const i = fakeInteraction('999999999999999999');
  await commands.handle(i, {
    linkManager: { isLinked: () => true, listTerminals: async () => [] },
    session: {},
  });
  assert.equal(i.sent.length, 1);
  assert.match(i.sent[0], /not authorized/i);
});

test('/terminals tells an unlinked bridge to link first', async () => {
  config.allowedUserIds = ['100000000000000001'];
  const i = fakeInteraction('100000000000000001');
  await commands.handle(i, { linkManager: { isLinked: () => false }, session: {} });
  assert.match(i.sent[0], /Not linked/);
});

test('/terminals returns the formatted list, read fresh from /state, for an allow-listed user', async () => {
  config.allowedUserIds = ['100000000000000001'];
  const i = fakeInteraction('100000000000000001');
  const terminals = [
    { id: 999, title: 'Manager', status: '...' },
    { id: 4, title: 'jade', status: 'running' },
  ];
  let calls = 0;
  await commands.handle(i, {
    linkManager: { isLinked: () => true, listTerminals: async () => { calls++; return terminals; } },
    session: {},
  });
  assert.equal(calls, 1, 'must read /state at the moment of the command');
  assert.equal(i.sent.length, 1);
  assert.match(i.sent[0], /2 of 2/);
  assert.match(i.sent[0], /jade/);
});

test('/terminals reports a control-API failure instead of throwing', async () => {
  config.allowedUserIds = ['100000000000000001'];
  const i = fakeInteraction('100000000000000001');
  await commands.handle(i, {
    linkManager: {
      isLinked: () => true,
      listTerminals: async () => { throw new Error('control API unreachable'); },
    },
    session: {},
  });
  assert.match(i.sent[0], /Couldn't list terminals: control API unreachable/);
});
