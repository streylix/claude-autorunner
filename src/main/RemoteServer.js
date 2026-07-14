/**
 * RemoteServer - Web-served remote mode (the VS Code Remote-SSH analog).
 *
 * A second loopback-only server beside HookServer that (a) serves the app's
 * own UI (index.html transformed to load remote-bootstrap.js + the esbuild
 * renderer bundle) and (b) upgrades to a WebSocket that bridges the Electron
 * IPC surface, so a browser on another machine — reached via SSH tunnel or
 * Tailscale — runs the SAME renderer, 1:1 interactive.
 *
 * Protocol (JSON frames, see docs/REMOTE_MODE.md §3.3):
 *   client → server:  {t:'hello', token}
 *                     {t:'send', channel, args[]}        → ipcMain.on handlers
 *                     {t:'invoke', id, channel, args[]}  → ipcMain.handle handlers
 *   server → client:  {t:'welcome', snapshot}
 *                     {t:'push', channel, args[]}        → ipcRenderer.on
 *                     {t:'invoke-result', id, ok, result|error}
 *                     {t:'error', code?, error}
 *
 * Security posture (same as HookServer / ssh-view):
 *   - binds 127.0.0.1 ONLY (never 0.0.0.0); transport is the user's SSH
 *     tunnel or Tailscale.
 *   - reuses the HookServer per-session token; the WS `hello` is validated
 *     with a constant-time compare and a bad token closes the socket.
 *   - static assets are served unauthenticated on loopback (they contain no
 *     secrets; all real state/PTY data flows over the token-gated WS).
 *
 * Correctness guards (the "one source of truth" rules):
 *   - `ccbot-state-snapshot` / `control-response` frames from browsers are
 *     DROPPED: the local Electron renderer stays the single owner of the
 *     /state snapshot and of control round-trips.
 *   - `terminal-start` for an id whose PTY already exists does NOT respawn:
 *     the client is attached instead — it gets a `terminal-ready` push plus a
 *     one-shot screen replay (late-join catch-up) read from the local
 *     renderer's xterm buffer via the existing terminal-screen control path.
 *   - `remote-queue-add` is re-broadcast as a `queue-add-request` push so the
 *     authoritative LOCAL queue (and every attached view) picks it up.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_FRAME_BYTES = 512 * 1024;
const DEFAULT_PORT = 8130;

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.wasm': 'application/wasm',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip'
};

class RemoteServer {
    /**
     * @param {Object} opts
     * @param {string} opts.appRoot   - app directory (serves index.html, bundle, assets)
     * @param {string} opts.token     - the HookServer session token (shared)
     * @param {Object} opts.deps      - bridges into main:
     *   getState()                       → enriched /state snapshot
     *   getScreen(terminalId)            → Promise<terminal-screen result> (replay)
     *   hasPty(terminalId)               → boolean
     *   dispatchSend(channel, args, ev)  → run the ipcMain.on handler
     *   dispatchInvoke(channel, args, ev)→ Promise (runs the ipcMain.handle handler)
     *   broadcastAll(channel, ...args)   → push to local window + every WS client
     *   onClientsChanged(count)          → (optional) attach/detach notification
     *                                      (drives the TTS audio-sink routing)
     *   log(...)                         → safe logger
     */
    constructor({ appRoot, token, deps }) {
        this.appRoot = appRoot;
        this.token = token;
        this.deps = deps;
        this.server = null;
        this.wss = null;
        this.port = null;
        this.clients = new Set(); // authed ws clients
        // Client-mic forwarding (REMOTE_MODE.md §10): at most ONE client may
        // stream its microphone at a time (interleaving two streams into the
        // single wake-word recognizer would be garbage). First-come ownership;
        // later starters are pushed a 'remote-mic-denied'.
        this.micOwner = null;
    }

    _tokenValid(provided) {
        if (typeof provided !== 'string') return false;
        const a = Buffer.from(provided);
        const b = Buffer.from(this.token);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    }

    /**
     * Start on 127.0.0.1. Tries preferredPort (default 8130) for a stable
     * tunnel target, falls back to an OS-assigned port if it is taken.
     * @returns {Promise<number>} the bound port
     */
    start(preferredPort) {
        const tryListen = (port) => new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this.handleHttp(req, res));
            server.once('error', reject);
            // SECURITY: loopback only, by construction. Transport = SSH/Tailscale.
            server.listen(port, '127.0.0.1', () => resolve(server));
        });
        const wanted = Number(preferredPort) > 0 ? Number(preferredPort) : DEFAULT_PORT;
        return tryListen(wanted)
            .catch((err) => {
                if (err && err.code === 'EADDRINUSE') return tryListen(0);
                throw err;
            })
            .then((server) => {
                this.server = server;
                this.port = server.address().port;
                const { WebSocketServer } = require('ws');
                this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_FRAME_BYTES });
                this.wss.on('connection', (ws) => this.handleSocket(ws));
                return this.port;
            });
    }

    // ======= static assets =======
    handleHttp(req, res) {
        // Backend reverse proxy: the browser renderer's `${BACKEND_URL}/api/...`
        // fetches (Whisper transcription, TTS notifications/audio, frontend
        // logs) resolve to '' in Remote Mode (see src/utils/backend-url.js), so
        // they arrive here same-origin. Forward them — any method, streamed —
        // to the desktop's loopback backend, which the viewer's machine cannot
        // reach directly (and CORS would block anyway). Same trust boundary as
        // the static assets: loopback bind + the user's SSH tunnel.
        if (req.url === '/api' || (req.url && req.url.startsWith('/api/'))) {
            return this.proxyBackend(req, res);
        }
        if (req.method !== 'GET') {
            res.writeHead(405);
            res.end();
            return;
        }
        let urlPath;
        try {
            urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        } catch (_) {
            res.writeHead(400);
            res.end();
            return;
        }
        if (urlPath === '/' || urlPath === '/index.html') return this.serveIndex(res);
        if (urlPath === '/remote-bootstrap.js') {
            return this.serveFile(res, path.join(this.appRoot, 'src', 'remote', 'remote-bootstrap.js'));
        }
        if (urlPath === '/remote-mic.js') {
            return this.serveFile(res, path.join(this.appRoot, 'src', 'remote', 'remote-mic.js'));
        }
        if (urlPath === '/renderer.bundle.js') {
            return this.serveFile(res, path.join(this.appRoot, 'dist-remote', 'renderer.bundle.js'));
        }

        // Everything else: static files under the app root only (no traversal,
        // no dotfiles/.git). The renderer bundle is self-contained, but
        // index.html still references style.css, xterm css, lucide, assets/.
        const resolved = path.normalize(path.join(this.appRoot, urlPath));
        if (!resolved.startsWith(this.appRoot + path.sep)) {
            res.writeHead(403);
            res.end();
            return;
        }
        if (resolved.split(path.sep).some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
            res.writeHead(404);
            res.end();
            return;
        }
        this.serveFile(res, resolved);
    }

    /**
     * Serve index.html transformed for the browser: inject the bootstrap
     * before the first script, and swap `renderer.js` for the bundle. Reading
     * + transforming the REAL index.html at request time means the remote UI
     * can never drift from the local one.
     */
    serveIndex(res) {
        fs.readFile(path.join(this.appRoot, 'index.html'), 'utf8', (err, html) => {
            if (err) {
                res.writeHead(500);
                res.end('index.html unavailable');
                return;
            }
            let out = html.replace(
                '<script src="renderer.js"></script>',
                '<script src="renderer.bundle.js"></script>'
            );
            // Bootstrap must run before EVERY other script (xterm, loading
            // manager, the bundle) so window.require/process exist first.
            // remote-mic.js rides right behind it: the client-side microphone
            // forwarder (REMOTE_MODE.md §10) — browser clients only.
            out = out.replace('<script',
                '<script src="remote-bootstrap.js"></script>\n    '
                + '<script src="remote-mic.js"></script>\n    <script');
            res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'], 'Cache-Control': 'no-store' });
            res.end(out);
        });
    }

    /** Stream one /api/* request to the Django backend and the response back. */
    proxyBackend(req, res) {
        const { BACKEND_URL } = require('../utils/backend-url');
        let target;
        try {
            target = new URL(req.url, BACKEND_URL);
        } catch (_) {
            res.writeHead(400);
            res.end();
            return;
        }
        const headers = Object.assign({}, req.headers, { host: target.host });
        const upstream = http.request(target, { method: req.method, headers }, (up) => {
            res.writeHead(up.statusCode || 502, up.headers);
            up.pipe(res);
        });
        upstream.on('error', () => {
            try {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('backend unavailable');
            } catch (_) { /* headers already sent — drop */ }
        });
        req.pipe(upstream);
    }

    serveFile(res, filePath) {
        fs.stat(filePath, (err, stat) => {
            if (err || !stat.isFile()) {
                res.writeHead(404);
                res.end();
                return;
            }
            const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store' });
            fs.createReadStream(filePath).pipe(res);
        });
    }

    // ======= WebSocket bridge =======
    handleSocket(ws) {
        let authedClient = false;
        // Unauthenticated sockets get 5s to say hello, then are dropped.
        const authTimer = setTimeout(() => { if (!authedClient) ws.close(4401, 'auth timeout'); }, 5000);

        ws.on('message', async (data) => {
            let frame;
            try { frame = JSON.parse(data.toString()); } catch (_) { return; }

            if (!authedClient) {
                if (frame.t === 'hello' && this._tokenValid(frame.token)) {
                    authedClient = true;
                    clearTimeout(authTimer);
                    this.clients.add(ws);
                    let snapshot = null;
                    try { snapshot = this.deps.getState(); } catch (_) { /* not ready yet */ }
                    this.sendTo(ws, { t: 'welcome', snapshot });
                    this.deps.log('[Remote] browser client authenticated (' + this.clients.size + ' attached)');
                    this._notifyClientsChanged();
                } else {
                    this.sendTo(ws, { t: 'error', code: 'auth', error: 'invalid token' });
                    ws.close(4403, 'invalid token');
                }
                return;
            }

            try {
                if (frame.t === 'send') await this.handleSend(ws, frame);
                else if (frame.t === 'invoke') await this.handleInvoke(ws, frame);
            } catch (err) {
                this.sendTo(ws, { t: 'error', error: err && err.message });
            }
        });

        ws.on('close', () => {
            clearTimeout(authTimer);
            this._releaseMic(ws);
            if (this.clients.delete(ws)) {
                this.deps.log('[Remote] browser client detached (' + this.clients.size + ' attached)');
                this._notifyClientsChanged();
            }
        });
        ws.on('error', () => { /* close fires next */ });
    }

    async handleSend(ws, frame) {
        const channel = String(frame.channel || '');
        const args = Array.isArray(frame.args) ? frame.args : [];

        // The local renderer OWNS the state snapshot and control round-trips;
        // a browser echoing these would corrupt main's caches. Drop.
        if (channel === 'ccbot-state-snapshot' || channel === 'control-response') return;

        // Client-mic forwarding: enforce single ownership BEFORE dispatching to
        // main (which relays to the local renderer's voice pipeline).
        if (channel === 'remote-mic-state') {
            const p = args[0] || {};
            if (p.active) {
                if (this.micOwner && this.micOwner !== ws) {
                    this.sendTo(ws, {
                        t: 'push',
                        channel: 'remote-mic-denied',
                        args: [{ reason: 'another remote viewer is already streaming its microphone' }]
                    });
                    return;
                }
                if (this.micOwner === ws) return; // duplicate start — already own it
                this.micOwner = ws;
                this.deps.log('[Remote] client mic stream STARTED (1 owner)');
            } else {
                if (this.micOwner !== ws) return; // only the owner can stop it
                this.micOwner = null;
                this.deps.log('[Remote] client mic stream STOPPED');
            }
            this.deps.dispatchSend(channel, [{ active: !!p.active }], this.makeEvent());
            return;
        }
        if (channel === 'remote-mic-frame') {
            if (this.micOwner !== ws) return; // only the owning client's frames count
            this.deps.dispatchSend(channel, args, this.makeEvent());
            return;
        }

        // Remote-added queue messages route through the authoritative local
        // queue via the same push the HookServer /queue/add path uses.
        if (channel === 'remote-queue-add') {
            const p = args[0] || {};
            if (typeof p.content === 'string' && p.content.trim()) {
                this.deps.broadcastAll('queue-add-request', {
                    terminalId: p.terminalId,
                    content: p.content,
                    type: p.type === 'urgent' ? 'urgent' : 'normal'
                });
            }
            return;
        }

        // Attach-not-respawn: a browser renderer boots the same persisted
        // terminal set (and the manager, 999) and sends terminal-start for
        // each. If the PTY already lives, replay the current screen to THIS
        // client instead of forwarding a (guarded) respawn to main.
        if (channel === 'terminal-start') {
            const opts = args[0] || {};
            const terminalId = opts.terminalId || 1;
            if (this.deps.hasPty(terminalId)) {
                await this.replayScreen(ws, terminalId);
                this.sendTo(ws, { t: 'push', channel: 'terminal-ready', args: [{ terminalId }] });
                return;
            }
            // New terminal created from the browser: spawn it in main. The
            // terminal-start handler itself broadcasts remote-terminal-created
            // so every other attached renderer builds a matching view.
            this.deps.dispatchSend(channel, args, this.makeEvent());
            return;
        }

        this.deps.dispatchSend(channel, args, this.makeEvent());
    }

    async handleInvoke(ws, frame) {
        const channel = String(frame.channel || '');
        const args = Array.isArray(frame.args) ? frame.args : [];
        try {
            const result = await this.deps.dispatchInvoke(channel, args, this.makeEvent());
            this.sendTo(ws, { t: 'invoke-result', id: frame.id, ok: true, result });
        } catch (err) {
            this.sendTo(ws, { t: 'invoke-result', id: frame.id, ok: false, error: (err && err.message) || 'invoke failed' });
        }
    }

    /** Fake IPC event for handlers that use event.reply (terminal-start etc.). */
    makeEvent() {
        return {
            reply: (channel, payload) => this.deps.broadcastAll(channel, payload),
            sender: null
        };
    }

    /**
     * Late-join catch-up: dump the terminal's current screen (from the local
     * renderer's xterm buffer, full scrollback) and push it to one client as
     * ordinary terminal-data, so its xterm starts populated instead of blank.
     * Plain text (colors/attrs of the backlog are lost — v1 tradeoff).
     */
    async replayScreen(ws, terminalId) {
        try {
            const result = await this.deps.getScreen(terminalId);
            if (result && result.ok && result.screen) {
                const content = result.screen.replace(/\n/g, '\r\n') + '\r\n';
                this.sendTo(ws, { t: 'push', channel: 'terminal-data', args: [{ terminalId, content }] });
            }
        } catch (_) { /* no replay is better than no attach */ }
    }

    /**
     * A socket that owned the mic stream went away without a clean stop
     * (network drop, tab closed): release ownership and tell the local voice
     * pipeline the source detached, so it never waits on a dead stream.
     */
    _releaseMic(ws) {
        if (this.micOwner !== ws) return;
        this.micOwner = null;
        this.deps.log('[Remote] client mic stream owner disconnected — mic source released');
        try {
            this.deps.dispatchSend('remote-mic-state', [{ active: false, reason: 'client disconnected' }], this.makeEvent());
        } catch (_) { /* handler not registered yet — nothing to release */ }
    }

    /** Attach/detach hook (audio-sink routing etc.). Count changes only. */
    _notifyClientsChanged() {
        if (typeof this.deps.onClientsChanged === 'function') {
            try { this.deps.onClientsChanged(this.clients.size); } catch (_) { /* never break the socket path */ }
        }
    }

    sendTo(ws, frame) {
        try {
            if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(frame));
        } catch (_) { /* client went away */ }
    }

    /** Push a main→renderer channel to every attached browser. */
    broadcast(channel, args) {
        if (this.clients.size === 0) return;
        const s = JSON.stringify({ t: 'push', channel, args });
        for (const ws of this.clients) {
            try { if (ws.readyState === 1) ws.send(s); } catch (_) { /* skip */ }
        }
    }

    close() {
        for (const ws of this.clients) {
            try { ws.close(1001, 'server shutting down'); } catch (_) { /* ignore */ }
        }
        this.clients.clear();
        this.micOwner = null;
        this._notifyClientsChanged();
        if (this.wss) { try { this.wss.close(); } catch (_) { /* ignore */ } this.wss = null; }
        if (this.server) { try { this.server.close(); } catch (_) { /* ignore */ } this.server = null; }
        this.port = null;
    }
}

module.exports = RemoteServer;
