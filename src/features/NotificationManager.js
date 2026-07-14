/**
 * NotificationManager - spoken notifications tab.
 *
 * The manager (terminal 999) turns terminal completions into short summaries and
 * POSTs them to the Django TTS backend (/api/tts/speak/), which synthesizes the
 * audio with Kokoro and persists a Notification row. This manager is the viewer:
 * it polls the backend for new notifications, renders them into the Notifications
 * tab (#todo-list), and reads new ones aloud automatically.
 *
 * Playback speed is applied client-side via HTMLAudioElement.playbackRate, so the
 * "Playback Speed" setting affects existing notifications too (no re-synthesis).
 *
 * Remote Mode (docs/REMOTE_MODE.md §9): in a browser / embedded remote client the
 * Django backend is NOT reachable (it lives on the app host's loopback), so there
 * is no polling there. Instead main forwards each fresh notification — metadata
 * plus the synthesized audio bytes — over the authenticated WebSocket as a
 * 'remote-tts-notification' push, and playback happens on the device actually
 * showing the interface (see initializeRemote). The LOCAL renderer keeps
 * playing too (DUAL OUTPUT): anything capturing the desktop's audio sink —
 * the Discord bridge with AUDIO_SOURCE=system, a person at the machine —
 * still hears every notification while remote viewer(s) are attached.
 */

const { BACKEND_URL: BASE_URL } = require('../utils/backend-url');

// True when this renderer is a Remote Mode client (browser tab or the client
// GUI's embedded iframe). Set by remote-bootstrap.js before any bundle code runs.
const IS_REMOTE = typeof window !== 'undefined' && !!window.__CCBOT_REMOTE__;

// ipcRenderer, lazily: the real one in the local Electron renderer, the wsIpc
// WebSocket shim in a remote client (remote-bootstrap.js), null in unit tests.
function getIpcRenderer() {
    try { return require('electron').ipcRenderer; } catch (_) { return null; }
}
const POLL_INTERVAL_MS = 3000;
// After every speaking source clears, wait this long before releasing held
// notifications. Combined with WakeWordManager's SPEECH_IDLE_MS (~600ms) trailing
// silence, this gives a ~1.3s total quiet window before a deferred notification
// reads out — so the assistant doesn't jump in the instant the user pauses.
const SPEAKING_RELEASE_MS = 700;
// Hard loop guard. A clip interrupted by speech/noise RESUMES from where it
// paused (it never restarts from 0). But if the same clip keeps getting
// interrupted — continuous talking, background noise, or the TTS output echoing
// back into the mic — we must not defer it forever. After this many
// interruptions we stop deferring and play the clip THROUGH to completion (we
// never drop it). NEVER replay it from the start.
const MAX_HOLDS_PER_MESSAGE = 3;
// If a clip is held (paused for a barge-in) but the user just keeps talking so it
// never clears, resume it anyway after this long and play it THROUGH. Completion
// is the priority: a notification must never loop and never stall indefinitely,
// no matter how long the user talks.
const MAX_HELD_MS = 4000;

class NotificationManager {
    constructor(eventBus, appStateStore) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;

        this.items = new Map();        // id -> notification payload
        this.lastSeenId = 0;           // highest id already rendered
        this.pollTimer = null;
        this.searchTerm = '';

        // Preferences (kept in sync via events; defaults match index.html).
        this.playbackRate = 1.3;
        this.autoplay = true;
        this.muted = false;
        // BARGE-IN: when the user starts speaking over an in-flight readout, STOP
        // that message for good (no resume) so the interaction is a real
        // back-and-forth. false restores the legacy hold-and-resume behaviour
        // (pause, then finish the clip once the user is quiet).
        this.bargeInInterrupt = true;

        // Single reused audio element + a small FIFO so notifications don't
        // overlap when several arrive at once.
        this.audio = new Audio();
        this.audio.addEventListener('ended', () => this._onPlaybackEnded());
        this.audio.addEventListener('error', () => this._onPlaybackEnded());
        this.playQueue = [];
        this.playing = false;
        // True while the current clip is a user-requested replay (vs a first autoplay).
        // Gates auto-wake-after-notification so replays never re-open the reply window.
        this._currentIsReplay = false;

