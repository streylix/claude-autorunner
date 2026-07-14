'use strict';

// Tests for the LOCAL renderer's side of Remote Mode audio routing
// (REMOTE_MODE.md §9): while ≥1 remote client is attached ('remote-clients-
// changed' with count > 0), the local renderer suppresses AUTO playback — the
// remote viewer(s) are the audio sink — but rows still render, an explicit ▶
// replay still plays locally, and playback resumes when the last client leaves.
// Run: node --test src/features/NotificationManager.local-sink.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ---- minimal DOM/host stubs (set before requiring the module) ----
let fetchCalls = [];
let pollPayload = { notifications: [] };
global.fetch = (url, opts) => {
  fetchCalls.push({ url, opts });
  return Promise.resolve({ ok: true, json: async () => pollPayload });
};
global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
global.window = {}; // LOCAL renderer: no __CCBOT_REMOTE__

class FakeAudio {
  constructor(src = '') {
    this._src = src;
    this.currentTime = 0;
    this.playbackRate = 1;
    this.volume = 1;
    this.paused = true;
    this.playCount = 0;
    this._l = {};
    this.onended = null;
    this.onerror = null;
  }
  get src() { return this._src; }
  set src(v) { this._src = v; this.currentTime = 0; }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  play() { this.paused = false; this.playCount++; return Promise.resolve(); }
  pause() { this.paused = true; }
  emit(t) { (this._l[t] || []).forEach((f) => f()); }
}
global.Audio = FakeAudio;

// Fake ipcRenderer so _wireRemoteSinkSignal has something to subscribe to.
const ipcHandlers = new Map();
const fakeIpc = {
  send: () => {},
  on: (channel, handler) => {
    if (!ipcHandlers.has(channel)) ipcHandlers.set(channel, []);
    ipcHandlers.get(channel).push(handler);
  },
  invoke: (channel) => channel === 'remote-clients-count'
    ? Promise.resolve({ count: 0 })
    : Promise.resolve({})
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron';
  return origResolve.call(this, request, ...rest);
};
require.cache.electron = { id: 'electron', filename: 'electron', loaded: true, exports: { ipcRenderer: fakeIpc } };

const NotificationManager = require('./NotificationManager');

function makeBus() {
  const h = {};
  return {
    on: (n, cb) => { (h[n] = h[n] || []).push(cb); },
    emit: (n, p) => { (h[n] || []).forEach((cb) => cb(p)); },
  };
}

function makeMgr() {
  fetchCalls = [];
  ipcHandlers.clear();
  const mgr = new NotificationManager(makeBus(), { getState: () => undefined });
  mgr.autoplay = true;
  mgr._wireRemoteSinkSignal();
  return mgr;
}

function setClients(count) {
  (ipcHandlers.get('remote-clients-changed') || []).forEach((h) => h({}, { count }));
}

function notif(id) {
  return { id, text: 'n' + id, audio_url: `/api/tts/audio/${id}/`, created_at: new Date().toISOString() };
}

test('remote client attached → polled notifications render but do NOT autoplay locally', async () => {
  const mgr = makeMgr();
  setClients(1);
  assert.strictEqual(mgr.remoteSinkActive, true);

  pollPayload = { notifications: [notif(1)] };
  await mgr.poll();

  assert.ok(mgr.items.has(1), 'row still rendered locally');
  assert.strictEqual(mgr.lastSeenId, 1, 'watermark advanced (no re-poll storm)');
  assert.strictEqual(mgr.playing, false, 'no local playback while a remote viewer is attached');
  assert.strictEqual(mgr.playQueue.length, 0, 'nothing queued locally');
  assert.strictEqual(mgr.audio.playCount, 0, 'audio element untouched');
});

test('explicit ▶ replay still plays locally even with a remote viewer attached', () => {
  const mgr = makeMgr();
  setClients(1);
  mgr.items.set(5, notif(5));
  mgr.replay(5);
  assert.strictEqual(mgr.playing, true, 'replay is an explicit local action — always honored');
  assert.strictEqual(mgr.audio.playCount, 1);
});

test('last client detaches → queue drains again locally', async () => {
  const mgr = makeMgr();
  setClients(1);
  // Something queued before the sink flipped (e.g. arrived mid-handoff).
  mgr.items.set(2, notif(2));
  mgr.playQueue.push(notif(2));
  mgr._drainQueue();
  assert.strictEqual(mgr.playing, false, 'held while remote viewers are the sink');

  setClients(0);
  assert.strictEqual(mgr.remoteSinkActive, false);
  // _drainQueue runs from the signal; the heads-up chime path is async but the
  // queue must have been consumed by the drain.
  assert.strictEqual(mgr.playQueue.length, 0, 'queue drained when the sink came back');
  assert.strictEqual(mgr._currentId, 2, 'held clip is now the in-flight one');
});

test('boot-time state comes from the remote-clients-count invoke', async () => {
  fetchCalls = [];
  ipcHandlers.clear();
  const mgr = new NotificationManager(makeBus(), { getState: () => undefined });
  const origInvoke = fakeIpc.invoke;
  fakeIpc.invoke = (channel) => channel === 'remote-clients-count'
    ? Promise.resolve({ count: 3 })
    : Promise.resolve({});
  try {
    mgr._wireRemoteSinkSignal();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(mgr.remoteSinkActive, true, 'reloaded local renderer learns clients are attached');
  } finally {
    fakeIpc.invoke = origInvoke;
  }
});
