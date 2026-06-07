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

class HookServer {
    /**
     * @param {Function|Object} handlers - Either the onEvent callback alone, or
     *   { onEvent, onQueueAdd, getState }:
     *   - onEvent({terminalId, event, hook, receivedAt}) - hook state events
     *   - onQueueAdd({terminalId, content}) - external queue-add requests
     *     (e.g. a manager Claude instance steering other terminals)
     *   - getState() - snapshot of interface state for GET /state
     */
    constructor(handlers) {
        if (typeof handlers === 'function') {
            handlers = { onEvent: handlers };
        }
        this.onEvent = handlers.onEvent;
        this.onQueueAdd = handlers.onQueueAdd || null;
        this.getState = handlers.getState || null;
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

    handleRequest(req, res) {
        if (req.headers['x-ccbot-token'] !== this.token) {
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
                    this.onQueueAdd({ terminalId, content });
                    res.writeHead(202, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ accepted: true, terminalId }));
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

module.exports = HookServer;
