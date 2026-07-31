/**
 * GamesLibrary - discovers and watches the playable games available to the app.
 *
 * The point of this module is that the manager instance (999) can WRITE a game
 * and the user can play it without restarting: drop an HTML file into `games/`
 * and it appears in the rail; edit it and the running game reloads. Nothing
 * here is registered anywhere — the filesystem is the registry.
 *
 * Two shapes are accepted:
 *   games/asteroids.html          -> a single self-contained file
 *   games/asteroids/index.html    -> a folder, so a game can ship assets
 *
 * Vibe Blast is not in `games/`. It lives at the app root as a tracked file and
 * is prepended by the renderer as the built-in, so an empty library still has
 * something to play.
 *
 * Metadata comes out of the HTML itself rather than a manifest, because a
 * manifest is one more file for the manager to get wrong:
 *   <title>            -> the card's name
 *   <meta name="game-description"> -> the card's subtitle
 */
const fs = require('fs');
const path = require('path');

// Coalesce editor save storms (write + rename + chmod) into one rescan.
const DEBOUNCE_MS = 250;
// Only the head of the file is read for metadata — games can be large.
const META_HEAD_BYTES = 4096;

class GamesLibrary {
    /**
     * @param {string} appRoot  directory containing `games/`
     * @param {(games: object[]) => void} onChange  called after every rescan
     */
    constructor(appRoot, onChange) {
        this.dir = path.join(appRoot, 'games');
        this.onChange = onChange;
        this.watchers = [];
        this.debounceTimer = null;
        this.games = [];
    }

    start() {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
        } catch (_) { /* read-only install; scan will just come back empty */ }
        this.scan();
        this.watch();
        return this.games;
    }

    stop() {
        clearTimeout(this.debounceTimer);
        this.watchers.forEach((w) => {
            try { w.close(); } catch (_) { /* already gone */ }
        });
        this.watchers = [];
    }

    /**
     * Recursive fs.watch is macOS/Windows only. On Linux we add a watcher per
     * subdirectory, and because a rescan re-runs this, a newly created game
     * folder picks up its own watcher on the next pass.
     */
    watch() {
        this.stop();
        const add = (dir) => {
            try {
                this.watchers.push(fs.watch(dir, { recursive: process.platform !== 'linux' }, () => this.schedule()));
            } catch (_) { /* directory vanished between scan and watch */ }
        };
        add(this.dir);
        if (process.platform === 'linux') {
            for (const g of this.games) {
                if (g.dir) add(path.join(this.dir, g.dir));
            }
        }
    }

    schedule() {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.scan();
            if (process.platform === 'linux') this.watch();
            if (this.onChange) this.onChange(this.games);
        }, DEBOUNCE_MS);
    }

    scan() {
        const found = [];
        let entries = [];
        try {
            entries = fs.readdirSync(this.dir, { withFileTypes: true });
        } catch (_) {
            this.games = [];
            return this.games;
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;

            if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
                const abs = path.join(this.dir, entry.name);
                found.push(this.describe(abs, `games/${entry.name}`, entry.name.replace(/\.html$/i, '')));
            } else if (entry.isDirectory()) {
                const abs = path.join(this.dir, entry.name, 'index.html');
                if (fs.existsSync(abs)) {
                    const game = this.describe(abs, `games/${entry.name}/index.html`, entry.name);
                    game.dir = entry.name;
                    found.push(game);
                }
            }
        }

        found.sort((a, b) => a.title.localeCompare(b.title));
        this.games = found;
        return this.games;
    }

    /** Build one card's worth of metadata. `url` is renderer-relative. */
    describe(absPath, url, fallbackTitle) {
        let title = fallbackTitle;
        let description = '';
        let mtime = 0;

        try {
            mtime = Math.floor(fs.statSync(absPath).mtimeMs);
        } catch (_) { /* raced a delete; mtime 0 is fine */ }

        try {
            const fd = fs.openSync(absPath, 'r');
            const buf = Buffer.alloc(META_HEAD_BYTES);
            const read = fs.readSync(fd, buf, 0, META_HEAD_BYTES, 0);
            fs.closeSync(fd);
            const head = buf.toString('utf8', 0, read);

            const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            if (t && t[1].trim()) title = t[1].trim().slice(0, 60);

            const d = head.match(/<meta\s+name=["']game-description["']\s+content=["']([^"']*)["']/i);
            if (d && d[1].trim()) description = d[1].trim().slice(0, 120);
        } catch (_) { /* unreadable — still list it, the iframe will show the error */ }

        return {
            id: url,
            url,
            title: this.prettify(title),
            description,
            mtime,
            builtIn: false,
        };
    }

    /** `space-shooter` / `space_shooter` -> `Space Shooter`, for filename fallbacks. */
    prettify(name) {
        if (/[A-Z ]/.test(name)) return name;
        return name
            .replace(/[-_]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, (c) => c.toUpperCase());
    }
}

module.exports = GamesLibrary;
