'use strict';

// T792: his messages from ANY text channel or thread of the guild reach the
// manager, named by source; #claude-voice keeps exactly today's wrapper; and a
// per-channel off switch (stored on disk) stops both forwarding and logging.
//
//   node --test src/channelRouting.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'g1';

const { config } = require('../config');
const { routeInbound, originTag, originMeta } = require('./channelRouting');
const ChannelIgnore = require('./channelIgnore');
const { makeMessageHandler } = require('./inboundText');
const { frameMemo } = require('./controlApi');
const conversationLog = require('./conversationLog');

const ALLOWED = '100000000000000001';
const BOT = 'bot-id';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't792-')), 'channel-ignore.json');
}

function chan(id, name, extra = {}) {
  return { id, name, isTextBased: () => true, isThread: () => false, ...extra };
}
function thread(id, name, parent) {
  return { id, name, parentId: parent.id, parent, isTextBased: () => true, isThread: () => true };
}

const MIRROR = chan('100', 'claude-voice');
const GENERAL = chan('200', 'general');
const PLANS = thread('300', 'weekend plans', GENERAL);
const MIRROR_THREAD = thread('400', 'side topic', MIRROR);

// ---- routing -------------------------------------------------------------

test('#claude-voice → forwarded with NO origin (today\'s wrapper)', () => {
  const r = routeInbound({ channel: MIRROR, mirrorChannelId: '100', ignore: new ChannelIgnore({ file: tmpFile() }) });
  assert.equal(r.forward, true);
  assert.equal(r.origin, null);
});

test('the configured DISCORD_TEXT_CHANNEL_ID also counts as the main channel', () => {
  const r = routeInbound({ channel: GENERAL, mirrorChannelId: null, textChannelId: '200', ignore: new ChannelIgnore({ file: tmpFile() }) });
  assert.equal(r.forward, true);
  assert.equal(r.origin, null);
});

test('any other text channel → forwarded, origin names the channel', () => {
  const r = routeInbound({ channel: GENERAL, mirrorChannelId: '100', ignore: new ChannelIgnore({ file: tmpFile() }) });
  assert.equal(r.forward, true);
  assert.deepEqual(r.origin, { channelId: '200', channelName: 'general' });
});

test('a thread → origin names the thread, its id, and its parent channel', () => {
  const r = routeInbound({ channel: PLANS, mirrorChannelId: '100', ignore: new ChannelIgnore({ file: tmpFile() }) });
  assert.equal(r.forward, true);
  assert.deepEqual(r.origin, { channelId: '200', channelName: 'general', threadId: '300', threadName: 'weekend plans' });
});

test('a thread inside #claude-voice is still named (it is not the main channel)', () => {
  const r = routeInbound({ channel: MIRROR_THREAD, mirrorChannelId: '100', ignore: new ChannelIgnore({ file: tmpFile() }) });
  assert.equal(r.forward, true);
  assert.equal(r.origin.threadId, '400');
  assert.equal(r.origin.channelName, 'claude-voice');
});

test('a non-text channel or a missing channel is not forwarded', () => {
  const ig = new ChannelIgnore({ file: tmpFile() });
  assert.equal(routeInbound({ channel: null, mirrorChannelId: '100', ignore: ig }).forward, false);
  assert.equal(routeInbound({ channel: { id: '9', name: 'vc', isTextBased: () => false }, mirrorChannelId: '100', ignore: ig }).forward, false);
});

test('an ignored channel is not forwarded, and neither are its threads', () => {
  const ig = new ChannelIgnore({ file: tmpFile() });
  assert.equal(ig.ignore('200', 'general').ok, true);
  const r = routeInbound({ channel: GENERAL, mirrorChannelId: '100', ignore: ig });
  assert.equal(r.forward, false);
  assert.equal(r.reason, 'ignored');
  assert.equal(routeInbound({ channel: PLANS, mirrorChannelId: '100', ignore: ig }).forward, false);
});

test('/manager-listen in a thread of an ignored channel overrides the parent for that thread only', () => {
  const ig = new ChannelIgnore({ file: tmpFile() });
  ig.ignore('200', 'general');
  ig.listen('300', 'weekend plans', { parentId: '200' });
  assert.equal(routeInbound({ channel: PLANS, mirrorChannelId: '100', ignore: ig }).forward, true);
  assert.equal(routeInbound({ channel: GENERAL, mirrorChannelId: '100', ignore: ig }).forward, false);
});

