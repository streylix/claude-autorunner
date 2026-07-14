/**
 * remote-mic - CLIENT-side microphone forwarding for web-served Remote Mode
 * (docs/REMOTE_MODE.md §10). The INPUT mirror of the TTS output forwarder.
 *
 * Loaded by the RemoteServer-transformed index.html right after
 * remote-bootstrap.js, so it only ever runs in a Remote Mode browser client
 * (window.__CCBOT_REMOTE__ is set). It captures THIS device's microphone and
 * streams it to the app host, where the desktop's EXISTING voice pipeline
 * (Vosk wake word + Whisper transcription, both in the local renderer)
 * processes it:
 *
 *   getUserMedia ─▶ AudioWorklet tap (ScriptProcessor fallback)
 *        │  Float32 @ ctx rate ─▶ downsample to 16 kHz mono ─▶ PCM16
 *        ▼
 *   { t:'send', channel:'remote-mic-frame',
 *     args:[{ seq, rate:16000, pcm16:'<base64>' }] }        (client → server)
 *   { t:'send', channel:'remote-mic-state', args:[{active}] }
 *
 * over the SAME authenticated WebSocket that carries the whole interface — no
 * new ports, no new auth surface. 16 kHz PCM16 mono is ~32 KB/s (~43 KB/s as
 * base64): negligible next to terminal traffic.
 *
 * Frames are ~85 ms (1360 samples @16 kHz) to match the duration of the
 * desktop pipeline's own ScriptProcessor frames (4096 @48 kHz), so the
 * server-side VAD's sustained-run tuning behaves identically for remote audio.
 *
 * Server pushes consumed here:
 *   'remote-mic-denied'  — another client already streams its mic; turn off.
 *   'remote-wake-state'  — the desktop wake pipeline's state while OUR mic is
 *                          the source (listening/capturing/transcribing);
 *                          drives the voice-button glow + activation/stop
 *                          chimes so the remote speaker gets the same audible
 *                          feedback a local user would.
 *
 * UI: NO floating button (it used to overlap the message input). The single
 * mic control is Settings → Microphone: picking one of THIS device's inputs
 * starts the stream (and persists, so it auto-resumes on the next connect);
 * picking "Off" stops it. While streaming, the app's own voice button
 * (#voice-btn) carries a colored glow: green = wake listening, yellow =
 * capturing a command, blue = transcribing, red = denied.
 */
