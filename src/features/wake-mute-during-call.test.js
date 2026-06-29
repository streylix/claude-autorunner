'use strict';

// Feature: "Mute local-mic wake word while Discord bot is in a call." When the
// pref is ON and the Discord bot is active (in a voice channel), the local
// host-mic wake word must NOT fire (so the user in the room only triggers via
// the bot — no double action). The always-on TTS speech gate must keep working.
// Run: node --test src/features/wake-mute-during-call.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const WakeWordManager = require('./WakeWordManager');

function makeBus() {
  const h = {};
  return {
    on: (n, cb) => { (h[n] = h[n] || []).push(cb); },
    emit: (n, p) => { (h[n] || []).forEach((cb) => cb(p)); },
  };
}

// A WakeWordManager parked in the idle-listening state with _beginCapture spied,
// so we can assert whether a heard wake word actually activates capture.
function makeManager() {
  const bus = makeBus();
  const mgr = new WakeWordManager(bus, { getState: () => undefined }, {});
  mgr.enabled = true;
  mgr.state = 'listening';
  let began = 0;
  mgr._beginCapture = () => { began++; };
  return { mgr, bus, began: () => began };
}

test('pref ON + bot in call: a heard wake word is suppressed (no capture)', () => {
  const { mgr, began } = makeManager();
  mgr.muteWhileBotActive = true;
  mgr._botInCall = true;
  mgr._onWakeDetected();
  assert.strictEqual(began(), 0, 'wake word must be suppressed while the bot is in a call');
});

test('pref ON + bot NOT in call: the wake word fires normally', () => {
  const { mgr, began } = makeManager();
  mgr.muteWhileBotActive = true;
  mgr._botInCall = false;
  mgr._onWakeDetected();
  assert.strictEqual(began(), 1, 'wake word must work when the bot is not active');
});

test('pref OFF: the wake word fires even if the bot is in a call', () => {
  const { mgr, began } = makeManager();
  mgr.muteWhileBotActive = false;
  mgr._botInCall = true;
  mgr._onWakeDetected();
  assert.strictEqual(began(), 1, 'with the setting off, local wake word is unaffected');
});

test('_applyConfig maps the wakeMuteDuringCall preference (bulk + live)', () => {
  const { mgr, bus } = makeManager();
  bus.emit('preferences:applied', { wakeMuteDuringCall: true });
  assert.strictEqual(mgr.muteWhileBotActive, true);
  bus.emit('preference:changed', { key: 'wakeMuteDuringCall', value: false });
  assert.strictEqual(mgr.muteWhileBotActive, false);
});

test('_applyBotStatus reads the backend bridge-status payload', () => {
  const { mgr } = makeManager();
  mgr._applyBotStatus({ active: true });
  assert.strictEqual(mgr._botInCall, true);
  mgr._applyBotStatus({ active: false });
  assert.strictEqual(mgr._botInCall, false);
  mgr._applyBotStatus(null); // malformed/empty response -> not in call
  assert.strictEqual(mgr._botInCall, false);
});

test('polling the backend drives suppression end-to-end (active → suppressed, inactive → fires)', async () => {
  const { mgr, began } = makeManager();
  mgr.muteWhileBotActive = true;
  const origFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ active: true }) });
    await mgr._pollBotStatus();
    assert.strictEqual(mgr._botInCall, true);
    mgr._onWakeDetected();
    assert.strictEqual(began(), 0, 'bot active via poll => wake suppressed');

    global.fetch = async () => ({ ok: true, json: async () => ({ active: false }) });
    await mgr._pollBotStatus();
    assert.strictEqual(mgr._botInCall, false);
    mgr._onWakeDetected();
    assert.strictEqual(began(), 1, 'bot inactive via poll => wake fires');
  } finally {
    global.fetch = origFetch;
  }
});

test('poll failure fails safe (not muted) so the local wake word keeps working', async () => {
  const { mgr } = makeManager();
  mgr._botInCall = true;
  const origFetch = global.fetch;
  global.fetch = async () => { throw new Error('backend unreachable'); };
  try { await mgr._pollBotStatus(); } finally { global.fetch = origFetch; }
  assert.strictEqual(mgr._botInCall, false, 'unreachable backend => treat bot as not in call');
});

test('the TTS speech gate still fires while the wake word is muted', () => {
  const { mgr, bus } = makeManager();
  mgr.muteWhileBotActive = true;
  mgr._botInCall = true;
  let active = 0;
  bus.on('speech:active', () => active++);
  for (let i = 0; i < 6; i++) mgr._updateSpeechSignal(0.05); // loud, sustained
  assert.strictEqual(active, 1, 'muting the wake word must NOT disable the speech gate');
});
