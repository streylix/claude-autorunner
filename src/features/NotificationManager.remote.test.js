'use strict';

// Tests for NotificationManager's Remote Mode audio routing (REMOTE_MODE.md §9):
//   REMOTE renderer (window.__CCBOT_REMOTE__): a 'remote-tts-notification' WS
//   push (metadata + base64 audio) becomes a Blob URL, renders a row, autoplays
//   on THIS device, and marks played over the WS bridge — never via fetch to
//   the viewer's own loopback.
// Run: node --test src/features/NotificationManager.remote.test.js
//
// (The LOCAL-side suppression — remoteSinkActive holding autoplay — is covered
// in NotificationManager.local-sink.test.js, since IS_REMOTE is bound at
// require time and the two modes need separate processes.)

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ---- minimal DOM/host stubs (set before requiring the module) ----
let fetchCalls = [];
global.fetch = (url, opts) => {
  fetchCalls.push({ url, opts });
  return Promise.resolve({ ok: true, json: async () => ({ notifications: [] }) });
};
const domElements = new Map();
global.document = {
  getElementById: (id) => domElements.get(id) || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    className: '', dataset: {}, innerHTML: '',
    querySelector: () => null,
    style: {},
    addEventListener: () => {},
    insertBefore: () => {},
    appendChild: () => {}
  }),
  addEventListener: () => {},
  removeEventListener: () => {}
};
// THIS process simulates a Remote Mode client.
global.window = { __CCBOT_REMOTE__: true };

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

// Fake ipcRenderer standing in for the wsIpc shim; injected via require('electron').
const ipcSent = [];
const ipcHandlers = new Map();
const fakeIpc = {
  send: (channel, payload) => ipcSent.push({ channel, payload }),
  on: (channel, handler) => {
    if (!ipcHandlers.has(channel)) ipcHandlers.set(channel, []);
    ipcHandlers.get(channel).push(handler);
  },
  invoke: () => Promise.resolve({})
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

function makeRemoteMgr() {
  fetchCalls = [];
  ipcSent.length = 0;
  ipcHandlers.clear();
  const mgr = new NotificationManager(makeBus(), { getState: () => undefined });
  mgr.autoplay = true;
  mgr.initializeRemote();
  return mgr;
}

function pushNotification(mgr, id, audioBytes) {
  const handlers = ipcHandlers.get('remote-tts-notification') || [];
  assert.ok(handlers.length > 0, 'initializeRemote subscribed to the WS push channel');
  const payload = {
    notification: {
      id,
      terminal_id: '999',
      terminal_name: 'manager',
      text: 'remote test ' + id,
      voice: 'af_heart',
      created_at: new Date().toISOString(),
      audio_url: `/api/tts/audio/${id}/`
    },
    audioBase64: audioBytes ? Buffer.from(audioBytes).toString('base64') : null,
    mime: 'audio/wav'
  };
  handlers.forEach((h) => h({ channel: 'remote-tts-notification' }, payload));
  return payload;
}

test('a WS-pushed notification becomes a blob URL, is stored, and autoplays on this device', () => {
  const mgr = makeRemoteMgr();
  pushNotification(mgr, 7, 'RIFF-audio-bytes');

  const item = mgr.items.get(7);
  assert.ok(item, 'notification stored');
  assert.match(item.audio_url, /^blob:/, 'audio bytes became a blob: URL (no backend fetch)');
  assert.strictEqual(mgr.lastSeenId, 7);

  // Autoplay path: it queued and (after the heads-up chime resolves) plays the
  // blob URL VERBATIM — no BASE_URL prefix, which would point at the viewer's
  // own loopback where no backend lives.
  const queuedOrPlaying = mgr.playQueue.some((q) => q.id === 7) || mgr._currentId === 7;
  assert.ok(queuedOrPlaying, 'pushed notification entered the play path');
  mgr._startAudio(item.audio_url);
  assert.strictEqual(mgr.audio.src, item.audio_url, 'blob URL played as-is');
  assert.strictEqual(fetchCalls.length, 0, 'no HTTP fetch from the remote client');
});

test('duplicate pushes are ignored', () => {
  const mgr = makeRemoteMgr();
  pushNotification(mgr, 3, 'AUDIO');
  const url1 = mgr.items.get(3).audio_url;
  pushNotification(mgr, 3, 'AUDIO');
  assert.strictEqual(mgr.items.get(3).audio_url, url1, 'second push ignored');
});

test('finishing a clip marks it played over the WS bridge, never via fetch', () => {
  const mgr = makeRemoteMgr();
  pushNotification(mgr, 9, 'AUDIO');
  // Simulate the clip being the one in flight, then ending.
  mgr.playing = true;
  mgr._currentId = 9;
  mgr._onPlaybackEnded();
  assert.deepStrictEqual(ipcSent[ipcSent.length - 1], { channel: 'remote-tts-played', payload: { id: 9 } });
  assert.strictEqual(fetchCalls.length, 0, 'played-mark did not hit the viewer loopback');
});

test('autoplay-blocked play() requeues the clip instead of consuming it', () => {
  const mgr = makeRemoteMgr();
  pushNotification(mgr, 4, 'AUDIO');
  const item = mgr.items.get(4);
  mgr.playing = true;
  mgr._currentId = 4;
  const err = new Error('blocked');
  err.name = 'NotAllowedError';
  mgr.playQueue.length = 0; // it may still be queued from the push; isolate
  mgr._onPlayRejected(err);
  assert.strictEqual(mgr.playing, false);
  assert.strictEqual(mgr.playQueue[0] && mgr.playQueue[0].id, 4, 'clip requeued at the front');
  assert.ok(!ipcSent.some((s) => s.channel === 'remote-tts-played' && s.payload.id === 4),
    'blocked clip NOT finalized as played');
  assert.strictEqual(item.audio_url, mgr.playQueue[0].audio_url);
});
