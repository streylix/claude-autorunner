'use strict';

// T796: --new-thread "<name>" on the post-* tools. The bridge creates a public
// thread with that name in the parent (--channel, default #claude-voice), or
// REUSES an active thread of the same name in that parent, posts into it, joins
// it, and reports the thread id. A missing permission or an unusable parent
// fails LOUDLY — it never quietly posts to #claude-voice instead.

const test = require('node:test');
const assert = require('node:assert');
const { ChannelType, PermissionsBitField } = require('discord.js');
const TextMirror = require('./textMirror');
const ImageOutbox = require('./imageOutbox');
const { parseFlags } = require('../tools/postCommon');

const F = PermissionsBitField.Flags;

class Cache extends Map {
  find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; }
}

let nextId = 500000000000000000n;
const snow = () => String(nextId++);

function fakeThread(name, parent) {
  return {
    id: snow(), name, parentId: parent.id, parent, guild: parent.guild, guildId: parent.guild.id,
    type: ChannelType.PublicThread, archived: false, joined: false, joinable: true, joins: 0,
    isTextBased: () => true, isThread: () => true, sent: [],
    send(p) { this.sent.push(p); return Promise.resolve({ id: 'm' }); },
    join() { this.joins += 1; this.joined = true; return Promise.resolve(this); },
    sendTyping() { return Promise.resolve(); },
  };
}

function fakeTextChannel(id, name, guild, perms) {
  const ch = {
    id, name, guild, guildId: guild.id, parentId: null, type: ChannelType.GuildText,
    isTextBased: () => true, isThread: () => false, sent: [], created: [],
    send(p) { this.sent.push(p); return Promise.resolve({ id: 'm' }); },
    sendTyping() { return Promise.resolve(); },
    permissionsFor: () => ({ has: (flag) => perms.has(flag) }),
  };
  const active = new Map();
  ch.threads = {
    _active: active,
    fetchActive: async () => ({ threads: new Map(active) }),
    create: async (opts) => {
      if (!perms.has(F.CreatePublicThreads)) { const e = new Error('Missing Permissions'); e.code = 50013; throw e; }
      const t = fakeThread(opts.name, ch);
      t.joined = true; // Discord adds the creator as a member
      active.set(t.id, t);
      ch.created.push(opts);
      return t;
    },
  };
  return ch;
}

function setup({ perms = [F.CreatePublicThreads, F.SendMessagesInThreads, F.SendMessages, F.ViewChannel] } = {}) {
  const set = new Set(perms);
  const guild = { id: 'g1' };
  const cache = new Cache();
  guild.members = { me: { id: 'bot', permissions: { has: () => true } } };
  guild.channels = {
    cache,
    fetch: async (id) => {
      if (id === undefined) return cache;
      if (cache.has(id)) return cache.get(id);
      for (const c of cache.values()) if (c.threads && c.threads._active.has(id)) return c.threads._active.get(id);
      const e = new Error('Unknown Channel'); e.code = 10003; throw e;
    },
    create: async (opts) => { const c = fakeTextChannel(snow(), opts.name, guild, set); cache.set(c.id, c); return c; },
  };
  const mirror = fakeTextChannel('111111111111111111', 'claude-voice', guild, set);
  const general = fakeTextChannel('222222222222222222', 'general', guild, set);
  cache.set(mirror.id, mirror); cache.set(general.id, general);
  const tm = new TextMirror();
  tm.channel = mirror;
  tm._logOut = () => {};
  return { tm, mirror, general, guild, outbox: new ImageOutbox({ textMirror: tm }) };
}

// ---- create ----------------------------------------------------------------

test('create: no thread of that name → a public thread is created in #claude-voice and posted into', async () => {
  const { mirror, outbox } = setup();
  const r = await outbox._deliver({ text: 'hello thread', newThread: 't796-test' }, 'a.json');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.created, true);
  assert.equal(mirror.created.length, 1);
  assert.equal(mirror.created[0].name, 't796-test');
  assert.equal(mirror.created[0].type, ChannelType.PublicThread);
  const t = [...mirror.threads._active.values()][0];
  assert.equal(r.threadId, t.id);
  assert.equal(r.threadName, 't796-test');
  assert.equal(r.parent, 'claude-voice');
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].content, 'hello thread');
  assert.equal(mirror.sent.length, 0, 'nothing lands in the parent itself');
});

test('create: the thread name keeps its spelling (threads are not channel-name sanitised)', async () => {
  const { mirror, outbox } = setup();
  const r = await outbox._deliver({ text: 'x', newThread: '  Weekend Plans  ' }, 'a.json');
  assert.equal(r.ok, true);
  assert.equal(mirror.created[0].name, 'Weekend Plans');
});

test('create: an empty thread name is refused', async () => {
  const { mirror, outbox } = setup();
  const r = await outbox._deliver({ text: 'x', newThread: '   ' }, 'a.json');
  assert.equal(r.ok, false);
  assert.equal(mirror.sent.length, 0);
});

// ---- reuse by name ---------------------------------------------------------

test('reuse: an active thread of the same name in that parent is reused, not duplicated', async () => {
  const { mirror, outbox } = setup();
  const first = await outbox._deliver({ text: 'one', newThread: 't796-test' }, 'a.json');
  const second = await outbox._deliver({ text: 'two', newThread: 't796-test' }, 'b.json');
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.threadId, first.threadId);
  assert.equal(mirror.created.length, 1);
  const t = mirror.threads._active.get(first.threadId);
  assert.deepEqual(t.sent.map((s) => s.content), ['one', 'two']);
});