        // Short heads-up chime played right before each spoken notification so
        // the user knows one is about to read out.
        this.headsUp = new Audio('assets/soundeffects/click2.wav');
        this.headsUp.volume = 0.5;

        // ---- Remote Mode audio routing (docs/REMOTE_MODE.md §9) --------------
        // DUAL OUTPUT: remote viewer(s) get the audio bytes over the WS and play
        // them on the viewing device, AND the local renderer keeps auto-playing
        // on the desktop's default sink — the Discord bridge (AUDIO_SOURCE=system)
        // and anyone at the machine must never go silent just because a remote
        // viewer is attached. remoteSinkActive only tracks attach state for the
        // action log; it no longer gates playback anywhere.
        this.remoteSinkActive = false;      // local only: ≥1 remote client attached
        this._remoteBlobUrls = new Map();   // remote only: id -> blob: URL
        this._gestureArmed = false;         // remote only: awaiting a user gesture to unlock audio

        // ---- talk-over prevention ------------------------------------------
        // Hold spoken notifications while the user is talking and resume after a
        // short trailing silence — never play over them, never drop them.
        // `_speakingSources` tracks every reason we currently believe the user is
        // speaking; while it's non-empty (or the post-silence release timer is
        // still pending) the play queue holds instead of draining.
        this._speakingSources = new Set();
        this._speakingReleaseTimer = null;
        // A notification paused mid-readout, awaiting resume. Kept OUT of the play
        // queue (so it can't be enqueued twice) and resumed from its current
        // position — the audio element keeps its src + currentTime while held.
        this._held = null;             // { id } or null
        this._holdCounts = new Map();  // id -> times interrupted (loop guard)
        this._playThrough = new Set(); // ids committed to finish without further holds
        this._heldWatchdog = null;     // forces a stuck-held clip to resume (no stall)

