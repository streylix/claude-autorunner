'use strict';

// Tests for WakeWordManager's remote-source mode (Remote Mode client mic
// forwarding, docs/REMOTE_MODE.md §10):
//   - attachRemoteSource() with the local wake word OFF starts a REMOTE-ONLY
//     session (model + recognizer, NO local getUserMedia).
//   - pushRemotePcm() feeds the recognizer with the remote frames + rate.
//   - which-mic rule: local mic frames are IGNORED while a remote source is
//     attached (and processed again after detach).
//   - wake match on the remote stream → remote capture (PCM accumulation, no
//     MediaRecorder) → VAD silence stop → PCM16 WAV → voiceManager.transcribeBlob
//     → the framed voice memo queued to the manager (999, urgent).
//   - no-speech timeout closes a remote capture quietly (nothing transcribed).
//   - detachRemoteSource() returns the pipeline to idle (remote-only session).
//
// Run: node --test src/features/WakeWordManager.remote-source.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const WakeWordManager = require('./WakeWordManager');

// ---- helpers ---------------------------------------------------------------

function makeEventBus() {
    const handlers = new Map();
    const emitted = [];
    return {
        emitted,
        on(ev, fn) {
            if (!handlers.has(ev)) handlers.set(ev, []);
            handlers.get(ev).push(fn);
        },
        emit(ev, payload) {
            emitted.push({ ev, payload });
            (handlers.get(ev) || []).forEach((fn) => fn(payload));
        }
    };
}

function makeGui() {
    const calls = { transcribed: [], queued: [] };
    return {
        calls,
        voiceManager: {
            getSupportedMimeType: () => 'audio/webm',
            transcribeBlob: async (blob, mime) => {
                calls.transcribed.push({ blob, mime });
                return 'remote transcript from whisper';
            }
        },
        messageQueueManager: {
            addMessage: (m) => calls.queued.push(m)
        },
        managerInstance: { running: true }
    };
}

class FakeRecognizer {
    constructor(rate, log) {
        this.rate = rate;
        this.log = log;
        this.handlers = {};
        this.removed = false;
    }
    setWords() {}
    on(ev, fn) { this.handlers[ev] = fn; }
    acceptWaveformFloat(f32, rate) { this.log.push({ len: f32.length, rate }); }
    remove() { this.removed = true; }
}

function makeWwm() {
    const eventBus = makeEventBus();
    const gui = makeGui();
    const wwm = new WakeWordManager(eventBus, {}, gui);
    const accepts = [];
    // Pre-seed a fake model so _loadModel() (fs read + WASM) is skipped.
    wwm.model = { KaldiRecognizer: class extends FakeRecognizer { constructor(rate) { super(rate, accepts); } } };
    return { wwm, eventBus, gui, accepts };
}

function loudFrame(n = 1360, amp = 0.3) {
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = amp * Math.sin(i / 3);
    return f;
}

const silentFrame = (n = 1360) => new Float32Array(n);

function fireWake(wwm) {
    wwm.recognizer.handlers.result({
        result: { text: 'hey claude', result: [{ word: 'hey', conf: 1 }, { word: 'claude', conf: 1 }] }
    });
}

const until = async (fn, ms = 4000, what = 'condition') => {
    const deadline = Date.now() + ms;
    while (!fn()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
        await new Promise((r) => setTimeout(r, 25));
    }
};

// ---- tests -----------------------------------------------------------------

test('attachRemoteSource starts a remote-only session (no local mic) and feeds the recognizer', async () => {
    const { wwm, accepts } = makeWwm();
    assert.strictEqual(wwm.state, 'idle');
    await wwm.attachRemoteSource();
    assert.strictEqual(wwm.state, 'listening');
    assert.strictEqual(wwm._remoteOnly, true);
    assert.strictEqual(wwm.audioStream, null, 'no getUserMedia in remote-only mode');

    wwm.pushRemotePcm(loudFrame(), 16000);
    assert.strictEqual(accepts.length, 1);
    assert.strictEqual(accepts[0].len, 1360);
    assert.strictEqual(accepts[0].rate, 16000);
    wwm.detachRemoteSource();
    assert.strictEqual(wwm.state, 'idle');
});

test('which-mic rule: local frames are ignored while remote is attached, resume after detach', async () => {
    const { wwm, accepts } = makeWwm();
    await wwm.attachRemoteSource();
    wwm.audioContext = { sampleRate: 48000 }; // what a live local session would have

    wwm._onAudioFrame(loudFrame(4096));
    assert.strictEqual(accepts.length, 0, 'local frame must NOT reach the recognizer while remote is attached');

    wwm.pushRemotePcm(loudFrame(), 16000);
    assert.strictEqual(accepts.length, 1, 'remote frame IS the input');

    // Detach while the local session (enabled) keeps running → local frames flow again.
    wwm._remoteOnly = false; // simulate "remote attached over a live local session"
    wwm.enabled = true;
    wwm.detachRemoteSource();
    wwm.state = 'listening';
    wwm._onAudioFrame(loudFrame(4096));
    assert.strictEqual(accepts.length, 2, 'local frames processed again after detach');
    assert.strictEqual(accepts[2 - 1].rate, 48000);
});

