/**
 * StreamSession - one live stream, from launch to pictures on the canvas.
 *
 * Ordering here is not stylistic. The host's video and audio threads sit in a
 * STARTING state and refuse to send anything until an ENet peer appears on the
 * control port; meanwhile their initial-ping deadline is already counting from
 * the moment PLAY returns. So the pings must start immediately and the control
 * channel must connect while they are in flight. Doing the obvious thing —
 * connect control, then begin pinging — loses the race and the host gives up
 * with "Initial Ping Timeout" having never sent a byte of video.
 *
 * Frames leave here over a loopback WebSocket rather than IPC. The consumer is
 * a sandboxed `file://` game frame with no ipcRenderer, and a socket is
 * something it can open unaided; it also keeps 60 full frames a second of
 * structured-clone traffic off the main thread's IPC channel.
 */
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');

const RtspClient = require('./rtsp');
const EnetClient = require('./enet');
const VideoDepacketizer = require('./video');
const AudioDepacketizer = require('./audio');
const ControlChannel = require('./control');
const input = require('./input');

const PING_INTERVAL_MS = 250;
const IDR_MIN_INTERVAL_MS = 500;

class StreamSession extends EventEmitter {
    /**
     * @param {string} address
     * @param {object} settings  the card's stream settings
     * @param {NvHttp} client    an already-paired control-plane client
     */
    constructor(address, settings, client) {
        super();
        this.address = address;
        this.settings = settings;
        this.client = client;

        this.rtsp = null;
        this.enet = null;
        this.control = null;
        this.video = new VideoDepacketizer({ hevc: settings.codec === 'hevc' });
        this.audio = new AudioDepacketizer();
        this.videoSocket = null;
        this.audioSocket = null;
        this.pingTimer = null;
        this.wss = null;
        this.port = 0;
        this.token = crypto.randomBytes(16).toString('hex');
        this.viewers = new Set();
        this.running = false;
        this.frameCount = 0;
        this.lastIdrRequest = 0;
    }

    /** Open the loopback socket the card will read frames from. */
    listen() {
        return new Promise((resolve) => {
            this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
            this.wss.on('connection', (ws, req) => {
                // The port is ephemeral but still local to this machine, so the
                // token keeps another local process from reading the screen.
                const url = new URL(req.url, 'http://127.0.0.1');
                if (url.searchParams.get('token') !== this.token) {
                    ws.close();
                    return;
                }
                this.viewers.add(ws);
                ws.on('close', () => this.viewers.delete(ws));

                // A viewer always joins AFTER the stream has started, so it has
                // already missed the only keyframe the host sends unprompted.
                // Without asking for another it would sit waiting for one
                // forever — a decoder cannot start on a delta frame — showing a
                // black panel while the pipeline behind it runs perfectly.
                if (this.control) this.control.requestIdr();
                // Input travels back up the same socket the frames come down.
                ws.on('message', (raw, isBinary) => {
                    if (isBinary) return;
                    try { this.onInput(JSON.parse(raw.toString('utf8'))); }
                    catch (_) { /* malformed event from the card; ignore it */ }
                });
                ws.send(JSON.stringify({
                    type: 'config',
                    codec: codecString(this.settings),
                    width: this.settings.width,
                    height: this.settings.height,
                    channels: this.settings.audio === 'stereo' ? 2 : (this.settings.audio === '5.1' ? 6 : 8),
                    settings: this.settings,
                }));
            });
            this.wss.on('listening', () => {
                this.port = this.wss.address().port;
                resolve({ port: this.port, token: this.token });
            });
        });
    }

    async start(appId, { resume = false } = {}) {
        await this.listen();

        const session = await this.client.launch(appId, this.settings, { resume });
        this.emit('stage', 'Negotiating the stream');

        // Bind BEFORE negotiating, on whatever ports the OS hands out, and tell
        // the host what we actually got.
        //
        // Fixed ports look simpler but are a trap: they collide with any other
        // instance of this app, and with a session of our own whose sockets have
        // not been reclaimed yet, producing EADDRINUSE at the one moment the
        // user is waiting for a picture. The host does not care which ports we
        // use — it learns them from the source address of our pings.
        this.videoSocket = await bind(0);
        this.audioSocket = await bind(0);

        this.rtsp = new RtspClient(this.address);
        const negotiated = await this.rtsp.negotiate(this.settings, {
            video: this.videoSocket.address().port,
            audio: this.audioSocket.address().port,
        });

        this.video.on('frame', (frame) => this.onFrame(frame));
        this.videoSocket.on('message', (msg) => this.video.push(msg));

        this.audio.on('frame', (opus) => this.onAudio(opus, false));
        this.audio.on('missing', () => this.onAudio(Buffer.alloc(0), true));
        this.audioSocket.on('message', (msg) => this.audio.push(msg));

        // Ping first — the deadline is already running.
        this.emit('stage', 'Waiting for the first frame');
        const beat = () => {
            this.videoSocket.send(negotiated.pingPayload, negotiated.videoPort, this.address);
            this.audioSocket.send(negotiated.pingPayload, negotiated.audioPort, this.address);
        };
        beat();
        this.pingTimer = setInterval(beat, PING_INTERVAL_MS);

        // ...and connect control while those pings are in flight.
        this.enet = new EnetClient(this.address, negotiated.controlPort, negotiated.connectData);
        this.enet.on('disconnected', () => this.emit('ended', 'The host closed the control channel.'));
        // An EventEmitter with no 'error' listener throws, which would take the
        // whole session down over a recoverable control-channel hiccup.
        this.enet.on('error', (err) => this.emit('stage', `Control channel: ${err.message}`));
        await this.enet.connect();

        // The rikey minted at launch is the key for every control message.
        this.control = new ControlChannel(this.enet, session.rikey);
        this.control.startB();
        this.control.startKeepalive();
        // Cover the other ordering: viewers that connected before control existed.
        if (this.viewers.size) this.control.requestIdr();

        // A dropped frame leaves the decoder stuck until the next keyframe, and
        // the host only sends one on request.
        // Rate-limited: under loss the depacketizer reports many misses in a
        // row, and an IDR is a full frame — answering every one of them costs
        // more bandwidth than the loss that prompted it.
        this.video.on('missing', () => {
            const now = Date.now();
            if (now - this.lastIdrRequest < IDR_MIN_INTERVAL_MS) return;
            this.lastIdrRequest = now;
            this.control.requestIdr();
        });

        this.running = true;
        this.emit('started', { port: this.port, token: this.token, session });
        return { port: this.port, token: this.token, appId };
    }

