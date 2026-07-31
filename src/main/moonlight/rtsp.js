/**
 * The RTSP handshake that negotiates a stream.
 *
 * Two things about this dialect are load-bearing and neither is standard RTSP:
 *
 *  - ONE MESSAGE PER TCP CONNECTION. The host reads a single request, answers
 *    it, and stops reading. Pipelining a second request down the same socket
 *    gets silence — not an error, not a close, just nothing — which is an
 *    extremely convincing impression of a broken network.
 *
 *  - A `Host` header is mandatory on TCP, and the stream identifiers are
 *    versioned: servers from 7.1.431 (which includes every Sunshine build)
 *    want `streamid=control/13/0` and a PLAY target of `/`, where older ones
 *    want `streamid=control/1/0` and per-stream PLAY targets.
 *
 * The SETUP replies carry the three things the session actually needs: the
 * session id, the ping payload to echo at the video and audio ports, and the
 * connect-data token that identifies us to the control channel.
 */
const net = require('net');

const RTSP_PORT = 48010;
const CLIENT_VERSION = 14;
const IF_MODIFIED_SINCE = 'Thu, 01 Jan 1970 00:00:00 GMT';
const REPLY_TIMEOUT_MS = 10000;

class RtspClient {
    constructor(address) {
        this.address = address;
        this.cseq = 0;
        this.session = null;
    }

    /**
     * One request, one connection. Resolves with the raw reply text.
     */
    transact(verb, target, headers = {}, body = '') {
        return new Promise((resolve, reject) => {
            this.cseq++;

            let msg = `${verb} ${target} RTSP/1.0\r\n`;
            msg += `CSeq: ${this.cseq}\r\n`;
            msg += `X-GS-ClientVersion: ${CLIENT_VERSION}\r\n`;
            msg += `Host: ${this.address}\r\n`;
            if (this.session) msg += `Session: ${this.session}\r\n`;
            for (const [key, value] of Object.entries(headers)) msg += `${key}: ${value}\r\n`;
            if (body) msg += `Content-length: ${body.length}\r\n`;
            msg += `\r\n${body}`;

            const socket = net.connect(RTSP_PORT, this.address, () => socket.write(msg));
            let acc = '';
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                fn(value);
            };

            socket.on('data', (chunk) => {
                acc += chunk.toString('utf8');
                const headEnd = acc.indexOf('\r\n\r\n');
                if (headEnd === -1) return;
                const len = /Content-length:\s*(\d+)/i.exec(acc.slice(0, headEnd));
                if (len && acc.length < headEnd + 4 + parseInt(len[1], 10)) return;
                finish(resolve, acc);
            });
            socket.on('close', () => finish(resolve, acc));
            socket.on('error', (error) => finish(reject, new Error(`${verb} failed: ${error.code || error.message}`)));
            setTimeout(() => finish(reject, new Error(`${verb} timed out — the host stopped answering.`)), REPLY_TIMEOUT_MS);
        });
    }

    static ok(reply) {
        return /^RTSP\/1\.0 200/.test(reply || '');
    }

    static header(reply, name) {
        const match = new RegExp(`${name}:\\s*([^\\r\\n]+)`, 'i').exec(reply || '');
        return match ? match[1].trim() : null;
    }

    /**
     * Run the whole negotiation.
     * @returns {Promise<{pingPayload: Buffer, connectData: number, videoPort: number, audioPort: number, controlPort: number}>}
     */
    async negotiate(settings, clientPorts = { video: 50000, audio: 50001 }) {
        const url = `rtsp://${this.address}:${RTSP_PORT}`;
        const transport = {
            Transport: `unicast;X-GS-ClientPort=${clientPorts.video}-${clientPorts.audio}`,
            'If-Modified-Since': IF_MODIFIED_SINCE,
        };

        const options = await this.transact('OPTIONS', url);
        if (!RtspClient.ok(options)) throw new Error('The host refused the RTSP connection.');

        await this.transact('DESCRIBE', url, {
            Accept: 'application/sdp',
            'If-Modified-Since': IF_MODIFIED_SINCE,
        });

        const audio = await this.transact('SETUP', `${url}/streamid=audio/0/0`, transport);
        if (!RtspClient.ok(audio)) throw new Error('The host refused the audio stream.');
        const sessionHeader = RtspClient.header(audio, 'Session');
        if (sessionHeader) this.session = sessionHeader.split(';')[0].trim();

        const video = await this.transact('SETUP', `${url}/streamid=video/0/0`, transport);
        if (!RtspClient.ok(video)) throw new Error('The host refused the video stream.');

        const control = await this.transact('SETUP', `${url}/streamid=control/13/0`, transport);
        if (!RtspClient.ok(control)) throw new Error('The host refused the control stream.');

        const announce = await this.transact('ANNOUNCE', url,
            { 'Content-type': 'application/sdp' }, buildSdp(this.address, settings));
        if (!RtspClient.ok(announce)) throw new Error('The host rejected the stream configuration.');

        const play = await this.transact('PLAY', `${url}/`);
        if (!RtspClient.ok(play)) throw new Error('The host would not start playback.');

        const pingHex = RtspClient.header(video, 'X-SS-Ping-Payload') || '';
        return {
            // The host looks for its payload as a SUBSTRING, so sending both the
            // ASCII form and the hex-decoded bytes satisfies it either way and
            // saves depending on which encoding a given build wants.
            pingPayload: Buffer.concat([Buffer.from(pingHex, 'utf8'), Buffer.from(pingHex, 'hex')]),
            connectData: parseInt(RtspClient.header(control, 'X-SS-Connect-Data') || '0', 10),
            videoPort: parseInt((/server_port=(\d+)/.exec(video) || [])[1] || '47998', 10),
            audioPort: parseInt((/server_port=(\d+)/.exec(audio) || [])[1] || '48000', 10),
            controlPort: parseInt((/server_port=(\d+)/.exec(control) || [])[1] || '47999', 10),
        };
    }
}

