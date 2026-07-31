/**
 * The known-hosts file and the network sweep that finds new ones.
 *
 * A host is remembered by address plus the certificate it paired with — that
 * certificate is what makes the pairing survive restarts, so this file is the
 * difference between "paired once" and "paired". It sits in userData rather
 * than the repo because it is per-machine state, not source.
 *
 * Discovery is a plain TCP sweep of the local /24 for port 47989. mDNS would be
 * tidier and is what the official clients use, but it needs a dependency and
 * fails on exactly the networks people run this on (VLANs, guest isolation,
 * VPNs). A sweep is dumb, has no dependencies, and finishes in about a second.
 * Typing the address by hand stays the reliable path and the UI treats it that
 * way — discovery is a convenience, never a requirement.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { HTTP_PORT } = require('./nvhttp');

const SCAN_TIMEOUT_MS = 700;
const SCAN_CONCURRENCY = 64;

// Defaults chosen to work everywhere rather than to look impressive: 1080p60 at
// 20 Mbps is the setting almost nobody needs to change on a wired LAN.
const DEFAULT_SETTINGS = {
    width: 1920,
    height: 1080,
    fps: 60,
    bitrateKbps: 20000,
    codec: 'auto',              // auto | h264 | hevc | av1
    hdr: false,
    audio: 'stereo',            // stereo | 5.1 | 7.1
    playAudioOnHost: false,
    optimizeGameSettings: false,
    // OFF by default and deliberately so. The whole point of streaming into the
    // sidebar is watching the terminals at the same time; going full screen
    // covers them and turns this back into an ordinary Moonlight client.
    fullscreen: false,
    vsync: true,
    mouseCapture: true,
};

class MoonlightHosts {
    constructor(dir) {
        this.dir = dir;
        this.file = path.join(dir, 'hosts.json');
        this.data = null;
    }

    load() {
        if (this.data) return this.data;
        try {
            this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        } catch (_) {
            this.data = {};
        }
        if (!Array.isArray(this.data.hosts)) this.data.hosts = [];
        this.data.settings = Object.assign({}, DEFAULT_SETTINGS, this.data.settings || {});
        return this.data;
    }

    save() {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    }

    list() {
        return this.load().hosts.map((host) => Object.assign({}, host));
    }

    get(address) {
        return this.load().hosts.find((h) => h.address === address) || null;
    }

    /** Insert or merge a host, keeping any fields the caller did not supply. */
    upsert(address, patch = {}) {
        const data = this.load();
        let host = data.hosts.find((h) => h.address === address);
        if (!host) {
            host = { address, hostname: address, serverCert: null, settings: null };
            data.hosts.push(host);
        }
        Object.assign(host, patch, { address });
        this.save();
        return Object.assign({}, host);
    }

    remove(address) {
        const data = this.load();
        const before = data.hosts.length;
        data.hosts = data.hosts.filter((h) => h.address !== address);
        this.save();
        return data.hosts.length !== before;
    }

    // ---------- settings ----------
    //
    // Global defaults, with an optional per-host override — a laptop on wifi and
    // a wired desktop rarely want the same bitrate, and having changed it once
    // for one host you should not have to change it back for the other.

    globalSettings() {
        return Object.assign({}, this.load().settings);
    }

    setGlobalSettings(patch) {
        const data = this.load();
        data.settings = Object.assign({}, data.settings, sanitize(patch));
        this.save();
        return Object.assign({}, data.settings);
    }

    /** What a stream to `address` would actually use. */
    settingsFor(address) {
        const host = this.get(address);
        return Object.assign({}, this.globalSettings(), (host && host.settings) || {});
    }

    setHostSettings(address, patch) {
        const host = this.get(address);
        if (!host) return null;
        const merged = Object.assign({}, host.settings || {}, sanitize(patch));
        this.upsert(address, { settings: merged });
        return this.settingsFor(address);
    }

    /** Drop a host's overrides so it follows the global defaults again. */
    clearHostSettings(address) {
        if (!this.get(address)) return null;
        this.upsert(address, { settings: null });
        return this.settingsFor(address);
    }

    static defaults() {
        return Object.assign({}, DEFAULT_SETTINGS);
    }
}

/**
 * Sweep every local /24 for something listening on the GameStream port.
 * Only reports addresses — whether they are really hosts is settled by the
 * caller asking each one for its serverinfo.
 */
async function scan({ timeoutMs = SCAN_TIMEOUT_MS } = {}) {
    const targets = [];
    const seen = new Set();

    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const iface of addresses || []) {
            if (iface.family !== 'IPv4' || iface.internal) continue;
            const prefix = iface.address.split('.').slice(0, 3).join('.');
            if (seen.has(prefix)) continue;
            seen.add(prefix);
            for (let host = 1; host < 255; host++) {
                const candidate = `${prefix}.${host}`;
                if (candidate !== iface.address) targets.push(candidate);
            }
        }
    }

    const found = [];
    let cursor = 0;

    const worker = async () => {
        while (cursor < targets.length) {
            const address = targets[cursor++];
            if (await probe(address, timeoutMs)) found.push(address);
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(SCAN_CONCURRENCY, targets.length) }, worker)
    );

    found.sort(byAddress);
    return found;
}

function probe(address, timeoutMs) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(result);
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(HTTP_PORT, address);
    });
}

function byAddress(a, b) {
    const parse = (ip) => ip.split('.').reduce((acc, part) => (acc << 8) | parseInt(part, 10), 0);
    return parse(a) - parse(b);
}

/** Keep persisted settings to known keys and sane values. */
function sanitize(patch) {
    const out = {};
    if (!patch || typeof patch !== 'object') return out;

    const clampInt = (value, min, max) => {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n)) return undefined;
        return Math.min(max, Math.max(min, n));
    };

    if ('width' in patch) out.width = clampInt(patch.width, 320, 7680);
    if ('height' in patch) out.height = clampInt(patch.height, 240, 4320);
    if ('fps' in patch) out.fps = clampInt(patch.fps, 24, 360);
    if ('bitrateKbps' in patch) out.bitrateKbps = clampInt(patch.bitrateKbps, 500, 500000);
    if ('codec' in patch && ['auto', 'h264', 'hevc', 'av1'].includes(patch.codec)) out.codec = patch.codec;
    if ('audio' in patch && ['stereo', '5.1', '7.1'].includes(patch.audio)) out.audio = patch.audio;

    for (const flag of ['hdr', 'playAudioOnHost', 'optimizeGameSettings', 'fullscreen', 'vsync', 'mouseCapture']) {
        if (flag in patch) out[flag] = !!patch[flag];
    }

    // A clamp that produced NaN means the caller sent junk; drop the key rather
    // than persisting undefined and later writing NaN into a launch URL.
    for (const key of Object.keys(out)) {
        if (out[key] === undefined) delete out[key];
    }
    return out;
}

module.exports = MoonlightHosts;
module.exports.scan = scan;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
