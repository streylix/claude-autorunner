'use strict';

// T521 (c3): while the bridge is not connected to voice, no code path may
// produce audio in Discord — not a TTS clip, not the sink-shim relay, not an
// SFX ack. canPlayAudio() is the single gate every outbound-audio path
// checks; this proves it reports closed when disconnected and open when
// connected (the control for c3's "audio IS still played when in the call").

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'g1';

const BridgeSession = require('./session');

function makeSession() {
  return new BridgeSession({ receiver: { attach() {}, detach() {}, getHealth: () => ({}) }, textMirror: null });
}

test('c3: not connected (no call) → canPlayAudio is false', () => {
  const session = makeSession();
  assert.equal(session.canPlayAudio(), false);
});

test('c3 control: connected with a player wired up → canPlayAudio is true', () => {
  const session = makeSession();
  session.connection = {}; // stands in for a live voice connection
  session.player = { enqueue() {} };
  assert.equal(session.canPlayAudio(), true);
});

test('c3: a connection with no player yet (mid-join) → still closed', () => {
  const session = makeSession();
  session.connection = {};
  assert.equal(session.canPlayAudio(), false);
});

test('c3: playSound() is a no-op with no audio produced while disconnected', () => {
  const session = makeSession();
  let enqueued = false;
  session.player = { enqueue: () => { enqueued = true; } }; // player exists but...
  session.connection = null; // ...we're not actually connected
  session.playSound('click2.wav', 'test');
  assert.equal(enqueued, false, 'no sound should be enqueued while disconnected');
});