/**
 * The ANNOUNCE payload. The host reads these attributes as the stream's whole
 * configuration — resolution, rate, codec and bitrate all arrive here rather
 * than in the launch request.
 */
function buildSdp(address, settings) {
    // The host reserves headroom for FEC out of whatever we ask for, so the
    // requested figure is 80% of the user's number.
    const adjusted = Math.floor(settings.bitrateKbps * 0.80);
    const hevc = settings.codec === 'hevc';
    const attrs = [];
    const a = (key, value) => attrs.push(`a=${key}:${value}`);

    a('x-nv-video[0].clientViewportWd', settings.width);
    a('x-nv-video[0].clientViewportHt', settings.height);
    a('x-nv-video[0].maxFPS', settings.fps);
    a('x-nv-video[0].packetSize', 1392);
    a('x-nv-video[0].rateControlMode', 4);
    a('x-nv-video[0].timeoutLengthMs', 7000);
    a('x-nv-video[0].framesWithInvalidRefThreshold', 0);
    a('x-nv-video[0].initialBitrateKbps', adjusted);
    a('x-nv-video[0].initialPeakBitrateKbps', adjusted);
    a('x-nv-vqos[0].bw.minimumBitrateKbps', adjusted);
    a('x-nv-vqos[0].bw.maximumBitrateKbps', adjusted);
    a('x-nv-vqos[0].fec.enable', 1);
    a('x-nv-vqos[0].fec.minRequiredFecPackets', 2);
    a('x-nv-vqos[0].bllFec.enable', 0);
    a('x-nv-vqos[0].videoQualityScoreUpdateTime', 5000);
    a('x-nv-vqos[0].qosTrafficType', 5);
    a('x-nv-aqos.qosTrafficType', 4);
    a('x-nv-vqos[0].bitStreamFormat', hevc ? 1 : 0);
    a('x-nv-video[0].videoEncoderSlicesPerFrame', 1);
    a('x-nv-clientSupportHevc', hevc ? 1 : 0);
    a('x-nv-video[0].dynamicRangeMode', settings.hdr ? 1 : 0);
    a('x-nv-video[0].maxNumReferenceFrames', 1);
    a('x-nv-video[0].clientRefreshRateX100', settings.fps * 100);
    a('x-nv-video[0].encoderCscMode', 0);
    a('x-nv-audio.surround.numChannels', 2);
    a('x-nv-audio.surround.channelMask', 3);
    a('x-nv-audio.surround.enable', 0);
    a('x-nv-audio.surround.AudioQuality', 0);
    a('x-nv-aqos.packetDuration', 5);
    a('x-ml-general.featureFlags', 3);
    // Bit 0 is control-v2, which the host lists as required.
    a('x-ss-general.encryptionEnabled', 1);
    a('x-ss-video[0].chromaSamplingType', 0);
    a('x-ml-video.configuredBitrateKbps', settings.bitrateKbps);

    return [
        'v=0',
        `o=android 0 ${CLIENT_VERSION} IN IPv4 ${address}`,
        's=NVIDIA Streaming Client',
        ...attrs,
        't=0 0',
        'm=video 47998  ',
        '',
    ].join('\r\n');
}

module.exports = RtspClient;
module.exports.buildSdp = buildSdp;
