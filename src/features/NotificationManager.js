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

        // Short heads-up chime played right before each spoken notification so
        // the user knows one is about to read out.
        this.headsUp = new Audio('assets/soundeffects/click2.wav');
        this.headsUp.volume = 0.5;

        this._setupPreferenceListeners();
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
        this.playQueue.push(n);
        this._drainQueue();
    }

    _drainQueue() {
        if (this.playing || this.muted) return;
        const n = this.playQueue.shift();
        if (!n) return;
        this.playing = true;
        this._currentId = n.id;
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
        if (this._currentId != null) {
            // Best-effort: mark as played server-side.
            fetch(`${BASE_URL}/api/tts/notifications/${this._currentId}/played/`, { method: 'POST' }).catch(() => {});
            const row = document.querySelector(`.notification-item[data-id="${this._currentId}"]`);
            if (row) row.classList.add('played');
            this._currentId = null;
        }
        this.playing = false;
        this._drainQueue();
    }

    /** Explicit user replay of one row — plays now, regardless of mute/queue. */
    replay(id) {
        const n = this.items.get(id);
        if (!n || !n.audio_url) return;
        // Interrupt whatever is playing.
        try { this.audio.pause(); } catch (_) {}
        this.playing = true;
        this._currentId = id;
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
