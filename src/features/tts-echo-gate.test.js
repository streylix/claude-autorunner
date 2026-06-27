'use strict';

// Echo/output gating: while a TTS clip is actively playing (plus a short tail),
// WakeWordManager raises the VAD threshold so the notification's own audio
// echoing back into the mic can't trip a false "user is speaking" hold — but a
// genuine (louder) barge-in still pauses playback, which then resumes in place.
//
// Run: node --test src/features/tts-echo-gate.test.js

const { test } = require('node:test');
const assert = require('node:assert');

// ---- host stubs (set before requiring the managers' consumers) -------------
let fetchCalls = [];
global.fetch = (url, opts) => {
  fetchCalls.push({ url, opts });
  return Promise.resolve({ ok: true, json: async () => ({ notifications: [] }) });
};
global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
global.window = {};

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
}
global.Audio = FakeAudio;

const NotificationManager = require('./NotificationManager');
const WakeWordManager = require('./WakeWordManager');

// RMS levels relative to the manager's tuning: floor 0.010, barge-in ~0.030.
const ECHO_RMS = 0.020; // above the idle floor, below the barge-in gate
const LOUD_RMS = 0.060; // a real, close-mic barge-in
const ENOUGH_FRAMES = 6; // > VOICE_RUN_FRAMES so the sustained-run gate clears

function makeBus() {
  const h = {};
  return {
    on: (n, cb) => { (h[n] = h[n] || []).push(cb); },
    emit: (n, p) => { (h[n] || []).forEach((cb) => cb(p)); },
  };
}

function makeEnv() {
  fetchCalls = [];
  const bus = makeBus();
  const store = { getState: () => undefined };
  const notif = new NotificationManager(bus, store);
  notif.autoplay = true;
  const wake = new WakeWordManager(bus, store, {});
  return { bus, notif, wake };
}

function startClip(notif, id, url, offset) {
  notif.items.set(id, { id, audio_url: url });
  notif.playing = true;
  notif._currentId = id;
  notif._currentIsReplay = false;
  notif._startAudio(url);          // emits tts:playback {active:true}
  notif.audio.currentTime = offset; // simulate progress (src setter zeroed it)
}

function feedFrames(wake, rms, n) {
  for (let i = 0; i < n; i++) wake._updateSpeechSignal(rms);
}

test('TTS echo during playback does NOT pause/hold the clip', () => {
  const { notif, wake } = makeEnv();
  startClip(notif, 1, '/audio/1.wav', 3.0);
  assert.strictEqual(wake._inTtsEchoWindow(), true, 'echo window should be open while playing');

  feedFrames(wake, ECHO_RMS, ENOUGH_FRAMES); // the TTS bleeding into the mic
  assert.strictEqual(notif.audio.paused, false, 'echo must not pause playback');
  assert.strictEqual(notif._held, null, 'echo must not hold the clip');
});

test('a genuine loud barge-in during playback still holds, then resumes in place', () => {
  const { bus, notif, wake } = makeEnv();
  startClip(notif, 1, '/audio/1.wav', 3.0);

  feedFrames(wake, LOUD_RMS, ENOUGH_FRAMES); // user clearly speaks over it
  assert.strictEqual(notif.audio.paused, true, 'loud barge-in must pause');
  assert.ok(notif._held && notif._held.id === 1, 'clip must be held for resume');

  // user goes quiet -> release -> resume from the same position, no reload
  const srcWrites = notif.audio.srcWrites;
  bus.emit('speech:idle');
  if (notif._speakingReleaseTimer) { clearTimeout(notif._speakingReleaseTimer); notif._speakingReleaseTimer = null; }
  notif._drainQueue();
  assert.strictEqual(notif.audio.paused, false, 'should resume after silence');
  assert.strictEqual(notif.audio.currentTime, 3.0, 'resume in place, not from 0');
  assert.strictEqual(notif.audio.srcWrites, srcWrites, 'resume must not reload src');
});

test('without TTS playing, the same echo-level sound DOES register as speech (sensitivity preserved)', () => {
  const { bus, wake } = makeEnv();
  let active = 0;
  bus.on('speech:active', () => active++);
  feedFrames(wake, ECHO_RMS, ENOUGH_FRAMES);
  assert.strictEqual(active, 1, 'normal (no-TTS) VAD sensitivity must be unchanged');
});

test('the elevated gate persists for a short tail after playback stops', () => {
  const { wake } = makeEnv();
  wake._setTtsPlayback(true);
  assert.strictEqual(wake._inTtsEchoWindow(), true);
  wake._setTtsPlayback(false);
  // tail timer still pending -> window remains elevated so a trailing echo is ignored
  assert.strictEqual(wake._inTtsEchoWindow(), true, 'tail should keep the gate elevated briefly');
});
