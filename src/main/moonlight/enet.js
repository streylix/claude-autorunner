/**
 * A minimal ENet client — just enough of the protocol to open the control
 * channel Sunshine insists on before it will send a single video packet.
 *
 * Why this exists at all: the video and audio threads on the host block in
 * their STARTING state until an ENet peer connects on 47999. Until then they
 * ignore the UDP pings the client is dutifully sending and eventually give up
 * with "Initial Ping Timeout". So the control channel is not an optional extra
 * to add once pictures are moving; it is the thing that starts them.
 *
 * This is deliberately NOT a general ENet implementation. It handles the
 * connection handshake, acknowledgements, keepalive pings and reliable sends —
 * no fragmentation, no unsequenced delivery, no bandwidth throttling. That is
 * the subset the control stream uses.
 *
 * Wire notes, all of which are easy to get wrong:
 *   - every multi-byte field is BIG endian
 *   - the header is a 2-byte peerID, plus a 2-byte sentTime when the
 *     SENT_TIME flag is set in the peerID's high bits
 *   - a client that has not been assigned a peer id yet sends 0xFFF
 *   - `data` on the CONNECT command is passed through to the server, which is
 *     how Sunshine matches the peer to the session it is holding open
 */
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// Commands. The high bit asks the peer to acknowledge.
const CMD_ACKNOWLEDGE = 1;
const CMD_CONNECT = 2;
const CMD_VERIFY_CONNECT = 3;
const CMD_DISCONNECT = 4;
const CMD_PING = 5;
const CMD_SEND_RELIABLE = 6;
const CMD_BANDWIDTH_LIMIT = 10;
const CMD_THROTTLE_CONFIGURE = 11;
const FLAG_ACKNOWLEDGE = 0x80;

const HEADER_FLAG_SENT_TIME = 0x8000;
// Stand-in peer id used until the host assigns a real one.
const UNASSIGNED_PEER_ID = 0xfff;

const MTU = 1392;
const CHANNEL_COUNT = 1;
const PING_INTERVAL_MS = 500;
const RETRANSMIT_TICK_MS = 50;
// ENet's own initial round-trip guess; the link here is a LAN or a tailnet.
const RETRANSMIT_AFTER_MS = 300;
const MAX_RETRANSMITS = 10;
const CONNECT_RETRIES = 8;
const CONNECT_RETRY_MS = 500;

class EnetClient extends EventEmitter {
    /**
     * @param {string} host
     * @param {number} port
     * @param {number} connectData  the host's X-SS-Connect-Data
     */
    constructor(host, port, connectData) {
        super();
        this.host = host;
        this.port = port;
        this.connectData = connectData >>> 0;

        this.socket = null;
        this.connected = false;
        this.peerId = UNASSIGNED_PEER_ID;   // ours, until VERIFY_CONNECT
        this.outgoingPeerId = 0;            // theirs, from VERIFY_CONNECT

        // Reliable sequence numbers are tracked PER CHANNEL, and the system
        // channel (0xFF, used by connect/ping/disconnect) keeps its own counter
        // separate from every data channel. Sharing one counter leaves channel
        // 0's numbering inflated by however many pings have gone out; the host
        // then treats each data packet as arriving from the future and holds it
        // in its reassembly window forever. Nothing errors — input simply never
        // takes effect.
        this.systemSequence = 0;
        this.channelSequences = new Map();

        // Unacknowledged reliable commands, keyed "<channel>:<sequence>".
        //
        // Retransmission is not optional. Reliable delivery on a channel is
        // strictly ordered, so a single lost datagram makes the host hold every
        // later command on that channel forever, waiting for a sequence number
        // that is never coming again. Nothing errors and the connection stays
        // up — input simply stops arriving partway through a session.
        this.pending = new Map();
        this.retransmitTimer = null;
        this.startTime = 0;
        this.pingTimer = null;
        this.connectTimer = null;
    }

    /** Milliseconds since the client started, which is ENet's clock. */
    now() {
        return (Date.now() - this.startTime) & 0xffff;
    }

    /** Frame one or more commands into a datagram and send it. */
    send(commands) {
        const header = Buffer.alloc(4);
        header.writeUInt16BE(this.peerId | HEADER_FLAG_SENT_TIME, 0);
        header.writeUInt16BE(this.now(), 2);
        const packet = Buffer.concat([header, ...commands]);
        this.socket.send(packet, this.port, this.host);
    }