// ---- ignore store --------------------------------------------------------

test('ignore state survives a restart (a fresh instance on the same file)', () => {
  const file = tmpFile();
  new ChannelIgnore({ file }).ignore('200', 'general');
  const again = new ChannelIgnore({ file });
  assert.equal(again.isIgnored('200'), true);
  assert.equal(again.isIgnored('999'), false);
  assert.ok(fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).channels['200'].state, 'ignored');
});

test('listen on an ignored channel clears it, and that is persisted too', () => {
  const file = tmpFile();
  const ig = new ChannelIgnore({ file });
  ig.ignore('200', 'general');
  const r = ig.listen('200', 'general');
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(new ChannelIgnore({ file }).isIgnored('200'), false);
});

test('ignoring an already-ignored channel / listening to a listened one reports no change', () => {
  const ig = new ChannelIgnore({ file: tmpFile() });
  assert.equal(ig.ignore('200', 'general').changed, true);
  assert.equal(ig.ignore('200', 'general').changed, false);
  assert.equal(ig.listen('500', 'random').changed, false);
});

test('a protected channel (#claude-voice) cannot be ignored', () => {
  const ig = new ChannelIgnore({ file: tmpFile(), isProtected: (id) => id === '100' });
  const r = ig.ignore('100', 'claude-voice');
  assert.equal(r.ok, false);
  assert.match(r.reason, /claude-voice|main/i);
  assert.equal(ig.isIgnored('100'), false);
});

test('a corrupt state file starts empty instead of crashing the bridge', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const ig = new ChannelIgnore({ file });
  assert.equal(ig.isIgnored('200'), false);
  assert.deepEqual(ig.list(), []);
});

test('list() reports every entry with its state and name', () => {
  const ig = new ChannelIgnore({ file: tmpFile() });
  ig.ignore('200', 'general');
  ig.listen('300', 'weekend plans', { parentId: '200' });
  const rows = ig.list().map((r) => [r.id, r.state, r.name]).sort();
  assert.deepEqual(rows, [['200', 'ignored', 'general'], ['300', 'listening', 'weekend plans']]);
});

// ---- the wrapper ---------------------------------------------------------

test('no origin → the framed memo is byte-identical to today\'s for every source', () => {
  for (const [src, paths] of [['typed', []], ['voice', []], ['file', ['/tmp/a.png']]]) {
    assert.equal(frameMemo('hi there', src, paths, null, null), frameMemo('hi there', src, paths, null));
  }
  assert.equal(frameMemo('hi', 'typed', [], null, null), `${config.typedMemoMarker} "hi"`);
});

test('a channel origin names the channel in the wrapper', () => {
  const out = frameMemo('hi', 'typed', [], null, { channelId: '200', channelName: 'general' });
  assert.match(out, /#general/);
  assert.match(out, /"hi"$/);
  assert.ok(out.startsWith('💬 Typed message from the user (Discord'), out);
});

test('a thread origin names the thread, its id and the parent channel', () => {
  const o = { channelId: '200', channelName: 'general', threadId: '300', threadName: 'weekend plans' };
  const out = frameMemo('hi', 'typed', [], null, o);
  assert.match(out, /thread "weekend plans"/);
  assert.match(out, /300/);
  assert.match(out, /#general/);
  const file = frameMemo('', 'file', ['/tmp/a.png'], null, o);
  assert.match(file, /300/);
  assert.match(file, /\/tmp\/a\.png/);
});

test('originTag is one line even for a thread name with quotes and newlines', () => {
  const tag = originTag({ channelId: '1', channelName: 'x', threadId: '2', threadName: 'a "b"\nc' });
  assert.ok(!/[\r\n]/.test(tag));
  assert.ok(!tag.includes('"b"'));
});

test('originMeta gives the conversation-log fields', () => {
  assert.deepEqual(originMeta(null), null);
  assert.deepEqual(originMeta({ channelId: '200', channelName: 'general', threadId: '300', threadName: 't' }),
    { channel: 'general', channelId: '200', thread: 't', threadId: '300' });
});

// ---- the messageCreate handler, end to end with fakes ---------------------

function fakeMessage({ channel, content = 'hello', author = ALLOWED, id }) {
  const reacts = [];
  return {
    id: id || String(Math.random()),
    guildId: 'g1',
    channelId: channel.id,
    channel,
    content,
    author: { id: author, bot: author === BOT },
    attachments: new Map(),
    reference: null,
    reacts,
    react(e) { reacts.push(e); return Promise.resolve(); },
    reply() { return Promise.resolve(); },
  };
}

function harness({ ignore } = {}) {
  config.allowedUserIds = [ALLOWED];
  config.guildId = 'g1';
  const forwarded = [];
  const linkManager = {
    isLinked: () => true,
    forward: async (text, opts) => { forwarded.push({ text, opts }); return { ok: true }; },
  };
  const handler = makeMessageHandler({
    client: { user: { id: BOT } },
    textMirror: { channel: MIRROR },
    linkManager,
    channelIgnore: ignore || new ChannelIgnore({ file: tmpFile() }),
  });
  return { handler, forwarded };
}

test('handler: #claude-voice message forwards exactly as before (typed, no origin)', async () => {
  const { handler, forwarded } = harness();
  const m = fakeMessage({ channel: MIRROR });
  await handler(m);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].opts.source, 'typed');
  assert.equal(forwarded[0].opts.origin, undefined);
  assert.deepEqual(m.reacts, ['✅']);
});

