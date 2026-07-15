'use strict';

// Stop-word interrupt (voice barge-in): a transcribed message whose FIRST word
// (case-insensitive, punctuation-trimmed) matches the app's interruptStopWords
// setting sends ESC to the manager BEFORE injecting, so the newest message
// preempts the in-flight turn. The list is mirrored LIVE from the app store.
// Run: node --test src/controlApi.stopword.test.js

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Point the bridge's live settings mirror at a throwaway store file.
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stopword-store-'));
const storeFile = path.join(storeDir, 'auto-injector.json');
process.env.APP_STORE_PATH = storeFile;

let mtimeBump = 1_700_000_000_000;
function writeStore(settings) {
  fs.writeFileSync(storeFile, JSON.stringify({ settings }));
  // appSettings re-parses on mtime change; writes in the same ms would be
  // missed, so stamp a strictly increasing mtime.
  mtimeBump += 1000;
  fs.utimesSync(storeFile, new Date(mtimeBump), new Date(mtimeBump));
}

const { firstToken, sendVoiceMemo } = require('./controlApi');
const { interruptStopWords } = require('./appSettings');

// ---- stub control API: records every /terminal/keys body ----
let received = [];
let server;
let target;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  target = { host: '127.0.0.1', port: server.address().port, token: 't', managerId: 999 };
});

after(() => server.close());

beforeEach(() => { received = []; });

const keysOf = () => received.filter((r) => r.url === '/terminal/keys').map((r) => r.body.keys);

test('firstToken: lowercases and trims punctuation ("No," -> "no")', () => {
  assert.strictEqual(firstToken('No, stop doing that.'), 'no');
  assert.strictEqual(firstToken('  WAIT!! do this instead'), 'wait');
  assert.strictEqual(firstToken(''), '');
  assert.strictEqual(firstToken('…okay then'), 'okay');
});

test('interruptStopWords: defaults to ["no"] with no store / no key', () => {
  try { fs.unlinkSync(storeFile); } catch (_) {}
  // cache may hold the previous read; a fresh default must still come back
  assert.deepStrictEqual(interruptStopWords().includes('no'), true);
});

test('voice message starting with a stop word sends ESC first, then text, then enter', async () => {
  writeStore({ interruptStopWords: '["no"]' });
  const r = await sendVoiceMemo(target, 'No, look at the newest file instead', { source: 'voice' });
  assert.strictEqual(r.ok, true);
  const keys = keysOf();
  assert.strictEqual(keys.length, 3, 'esc + text + enter');
  assert.deepStrictEqual(keys[0], ['esc'], 'ESC fires FIRST');
  assert.ok(String(keys[1][0]).includes('No, look at the newest file instead'), 'whole message injected (stop word NOT stripped)');
  assert.deepStrictEqual(keys[2], ['enter']);
});

test('normal voice message does NOT send ESC', async () => {
  writeStore({ interruptStopWords: '["no"]' });
  await sendVoiceMemo(target, 'please summarize the log output', { source: 'voice' });
  const keys = keysOf();
  assert.strictEqual(keys.length, 2, 'text + enter only');
  assert.notDeepStrictEqual(keys[0], ['esc']);
});

test('stop word mid-sentence does NOT trigger (first word only)', async () => {
  writeStore({ interruptStopWords: '["no"]' });
  await sendVoiceMemo(target, 'there is no reason to stop', { source: 'voice' });
  assert.strictEqual(keysOf().length, 2);
});

test('typed messages never interrupt, even when led by a stop word', async () => {
  writeStore({ interruptStopWords: '["no"]' });
  await sendVoiceMemo(target, 'no this is a typed message', { source: 'typed' });
  assert.strictEqual(keysOf().length, 2);
});

test('LIVE settings change: adding "wait" takes effect on the next message', async () => {
  writeStore({ interruptStopWords: '["no"]' });
  await sendVoiceMemo(target, 'Wait, use the other branch', { source: 'voice' });
  assert.strictEqual(keysOf().length, 2, '"wait" not configured yet — no ESC');

  received = [];
  writeStore({ interruptStopWords: '["no","wait"]' });
  await sendVoiceMemo(target, 'Wait, use the other branch', { source: 'voice' });
  const keys = keysOf();
  assert.strictEqual(keys.length, 3, '"wait" now configured — ESC fires');
  assert.deepStrictEqual(keys[0], ['esc']);
});

test('ESC failure is non-fatal: the message is still injected', async () => {
  writeStore({ interruptStopWords: '["no"]' });
  // A target whose first call fails: point at a dead port for /terminal/keys?
  // Simpler: make the stub error once.
  let failNext = true;
  const origListeners = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (failNext && Array.isArray(parsed.keys) && parsed.keys[0] === 'esc') {
        failNext = false;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"ok":false}');
        return;
      }
      received.push({ url: req.url, body: parsed });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const r = await sendVoiceMemo(target, 'no really, stop', { source: 'voice' });
  assert.strictEqual(r.ok, true, 'inject still succeeds after ESC failure');
  assert.strictEqual(keysOf().length, 2, 'text + enter delivered');
  server.removeAllListeners('request');
  origListeners.forEach((l) => server.on('request', l));
});
