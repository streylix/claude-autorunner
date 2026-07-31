/**
 * BrowserBridge - the tabs behind the Browser card.
 *
 * The card (browser.html) draws the chrome — the tab strip, back, forward,
 * reload, the address bar — but it cannot draw a page. Two reasons, and the
 * second is the one that shapes this file:
 *
 *  1. An iframe cannot show instagram.com. Nor x.com, nor reddit, nor anything
 *     else worth scrolling: they all send X-Frame-Options or a frame-ancestors
 *     CSP. Only a <webview>, which is a real guest process rather than a frame,
 *     gets to load them.
 *
 *  2. A <webview> only exists in the MAIN frame. The custom element is not
 *     registered inside nested iframes, so the card — which IS a nested iframe,
 *     on the stage — can create the element but gets an inert one back.
 *
 * So the pages live up here, in the app's own document: one <webview> per tab,
 * all of them fixed-position elements floated over the stage, with only the
 * active one visible. The card measures the hole it left and posts that
 * rectangle; this bridge converts it to page coordinates every frame (the panel
 * slides, the window resizes, the sidebar scrolls) and keeps the active tab
 * pinned to it.
 *
 * Nothing is ever destroyed except by closing a tab. A background tab, a
 * detour into another game, a closed panel — all of them only hide and mute
 * the view, so scroll position, playback and session survive. Which is the
 * whole point: the card exists so a feed can be somewhere you glance at, not
 * something you reload.
 *
 * The handshake, the token, and the wire format are MoonlightBridge's, for the
 * same reason: `file://` frames each get an opaque origin, so `e.source ===
 * frame.contentWindow` never matches and the trust has to run the other way —
 * the token is posted TO the stage frame and only ever read by whoever is on it.
 */
const crypto = require('crypto');

const CARD_URL = 'browser.html';

// Must match src/main/browser-game.js, which is where the session policy for
// this partition is set. A mismatch is refused at attach time.
const PARTITION = 'persist:browser-game';

const HOME = 'https://www.instagram.com/';
const PREFS_KEY = 'browserGame:prefs';
const MAX_TABS = 12;

// The panel is a sidebar — a phone-shaped column. A desktop UA gets a layout
// built for 1400px squeezed into 400 and reads terribly, so mobile is the
// default and the card can toggle.
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const ALLOWED_OPS = new Set([
    'place', 'navigate', 'back', 'forward', 'reload', 'stop',
    'home', 'ua', 'clear', 'state', 'focus',
    'new-tab', 'close-tab', 'activate',
]);

const isWebUrl = (url) => /^https?:\/\//i.test(url || '');

class BrowserBridge {
    constructor(eventBus, ipcHandler, vibeBlastManager) {
        this.eventBus = eventBus;
        this.ipc = ipcHandler;
        this.vibe = vibeBlastManager;

        this.tabs = [];          // [{ id, view, ready, url, title, loading }]
        this.activeId = null;
        this.nextTabId = 1;

        this.token = null;
        this.visible = false;
        this.rect = null;        // last rectangle the card asked for, iframe-relative
        this.box = null;         // last geometry actually written, page coordinates
        this.rafId = null;
        this.boundMessage = null;
        // Prefs load lazily on first access (see the getter below), NOT here:
        // readPrefs() hits localStorage, and the renderer's first localStorage
        // access synchronously initializes the whole storage area — too
        // expensive for the boot path. First real access is when the Browser
        // card opens, well after boot.
        this._prefs = null;
    }

    get prefs() {
        if (!this._prefs) this._prefs = this.readPrefs();
        return this._prefs;
    }

    set prefs(value) {
        this._prefs = value;
    }

    initialize() {
        if (!this.vibe) return;

        this.boundMessage = (e) => this.handleMessage(e);
        window.addEventListener('message', this.boundMessage);

        if (this.eventBus) {
            // A closed panel must not leave a web page floating over the app.
            this.eventBus.on('games:panel-closed', () => this.hide());
            this.eventBus.on('games:panel-opened', () => this.startTracking());
        }

        // A link that asked for a new window. Main refuses to open one and
        // sends it here instead, where "new window" means "new tab".
        if (this.ipc && this.ipc.on) {
            this.ipc.on('browser-game:popup', (_e, payload) => {
                if (!this.tabs.length || !payload || !isWebUrl(payload.url)) return;
                this.openTab(payload.url, { activate: true });
                this.pushTabs();
            });
        }
    }

    dispose() {
        if (this.boundMessage) window.removeEventListener('message', this.boundMessage);
        this.boundMessage = null;
        this.stopTracking();
    }

