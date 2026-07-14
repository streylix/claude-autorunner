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
 *        └ VAD: stop ONLY after `silenceMs` of continuous trailing silence
 *          (user-configured; no maximum-duration cap — long speech is never cut)
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
// A frame's RMS must exceed RMS_VOICE_THRESHOLD to count toward speech. Lowered
// from 0.015 so quiet/trailing speech still registers — a too-high gate froze the
// silence clock mid-utterance and clipped the ends of sentences.
const RMS_VOICE_THRESHOLD = 0.010;
// Consecutive above-threshold frames (~85ms each @48kHz) required before audio
// counts as the user genuinely speaking and refreshes the trailing-silence clock.
// Rejecting short runs keeps "stop after N s of silence" honest: bursty room noise
// during a pause can't keep nudging the clock and stretch the stop past N.
// Raised 2→4 (~170ms→~340ms sustained): brief ambient blips (key clicks, single
// thuds) no longer refresh the clock so the stop lands near the configured silence
// (~2.5s) instead of drifting to ~5s, while genuine speech — continuous, words
// typically ≥340ms — still clears the run every frame. The RMS floor is left at
// 0.010 so quiet trailing speech is NOT clipped (the 9f4a976 fix is preserved).
const VOICE_RUN_FRAMES = 4;
const NO_SPEECH_TIMEOUT_MS = 8000; // ONLY used before any speech: bail if the user never starts
const FRAME_SIZE = 4096;           // ScriptProcessor buffer (~85ms @ 48kHz)
// Continuous "is the user speaking right now" signal (drives speech:active/idle for
// the TTS-notification hold). Independent of command capture: it runs in EVERY mic
// state so spoken notifications can defer while the user talks even before a wake
// word. SPEECH_IDLE_MS is the trailing silence before we declare the user done — set
// longer than a normal inter-word gap so a sentence doesn't flap active→idle→active
// between words, but short enough that NotificationManager's own release timer adds
// up to the ~1-1.5s total trailing window the user asked for.
const SPEECH_IDLE_MS = 600;
// Echo/output gate. While our own spoken notification is playing (plus a short
// tail), its audio bleeds from the speakers back into the mic and would trip the
// VAD as if the user were talking — pausing the readout. So during playback we
// raise the gate from the sensitive floor to RMS_BARGE_IN_THRESHOLD: only sound
// clearly louder than the echo (a real, close-mic barge-in) counts. Outside
// playback the floor is used unchanged. RMS_BARGE_IN_THRESHOLD is the tunable
// knob — lower = easier to interrupt the TTS (and more echo false-positives);
// higher = the readout is harder to barge in on. TTS_ECHO_TAIL_MS keeps the
// raised gate up briefly past the clip's end for the buffer/reverb tail.
const RMS_BARGE_IN_THRESHOLD = 0.030;
const TTS_ECHO_TAIL_MS = 400;
// Discord-bot presence. When the "mute wake word while the bot is in a call"
// preference is on, we poll the backend for whether the Discord bridge is
// active (linked + in a voice channel) and suppress the LOCAL wake word so the
// same spoken phrase doesn't trigger twice (once via the bot, once via the host
// mic). The backend reports inactive if the bridge stops heartbeating, so a
// crashed/closed bridge can never leave the local wake word stuck muted.
const { BACKEND_URL } = require('../utils/backend-url');
const BOT_STATUS_POLL_MS = 3000;

class WakeWordManager {
    constructor(eventBus, appStateStore, gui) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        this.gui = gui;

