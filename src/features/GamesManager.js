/**
 * GamesManager - the game library rail under the Vibe Blast stage.
 *
 * Vibe Blast stopped being "the easter egg" and became "the first game". This
 * manager owns everything below the stage: a horizontally scrolling rail of
 * cards, one per playable game, and the logic that swaps the stage iframe
 * between them.
 *
 * Three things make it a library rather than a menu:
 *
 *  1. DISCOVERY is the filesystem. `src/main/games-library.js` scans `games/`
 *     and pushes the list over IPC. Nothing is registered in code and the
 *     watcher has no idea who wrote a file — so ANY Claude session running in
 *     any terminal, the manager instance, or the user with a text editor all
 *     add a game the same way: write one HTML file into `games/`.
 *
 *  2. HOT RELOAD. The same watcher fires on edits. A changed file that is not
 *     currently on the stage just re-renders its card; a changed file that IS
 *     on the stage gets its iframe reloaded against the new mtime. So a session
 *     can iterate on a game while the user watches, with no app restart.
 *
 *  3. KEYBOARD. Games need WASD and the arrow keys, which the app itself binds
 *     for its own hotkeys. Because the game runs in an iframe its keydowns land
 *     in a different document and never reach the app's handlers — so the whole
 *     problem reduces to making sure the iframe actually holds focus. This
 *     manager focuses it on open, on selection, and on any click on the stage,
 *     and shows a "click to play" hint whenever focus has drifted away.
 */

// Shares the naming convention of the right sidebar's collapsible panels.
const COLLAPSE_KEY = 'panelCollapsed:games';

const BUILT_IN = {
    id: 'vibe-blast.html',
    url: 'vibe-blast.html',
    title: 'Vibe Blast',
    description: 'Fit every piece. The original.',
    mtime: 0,
    builtIn: true,
};

class GamesManager {
    constructor(eventBus, appStateStore, ipcHandler, vibeBlastManager) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        this.ipc = ipcHandler;
        this.vibe = vibeBlastManager;

