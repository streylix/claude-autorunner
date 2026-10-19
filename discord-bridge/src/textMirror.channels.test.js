'use strict';

// The per-channel posting path: --channel on the post-* tools becomes
// desc.channel, which becomes textMirror.channelFor(name). What matters is that
// it (a) leaves the DEFAULT path untouched, (b) creates a named channel once and
// reuses it, and (c) falls back to the default LOUDLY instead of dropping a post.

const test = require('node:test');
const assert = require('node:assert');
const { ChannelType, PermissionsBitField } = require('discord.js');
const { config } = require('../config');
const TextMirror = require('./textMirror');

// discord.js hands us a Collection (a Map with .find); a plain Map has no .find.
class Cache extends Map {
  find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; }
}

function fakeChannel(name, guild) {
  return {
    id: `id-${name}`, name, guild, guildId: guild.id, parentId: null,
    type: ChannelType.GuildText, isTextBased: () => true,
    sent: [], typing: 0,
    send(payload) { this.sent.push(payload); return Promise.resolve({ id: 'msg' }); },
    sendTyping() { this.typing += 1; return Promise.resolve(); },
  };
}

// canManage:false models the real failure mode — the bot without Manage Channels.
function fakeGuild({ names = [], canManage = true } = {}) {
  const guild = { id: 'g1', channels: null, members: null, created: [] };
  const cache = new Cache();
  guild.channels = {
    cache,
    fetch: async () => cache,
    create: async (opts) => {
      if (!canManage) throw new Error('Missing Permissions');
      const ch = fakeChannel(opts.name, guild);
      cache.set(ch.id, ch);
      guild.created.push(opts.name);
      return ch;
    },
  };
  guild.members = { me: { permissions: { has: (f) => (f === PermissionsBitField.Flags.ManageChannels ? canManage : true) } } };
  for (const n of names) { const ch = fakeChannel(n, guild); cache.set(ch.id, ch); }
  return guild;
}

function mirrorOn(guild, defaultName = 'claude-voice') {
  const tm = new TextMirror();
  tm.channel = guild.channels.cache.find((c) => c.name === defaultName);
  return tm;
}

test('no channel requested → the default mirror channel, untouched', async () => {
  const guild = fakeGuild({ names: ['claude-voice'] });
  const tm = mirrorOn(guild);
  const t = await tm.channelFor(undefined);
  assert.equal(t.channel, tm.channel);
  assert.equal(t.fallback, false);
  assert.deepEqual(guild.created, [], 'never creates a channel for a default post');
});

test('a named channel is created once and reused after', async () => {
  const guild = fakeGuild({ names: ['claude-voice'] });
  const tm = mirrorOn(guild);

  const first = await tm.channelFor('rma-drafts');
  assert.equal(first.name, 'rma-drafts');
  assert.equal(first.fallback, false);
  assert.deepEqual(guild.created, ['rma-drafts']);

  const second = await tm.channelFor('RMA Drafts'); // same channel, messier name
  assert.equal(second.channel, first.channel, 'reuses the cached channel');
  assert.deepEqual(guild.created, ['rma-drafts'], 'no duplicate channel');
});

test('concurrent posts to a new channel create it only once', async () => {
  const guild = fakeGuild({ names: ['claude-voice'] });
  const tm = mirrorOn(guild);
  const [a, b, c] = await Promise.all([
    tm.channelFor('rma-drafts'), tm.channelFor('rma-drafts'), tm.channelFor('rma-drafts'),
  ]);
  assert.deepEqual(guild.created, ['rma-drafts']);
  assert.equal(a.channel, b.channel);
  assert.equal(b.channel, c.channel);
});

test('an existing channel is found, not re-created', async () => {
  const guild = fakeGuild({ names: ['claude-voice', 'rma-drafts'] });
  const tm = mirrorOn(guild);
  const t = await tm.channelFor('rma-drafts');
  assert.equal(t.name, 'rma-drafts');
  assert.deepEqual(guild.created, []);
});

test('asking for the default channel by name is not a fallback', async () => {
  const guild = fakeGuild({ names: ['claude-voice'] });
  const tm = mirrorOn(guild);
  const t = await tm.channelFor('claude-voice');
  assert.equal(t.channel, tm.channel);
  assert.equal(t.fallback, false);
});