        // Config (persisted as preferences; defaults below match index.html).
        this.enabled = false;
        this.phrase = 'hey claude';
        // The ONLY thing that ends a command capture: how long of continuous
        // trailing silence to wait after speech before stopping. User-configured
        // via the wakeSilenceMs preference ("Stop after silence" slider). There is
        // deliberately NO maximum-duration cap — long continuous speech is never cut.
        // Default raised 3000→5000: users dictating from across the room were cut off
        // mid-thought by the shorter trailing-silence window.
        this.silenceMs = 5000;
        // Strictness (0..1): the minimum per-word STRING SIMILARITY each spoken word
        // must reach against the corresponding wake-phrase word in a FINAL open-
        // vocabulary recognition. 1 ≈ require a near-exact phrase; lower = accept
        // near-matches (small edit distance). This is the lever the "strictness"
        // slider drives, and it is genuinely observable: at the high end only a clean
        // utterance of the phrase triggers; at the low end near-homophones (and, at
        // the extreme, almost anything) trigger. We use string similarity rather than
        // the engine's per-word `conf` because — although vosk-browser DOES supply
        // `conf` — genuine speech decodes near 1.0, so confidence is a poor strictness
        // lever (it barely changes behaviour across the slider). Tunable via the
        // wakeMatchThreshold preference.
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
        this._voiceRun = 0; // consecutive above-threshold frames (sustained-voice gate)
        this._vadTimer = null;
        // Continuous speech signal (speech:active/idle) — separate from the capture
        // VAD above so the wake tuning is untouched. Edge-triggered: rises on a
        // sustained run, falls after SPEECH_IDLE_MS of silence.
        this._speechRun = 0;
        this._userSpeaking = false;
        this._lastUserVoiceAt = 0;
        // Echo/output gate state: true while our TTS is producing sound (+ a short
        // tail), during which the VAD uses RMS_BARGE_IN_THRESHOLD. Driven by
        // NotificationManager's tts:playback events.
        this._ttsPlaybackActive = false;
        this._ttsEchoTailTimer = null;
        // Wake-word mute while the Discord bot is in a call (anti double-trigger).
        // muteWhileBotActive is the user preference; _botInCall is the live state
        // polled from the backend bridge-status endpoint while enabled.
        this.muteWhileBotActive = false;
        this._botInCall = false;
        this._botPollTimer = null;
        // What started the current capture: 'wake' (wake word) or 'post-notification'
        // (auto-opened right after a notification finished reading out). Drives how the
        // transcript is framed for the manager; reset to 'wake' after each capture.
        this._captureSource = 'wake';
        // Pre-speech listen window for the current capture (how long to wait for the
        // user to START talking before closing quietly). Wake uses the long default;
        // post-notification uses the configured stop-after-silence.
        this._noSpeechMs = NO_SPEECH_TIMEOUT_MS;
        // ---- Remote Mode client-mic forwarding (docs/REMOTE_MODE.md §10) ----
        // While a Remote Mode viewer streams ITS microphone over the WS, that
        // stream becomes the pipeline's input (which-mic rule: remote wins; the
        // local mic is ignored until it detaches). Frames arrive as Float32 via
        // pushRemotePcm() from RemoteMicSink — same VAD, same recognizer, same
        // Whisper POST as local audio.
        this._remoteSource = false;  // a remote client's mic is attached as THE input
        this._remoteOnly = false;    // this session exists FOR the remote source (local wake pref off / no local mic opened)
        this._remoteRate = 16000;    // sample rate of the incoming remote PCM
        this._remoteCapture = false; // the in-flight capture is remote-sourced (PCM accumulation, no MediaRecorder)
        this._remotePcm = [];        // Int16Array chunks of the remote utterance being captured

        this._setupPreferenceListeners();

        // Auto-wake-after-notification: when a notification finishes its FIRST read-out
        // (NotificationManager emits this only on first play, not replay, and only when
        // nothing else is queued), open the capture flow briefly so the user can reply
        // immediately without the wake word.
        this.eventBus.on('notification:read-complete', () => this.startPostNotificationCapture());