    onFrame(frame) {
        this.frameCount++;
        if (this.frameCount === 1) this.emit('stage', 'Streaming');

        // A 4-byte prefix is cheaper for the frame to read than a JSON envelope.
        const header = Buffer.alloc(4);
        header.writeUInt8(frame.keyframe ? 1 : 0, 0);
        header.writeUInt8(0, 1);
        header.writeUInt16BE(0, 2);
        const payload = Buffer.concat([header, frame.data]);

        for (const ws of this.viewers) {
            // Never queue: a viewer that cannot keep up should drop frames
            // rather than accumulate latency it can never pay back.
            if (ws.readyState === 1 && ws.bufferedAmount < 4 * 1024 * 1024) {
                ws.send(payload);
            }
        }
    }

    /**
     * Translate one event from the card into an input packet.
     *
     * Kept as a flat switch rather than a table because each event shapes its
     * arguments differently, and the mouse cases care about the video's own
     * dimensions rather than whatever size the canvas is drawn at.
     */
    onInput(event) {
        if (!this.control) return;
        const { width, height } = this.settings;

        switch (event.type) {
            case 'mousemove':
                this.control.sendInput(input.mouseMoveRelative(event.dx, event.dy));
                break;
            case 'mouseposition':
                this.control.sendInput(input.mouseMoveAbsolute(event.x, event.y, width, height));
                break;
            case 'mousedown':
            case 'mouseup':
                this.control.sendInput(input.mouseButton(event.type === 'mousedown', event.button));
                break;
            case 'scroll':
                if (event.dy) this.control.sendInput(input.scroll(event.dy));
                if (event.dx) this.control.sendInput(input.horizontalScroll(event.dx));
                break;
            case 'keydown':
            case 'keyup':
                this.control.sendInput(input.keyboard(event.type === 'keydown', event.keyCode, event.modifiers || 0));
                break;
            case 'text':
                this.control.sendInput(input.utf8Text(event.text));
                break;
            case 'gamepad':
                this.control.sendInput(input.gamepad(
                    event.index || 0, event.buttons || 0, event.axes || {}, event.activeMask
                ));
                break;
            case 'idr':
                this.control.requestIdr();
                break;
            default:
                break;   // unknown event from a future card build
        }
    }

    /**
     * Audio frames go down the same socket as video, tagged so the card can
     * tell them apart without a second connection.
     */
    onAudio(opus, concealed) {
        const header = Buffer.alloc(4);
        header.writeUInt8(2, 0);              // 2 = audio (1/0 = video keyframe flag)
        header.writeUInt8(concealed ? 1 : 0, 1);
        const payload = Buffer.concat([header, opus]);

        for (const ws of this.viewers) {
            if (ws.readyState === 1 && ws.bufferedAmount < 4 * 1024 * 1024) ws.send(payload);
        }
    }

    stats() {
        return Object.assign({
            viewers: this.viewers.size,
            running: this.running,
            input: !!this.control,
        }, this.video.stats, { audio: Object.assign({}, this.audio.stats) });
    }

    /**
     * Tear the local stream down.
     *
     * `cancelHost` is the difference between stopping and resuming. Quitting
     * means telling the host to end the session, but a resume tears down only
     * this side and reconnects to the session still running over there — so
     * cancelling on the way out would kill the very thing being resumed and
     * leave `/resume` with nothing to attach to.
     */
    async stop({ cancelHost = true } = {}) {
        this.running = false;
        clearInterval(this.pingTimer);
        if (this.control) { try { this.control.terminate(); } catch (_) { /* channel already gone */ } this.control = null; }
        if (this.enet) this.enet.close();
        for (const socket of [this.videoSocket, this.audioSocket]) {
            if (socket) { try { socket.close(); } catch (_) { /* already closed */ } }
        }
        for (const ws of this.viewers) { try { ws.close(); } catch (_) { /* gone */ } }
        this.viewers.clear();
        if (this.wss) { try { this.wss.close(); } catch (_) { /* gone */ } }
        if (cancelHost) {
            try { await this.client.cancel(); } catch (_) { /* host already idle */ }
        }
        this.emit('ended', 'stopped');
    }
}

/**
 * The WebCodecs codec string for the negotiated stream.
 *
 * HDR needs 10-bit, which in HEVC means Main10 (profile 2) — a Main-profile
 * string would configure an 8-bit decoder and every frame would fail to decode.
 */
function codecString(settings) {
    if (settings.codec !== 'hevc') return 'avc1.64002A';   // H.264 High 4.2
    // hev1, not hvc1: hvc1 implies out-of-band parameter sets (an hvcC box),
    // and this stream is Annex B with them in-band.
    return settings.hdr ? 'hev1.2.4.L120.90' : 'hev1.1.6.L120.90';
}

function bind(port) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', reject);
        socket.bind(port, () => resolve(socket));
    });
}

module.exports = StreamSession;