        this._setupPreferenceListeners();
        this._setupSpeakingGate();
    }

    /**
     * Wire the "is the user speaking" inputs that gate playback:
     *   - speech:active / speech:idle  — continuous RMS voice activity (WakeWordManager)
     *   - wake:state capturing|transcribing — an active voice-command window
     *   - voice:button-state recording|processing — manual push-to-talk (VoiceManager)
     * Any active source holds the queue; when the last one clears we wait
     * SPEAKING_RELEASE_MS of silence, then drain in order.
     */
    _setupSpeakingGate() {
        this.eventBus.on('speech:active', () => this._addSpeakingSource('rms'));
        this.eventBus.on('speech:idle', () => this._removeSpeakingSource('rms'));

        this.eventBus.on('wake:state', ({ state } = {}) => {
            if (state === 'capturing' || state === 'transcribing') this._addSpeakingSource('capture');
            else this._removeSpeakingSource('capture'); // 'listening' | 'idle'
        });

        this.eventBus.on('voice:button-state', (state) => {
            if (state === 'recording' || state === 'processing') this._addSpeakingSource('manual');
            else this._removeSpeakingSource('manual'); // 'ready' | 'error'
        });
    }

    _addSpeakingSource(source) {
        // A new utterance starts: cancel any pending release so we stay held.
        if (this._speakingReleaseTimer) { clearTimeout(this._speakingReleaseTimer); this._speakingReleaseTimer = null; }
        const wasSpeaking = this._isUserSpeaking();
        this._speakingSources.add(source);
        // The user started talking mid-readout. Barge-in (default): STOP the
        // message outright so they can cut in naturally. Legacy mode: hold it and
        // resume from the same spot once they're quiet.
        if (!wasSpeaking && this.playing) {
            if (this.bargeInInterrupt) this._interruptCurrentPlayback(source);
            else this._holdCurrentPlayback();
        }
    }

    /**
     * BARGE-IN: stop the in-flight readout for good — no hold, no resume, no
     * replay. The notification is finalized as played (it was consciously talked
     * over, and it must not read out again later), and the log notes roughly
     * where it was cut. Play-through clips are NOT exempt here: barge-in is an
     * explicit user action, unlike the echo/noise the play-through flag guards
     * against. Pre-start holding (never BEGIN a readout while the user talks)
     * lives in _drainQueue and is unchanged.
     */
    _interruptCurrentPlayback(source) {
        const id = this._currentId;
        const wasReplay = this._currentIsReplay;
        const cur = Number(this.audio.currentTime) || 0;
        const dur = Number(this.audio.duration);
        const where = Number.isFinite(dur) && dur > 0
            ? `~${cur.toFixed(1)}s/${dur.toFixed(1)}s (~${Math.min(99, Math.round((cur / dur) * 100))}%)`
            : `~${cur.toFixed(1)}s`;
        try { this.audio.pause(); } catch (_) {}
        try { this.headsUp.pause(); this.headsUp.currentTime = 0; } catch (_) {}
        this._held = null;
        this._clearHeldWatchdog();
        this.playing = false;
        this._currentId = null;
        this._currentIsReplay = false;
        this._emitPlaybackState(false);
        if (id != null) {
            this._log(`✋ barge-in (${source || 'speech'}): stopped the readout at ${where} — you have the floor.`, 'info');
            // First read-outs are consumed; replays were already played.
            if (!wasReplay) this._finalizePlayed(id);
        }
        // NOTE: deliberately NO 'notification:read-complete' here — that event
        // opens the hands-free reply window, but the user is ALREADY talking.
    }

    _removeSpeakingSource(source) {
        if (!this._speakingSources.delete(source)) return;
        if (this._speakingSources.size > 0) return; // still speaking via another source
        // Last source cleared — start the trailing-silence release. If the user
        // speaks again before it fires, _addSpeakingSource cancels it.
        if (this._speakingReleaseTimer) clearTimeout(this._speakingReleaseTimer);
        this._speakingReleaseTimer = setTimeout(() => {
            this._speakingReleaseTimer = null;
            this._drainQueue();
        }, SPEAKING_RELEASE_MS);
    }

    /** True while we should hold notifications: actively speaking OR in the release window. */
    _isUserSpeaking() {
        return this._speakingSources.size > 0 || this._speakingReleaseTimer != null;
    }

    /**
     * Pause the in-flight notification because the user just started speaking.
     * The clip is NOT re-queued and NOT rewound: the audio element keeps its src
     * and currentTime, so it RESUMES from this exact spot once the user is silent
     * (see _drainQueue).
     *
     * Completion is the priority — a notification must always finish and may never
     * loop or stall indefinitely. So the hold is bounded two ways: a clip that is
     * interrupted MAX_HOLDS_PER_MESSAGE times, or that stays held past MAX_HELD_MS
     * because the user keeps talking, is flagged "play through" and resumed to the
     * end, ignoring further speech. A play-through clip is never paused again.
     */
    _holdCurrentPlayback() {
        const id = this._currentId;
        // Never interrupt a clip we've committed to playing through.
        if (id != null && this._playThrough.has(id)) return;
        try { this.audio.pause(); } catch (_) {}
        try { this.headsUp.pause(); this.headsUp.currentTime = 0; } catch (_) {}
        if (id == null || this._currentIsReplay) {
            this.playing = false;
            this._currentId = null;
            this._emitPlaybackState(false);
            return;
        }
        const count = (this._holdCounts.get(id) || 0) + 1;
        this._holdCounts.set(id, count);
        this._held = { id };
        this.playing = false;
        this._currentId = null;
        this._emitPlaybackState(false);
        if (count >= MAX_HOLDS_PER_MESSAGE) {
            // Interrupted too many times — stop deferring and PLAY IT THROUGH to
            // completion (never drop it), ignoring further speech.
            this._playThrough.add(id);
            this._forceResumeHeld();
        } else {
            // Bounded hold: if the user keeps talking and it never resumes on its
            // own, the watchdog forces it through so it can't stall.
            this._armHeldWatchdog();
        }
    }

    _armHeldWatchdog() {
        this._clearHeldWatchdog();
        const t = setTimeout(() => this._onHeldWatchdog(), MAX_HELD_MS);
        if (t && typeof t.unref === 'function') t.unref();
        this._heldWatchdog = t;
    }

    _clearHeldWatchdog() {
        if (this._heldWatchdog) { clearTimeout(this._heldWatchdog); this._heldWatchdog = null; }
    }

    /** The held clip never cleared (the user kept talking) — force it through. */
    _onHeldWatchdog() {
        if (!this._held) { this._clearHeldWatchdog(); return; }
        this._playThrough.add(this._held.id);
        this._forceResumeHeld();
    }

    /** Resume the held clip even if the user is still speaking (completion wins). */
    _forceResumeHeld() {
        this._clearHeldWatchdog();
        if (this.muted || this.playing || !this._held) return;
        this._resumeHeld();
    }

    /** Resume the held clip in place — no chime, no src reload, no rewind. */
    _resumeHeld() {
        this._clearHeldWatchdog();
        if (!this._held) return false;
        const { id } = this._held;
        this._held = null;
        const n = this.items.get(id);
        if (!n || !n.audio_url) return false;
        this.playing = true;
        this._currentId = id;
        this._currentIsReplay = false;
        const p = this.audio.play();
        if (p && p.catch) p.catch(() => this._onPlaybackEnded());
        this._emitPlaybackState(true);
        return true;
    }

    /** Tell the rest of the app whether TTS audio is producing sound, so the
     *  wake-word VAD can raise its gate and ignore the echo (see
     *  WakeWordManager._setTtsPlayback). */
    _emitPlaybackState(active) {
        try { this.eventBus.emit('tts:playback', { active: !!active }); } catch (_) {}
    }

    /**
     * Mark a notification played (server-side, best-effort) and forget its hold
     * count + play-through + UI state. Used on natural completion.
     */
    _finalizePlayed(id) {
        if (id == null) return;
        this._holdCounts.delete(id);
        this._playThrough.delete(id);
        if (IS_REMOTE) {
            // The backend lives on the app host's loopback — unreachable from a
            // remote client. Route the played-mark through the WS bridge; main
            // POSTs it to the backend on our behalf (see 'remote-tts-played').
            const ipc = getIpcRenderer();
            if (ipc) { try { ipc.send('remote-tts-played', { id }); } catch (_) { /* ignore */ } }
        } else {
            fetch(`${BASE_URL}/api/tts/notifications/${id}/played/`, { method: 'POST' }).catch(() => {});
        }
        try {
            const row = document.querySelector(`.notification-item[data-id="${id}"]`);
            if (row) row.classList.add('played');
        } catch (_) {}
    }

    _setupPreferenceListeners() {
        // Bulk apply on startup.
        this.eventBus.on('preferences:applied', (prefs) => {
            if (!prefs) return;
            if (prefs.ttsPlaybackSpeed != null) this.setPlaybackRate(prefs.ttsPlaybackSpeed);
            if (prefs.ttsAutoplayEnabled != null) this.autoplay = !!prefs.ttsAutoplayEnabled;
            if (prefs.ttsBargeInInterrupt != null) this.bargeInInterrupt = !!prefs.ttsBargeInInterrupt;
            // Restore the persisted mute state (survives navigation/restart).
            if (prefs.notificationsMuted != null) this._applyMutedState(!!prefs.notificationsMuted);
        });
        // Live changes. _applyMutedState (NOT setMuted) so we don't re-emit
        // preference:update and loop with PreferenceManager.
        this.eventBus.on('preference:changed', ({ key, value }) => {
            if (key === 'ttsPlaybackSpeed') this.setPlaybackRate(value);
            else if (key === 'ttsAutoplayEnabled') this.autoplay = !!value;
            else if (key === 'ttsBargeInInterrupt') this.bargeInInterrupt = !!value;
            else if (key === 'notificationsMuted') this._applyMutedState(!!value);
        });
    }

    async initialize() {
        await this.loadHistory();
        this.startPolling();
        this._wireToolbar();
        this._wireRemoteSinkSignal();
    }

    /**
     * Remote Mode boot (browser tab / embedded client iframe) — used INSTEAD of
     * initialize(). No backend polling here: main pushes each fresh notification
     * (metadata + synthesized audio bytes, base64) over the authenticated
     * WebSocket, and playback happens HERE — on the device showing the interface.
     */
    initializeRemote() {
        this._wireToolbar();
        const ipc = getIpcRenderer();
        if (!ipc) return;
        ipc.on('remote-tts-notification', (_event, payload) => {
            try {
                this._onRemoteTtsPush(payload);
            } catch (err) {
                console.error('[remote-tts] failed to handle pushed notification:', err);
            }
        });
        console.log('[remote-tts] client sink ready (voice notifications will play on this device)');
    }

    /** A notification (with its audio bytes) pushed to this remote client. */
    _onRemoteTtsPush(payload) {
        const n = payload && payload.notification;
        if (!n || n.id == null || this.items.has(n.id)) return;
        let url = null;
        if (payload.audioBase64) {
            const bin = atob(payload.audioBase64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            url = URL.createObjectURL(new Blob([bytes], { type: payload.mime || 'audio/wav' }));
            this._remoteBlobUrls.set(n.id, url);
            console.log(`[remote-tts] notification ${n.id} received over WS (${bytes.length} audio bytes)`);
        }
        const item = Object.assign({}, n, { audio_url: url });
        this._renderItem(item, { prepend: true });
        this.lastSeenId = Math.max(this.lastSeenId, n.id);
        if (this.autoplay) this._enqueuePlay(item);
    }

    /**
     * LOCAL renderer only: track whether any Remote Mode client is attached.
     * Main pushes 'remote-clients-changed' on every attach/detach and answers
     * the 'remote-clients-count' invoke for the boot-time state. While ≥1 is
     * attached, the client(s) are the audio sink and local autoplay holds.
     */
    _wireRemoteSinkSignal() {
        const ipc = getIpcRenderer();
        if (!ipc) return;
        try {
            let pushSeen = false; // a live push always beats the boot-time invoke
            ipc.on('remote-clients-changed', (_event, payload) => {
                pushSeen = true;
                this._setRemoteSinkActive(!!(payload && payload.count > 0));
            });
            if (typeof ipc.invoke === 'function') {
                ipc.invoke('remote-clients-count')
                    .then((r) => {
                        // Stale-guard: if an attach/detach push already arrived,
                        // this snapshot is older than what we know — drop it.
                        if (pushSeen) return;
                        if (r && typeof r.count === 'number') this._setRemoteSinkActive(r.count > 0);
                    })
                    .catch(() => {});
            }
        } catch (_) { /* non-Electron host (unit tests) */ }
    }

    _setRemoteSinkActive(active) {
        if (this.remoteSinkActive === !!active) return;
        this.remoteSinkActive = !!active;
        this._log(
            `notifications: ${this.remoteSinkActive ? 'remote viewer(s) attached — audio plays here AND on the viewing device(s)' : 'no remote viewers — audio plays here only'}`,
            'info'
        );
    }

    // ---- backend I/O ---------------------------------------------------------

    async _get(path) {
        const res = await fetch(BASE_URL + path);
        if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
        return res.json();
    }

    async loadHistory() {
        try {
            const { notifications } = await this._get('/api/tts/notifications/?limit=100');
            // Render newest-first (backend already orders that way); never autoplay history.
            notifications.forEach((n) => this._renderItem(n, { prepend: false }));
            this.lastSeenId = notifications.reduce((m, n) => Math.max(m, n.id), 0);
        } catch (err) {
            // Backend may not be up yet; polling will catch up.
            this._log(`notifications: history load failed (${err.message})`, 'warning');
        }
    }

    startPolling() {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    }

    stopPolling() {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    }

    async poll() {
        let data;
        try {
            data = await this._get(`/api/tts/notifications/?after=${this.lastSeenId}&limit=50`);
        } catch (err) {
            return; // transient; try again next tick
        }
        const fresh = (data.notifications || []).filter((n) => n.id > this.lastSeenId);
        if (!fresh.length) return;
        // Play in chronological order (backend returns newest-first).
        fresh.sort((a, b) => a.id - b.id);
        for (const n of fresh) {
            this._renderItem(n, { prepend: true });
            this.lastSeenId = Math.max(this.lastSeenId, n.id);
            // DUAL OUTPUT: play locally even with remote viewer(s) attached —
            // the desktop sink feeds the Discord bridge; the viewers get their
            // own copy over the WS (tts-remote-forwarder).
            if (this.autoplay) this._enqueuePlay(n);
        }
    }

    // ---- playback ------------------------------------------------------------

    _enqueuePlay(n) {
        if (!n.audio_url) return;
        // De-dupe: never queue something already playing, held, or already queued.
        if (this._currentId === n.id) return;
        if (this._held && this._held.id === n.id) return;
        if (this.playQueue.some((q) => q.id === n.id)) return;
        this.playQueue.push(n);
        this._drainQueue();
    }

    _drainQueue() {
        if (this.playing || this.muted) return;
        // Hold while the user is speaking (or within the trailing-silence window):
        // the queue keeps its items and drains once _removeSpeakingSource's release
        // timer fires. Never talk over the user; never drop the notification.
        if (this._isUserSpeaking()) return;
        // Resume an interrupted clip first — continue from where it paused (src and
        // currentTime are untouched), no chime, no restart from 0.
        if (this._held) {
            if (this._resumeHeld()) return;
            // Item vanished — fall through to the normal queue.
        }
        const n = this.playQueue.shift();
        if (!n) return;
        this.playing = true;
        this._currentId = n.id;
        this._currentIsReplay = false; // queue playback = first read-out
        // Heads-up chime first, then the spoken notification.
        this._playHeadsUpThen(() => this._startAudio(n.audio_url));
    }

    // Play the heads-up chime and invoke cb exactly once when it finishes
    // (or immediately if it can't play / never ends).
    _playHeadsUpThen(cb) {
        let fired = false;
        const go = () => { if (fired) return; fired = true; cb(); };
        try {
            this.headsUp.currentTime = 0;
            this.headsUp.onended = go;
            this.headsUp.onerror = go;
            const p = this.headsUp.play();
            if (p && p.catch) p.catch(() => go());
            setTimeout(go, 1200); // safety net if 'ended' never fires
        } catch (_) {
            go();
        }
    }

    _startAudio(url) {
        try {
            // blob:/data: URLs (Remote Mode pushes raw bytes) and absolute URLs
            // play as-is; backend-relative paths get the backend origin.
            this.audio.src = /^(blob:|data:|https?:)/.test(url) ? url : BASE_URL + url;
            this.audio.playbackRate = this.playbackRate;
            const p = this.audio.play();
            if (p && p.then) {
                p.then(() => {
                    if (IS_REMOTE && this._currentId != null) {
                        console.log(`[remote-tts] playback started on this device for notification ${this._currentId}`);
                    }
                }).catch((err) => this._onPlayRejected(err));
            }
            this._emitPlaybackState(true);
        } catch (err) {
            this._onPlaybackEnded();
        }
    }

    /**
     * play() rejected. In a plain-browser remote client the FIRST play can be
     * blocked by the autoplay policy until the user interacts with the page —
     * don't consume the clip: requeue it at the front and retry on the first
     * gesture. Any other rejection falls through to the normal ended path.
     */
    _onPlayRejected(err) {
        const blocked = IS_REMOTE && err && err.name === 'NotAllowedError';
        if (!blocked) return this._onPlaybackEnded();
        const id = this._currentId;
        const n = id != null ? this.items.get(id) : null;
        this.playing = false;
        this._currentId = null;
        this._currentIsReplay = false;
        this._emitPlaybackState(false);
        if (n && n.audio_url) this.playQueue.unshift(n);
        console.log('[remote-tts] autoplay blocked by the browser — will play on the first click/keypress');
        if (!this._gestureArmed) {
            this._gestureArmed = true;
            const unlock = () => {
                this._gestureArmed = false;
                document.removeEventListener('pointerdown', unlock, true);
                document.removeEventListener('keydown', unlock, true);
                this._drainQueue();
            };
            document.addEventListener('pointerdown', unlock, true);
            document.addEventListener('keydown', unlock, true);
        }
    }

    _onPlaybackEnded() {
        const finishedId = this._currentId;
        const wasReplay = this._currentIsReplay;
        if (this._currentId != null) {
            this._finalizePlayed(this._currentId); // mark played + clear hold count
            this._currentId = null;
        }
        if (this._held && this._held.id === finishedId) { this._held = null; this._clearHeldWatchdog(); }
        this._currentIsReplay = false;
        this.playing = false;
        this._emitPlaybackState(false);
        // Snapshot BEFORE draining (drain shifts the queue): only open a reply window
        // when this was the last notification to read out.
        const moreQueued = this.playQueue.length > 0 || this._held != null;
        this._drainQueue();
        // Auto-wake-after-notification: a notification's FIRST read-out just finished
        // and nothing else is queued — tell WakeWordManager to open a brief hands-free
        // reply window so the user can answer without the wake word. Skipped on replay
        // and while muted. WakeWordManager only acts if its spotter is enabled + idle.
        if (finishedId != null && !wasReplay && !moreQueued && !this.muted) {
            this.eventBus.emit('notification:read-complete', { id: finishedId });
        }
    }

    /** Explicit user replay of one row — plays now, regardless of mute/queue. */
    replay(id) {
        const n = this.items.get(id);
        if (!n || !n.audio_url) return;
        // Interrupt whatever is playing and abandon any clip held for resume —
        // the user explicitly chose this one, and the shared audio element is
        // about to load a different src.
        try { this.audio.pause(); } catch (_) {}
        this._held = null;
        this._clearHeldWatchdog();
        this.playing = true;
        this._currentId = id;
        this._currentIsReplay = true; // explicit replay: must NOT trigger auto-wake
        this._startAudio(n.audio_url);
    }

    // ---- settings hooks (called from renderer) -------------------------------

    setPlaybackRate(rate) {
        const r = Number(rate);
        if (!Number.isFinite(r)) return;
        this.playbackRate = Math.min(2, Math.max(0.5, r));
        if (this.playing) this.audio.playbackRate = this.playbackRate;
    }

    setAutoplay(enabled) { this.autoplay = !!enabled; }

    /**
     * Apply the muted state to playback + UI WITHOUT persisting. Used by the
     * preference event handlers (restore on startup, cross-tab sync) so they
     * don't re-emit preference:update and loop.
     */
    _applyMutedState(muted) {
        this.muted = !!muted;
        if (this.muted) {
            // Silence everything, not just the current clip: stop the current
            // audio and the heads-up chime; the queue stops draining while muted
            // (see _drainQueue's guard), so nothing new plays until unmuted.
            try { this.audio.pause(); } catch (_) {}
            try { this.headsUp.pause(); } catch (_) {}
            this.playing = false;
            this._clearHeldWatchdog();
            this._emitPlaybackState(false);
        } else {
            this._drainQueue();
        }
        this._updateMuteButtonUI();
    }

    /** Reflect mute state on the toolbar toggle (styling + icon + label). */
    _updateMuteButtonUI() {
        const btn = document.getElementById('notification-mute-btn');
        if (!btn) return;
        btn.classList.toggle('is-muted', this.muted);
        btn.setAttribute('aria-pressed', this.muted ? 'true' : 'false');
        const icon = btn.querySelector('i');
        if (icon) icon.setAttribute('data-lucide', this.muted ? 'volume-x' : 'volume-2');
        const label = btn.querySelector('.mute-toggle-label');
        if (label) label.textContent = this.muted ? 'Muted' : 'Sound on';
        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    }

    /** User-driven mute change: apply AND persist to preferences. */
    setMuted(muted) {
        this._applyMutedState(muted);
        this.eventBus.emit('preference:update', { key: 'notificationsMuted', value: this.muted });
    }

    toggleMuted() { this.setMuted(!this.muted); }

    /** Persist the user's preferred default voice to the backend config. */
    async setPreferredVoice(voice) {
        if (IS_REMOTE) return; // backend unreachable from a remote client (and localhost = the WRONG machine)
        try {
            await fetch(`${BASE_URL}/api/tts/config/`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ preferred_voice: voice }),
            });
        } catch (err) {
            this._log(`notifications: failed to save preferred voice (${err.message})`, 'warning');
        }
    }

    /** Synthesize a short sample in `voice` and play it (settings "Test" button). */
    async testVoice(voice) {
        if (IS_REMOTE) return; // backend unreachable from a remote client
        try {
            const res = await fetch(`${BASE_URL}/api/tts/speak/`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: 'This is how notifications will sound.', voice, source: 'test' }),
            });
            const data = await res.json();
            if (data && data.audio_url) {
                // Don't route test clips through the persisted-row queue.
                const a = new Audio(BASE_URL + data.audio_url);
                a.playbackRate = this.playbackRate;
                a.play().catch(() => {});
            }
        } catch (err) {
            this._log(`notifications: voice test failed (${err.message})`, 'warning');
        }
    }

    async clearAll() {
        // Remote client: never fetch localhost from the viewer's machine (that
        // is the CLIENT's loopback, not the backend). Clear the local view only.
        if (!IS_REMOTE) {
            try {
                await fetch(`${BASE_URL}/api/tts/notifications/`, { method: 'DELETE' });
            } catch (_) {}
        }
        for (const u of this._remoteBlobUrls.values()) {
            try { URL.revokeObjectURL(u); } catch (_) { /* ignore */ }
        }
        this._remoteBlobUrls.clear();
        this.items.clear();
        const list = document.getElementById('todo-list');
        if (list) list.innerHTML = '';
        // Keep lastSeenId: ids are monotonic, so we won't re-show deleted rows.
    }

    // ---- rendering -----------------------------------------------------------

    _wireToolbar() {
        const search = document.getElementById('todo-search');
        if (search) {
            search.addEventListener('input', (e) => {
                this.searchTerm = (e.target.value || '').toLowerCase();
                this._applySearch();
            });
        }
        const clearSearch = document.getElementById('todo-search-clear-btn');
        if (clearSearch) clearSearch.addEventListener('click', () => {
            if (search) search.value = '';
            this.searchTerm = '';
            this._applySearch();
        });
        const mute = document.getElementById('notification-mute-btn');
        if (mute) mute.addEventListener('click', () => this.toggleMuted());
        // Reflect the current (possibly pre-restored) mute state on first render.
        this._updateMuteButtonUI();
        const clearAll = document.getElementById('clear-notifications-btn');
        if (clearAll) clearAll.addEventListener('click', () => this.clearAll());
    }

    _applySearch() {
        const term = this.searchTerm;
        document.querySelectorAll('.notification-item').forEach((row) => {
            const text = (row.dataset.text || '').toLowerCase();
            row.style.display = !term || text.includes(term) ? '' : 'none';
        });
    }

    _renderItem(n, { prepend }) {
        this.items.set(n.id, n);
        const list = document.getElementById('todo-list');
        if (!list) return;

        const row = document.createElement('div');
        row.className = 'notification-item' + (n.played ? ' played' : '');
        row.dataset.id = n.id;
        row.dataset.text = n.text || '';

        const when = this._formatTime(n.created_at);
        const term = n.terminal_name || (n.terminal_id != null ? `#${n.terminal_id}` : 'system');

        row.innerHTML = `
            <div class="notification-header">
                <span class="notification-terminal">${this._esc(term)}</span>
                <span class="notification-voice">${this._esc(n.voice || '')}</span>
                <span class="notification-time">${this._esc(when)}</span>
            </div>
            <div class="notification-text">${this._esc(n.text || '')}</div>
            <div class="notification-actions">
                <button class="notification-replay-btn" title="Play this notification">
                    <i data-lucide="play"></i>
                </button>
            </div>`;

        const replayBtn = row.querySelector('.notification-replay-btn');
        if (replayBtn) replayBtn.addEventListener('click', () => this.replay(n.id));

        if (prepend && list.firstChild) list.insertBefore(row, list.firstChild);
        else if (prepend) list.appendChild(row);
        else list.appendChild(row);

        if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
        if (this.searchTerm) this._applySearch();
    }

    _formatTime(iso) {
        try {
            const d = new Date(iso);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (_) { return ''; }
    }

    _esc(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    _log(message, type = 'info') {
        try { this.eventBus.emit('log:action', { message, type }); } catch (_) {}
    }
}

module.exports = NotificationManager;
