/**
 * WakeWordManager — always-on "Hey Claude" voice activation.
 *
 * Pipeline (all in the renderer; keeps running while the app is hidden/unfocused
 * because the BrowserWindow sets backgroundThrottling:false):
 *
 *   mic ─▶ vosk-browser (WASM worker, OPEN-VOCABULARY transcription)
 *              │ final result contains the wake phrase as whole words + clears
 *              │ the confidence threshold → phrase matched
 *              ▼
 *     1. play activation chime           (default screenshot.wav)
 *     2. capture the command             (same mic stream + MediaRecorder)
 *        └ VAD: stop after `silenceMs` of silence, or `maxCommandMs` hard cap
 *     3. play stop chime                 (default hud4.wav)
 *     4. transcribe ONCE                 (VoiceManager.transcribeBlob → Whisper)
 *     5. frame as a voice memo and queue it to the manager (terminal 999, urgent)
 *     6. resume listening
 *
 * The continuous spotter is cheap (Vosk with a restricted grammar); the expensive
 * Whisper pass runs exactly once per command, not continuously.
 *
 * Constructed with (eventBus, appStateStore, gui) — `gui` is the TerminalGUI
 * orchestrator, used to reach soundManager / voiceManager / messageQueueManager.
 */
const fs = require('fs');
const path = require('path');

const MANAGER_TERMINAL_ID = 999;
const MODEL_PATH = path.join(__dirname, '..', '..', 'assets', 'models', 'vosk-model-small-en-us.tar.gz');
const SOUND_DIR = 'assets/soundeffects/'; // renderer-relative (matches SoundManager)

// VAD tuning.
const RMS_VOICE_THRESHOLD = 0.015; // frame RMS above this counts as speech
const NO_SPEECH_TIMEOUT_MS = 8000; // if nothing is said after activation, bail
const FRAME_SIZE = 4096;           // ScriptProcessor buffer (~85ms @ 48kHz)

class WakeWordManager {
    constructor(eventBus, appStateStore, gui) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        this.gui = gui;

        // Config (persisted as preferences; defaults below match index.html).
        this.enabled = false;
        this.phrase = 'hey claude';
        this.silenceMs = 3000;
        this.maxCommandMs = 60000;
        // Minimum average word confidence (0..1) the matched phrase words in a
        // FINAL open-vocabulary recognition must reach before it counts as the wake
        // phrase. Higher = stricter / fewer false positives. Defaults to the strict
        // end; tunable via the wakeMatchThreshold preference.
        this.matchThreshold = 0.75;
        this.activationSound = 'screenshot.wav';
        this.stopSound = 'hud4.wav';
        this.microphoneDeviceId = 'default';

        // 'idle' | 'listening' | 'capturing' | 'transcribing'
        this.state = 'idle';

        // Engine + audio graph handles.
        this.model = null;
        this.recognizer = null;
        this.audioStream = null;
        this.audioContext = null;
        this.sourceNode = null;
        this.processorNode = null;
        this.sinkNode = null;

        // Command-capture handles.
        this.mediaRecorder = null;
        this.commandChunks = [];
        this._captureStartedAt = 0;
        this._lastVoiceAt = 0;
        this._heardSpeech = false;
        this._vadTimer = null;