        // Raise the speech gate while a spoken notification is actually playing so
        // its own audio echoing into the mic can't be mistaken for the user talking.
        this.eventBus.on('tts:playback', ({ active } = {}) => this._setTtsPlayback(!!active));
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
        // Floor 600ms — matches the slider minimum and the Discord bridge's clamp,
        // so the ONE wakeSilenceMs setting behaves identically on both voice paths.
        if (prefs.wakeSilenceMs != null) this.silenceMs = Math.max(600, Number(prefs.wakeSilenceMs) || 5000);
        if (prefs.wakeMatchThreshold != null) {
            const t = Number(prefs.wakeMatchThreshold);
            if (Number.isFinite(t)) this.matchThreshold = Math.min(0.95, Math.max(0, t));
        }
        if (prefs.wakeActivationSound) this.activationSound = prefs.wakeActivationSound;
        if (prefs.wakeStopSound) this.stopSound = prefs.wakeStopSound;
        if (prefs.wakeMuteDuringCall != null) {
            this.muteWhileBotActive = !!prefs.wakeMuteDuringCall;
            if (this.enabled) this._syncBotPoll(); // start/stop polling to match
        }
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
        if (this.state !== 'idle') {
            // A remote-only session is already running the pipeline (remote mic
            // attached with the local pref off). Record the pref so the local
            // mic takes over when the remote source detaches — but do NOT open
            // the local mic now: the remote stream owns the input.
            if (this._remoteOnly) this.enabled = true;
            return;
        }
        this.enabled = true;
        try {
            this._log('🟣 Wake word: starting listener…', 'info');
            await this._loadModel();
            await this._openMic();
            await this._rebuildRecognizer();
            this.state = 'listening';
            this._log(`🟣 Wake word active — say "${this.phrase}"`, 'success');
            this.eventBus.emit('wake:state', { state: 'listening', phrase: this.phrase });
            this._syncBotPoll(); // begin watching the Discord bot if the mute pref is on
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
        this._stopBotPoll();
        this._botInCall = false;
        this._stopCommandCapture(true); // abort any in-flight capture
        this._teardownAudio();
        this.state = 'idle';
        this._remoteOnly = false;
        this._log('⚪ Wake word stopped', 'info');
        this.eventBus.emit('wake:state', { state: 'idle' });
        // A remote viewer is still streaming its mic: the pipeline must keep
        // serving it. Re-bootstrap as a remote-only session (no local mic).
        if (this._remoteSource) {
            this._remoteSource = false;
            this.attachRemoteSource();
        }
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
        // Releasing the mic ends any in-progress utterance: clear the speech signal so
        // a held TTS notification isn't stuck waiting on a speaker that's now gone.
        if (this._userSpeaking) {
            this._userSpeaking = false;
            try { this.eventBus.emit('speech:idle', {}); } catch (_) {}
        }
        this._speechRun = 0;
        if (this.processorNode) { try { this.processorNode.onaudioprocess = null; this.processorNode.disconnect(); } catch (_) {} this.processorNode = null; }
        if (this.sourceNode) { try { this.sourceNode.disconnect(); } catch (_) {} this.sourceNode = null; }
        if (this.sinkNode) { try { this.sinkNode.disconnect(); } catch (_) {} this.sinkNode = null; }
        if (this.audioContext) { this.audioContext.close().catch(() => {}); this.audioContext = null; }
        if (this.audioStream) { this.audioStream.getTracks().forEach((t) => t.stop()); this.audioStream = null; }
        if (this.recognizer) { try { this.recognizer.remove(); } catch (_) {} this.recognizer = null; }
    }

    // ---- live audio ----------------------------------------------------------

    _onAudioFrame(frame) {
        // Which-mic rule (REMOTE_MODE.md §10): while a remote client streams its
        // microphone, THAT stream is the pipeline's input and local mic frames
        // are ignored — except to let an already-running LOCAL capture finish.
        if (this._remoteSource && !(this.state === 'capturing' && !this._remoteCapture)) return;
        // RMS for the VAD, computed every frame regardless of mode.
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        const rms = Math.sqrt(sum / frame.length);

        // Continuous "user is speaking" signal — runs in every state so spoken
        // notifications can hold while the user talks, even outside a capture window.
        this._updateSpeechSignal(rms);

        if (this.state === 'listening' && this.recognizer) {
            // Feed a COPY — the underlying buffer is recycled by Web Audio.
            this.recognizer.acceptWaveformFloat(frame.slice(0), this.audioContext.sampleRate);
        } else if (this.state === 'capturing') {
            if (rms > RMS_VOICE_THRESHOLD) {
                // Require a short sustained run so a lone noise spike can't pass as
                // speech and refresh the silence clock (which would stretch the stop
                // past the configured seconds). Continuous speech trivially clears
                // this and keeps _lastVoiceAt current every frame.
                this._voiceRun++;
                if (this._voiceRun >= VOICE_RUN_FRAMES) {
                    this._heardSpeech = true;
                    this._lastVoiceAt = performance.now();
                }
            } else {
                this._voiceRun = 0;
            }
        }
    }

