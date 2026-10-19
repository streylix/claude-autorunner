'use strict';

// T792: /manager-ignore, /manager-listen, /manager-channels — the per-channel
// off switch for the manager reading his messages.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'test-guild';

const commands = require('./commands');
const { config } = require('../config');
const ChannelIgnore = require('./channelIgnore');

const ALLOWED = '100000000000000001';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't792c-')), 'channel-ignore.json');
}

const MIRROR = { id: '100', name: 'claude-voice', isThread: () => false };
const GENERAL = { id: '200', name: 'general', isThread: () => false };
const PLANS = { id: '300', name: 'weekend plans', parentId: '200', isThread: () => true, joinable: false };

function fakeInteraction(commandName, channel, userId = ALLOWED) {
  const sent = [];
  return {
    sent, commandName, channel, channelId: channel.id,
    isChatInputCommand: () => true,
    user: { id: userId, tag: 'someone#0001' },
    deferred: false, replied: false,
    options: { getSubcommand: () => null, getString: () => null, getInteger: () => null, getAttachment: () => null },
    async deferReply() { this.deferred = true; },
    async reply(p) { this.replied = true; sent.push(p.content ?? p); },
    async editReply(p) { sent.push(p.content ?? p); },
  };
}

function ctx(file) {
  const textMirror = { channel: MIRROR };
  const channelIgnore = new ChannelIgnore({ file, isProtected: (id) => id === textMirror.channel.id });
  return { linkManager: { isLinked: () => true }, session: {}, textMirror, channelIgnore };
}

test('the three commands are registered', () => {
  const names = commands.definitions.map((d) => d.name);
  for (const n of ['manager-ignore', 'manager-listen', 'manager-channels']) assert.ok(names.includes(n), n);
});

test('/manager-ignore in a channel ignores it and persists it', async () => {
  config.allowedUserIds = [ALLOWED];
  const file = tmpFile();
  const c = ctx(file);
  const i = fakeInteraction('manager-ignore', GENERAL);
  await commands.handle(i, c);
  assert.equal(c.channelIgnore.isIgnored('200'), true);
  assert.equal(new ChannelIgnore({ file }).isIgnored('200'), true);
  assert.match(i.sent[0], /general/);
});

test('/manager-ignore in #claude-voice is refused with a message', async () => {
  config.allowedUserIds = [ALLOWED];
  const c = ctx(tmpFile());
  const i = fakeInteraction('manager-ignore', MIRROR);
  await commands.handle(i, c);
  assert.equal(c.channelIgnore.isIgnored('100'), false);
  assert.match(i.sent[0], /can't|cannot|refus/i);
});

test('/manager-listen undoes it', async () => {
  config.allowedUserIds = [ALLOWED];
  const c = ctx(tmpFile());
  await commands.handle(fakeInteraction('manager-ignore', GENERAL), c);
  const i = fakeInteraction('manager-listen', GENERAL);
  await commands.handle(i, c);
  assert.equal(c.channelIgnore.isIgnored('200'), false);
  assert.match(i.sent[0], /general/);
});

test('/manager-ignore works inside a thread, keyed by the thread id', async () => {
  config.allowedUserIds = [ALLOWED];
  const c = ctx(tmpFile());
  await commands.handle(fakeInteraction('manager-ignore', PLANS), c);
  assert.equal(c.channelIgnore.isIgnored('300'), true);
  assert.equal(c.channelIgnore.isIgnored('200'), false);
});

test('/manager-channels lists the ignored channels', async () => {
  config.allowedUserIds = [ALLOWED];
  const c = ctx(tmpFile());
  await commands.handle(fakeInteraction('manager-ignore', GENERAL), c);
  const i = fakeInteraction('manager-channels', MIRROR);
  await commands.handle(i, c);
  assert.match(i.sent[0], /200/);
  assert.match(i.sent[0], /ignor/i);
});

test('/manager-channels with nothing ignored says the manager reads everywhere', async () => {
  config.allowedUserIds = [ALLOWED];
  const i = fakeInteraction('manager-channels', MIRROR);
  await commands.handle(i, ctx(tmpFile()));
  assert.match(i.sent[0], /every|all/i);
});

test('unauthorized users cannot flip the switch', async () => {
  config.allowedUserIds = [ALLOWED];
  const c = ctx(tmpFile());
  await commands.handle(fakeInteraction('manager-ignore', GENERAL, '555'), c);
  assert.equal(c.channelIgnore.isIgnored('200'), false);
});
