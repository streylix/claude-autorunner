/**
 * RemoteMicSink - LOCAL-renderer end of Remote Mode client microphone
 * forwarding (docs/REMOTE_MODE.md §10). The INPUT mirror of the TTS output
 * forwarder: where TtsRemoteForwarder pushes desktop audio OUT to the viewer,
 * this pulls the viewer's microphone IN and feeds it to the desktop's
 * EXISTING voice pipeline.
 *
 * Path: browser client (remote-mic.js) → authenticated WS ('remote-mic-state'
 * / 'remote-mic-frame') → main (relay to the LOCAL window only) → here →
 * WakeWordManager.attachRemoteSource()/pushRemotePcm(). Wake-word detection
 * (Vosk) and Whisper transcription then run exactly where they always have:
 * in THIS renderer, on the app host.
 *
 * Which-mic rule (mirror of the output double-play rule): while a remote
 * client is streaming its mic, THAT stream is the pipeline's input and the
 * local microphone is ignored; when no remote mic is attached, local behavior
 * is exactly as before.
 *
 * Also forwards the wake pipeline's state ('wake:state' → 'remote-wake-state'
 * via main) back to the streaming client while its mic is the source, so the
 * remote speaker gets button feedback + activation/stop chimes on THEIR device.
 *
 * LOCAL renderer only — never constructed in a Remote Mode client renderer.
 */

// ipcRenderer, lazily: the real one in the local Electron renderer, null in
// unit tests (same pattern as NotificationManager).
function getIpcRenderer() {
    try { return require('electron').ipcRenderer; } catch (_) { return null; }
}

class RemoteMicSink {
    /**
     * @param {Object} eventBus - the renderer EventBus (wake:state feed)
     * @param {Object} gui      - TerminalGUI orchestrator (reaches wakeWordManager)
     */
    constructor(eventBus, gui) {
        this.eventBus = eventBus;
        this.gui = gui;
        this.active = false;      // a remote client's mic is currently attached
        // Delivery-proof counters (mirror of the client's `sent` stats; the
        // e2e harness compares the two to prove byte-faithful arrival).
        this.stats = { frames: 0, samples: 0, hash: 0 };
    }

    initialize() {
        const ipc = getIpcRenderer();
        if (!ipc) return;
        ipc.on('remote-mic-state', (_event, payload) => this._setActive(!!(payload && payload.active), payload && payload.reason));
        ipc.on('remote-mic-frame', (_event, payload) => this._onFrame(payload));
        // While the remote mic is the source, mirror the wake pipeline's state
        // out to the streaming client (chimes + button feedback on its device).
        this.eventBus.on('wake:state', (payload) => {
            if (!this.active) return;
            this._sendWakeState((payload && payload.state) || 'idle');
        });
    }

    _setActive(active, reason) {
        if (this.active === active) return;
        this.active = active;
        const wwm = this.gui && this.gui.wakeWordManager;
        if (active) {
            this.stats = { frames: 0, samples: 0, hash: 0 };
            this._log('🎙️ Remote viewer microphone attached — desktop voice pipeline now listens to the remote stream', 'info');
            if (wwm && typeof wwm.attachRemoteSource === 'function') {
                Promise.resolve(wwm.attachRemoteSource()).catch(() => {});
            }
        } else {
            this._log('🎙️ Remote viewer microphone detached' + (reason ? ` (${reason})` : '') + ' — local microphone behavior restored', 'info');
            if (wwm && typeof wwm.detachRemoteSource === 'function') wwm.detachRemoteSource();
        }
    }

    _onFrame(payload) {
        if (!this.active || !payload || typeof payload.pcm16 !== 'string') return;
        let f32;
        try {
            f32 = this._decodeFrame(payload.pcm16);
        } catch (_) {
            return; // malformed frame — drop, never break the pipeline
        }
        if (!f32 || !f32.length) return;
        const wwm = this.gui && this.gui.wakeWordManager;
        if (wwm && typeof wwm.pushRemotePcm === 'function') {
            wwm.pushRemotePcm(f32, Number(payload.rate) || 16000);
        }
    }

    /** base64 PCM16 → Float32 [-1,1); folds samples into the delivery hash. */
    _decodeFrame(b64) {
        const buf = Buffer.from(b64, 'base64');
        const n = Math.floor(buf.length / 2);
        const f32 = new Float32Array(n);
        let h = this.stats.hash;
        for (let i = 0; i < n; i++) {
            const s = buf.readInt16LE(i * 2);
            h = (Math.imul(h, 31) + s) | 0;
            f32[i] = s / 32768;
        }
        this.stats.hash = h;
        this.stats.frames++;
        this.stats.samples += n;
        return f32;
    }

    _sendWakeState(state) {
        const ipc = getIpcRenderer();
        if (!ipc) return;
        const wwm = this.gui && this.gui.wakeWordManager;
        try {
            ipc.send('remote-wake-state', {
                state,
                // Let the client play the SAME configured chimes a local user hears.
                activationSound: (wwm && wwm.activationSound) || null,
                stopSound: (wwm && wwm.stopSound) || null
            });
        } catch (_) { /* ignore */ }
    }

    _log(message, type = 'info') {
        try { this.eventBus.emit('log:action', { message, type }); } catch (_) { /* ignore */ }
    }
}

module.exports = RemoteMicSink;
