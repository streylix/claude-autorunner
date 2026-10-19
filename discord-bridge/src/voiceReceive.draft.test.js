'use strict';

// Always-listen utterance behavior (T510 redesign):
//   c5  a short utterance is transcribed and sent exactly once
//   c9  the streamed draft builds while he talks (durable file, T512); ONE
//       message reaches 999, only after the configured silence, covering the
//       whole utterance
//   c10 audio below the breathing threshold does not reset the silence timer;
//       audio above it does
//   c13 muting mid-utterance sends what was captured immediately (once);
//       muting with nothing captured sends nothing
//   d3  an utterance past the memory backstop is sent in pieces, never dropped
// Test silence is 600ms (IN_CALL_SILENCE_MS) so the suite runs in seconds.
// Run: node --test src/voiceReceive.draft.test.js

const fs = require('fs');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { setup, talk, waitFor, sleep, SPEECH, BREATH } = require('./voiceHarness');

const h = setup();
const { config, calls, receiver, vr } = h;
const SILENCE = 600;
const defaults = {
  draftMinSegmentMs: config.draftMinSegmentMs,
  draftGapMs: config.draftGapMs,
  maxUtteranceMs: config.maxUtteranceMs,
};

beforeEach(async () => {
  Object.assign(config, defaults);
  await waitFor(() => vr.utterances.size === 0 && !vr.isWriting(), 3000);
  await sleep(150); // let the speaking map expire so the next packet is a fresh 'start'
  calls.forward.length = 0;
  calls.heard.length = 0;
  calls.transcribe.length = 0;
});

// The stub transcript is "said <N>ms" for an N-ms WAV, so the forwarded text
// tells us exactly how much audio it covers (summed over stitched segments).
const saidMs = (t) => [...t.matchAll(/said (\d+)ms/g)].reduce((a, m) => a + Number(m[1]), 0);
const draftLines = () => {
  try {
    return fs.readdirSync(config.draftDir).filter((n) => !n.endsWith('.sent.jsonl'))
      .reduce((a, n) => a + fs.readFileSync(`${config.draftDir}/${n}`, 'utf8').split('\n').filter(Boolean).length, 0);
  } catch (_) { return 0; }
};

test('c5: a normal short utterance is transcribed and sent exactly once', async () => {
  assert.strictEqual(vr.isWriting(), false);
  await talk(receiver, 600);
  assert.strictEqual(vr.isWriting(), true, 'isWriting while the utterance is open (d4 holds playback on it)');
  const t = await waitFor(() => calls.forward.length > 0, 3000);
  assert.strictEqual(vr.isWriting(), false, 'isWriting cleared once the message is sent');
  assert.ok(t >= 0, 'never sent');
  await sleep(1500); // any duplicate would land in here
  assert.strictEqual(calls.forward.length, 1, 'exactly one injection');
  assert.strictEqual(calls.heard.length, 1, 'exactly one Heard mirror');
  assert.strictEqual(calls.transcribe.length, 1, 'one Whisper pass (no draft segment for a short utterance)');
  assert.ok(Math.abs(saidMs(calls.forward[0]) - 600) <= 40, `whole utterance transcribed (${calls.forward[0]})`);
});

test('c9: the draft builds incrementally; one message to 999, after the silence, covering the whole audio', async () => {
  config.draftMinSegmentMs = 300;
  config.draftGapMs = 150;
  let lastVoice = 0;
  const growth = [];
  for (let i = 0; i < 3; i++) {       // three phrases with short pauses (no packets)
    await talk(receiver, 400);
    lastVoice = Date.now();
    await sleep(250);                  // < SILENCE: one utterance
    assert.strictEqual(calls.forward.length, 0, `sent mid-utterance (after phrase ${i + 1})`);
    growth.push(draftLines());
  }
  const t = await waitFor(() => calls.forward.length > 0, 3000);
  assert.ok(t >= 0, 'never sent');
  const sentAfter = Date.now() - lastVoice;
  assert.ok(sentAfter >= SILENCE - 20, `sent ${sentAfter}ms after the last voice — before the ${SILENCE}ms silence`);
  await sleep(1000);
  assert.strictEqual(calls.forward.length, 1, 'exactly one message to 999');
  assert.ok(growth[1] > growth[0] && growth[2] > growth[1], `draft grew during the utterance (segment lines: ${growth})`);
  assert.ok(Math.abs(saidMs(calls.forward[0]) - 1200) <= 60, `sent draft covers the whole utterance (${calls.forward[0]})`);
});