test('NO Manage Channels → falls back to the default WITH a reason', async () => {
  const guild = fakeGuild({ names: ['claude-voice'], canManage: false });
  const tm = mirrorOn(guild);
  const t = await tm.channelFor('rma-drafts');
  assert.equal(t.channel, tm.channel, 'the post still goes somewhere');
  assert.equal(t.fallback, true);
  assert.equal(t.requested, 'rma-drafts');
  assert.match(t.reason, /Manage Channels/, 'the reason is reportable to a human');
});

test('an unusable channel name falls back rather than dropping the post', async () => {
  const guild = fakeGuild({ names: ['claude-voice'] });
  const tm = mirrorOn(guild);
  const t = await tm.channelFor('!!!');
  assert.equal(t.channel, tm.channel);
  assert.equal(t.fallback, true);
  assert.ok(t.reason);
});

test('posts land in the requested channel, and default posts still land in the default', async () => {
  const guild = fakeGuild({ names: ['claude-voice'] });
  const tm = mirrorOn(guild);
  const target = (await tm.channelFor('rma-drafts')).channel;

  assert.equal(await tm.postText('draft v1', { channel: target }), true);
  assert.equal(target.sent.length, 1);
  assert.equal(target.sent[0].content, 'draft v1');
  assert.equal(tm.channel.sent.length, 0, 'nothing leaked into the default channel');

  assert.equal(await tm.postText('to the usual place'), true);
  assert.equal(tm.channel.sent.length, 1);
  assert.equal(tm.channel.sent[0].content, 'to the usual place');
  assert.equal(target.sent.length, 1);
});

test('the existing 2000-char chunking is unchanged by channel routing', async () => {
  const guild = fakeGuild({ names: ['claude-voice'] });
  const tm = mirrorOn(guild);
  const body = 'x'.repeat(4500);
  assert.equal(await tm.postText(body), true);
  assert.equal(tm.channel.sent.length, 3);
  assert.equal(tm.channel.sent.map((m) => m.content).join(''), body, 'nothing lost');
});

test('a deleted named channel is re-created instead of posting into a dead id', async () => {
  const guild = fakeGuild({ names: ['claude-voice'] });
  const tm = mirrorOn(guild);
  const first = (await tm.channelFor('rma-drafts')).channel;
  guild.channels.cache.delete(first.id); // channel deleted in Discord
  const again = await tm.channelFor('rma-drafts');
  assert.notEqual(again.channel, first);
  assert.deepEqual(guild.created, ['rma-drafts', 'rma-drafts']);
});

test('with no mirror channel at all, nothing pretends to have posted', async () => {
  const tm = new TextMirror();
  const t = await tm.channelFor('rma-drafts');
  assert.equal(t.channel, null);
  assert.ok(t.reason);
  assert.equal(await tm.postText('nowhere to go'), false);
});

test('postFile refuses a non-text file and an oversized one rather than posting it', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const guild = fakeGuild({ names: ['claude-voice'] });
  const tm = mirrorOn(guild);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbot-file-test-'));

  const binary = path.join(dir, 'shot.png');
  fs.writeFileSync(binary, 'not really a png');
  assert.equal(await tm.postFile(binary, 'nope'), false);

  const empty = path.join(dir, 'empty.md');
  fs.writeFileSync(empty, '');
  assert.equal(await tm.postFile(empty), false);

  const big = path.join(dir, 'big.md');
  fs.writeFileSync(big, 'y'.repeat(config.textFileMaxBytes + 10));
  assert.equal(await tm.postFile(big), false, 'oversized is refused, never truncated');

  const ok = path.join(dir, 'draft.md');
  fs.writeFileSync(ok, '# RMA letter\n\nDear WD,\n');
  assert.equal(await tm.postFile(ok, 'draft v1'), true);
  assert.equal(tm.channel.sent.length, 1);
  assert.equal(tm.channel.sent[0].files.length, 1);
  assert.equal(tm.channel.sent[0].content, 'draft v1');

  fs.rmSync(dir, { recursive: true, force: true });
});
