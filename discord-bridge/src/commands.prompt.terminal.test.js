'use strict';

// Tests for /prompt's optional `terminal` option (default 999, unchanged
// behaviour when omitted). A non-999 id is validated against a fresh /state
// read and refused if unknown; nothing is queued on refusal. Run:
//   node --test src/commands.prompt.terminal.test.js

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'test-guild';

const commands = require('./commands');
const { definitions } = require('./commands');
const { config } = require('../config');

test('/prompt is registered with an optional integer terminal option', () => {
  const d = definitions.find((x) => x.name === 'prompt');
  const byName = Object.fromEntries(d.options.map((o) => [o.name, o]));
  assert.ok(byName.terminal, '/prompt must have a terminal option');
  assert.ok(!byName.terminal.required, 'terminal must be optional');
});

function fakeInteraction(userId, opts = {}) {
  const sent = [];
  const strings = opts.strings || {};
  const ints = opts.ints || {};
  return {
    sent,
    isChatInputCommand: () => true,
    commandName: 'prompt',
    user: { id: userId, tag: 'someone#0001' },
    deferred: false,
    replied: false,
    options: {
      getString: (n) => (n in strings ? strings[n] : null),
      getInteger: (n) => (n in ints ? ints[n] : null),
      getAttachment: () => null,
    },
    async deferReply() { this.deferred = true; },
    async reply(p) { this.replied = true; sent.push(p.content ?? p); },
    async editReply(p) { sent.push(p.content ?? p); },
  };
}

const ALLOWED = '100000000000000001';

test('/prompt with no terminal option still forwards to 999 unchanged', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, { strings: { text: 'hi' } });
  const calls = [];
  await commands.handle(i, {
    linkManager: {
      isLinked: () => true,
      forward: async (text, opts) => { calls.push(['forward', text, opts]); return { ok: true }; },
      queueToTerminal: async () => { throw new Error('must not be called for 999'); },
    },
    session: {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'forward');
  assert.match(i.sent[0], /Sent to the manager/);
});

test('/prompt with terminal:999 explicit still forwards, not queues (no /state read needed)', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, { strings: { text: 'hi' }, ints: { terminal: 999 } });
  const calls = [];
  await commands.handle(i, {
    linkManager: {
      isLinked: () => true,
      forward: async () => { calls.push('forward'); return { ok: true }; },
      queueToTerminal: async () => { calls.push('queue'); return { ok: true }; },
      listTerminals: async () => { calls.push('listTerminals'); return [{ id: 999, title: 'Manager', status: '...' }]; },
    },
    session: {},
  });
  assert.deepEqual(calls, ['forward']);
});

test('/prompt with a valid non-999 terminal queues to it instead of forwarding to the manager', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, { strings: { text: 'hello terminal 4' }, ints: { terminal: 4 } });
  const calls = [];
  await commands.handle(i, {
    linkManager: {
      isLinked: () => true,
      listTerminals: async () => [
        { id: 4, title: 'jade', status: 'running' },
        { id: 999, title: 'Manager', status: '...' },
      ],
      forward: async () => { throw new Error('must not be called for a non-999 terminal'); },
      queueToTerminal: async (terminalId, text, opts) => { calls.push([terminalId, text, opts]); return { ok: true }; },
    },
    session: {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 4);
  assert.equal(calls[0][1], 'hello terminal 4');
  assert.match(i.sent[0], /Sent to terminal 4/);
});

test('/prompt with an unknown terminal id is refused, lists valid ids, and nothing is queued', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, { strings: { text: 'hello' }, ints: { terminal: 777 } });
  let queued = false;
  await commands.handle(i, {
    linkManager: {
      isLinked: () => true,
      listTerminals: async () => [
        { id: 4, title: 'jade', status: 'running' },
        { id: 999, title: 'Manager', status: '...' },
      ],
      forward: async () => { throw new Error('must not be called'); },
      queueToTerminal: async () => { queued = true; return { ok: true }; },
    },
    session: {},
  });
  assert.equal(queued, false, 'nothing may be queued when the terminal id is unknown');
  assert.match(i.sent[0], /Unknown terminal 777/);
  assert.match(i.sent[0], /4, 999/);
});

test('/prompt terminal validation failure (control API error) is reported, not thrown, and nothing is queued', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, { strings: { text: 'hi' }, ints: { terminal: 4 } });
  let queued = false;
  await commands.handle(i, {
    linkManager: {
      isLinked: () => true,
      listTerminals: async () => { throw new Error('control API unreachable'); },
      queueToTerminal: async () => { queued = true; return { ok: true }; },
    },
    session: {},
  });
  assert.equal(queued, false);
  assert.match(i.sent[0], /Couldn't validate terminal 4/);
});

test('/prompt still requires text and/or media regardless of terminal option', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction(ALLOWED, { ints: { terminal: 4 } });
  await commands.handle(i, {
    linkManager: { isLinked: () => true },
    session: {},
  });
  assert.match(i.sent[0], /Give me some text/);
});
