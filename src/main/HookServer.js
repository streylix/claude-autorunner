/**
 * HookServer - Localhost HTTP listener for Claude Code hook events
 *
 * Claude Code instances running inside app-spawned terminals fire hooks
 * (Stop / Notification / UserPromptSubmit) that POST state transitions here.
 * This replaces the legacy terminal-output parsing detection system with
 * ground-truth push notifications from Claude Code itself.
 *
 * Security: binds 127.0.0.1 only, requires a per-app-session token that is
 * injected into each PTY's environment (CCBOT_TOKEN), so stray local
 * processes and other app instances cannot spoof terminal state.
 */
const http = require('http');
const crypto = require('crypto');

const VALID_EVENTS = new Set(['stop', 'notification', 'prompt-submit', 'cwd-changed']);
const MAX_BODY_BYTES = 256 * 1024;
// The manager instance's hidden terminal. The control API must never queue a
// message to it: the manager drives OTHER terminals and queues its own passes
// via the internal path (ManagerInstance -> messageQueueManager.addMessage),
// never over HTTP. Mirrors ManagerInstance.MANAGER_TERMINAL_ID.
const MANAGER_TERMINAL_ID = 999;

// Mirror of MessageQueueManager.VALID_TYPES. MessageQueueManager.normalizeType
// remains the canonical validator (it runs again in the renderer), but the
// HookServer normalizes here too so POST /queue/add {type} is forwarded as a
// known-good value rather than silently dropped.
const VALID_QUEUE_TYPES = new Set(['normal', 'urgent']);

class HookServer {
    /**
     * @param {Function|Object} handlers - Either the onEvent callback alone, or
     *   { onEvent, onQueueAdd, getState }:
     *   - onEvent({terminalId, event, hook, receivedAt}) - hook state events
     *   - onQueueAdd({terminalId, content, type}) - external queue-add requests
     *     (e.g. a manager Claude instance steering other terminals). `type` is
     *     normalized to a valid priority ('normal' | 'urgent'); urgent bypasses
     *     the injection gate.
     *   - getState() - snapshot of interface state for GET /state
     */
    constructor(handlers) {
        if (typeof handlers === 'function') {
            handlers = { onEvent: handlers };
        }
        this.onEvent = handlers.onEvent;
        this.onQueueAdd = handlers.onQueueAdd || null;
        this.getState = handlers.getState || null;
        // onControl(action, payload) -> Promise<result> - round-trip to the
        // renderer for operations that need a response (create/update/delete)
        this.onControl = handlers.onControl || null;
        this.server = null;
        this.port = null;
        this.token = crypto.randomBytes(16).toString('hex');
    }

