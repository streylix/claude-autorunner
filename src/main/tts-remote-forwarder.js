'use strict';

/**
 * TtsRemoteForwarder - make voice notifications play on the device SHOWING the
 * interface (docs/REMOTE_MODE.md §9).
 *
 * Today's TTS path is entirely host-local: the manager POSTs /api/tts/speak/ to
 * the Django backend (loopback), and the LOCAL renderer's NotificationManager
 * polls /api/tts/notifications/ and plays the WAV — sound comes out of the app
 * host, which in Remote Mode is usually a headless box nobody is sitting at.
 *
 * This forwarder runs in the MAIN process (where the backend's loopback IS
 * reachable). While ≥1 Remote Mode client is attached it polls the same
 * notifications endpoint, fetches each fresh notification's audio bytes, and
 * pushes them to every attached client over the existing authenticated
 * WebSocket as a 'remote-tts-notification' frame:
 *
 *   { t:'push', channel:'remote-tts-notification',
 *     args:[{ notification:{...}, audioBase64:'...', mime:'audio/wav' }] }
 *
 * The remote renderer (NotificationManager.initializeRemote) turns the bytes
 * into a Blob URL and plays them there. No new ports, no new auth surface: the
 * audio rides the token-gated WS that already carries the whole interface.
 *
 * Which device plays (the double-play rule):
 *   - ≥1 remote client attached → the client(s) play; the local renderer is
 *     told (via 'remote-clients-changed') to suppress AUTO playback.
 *   - 0 remote clients → local playback exactly as before.
 *   - Only notifications created while a client is attached are forwarded: the
 *     watermark (lastSeenId) is (re)baselined on every 0→N attach, so history
 *     never replays into a client that just connected.
 */

const http = require('http');
const https = require('https');

const POLL_INTERVAL_MS = 2000;
// Kokoro WAVs are ~50 KB/s of speech; a whole minute is ~3 MB. Anything past
// this cap is almost certainly not a notification — skip it rather than shove
// it through the WS.
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

class TtsRemoteForwarder {
    /**
     * @param {Object} opts
     * @param {string}   opts.backendUrl - Django backend origin (http://localhost:8123)
     * @param {Function} opts.broadcast  - (channel, args[]) → push to every attached WS client
     * @param {Function} opts.log        - safe logger
     */
    constructor({ backendUrl, broadcast, log }) {
        this.backendUrl = String(backendUrl || '').replace(/\/$/, '');
        this.broadcast = broadcast;
        this.log = log || (() => {});
        this.active = false;
        this.timer = null;
        this.lastSeenId = null; // null = needs a baseline before forwarding
        this._ticking = false;
    }

    /** Attach/detach notifications from the RemoteServer drive activation. */
    setClientCount(count) {
        const wantActive = Number(count) > 0;
        if (wantActive && !this.active) {
            this.active = true;
            this.lastSeenId = null; // re-baseline: never replay history to a fresh client
            this.timer = setInterval(() => this._tick(), POLL_INTERVAL_MS);
            if (this.timer.unref) this.timer.unref();
            this.log('[Remote] TTS forwarder ON — voice notifications now play on the remote viewer(s)');
            this._tick(); // baseline immediately
        } else if (!wantActive && this.active) {
            this.stop();
            this.log('[Remote] TTS forwarder OFF — voice notifications play locally again');
        }
    }

    stop() {
        this.active = false;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this.lastSeenId = null;
    }

    async _tick() {
        if (!this.active || this._ticking) return;
        this._ticking = true;
        try {
            if (this.lastSeenId === null) {
                // Baseline pass: find the current high-water mark, forward nothing.
                const data = await this._getJson('/api/tts/notifications/?limit=1');
                const items = (data && data.notifications) || [];
                this.lastSeenId = items.reduce((m, n) => Math.max(m, n.id), 0);
                return;
            }
            const data = await this._getJson(
                `/api/tts/notifications/?after=${this.lastSeenId}&limit=20`
            );
            const fresh = ((data && data.notifications) || [])
                .filter((n) => n.id > this.lastSeenId)
                .sort((a, b) => a.id - b.id); // chronological, like the local player
            for (const n of fresh) {
                await this._forward(n);
                this.lastSeenId = Math.max(this.lastSeenId, n.id);
            }
        } catch (_) {
            // Backend down / transient — try again next tick. Never advance the
            // watermark on failure, so nothing is silently dropped.
        } finally {
            this._ticking = false;
        }
    }

    async _forward(n) {
        if (!this.active) return;
        let audioBase64 = null;
        let mime = 'audio/wav';
        if (n.audio_url) {
            try {
                const { bytes, contentType } = await this._getBytes(n.audio_url);
                if (bytes.length > MAX_AUDIO_BYTES) {
                    this.log(`[Remote] TTS forwarder: notification ${n.id} audio too large (${bytes.length} bytes) — skipped`);
                } else {
                    audioBase64 = bytes.toString('base64');
                    if (contentType) mime = contentType.split(';')[0].trim();
                    this.log(`[Remote] TTS forwarder: pushing notification ${n.id} (${bytes.length} audio bytes) to remote client(s)`);
                }
            } catch (err) {
                this.log(`[Remote] TTS forwarder: audio fetch failed for notification ${n.id}: ${err.message}`);
            }
        }
        // Forward even without audio so the row still shows up remotely.
        this.broadcast('remote-tts-notification', [{ notification: n, audioBase64, mime }]);
    }

    _getJson(path) {
        return this._get(path).then(({ bytes }) => JSON.parse(bytes.toString('utf8')));
    }

    _getBytes(path) {
        return this._get(path);
    }

    _get(path) {
        return new Promise((resolve, reject) => {
            const url = this.backendUrl + path;
            const lib = url.startsWith('https:') ? https : http;
            const req = lib.get(url, (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`GET ${path} -> ${res.statusCode}`));
                    return;
                }
                const chunks = [];
                let total = 0;
                res.on('data', (c) => {
                    total += c.length;
                    if (total > MAX_AUDIO_BYTES + 1024) {
                        req.destroy(new Error('response too large'));
                        return;
                    }
                    chunks.push(c);
                });
                res.on('end', () => resolve({
                    bytes: Buffer.concat(chunks),
                    contentType: res.headers['content-type'] || null
                }));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.setTimeout(15000, () => req.destroy(new Error('backend timeout')));
        });
    }
}

module.exports = TtsRemoteForwarder;
