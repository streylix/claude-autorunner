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
 */

const BASE_URL = 'http://localhost:8123';
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
// interruptions we stop deferring: mark it played and move on. NEVER replay it.
const MAX_HOLDS_PER_MESSAGE = 3;

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
        // If a notification is mid-readout when the user starts talking, halt it and
        // re-queue it to the FRONT so it isn't lost — it replays once they're silent.
        if (!wasSpeaking && this.playing) this._holdCurrentPlayback();
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
     * (see _drainQueue). The loop guard caps how many times one clip may be
     * interrupted — past the cap we stop deferring, mark it played, and move on,
     * so noise/echo can never restart-and-replay it forever.
     */
    _holdCurrentPlayback() {
        try { this.audio.pause(); } catch (_) {}
        try { this.headsUp.pause(); this.headsUp.currentTime = 0; } catch (_) {}
        const id = this._currentId;
        if (id != null && !this._currentIsReplay) {
            const count = (this._holdCounts.get(id) || 0) + 1;
            this._holdCounts.set(id, count);
            if (count > MAX_HOLDS_PER_MESSAGE) {
                // Interrupted too many times — give up deferring it. Cancel cleanly:
                // mark played and move on. Never replay.
                this._finalizePlayed(id);
                this._held = null;
            } else {
                this._held = { id }; // resume from the current position later
            }
        }
        this.playing = false;
        this._currentId = null;
    }

    /**
     * Mark a notification played (server-side, best-effort) and forget its hold
     * count + UI state. Used both on natural completion and when the loop guard
     * cancels a clip that keeps getting interrupted.
     */
    _finalizePlayed(id) {
        if (id == null) return;
        this._holdCounts.delete(id);
        fetch(`${BASE_URL}/api/tts/notifications/${id}/played/`, { method: 'POST' }).catch(() => {});
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
            // Restore the persisted mute state (survives navigation/restart).
            if (prefs.notificationsMuted != null) this._applyMutedState(!!prefs.notificationsMuted);
        });
        // Live changes. _applyMutedState (NOT setMuted) so we don't re-emit
        // preference:update and loop with PreferenceManager.
        this.eventBus.on('preference:changed', ({ key, value }) => {
            if (key === 'ttsPlaybackSpeed') this.setPlaybackRate(value);
            else if (key === 'ttsAutoplayEnabled') this.autoplay = !!value;
            else if (key === 'notificationsMuted') this._applyMutedState(!!value);
        });
    }

    async initialize() {
        await this.loadHistory();
        this.startPolling();
        this._wireToolbar();
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
            const { id } = this._held;
            this._held = null;
            const n = this.items.get(id);
            if (n && n.audio_url) {
                this.playing = true;
                this._currentId = id;
                this._currentIsReplay = false;
                const p = this.audio.play();
                if (p && p.catch) p.catch(() => this._onPlaybackEnded());
                return;
            }
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
            this.audio.src = BASE_URL + url;
            this.audio.playbackRate = this.playbackRate;
            const p = this.audio.play();
            if (p && p.catch) p.catch(() => this._onPlaybackEnded());
        } catch (err) {
            this._onPlaybackEnded();
        }
    }

    _onPlaybackEnded() {
        const finishedId = this._currentId;
        const wasReplay = this._currentIsReplay;
        if (this._currentId != null) {
            this._finalizePlayed(this._currentId); // mark played + clear hold count
            this._currentId = null;
        }
        if (this._held && this._held.id === finishedId) this._held = null;
        this._currentIsReplay = false;
        this.playing = false;
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
        try {
            await fetch(`${BASE_URL}/api/tts/notifications/`, { method: 'DELETE' });
        } catch (_) {}
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
