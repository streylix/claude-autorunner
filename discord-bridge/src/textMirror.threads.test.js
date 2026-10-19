'use strict';

// T792 outbound: --channel accepts a channel or THREAD id as well as a name, so
// TELL_CHANNEL=<thread id> bin/tell replies inside the thread. Names keep
// today's resolve-or-create behaviour; an unknown id never creates a channel.

const test = require('node:test');
const assert = require('node:assert');
const { ChannelType, PermissionsBitField } = require('discord.js');
const TextMirror = require('./textMirror');
const ImageOutbox = require('./imageOutbox');

class Cache extends Map {
  find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; }
}

function fakeChannel(id, name, guild, type = ChannelType.GuildText) {
  return {
    id, name, guild, guildId: guild.id, parentId: null, type,
    isTextBased: () => true, isThread: () => type === ChannelType.PublicThread,
    sent: [],
    send(payload) { this.sent.push(payload); return Promise.resolve({ id: 'msg' }); },
    sendTyping() { return Promise.resolve(); },
  };
}

// Threads live OUTSIDE guild.channels.cache (discord.js keeps them on the
// parent), but guild.channels.fetch(id) returns them — that is the real shape.
function fakeGuild() {
  const guild = { id: 'g1', created: [], fetchedIds: [] };
  const cache = new Cache();
  const threads = new Map();
  guild.channels = {
    cache,
    fetch: async (id) => {
      if (id === undefined) return cache;
      guild.fetchedIds.push(id);
      if (cache.has(id)) return cache.get(id);
      if (threads.has(id)) return threads.get(id);
      const e = new Error('Unknown Channel'); e.code = 10003; throw e;
    },
    create: async (opts) => {
      const ch = fakeChannel(`id-${opts.name}`, opts.name, guild);
      cache.set(ch.id, ch); guild.created.push(opts.name); return ch;
    },
  };
  guild.members = { me: { permissions: { has: () => true } } };
  const mirror = fakeChannel('111111111111111111', 'claude-voice', guild);
  cache.set(mirror.id, mirror);
  const general = fakeChannel('222222222222222222', 'general', guild);
  cache.set(general.id, general);
  const t = fakeChannel('333333333333333333', 'weekend plans', guild, ChannelType.PublicThread);
  t.parentId = general.id;
  threads.set(t.id, t);
  return { guild, mirror, general, thread: t };
}

function mirrorOn(g) { const tm = new TextMirror(); tm.channel = g.mirror; return tm; }

test('a THREAD id resolves to that thread — nothing is created', async () => {
  const g = fakeGuild();
  const tm = mirrorOn(g);
  const t = await tm.channelFor('333333333333333333');
  assert.equal(t.channel, g.thread);
  assert.equal(t.fallback, false);
  assert.deepEqual(g.guild.created, []);
});

test('a channel id resolves to that channel', async () => {
  const g = fakeGuild();
  const t = await mirrorOn(g).channelFor('222222222222222222');
  assert.equal(t.channel, g.general);
  assert.equal(t.fallback, false);
});

test('the main channel\'s own id is the main channel', async () => {
  const g = fakeGuild();
  const tm = mirrorOn(g);
  const t = await tm.channelFor('111111111111111111');
  assert.equal(t.channel, g.mirror);
  assert.equal(t.fallback, false);
});

test('an unknown id falls back LOUDLY and never creates a channel named after it', async () => {
  const g = fakeGuild();
  const t = await mirrorOn(g).channelFor('444444444444444444');
  assert.equal(t.fallback, true);
  assert.equal(t.channel, g.mirror);
  assert.match(t.reason, /444444444444444444/);
  assert.deepEqual(g.guild.created, []);
});

test('an unknown NAME still creates the channel, as today', async () => {
  const g = fakeGuild();
  const t = await mirrorOn(g).channelFor('t792-test');
  assert.equal(t.fallback, false);
  assert.deepEqual(g.guild.created, ['t792-test']);
});

test('the outbox delivers a text descriptor with a thread id INTO the thread', async () => {
  const g = fakeGuild();
  const tm = mirrorOn(g);
  tm._logOut = () => {};
  const ob = new ImageOutbox({ textMirror: tm });
  const r = await ob._deliver({ text: 'reply in thread', channel: '333333333333333333' }, 'x.json');
  assert.equal(r.ok, true);
  assert.equal(r.fallback, false);
  assert.equal(g.thread.sent.length, 1);
  assert.equal(g.thread.sent[0].content, 'reply in thread');
  assert.equal(g.mirror.sent.length, 0);
});
