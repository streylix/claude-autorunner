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
     * @param {Function} onEvent - Callback invoked with validated hook payloads:
     *                             { terminalId, event, hook, receivedAt }
     */
    constructor(onEvent) {
        this.onEvent = onEvent;
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
        if (req.method !== 'POST' || req.url !== '/hook-event') {
            req.resume(); // drain body so the connection closes cleanly, not via RST
            res.writeHead(404);
            res.end();
            return;
        }

        if (req.headers['x-ccbot-token'] !== this.token) {
            req.resume();
            res.writeHead(403);
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
