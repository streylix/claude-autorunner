'use strict';

// c11 / d4: bot audio requested while the user is WRITING (isWriting) is held —
// not dropped — and plays exactly once when writing ends. Covers the tts-mode
// clip queue, a clip already playing (paused, then resumed — not restarted),
// and the system-mode sink relay (the live config) where TTS arrives as a
// burst of PCM. @discordjs/voice is stubbed; the hold check is the same
// function shape session.js wires to receiver.shouldHoldPlayback().
// Run: node --test src/audioPlayer.hold.test.js

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const plays = [];
class FakePlayer extends EventEmitter {
  constructor() { super(); this.state = { status: 'idle' }; this.pauses = 0; this.unpauses = 0; }
  play(resource) { plays.push(resource); this.state = { status: 'playing', resource }; }
  pause() { if (this.state.status !== 'playing') return false; this.pauses += 1; this.state = { ...this.state, status: 'paused' }; return true; }
  unpause() { if (this.state.status !== 'paused') return false; this.unpauses += 1; this.state = { ...this.state, status: 'playing' }; return true; }
  stop() { this.state = { status: 'idle' }; this.emit('idle'); return true; }
}
const voiceFile = require.resolve('@discordjs/voice');
require.cache[voiceFile] = {
  id: voiceFile, filename: voiceFile, loaded: true,
  exports: {
    createAudioPlayer: () => new FakePlayer(),
    createAudioResource: (stream, opts) => ({ stream, opts, playbackDuration: 0 }),
    StreamType: { Raw: 'raw', Arbitrary: 'arbitrary' },
    AudioPlayerStatus: { Idle: 'idle', Playing: 'playing', Paused: 'paused' },
    NoSubscriberBehavior: { Pause: 'pause' },
    entersState: async () => {},
  },
};
const log = require('./log');
for (const k of Object.keys(log)) if (typeof log[k] === 'function') log[k] = () => {};
const { config } = require('../config');
const VoicePlayer = require('./audioPlayer');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let writing = false;
function newPlayer() {
  const p = new VoicePlayer();
  p.attach({ subscribe() {} });
  p.setHoldCheck(() => writing, 60000);
  return p;
}
beforeEach(() => { plays.length = 0; writing = false; config.bargeInEnabled = true; });

test('c11: a TTS clip requested while writing waits, then plays exactly once', async () => {
  const p = newPlayer();
  writing = true;
  p.enqueue(Buffer.from('RIFF-clip'), '#1');
  await sleep(600);
  assert.strictEqual(plays.length, 0, 'played over the user while they were writing');
  assert.strictEqual(p.queue.length, 1, 'clip still queued (held, not dropped)');
  writing = false;
  await sleep(250);
  assert.strictEqual(plays.length, 1, 'played once writing ended');
  await sleep(400);
  assert.strictEqual(plays.length, 1, 'played exactly once');
  p.stop();
});

test('c11: a clip already playing is paused while writing and resumed — not restarted', async () => {
  const p = newPlayer();
  p.enqueue(Buffer.from('RIFF-clip'), '#2');
  assert.strictEqual(plays.length, 1);
  writing = true;
  await sleep(250);
  assert.strictEqual(p.player.state.status, 'paused', 'kept talking over the user');
  writing = false;
  await sleep(250);
  assert.strictEqual(p.player.state.status, 'playing');
  assert.strictEqual(p.player.unpauses, 1);
  assert.strictEqual(plays.length, 1, 'resumed the same clip rather than replaying it');
  p.stop();
});

test('c11: system-mode relay — a TTS burst during writing is buffered, then relayed once with nothing lost', async () => {
  config.systemGateEnabled = true;
  const p = newPlayer();
  const sink = new PassThrough();
  p.playLive(sink);
  writing = true;
  const loud = Buffer.alloc(3840);
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(i % 4 ? 8000 : -8000, i);
  for (let i = 0; i < 50; i++) sink.write(loud); // 1s of bot speech into the sink
  await sleep(500);
  assert.strictEqual(plays.length, 0, 'relayed bot audio while the user was writing');
  writing = false;
  await sleep(250);
  assert.strictEqual(plays.length, 1, 'held burst released exactly once');
  const got = plays[0].stream.readableLength;
  assert.ok(got >= 50 * 3840, `held audio kept (${got} of ${50 * 3840} bytes)`);
  p.stop();
});

test.after(() => setTimeout(() => process.exit(0), 50).unref());