(() => {
    'use strict';

    if (typeof window === 'undefined' || !window.__CCBOT_REMOTE__) return;

    const TARGET_RATE = 16000;
    const FRAME_SAMPLES = 1360; // ~85ms @ 16kHz — mirrors the desktop frame duration

    // Which of THIS browser's inputs to capture. Chosen in Settings → Microphone
    // (the remote view's picker lists the VIEWING device's mics, never the
    // desktop's) and persisted per-browser — it is meaningless to any other
    // machine, so it never touches the desktop's microphoneDeviceId preference.
    const DEVICE_KEY = 'ccbotRemoteMicDeviceId';
    // null = the viewer never chose (no auto-start — streaming a mic without an
    // explicit opt-in would be wrong); 'off' = explicitly off; 'default' or a
    // real deviceId = stream that input, and auto-resume it on reconnect.
    function loadDeviceId() {
        try { return window.localStorage.getItem(DEVICE_KEY); } catch (_) { return null; }
    }

    const state = {
        streaming: false,     // mic on (either real capture or test mode)
        testMode: false,      // streaming via the test hook, no real audio graph
        denied: false,        // getUserMedia refused or server denied ownership
        deviceId: loadDeviceId() || 'default', // 'default' = browser default input
        activeLabel: null,    // label of the track actually captured (evidence/UI)
        stream: null,
        ctx: null,
        sourceNode: null,
        tapNode: null,        // AudioWorkletNode or ScriptProcessorNode
        pending: new Float32Array(0), // <FRAME_SAMPLES leftover awaiting next tap
        resamplePos: 0,       // fractional read position for the downsampler
        seq: 0,
        // Delivery-proof counters (compared against the server side in tests):
        // hash folds every Int16 sample sent, in order: h = (h*31 + s) | 0.
        sent: { frames: 0, samples: 0, hash: 0 },
        wakeState: null,
        sounds: { activation: 'screenshot.wav', stop: 'hud4.wav' }
    };

    const ipc = () => (window.__ccbotRemote && window.__ccbotRemote.wsIpc) || null;

    // ---- PCM helpers -------------------------------------------------------

    /** Lossless-roundtrip Float32 [-1,1] -> Int16 (i/32768 -> round(f*32768)). */
    function floatToInt16(f32) {
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
            let s = Math.round(f32[i] * 32768);
            if (s > 32767) s = 32767;
            else if (s < -32768) s = -32768;
            out[i] = s;
        }
        return out;
    }

    function int16ToBase64(i16) {
        const bytes = new Uint8Array(i16.buffer, i16.byteOffset, i16.length * 2);
        let bin = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(bin);
    }

    /** Linear-interpolation downsample Float32 from `fromRate` to 16 kHz. */
    function downsampleTo16k(f32, fromRate) {
        if (fromRate === TARGET_RATE) return f32;
        const ratio = fromRate / TARGET_RATE;
        const outLen = Math.floor((f32.length - state.resamplePos) / ratio);
        const out = new Float32Array(Math.max(0, outLen));
        let pos = state.resamplePos;
        for (let i = 0; i < out.length; i++) {
            const i0 = Math.floor(pos);
            const i1 = Math.min(i0 + 1, f32.length - 1);
            const frac = pos - i0;
            out[i] = f32[i0] * (1 - frac) + f32[i1] * frac;
            pos += ratio;
        }
        state.resamplePos = pos - f32.length; // carry the fraction into the next block
        return out;
    }

    // ---- frame emission ----------------------------------------------------

    /** Send one Int16 frame over the WS and fold it into the delivery hash. */
    function sendFrame(i16) {
        const bridge = ipc();
        if (!bridge) return;
        let h = state.sent.hash;
        for (let i = 0; i < i16.length; i++) h = (Math.imul(h, 31) + i16[i]) | 0;
        state.sent.hash = h;
        state.sent.frames++;
        state.sent.samples += i16.length;
        bridge.send('remote-mic-frame', {
            seq: state.seq++,
            rate: TARGET_RATE,
            pcm16: int16ToBase64(i16)
        });
    }

    /** Accept a Float32 block at 16 kHz, chunk it into FRAME_SAMPLES frames. */
    function push16k(f32) {
        if (!state.streaming || !f32 || !f32.length) return;
        const merged = new Float32Array(state.pending.length + f32.length);
        merged.set(state.pending, 0);
        merged.set(f32, state.pending.length);
        let off = 0;
        while (merged.length - off >= FRAME_SAMPLES) {
            sendFrame(floatToInt16(merged.subarray(off, off + FRAME_SAMPLES)));
            off += FRAME_SAMPLES;
        }
        state.pending = merged.slice(off);
    }

    /** Raw tap callback at the AudioContext's native rate. */
    function onTapBlock(f32) {
        if (!state.streaming || state.testMode) return;
        push16k(downsampleTo16k(f32, state.ctx ? state.ctx.sampleRate : TARGET_RATE));
    }

    // ---- capture lifecycle -------------------------------------------------

    const WORKLET_SRC = `
        class CcbotMicTap extends AudioWorkletProcessor {
            process(inputs) {
                const ch = inputs[0] && inputs[0][0];
                if (ch && ch.length) this.port.postMessage(ch.slice(0));
                return true;
            }
        }
        registerProcessor('ccbot-mic-tap', CcbotMicTap);
    `;

    function buildAudioConstraints() {
        const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        if (state.deviceId && state.deviceId !== 'default' && state.deviceId !== 'off') {
            return Object.assign({ deviceId: { exact: state.deviceId } }, base);
        }
        return base;
    }

    async function start() {
        if (state.streaming) return true;
        state.denied = false;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: buildAudioConstraints() });
        } catch (err) {
            // Selected device gone (unplugged, stale id from a previous session):
            // fall back to the browser default rather than failing the stream.
            const gone = err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError');
            if (gone && state.deviceId !== 'default') {
                console.warn('[remote-mic] selected input unavailable — falling back to the default device');
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
                    });
                } catch (err2) {
                    console.error('[remote-mic] microphone permission denied / unavailable:', err2 && err2.message);
                    state.denied = true;
                    renderButton();
                    return false;
                }
            } else {
                console.error('[remote-mic] microphone permission denied / unavailable:', err && err.message);
                state.denied = true;
                renderButton();
                return false;
            }
        }
        state.stream = stream;
        const track = stream.getAudioTracks && stream.getAudioTracks()[0];
        state.activeLabel = (track && track.label) || null;
        if (state.activeLabel) console.log('[remote-mic] capturing input device: ' + state.activeLabel);
        // Ask for 16 kHz directly; browsers that ignore it are handled by the
        // downsampler (ctx.sampleRate is always consulted).
        try { state.ctx = new AudioContext({ sampleRate: TARGET_RATE }); } catch (_) { state.ctx = new AudioContext(); }
        try { await state.ctx.resume(); } catch (_) { /* ignore */ }
        state.sourceNode = state.ctx.createMediaStreamSource(stream);
        state.pending = new Float32Array(0);
        state.resamplePos = 0;
        state.sent = { frames: 0, samples: 0, hash: 0 }; // fresh delivery counters per session

        let wired = false;
        if (state.ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
            try {
                const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
                // addModule can hang forever on stripped builds (e.g. headless
                // test shells) — race it so the ScriptProcessor fallback always
                // gets its turn instead of wedging the mic button.
                await Promise.race([
                    state.ctx.audioWorklet.addModule(url),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('audioWorklet.addModule timed out')), 4000))
                ]);
                state.tapNode = new AudioWorkletNode(state.ctx, 'ccbot-mic-tap', {
                    numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1
                });
                state.tapNode.port.onmessage = (e) => onTapBlock(e.data);
                state.sourceNode.connect(state.tapNode);
                // Keep the graph alive without echoing the mic to the speakers.
                const sink = state.ctx.createGain();
                sink.gain.value = 0;
                state.tapNode.connect(sink);
                sink.connect(state.ctx.destination);
                wired = true;
            } catch (err) {
                console.warn('[remote-mic] AudioWorklet unavailable, falling back to ScriptProcessor:', err && err.message);
            }
        }
        if (!wired) {
            const proc = state.ctx.createScriptProcessor(4096, 1, 1);
            proc.onaudioprocess = (e) => onTapBlock(e.inputBuffer.getChannelData(0).slice(0));
            const sink = state.ctx.createGain();
            sink.gain.value = 0;
            state.sourceNode.connect(proc);
            proc.connect(sink);
            sink.connect(state.ctx.destination);
            state.tapNode = proc;
        }

        state.streaming = true;
        state.testMode = false;
        const bridge = ipc();
        if (bridge) bridge.send('remote-mic-state', { active: true });
        console.log('[remote-mic] streaming ON — this device\'s microphone now feeds the desktop voice pipeline');
        renderButton();
        return true;
    }

    function stop(reason) {
        if (!state.streaming) return;
        state.streaming = false;
        state.testMode = false;
        state.wakeState = null;
        try { if (state.tapNode) { state.tapNode.disconnect(); if (state.tapNode.port) state.tapNode.port.onmessage = null; } } catch (_) { /* ignore */ }
        try { if (state.sourceNode) state.sourceNode.disconnect(); } catch (_) { /* ignore */ }
        try { if (state.ctx) state.ctx.close(); } catch (_) { /* ignore */ }
        try { if (state.stream) state.stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* ignore */ }
        state.tapNode = null;
        state.sourceNode = null;
        state.ctx = null;
        state.stream = null;
        state.activeLabel = null;
        state.pending = new Float32Array(0);
        const bridge = ipc();
        if (bridge) bridge.send('remote-mic-state', { active: false });
        console.log('[remote-mic] streaming OFF' + (reason ? ' (' + reason + ')' : ''));
        renderButton();
    }

    // ---- server pushes -----------------------------------------------------

    function wirePushes() {
        const bridge = ipc();
        if (!bridge) { setTimeout(wirePushes, 250); return; }
        bridge.on('remote-mic-denied', (_e, payload) => {
            console.warn('[remote-mic] denied by server:', (payload && payload.reason) || 'unknown');
            state.denied = true;
            stop('denied: ' + ((payload && payload.reason) || 'another client owns the mic'));
        });
        bridge.on('remote-wake-state', (_e, payload) => {
            if (!state.streaming || !payload) return;
            const prev = state.wakeState;
            state.wakeState = payload.state || null;
            if (payload.activationSound) state.sounds.activation = payload.activationSound;
            if (payload.stopSound) state.sounds.stop = payload.stopSound;
            // Audible feedback on THIS device (the desktop's own chimes play on
            // the app host where nobody is listening).
            if (state.wakeState === 'capturing' && prev !== 'capturing') chime(state.sounds.activation);
            if (state.wakeState === 'transcribing' && prev !== 'transcribing') chime(state.sounds.stop);
            console.log('[remote-mic] desktop wake pipeline: ' + state.wakeState);
            renderButton();
        });
    }

    function chime(file) {
        if (!file) return;
        try {
            const a = new Audio('assets/soundeffects/' + file); // served by the RemoteServer
            a.volume = 0.6;
            a.play().catch(() => {});
        } catch (_) { /* ignore */ }
    }

    // ---- UI ----------------------------------------------------------------
    // No floating button (it overlapped the message input). The stream is
    // controlled from Settings → Microphone; the app's own voice button just
    // carries a colored glow so the viewer can see the wake pipeline's state.

    function injectUi() {
        if (!document.body || document.getElementById('ccbot-remote-mic-style')) return;
        const style = document.createElement('style');
        style.id = 'ccbot-remote-mic-style';
        style.textContent = `
            #voice-btn.remote-wake-on { color: #28ca42 !important; animation: ccbot-mic-pulse 1.6s ease-in-out infinite; border-radius: 6px; }
            #voice-btn.remote-wake-capturing { color: #f6c945 !important; animation: none; box-shadow: 0 0 10px rgba(246,201,69,.7); border-radius: 6px; }
            #voice-btn.remote-wake-transcribing { color: #4aa3ff !important; animation: none; box-shadow: 0 0 10px rgba(74,163,255,.7); border-radius: 6px; }
            #voice-btn.remote-wake-denied { color: #ff5f57 !important; animation: none; }
            @keyframes ccbot-mic-pulse {
                0%, 100% { box-shadow: 0 0 4px rgba(40,202,66,.5); }
                50% { box-shadow: 0 0 12px rgba(40,202,66,.9); }
            }
        `;
        document.head.appendChild(style);
        renderButton();
    }

    /** Reflect streaming/wake state as a glow on the app's own voice button. */
    function renderButton() {
        const btn = document.getElementById('voice-btn');
        if (!btn) return;
        btn.classList.toggle('remote-wake-on', state.streaming && state.wakeState !== 'capturing' && state.wakeState !== 'transcribing');
        btn.classList.toggle('remote-wake-capturing', state.streaming && state.wakeState === 'capturing');
        btn.classList.toggle('remote-wake-transcribing', state.streaming && state.wakeState === 'transcribing');
        btn.classList.toggle('remote-wake-denied', !state.streaming && state.denied);
        if (state.streaming) {
            btn.title = state.wakeState === 'capturing' ? 'Desktop is capturing your command…'
                : state.wakeState === 'transcribing' ? 'Desktop is transcribing…'
                    : 'This device\'s mic feeds the desktop voice pipeline (say the wake phrase). Turn off in Settings → Microphone.';
        } else if (state.denied) {
            btn.title = 'Remote mic unavailable (permission denied or another viewer owns it) — reselect it in Settings → Microphone to retry';
        }
    }

    /**
     * Auto-resume: the mic choice is an explicit, persisted opt-in — if this
     * browser picked an input before (and didn't pick "Off"), start streaming
     * as soon as the page is up so the wake word works without reopening
     * Settings on every connect. Never auto-starts for a first-time viewer.
     */
    function autoResume() {
        const saved = loadDeviceId();
        if (!saved || saved === 'off') return;
        start().catch(() => { /* denied/unavailable — state.denied already set */ });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { injectUi(); autoResume(); });
    } else {
        injectUi();
        autoResume();
    }
    wirePushes();

    // ---- test hooks (used by tests/integration/remote-mic-e2e.js) -----------
    // startTest() opens the streaming session WITHOUT a real microphone;
    // injectPcm16() then pushes known PCM through the exact same chunk/encode/
    // send path a live capture uses (only getUserMedia + the worklet tap are
    // bypassed — real acoustic capture is impossible on a headless box).
    window.__ccbotRemoteMic = {
        start,
        stop,
        /**
         * Select which of THIS browser's inputs to capture (Settings →
         * Microphone drives this in the remote view). Persists per-browser.
         * Streaming already? Restart the capture on the new device. Not
         * streaming yet? Start it — picking a mic IS the intent to use it,
         * which also arms wake-word listening on the desktop pipeline.
         * 'off' stops the stream (and stays off across reconnects).
         */
        async setDevice(deviceId) {
            const v = deviceId === 'off' ? 'off'
                : (deviceId && deviceId !== 'default') ? String(deviceId) : 'default';
            state.deviceId = v;
            try { window.localStorage.setItem(DEVICE_KEY, v); } catch (_) { /* private mode */ }
            if (state.testMode) return true; // tests drive frames directly — nothing to recapture
            if (v === 'off') {
                stop('turned off in settings');
                state.denied = false;
                renderButton();
                return false;
            }
            if (state.streaming) stop('switching input device');
            return start();
        },
        getDevice: () => state.deviceId,
        activeLabel: () => state.activeLabel,
        isStreaming: () => state.streaming,
        stats: () => ({ frames: state.sent.frames, samples: state.sent.samples, hash: state.sent.hash, seq: state.seq }),
        wakeState: () => state.wakeState,
        isDenied: () => state.denied,
        startTest() {
            if (state.streaming) return false;
            state.streaming = true;
            state.testMode = true;
            state.denied = false;
            state.pending = new Float32Array(0);
            state.sent = { frames: 0, samples: 0, hash: 0 };
            const bridge = ipc();
            if (bridge) bridge.send('remote-mic-state', { active: true });
            renderButton();
            return true;
        },
        /**
         * Feed base64 PCM16 @16 kHz through the send path, paced in real time
         * (one ~85 ms frame per 85 ms) so the desktop VAD sees a live-shaped
         * stream. Resolves when everything (plus trailing silence) is sent.
         */
        async injectPcm16(base64, opts = {}) {
            if (!state.streaming) throw new Error('mic not streaming');
            const bin = atob(base64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const i16 = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
            const f32 = new Float32Array(i16.length);
            for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
            const silenceMs = Number(opts.trailingSilenceMs || 0);
            const silence = new Float32Array(Math.floor((silenceMs / 1000) * TARGET_RATE));
            const all = new Float32Array(f32.length + silence.length);
            all.set(f32, 0);
            all.set(silence, f32.length);
            const frameMs = (FRAME_SAMPLES / TARGET_RATE) * 1000;
            for (let off = 0; off < all.length; off += FRAME_SAMPLES) {
                if (!state.streaming) break;
                push16k(all.subarray(off, Math.min(off + FRAME_SAMPLES, all.length)));
                await new Promise((r) => setTimeout(r, opts.fast ? 0 : frameMs));
            }
        }
    };
})();