    /**
     * Start listening on an OS-assigned port on loopback only.
     * @returns {Promise<number>} The assigned port
     */
    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this.handleRequest(req, res));
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                this.port = this.server.address().port;
                resolve(this.port);
            });
        });
    }

    // Constant-time token check. A plain `!==` string compare leaks how much of
    // the token matched via timing; use timingSafeEqual over equal-length
    // buffers (length is checked first, which is safe — token length is fixed).
    _tokenValid(provided) {
        if (typeof provided !== 'string') return false;
        const a = Buffer.from(provided);
        const b = Buffer.from(this.token);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    }

    handleRequest(req, res) {
        if (!this._tokenValid(req.headers['x-ccbot-token'])) {
            req.resume(); // drain body so the connection closes cleanly, not via RST
            res.writeHead(403);
            res.end();
            return;
        }

        // GET /state - interface snapshot for external controllers
        if (req.method === 'GET' && req.url === '/state') {
            req.resume();
            const state = this.getState ? this.getState() : null;
            res.writeHead(state ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(state || { error: 'state unavailable' }));
            return;
        }

        // GET /queue - full pending queue (id, terminalId, content, type) so a
        // controller can inspect and (via POST /queue/update) reorder/edit it.
        // Served from the same cached snapshot as /state.
        if (req.method === 'GET' && req.url === '/queue') {
            req.resume();
            const state = this.getState ? this.getState() : null;
            res.writeHead(state ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(state ? { queue: state.queue || [] } : { error: 'state unavailable' }));
            return;
        }

        // Terminal management: routed to onControl and answered with its result.
        // Most round-trip to the renderer; the PTY-level ones (keys, claude
        // lifecycle) are handled directly in main. Actions: create {directory?,
        // title?, color?}, update {terminalId, title?, color?}, delete
        // {terminalId}, screen {terminalId, scrollback?}, keys {terminalId,
        // keys[]}, claude {terminalId, action: start|resume|restart, ...}.
        const CONTROL_ROUTES = HookServer.CONTROL_ROUTES;
        if (req.method === 'POST' && CONTROL_ROUTES[req.url]) {
            const action = CONTROL_ROUTES[req.url];
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
                if (body.length > MAX_BODY_BYTES) req.destroy();
            });
            req.on('end', async () => {
                if (!this.onControl) {
                    res.writeHead(503);
                    res.end();
                    return;
                }
                try {
                    const payload = body ? JSON.parse(body) : {};
                    const result = await this.onControl(action, payload);
                    res.writeHead(result && result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result || { ok: false, error: 'no result' }));
                } catch (error) {
                    res.writeHead(error.message === 'control timeout' ? 504 : 400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: error.message }));
                }
            });
            return;
        }

        const isHookEvent = req.method === 'POST' && req.url === '/hook-event';
        const isQueueAdd = req.method === 'POST' && req.url === '/queue/add';
        if (!isHookEvent && !isQueueAdd) {
            req.resume();
            res.writeHead(404);
            res.end();
            return;
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_BODY_BYTES) {
                req.destroy();
            }
        });

        req.on('end', () => {
            try {
                const payload = JSON.parse(body);
                const terminalId = parseInt(payload.terminalId, 10);

                if (isQueueAdd) {
                    const content = typeof payload.content === 'string' ? payload.content.trim() : '';
                    if (!Number.isInteger(terminalId) || !content || !this.onQueueAdd) {
                        res.writeHead(this.onQueueAdd ? 400 : 503);
                        res.end();
                        return;
                    }
                    // Enforce the "never target yourself (999)" invariant at the HTTP
                    // boundary, regardless of the renderer-side manager-input toggle.
                    if (terminalId === MANAGER_TERMINAL_ID) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'cannot queue to the manager terminal (999)' }));
                        return;
                    }
                    const type = HookServer.normalizeQueueType(payload.type);
                    this.onQueueAdd({ terminalId, content, type });
                    res.writeHead(202, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ accepted: true, terminalId, type }));
                    return;
                }

                if (!Number.isInteger(terminalId) || !VALID_EVENTS.has(payload.event)) {
                    res.writeHead(400);
                    res.end();
                    return;
                }

                this.onEvent({
                    terminalId,
                    event: payload.event,
                    // Raw hook input JSON from Claude Code (session_id, cwd,
                    // notification message, etc.) - forwarded for consumers
                    // that want richer context (e.g. "why prompted").
                    hook: payload.hook || null,
                    receivedAt: Date.now()
                });

                res.writeHead(204);
                res.end();
            } catch (error) {
                res.writeHead(400);
                res.end();
            }
        });
    }

    close() {
        if (this.server) {
            this.server.close();
            this.server = null;
            this.port = null;
        }
    }
}

// POST control routes -> renderer/main action names. Hoisted to a static so it
// can be inspected/tested and extended in one place.
//   /queue/inject-now {messageId} - force-inject a queued message NOW, bypassing
//   the pause/timer/usage-limit gate (the manual override path).
HookServer.CONTROL_ROUTES = {
    '/terminal/create': 'terminal-create',
    '/terminal/update': 'terminal-update',
    '/terminal/delete': 'terminal-delete',
    '/terminal/screen': 'terminal-screen',
    '/terminal/keys': 'terminal-keys',
    '/terminal/claude': 'terminal-claude',
    '/terminal/transcript': 'terminal-transcript',
    '/queue/update': 'queue-update',
    '/queue/inject-now': 'queue-inject-now'
};

// Coerce any incoming queue priority to a valid value (default 'normal').
HookServer.normalizeQueueType = function normalizeQueueType(type) {
    return VALID_QUEUE_TYPES.has(type) ? type : 'normal';
};

module.exports = HookServer;