test('handler: a message in another channel forwards with its origin', async () => {
  const { handler, forwarded } = harness();
  await handler(fakeMessage({ channel: GENERAL }));
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0].opts.origin, { channelId: '200', channelName: 'general' });
});

test('handler: a message in a thread forwards with the thread named', async () => {
  const { handler, forwarded } = harness();
  await handler(fakeMessage({ channel: PLANS }));
  assert.equal(forwarded[0].opts.origin.threadId, '300');
});

test('handler: the bot\'s own messages are still ignored, in any channel', async () => {
  const { handler, forwarded } = harness();
  await handler(fakeMessage({ channel: PLANS, author: BOT }));
  await handler(fakeMessage({ channel: MIRROR, author: BOT }));
  assert.equal(forwarded.length, 0);
});

test('handler: unauthorized users are still ignored', async () => {
  const { handler, forwarded } = harness();
  await handler(fakeMessage({ channel: GENERAL, author: '12345' }));
  assert.equal(forwarded.length, 0);
});

test('handler: an ignored channel is neither forwarded nor logged', async () => {
  const ig = new ChannelIgnore({ file: tmpFile() });
  ig.ignore('200', 'general');
  const rows = [];
  conversationLog.setTransport(async (_url, payload) => { rows.push(payload); return 1; });
  try {
    const { handler, forwarded } = harness({ ignore: ig });
    const m = fakeMessage({ channel: GENERAL });
    await handler(m);
    assert.equal(forwarded.length, 0);
    assert.equal(rows.length, 0);
    assert.deepEqual(m.reacts, [], 'no reaction either — the channel is simply not read');
  } finally {
    conversationLog.resetTransport();
  }
});

test('handler: a duplicate gateway event is dropped (dedupe kept)', async () => {
  const { handler, forwarded } = harness();
  const m = fakeMessage({ channel: GENERAL, id: 'dup-1' });
  await handler(m);
  await handler(m);
  assert.equal(forwarded.length, 1);
});

// ---- conversation log meta ----------------------------------------------

test('linkManager.forward puts the origin in the conversation log meta (and not for #claude-voice)', async () => {
  const LinkManager = require('./linkManager');
  const rows = [];
  conversationLog.setTransport(async (_url, payload) => { rows.push(payload); return 1; });
  const prev = config.conversationLogEnabled;
  config.conversationLogEnabled = true;
  try {
    const lm = new LinkManager(); // unlinked: logs first, then refuses delivery
    await lm.forward('in a thread', { source: 'typed', origin: { channelId: '200', channelName: 'general', threadId: '300', threadName: 'weekend plans' } });
    await lm.forward('in main', { source: 'typed' });
    await new Promise((r) => setImmediate(r));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].meta.channel, 'general');
    assert.equal(rows[0].meta.threadId, '300');
    assert.equal(rows[0].meta.thread, 'weekend plans');
    assert.equal(rows[1].meta.channel, undefined);
    assert.equal(rows[1].meta.threadId, undefined);
  } finally {
    config.conversationLogEnabled = prev;
    conversationLog.resetTransport();
  }
});