test('c10: breathing below the threshold does not reset the silence timer', async () => {
  await talk(receiver, 300, SPEECH);
  const lastVoice = Date.now();
  const breathing = talk(receiver, 1500, BREATH);  // packets keep flowing, all below -40 dBFS
  const t = await waitFor(() => calls.forward.length > 0, 1400);
  const sentAt = Date.now() - lastVoice;
  assert.ok(t >= 0, 'breathing kept the utterance open (silence timer was reset by sub-threshold audio)');
  assert.ok(sentAt < 1200, `sent ${sentAt}ms after the last voice while breath was still arriving`);
  await breathing;
  await sleep(SILENCE + 300);
  assert.strictEqual(calls.forward.length, 1, 'the trailing breath is not sent as its own message');
});

test('c10: audio above the threshold does reset the silence timer', async () => {
  await talk(receiver, 300, SPEECH);
  await talk(receiver, 400, BREATH);   // quiet but < SILENCE
  await talk(receiver, 300, SPEECH);   // voice again → same utterance
  await sleep(250);
  assert.strictEqual(calls.forward.length, 0, 'sent before the silence after the second phrase');
  await waitFor(() => calls.forward.length > 0, 3000);
  await sleep(800);
  assert.strictEqual(calls.forward.length, 1, 'one message for both phrases');
});

test('c10: breath-only audio is never sent', async () => {
  await talk(receiver, 800, BREATH);
  await sleep(SILENCE + 600);
  assert.strictEqual(calls.forward.length, 0);
  assert.strictEqual(calls.transcribe.length, 0, 'no Whisper call for breathing');
});

test('c13: muting mid-utterance sends the captured audio at once, as one message', async () => {
  await talk(receiver, 500);
  const t0 = Date.now();
  vr.setMute('u1', true);
  const t = await waitFor(() => calls.forward.length > 0, 2000, 5);
  const took = Date.now() - t0;
  assert.ok(t >= 0, 'mute threw the captured audio away');
  assert.ok(took < SILENCE / 2, `sent ${took}ms after the mute — not immediate`);
  await sleep(SILENCE + 400);
  assert.strictEqual(calls.forward.length, 1, 'exactly one message');
  assert.ok(Math.abs(saidMs(calls.forward[0]) - 500) <= 40, `captured audio sent (${calls.forward[0]})`);
  vr.setMute('u1', false);
});

test('c13: muting with nothing captured sends nothing', async () => {
  vr.setMute('u1', true);             // idle mute
  vr.setMute('u1', false);
  await talk(receiver, 400, BREATH);  // only breathing captured…
  vr.setMute('u1', true);             // …then mute
  await sleep(SILENCE + 400);
  assert.strictEqual(calls.forward.length, 0);
  assert.strictEqual(calls.transcribe.length, 0);
  vr.setMute('u1', false);
});

test('d3: an utterance past the length backstop is sent in pieces — no audio dropped', async () => {
  config.maxUtteranceMs = 1000;
  config.draftMinSegmentMs = 100000; // no draft noise in this test
  await talk(receiver, 1600);         // continuous — no pause to end on
  await waitFor(() => calls.forward.length >= 2, 3000);
  await sleep(800);
  const total = calls.forward.reduce((a, t) => a + saidMs(t), 0);
  assert.strictEqual(calls.forward.length, 2, `sent as ${calls.forward.length} message(s)`);
  assert.ok(total >= 1500, `only ${total}ms of 1600ms reached 999`);
});

test.after(() => setTimeout(() => process.exit(0), 50).unref());
