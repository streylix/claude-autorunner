'use strict';

// Tests for NotificationManager's talk-over handling: a spoken notification that
// is interrupted by speech/noise mid-readout must RESUME from where it paused
// (never restart from 0), must never loop forever, and must not be re-queued
// twice. Run: node --test src/features/NotificationManager.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// Must match the module's own resolution (127.0.0.1, not localhost — see
// src/utils/backend-url.js on Electron's ::1-only localhost lookup).
const { BACKEND_URL: BASE_URL } = require('../utils/backend-url');

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

function makeEnv({ bargeIn = false } = {}) {
  fetchCalls = [];
  const eventBus = makeBus();
  const appStateStore = { getState: () => undefined };
  const mgr = new NotificationManager(eventBus, appStateStore);
  mgr.autoplay = true;
  // Default here is LEGACY hold-and-resume so the long-standing hold tests keep
  // exercising that path; pass { bargeIn: true } for the interrupt behaviour
  // (which is the manager's real-world default).
  mgr.bargeInInterrupt = bargeIn;
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

test('repeated interruptions never loop and never drop the message — it plays through to completion', () => {
  const { mgr, eventBus } = makeEnv();
  startClip(mgr, 1, '/audio/1.wav', 1.0);

  for (let i = 0; i < 6; i++) {
    eventBus.emit('speech:active');
    eventBus.emit('speech:idle');
    flushRelease(mgr);
  }

  // After the hold cap the clip is flagged "play through": actively playing,
  // not held, not dropped, and resumed in place (never restarted from 0).
  assert.strictEqual(mgr.playing, true, 'message must be playing through, not stalled or dropped');
  assert.strictEqual(mgr._currentId, 1);
  assert.strictEqual(mgr._held, null);
  assert.strictEqual(mgr.audio.currentTime, 1.0, 'must have resumed in place, never from 0');
  eventBus.emit('speech:active');
  assert.strictEqual(mgr.audio.paused, false, 'a play-through clip must never be paused again');
});

test('a clip held while the user keeps talking is force-resumed (watchdog) and plays through — never stalls', () => {
  const { mgr, eventBus } = makeEnv();
  startClip(mgr, 1, '/audio/1.wav', 2.0);

  eventBus.emit('speech:active'); // user starts talking and does NOT stop (no speech:idle)
  assert.strictEqual(mgr.audio.paused, true, 'the first barge-in pauses');
  assert.ok(mgr._held && mgr._held.id === 1, 'clip is held');

  mgr._onHeldWatchdog(); // the bounded-hold watchdog fires while the user is still talking
  assert.strictEqual(mgr.audio.paused, false, 'watchdog force-resumes so the clip cannot stall');
  assert.strictEqual(mgr._held, null);
  assert.strictEqual(mgr.audio.currentTime, 2.0, 'resumes in place, not from 0');

  // a later, separate utterance must NOT pause it again — it plays through.
  eventBus.emit('speech:idle');
  if (mgr._speakingReleaseTimer) { clearTimeout(mgr._speakingReleaseTimer); mgr._speakingReleaseTimer = null; }
  eventBus.emit('speech:active');
  assert.strictEqual(mgr.audio.paused, false, 'play-through clip is never paused again');
});

test('BARGE-IN: speech onset mid-readout STOPS the message for good (no hold, no resume, finalized played)', () => {
  const { mgr, eventBus, fetchCalls } = makeEnv({ bargeIn: true });
  startClip(mgr, 1, '/audio/1.wav', 3.5);

  eventBus.emit('speech:active'); // user cuts in
  assert.strictEqual(mgr.audio.paused, true, 'readout must stop immediately');
  assert.strictEqual(mgr._held, null, 'clip must NOT be held for resume');
  assert.strictEqual(mgr.playing, false);
  assert.strictEqual(mgr._currentId, null);
  assert.ok(fetchCalls.some((c) => c.url === `${BASE_URL}/api/tts/notifications/1/played/`),
    'interrupted clip is finalized as played so it never reads out again');

  eventBus.emit('speech:idle');   // user goes quiet
  flushRelease(mgr);
  assert.strictEqual(mgr.audio.paused, true, 'the interrupted clip must NOT resume');
  assert.strictEqual(mgr.playing, false);
});

test('BARGE-IN: the next queued notification still plays after the user goes quiet', () => {
  const { mgr, eventBus } = makeEnv({ bargeIn: true });
  startClip(mgr, 1, '/audio/1.wav', 2.0);
  mgr.items.set(2, { id: 2, audio_url: '/audio/2.wav' });
  mgr._enqueuePlay(mgr.items.get(2)); // waiting behind the current clip

  eventBus.emit('speech:active');
  assert.strictEqual(mgr.playing, false, 'current readout stopped');
  assert.strictEqual(mgr.playQueue.length, 1, 'queued clip must survive the interrupt');

  eventBus.emit('speech:idle');
  flushRelease(mgr);
  assert.strictEqual(mgr.playing, true, 'next notification plays once the user is quiet');
  assert.strictEqual(mgr._currentId, 2);
});

test('BARGE-IN: interrupting a user-requested replay stops it but does NOT re-mark it played', () => {
  const { mgr, eventBus, fetchCalls } = makeEnv({ bargeIn: true });
  mgr.items.set(3, { id: 3, audio_url: '/audio/3.wav' });
  mgr.replay(3);
  fetchCalls.length = 0; // ignore any calls so far

  eventBus.emit('speech:active');
  assert.strictEqual(mgr.audio.paused, true, 'replay stops on barge-in');
  assert.ok(!fetchCalls.some((c) => String(c.url).includes('/played/')),
    'a replay was already played — no duplicate played POST');
});

test('the same notification is not enqueued twice', () => {
  const { mgr } = makeEnv();
  mgr.muted = true; // hold the queue so we can inspect it
  const n = { id: 7, audio_url: '/audio/7.wav' };
  mgr._enqueuePlay(n);
  mgr._enqueuePlay(n);
  assert.strictEqual(mgr.playQueue.filter((q) => q.id === 7).length, 1, 'duplicate enqueue must be ignored');
});
