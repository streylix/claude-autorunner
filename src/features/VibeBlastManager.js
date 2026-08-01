/**
 * VibeBlastManager - the hold-to-Send easter egg in the right sidebar.
 *
 * Hold the send button for a second and a half while the message box is empty
 * and the sidebar is pushed up out of the way, revealing Vibe Blast underneath.
 * The hold has no on-screen tell — the button looks ordinary until it opens.
 * The game itself lives in vibe-blast.html and runs in an iframe: it ships a
 * bare `button {}` rule and ids like #board and #best, either of which would
 * trample the app if it were inlined.
 *
 * The game never talks to the network. It asks this manager for a key and this
 * manager decides where that lands — the Django save endpoint when it answers,
 * localStorage when it doesn't — and tells the game which, so the game can say
 * on screen that a score is device-local.
 */
const { BACKEND_URL } = require('../utils/backend-url');

const HOLD_MS = 1500;
const SLIDE_MS = 520;
const SAVE_ENDPOINT = `${BACKEND_URL}/api/game/vibe-blast/`;
// Generous: this fires while the app is still spawning terminals, and a
// timeout here would wrongly tell the player their score is device-local.
const REQUEST_TIMEOUT_MS = 8000;
const CIRCUIT_MS = 10000; // back off this long after a failed write
const RETRY_MS = 15000;   // ...then quietly try to reconnect
const FLUSH_DEBOUNCE_MS = 400;
const LOCAL_KEY = 'vibeblast:save';

// The two keys the game asks for, mapped onto the save record's columns.
const KEY_BEST = 'vibeblast:best';
const KEY_STATE = 'vibeblast:state';

class VibeBlastManager {
    constructor(eventBus, appStateStore) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;

        this.isOpen = false;
        this.frame = null;
        this.holdTimer = null;
        this.closeTimer = null;
        this.suppressClickUntil = 0;