    // Continuous voice-activity edge detector that powers the speech:active /
    // speech:idle events NotificationManager uses to hold spoken notifications while
    // the user is talking. Deliberately separate from the capture VAD: same RMS
    // threshold + sustained-run gate (so room blips don't trip it), but it emits on
    // rising/falling edges in ANY state. Frames arrive continuously (the
    // ScriptProcessor fires on silence too), so the falling edge is detected here
    // rather than on a timer.
    /** Track whether our TTS is producing sound (drives the echo gate + its tail). */
    _setTtsPlayback(active) {
        if (active) {
            if (this._ttsEchoTailTimer) { clearTimeout(this._ttsEchoTailTimer); this._ttsEchoTailTimer = null; }
            this._ttsPlaybackActive = true;
        } else if (this._ttsPlaybackActive) {
            this._ttsPlaybackActive = false;
            if (this._ttsEchoTailTimer) clearTimeout(this._ttsEchoTailTimer);
            const t = setTimeout(() => { this._ttsEchoTailTimer = null; }, TTS_ECHO_TAIL_MS);
            if (t && typeof t.unref === 'function') t.unref();
            this._ttsEchoTailTimer = t;
        }
    }

    /** True while TTS output (or its short tail) should raise the VAD gate. */
    _inTtsEchoWindow() {
        return this._ttsPlaybackActive || this._ttsEchoTailTimer != null;
    }

    _updateSpeechSignal(rms) {
        const now = performance.now();
        // During TTS playback (+tail) require the higher barge-in gate so the
        // notification's own echo doesn't read as the user speaking; otherwise the
        // sensitive floor so quiet/trailing speech still registers.
        const threshold = this._inTtsEchoWindow() ? RMS_BARGE_IN_THRESHOLD : RMS_VOICE_THRESHOLD;
        if (rms > threshold) {
            this._speechRun++;
            if (this._speechRun >= VOICE_RUN_FRAMES) {
                this._lastUserVoiceAt = now;
                if (!this._userSpeaking) {
                    this._userSpeaking = true;
                    try { this.eventBus.emit('speech:active', {}); } catch (_) {}
                }
            }
        } else {
            this._speechRun = 0;
            if (this._userSpeaking && (now - this._lastUserVoiceAt) > SPEECH_IDLE_MS) {
                this._userSpeaking = false;
                try { this.eventBus.emit('speech:idle', {}); } catch (_) {}
            }
        }
    }

