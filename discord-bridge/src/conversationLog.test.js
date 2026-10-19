'use strict';

// Durable conversation log — bridge side.
//
// The load-bearing test here is "a backend outage must not break delivery"
// (acceptance criterion 5): with the backend stubbed to fail, the Discord post
// still goes out and the manager still receives the forwarded message.

const test = require('node:test');
const assert = require('node:assert');

const { config } = require('../config');

// Stub controlApi BEFORE linkManager destructures it at require time.
const controlApiPath = require.resolve('./controlApi');
const delivered = [];
require.cache[controlApiPath] = {
  id: controlApiPath,
  filename: controlApiPath,
  loaded: true,
  exports: {
    checkState: async () => ({ managerPresent: true, managerStatus: 'idle' }),
    sendVoiceMemo: async (target, text, opts) => { delivered.push({ text, opts }); return { ok: true }; },
    getScreen: async () => ({ screen: '' }),
  },
};

const conversationLog = require('./conversationLog');
const LinkManager = require('./linkManager');
const TextMirror = require('./textMirror');

const realFetch = global.fetch;

// Tests observe the logger by INJECTING a transport, never by stubbing global
// fetch. That is what makes it impossible for this suite to reach the real
// backend: the module's default transport under the runner is a sink, and
// these stubs replace it with an in-memory recorder.
//
// mode: 'ok' | 'reject' | '500' | 'hang'
function stubBackend(mode) {
  const posted = [];
  conversationLog.setTransport(async (url, body) => {
    posted.push({ url, body });
    if (mode === 'reject') throw new Error('ECONNREFUSED: backend is down');
    if (mode === '500') return null;              // transport reports failure as null
    if (mode === 'hang') return new Promise(() => {});
    return posted.length;
  });
  return posted;
}

function restore() {
  global.fetch = realFetch;
  conversationLog.resetTransport();
}

function fakeChannel() {
  const sent = [];
  return { channel: { name: 'claude-voice', send: async (m) => { sent.push(m); }, sendTyping: async () => {} }, sent };
}

test.beforeEach(() => { delivered.length = 0; config.conversationLogEnabled = true; config.textMirrorEnabled = true; });
test.afterEach(() => restore());

// ---------------------------------------------------------------- shape ----

test('recordInbound posts an inbound discord row and returns the new id', async () => {
  const posted = stubBackend('ok');
  const id = await conversationLog.recordInbound({ text: 'hi', kind: 'text', meta: { source: 'typed' } });
  assert.equal(id, 1);
  assert.equal(posted.length, 1);
  assert.match(posted[0].url, /\/api\/conversation\/messages\/$/);
  assert.equal(posted[0].body.direction, 'inbound');
  assert.equal(posted[0].body.destination, 'discord');
  assert.equal(posted[0].body.kind, 'text');
  assert.equal(posted[0].body.text, 'hi');
  assert.equal(posted[0].body.meta.source, 'typed');
});

test('recordOutbound carries media paths', async () => {
  const posted = stubBackend('ok');
  await conversationLog.recordOutbound({ kind: 'image', text: 'cap', paths: ['/tmp/a.png', '/tmp/b.png'] });
  assert.equal(posted[0].body.direction, 'outbound');
  assert.equal(posted[0].body.media_path, '/tmp/a.png');
  assert.deepEqual(posted[0].body.meta.media_paths, ['/tmp/a.png', '/tmp/b.png']);
});

test('kindForSource maps linkManager sources onto log kinds', () => {
  assert.equal(conversationLog.kindForSource('typed'), 'text');
  assert.equal(conversationLog.kindForSource('voice'), 'voice');
  assert.equal(conversationLog.kindForSource(undefined), 'voice');
  assert.equal(conversationLog.kindForSource('file', ['/tmp/x.png']), 'file');
});

test('logging is skippable via config without throwing', async () => {
  const posted = stubBackend('ok');
  config.conversationLogEnabled = false;
  assert.equal(await conversationLog.recordInbound({ text: 'nope' }), null);
  assert.equal(posted.length, 0);
});

