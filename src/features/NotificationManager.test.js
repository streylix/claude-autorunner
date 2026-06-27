'use strict';

// Tests for NotificationManager's talk-over handling: a spoken notification that
// is interrupted by speech/noise mid-readout must RESUME from where it paused
// (never restart from 0), must never loop forever, and must not be re-queued
// twice. Run: node --test src/features/NotificationManager.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const BASE_URL = 'http://localhost:8123';

// ---- minimal DOM/host stubs (set before requiring the module's consumers) ----
let fetchCalls = [];
global.fetch = (url, opts) => {
  fetchCalls.push({ url, opts });
  return Promise.resolve({ ok: true, json: async () => ({ notifications: [] }) });
};
global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
global.window = {};

// A fake HTMLAudioElement. Assigning `.src` reloads the media and resets
// currentTime to 0 — exactly like a real element — so a fix that resumes by
// re-assigning src would visibly lose its position here.
class FakeAudio {
  constructor(src = '') {
    this._src = src;
    this.srcWrites = src ? 1 : 0;
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
  set src(v) { this._src = v; this.srcWrites++; this.currentTime = 0; }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
  play() { this.paused = false; this.playCount++; return Promise.resolve(); }
  pause() { this.paused = true; }
  emit(t) { (this._l[t] || []).forEach((f) => f()); }
}
global.Audio = FakeAudio;

const NotificationManager = require('./NotificationManager');

function makeBus() {
  const h = {};
  return {
    on: (n, cb) => { (h[n] = h[n] || []).push(cb); },
    emit: (n, p) => { (h[n] || []).forEach((cb) => cb(p)); },
  };
}

function makeEnv() {
  fetchCalls = [];
  const eventBus = makeBus();
  const appStateStore = { getState: () => undefined };
  const mgr = new NotificationManager(eventBus, appStateStore);
  mgr.autoplay = true;
  return { mgr, eventBus, fetchCalls };
}

// Put the manager into a "clip is playing mid-way" state without the async chime.
function startClip(mgr, id, url, offset) {
  mgr.items.set(id, { id, audio_url: url });
  mgr.playing = true;
  mgr._currentId = id;
  mgr._currentIsReplay = false;
  mgr._startAudio(url);          // sets audio.src (srcWrites -> 1)
  mgr.audio.currentTime = offset; // simulate playback progressed
}

// Fire the trailing-silence release timer synchronously (what its callback does).
function flushRelease(mgr) {
  if (mgr._speakingReleaseTimer) { clearTimeout(mgr._speakingReleaseTimer); mgr._speakingReleaseTimer = null; }
  mgr._drainQueue();
}

test('interruption pauses and RESUMES from the same position (never restarts from 0)', () => {
  const { mgr, eventBus } = makeEnv();
  startClip(mgr, 1, '/audio/1.wav', 4.2);
  const srcWritesBefore = mgr.audio.srcWrites;

  eventBus.emit('speech:active');               // user starts talking mid-readout
  assert.strictEqual(mgr.audio.paused, true, 'playback should pause');
  assert.strictEqual(mgr.playQueue.length, 0, 'held clip must NOT be pushed back onto the queue');
  assert.strictEqual(mgr.audio.currentTime, 4.2, 'position must be preserved while held');

  eventBus.emit('speech:idle');                 // user goes quiet
  flushRelease(mgr);
  assert.strictEqual(mgr.audio.paused, false, 'playback should resume');
  assert.strictEqual(mgr.audio.currentTime, 4.2, 'must resume from the held position, not 0');
  assert.strictEqual(mgr.audio.srcWrites, srcWritesBefore, 'resume must not reload src (which would reset to 0)');
});

test('repeated interruptions do not loop forever — after the cap the message is marked played and dropped', () => {
  const { mgr, eventBus, fetchCalls } = makeEnv();
  startClip(mgr, 1, '/audio/1.wav', 1.0);

  for (let i = 0; i < 5; i++) {
    eventBus.emit('speech:active');
    eventBus.emit('speech:idle');
    flushRelease(mgr);
  }

  const played = fetchCalls.filter(
    (c) => /\/api\/tts\/notifications\/1\/played\//.test(c.url) && c.opts && c.opts.method === 'POST'
  );
  assert.ok(played.length >= 1, 'message must be marked played after exceeding the interruption cap');
  assert.strictEqual(mgr._held, null, 'no message should be left held after the cap');
  assert.strictEqual(mgr.playQueue.some((q) => q.id === 1), false, 'capped message must not be re-queued for replay');
});

test('the same notification is not enqueued twice', () => {
  const { mgr } = makeEnv();
  mgr.muted = true; // hold the queue so we can inspect it
  const n = { id: 7, audio_url: '/audio/7.wav' };
  mgr._enqueuePlay(n);
  mgr._enqueuePlay(n);
  assert.strictEqual(mgr.playQueue.filter((q) => q.id === 7).length, 1, 'duplicate enqueue must be ignored');
});