    // Final recognition. With open-vocabulary decoding the result text is a real
    // transcription of what was said, so we look for the wake phrase as a contiguous
    // run of words whose per-word STRING SIMILARITY to the phrase clears the
    // strictness threshold (matchThreshold). Random speech transcribes as itself and
    // is dissimilar to the phrase, so at normal/high strictness false positives stay
    // ~zero; lowering strictness deliberately widens what counts as a match, which is
    // what makes the slider observable.
    _onResult(res) {
        if (this.state !== 'listening' || !res) return;

        // Prefer the per-word array (exact tokenization, and carries `conf` for
        // logging); fall back to splitting the plain text if word details are absent.
        const wordObjs = Array.isArray(res.result) ? res.result : null;
        const words = wordObjs
            ? wordObjs.map((w) => String((w && w.word) || '').toLowerCase())
            : String(res.text || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
        const phraseWords = this.phrase.split(/\s+/).filter(Boolean);
        if (!phraseWords.length || !words.length) return;

        // Strictness slider → minimum per-word similarity. No qualifying window → reject.
        const match = this._matchPhrase(words, phraseWords, this.matchThreshold);
        if (!match) return;

        // Engine confidence IS available (vosk-browser final words carry `conf`) but
        // clusters near 1.0 for genuine speech, so it is logged for diagnostics only —
        // the fuzzy similarity above is the actual gate the strictness slider drives.
        let conf = null;
        if (wordObjs) {
            const confs = wordObjs.slice(match.index, match.index + phraseWords.length)
                .map((w) => Number(w && w.conf))
                .filter((n) => Number.isFinite(n));
            if (confs.length) conf = confs.reduce((a, b) => a + b, 0) / confs.length;
        }
        this._log(`wake: matched "${this.phrase}" (similarity ${match.score.toFixed(2)} ≥ strictness ${this.matchThreshold.toFixed(2)}`
            + (conf != null ? `, conf ${conf.toFixed(2)}` : '') + ')', 'info');
        this._onWakeDetected();
    }

    // Best contiguous window in `words` whose EVERY word is at least `minSim` string-
    // similar to the matching wake-phrase word. Returns { index, score } (score =
    // average similarity of the best-scoring qualifying window) or null. `minSim` is
    // the strictness: ~1 demands a near-exact phrase, lower accepts near-matches.
    // Single-word ("miranda") and multi-word ("hey claude") phrases both work.
    _matchPhrase(words, phraseWords, minSim) {
        let best = null;
        for (let i = 0; i + phraseWords.length <= words.length; i++) {
            let sum = 0;
            let ok = true;
            for (let j = 0; j < phraseWords.length; j++) {
                const sim = this._wordSimilarity(words[i + j], phraseWords[j]);
                if (sim < minSim) { ok = false; break; }
                sum += sim;
            }
            if (!ok) continue;
            const score = sum / phraseWords.length;
            if (!best || score > best.score) best = { index: i, score };
        }
        return best;
    }

    // Normalized 0..1 similarity between two words (1 = identical), from edit distance.
    _wordSimilarity(a, b) {
        a = a || ''; b = b || '';
        if (a === b) return 1;
        const max = Math.max(a.length, b.length);
        if (!max) return 1;
        return 1 - this._levenshtein(a, b) / max;
    }

    // Levenshtein edit distance (two-row, O(min) memory).
    _levenshtein(a, b) {
        const m = a.length, n = b.length;
        if (!m) return n;
        if (!n) return m;
        let prev = new Array(n + 1);
        for (let j = 0; j <= n; j++) prev[j] = j;
        for (let i = 1; i <= m; i++) {
            const cur = [i];
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            }
            prev = cur;
        }
        return prev[n];
    }

    // ---- activation → command capture ---------------------------------------

    _onWakeDetected() {
        if (this.state !== 'listening') return;
        if (this._isWakeMuted()) {
            // The Discord bot is in a call and the user opted to route the wake
            // word through it only — ignore the local mic so it can't double-fire.
            this._log('🔇 Wake word heard but muted — Discord bot is in a call (no double trigger).', 'info');
            return;
        }
        this._captureSource = 'wake';
        this._log(`🎙️ Heard "${this.phrase}" — listening for your command…`, 'success');
        this._beginCapture();
    }

    /** Suppress the local wake word only when the user opted in AND the bot is live. */
    _isWakeMuted() {
        return this.muteWhileBotActive && this._botInCall;
    }

    // ---- Discord-bot presence polling (drives _botInCall) --------------------

    /** Poll the backend only while it can matter: enabled AND the pref is on. */
    _syncBotPoll() {
        if (this.enabled && this.muteWhileBotActive) this._startBotPoll();
        else { this._stopBotPoll(); this._botInCall = false; }
    }

    _startBotPoll() {
        if (this._botPollTimer) return;
        this._pollBotStatus();
        this._botPollTimer = setInterval(() => this._pollBotStatus(), BOT_STATUS_POLL_MS);
        if (this._botPollTimer && typeof this._botPollTimer.unref === 'function') this._botPollTimer.unref();
    }

    _stopBotPoll() {
        if (this._botPollTimer) { clearInterval(this._botPollTimer); this._botPollTimer = null; }
    }