test('reuse: a thread the bot is not in yet is JOINED so his replies reach the manager', async () => {
  const { mirror, outbox } = setup();
  const t = fakeThread('his thread', mirror);
  mirror.threads._active.set(t.id, t);
  const r = await outbox._deliver({ text: 'hi', newThread: 'his thread' }, 'a.json');
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.equal(r.threadId, t.id);
  assert.equal(t.joins, 1);
});

test('reuse: a same-named thread in a DIFFERENT parent is not reused', async () => {
  const { mirror, general, outbox } = setup();
  const other = fakeThread('t796-test', general);
  general.threads._active.set(other.id, other);
  const r = await outbox._deliver({ text: 'x', newThread: 't796-test' }, 'a.json');
  assert.equal(r.created, true);
  assert.notEqual(r.threadId, other.id);
  assert.equal(mirror.created.length, 1);
});

test('reuse: two quick posts with a new name create the thread only once', async () => {
  const { mirror, tm } = setup();
  const [a, b] = await Promise.all([tm.threadFor(undefined, 'race'), tm.threadFor(undefined, 'race')]);
  assert.equal(a.channel, b.channel);
  assert.equal(mirror.created.length, 1);
});

// ---- parent resolution -----------------------------------------------------

test('parent: --channel by NAME puts the thread in that channel', async () => {
  const { general, mirror, outbox } = setup();
  const r = await outbox._deliver({ text: 'x', newThread: 'plans', channel: 'general' }, 'a.json');
  assert.equal(r.ok, true);
  assert.equal(r.parent, 'general');
  assert.equal(general.created.length, 1);
  assert.equal(mirror.created.length, 0);
});

test('parent: --channel by ID puts the thread in that channel', async () => {
  const { general, outbox } = setup();
  const r = await outbox._deliver({ text: 'x', newThread: 'plans', channel: '222222222222222222' }, 'a.json');
  assert.equal(r.ok, true);
  assert.equal(r.parent, 'general');
  assert.equal(general.created.length, 1);
});

test('parent: an unknown id FAILS loudly — no thread, nothing posted to #claude-voice', async () => {
  const { mirror, outbox } = setup();
  const r = await outbox._deliver({ text: 'x', newThread: 'plans', channel: '999999999999999999' }, 'a.json');
  assert.equal(r.ok, false);
  assert.match(r.reason, /999999999999999999/);
  assert.equal(mirror.sent.length, 0);
  assert.equal(mirror.created.length, 0);
});

test('parent: a THREAD as the parent is refused (threads cannot hold threads)', async () => {
  const { mirror, outbox } = setup();
  const t = fakeThread('existing', mirror);
  mirror.threads._active.set(t.id, t);
  const r = await outbox._deliver({ text: 'x', newThread: 'inner', channel: t.id }, 'a.json');
  assert.equal(r.ok, false);
  assert.match(r.reason, /thread/i);
  assert.equal(t.sent.length, 0);
  assert.equal(mirror.sent.length, 0);
});

// ---- permissions -----------------------------------------------------------

test('permissions: missing Create Public Threads → fails naming that permission, posts nowhere', async () => {
  const { mirror, outbox } = setup({ perms: [F.SendMessagesInThreads, F.SendMessages, F.ViewChannel] });
  const r = await outbox._deliver({ text: 'x', newThread: 'plans' }, 'a.json');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Create Public Threads/);
  assert.equal(mirror.sent.length, 0);
});

test('permissions: missing Send Messages in Threads → fails naming that permission', async () => {
  const { mirror, outbox } = setup({ perms: [F.CreatePublicThreads, F.SendMessages, F.ViewChannel] });
  const r = await outbox._deliver({ text: 'x', newThread: 'plans' }, 'a.json');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Send Messages in Threads/);
  assert.equal(mirror.sent.length, 0);
  assert.equal(mirror.created.length, 0, 'checked BEFORE creating an empty thread');
});

// ---- other kinds and the CLI flag -----------------------------------------

test('a FILE descriptor with newThread lands in the thread too', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't796-'));
  const f = path.join(dir, 'note.md'); fs.writeFileSync(f, '# hi\n');
  const prev = process.env.CCBOT_MEDIA_ROOTS; process.env.CCBOT_MEDIA_ROOTS = dir;
  try {
    const { mirror, outbox } = setup();
    const r = await outbox._deliver({ file: f, newThread: 'files' }, 'a.json');
    assert.equal(r.ok, true, r.reason);
    const t = [...mirror.threads._active.values()][0];
    assert.equal(t.sent.length, 1);
    assert.ok(t.sent[0].files);
  } finally { if (prev === undefined) delete process.env.CCBOT_MEDIA_ROOTS; else process.env.CCBOT_MEDIA_ROOTS = prev; }
});

test('CLI: --new-thread "<name>" and --new-thread=<name> are parsed, alongside --channel', () => {
  const a = parseFlags(['--new-thread', 'Weekend Plans', '--channel', 'general', 'hello', 'there']);
  assert.equal(a.newThread, 'Weekend Plans');
  assert.equal(a.channel, 'general');
  assert.deepEqual(a.rest, ['hello', 'there']);
  const b = parseFlags(['--new-thread=plans', 'hi']);
  assert.equal(b.newThread, 'plans');
  assert.equal(b.channel, null);
  assert.equal(parseFlags(['hi']).newThread, null);
});