    // ---------- the bridge ----------

    stageWindow() {
        const frame = this.vibe && this.vibe.frame;
        return frame && frame.contentWindow ? frame.contentWindow : null;
    }

    /** True while the Browser card itself is the game on the stage. */
    stageIsCard() {
        const frame = this.vibe && this.vibe.frame;
        if (!frame) return false;
        const src = frame.getAttribute('src') || '';
        return src.split('?')[0] === CARD_URL;
    }

    post(message) {
        const target = this.stageWindow();
        if (!target) return;
        try {
            target.postMessage(message, '*');
        } catch (_) { /* frame navigated away mid-send */ }
    }

    /** Mint a token and hand it to the stage frame — never to the requester. */
    handshake() {
        if (!this.stageIsCard()) return;
        this.token = crypto.randomBytes(24).toString('hex');
        this.post({ source: 'browser-host', op: 'welcome', token: this.token, home: HOME });
    }

    handleMessage(e) {
        const msg = e.data;
        if (!msg || msg.source !== 'browser') return;

        if (msg.op === 'handshake') {
            this.handshake();
            return;
        }

        if (!msg.id) return;

        const reply = (payload) => {
            try {
                e.source.postMessage(
                    Object.assign({ source: 'browser-host', id: msg.id }, payload), '*'
                );
            } catch (_) { /* frame went away mid-flight */ }
        };

        if (!this.token || msg.token !== this.token || !this.stageIsCard()) {
            reply({ ok: false, error: 'stale', stale: true });
            return;
        }

        if (!ALLOWED_OPS.has(msg.op)) {
            reply({ ok: false, error: `unknown op ${msg.op}` });
            return;
        }

        Promise.resolve()
            .then(() => this.run(msg.op, msg.args || {}))
            .then((result) => reply({ ok: true, result }))
            .catch((err) => reply({ ok: false, error: err.message || 'request failed' }));
    }

    async run(op, args) {
        this.ensureTabs();
        const tab = this.activeTab();

        switch (op) {
            case 'place':
                this.rect = args.rect || null;
                this.startTracking();
                break;

            case 'navigate': {
                const url = String(args.url || '');
                if (!isWebUrl(url)) throw new Error('only http(s) addresses');
                tab.view.setAttribute('src', url);
                break;
            }

            case 'home':
                tab.view.setAttribute('src', HOME);
                break;

            case 'back':
                if (tab.ready && tab.view.canGoBack()) tab.view.goBack();
                break;

            case 'forward':
                if (tab.ready && tab.view.canGoForward()) tab.view.goForward();
                break;

            case 'reload':
                if (tab.ready) tab.view.reload();
                break;

            case 'stop':
                if (tab.ready) tab.view.stop();
                break;

            case 'focus':
                this.focusActive();
                break;

            case 'new-tab':
                this.openTab(isWebUrl(args.url) ? args.url : HOME, { activate: true });
                break;

            case 'close-tab':
                this.closeTab(args.id);
                break;

            case 'activate':
                this.activate(args.id);
                break;

            case 'ua': {
                // A UA change is a different site, not a different rendering, so
                // every tab reloads — leaving half the tabs on the desktop
                // layout would read as a bug.
                const mobile = args.mode !== 'desktop';
                this.savePrefs({ mobile });
                const ua = this.userAgent();
                this.tabs.forEach((t) => {
                    t.view.setAttribute('useragent', ua);
                    if (!t.ready) return;
                    try {
                        t.view.setUserAgent(ua);
                        t.view.reload();
                    } catch (_) { /* the attribute covers its next load */ }
                });
                break;
            }

            case 'clear': {
                await this.ipc.invoke('browser-game:clear');
                this.eventBus?.emit('log:action', {
                    message: 'Browser: cookies and cache cleared',
                    type: 'info',
                });
                this.tabs.forEach((t) => { if (t.ready) t.view.reload(); });
                break;
            }

            case 'state':
            default:
                break;
        }

        return this.snapshot();
    }

    // ---------- tabs ----------

    activeTab() {
        return this.tabs.find((t) => t.id === this.activeId) || this.tabs[0] || null;
    }

    /** First contact: restore last session's tabs, or open one on the home page. */
    ensureTabs() {
        if (this.tabs.length) return;
        const urls = (this.prefs.tabs || []).filter(isWebUrl).slice(0, MAX_TABS);
        const list = urls.length ? urls : [HOME];
        list.forEach((url) => this.openTab(url, { activate: false }));
        const index = Math.min(Math.max(this.prefs.active | 0, 0), this.tabs.length - 1);
        this.activate(this.tabs[index].id);
    }