    async _pollBotStatus() {
        try {
            const res = await fetch(`${BACKEND_URL}/api/voice/bridge-status/`);
            if (!res.ok) throw new Error(`status ${res.status}`);
            this._applyBotStatus(await res.json());
        } catch (_) {
            // Fail-safe: if the backend is unreachable, never leave the wake word
            // muted — treat the bot as not in a call so the local mic keeps working.
            this._botInCall = false;
        }
    }

    _applyBotStatus(data) {
        this._botInCall = !!(data && data.active);
    }

    // Auto-open a command capture WITHOUT a wake word, right after a notification
    // finished reading out, so the user can fire back a reply immediately. Same flow
    // as the wake word but tagged 'post-notification' (see _sendToManager). No-op
    // unless the spotter is enabled and idle-listening, so it never interrupts an
    // in-flight capture, a disabled spotter, or startup — and so it can't clash with
    // the wake-word path. The listen window before the user starts speaking is the
    // configured stop-after-silence: if no reply comes, it closes quietly.
    startPostNotificationCapture() {
        if (!this.enabled || this.state !== 'listening') return;
        this._captureSource = 'post-notification';
        this._log('🗣️ Notification read out — listening for your reply (no wake word needed)…', 'info');
        this._beginCapture({ noSpeechMs: this.silenceMs });
    }

    // Shared activation: flip to capturing, signal the UI (and the notification-halt
    // listener), play the activation chime, and start recording. opts is forwarded to
    // _startCommandCapture (e.g. noSpeechMs for the pre-speech window).
    _beginCapture(opts = {}) {
        this.state = 'capturing';
        this.eventBus.emit('wake:state', { state: 'capturing' });
        this._playChime(this.activationSound);
        this._startCommandCapture(opts);
    }

