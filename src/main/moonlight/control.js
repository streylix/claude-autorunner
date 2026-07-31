/**
 * The encrypted control channel.
 *
 * Sunshine (and any host from 7.1.431) requires SS_ENC_CONTROL_V2, so every
 * control message — input included — is AES-GCM sealed under the same `rikey`
 * that was minted for the launch request. Nothing readable goes over ENet.
 *
 * Wire layout of one message, as the ENet reliable payload:
 *
 *   0  u16 LE  headerType, always 0x0001
 *   2  u16 LE  length = 4 (seq) + 16 (tag) + 4 (inner header) + payload
 *   4  u32 LE  seq, monotonic — and doubles as the GCM IV
 *   8  ..16    AES-GCM tag
 *   24 ..      ciphertext of { u16 LE type, u16 LE payloadLength, payload }
 *
 * The IV is the sequence number in little-endian in the low four bytes, then
 * zeroes, then 'C','C' at offsets 10 and 11 — "client originated, control
 * stream". Getting those two marker bytes wrong yields a tag the host rejects
 * silently, which looks exactly like input being ignored.
 */
const crypto = require('crypto');

const HEADER_TYPE = 0x0001;
const TAG_LENGTH = 16;

// Message types for an encrypted gen-7 host.
const TYPE_REQUEST_IDR = 0x0302;
const TYPE_START_B = 0x0307;
const TYPE_INVALIDATE_REF_FRAMES = 0x0301;
const TYPE_LOSS_STATS = 0x0201;
const TYPE_INPUT_DATA = 0x0206;
const TYPE_PERIODIC_PING = 0x0200;
const TYPE_TERMINATION = 0x0109;

// Comfortably inside the host's 10-second session timeout.
const PING_INTERVAL_MS = 500;

class ControlChannel {
    /**
     * @param {EnetClient} enet
     * @param {string} rikeyHex  the AES key handed to the host at launch
     */
    constructor(enet, rikeyHex) {
        this.enet = enet;
        this.key = Buffer.from(rikeyHex, 'hex');
        this.seq = 0;
        this.keepaliveTimer = null;
    }

    /** Seal and send one control message. */
    send(type, payload = Buffer.alloc(0)) {
        if (!this.enet || !this.enet.connected) return false;

        const seq = this.seq++;

        const iv = Buffer.alloc(12);
        iv.writeUInt32LE(seq >>> 0, 0);
        iv[10] = 0x43;   // 'C' — client originated
        iv[11] = 0x43;   // 'C' — control stream

        // The inner header travels encrypted along with the payload.
        const inner = Buffer.alloc(4 + payload.length);
        inner.writeUInt16LE(type, 0);
        inner.writeUInt16LE(payload.length, 2);
        payload.copy(inner, 4);

        const cipher = crypto.createCipheriv('aes-128-gcm', this.key, iv);
        const ciphertext = Buffer.concat([cipher.update(inner), cipher.final()]);
        const tag = cipher.getAuthTag();

        const head = Buffer.alloc(8);
        head.writeUInt16LE(HEADER_TYPE, 0);
        head.writeUInt16LE(4 + TAG_LENGTH + inner.length, 2);
        head.writeUInt32LE(seq >>> 0, 4);

        this.enet.sendReliable(Buffer.concat([head, tag, ciphertext]), 0);
        return true;
    }

    /** Input packets ride the control stream already encrypted by `send`. */
    sendInput(packet) {
        return this.send(TYPE_INPUT_DATA, packet);
    }

    /** Ask for a fresh keyframe — used after a frame is dropped. */
    requestIdr() {
        return this.send(TYPE_REQUEST_IDR, Buffer.alloc(0));
    }

    /**
     * Announce the client is ready. The host will not begin sending until it
     * has seen this on an encrypted channel.
     */
    startB() {
        return this.send(TYPE_START_B, Buffer.alloc(0));
    }

    /**
     * Keepalive.
     *
     * The host refreshes its 10-second session timeout only when it actually
     * receives data from us — ENet's own protocol-level pings never surface as
     * events on its side, so a session with nothing to say dies mid-stream
     * while video is still flowing perfectly. This is the message that keeps it
     * alive, and it has to keep coming for as long as the stream does.
     */
    ping() {
        const payload = Buffer.alloc(8);
        payload.writeUInt16LE(4, 0);   // length of the part that follows
        payload.writeUInt32LE(0, 2);   // timestamp; the host does not read it
        return this.send(TYPE_PERIODIC_PING, payload);
    }

    startKeepalive() {
        this.stopKeepalive();
        this.keepaliveTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
    }

    stopKeepalive() {
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
    }

    terminate() {
        this.stopKeepalive();
        return this.send(TYPE_TERMINATION, Buffer.alloc(4));
    }
}

module.exports = ControlChannel;
module.exports.TYPES = {
    TYPE_REQUEST_IDR,
    TYPE_START_B,
    TYPE_INVALIDATE_REF_FRAMES,
    TYPE_LOSS_STATS,
    TYPE_INPUT_DATA,
    TYPE_PERIODIC_PING,
    TYPE_TERMINATION,
};
