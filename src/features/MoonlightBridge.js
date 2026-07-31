/**
 * MoonlightBridge - lets the Moonlight game card reach the main process.
 *
 * Games on the stage are plain `file://` documents in an iframe. They get no
 * Node (`nodeIntegrationInSubFrames` is off) and no ipcRenderer, which is the
 * right default — a game written by a Claude session should not be able to
 * touch the machine. Moonlight is the one card that genuinely needs to, so it
 * gets a narrow, audited hole rather than a general one:
 *
 *   - a caller must hold the current TOKEN. See below.
 *   - only ops in ALLOWED_OPS are relayed, and each becomes exactly the IPC
 *     channel `moonlight:<op>`. There is no path from a frame message to an
 *     arbitrary channel.
 *   - arguments are re-read field by field on the main side (see hosts.js
 *     `sanitize`), so a frame cannot smuggle extra keys into stored settings.
 *
 * Why a token rather than simply checking the sender?
 *
 * The obvious check is `e.source === frame.contentWindow`, which is what the
 * Vibe Blast storage bridge does. It does not work here: these are `file://`
 * documents, every one of which gets its own opaque origin, and the WindowProxy
 * the parent reads off the iframe is not identity-equal to the `source` on the
 * arriving event. The comparison silently rejects every message.
 *
 * So the trust is established the other way round. A frame asks to shake hands;
 * the token is minted and posted TO THE STAGE FRAME — never back to whoever
 * asked. A thumbnail or any other frame can send the request, but the answer is
 * delivered somewhere it cannot read, so it never obtains a token. The stage
 * frame must also currently be showing moonlight.html, which keeps the hole
 * shut while an ordinary game is on the stage.
 *
 * The wire format otherwise matches the storage bridge Vibe Blast already uses:
 * the frame posts `{source:'moonlight', id, op, token, args}` and gets back
 * `{source:'moonlight-host', id, ok, result, error}` with the same id.
 */
const crypto = require('crypto');

// The one card allowed to drive this bridge.
const CARD_URL = 'moonlight.html';

// One entry per main-process handler in src/main/moonlight/index.js.
const ALLOWED_OPS = new Set([
    'hosts',
    'add-host',
    'remove-host',
    'refresh-host',
    'discover',
    'pair',
    'pair-cancel',
    'unpair',
    'apps',
    'app-asset',
    'settings',
    'save-settings',
    'reset-settings',
    'launch',
    'quit',
    'stream-stats',
]);

class MoonlightBridge {
    constructor(eventBus, ipcHandler, vibeBlastManager) {
        this.eventBus = eventBus;
        this.ipc = ipcHandler;
        this.vibe = vibeBlastManager;
        this.boundMessage = null;
        this.token = null;
    }

    initialize() {
        if (!this.ipc || !this.vibe) return;

        this.boundMessage = (e) => this.handleMessage(e);
        window.addEventListener('message', this.boundMessage);

        // Pushes from main — pairing progress, scan lifecycle, session changes.
        // Forwarded verbatim; the card decides what is worth showing.
        this.ipc.on('moonlight:event', (_e, payload) => this.post({
            source: 'moonlight-host',
            event: payload && payload.event,
            payload,
        }));
    }

    dispose() {
        if (this.boundMessage) window.removeEventListener('message', this.boundMessage);
        this.boundMessage = null;
    }

    /** The stage frame's window — the only place a token is ever delivered. */
    stageWindow() {
        const frame = this.vibe && this.vibe.frame;
        return frame && frame.contentWindow ? frame.contentWindow : null;
    }

    /** True while the Moonlight card itself is the game on the stage. */
    stageIsCard() {
        const frame = this.vibe && this.vibe.frame;
        if (!frame) return false;
        const src = frame.getAttribute('src') || '';
        // The loader appends ?v=<mtime>, so compare the path only.
        return src.split('?')[0] === CARD_URL;
    }

    /**
     * Mint a fresh token and hand it to the stage frame.
     *
     * Deliberately posted to the stage window rather than answered to the
     * requester: that is the whole security property. Rotating on every
     * handshake also means a reloaded card invalidates the previous one.
     */
    handshake() {
        if (!this.stageIsCard()) return;
        this.token = crypto.randomBytes(24).toString('hex');
        this.post({ source: 'moonlight-host', op: 'welcome', token: this.token });
    }

    post(message) {
        const target = this.stageWindow();
        if (!target) return;
        try {
            target.postMessage(message, '*');
        } catch (_) { /* frame navigated away mid-send */ }
    }

    handleMessage(e) {
        const msg = e.data;
        if (!msg || msg.source !== 'moonlight') return;

        // The handshake is the one op that needs no token, and it is answered
        // through the stage frame rather than to the sender.
        if (msg.op === 'handshake') {
            this.handshake();
            return;
        }

        if (!msg.id) return;

        const reply = (payload) => {
            try {
                e.source.postMessage(
                    Object.assign({ source: 'moonlight-host', id: msg.id }, payload), '*'
                );
            } catch (_) { /* frame went away mid-flight */ }
        };

        // Without a live token the caller never received one through the
        // trusted channel, so it is not the card on the stage.
        if (!this.token || msg.token !== this.token || !this.stageIsCard()) {
            reply({ ok: false, error: 'stale', stale: true });
            return;
        }

        if (!ALLOWED_OPS.has(msg.op)) {
            reply({ ok: false, error: `unknown op ${msg.op}` });
            return;
        }

        this.ipc.invoke(`moonlight:${msg.op}`, msg.args || {})
            .then((result) => {
                // Main already answers {ok, result|error}; pass it straight on.
                reply(result && typeof result === 'object' && 'ok' in result
                    ? result
                    : { ok: true, result });
                this.log(msg, result);
            })
            .catch((error) => reply({ ok: false, error: error.message || 'request failed' }));
    }

    /** Surface the handful of ops worth a line in the app's action log. */
    log(msg, result) {
        if (!this.eventBus || !result || result.ok === false) return;

        if (msg.op === 'add-host' && result.result) {
            this.eventBus.emit('log:action', {
                message: `Moonlight host added: ${result.result.hostname || msg.args.address}`,
                type: 'info',
            });
        } else if (msg.op === 'launch') {
            this.eventBus.emit('log:action', {
                message: `Moonlight session started on ${msg.args.address}`,
                type: 'info',
            });
        } else if (msg.op === 'quit') {
            this.eventBus.emit('log:action', {
                message: `Moonlight session stopped on ${msg.args.address}`,
                type: 'info',
            });
        }
    }
}

module.exports = MoonlightBridge;
module.exports.ALLOWED_OPS = ALLOWED_OPS;