// ------------------------------------- the suite must not touch production ----

test('under the test runner, logging is OFF unless a test opts in', async () => {
  // This is the guard that stops `npm test` writing fixtures into the live
  // conversation table. It regressed once already: an existing typing test
  // calls postText('manager reply') with a fake channel and no fetch stub,
  // which posted two rows to production before this default existed.
  assert.ok(process.env.NODE_TEST_CONTEXT, 'expected to be running under node --test');
  delete require.cache[require.resolve('../config')];
  const fresh = require('../config').config;
  assert.equal(fresh.conversationLogEnabled, false,
    'conversation logging must default OFF under the test runner');
});

test('a row written from under the test runner is marked synthetic', () => {
  const row = conversationLog.build('outbound', { text: 'manager reply' });
  assert.equal(row.meta.synthetic, true,
    'test-runner rows must be self-marking so they can never read as real');
});

test('the endpoint is UNROUTABLE under the test runner', () => {
  // Even if a test flips the enable flag AND injects the real transport, it
  // still cannot reach production: the base URL is redirected to a reserved
  // address nothing listens on.
  assert.ok(conversationLog.UNDER_TEST, 'expected to be running under node --test');
  assert.ok(conversationLog.endpoint().startsWith(conversationLog.UNROUTABLE),
    `endpoint must be unroutable under test, got ${conversationLog.endpoint()}`);
  assert.ok(!conversationLog.endpoint().includes(config.backendUrl),
    'the real backend URL must never be used from the suite');
});

test('the DEFAULT transport under the runner touches no socket', async () => {
  // The shape that leaked before: real method, fake channel, nobody stubbed
  // anything. It must deliver and stay silent on the wire.
  conversationLog.resetTransport();          // whatever the default is
  config.conversationLogEnabled = true;      // even with logging ON
  const urls = [];
  global.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 201, json: async () => ({}) }; };

  const tm = new TextMirror();
  const { channel, sent } = fakeChannel();
  tm.channel = channel;

  assert.equal(await tm.postText('manager reply'), true);
  assert.equal(sent.length, 1, 'delivery still happens');
  assert.equal(await conversationLog.recordInbound({ text: 'x' }), null);
  // log.js has always shipped its own lines to /api/logs/frontend/ (stdout
  // only, no durable rows) and predates this feature; what must never happen
  // is a conversation-log write.
  assert.deepEqual(urls.filter((u) => u.includes('/api/conversation/')), [],
    'the conversation logger made no HTTP call at all');
});

test('even the REAL transport, forced on, cannot reach the real backend', async () => {
  // Belt and braces: inject fetchTransport deliberately and confirm the URL it
  // would hit is the unroutable sentinel, not the configured backend.
  const urls = [];
  global.fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 201, json: async () => ({ id: 1 }) }; };
  conversationLog.setTransport(conversationLog.fetchTransport);
  await conversationLog.recordOutbound({ text: 'would-be production write' });
  assert.equal(urls.length, 1);
  assert.ok(urls[0].startsWith(conversationLog.UNROUTABLE), `got ${urls[0]}`);
});

// ------------------------------------------- criterion 5: outage safety ----

test('a rejecting backend never throws out of the logger', async () => {
  stubBackend('reject');
  assert.equal(await conversationLog.recordInbound({ text: 'x' }), null);
  assert.equal(await conversationLog.recordOutbound({ text: 'y' }), null);
});

test('a 500ing backend never throws out of the logger', async () => {
  stubBackend('500');
  assert.equal(await conversationLog.recordOutbound({ text: 'y' }), null);
});

test('BACKEND DOWN: the Discord message still sends (postText)', async () => {
  const posted = stubBackend('reject');
  const tm = new TextMirror();
  const { channel, sent } = fakeChannel();
  tm.channel = channel;

  const ok = await tm.postText('the backend is on fire but this must still arrive');

  assert.equal(ok, true, 'postText must report success even though logging failed');
  assert.equal(sent.length, 1, 'the message must still be sent to Discord');
  assert.equal(sent[0].content, 'the backend is on fire but this must still arrive');
  assert.ok(posted.length >= 1, 'and the logger must at least have tried');
});

