'use strict';

// Tests for /manager codex | claude | status (T636). Run:
//   node --test src/commands.manager.test.js

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'test-guild';

const commands = require('./commands');
const { definitions } = require('./commands');
const { config } = require('../config');

const ALLOWED = '100000000000000001';

function fakeInteraction(userId, sub) {
  const sent = [];
  return {
    sent,
    isChatInputCommand: () => true,
    commandName: 'manager',
    user: { id: userId, tag: 'someone#0001' },
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => sub,
      getString: () => null,
      getInteger: () => null,
      getAttachment: () => null,
    },
    async deferReply() { this.deferred = true; },
    async reply(p) { this.replied = true; sent.push(p.content ?? p); },
    async editReply(p) { sent.push(p.content ?? p); },
  };
}

function ctx({ linked = true, standIn, lmStatus } = {}) {
  return {
    linkManager: {
      isLinked: () => linked,
      target: linked ? { port: 36319, token: 't', managerId: 999 } : null,
      status: () => lmStatus || { linked, managerId: 999, port: 36319, deliveryTerminalId: 999, standIn: standIn ? standIn.status() : null },
    },
    standIn,
    session: {},
  };
}

test('/manager is registered with codex, claude and status subcommands', () => {
  const d = definitions.find((x) => x.name === 'manager');
  assert.ok(d, '/manager must be registered');
  const subs = d.options.map((o) => o.name).sort();
  assert.deepEqual(subs, ['claude', 'codex', 'status']);
});

test('/manager codex refuses when not linked', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, 'codex');
  let started = false;
  await commands.handle(i, ctx({ linked: false, standIn: { start: async () => { started = true; }, status: () => ({ active: false }) } }));
  assert.equal(started, false);
  assert.match(i.sent[0], /Not linked/);
});

test('/manager codex starts the stand-in and reports the terminal id and confirmation', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, 'codex');
  const calls = [];
  const standIn = {
    start: async (target) => { calls.push(['start', target.port]); return { ok: true, terminalId: 42, confirmed: true }; },
    status: () => ({ active: true, terminalId: 42 }),
  };
  await commands.handle(i, ctx({ standIn }));
  assert.deepEqual(calls, [['start', 36319]]);
  assert.match(i.sent[0], /terminal 42/);
  assert.match(i.sent[0], /Codex/);
  assert.match(i.sent[0], /route/i);
});

test('/manager codex reports an unconfirmed start honestly', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, 'codex');
  const standIn = {
    start: async () => ({ ok: true, terminalId: 42, confirmed: false }),
    status: () => ({ active: true, terminalId: 42 }),
  };
  await commands.handle(i, ctx({ standIn }));
  assert.match(i.sent[0], /terminal 42/);
  assert.match(i.sent[0], /could not confirm|not confirmed|unconfirmed/i);
});

test('/manager codex surfaces a start failure', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, 'codex');
  const standIn = { start: async () => ({ ok: false, error: 'terminal create failed: HTTP 500' }), status: () => ({ active: false }) };
  await commands.handle(i, ctx({ standIn }));
  assert.match(i.sent[0], /❌/);
  assert.match(i.sent[0], /HTTP 500/);
});

test('/manager claude hands back: stops the stand-in and says routing is back on 999', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, 'claude');
  const calls = [];
  const standIn = {
    stop: async (target) => { calls.push(['stop', target.port]); return { ok: true, wasActive: true, terminalId: 42, deleted: true }; },
    status: () => ({ active: false }),
  };
  await commands.handle(i, ctx({ standIn }));
  assert.deepEqual(calls, [['stop', 36319]]);
  assert.match(i.sent[0], /999/);
  assert.match(i.sent[0], /closed/i);
});

test('/manager claude when no stand-in is active says so', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, 'claude');
  const standIn = { stop: async () => ({ ok: true, wasActive: false }), status: () => ({ active: false }) };
  await commands.handle(i, ctx({ standIn }));
  assert.match(i.sent[0], /already|no stand-in|not active/i);
});

test('/manager status shows where messages are going', async () => {
  config.allowedUserIds = [ALLOWED];
  const active = { status: () => ({ active: true, terminalId: 42, engine: 'codex', startedAt: 1 }) };
  const i = fakeInteraction(ALLOWED, 'status');
  await commands.handle(i, ctx({ standIn: active, lmStatus: { linked: true, managerId: 999, port: 36319, deliveryTerminalId: 42, standIn: active.status() } }));
  assert.match(i.sent[0], /terminal 42/);
  assert.match(i.sent[0], /Codex/i);

  const idle = { status: () => ({ active: false }) };
  const j = fakeInteraction(ALLOWED, 'status');
  await commands.handle(j, ctx({ standIn: idle }));
  assert.match(j.sent[0], /999/);
});

test('/manager is denied for unauthorized users', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction('1', 'codex');
  let started = false;
  await commands.handle(i, ctx({ standIn: { start: async () => { started = true; }, status: () => ({ active: false }) } }));
  assert.equal(started, false);
  assert.match(i.sent[0], /not authorized/);
});

test('formatStandInStatus is pure and covers both states', () => {
  assert.match(commands.formatStandInStatus({ active: true, terminalId: 42, engine: 'codex' }, 999), /Codex.*terminal 42/);
  assert.match(commands.formatStandInStatus({ active: false }, 999), /999/);
  assert.match(commands.formatStandInStatus(null, 999), /999/);
});
