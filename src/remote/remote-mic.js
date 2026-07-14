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
 *                          drives the button UI + activation/stop chimes so
 *                          the remote speaker gets the same audible feedback
 *                          a local user would.
 *
 * UI: a floating mic button (bottom-left). Grey = off, green pulse = streaming
 * (wake listening), yellow = capturing a command, blue = transcribing,
 * red ring = mic permission denied / mic taken by another client.
 */
(() => {
    'use strict';

    if (typeof window === 'undefined' || !window.__CCBOT_REMOTE__) return;

    const TARGET_RATE = 16000;
    const FRAME_SAMPLES = 1360; // ~85ms @ 16kHz — mirrors the desktop frame duration

    const state = {
        streaming: false,     // mic on (either real capture or test mode)
        testMode: false,      // streaming via the test hook, no real audio graph
        denied: false,        // getUserMedia refused or server denied ownership
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

    async function start() {
        if (state.streaming) return true;
        state.denied = false;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
        } catch (err) {
            console.error('[remote-mic] microphone permission denied / unavailable:', err && err.message);
            state.denied = true;
            renderButton();
            return false;
        }
        state.stream = stream;
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

    const MIC_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>';

    let btn = null;

    function injectUi() {
        if (btn || !document.body) return;
        const style = document.createElement('style');
        style.textContent = `
            #remote-mic-btn {
                position: fixed; left: 14px; bottom: 14px; z-index: 10050;
                width: 40px; height: 40px; border-radius: 50%;
                border: 1px solid rgba(128,128,128,.45);
                background: rgba(30,30,30,.85); color: #bbb;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; transition: background .15s, color .15s, box-shadow .15s;
            }
            #remote-mic-btn:hover { color: #fff; }
            #remote-mic-btn.on { color: #28ca42; border-color: #28ca42; animation: ccbot-mic-pulse 1.6s ease-in-out infinite; }
            #remote-mic-btn.capturing { color: #f6c945; border-color: #f6c945; animation: none; box-shadow: 0 0 10px rgba(246,201,69,.7); }
            #remote-mic-btn.transcribing { color: #4aa3ff; border-color: #4aa3ff; animation: none; box-shadow: 0 0 10px rgba(74,163,255,.7); }
            #remote-mic-btn.denied { color: #ff5f57; border-color: #ff5f57; animation: none; }
            @keyframes ccbot-mic-pulse {
                0%, 100% { box-shadow: 0 0 4px rgba(40,202,66,.5); }
                50% { box-shadow: 0 0 14px rgba(40,202,66,.9); }
            }
        `;
        document.head.appendChild(style);
        btn = document.createElement('button');
        btn.id = 'remote-mic-btn';
        btn.type = 'button';
        btn.innerHTML = MIC_SVG;
        btn.addEventListener('click', () => {
            if (state.streaming) stop('user toggled off');
            else start();
        });
        document.body.appendChild(btn);
        renderButton();
    }

    function renderButton() {
        if (!btn) return;
        btn.classList.toggle('on', state.streaming && state.wakeState !== 'capturing' && state.wakeState !== 'transcribing');
        btn.classList.toggle('capturing', state.streaming && state.wakeState === 'capturing');
        btn.classList.toggle('transcribing', state.streaming && state.wakeState === 'transcribing');
        btn.classList.toggle('denied', !state.streaming && state.denied);
        btn.title = state.streaming
            ? (state.wakeState === 'capturing' ? 'Desktop is capturing your command — click to stop the mic'
                : state.wakeState === 'transcribing' ? 'Desktop is transcribing…'
                    : 'Mic is streaming to the desktop voice pipeline (say the wake phrase) — click to stop')
            : (state.denied ? 'Mic unavailable (permission denied or another viewer owns it) — click to retry'
                : 'Send this device\'s microphone to the desktop voice pipeline');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectUi);
    } else {
        injectUi();
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
