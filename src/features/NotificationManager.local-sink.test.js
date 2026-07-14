'use strict';

// Tests for the LOCAL renderer's side of Remote Mode audio routing
// (REMOTE_MODE.md §9): DUAL OUTPUT. Remote viewer(s) get the audio over the WS
// and play it on the viewing device, AND the local renderer keeps auto-playing
// on the desktop's default sink — the Discord bridge (AUDIO_SOURCE=system) and
// anyone at the machine must never go silent because a viewer attached.
// remoteSinkActive only tracks attach state (for the action log); it gates
// nothing.
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

test('DUAL OUTPUT: remote client attached → polled notifications still autoplay locally', async () => {
  const mgr = makeMgr();
  setClients(1);
  assert.strictEqual(mgr.remoteSinkActive, true, 'attach state is still tracked');

  pollPayload = { notifications: [notif(1)] };
  await mgr.poll();

  assert.ok(mgr.items.has(1), 'row rendered locally');
  assert.strictEqual(mgr.lastSeenId, 1, 'watermark advanced (no re-poll storm)');
  // The heads-up chime path is async; the clip must at least be in flight or queued.
  assert.ok(
    mgr.playing || mgr.playQueue.length > 0 || mgr._currentId === 1,
    'local playback proceeds even with a remote viewer attached — the desktop sink (Discord bridge) must hear it'
  );
});

test('explicit ▶ replay plays locally with a remote viewer attached (unchanged)', () => {
  const mgr = makeMgr();
  setClients(1);
  mgr.items.set(5, notif(5));
  mgr.replay(5);
  assert.strictEqual(mgr.playing, true, 'replay is an explicit local action — always honored');
  assert.strictEqual(mgr.audio.playCount, 1);
});

test('attach/detach transitions never strand the queue', async () => {
  const mgr = makeMgr();
  setClients(1);
  mgr.items.set(2, notif(2));
  mgr.playQueue.push(notif(2));
  mgr._drainQueue();
  assert.strictEqual(mgr._currentId, 2, 'drains immediately — no remote-sink hold');

  setClients(0);
  assert.strictEqual(mgr.remoteSinkActive, false);
  assert.strictEqual(mgr._currentId, 2, 'detach does not disturb the in-flight clip');
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