    commandHeader(command, channelId, sequence) {
        const buf = Buffer.alloc(4);
        buf.writeUInt8(command, 0);
        buf.writeUInt8(channelId, 1);
        buf.writeUInt16BE(sequence, 2);
        return buf;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.startTime = Date.now();
            this.socket = dgram.createSocket('udp4');
            this.socket.on('message', (msg) => this.onMessage(msg));
            this.socket.on('error', (err) => this.emit('error', err));

            this.socket.bind(() => {
                let attempts = 0;
                const attempt = () => {
                    if (this.connected) return;
                    if (++attempts > CONNECT_RETRIES) {
                        this.close();
                        return reject(new Error('The host never answered on the control channel.'));
                    }
                    this.sendConnect();
                    this.connectTimer = setTimeout(attempt, CONNECT_RETRY_MS);
                };

                this.once('connected', () => {
                    clearTimeout(this.connectTimer);
                    resolve();
                });
                attempt();
            });
        });
    }

    sendConnect() {
        // 44 bytes of fields follow the 4-byte command header, so the whole
        // CONNECT command is 48 bytes on the wire.
        const body = Buffer.alloc(44);
        let o = 0;
        body.writeUInt16BE(UNASSIGNED_PEER_ID, o); o += 2;   // outgoingPeerID
        body.writeUInt8(0xff, o); o += 1;                    // incomingSessionID
        body.writeUInt8(0xff, o); o += 1;                    // outgoingSessionID
        body.writeUInt32BE(MTU, o); o += 4;
        body.writeUInt32BE(32 * 1024, o); o += 4;            // windowSize
        body.writeUInt32BE(CHANNEL_COUNT, o); o += 4;
        body.writeUInt32BE(0, o); o += 4;                    // incomingBandwidth
        body.writeUInt32BE(0, o); o += 4;                    // outgoingBandwidth
        body.writeUInt32BE(5000, o); o += 4;                 // packetThrottleInterval
        body.writeUInt32BE(2, o); o += 4;                    // packetThrottleAcceleration
        body.writeUInt32BE(2, o); o += 4;                    // packetThrottleDeceleration
        body.writeUInt32BE(this.connectId || (this.connectId = crypto.randomBytes(4).readUInt32BE(0)), o); o += 4;
        body.writeUInt32BE(this.connectData, o); o += 4;     // Sunshine's session handle

        // Always sequence 1 — a retry is a retransmit of the same command, not
        // a new one — which also leaves the system counter at 1 so pings follow.
        this.systemSequence = 1;
        this.send([
            this.commandHeader(CMD_CONNECT | FLAG_ACKNOWLEDGE, 0xff, 1),
            body,
        ]);
    }

    onMessage(msg) {
        if (msg.length < 4) return;

        const rawPeerId = msg.readUInt16BE(0);
        const hasSentTime = (rawPeerId & HEADER_FLAG_SENT_TIME) !== 0;
        let offset = hasSentTime ? 4 : 2;
        const sentTime = hasSentTime ? msg.readUInt16BE(2) : 0;

        // A datagram can carry several commands back to back.
        while (offset + 4 <= msg.length) {
            const raw = msg.readUInt8(offset);
            const command = raw & 0x0f;
            const channelId = msg.readUInt8(offset + 1);
            const sequence = msg.readUInt16BE(offset + 2);

            const consumed = this.handleCommand(command, channelId, sequence, msg, offset, sentTime);

            // ANY command carrying the acknowledge flag must be acknowledged,
            // not just the handful we act on. The host sets it on things we
            // otherwise ignore — BANDWIDTH_LIMIT above all — and when those go
            // unacknowledged it retransmits them forever and eventually treats
            // the peer as dead, at which point it stops acknowledging us too and
            // the whole control channel quietly seizes up.
            //
            // Acknowledged AFTER handling, never before: VERIFY_CONNECT is what
            // assigns our peer id, and an acknowledgement sent ahead of it still
            // carries the unassigned 0xFFF. The host cannot match that to the
            // peer it just created, so it concludes the connection was never
            // established and drops the session a few seconds later.
            if (raw & FLAG_ACKNOWLEDGE) {
                this.acknowledge(channelId, sequence, sentTime);
            }

            if (consumed <= 0) return;
            offset += consumed;
        }
    }

    handleCommand(command, channelId, sequence, msg, offset, sentTime) {
        switch (command) {
            // VERIFY_CONNECT carries one fewer field than CONNECT (no `data`),
            // so it is 44 bytes including the header.
            case CMD_VERIFY_CONNECT: {
                if (msg.length < offset + 44) return -1;
                // The id the host wants us to put in our outgoing headers.
                this.outgoingPeerId = msg.readUInt16BE(offset + 4);
                this.peerId = this.outgoingPeerId;
                if (!this.connected) {
                    this.connected = true;
                    this.startPing();
                    this.emit('connected', { peerId: this.peerId });
                }
                return 44;
            }

            case CMD_ACKNOWLEDGE: {
                // Body: the sequence being acked, then the time it was sent.
                if (msg.length >= offset + 8) {
                    const acked = msg.readUInt16BE(offset + 4);
                    this.pending.delete(`${channelId}:${acked}`);
                }
                return 8;
            }

            case CMD_PING:
                return 4;

            case CMD_DISCONNECT:
                this.connected = false;
                this.emit('disconnected');
                return 8;

            case CMD_SEND_RELIABLE: {
                if (msg.length < offset + 6) return -1;
                const length = msg.readUInt16BE(offset + 4);
                const payload = msg.subarray(offset + 6, offset + 6 + length);
                this.emit('data', Buffer.from(payload), channelId);
                return 6 + length;
            }

            case CMD_BANDWIDTH_LIMIT:
                return 12;

            case CMD_THROTTLE_CONFIGURE:
                return 16;

            default:
                // Unknown command: without a length we cannot keep walking the
                // datagram, so stop rather than misparse the remainder.
                return -1;
        }
    }

    acknowledge(channelId, sequence, sentTime) {
        const body = Buffer.alloc(4);
        body.writeUInt16BE(sequence, 0);
        body.writeUInt16BE(sentTime, 2);
        this.send([this.commandHeader(CMD_ACKNOWLEDGE, channelId, 0), body]);
    }

    /** Next reliable sequence number for a channel; 0xFF is the system channel. */
    nextSequence(channelId) {
        if (channelId === 0xff) {
            this.systemSequence = (this.systemSequence + 1) & 0xffff;
            return this.systemSequence;
        }
        const next = ((this.channelSequences.get(channelId) || 0) + 1) & 0xffff;
        this.channelSequences.set(channelId, next);
        return next;
    }

    startPing() {
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
            this.send([this.commandHeader(CMD_PING | FLAG_ACKNOWLEDGE, 0xff, this.nextSequence(0xff))]);
        }, PING_INTERVAL_MS);
    }

    /** Reliable send on a data channel — how control messages reach the host. */
    sendReliable(payload, channelId = 0) {
        const sequence = this.nextSequence(channelId);
        const body = Buffer.alloc(2);
        body.writeUInt16BE(payload.length, 0);
        const commands = [
            this.commandHeader(CMD_SEND_RELIABLE | FLAG_ACKNOWLEDGE, channelId, sequence),
            body,
            payload,
        ];

        this.pending.set(`${channelId}:${sequence}`, {
            commands,
            sentAt: Date.now(),
            attempts: 1,
        });
        this.armRetransmit();
        this.send(commands);
    }

    armRetransmit() {
        if (this.retransmitTimer) return;
        this.retransmitTimer = setInterval(() => this.retransmit(), RETRANSMIT_TICK_MS);
    }

    /** Resend anything the host has not acknowledged yet. */
    retransmit() {
        if (this.pending.size === 0) {
            clearInterval(this.retransmitTimer);
            this.retransmitTimer = null;
            return;
        }

        const now = Date.now();
        for (const [key, entry] of this.pending) {
            if (now - entry.sentAt < RETRANSMIT_AFTER_MS) continue;

            if (entry.attempts >= MAX_RETRANSMITS) {
                // The channel is unrecoverable at this point: the host is still
                // waiting on this sequence and everything behind it is stuck.
                this.pending.delete(key);
                this.emit('error', new Error('The control channel stopped responding.'));
                continue;
            }

            entry.attempts++;
            entry.sentAt = now;
            // Reframed so the header carries a current sent-time, as ENet does.
            this.send(entry.commands);
        }
    }

    close() {
        clearInterval(this.pingTimer);
        clearInterval(this.retransmitTimer);
        this.retransmitTimer = null;
        this.pending.clear();
        clearTimeout(this.connectTimer);
        if (this.socket) {
            try { this.socket.close(); } catch (_) { /* already closed */ }
            this.socket = null;
        }
        this.connected = false;
    }
}

module.exports = EnetClient;