        this._setupPreferenceListeners();
    }

    _setupPreferenceListeners() {
        this.eventBus.on('preferences:applied', (prefs) => {
            if (!prefs) return;
            this._applyConfig(prefs);
        });
        this.eventBus.on('preference:changed', ({ key, value }) => {
            this._applyConfig({ [key]: value });
        });
    }

    // Map preference keys → config and react to enable/phrase/mic changes.
    _applyConfig(prefs) {
        let phraseChanged = false;
        let micChanged = false;
        let toggle = null;

        if (prefs.wakeWordPhrase != null && prefs.wakeWordPhrase !== this.phrase) {
            this.phrase = String(prefs.wakeWordPhrase).trim().toLowerCase() || 'hey claude';
            phraseChanged = true;
        }
        if (prefs.wakeSilenceMs != null) this.silenceMs = Math.max(1000, Number(prefs.wakeSilenceMs) || 3000);
        if (prefs.wakeMaxCommandMs != null) this.maxCommandMs = Math.max(5000, Number(prefs.wakeMaxCommandMs) || 60000);
        if (prefs.wakeMatchThreshold != null) {
            const t = Number(prefs.wakeMatchThreshold);
            if (Number.isFinite(t)) this.matchThreshold = Math.min(0.95, Math.max(0, t));
        }
        if (prefs.wakeActivationSound) this.activationSound = prefs.wakeActivationSound;
        if (prefs.wakeStopSound) this.stopSound = prefs.wakeStopSound;
        if (prefs.microphoneDeviceId != null && prefs.microphoneDeviceId !== this.microphoneDeviceId) {
            this.microphoneDeviceId = prefs.microphoneDeviceId;
            micChanged = true;
        }
        if (prefs.wakeWordEnabled != null) toggle = !!prefs.wakeWordEnabled;

        if (toggle === true && !this.enabled) { this.enable(); return; }
        if (toggle === false && this.enabled) { this.disable(); return; }
        // Live phrase / mic change while running → rebuild the listener.
        if (this.enabled && (phraseChanged || micChanged) && this.state === 'listening') {
            this._rebuildRecognizer().catch((e) => this._log(`wake: rebuild failed (${e.message})`, 'error'));
        }
    }

    async initialize() {
        // Pull persisted prefs if the store exposes them; otherwise enable() is
        // driven later by the preferences:applied event.
        if (this.enabled) await this.enable();
    }

    // ---- lifecycle -----------------------------------------------------------

    async enable() {
        if (this.state !== 'idle') return;
        this.enabled = true;
        try {
            this._log('🟣 Wake word: starting listener…', 'info');
            await this._loadModel();
            await this._openMic();
            await this._rebuildRecognizer();
            this.state = 'listening';
            this._log(`🟣 Wake word active — say "${this.phrase}"`, 'success');
            this.eventBus.emit('wake:state', { state: 'listening', phrase: this.phrase });
        } catch (err) {
            this.enabled = false;
            this.state = 'idle';
            this._teardownAudio();
            this._log(`❌ Wake word failed to start: ${err.message}`, 'error');
            this.eventBus.emit('wake:state', { state: 'error', error: err.message });
        }
    }

    disable() {
        this.enabled = false;
        this._stopCommandCapture(true); // abort any in-flight capture
        this._teardownAudio();
        this.state = 'idle';
        this._log('⚪ Wake word stopped', 'info');
        this.eventBus.emit('wake:state', { state: 'idle' });
    }

    async _loadModel() {
        if (this.model) return;
        if (!fs.existsSync(MODEL_PATH)) {
            throw new Error(`Vosk model missing at ${MODEL_PATH}`);
        }
        const Vosk = require('vosk-browser');
        const buf = fs.readFileSync(MODEL_PATH);
        // Blob URL is reachable from the WASM worker even under file://.
        const url = URL.createObjectURL(new Blob([buf]));
        this.model = await Vosk.createModel(url);
    }

    // (Re)create the OPEN-VOCABULARY recognizer for the current phrase.
    async _rebuildRecognizer() {
        if (!this.model) return;
        if (this.recognizer) {
            try { this.recognizer.remove(); } catch (_) {}
            this.recognizer = null;
        }
        // NO grammar restriction (this is the root-cause fix for false positives).
        // A grammar limited to [phrase, '[unk]'] makes Kaldi SNAP any audio to the
        // nearest in-grammar phrase, so a short noise like "Mo" decoded to the wake
        // phrase with inflated confidence — defeating both the exact-text match and
        // the confidence gate. With full open-vocabulary decoding, random speech
        // transcribes as ITSELF ("mo" → "mo", not "miranda"), so only a genuine
        // utterance of the phrase ever produces the phrase words.
        this.recognizer = new this.model.KaldiRecognizer(16000);
        // Per-word confidences let the FINAL-result path enforce matchThreshold as a
        // secondary backstop; harmless no-op if the engine doesn't support it.
        try { this.recognizer.setWords(true); } catch (_) {}
        // Trigger on FINAL results only. Partials carry no confidence and can briefly
        // flicker through near-words, so gating on the final (with confidence) biases
        // hard toward never false-triggering — the explicit product requirement.
        this.recognizer.on('result', (m) => this._onResult(m && m.result));
    }

    async _openMic() {
        if (this.audioStream) return;
        const constraints = (this.microphoneDeviceId && this.microphoneDeviceId !== 'default')
            ? { deviceId: { exact: this.microphoneDeviceId } }
            : true;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        } catch (err) {
            if (this.microphoneDeviceId !== 'default') {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } else {
                throw err;
            }
        }
        this.audioStream = stream;

        // One AudioContext drives both the Vosk feed and the VAD meter. A
        // zero-gain sink keeps the ScriptProcessor firing without echoing the
        // mic to the speakers.
        this.audioContext = new AudioContext();
        this.sourceNode = this.audioContext.createMediaStreamSource(stream);
        this.processorNode = this.audioContext.createScriptProcessor(FRAME_SIZE, 1, 1);
        this.sinkNode = this.audioContext.createGain();
        this.sinkNode.gain.value = 0;
        this.sourceNode.connect(this.processorNode);
        this.processorNode.connect(this.sinkNode);
        this.sinkNode.connect(this.audioContext.destination);
        this.processorNode.onaudioprocess = (e) => this._onAudioFrame(e.inputBuffer.getChannelData(0));
    }

    _teardownAudio() {
        if (this.processorNode) { try { this.processorNode.onaudioprocess = null; this.processorNode.disconnect(); } catch (_) {} this.processorNode = null; }
        if (this.sourceNode) { try { this.sourceNode.disconnect(); } catch (_) {} this.sourceNode = null; }
        if (this.sinkNode) { try { this.sinkNode.disconnect(); } catch (_) {} this.sinkNode = null; }
        if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }
        if (this.audioStream) { this.audioStream.getTracks().forEach((t) => t.stop()); this.audioStream = null; }
        if (this.recognizer) { try { this.recognizer.remove(); } catch (_) {} this.recognizer = null; }
    }

    // ---- live audio ----------------------------------------------------------

    _onAudioFrame(frame) {
        // RMS for the VAD, computed every frame regardless of mode.
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        const rms = Math.sqrt(sum / frame.length);

        if (this.state === 'listening' && this.recognizer) {
            // Feed a COPY — the underlying buffer is recycled by Web Audio.
            this.recognizer.acceptWaveformFloat(frame.slice(0), this.audioContext.sampleRate);
        } else if (this.state === 'capturing') {
            if (rms > RMS_VOICE_THRESHOLD) {
                this._heardSpeech = true;
                this._lastVoiceAt = performance.now();
            }
        }
    }

    // Final recognition. With open-vocabulary decoding the result text is a real
    // transcription of what was said, so we require the wake phrase to appear as a
    // contiguous WHOLE-WORD match in it (not a loose substring — so "amanda" or
    // "mirandaesque" can't match) AND require the matched phrase words' average
    // confidence to clear matchThreshold. Random speech transcribes as itself and
    // simply never contains the phrase words, which is what drives false positives
    // to ~zero; the confidence gate is a secondary backstop on near-homophones.
    _onResult(res) {
        if (this.state !== 'listening' || !res) return;

        // Prefer the per-word array (carries confidences + exact tokenization);
        // fall back to splitting the plain text if word details are absent.
        const wordObjs = Array.isArray(res.result) ? res.result : null;
        const words = wordObjs
            ? wordObjs.map((w) => String((w && w.word) || '').toLowerCase())
            : String(res.text || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
        const phraseWords = this.phrase.split(/\s+/).filter(Boolean);
        if (!phraseWords.length) return;

        const at = this._findPhrase(words, phraseWords);
        if (at < 0) return; // phrase not spoken → reject (the primary filter)

        // Average confidence over just the matched phrase words. If the engine
        // didn't supply confidences, treat as 1 so the whole-word match alone
        // decides rather than blocking every detection.
        let conf = 1;
        if (wordObjs) {
            const confs = wordObjs.slice(at, at + phraseWords.length)
                .map((w) => Number(w && w.conf))
                .filter((n) => Number.isFinite(n));
            if (confs.length) conf = confs.reduce((a, b) => a + b, 0) / confs.length;
        }
        if (conf < this.matchThreshold) {
            this._log(`wake: ignored low-confidence "${this.phrase}" (${conf.toFixed(2)} < ${this.matchThreshold.toFixed(2)})`, 'info');
            return;
        }
        this._onWakeDetected();
    }

    // Index of the first contiguous whole-word occurrence of `phraseWords` within
    // `words`, or -1. Single-word phrases ("miranda") and multi-word phrases
    // ("hey claude") are both handled.
    _findPhrase(words, phraseWords) {
        for (let i = 0; i + phraseWords.length <= words.length; i++) {
            let ok = true;
            for (let j = 0; j < phraseWords.length; j++) {
                if (words[i + j] !== phraseWords[j]) { ok = false; break; }
            }
            if (ok) return i;
        }
        return -1;
    }

    // ---- activation → command capture ---------------------------------------

    _onWakeDetected() {
        if (this.state !== 'listening') return;
        this.state = 'capturing';
        this._log(`🎙️ Heard "${this.phrase}" — listening for your command…`, 'success');
        this.eventBus.emit('wake:state', { state: 'capturing' });
        this._playChime(this.activationSound);
        this._startCommandCapture();
    }

    _startCommandCapture() {
        try {
            this.commandChunks = [];
            this._captureStartedAt = performance.now();
            this._lastVoiceAt = performance.now();
            this._heardSpeech = false;

            const mimeType = this.gui.voiceManager
                ? this.gui.voiceManager.getSupportedMimeType()
                : 'audio/webm';
            // Reuse the already-open mic stream — no second getUserMedia.
            this.mediaRecorder = new MediaRecorder(this.audioStream, { mimeType });
            this.mediaRecorder.ondataavailable = (ev) => { if (ev.data.size > 0) this.commandChunks.push(ev.data); };
            this.mediaRecorder.onstop = () => this._onCommandRecorded(mimeType);
            this.mediaRecorder.start();

            // VAD poll: stop on trailing silence / hard cap / no-speech timeout.
            this._vadTimer = setInterval(() => this._checkVad(), 200);
        } catch (err) {
            this._log(`❌ Command capture failed: ${err.message}`, 'error');
            this._resumeListening();
        }
    }

    _checkVad() {
        if (this.state !== 'capturing') return;
        const now = performance.now();
        const elapsed = now - this._captureStartedAt;
        if (elapsed > this.maxCommandMs) {
            this._log('⏱️ Command hit max length — sending what I have.', 'warning');
            this._stopCommandCapture();
        } else if (!this._heardSpeech && elapsed > NO_SPEECH_TIMEOUT_MS) {
            this._log('🤫 No command heard — going back to listening.', 'info');
            this._stopCommandCapture(true);
        } else if (this._heardSpeech && (now - this._lastVoiceAt) > this.silenceMs) {
            this._stopCommandCapture();
        }
    }

    // abort=true: discard audio and just resume listening.
    _stopCommandCapture(abort = false) {
        if (this._vadTimer) { clearInterval(this._vadTimer); this._vadTimer = null; }
        this._abortCapture = abort;
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try { this.mediaRecorder.stop(); } catch (_) { this._resumeListening(); }
        } else if (abort) {
            this._resumeListening();
        }
    }

    // True only while a wake-triggered command capture is in flight (the YELLOW
    // mic state). The renderer checks this to decide whether a mic-button tap
    // means "cancel this capture" vs. the normal manual-recording toggle.
    isCapturing() {
        return this.state === 'capturing';
    }

    // User tapped the yellow mic to cancel an unintended wake activation. Aborts
    // the in-flight capture immediately: stops the recorder and DISCARDS its audio
    // (abort=true routes _onCommandRecorded to the discard-and-resume branch, so no
    // Whisper call and no _sendToManager ever fire), then resumes the spotter. The
    // synchronous wake:state 'idle' clears the yellow at once; _resumeListening then
    // re-emits 'listening' once the recognizer is rebuilt. No-op if not capturing.
    cancelCapture() {
        if (this.state !== 'capturing') return false;
        this._log('🚫 Wake capture cancelled — nothing transcribed or sent.', 'info');
        this.eventBus.emit('wake:state', { state: 'idle' });
        this._stopCommandCapture(true);
        return true;
    }

    async _onCommandRecorded(mimeType) {
        const recorder = this.mediaRecorder;
        this.mediaRecorder = null;
        if (this._abortCapture) { this.commandChunks = []; this._resumeListening(); return; }

        this.state = 'transcribing';
        this.eventBus.emit('wake:state', { state: 'transcribing' });
        this._playChime(this.stopSound);

        try {
            const blob = new Blob(this.commandChunks, { type: (recorder && recorder.mimeType) || mimeType });
            this.commandChunks = [];
            this._log('🔄 Transcribing your command…', 'info');
            const text = await this.gui.voiceManager.transcribeBlob(blob, mimeType);
            if (text) {
                this._log(`✅ You said: "${text}"`, 'success');
                this._sendToManager(text);
            } else {
                this._log('⚠️ Could not transcribe the command (no speech detected).', 'warning');
            }
        } catch (err) {
            this._log(`❌ Transcription failed: ${err.message}`, 'error');
        } finally {
            this._resumeListening();
        }
    }

    _resumeListening() {
        if (!this.enabled) { this.state = 'idle'; return; }
        // Fresh recognizer clears any buffered audio so we don't re-trigger.
        this._rebuildRecognizer()
            .then(() => {
                this.state = 'listening';
                this.eventBus.emit('wake:state', { state: 'listening', phrase: this.phrase });
            })
            .catch((e) => {
                this._log(`❌ Wake word could not resume: ${e.message}`, 'error');
                this.disable();
            });
    }

    // ---- routing -------------------------------------------------------------

    _sendToManager(text) {
        // Frame the transcript as a voice memo so the manager treats it as the
        // user speaking aloud and acknowledges out loud before starting.
        // Keep the "🎙️ Voice memo from the user" marker verbatim — the manager's
        // CLAUDE.md keys off that exact phrase to acknowledge out loud first, then
        // act. The standing how-to is NOT repeated per message.
        const framed =
            '🎙️ Voice memo from the user (spoken aloud, auto-transcribed — phrasing '
            + 'may be imperfect):\n\n'
            + `"${text}"`;

        if (!this.gui.messageQueueManager) {
            this._log('❌ Cannot route voice command — message queue unavailable.', 'error');
            return;
        }
        if (this.gui.managerInstance && this.gui.managerInstance.running === false) {
            this._log('⚠️ Manager (999) is not running — voice command queued but may not inject.', 'warning');
        }
        this.gui.messageQueueManager.addMessage({
            content: framed,
            terminalId: MANAGER_TERMINAL_ID,
            type: 'urgent'
        });
        this._log('📨 Sent your voice memo to the manager (999).', 'success');
    }

    // ---- helpers -------------------------------------------------------------

    _playChime(file) {
        // Direct Audio element so the wake chimes always play, independent of
        // the global sound-effects toggle in SoundManager.
        if (!file) return;
        try {
            const a = new Audio(SOUND_DIR + file);
            a.volume = 0.6;
            a.play().catch(() => {});
        } catch (_) {}
    }

    _log(message, type = 'info') {
        try { this.eventBus.emit('log:action', { message, type }); } catch (_) {}
    }

    // ---- test hook (used by validation harness) ------------------------------
    // Feed a Float32 PCM buffer straight into the spotter as if it came from the
    // mic, bypassing getUserMedia. Returns nothing; detection fires the normal path.
    _injectPcmForTest(float32, sampleRate) {
        if (this.state !== 'listening' || !this.recognizer) return;
        this.recognizer.acceptWaveformFloat(float32, sampleRate);
    }
}

module.exports = WakeWordManager;