    _startCommandCapture(opts = {}) {
        try {
            this.commandChunks = [];
            this._captureStartedAt = performance.now();
            this._lastVoiceAt = performance.now();
            this._heardSpeech = false;
            this._voiceRun = 0;
            this._noSpeechMs = opts.noSpeechMs || NO_SPEECH_TIMEOUT_MS;

            if (this._remoteSource) {
                // Remote-sourced capture: there is no MediaStream for network
                // audio, so instead of MediaRecorder the PCM frames are
                // accumulated in pushRemotePcm() and encoded to a WAV when the
                // VAD stops the capture (see _onRemoteCommandRecorded).
                this._remoteCapture = true;
                this._remotePcm = [];
            } else {
                const mimeType = this.gui.voiceManager
                    ? this.gui.voiceManager.getSupportedMimeType()
                    : 'audio/webm';
                // Reuse the already-open mic stream — no second getUserMedia.
                this.mediaRecorder = new MediaRecorder(this.audioStream, { mimeType });
                this.mediaRecorder.ondataavailable = (ev) => { if (ev.data.size > 0) this.commandChunks.push(ev.data); };
                this.mediaRecorder.onstop = () => this._onCommandRecorded(mimeType);
                this.mediaRecorder.start();
            }

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
        // Before any speech: bail only if the user never starts, so a stray wake
        // activation doesn't record forever. This is the ONLY pre-speech guard.
        if (!this._heardSpeech) {
            if ((now - this._captureStartedAt) > this._noSpeechMs) {
                this._log('🤫 No command heard — going back to listening.', 'info');
                // Play the same "done listening" stop chime the transcribe path plays
                // (line ~459), so the user gets audible feedback that the window closed
                // even when they said nothing. The abort below routes through
                // _onCommandRecorded's discard branch, which returns before that chime —
                // so this is the ONLY place it fires on the silent no-speech close (once).
                this._playChime(this.stopSound);
                this._stopCommandCapture(true);
            }
            return;
        }
        // After speech starts, the configurable trailing-silence is the SOLE stop —
        // there is no maximum-duration cap, so long continuous speech is never cut.
        if ((now - this._lastVoiceAt) > this.silenceMs) {
            this._stopCommandCapture();
        }
    }

    // abort=true: discard audio and just resume listening.
    _stopCommandCapture(abort = false) {
        if (this._vadTimer) { clearInterval(this._vadTimer); this._vadTimer = null; }
        if (this._remoteCapture) {
            // Remote-sourced capture: no MediaRecorder to stop — hand the
            // accumulated PCM to the transcribe path (or discard on abort).
            this._remoteCapture = false;
            const chunks = this._remotePcm;
            this._remotePcm = [];
            if (abort) { this._resumeListening(); return; }
            this._onRemoteCommandRecorded(chunks);
            return;
        }
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
        this._captureSource = 'wake'; // post-notification is one-shot; default back
        // A remote-only session (remote client mic with the local wake pref off)
        // stays alive for as long as the remote source is attached.
        const sessionAlive = this.enabled || (this._remoteSource && this._remoteOnly);
        if (!sessionAlive) { this.state = 'idle'; return; }
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
        // Keep the "🎙️ Voice memo from the user" marker verbatim either way — the
        // manager's CLAUDE.md keys off that exact phrase. The post-notification variant
        // additionally tags that this capture was AUTO-started right after a
        // notification was read out (the user replying immediately), not a wake word.
        const framed = this._captureSource === 'post-notification'
            ? '🎙️ Voice memo from the user [auto-started reply, right after a '
              + 'notification was read out — no wake word; spoken aloud, auto-'
              + 'transcribed, phrasing may be imperfect]:\n\n'
              + `"${text}"`
            : '🎙️ Voice memo from the user (spoken aloud, auto-transcribed — phrasing '
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

    // ---- remote client microphone as the pipeline input (REMOTE_MODE.md §10) --

    /** True while a Remote Mode viewer's mic is the pipeline's input. */
    isRemoteSourceActive() {
        return this._remoteSource;
    }

    /**
     * A Remote Mode client started streaming its microphone. From now on that
     * stream is THE input (which-mic rule): local mic frames are ignored. If no
     * local session is running (wake pref off — or the app host is headless
     * with no mic at all), spin up a REMOTE-ONLY session: load the model and
     * recognizer but never open the local microphone.
     */
    async attachRemoteSource() {
        if (this._remoteSource) return;
        this._remoteSource = true;
        if (this.state === 'idle') {
            try {
                this._log('🟣 Remote mic attached — starting the wake pipeline on the remote stream…', 'info');
                await this._loadModel();
                await this._rebuildRecognizer();
                this._remoteOnly = true;
                this.state = 'listening';
                this._log(`🟣 Wake word active on the REMOTE viewer's microphone — say "${this.phrase}"`, 'success');
                this.eventBus.emit('wake:state', { state: 'listening', phrase: this.phrase });
            } catch (err) {
                this._remoteSource = false;
                this._log(`❌ Remote mic attach failed: ${err.message}`, 'error');
                this.eventBus.emit('wake:state', { state: 'error', error: err.message });
            }
            return;
        }
        // A local session is already live: the remote stream simply takes over
        // as the input; the local mic stays open but its frames are dropped
        // (see _onAudioFrame) until the remote source detaches.
        this._log('🎙️ Remote mic attached — wake input source → remote viewer (local mic ignored)', 'info');
    }

    /**
     * The streaming client stopped (toggle, disconnect, or another client took
     * over and this one was denied). Restore local behavior exactly as before.
     */
    detachRemoteSource() {
        if (!this._remoteSource) return;
        this._remoteSource = false;
        if (this.state === 'capturing' && this._remoteCapture) {
            // Discard the in-flight remote capture inline (no MediaRecorder to
            // stop, and the teardown below must not race a listener rebuild).
            if (this._vadTimer) { clearInterval(this._vadTimer); this._vadTimer = null; }
            this._remoteCapture = false;
            this._remotePcm = [];
            this._log('⚠️ Remote mic detached mid-capture — capture discarded', 'warning');
            if (!this._remoteOnly) this._resumeListening(); // the local session takes back over
        }
        if (this._remoteOnly) {
            this._remoteOnly = false;
            this._teardownAudio(); // recognizer only — no local mic was ever opened
            this.state = 'idle';
            this.eventBus.emit('wake:state', { state: 'idle' });
            if (this.enabled) {
                // The local wake pref is on (it was enabled while the remote
                // session ran): hand the pipeline back to the local microphone.
                this.enabled = false;
                this.enable();
            } else {
                this._log('⚪ Remote mic detached — wake pipeline idle (local wake word is off)', 'info');
            }
        } else if (this.enabled) {
            this._log('🎙️ Remote mic detached — wake input source → local microphone', 'info');
        }
    }

    /**
     * One frame of remote microphone audio (Float32 [-1,1], mono). Runs the
     * exact same stages as a local mic frame: speech signal, recognizer feed
     * while listening, VAD + PCM accumulation while capturing. Frames are
     * ~85 ms (client-side chunking) so the sustained-run VAD tuning matches.
     */
    pushRemotePcm(float32, sampleRate) {
        if (!this._remoteSource || !float32 || !float32.length) return;
        const rate = Number(sampleRate) > 0 ? Number(sampleRate) : this._remoteRate;
        this._remoteRate = rate;

        let sum = 0;
        for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
        const rms = Math.sqrt(sum / float32.length);

        this._updateSpeechSignal(rms);

        if (this.state === 'listening' && this.recognizer) {
            this.recognizer.acceptWaveformFloat(float32, rate);
        } else if (this.state === 'capturing' && this._remoteCapture) {
            if (rms > RMS_VOICE_THRESHOLD) {
                // Same sustained-run gate as the local capture VAD.
                this._voiceRun++;
                if (this._voiceRun >= VOICE_RUN_FRAMES) {
                    this._heardSpeech = true;
                    this._lastVoiceAt = performance.now();
                }
            } else {
                this._voiceRun = 0;
            }
            // Accumulate the utterance as PCM16 (MediaRecorder needs a
            // MediaStream, which a network source doesn't have).
            const i16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
                let s = Math.round(float32[i] * 32768);
                if (s > 32767) s = 32767;
                else if (s < -32768) s = -32768;
                i16[i] = s;
            }
            this._remotePcm.push(i16);
        }
    }

    // Remote-capture counterpart of _onCommandRecorded: encode the accumulated
    // PCM as a WAV and run it through the SAME Whisper path (transcribeBlob →
    // POST /api/voice/transcribe/ on the app host's loopback) and the SAME
    // voice-memo framing to the manager.
    async _onRemoteCommandRecorded(chunks) {
        this.state = 'transcribing';
        this.eventBus.emit('wake:state', { state: 'transcribing' });
        this._playChime(this.stopSound);
        try {
            const wav = this._encodeWavPcm16(chunks, this._remoteRate);
            const blob = new Blob([wav], { type: 'audio/wav' });
            this._log('🔄 Transcribing your command (remote mic)…', 'info');
            const text = await this.gui.voiceManager.transcribeBlob(blob, 'audio/wav');
            if (text) {
                this._log(`✅ You said (remote mic): "${text}"`, 'success');
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

    /** Int16Array chunks → mono PCM16 RIFF/WAVE bytes. */
    _encodeWavPcm16(chunks, rate) {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const buf = new ArrayBuffer(44 + total * 2);
        const view = new DataView(buf);
        const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
        writeStr(0, 'RIFF');
        view.setUint32(4, 36 + total * 2, true);
        writeStr(8, 'WAVE');
        writeStr(12, 'fmt ');
        view.setUint32(16, 16, true);       // PCM chunk size
        view.setUint16(20, 1, true);        // PCM
        view.setUint16(22, 1, true);        // mono
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * 2, true); // byte rate
        view.setUint16(32, 2, true);        // block align
        view.setUint16(34, 16, true);       // bits/sample
        writeStr(36, 'data');
        view.setUint32(40, total * 2, true);
        let off = 44;
        for (const c of chunks) {
            for (let i = 0; i < c.length; i++) { view.setInt16(off, c[i], true); off += 2; }
        }
        return new Uint8Array(buf);
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