test('remote wake → capture → silence stop → WAV to Whisper → memo queued to 999', async () => {
    const { wwm, gui } = makeWwm();
    await wwm.attachRemoteSource();
    wwm.silenceMs = 250; // fast trailing-silence stop for the test

    fireWake(wwm);
    assert.strictEqual(wwm.state, 'capturing');
    assert.strictEqual(wwm._remoteCapture, true);
    assert.strictEqual(wwm.mediaRecorder, null, 'no MediaRecorder for a network source');

    // Speak: 6 loud frames (~0.5s), then trailing silence frames.
    const spoken = [];
    for (let i = 0; i < 6; i++) {
        const f = loudFrame();
        spoken.push(f);
        wwm.pushRemotePcm(f, 16000);
    }
    const silenceTimer = setInterval(() => wwm.pushRemotePcm(silentFrame(), 16000), 85);

    await until(() => gui.calls.queued.length > 0, 5000, 'voice memo queued');
    clearInterval(silenceTimer);

    // Whisper got a real WAV of the captured PCM.
    assert.strictEqual(gui.calls.transcribed.length, 1);
    const { blob, mime } = gui.calls.transcribed[0];
    assert.strictEqual(mime, 'audio/wav');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    assert.strictEqual(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
    assert.strictEqual(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
    assert.strictEqual(view.getUint32(24, true), 16000, 'sample rate 16k');
    assert.strictEqual(view.getUint16(22, true), 1, 'mono');
    // The spoken frames are in the data chunk, sample-exact (PCM16 of the floats).
    const expectFirst = Math.max(-32768, Math.min(32767, Math.round(spoken[0][1] * 32768)));
    assert.strictEqual(view.getInt16(44 + 2, true), expectFirst, 'captured PCM is byte-faithful');

    // The memo reached the manager, framed, urgent.
    const memo = gui.calls.queued[0];
    assert.strictEqual(memo.terminalId, 999);
    assert.strictEqual(memo.type, 'urgent');
    assert.ok(memo.content.includes('🎙️ Voice memo from the user'));
    assert.ok(memo.content.includes('remote transcript from whisper'));

    // And the pipeline resumed listening on the remote stream.
    await until(() => wwm.state === 'listening', 2000, 'resume listening');
});

test('remote capture with no speech closes quietly (nothing transcribed, nothing queued)', async () => {
    const { wwm, gui } = makeWwm();
    await wwm.attachRemoteSource();
    fireWake(wwm);
    assert.strictEqual(wwm.state, 'capturing');
    wwm._noSpeechMs = 300; // shrink the pre-speech window for the test
    const silenceTimer = setInterval(() => wwm.pushRemotePcm(silentFrame(), 16000), 85);
    await until(() => wwm.state === 'listening', 3000, 'quiet close back to listening');
    clearInterval(silenceTimer);
    assert.strictEqual(gui.calls.transcribed.length, 0);
    assert.strictEqual(gui.calls.queued.length, 0);
});

test('detach mid-capture discards the capture; remote-only session tears down to idle', async () => {
    const { wwm, gui, eventBus } = makeWwm();
    await wwm.attachRemoteSource();
    fireWake(wwm);
    for (let i = 0; i < 6; i++) wwm.pushRemotePcm(loudFrame(), 16000);
    assert.strictEqual(wwm.state, 'capturing');

    wwm.detachRemoteSource();
    assert.strictEqual(wwm.state, 'idle');
    assert.strictEqual(wwm._remoteCapture, false);
    assert.strictEqual(wwm._remotePcm.length, 0);
    assert.strictEqual(gui.calls.transcribed.length, 0, 'discarded — never sent to Whisper');
    assert.ok(eventBus.emitted.some((e) => e.ev === 'wake:state' && e.payload.state === 'idle'));
});

test('local-only behavior is untouched when no remote source was ever attached', () => {
    const { wwm, accepts } = makeWwm();
    // Simulate a live local session.
    wwm.state = 'listening';
    wwm.audioContext = { sampleRate: 48000 };
    return (async () => {
        await wwm._rebuildRecognizer();
        wwm._onAudioFrame(loudFrame(4096));
        assert.strictEqual(accepts.length, 1);
        assert.strictEqual(accepts[0].rate, 48000);
        // pushRemotePcm is inert without an attached source.
        wwm.pushRemotePcm(loudFrame(), 16000);
        assert.strictEqual(accepts.length, 1);
    })();
});