        this.games = [BUILT_IN];
        this.activeId = BUILT_IN.id;
        this.focusPollTimer = null;
    }

    initialize() {
        this.rail = document.getElementById('games-rail');
        this.stage = document.getElementById('vibe-stage');
        this.hint = document.getElementById('games-focus-hint');
        this.shelf = document.getElementById('games-shelf');
        this.flap = document.getElementById('games-flap');
        if (!this.rail || !this.stage) return;

        this.restoreCollapsed();

        this.setupDOMHandlers();
        this.refresh();

        // The watcher is the source of truth for everything after the first load.
        if (this.ipc && this.ipc.on) {
            this.ipc.on('games:changed', (_e, games) => this.onLibraryChanged(games));
        }

        // Opening the panel should land the player in the game, not in the app.
        if (this.eventBus) {
            this.eventBus.on('games:panel-opened', () => {
                this.focusGame();
                this.startFocusWatch();
            });
            this.eventBus.on('games:panel-closed', () => this.stopFocusWatch());
        }
    }

    // ---------- the collapse flap ----------
    //
    // Same convention the right sidebar's Status/Timer panels already use — a
    // `collapsed` class plus a `panelCollapsed:<name>` localStorage key — but
    // handled here rather than by renderer.js's generic
    // `.collapse-toggle[data-collapse-target]` sweep, so the flap can be a
    // full-width grip bar instead of a rotating chevron button.

    restoreCollapsed() {
        if (localStorage.getItem(COLLAPSE_KEY) === '1') this.setCollapsed(true);
    }

    setCollapsed(collapsed) {
        if (!this.shelf) return;
        this.shelf.classList.toggle('collapsed', collapsed);
        if (this.flap) {
            this.flap.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            this.flap.title = collapsed ? 'Show the games shelf' : 'Collapse the games shelf';
        }
        try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (_) { /* private mode */ }
    }

    toggleCollapsed() {
        this.setCollapsed(!this.shelf.classList.contains('collapsed'));
        // Collapsing hands the stage more room; give the game focus back so the
        // player isn't left typing at a button.
        this.focusGame();
    }

    setupDOMHandlers() {
        if (this.flap) {
            this.flap.addEventListener('click', () => this.toggleCollapsed());
        }

        // Any click on the stage means "I want to play" — take focus back from
        // whatever app control had it.
        this.stage.addEventListener('mousedown', () => {
            // Deferred: the browser moves focus after mousedown, and focusing
            // before that would be immediately undone.
            setTimeout(() => this.focusGame(), 0);
        });

        const refreshBtn = document.getElementById('games-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.classList.add('spinning');
                try {
                    const games = await this.ipc.invoke('games:refresh');
                    const before = this.games.length;
                    this.applyList(games || []);
                    const delta = this.games.length - before;
                    this.eventBus?.emit('log:action', {
                        message: delta === 0
                            ? `Games rescanned — ${this.games.length} found`
                            : `Games rescanned — ${this.games.length} found (${delta > 0 ? '+' : ''}${delta})`,
                        type: 'info',
                    });
                } catch (_) {
                    this.eventBus?.emit('log:action', { message: 'Games rescan failed', type: 'warning' });
                } finally {
                    // Let one full turn play out even on an instant reply, or the
                    // button flickers and reads as if nothing happened.
                    setTimeout(() => refreshBtn.classList.remove('spinning'), 500);
                }
            });
        }

        const openFolderBtn = document.getElementById('games-folder-btn');
        if (openFolderBtn) {
            openFolderBtn.addEventListener('click', () => {
                this.ipc.invoke('games:open-folder').catch(() => { /* non-critical */ });
            });
        }

        // Horizontal rails are awkward with a normal wheel; map vertical scroll
        // onto the rail so a trackpad or mouse wheel moves it.
        this.rail.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
            e.preventDefault();
            this.rail.scrollLeft += e.deltaY;
        }, { passive: false });
    }

    async refresh() {
        let discovered = [];
        try {
            discovered = (await this.ipc.invoke('games:list')) || [];
        } catch (_) { /* library unavailable; the built-in still plays */ }
        this.applyList(discovered);
    }

    onLibraryChanged(games) {
        const previous = this.games.find((g) => g.id === this.activeId);
        this.applyList(games || []);

        const current = this.games.find((g) => g.id === this.activeId);
        if (!current) {
            // The game being played was deleted — fall back to the built-in.
            this.eventBus?.emit('log:action', {
                message: `Game removed: ${previous ? previous.title : this.activeId}`,
                type: 'info',
            });
            this.select(BUILT_IN.id);
            return;
        }
        // Same game, new bytes: reload the stage so the edit is playable now.
        if (previous && current.mtime !== previous.mtime) {
            this.eventBus?.emit('log:action', {
                message: `Game reloaded: ${current.title}`,
                type: 'info',
            });
            this.load(current, { force: true });
        }
    }

    applyList(discovered) {
        // Vibe Blast is always first and always present — it is the main game
        // and it is the only one that ships with the app.
        this.games = [BUILT_IN, ...discovered.filter((g) => g && g.url && g.url !== BUILT_IN.url)];
        this.render();
    }

    render() {
        this.rail.replaceChildren();

        for (const game of this.games) {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'game-card' + (game.id === this.activeId ? ' active' : '');
            card.dataset.gameId = game.id;
            card.title = game.description || game.title;

            const art = this.buildArt(game);

            const name = document.createElement('span');
            name.className = 'game-card-name';
            name.textContent = game.title;

            const sub = document.createElement('span');
            sub.className = 'game-card-sub';
            sub.textContent = game.builtIn ? 'Built in' : (game.description || 'Game');

            card.append(art, name, sub);
            card.addEventListener('click', () => this.select(game.id));
            this.rail.appendChild(card);
        }

        if (this.games.length === 1) {
            const empty = document.createElement('div');
            empty.className = 'games-rail-empty';
            empty.textContent = 'Drop an .html file in games/';
            this.rail.appendChild(empty);
        }
    }

    /**
     * The card's cover box. The thumbnail IS the game — a live render of the
     * same HTML, scaled down inside a fixed landscape box, so there is no cover
     * -art convention for game authors to follow and an edited game's thumbnail
     * updates itself (the mtime in the URL changes with the file).
     *
     * Underneath the render sits a coloured initial. It is not a second code
     * path — it is simply what remains visible when the render doesn't produce
     * anything (a game that paints nothing until you press start, a file that
     * failed to parse), so the box is never empty and never changes size.
     */
    buildArt(game) {
        const art = document.createElement('span');
        art.className = 'game-card-art';
        art.style.setProperty('--game-hue', String(this.hueFor(game.title)));

        const fallback = document.createElement('span');
        fallback.className = 'game-card-fallback';
        fallback.textContent = game.title.slice(0, 1).toUpperCase();
        art.appendChild(fallback);

        const shot = document.createElement('iframe');
        shot.className = 'game-card-shot';
        shot.setAttribute('tabindex', '-1');
        shot.setAttribute('aria-hidden', 'true');
        shot.setAttribute('scrolling', 'no');
        shot.setAttribute('loading', 'lazy');
        shot.src = game.mtime ? `${game.url}?thumb=${game.mtime}` : game.url;
        // Only reveal the render once it has actually painted; until then the
        // coloured initial is what the user sees, so no card ever flashes white.
        shot.addEventListener('load', () => {
            art.classList.add('has-shot');
            // Thumbnails are separate documents from the stage, so they never
            // saw the host's theme push and would sit in light mode inside a
            // dark app. Same message the stage frame gets.
            try {
                shot.contentWindow.postMessage({
                    source: 'vibe-blast-host',
                    op: 'theme',
                    theme: document.documentElement.getAttribute('data-theme') || 'system',
                }, '*');
            } catch (_) { /* frame went away; the card just keeps its own colours */ }
        });
        art.appendChild(shot);

        return art;
    }

    /** Stable 0-359 hue from the title, so a game keeps its colour across restarts. */
    hueFor(text) {
        let h = 0;
        for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
        return h;
    }

    select(id) {
        const game = this.games.find((g) => g.id === id);
        if (!game) return;
        const changed = this.activeId !== id;
        this.activeId = id;
        this.render();
        this.load(game, { force: changed });
        if (changed) {
            this.eventBus?.emit('log:action', { message: `Playing ${game.title}`, type: 'info' });
        }
    }

    /**
     * Point the stage iframe at a game. The mtime rides along as a query string
     * so an edited file actually re-fetches instead of coming back from cache.
     */
    load(game, { force = false } = {}) {
        if (!this.vibe) return;
        const src = game.mtime ? `${game.url}?v=${game.mtime}` : game.url;
        this.vibe.loadGame(src, { force });
        // Focus after the swap so keys reach the new game immediately.
        setTimeout(() => this.focusGame(), 80);
    }

    /** Hand keyboard control to the game. */
    focusGame() {
        const frame = this.vibe && this.vibe.frame;
        if (!frame) return;
        try {
            frame.focus();
            if (frame.contentWindow) frame.contentWindow.focus();
        } catch (_) { /* cross-document focus refused; the click hint covers it */ }
        this.updateFocusHint();
    }

    /** Show the "click to play" nudge only while the game does NOT have focus. */
    updateFocusHint() {
        if (!this.hint) return;
        const frame = this.vibe && this.vibe.frame;
        const focused = !!frame && document.activeElement === frame;
        this.hint.style.display = focused ? 'none' : '';
    }

    startFocusWatch() {
        clearInterval(this.focusPollTimer);
        // focus/blur don't fire reliably across the iframe boundary, so poll —
        // cheap, and only while the panel is actually open.
        this.focusPollTimer = setInterval(() => this.updateFocusHint(), 400);
    }

    stopFocusWatch() {
        clearInterval(this.focusPollTimer);
        this.focusPollTimer = null;
    }
}

module.exports = GamesManager;