    userAgent() {
        if (this.prefs.mobile) return MOBILE_UA;
        // Electron's own UA names itself and the app, which some sites treat as
        // an unknown browser. Strip both tokens and what is left is Chrome.
        return navigator.userAgent
            .replace(/\s*Electron\/[\d.]+/i, '')
            .replace(/\s*(auto-injector|claude-autorunner)\/[\d.]+/i, '')
            .trim();
    }

    openTab(url, { activate = true } = {}) {
        if (this.tabs.length >= MAX_TABS) {
            this.eventBus?.emit('log:action', {
                message: `Browser: ${MAX_TABS} tabs is the limit — close one first`,
                type: 'warning',
            });
            return null;
        }

        const tab = {
            id: `t${this.nextTabId++}`,
            view: null,
            ready: false,
            url,
            title: '',
            loading: true,
        };

        const view = document.createElement('webview');
        view.className = 'browser-game-view hidden';
        view.setAttribute('partition', PARTITION);
        // Popups are denied in main and reported back as tabs; the attribute is
        // what makes the window-open handler run at all rather than the guest
        // silently dropping the click.
        view.setAttribute('allowpopups', 'on');
        view.setAttribute('useragent', this.userAgent());
        view.setAttribute('src', url);

        view.addEventListener('dom-ready', () => {
            tab.ready = true;
            try { view.setAudioMuted(tab.id !== this.activeId || !this.visible); } catch (_) { /* gone */ }
            this.pushTabs();
        });

        const bump = () => {
            this.readTab(tab);
            this.pushTabs();
        };
        ['did-start-loading', 'did-stop-loading', 'did-navigate',
            'did-navigate-in-page', 'page-title-updated'].forEach((evt) => {
            view.addEventListener(evt, bump);
        });
        view.addEventListener('did-fail-load', (e) => {
            // -3 is ABORTED, which is what an ordinary in-page navigation
            // cancels itself with; showing it would flag half of Instagram.
            if (e.errorCode === -3 || e.isMainFrame === false) return;
            this.push({ event: 'error', message: e.errorDescription || 'load failed' });
        });

        tab.view = view;
        document.body.appendChild(view);
        this.tabs.push(tab);

        if (activate) this.activate(tab.id);
        this.scheduleSave();
        return tab;
    }

    activate(id) {
        const tab = this.tabs.find((t) => t.id === id);
        if (!tab || this.activeId === id) return;

        const previous = this.activeTab();
        if (previous && previous !== tab) {
            previous.view.classList.add('hidden');
            try { if (previous.ready) previous.view.setAudioMuted(true); } catch (_) { /* gone */ }
        }

        this.activeId = id;
        // The incoming view has whatever geometry it was last given (or none),
        // so force the next frame to write all four numbers rather than
        // short-circuit on an unchanged box.
        this.box = null;
        this.visible = false;
        this.scheduleSave();
    }

    closeTab(id) {
        const index = this.tabs.findIndex((t) => t.id === id);
        if (index === -1) return;

        const [tab] = this.tabs.splice(index, 1);
        // The one place a guest is genuinely torn down: closing a tab is the
        // user saying the page can go.
        tab.view.remove();

        if (this.activeId === id) {
            this.activeId = null;
            const next = this.tabs[index] || this.tabs[index - 1];
            if (next) this.activate(next.id);
        }
        // Never leave the card staring at nothing.
        if (!this.tabs.length) this.openTab(HOME, { activate: true });

        this.scheduleSave();
    }

    focusActive() {
        const tab = this.activeTab();
        if (!tab) return;
        try { tab.view.focus(); } catch (_) { /* not attached yet */ }
    }

    /** Re-read a tab's live state from its guest. Cheap, and the only source of
     *  truth — the guest navigates on its own all the time. */
    readTab(tab) {
        if (!tab.ready) return;
        try {
            tab.url = tab.view.getURL() || tab.url;
            tab.title = tab.view.getTitle() || '';
            tab.loading = tab.view.isLoading();
        } catch (_) { /* torn down mid-read */ }
    }

    snapshot() {
        const tabs = this.tabs.map((t) => {
            let back = false;
            let forward = false;
            if (t.ready) {
                try { back = t.view.canGoBack(); forward = t.view.canGoForward(); } catch (_) { /* gone */ }
            }
            return {
                id: t.id,
                url: t.url || '',
                title: t.title || '',
                loading: !!t.loading,
                active: t.id === this.activeId,
                back,
                forward,
            };
        });
        return { tabs, activeId: this.activeId, mobile: !!this.prefs.mobile };
    }