        // Persistence state. `backed` is null until the first round trip:
        // true = the database answered, false = localStorage only.
        this.backed = null;
        this.loaded = false;
        this.save = { best: 0, state: '' };
        this.flushTimer = null;
        this.circuitUntil = 0;
        this.loadPromise = null;
        this.reconnectTimer = null;
    }

    initialize() {
        this.sidebar = document.getElementById('right-sidebar');
        this.panel = document.getElementById('vibe-panel');
        this.stage = document.getElementById('vibe-stage');
        this.flap = document.getElementById('vibe-flap');
        this.sendBtn = document.getElementById('send-btn');
        this.input = document.getElementById('message-input');

        if (!this.sidebar || !this.panel || !this.stage || !this.sendBtn) return;

        this.bindHold();

        if (this.flap) this.flap.addEventListener('click', () => this.close());

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen) this.close();
        });

        window.addEventListener('message', (e) => this.handleGameMessage(e));

        // The panel's geometry is written as PIXELS (see syncMetrics), so it
        // goes stale the moment the window is resized — the panel would keep
        // its old height and stop sitting on the bottom of the sidebar. Track
        // the sidebar's box instead of measuring once at open time.
        if (typeof ResizeObserver !== 'undefined') {
            this.sizeObserver = new ResizeObserver(() => this.syncMetrics());
            this.sizeObserver.observe(this.sidebar);
        } else {
            window.addEventListener('resize', () => this.syncMetrics());
        }
        // --vibe-top follows the sidebar's scroll position for the same reason.
        this.sidebar.addEventListener('scroll', () => this.syncMetrics());

        // The app's theme lives on <html data-theme>; mirror every change into
        // the game so it can never sit in light mode inside a dark app.
        this.themeObserver = new MutationObserver(() => this.postTheme());
        this.themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
    }

    currentTheme() {
        return document.documentElement.getAttribute('data-theme') || 'system';
    }

    postTheme() {
        if (!this.frame || !this.frame.contentWindow) return;
        try {
            this.frame.contentWindow.postMessage(
                { source: 'vibe-blast-host', op: 'theme', theme: this.currentTheme() }, '*'
            );
        } catch (_) { /* frame not ready; open() posts again once it is */ }
    }

    // ---------- the easter egg ----------

    bindHold() {
        this.sendBtn.addEventListener('pointerdown', (e) => this.startHold(e));
        this.sendBtn.addEventListener('pointerup', () => this.cancelHold());
        this.sendBtn.addEventListener('pointerleave', () => this.cancelHold());
        this.sendBtn.addEventListener('pointercancel', () => this.cancelHold());

        // A completed hold must not also queue an empty message. Listeners on the
        // target element itself fire in registration order no matter their capture
        // flag, so renderer.js's own click handler can only be preempted from an
        // ancestor in the capture phase.
        document.addEventListener('click', (e) => {
            if (Date.now() >= this.suppressClickUntil) return;
            if (!e.target || !e.target.closest || !e.target.closest('#send-btn')) return;
            this.suppressClickUntil = 0;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true);
    }

    /** Only an empty box with nothing attached arms the hold — a real message
     *  being sent must never be swallowed by a slow click. */
    inputIsEmpty() {
        const text = this.input ? this.input.value.trim() : '';
        if (text.length > 0) return false;
        const previews = document.getElementById('image-preview-list');
        return !previews || previews.children.length === 0;
    }

    startHold(e) {
        if (this.isOpen) return;
        if (e && e.button != null && e.button !== 0) return;
        if (!this.inputIsEmpty()) return;

        this.cancelHold();
        this.holdTimer = setTimeout(() => {
            this.holdTimer = null;
            // Self-expiring rather than a flag, so a hold that ends with the
            // pointer somewhere else can't leave a trap for a later click.
            this.suppressClickUntil = Date.now() + 800;
            this.open();
        }, HOLD_MS);
    }

    cancelHold() {
        if (this.holdTimer) {
            clearTimeout(this.holdTimer);
            this.holdTimer = null;
        }
    }

    // ---------- geometry ----------

    /**
     * Push the sidebar's current height and scroll offset into the two custom
     * properties the slide is built on.
     *
     * These have to be pixel values: the panel and its siblings move by the
     * SAME distance, and a percentage transform would resolve against each
     * element's own height and shear them apart mid-flight. The cost of pixels
     * is that they don't self-update, which is what this method is for.
     *
     * @param {boolean} immediate - skip the transition suppression (used by
     *        open(), where the slide animation is the whole point).
     */
    syncMetrics({ immediate = false } = {}) {
        if (!this.isOpen || !this.sidebar) return;

        const shift = this.sidebar.clientHeight;
        const top = this.sidebar.scrollTop;
        if (shift === this.lastShift && top === this.lastTop) return;
        this.lastShift = shift;
        this.lastTop = top;

        if (!immediate) {
            // A live resize must not animate: the transform is driven by the
            // value being changed, so leaving the 520ms slide on would make the
            // panel lag the window edge on every frame of a drag.
            this.sidebar.classList.add('vibe-resizing');
            clearTimeout(this.resizeSettleTimer);
            this.resizeSettleTimer = setTimeout(() => {
                this.sidebar.classList.remove('vibe-resizing');
            }, 120);
        }

        this.sidebar.style.setProperty('--vibe-shift', `${shift}px`);
        this.sidebar.style.setProperty('--vibe-top', `${top}px`);
    }

    // ---------- the slide ----------

    open() {
        if (this.isOpen) return;
        this.isOpen = true;
        clearTimeout(this.closeTimer);

        this.ensureFrame();

        // Both halves of the push move by this exact pixel amount; --vibe-top
        // keeps the panel on the visible strip if the sidebar happens to be
        // scrolled when the game opens.
        this.syncMetrics({ immediate: true });

        this.panel.removeAttribute('inert');
        this.sidebar.classList.add('vibe-active');
        void this.panel.offsetHeight; // commit the start position before transitioning
        requestAnimationFrame(() => {
            if (this.isOpen) this.sidebar.classList.add('vibe-open');
        });

        this.postTheme();
        this.postStatus();
        if (this.eventBus) {
            this.eventBus.emit('log:action', { message: 'Games panel opened', type: 'info' });
            // GamesManager hands keyboard control to the game on this.
            this.eventBus.emit('games:panel-opened', {});
        }
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;

        this.panel.setAttribute('inert', '');
        this.sidebar.classList.remove('vibe-open');
        if (this.eventBus) this.eventBus.emit('games:panel-closed', {});

        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => {
            if (this.isOpen) return;
            this.sidebar.classList.remove('vibe-active');
            this.sidebar.classList.remove('vibe-resizing');
            this.sidebar.style.removeProperty('--vibe-shift');
            this.sidebar.style.removeProperty('--vibe-top');
            // The properties are gone, so the memo of what was last written
            // has to go too — otherwise reopening at an unchanged size would
            // hit syncMetrics' no-change guard and never re-set them.
            this.lastShift = null;
            this.lastTop = null;
        }, SLIDE_MS + 40);
    }

    /** Built on first reveal, not at startup — an unopened easter egg costs
     *  nothing. Kept alive afterwards so the run survives closing the panel. */
    ensureFrame() {
        if (this.frame) return;
        this.frame = document.createElement('iframe');
        this.frame.title = this.currentGameTitle || 'Vibe Blast';
        this.frame.setAttribute('allow', 'autoplay');
        // tabindex makes the frame itself focusable, which is what lets the
        // games rail hand keyboard control (WASD / arrows) to the game.
        this.frame.setAttribute('tabindex', '0');
        // The theme has to land before the board paints, so push it as soon as
        // the document exists rather than waiting for the next app-side change.
        this.frame.addEventListener('load', () => {
            this.postTheme();
            this.postStatus();
        });
        this.frame.src = this.currentGameSrc || 'vibe-blast.html';
        this.stage.appendChild(this.frame);
    }

    /**
     * Point the stage at a game. Called by GamesManager, which owns which game
     * is selected; this manager only owns the frame and the storage bridge.
     *
     * `force` re-navigates even when the URL is unchanged, which is how a
     * hot-reload of the currently-playing game happens (the URL carries the
     * file's mtime, so in practice it changes anyway).
     */
    loadGame(src, { force = false } = {}) {
        this.currentGameSrc = src;
        if (!this.frame) {
            // Not opened yet — ensureFrame() will pick up currentGameSrc.
            return;
        }
        const current = this.frame.getAttribute('src');
        if (!force && current === src) return;
        this.frame.setAttribute('src', src);
    }

    // ---------- the storage bridge ----------

    handleGameMessage(e) {
        const msg = e.data;
        if (!msg || msg.source !== 'vibe-blast') return;
        if (!this.frame || e.source !== this.frame.contentWindow) return;

        const reply = (payload) => {
            try {
                e.source.postMessage(Object.assign(
                    { source: 'vibe-blast-host', id: msg.id, backed: this.backed },
                    payload
                ), '*');
            } catch (_) { /* frame went away mid-flight */ }
        };

        const run = async () => {
            if (msg.op === 'get') return { result: { value: await this.getKey(msg.key) } };
            if (msg.op === 'set') { await this.setKey(msg.key, msg.value); return { result: { ok: true } }; }
            return { error: `unknown op ${msg.op}` };
        };

        run().then(reply).catch((err) => reply({ error: err.message || 'storage failed' }));
    }

    async getKey(key) {
        await this.ensureLoaded();
        if (key === KEY_BEST) return String(this.save.best);
        if (key === KEY_STATE) return this.save.state || '';
        return null;
    }

    async setKey(key, value) {
        await this.ensureLoaded();
        if (key === KEY_BEST) this.save.best = parseInt(value, 10) || 0;
        else if (key === KEY_STATE) this.save.state = String(value == null ? '' : value);
        else return;

        // localStorage is always written, not just when offline, so it stays a
        // true mirror and a later disconnect resumes from the same place.
        this.writeLocal();
        this.scheduleFlush();
    }

    /** Loads the save exactly once — but a FAILED load is not cached, so a
     *  backend that was briefly unreachable gets picked up on the next write
     *  instead of stranding the game on localStorage until a reload. Concurrent
     *  callers share the one in-flight attempt. */
    ensureLoaded() {
        if (this.loaded) return Promise.resolve();
        if (this.loadPromise) return this.loadPromise;
        this.loadPromise = this.loadSave().then(() => {
            this.loadPromise = null;
        });
        return this.loadPromise;
    }

    async loadSave() {
        try {
            const res = await fetch(SAVE_ENDPOINT, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            if (!res.ok) throw new Error(`GET ${SAVE_ENDPOINT} -> ${res.status}`);
            const data = await res.json();
            this.save = {
                best: Number(data.best_score) || 0,
                state: typeof data.state === 'string' ? data.state : ''
            };
            this.loaded = true;
            this.setBacked(true);

            // A run played while the backend was down leaves a higher local best.
            // Carry the number up, but not the board — the server's run is the
            // one the player would expect to still be sitting there.
            const local = this.readLocal();
            if (local && local.best > this.save.best) {
                this.save.best = local.best;
                this.scheduleFlush();
            }
        } catch (err) {
            // Deliberately not setting this.loaded — see ensureLoaded.
            const local = this.readLocal();
            if (local) this.save = local;
            this.setBacked(false);
            this.scheduleReconnect();
        }
    }

    /** Poll gently in the background so the "saved locally" notice clears
     *  itself once the backend is up, without the player doing anything. */
    scheduleReconnect() {
        if (this.reconnectTimer || !this.frame) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.loaded) return;
            this.ensureLoaded().then(() => {
                // Reconnected with local progress in hand — push it up.
                if (this.loaded) this.scheduleFlush();
            });
        }, RETRY_MS);
    }

    scheduleFlush() {
        clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS);
    }

    async flush() {
        if (Date.now() < this.circuitUntil) { this.setBacked(false); return; }
        try {
            const res = await fetch(SAVE_ENDPOINT, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ best_score: this.save.best, state: this.save.state }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
            if (!res.ok) throw new Error(`PUT ${SAVE_ENDPOINT} -> ${res.status}`);
            // The server refuses to lower a best score, so its answer is the
            // authority: adopt it, or a record set in another attached renderer
            // would keep getting overwritten locally.
            const data = await res.json();
            if (Number(data.best_score) > this.save.best) {
                this.save.best = Number(data.best_score);
                this.writeLocal();
            }
            this.circuitUntil = 0;
            this.setBacked(true);
        } catch (err) {
            // Open the circuit rather than retry-hammering a dead backend. The
            // localStorage mirror already holds this write.
            this.circuitUntil = Date.now() + CIRCUIT_MS;
            this.setBacked(false);
            this.loaded = false;
            this.scheduleReconnect();
        }
    }

    setBacked(value) {
        if (this.backed === value) return;
        this.backed = value;
        this.postStatus();
        if (this.eventBus && value === false) {
            this.eventBus.emit('log:action', {
                message: 'Vibe Blast: backend unreachable, saving scores locally',
                type: 'warning'
            });
        }
    }

    postStatus() {
        if (!this.frame || !this.frame.contentWindow) return;
        try {
            this.frame.contentWindow.postMessage(
                { source: 'vibe-blast-host', op: 'status', backed: this.backed }, '*'
            );
        } catch (_) { /* not loaded yet; the next reply carries the flag */ }
    }

    readLocal() {
        try {
            const raw = localStorage.getItem(LOCAL_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return {
                best: Number(parsed.best) || 0,
                state: typeof parsed.state === 'string' ? parsed.state : ''
            };
        } catch (_) {
            return null;
        }
    }

    writeLocal() {
        try {
            localStorage.setItem(LOCAL_KEY, JSON.stringify(this.save));
        } catch (_) { /* quota or private mode — the run just won't survive a reload */ }
    }
}

module.exports = VibeBlastManager;