test('BACKEND 500: the Discord message still sends (postText)', async () => {
  stubBackend('500');
  const tm = new TextMirror();
  const { channel, sent } = fakeChannel();
  tm.channel = channel;

  assert.equal(await tm.postText('still delivered'), true);
  assert.equal(sent.length, 1);
});

test('BACKEND DOWN: an inbound message still reaches the manager (forward)', async () => {
  stubBackend('reject');
  const lm = new LinkManager();
  lm.target = { host: '127.0.0.1', port: 1234, token: 't', managerId: '999' };

  const res = await lm.forward('remember to fix the deploy', { source: 'typed' });

  assert.equal(res.ok, true, 'forward must still deliver with the backend down');
  assert.equal(delivered.length, 1, 'the manager must still receive the message');
  assert.equal(delivered[0].text, 'remember to fix the deploy');
});

test('BACKEND DOWN: a slow/hanging backend does not delay delivery', async () => {
  stubBackend('hang'); // transport never settles
  const lm = new LinkManager();
  lm.target = { host: '127.0.0.1', port: 1234, token: 't', managerId: '999' };

  const res = await lm.forward('do not block on me', { source: 'typed' });

  assert.equal(res.ok, true);
  assert.equal(delivered.length, 1);
});

// ------------------------------------------------- both directions land ----

test('forward logs inbound with source and media paths', async () => {
  const posted = stubBackend('ok');
  const lm = new LinkManager();
  lm.target = { host: '127.0.0.1', port: 1234, token: 't', managerId: '999' };

  await lm.forward('look at this', { source: 'file', paths: ['/tmp/shot.png'] });

  const row = posted[0].body;
  assert.equal(row.direction, 'inbound');
  assert.equal(row.kind, 'file');
  assert.equal(row.media_path, '/tmp/shot.png');
  assert.equal(row.meta.source, 'file');
  assert.equal(row.meta.linked, true);
});

test('an UNLINKED inbound message is still logged (that is the point)', async () => {
  const posted = stubBackend('ok');
  const lm = new LinkManager();
  lm.target = null;

  const res = await lm.forward('nobody is listening but do not lose this');

  assert.equal(res.ok, false);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.direction, 'inbound');
  assert.equal(posted[0].body.meta.linked, false);
});

test('postText logs an outbound text row as delivered', async () => {
  const posted = stubBackend('ok');
  const tm = new TextMirror();
  tm.channel = fakeChannel().channel;

  await tm.postText('here is the PR link');

  assert.equal(posted[0].body.direction, 'outbound');
  assert.equal(posted[0].body.destination, 'discord');
  assert.equal(posted[0].body.kind, 'text');
  assert.equal(posted[0].body.text, 'here is the PR link');
  assert.equal(posted[0].body.meta.delivered, true);
});

test('a post that could not go out is logged as undelivered', async () => {
  const posted = stubBackend('ok');
  const tm = new TextMirror();
  tm.channel = null; // no channel resolved

  assert.equal(await tm.postText('into the void'), false);
  assert.equal(posted[0].body.meta.delivered, false);
  assert.equal(posted[0].body.meta.reason, 'no-channel');
});

test('postImage logs an outbound image row with its path', async () => {
  const posted = stubBackend('ok');
  const tm = new TextMirror();
  tm.channel = null;

  await tm.postImage('/tmp/does-not-matter.png', 'a caption');

  assert.equal(posted[0].body.kind, 'image');
  assert.equal(posted[0].body.media_path, '/tmp/does-not-matter.png');
  assert.equal(posted[0].body.text, 'a caption');
});

test('postVideo logs an outbound video row with its path', async () => {
  const posted = stubBackend('ok');
  const tm = new TextMirror();
  tm.channel = null;

  await tm.postVideo('/tmp/clip.mp4', 'a clip');

  assert.equal(posted[0].body.kind, 'video');
  assert.equal(posted[0].body.media_path, '/tmp/clip.mp4');
});