    push(payload) {
        this.post(Object.assign({ source: 'browser-host' }, payload));
    }

    pushTabs() {
        this.push({ event: 'tabs', payload: this.snapshot() });
        this.scheduleSave();
    }

    // ---------- geometry ----------
    //
    // The card's hole is measured inside the stage iframe, so its rectangle is
    // relative to that frame. Everything the frame sits in moves: the panel
    // slides on a 520ms transform when it opens, the sidebar can be scrolled or
    // resized, the window itself can be dragged to another screen. Rather than
    // subscribe to all of that, the position is simply recomputed each frame
    // while the panel is open — one getBoundingClientRect, and writes only when
    // a number actually changed.

    startTracking() {
        if (this.rafId != null) return;
        const step = () => {
            this.rafId = requestAnimationFrame(step);
            this.track();
        };
        this.rafId = requestAnimationFrame(step);
    }

    stopTracking() {
        if (this.rafId != null) cancelAnimationFrame(this.rafId);
        this.rafId = null;
    }

    track() {
        const frame = this.vibe && this.vibe.frame;
        const tab = this.activeTab();
        if (!frame || !tab || !this.rect || !this.stageIsCard() || !this.vibe.isOpen) {
            this.hide();
            return;
        }

        const stage = frame.getBoundingClientRect();
        // Clipped to the stage: a panel shorter than the card must crop the page
        // rather than let it spill over the terminals.
        const left = Math.max(stage.left, stage.left + this.rect.x);
        const top = Math.max(stage.top, stage.top + this.rect.y);
        const right = Math.min(stage.right, stage.left + this.rect.x + this.rect.w);
        const bottom = Math.min(stage.bottom, stage.top + this.rect.y + this.rect.h);
        const width = right - left;
        const height = bottom - top;

        if (width < 4 || height < 4) {
            this.hide();
            return;
        }

        const box = { left, top, width, height };
        if (!this.box || ['left', 'top', 'width', 'height']
            .some((k) => Math.abs(this.box[k] - box[k]) > 0.5)) {
            const style = tab.view.style;
            style.left = `${Math.round(left)}px`;
            style.top = `${Math.round(top)}px`;
            style.width = `${Math.round(width)}px`;
            style.height = `${Math.round(height)}px`;
            this.box = box;
        }

        this.show();
    }

    show() {
        const tab = this.activeTab();
        if (this.visible || !tab) return;
        this.visible = true;
        tab.view.classList.remove('hidden');
        try { if (tab.ready) tab.view.setAudioMuted(false); } catch (_) { /* gone */ }
    }

    /** Hidden, not destroyed — every tab keeps its scroll position and session,
     *  but goes silent so a reel does not play on into a closed panel. */
    hide() {
        this.stopTracking();
        if (!this.visible) return;
        this.visible = false;
        this.tabs.forEach((t) => {
            t.view.classList.add('hidden');
            try { if (t.ready) t.view.setAudioMuted(true); } catch (_) { /* gone */ }
        });
    }

    // ---------- prefs ----------
    //
    // The card is a `file://` document with an opaque origin, where
    // localStorage throws. So the session — which tabs were open, which one was
    // in front, mobile or desktop — is kept up here instead, and reopening the
    // card puts back what was on screen last time.

    tabPrefs() {
        return {
            tabs: this.tabs.map((t) => t.url).filter(isWebUrl),
            active: Math.max(0, this.tabs.findIndex((t) => t.id === this.activeId)),
        };
    }

    /** Which tabs are open changes on every in-page navigation, and Instagram
     *  fires those by the scroll. Coalesce, so a feed does not turn into a
     *  synchronous localStorage write per frame. */
    scheduleSave() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.savePrefs(this.tabPrefs()), 800);
    }

    readPrefs() {
        const base = { tabs: [HOME], active: 0, mobile: true };
        try {
            const raw = localStorage.getItem(PREFS_KEY);
            if (!raw) return base;
            const parsed = JSON.parse(raw);
            const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isWebUrl) : [];
            return {
                tabs: tabs.length ? tabs.slice(0, MAX_TABS) : [HOME],
                active: parsed.active | 0,
                mobile: parsed.mobile !== false,
            };
        } catch (_) {
            return base;
        }
    }

    savePrefs(patch) {
        this.prefs = Object.assign({}, this.prefs, patch);
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
        } catch (_) { /* quota or private mode — the card just forgets */ }
    }
}

module.exports = BrowserBridge;
module.exports.ALLOWED_OPS = ALLOWED_OPS;
module.exports.PARTITION = PARTITION;
