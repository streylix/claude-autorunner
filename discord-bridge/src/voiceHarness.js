'use strict';

// Test harness for VoiceReceiver: a fake Discord receiver that mirrors the
// @discordjs/voice internals the capture path depends on (SpeakingMap fed by
// every UDP packet BEFORE decryption, a subscriptions Map, and the REAL
// AudioReceiveStream with its AfterSilence/Manual end behaviors), plus stubs
// for Opus decoding, Whisper, the link manager and the text mirror.
// Only used by the *.test.js files.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Transform } = require('stream');

// Env must be set before config.js is loaded.
function primeEnv() {
  process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
  process.env.ALLOWED_SPEAKER_IDS = 'u1';
  process.env.IN_CALL_SILENCE_MS = '600';
  process.env.ALWAYS_LISTEN_IN_CALL = 'true';
  process.env.BARGE_IN_INTERRUPT_ENABLED = 'false';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-harness-'));
  const store = path.join(dir, 'auto-injector.json');
  fs.writeFileSync(store, JSON.stringify({ settings: {} }));
  process.env.APP_STORE_PATH = store;
  process.env.VOICE_DRAFT_DIR = path.join(dir, 'voice-drafts');
}

// Replace a module in the require cache before voiceReceive destructures it.
function stubModule(rel, exportsObj) {
  const file = require.resolve(path.join(__dirname, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj };
}

// 20ms of 48kHz stereo s16le — one decoded Opus frame.
const FRAME_BYTES = 3840;
function frame(amplitude) {
  const b = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES / 4; i++) {
    const s = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 48000));
    b.writeInt16LE(s, i * 4);
    b.writeInt16LE(s, i * 4 + 2);
  }
  return b;
}
const SPEECH = 3000;  // sine peak ≈ -20.8 dBFS, RMS ≈ -23.8 dBFS
const BREATH = 200;   // sine peak ≈ -44.3 dBFS, RMS ≈ -47.3 dBFS

class FakeSpeakingMap extends EventEmitter {
  constructor() { super(); this.users = new Map(); this.timeouts = new Map(); }
  onPacket(userId) {
    const t = this.timeouts.get(userId);
    if (t) clearTimeout(t); else { this.users.set(userId, Date.now()); this.emit('start', userId); }
    this.timeouts.set(userId, setTimeout(() => {
      this.timeouts.delete(userId); this.users.delete(userId); this.emit('end', userId);
    }, 100));
  }
}

class FakeReceiver {
  constructor(AudioReceiveStream) {
    this.AudioReceiveStream = AudioReceiveStream;
    this.speaking = new FakeSpeakingMap();
    this.subscriptions = new Map();
    this.subscribeCount = 0;
    this.deliver = true; // false = UDP packets arrive but never reach the stream (decrypt null)
  }
  subscribe(userId, options) {
    const existing = this.subscriptions.get(userId);
    if (existing) return existing;
    this.subscribeCount += 1;
    const stream = new this.AudioReceiveStream({ end: options.end });
    stream.once('close', () => this.subscriptions.delete(userId));
    this.subscriptions.set(userId, stream);
    return stream;
  }
  // Mirrors VoiceReceiver.onUdpMessage: speaking state first, then the stream.
  packet(userId, pcm) {
    this.speaking.onPacket(userId);
    const s = this.subscriptions.get(userId);
    if (s && this.deliver && !s.destroyed) s.push(pcm);
  }
}

function setup() {
  primeEnv();
  const calls = { transcribe: [], forward: [], heard: [], forwardAt: [] };
  let transcriptFor = (wav) => `said ${Math.round((wav.length - 44) / 192)}ms`;
  let whisperDelay = () => 0; // (audioMs) => ms — emulate Whisper's cost
  stubModule('transcribe.js', {
    transcribeWav: async (wav) => {
      const ms = Math.round((wav.length - 44) / 192);
      calls.transcribe.push(ms);
      const d = whisperDelay(ms);
      if (d) await new Promise((r) => setTimeout(r, d));
      return transcriptFor(wav);
    },
  });
  stubModule('wakeCheck.js', { wakeCheck: async () => '' });
  const prism = require('prism-media');
  prism.opus.Decoder = class extends Transform {
    constructor() { super(); }
    _transform(c, _e, cb) { cb(null, c); }
  };
  const log = require('./log');
  for (const k of Object.keys(log)) if (typeof log[k] === 'function') log[k] = () => {};
  const { AudioReceiveStream } = require('@discordjs/voice');
  const { config } = require('../config');
  const VoiceReceiver = require('./voiceReceive');
  const linkManager = {
    forward: async (text) => { calls.forward.push(text); calls.forwardAt.push(Date.now()); return { ok: true }; },
    status: () => ({ managerId: 999 }),
  };
  const vr = new VoiceReceiver({ linkManager, wakeSpotter: null });
  vr.onHeard = (text) => calls.heard.push(text);
  const receiver = new FakeReceiver(AudioReceiveStream);
  vr.attach({ receiver });
  return {
    vr, receiver, config, calls,
    setTranscript(fn) { transcriptFor = fn; },
    setWhisperDelay(fn) { whisperDelay = fn; },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send `ms` of frames at `amplitude`, paced in real time (20ms per frame).
async function talk(receiver, ms, amplitude = SPEECH, userId = 'u1') {
  for (let t = 0; t < ms; t += 20) {
    receiver.packet(userId, frame(amplitude));
    await sleep(20);
  }
}

async function waitFor(pred, timeoutMs, stepMs = 20) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return Date.now() - t0;
    await sleep(stepMs);
  }
  return -1;
}

module.exports = { setup, talk, waitFor, sleep, frame, SPEECH, BREATH, FRAME_BYTES };
