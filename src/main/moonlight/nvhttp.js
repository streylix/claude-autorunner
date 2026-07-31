/**
 * NvHTTP - the GameStream control API spoken by both NVIDIA GFE and Sunshine.
 *
 * Two ports, and which one you use is itself the authentication:
 *
 *   :47989 plain HTTP   — reachable by anyone; only tells you the host exists
 *   :47984 HTTPS + mTLS — everything real, and only after pairing
 *
 * The host's TLS certificate is self-signed, so Node's normal verification can
 * never pass. Rather than simply disabling the check, this client disables it
 * and then pins: the certificate captured during pairing is compared against
 * the one presented on every later connection, so a substituted host is caught
 * even though no CA was ever involved. `rejectUnauthorized: false` without a
 * pin would be the actual security hole.
 *
 * Responses are small XML documents. They are read with targeted regexes rather
 * than a parser dependency — the schema is fixed, shallow, and we only ever
 * want a handful of leaf values out of it.
 */
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const pairing = require('./pairing');
const MoonlightIdentity = require('./identity');

const HTTP_PORT = 47989;
const HTTPS_PORT = 47984;
const TIMEOUT_MS = 8000;
// Pairing waits on a human walking to another machine and typing four digits.
// Sunshine holds the first request open for exactly that long, so this is a
// patience budget, not a network timeout.
const PAIR_TIMEOUT_MS = 120000;

class NvHttp {
    /**
     * @param {string} address  host IP or name
     * @param {MoonlightIdentity} identity
     * @param {{serverCert?: string}} [known]  pinned certificate from a past pairing
     */
    constructor(address, identity, known = {}) {
        this.address = address;
        this.identity = identity;
        this.serverCert = known.serverCert || null;
    }

    // ---------- transport ----------

    /** A fresh uuid per request; the host uses it only to correlate its logs. */
    static uuid() {
        return crypto.randomUUID().replace(/-/g, '');
    }

    query(extra = {}) {
        const { uniqueId } = this.identity.load();
        const params = new URLSearchParams({ uniqueid: uniqueId, uuid: NvHttp.uuid() });
        for (const [key, value] of Object.entries(extra)) {
            if (value !== undefined && value !== null) params.append(key, String(value));
        }
        return params.toString();
    }

    /**
     * Every call gets its own connection (`agent: false`).
     *
     * This is not a style choice. Node's global agent pools connections with
     * keep-alive on by default, but the host closes each one after replying, so
     * two calls in quick succession — which is the normal case, since pairing
     * asks for serverinfo and then immediately posts a challenge — hand the
     * second request a socket the host is already tearing down. It surfaces as
     * "socket hang up" on a request that never reached the host at all.
     *
     * @param {string} path
     * @param {object} params
     * @param {{secure?: boolean, timeout?: number, binary?: boolean}} opts
     */
    request(path, params = {}, opts = {}) {
        const secure = opts.secure !== false;
        const timeout = opts.timeout || TIMEOUT_MS;
        const url = `${path}?${this.query(params)}`;

        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                fn(value);
            };

            let requestOptions;
            let transport;

            if (secure) {
                const { cert, key } = this.identity.load();
                transport = https;
                requestOptions = {
                    host: this.address,
                    port: HTTPS_PORT,
                    path: url,
                    method: 'GET',
                    cert,
                    key,
                    // Self-signed by definition; the pin below is the real check.
                    rejectUnauthorized: false,
                    // GFE speaks an old TLS dialect and offers no modern suites.
                    //
                    // Note what is NOT here: OpenSSL's `ciphers: 'DEFAULT:@SECLEVEL=0'`,
                    // the usual way to talk to such a host. This code runs in
                    // Electron, which links BoringSSL, and BoringSSL does not
                    // implement @SECLEVEL — it rejects the whole cipher string
                    // with "SSL routines:OPENSSL_internal:INVALID_COMMAND" and
                    // every HTTPS call fails. Plain `node` links real OpenSSL
                    // and accepts it, so this breaks ONLY inside the app and
                    // looks fine from a script.
                    minVersion: 'TLSv1',
                    agent: false,
                };
            } else {
                transport = http;
                requestOptions = {
                    host: this.address,
                    port: HTTP_PORT,
                    path: url,
                    method: 'GET',
                    agent: false,
                };
            }

            const req = transport.request(requestOptions, (res) => {
                if (secure) {
                    const peer = res.socket.getPeerCertificate && res.socket.getPeerCertificate();
                    // Remembered even when there is nothing to compare against
                    // yet, so a pairing that completed on the host but lost its
                    // confirmation can still be recovered. See `serverInfo`.
                    if (peer && peer.raw) this.lastPeerCert = derToPem(peer.raw);
                }
                if (secure && this.serverCert) {
                    const peer = res.socket.getPeerCertificate && res.socket.getPeerCertificate();
                    if (!this.certMatchesPin(peer)) {
                        req.destroy();
                        return finish(reject, new Error(
                            'The host presented a different certificate than the one it paired with. '
                            + 'Either it was reinstalled — unpair and pair again — or this is not the same machine.'
                        ));
                    }
                }

                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const body = Buffer.concat(chunks);
                    if (res.statusCode !== 200) {
                        return finish(reject, new Error(`Host replied HTTP ${res.statusCode}`));
                    }
                    if (opts.binary) return finish(resolve, body);

                    const xml = body.toString('utf8');
                    // The transport status is not the answer. Sunshine reports
                    // application failures — an unrecognised client certificate
                    // above all — as HTTP 200 carrying <root status_code="401">.
                    // Trusting the HTTP code alone turns those into an empty but
                    // apparently successful parse.
                    const status = /<root[^>]*\bstatus_code="(\d+)"/i.exec(xml);
                    if (status && status[1] !== '200') {
                        const why = /status_message="([^"]*)"/i.exec(xml);
                        return finish(reject, new Error(
                            why && why[1] ? why[1] : `Host replied status ${status[1]}`
                        ));
                    }
                    finish(resolve, xml);
                });
            });

            req.setTimeout(timeout, () => {
                req.destroy();
                finish(reject, new Error(`No reply from ${this.address} within ${Math.round(timeout / 1000)}s`));
            });
            req.on('error', (error) => finish(reject, friendlyNetworkError(error, this.address, secure)));
            req.end();
        });
    }

    certMatchesPin(peer) {
        if (!peer || !peer.raw) return false;
        try {
            return peer.raw.equals(MoonlightIdentity.pemToDer(this.serverCert));
        } catch (_) {
            return false;
        }
    }

    // ---------- server info ----------

    /**
     * Ask the host who it is. Tried over HTTPS first because only the mTLS port
     * reports an honest PairStatus; an unpaired client falls back to plain HTTP,
     * which still answers enough to show the host as online.
     */
    async serverInfo() {
        let xml = null;
        let secure = true;
        let adoptedCert = null;

        // Tried even with no certificate on file. If the host authorises our
        // client certificate anyway then pairing already succeeded on its side
        // and only our record of it is missing — which is what happens when the
        // handshake's final confirmation fails after the host has committed.
        // Adopting the certificate it presents is no weaker than the pairing
        // that just proved it, and it saves making the user pair a second time.
        try {
            xml = await this.request('/serverinfo', {}, { secure: true });
            if (!this.serverCert && this.lastPeerCert) adoptedCert = this.lastPeerCert;
        } catch (_) { /* not paired, or pairing was revoked; fall through */ }

        if (xml === null) {
            secure = false;
            xml = await this.request('/serverinfo', {}, { secure: false });
        }

        const paired = tag(xml, 'PairStatus') === '1';
        const currentGame = tag(xml, 'currentgame') || '0';

        return {
            address: this.address,
            hostname: tag(xml, 'hostname') || this.address,
            uniqueId: tag(xml, 'uniqueid') || '',
            mac: tag(xml, 'mac') || '',
            localIp: tag(xml, 'LocalIP') || '',
            appVersion: tag(xml, 'appversion') || '',
            gfeVersion: tag(xml, 'GfeVersion') || '',
            // 0 = nothing running; anything else is the running app's id.
            currentGame: currentGame === '0' ? null : currentGame,
            state: tag(xml, 'state') || '',
            // Bit 0 = H.264, bit 1 = HEVC (main), bit 2 = HEVC Main10 (HDR).
            codecSupport: parseInt(tag(xml, 'ServerCodecModeSupport') || '0', 10),
            maxLumaPixelsHEVC: parseInt(tag(xml, 'MaxLumaPixelsHEVC') || '0', 10),
            displayModes: displayModes(xml),
            paired: secure ? paired : false,
            verified: secure,
            // Set only when this call discovered an existing pairing we had no
            // record of; the caller persists it.
            adoptedCert,
        };
    }

    // ---------- pairing ----------

    /**
     * Run the whole four-phase handshake.
     *
     * @param {string} pin              shown to the user; typed into the host
     * @param {(stage: string) => void} [onStage]  progress for the UI
     * @returns {Promise<{serverCert: string}>}
     */
    async pair(pin, onStage = () => {}) {
        const info = await this.serverInfo();
        if (info.paired) return { serverCert: this.serverCert, already: true };

        // A host that is mid-stream will accept the pairing request and then
        // simply never answer it, so the failure looks like a dead network
        // rather than a busy host. Refuse up front and say why.
        //
        // Keyed on `state` rather than `currentgame`: the state string is what
        // actually tracks whether a session is live, and reading it wrong costs
        // a two-minute timeout to discover.
        if (/BUSY/i.test(info.state || '')) {
            throw new Error(
                'The host is streaming to something else right now. '
                + 'Pairing only works while it is idle — stop that session and try again.'
            );
        }

        const algo = pairing.hashFor(info.appVersion);
        const salt = pairing.randomBytes(pairing.BLOCK);
        const aesKey = pairing.deriveKey(algo, salt, pin);

        // --- 1. exchange certificates ---
        onStage('Sending the pairing request');
        const certXml = await this.request('/pair', {
            devicename: 'roth',
            updateState: 1,
            phrase: 'getservercert',
            salt: salt.toString('hex'),
            clientcert: this.identity.certHex(),
        }, { secure: false, timeout: PAIR_TIMEOUT_MS });

        if (tag(certXml, 'paired') !== '1') {
            throw new Error('The host refused the pairing request.');
        }
        const plainCert = tag(certXml, 'plaincert');
        if (!plainCert) {
            throw new Error('The host did not return its certificate. Another pairing may already be in progress.');
        }
        const serverCert = Buffer.from(plainCert, 'hex').toString('utf8');
        const serverCertSignature = MoonlightIdentity.signatureFromPem(serverCert);

        // --- 2. challenge the host ---
        onStage('Waiting for the PIN');
        const clientChallenge = pairing.randomBytes(pairing.BLOCK);
        const challengeXml = await this.request('/pair', {
            devicename: 'roth',
            updateState: 1,
            clientchallenge: pairing.encrypt(aesKey, clientChallenge).toString('hex'),
        }, { secure: false, timeout: PAIR_TIMEOUT_MS });

        const challengeResponseHex = tag(challengeXml, 'challengeresponse');
        if (tag(challengeXml, 'paired') !== '1' || !challengeResponseHex) {
            await this.unpair().catch(() => {});
            throw new Error('The host rejected the challenge — the PIN was probably wrong.');
        }

        const { serverResponse, serverChallenge } = pairing.splitServerChallengeResponse(
            algo, pairing.decrypt(aesKey, Buffer.from(challengeResponseHex, 'hex'))
        );

        // --- 3. answer the host's challenge ---
        onStage('Answering the host');
        const clientSecret = pairing.randomBytes(pairing.BLOCK);
        const clientCertSignature = this.identity.certSignature();
        const responseHash = pairing.digest(algo, serverChallenge, clientCertSignature, clientSecret);

        const secretXml = await this.request('/pair', {
            devicename: 'roth',
            updateState: 1,
            serverchallengeresp: pairing.encrypt(aesKey, responseHash).toString('hex'),
        }, { secure: false, timeout: PAIR_TIMEOUT_MS });

        const pairingSecretHex = tag(secretXml, 'pairingsecret');
        if (tag(secretXml, 'paired') !== '1' || !pairingSecretHex) {
            await this.unpair().catch(() => {});
            throw new Error('The host rejected our response — the PIN was probably wrong.');
        }

        const { secret: serverSecret, signature: serverSignature } =
            pairing.splitPairingSecret(Buffer.from(pairingSecretHex, 'hex'));

        // The host must prove it owns the certificate it just handed us.
        // Without this check a relay could pair in the middle undetected.
        if (!pairing.verifySignature(algo, serverSecret, serverSignature, serverCert)) {
            await this.unpair().catch(() => {});
            throw new Error('The host failed its signature check — something is intercepting the connection.');
        }

        // And it must have known the PIN, which is what its earlier hash proves.
        const expected = pairing.digest(algo, clientChallenge, serverCertSignature, serverSecret);
        if (!expected.equals(serverResponse)) {
            await this.unpair().catch(() => {});
            throw new Error('Wrong PIN.');
        }

        // --- 4. reveal our secret, signed ---
        onStage('Finishing up');
        const signedSecret = Buffer.concat([
            clientSecret,
            pairing.sign(algo, clientSecret, this.identity.load().key),
        ]);
        const finalXml = await this.request('/pair', {
            devicename: 'roth',
            updateState: 1,
            clientpairingsecret: signedSecret.toString('hex'),
        }, { secure: false, timeout: PAIR_TIMEOUT_MS });

        if (tag(finalXml, 'paired') !== '1') {
            await this.unpair().catch(() => {});
            throw new Error('The host would not complete pairing.');
        }

        // From here the client certificate alone is the credential, so the last
        // step is simply proving it works on the mTLS port.
        this.serverCert = serverCert;
        const confirmXml = await this.request('/pair', { devicename: 'roth', updateState: 1, phrase: 'pairchallenge' },
            { secure: true, timeout: PAIR_TIMEOUT_MS });

        if (tag(confirmXml, 'paired') !== '1') {
            this.serverCert = null;
            await this.unpair().catch(() => {});
            throw new Error('Pairing completed but the secure channel was refused.');
        }

        return { serverCert };
    }

    async unpair() {
        return this.request('/unpair', {}, { secure: false });
    }

    // ---------- apps ----------

    async appList() {
        const xml = await this.request('/applist', {}, { secure: true });
        const apps = [];

        for (const block of xml.match(/<App>[\s\S]*?<\/App>/g) || []) {
            const id = tag(block, 'ID');
            if (!id) continue;
            apps.push({
                id,
                title: tag(block, 'AppTitle') || `App ${id}`,
                hdr: tag(block, 'IsHdrSupported') === '1',
                // GFE could resume a game without restarting it; Sunshine reports 0.
                supportsResume: tag(block, 'IsAppCollectorGame') !== '1',
            });
        }

        apps.sort((a, b) => a.title.localeCompare(b.title));
        return apps;
    }

    /** Box art as a data URL, or null when the host has none for this app. */
    async appAsset(appId) {
        try {
            const png = await this.request('/appasset', {
                appid: appId,
                AssetType: 2,   // box art
                AssetIdx: 0,
            }, { secure: true, binary: true });

            if (!png || png.length < 100) return null;
            return `data:image/png;base64,${png.toString('base64')}`;
        } catch (_) {
            return null;
        }
    }

    // ---------- sessions ----------

    /**
     * Ask the host to start (or resume) an app with the given stream settings.
     *
     * `rikey` is the AES key that will later encrypt input events. It is minted
     * here because the host has to be told it at launch time, and handed back to
     * the caller so a future video pipeline can use the same one.
     */
    async launch(appId, settings, { resume = false } = {}) {
        const rikey = pairing.randomBytes(16);
        const rikeyid = crypto.randomInt(0, 0x7fffffff);

        const params = {
            appid: appId,
            mode: `${settings.width}x${settings.height}x${settings.fps}`,
            additionalStates: 1,
            sops: settings.optimizeGameSettings ? 1 : 0,
            rikey: rikey.toString('hex'),
            rikeyid,
            // 0 keeps audio on this machine; 1 also plays it on the host.
            localAudioPlayMode: settings.playAudioOnHost ? 1 : 0,
            surroundAudioInfo: surroundAudioInfo(settings.audio),
            remoteControllersBitmap: 0,
            gcmap: 0,
            gcpersist: 0,
        };

        const xml = resume
            ? await this.request('/resume', { appid: appId, rikey: params.rikey, rikeyid, surroundAudioInfo: params.surroundAudioInfo }, { secure: true, timeout: 30000 })
            : await this.request('/launch', params, { secure: true, timeout: 30000 });

        const sessionUrl = tag(xml, 'sessionUrl0');
        const gameSession = tag(xml, 'gamesession');
        const resumeToken = tag(xml, 'resume');

        if (!sessionUrl && gameSession !== '1' && resumeToken !== '1') {
            throw new Error(tag(xml, 'status_message') || 'The host would not start the session.');
        }

        return {
            sessionUrl: sessionUrl || null,
            rikey: rikey.toString('hex'),
            rikeyid,
        };
    }

    /** Stop whatever is streaming. Safe to call when nothing is. */
    async cancel() {
        const xml = await this.request('/cancel', {}, { secure: true });
        return tag(xml, 'cancel') === '1';
    }
}

// ---------- XML ----------

/** First value of a leaf tag, CDATA unwrapped. */
function tag(xml, name) {
    const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml || '');
    if (!match) return '';
    return match[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

function displayModes(xml) {
    const modes = [];
    for (const block of xml.match(/<DisplayMode>[\s\S]*?<\/DisplayMode>/g) || []) {
        const width = parseInt(tag(block, 'Width'), 10);
        const height = parseInt(tag(block, 'Height'), 10);
        const fps = parseInt(tag(block, 'RefreshRate'), 10);
        if (width && height && fps) modes.push({ width, height, fps });
    }
    return modes;
}

/**
 * The host wants channel layout packed into one integer:
 * low 8 bits = channel count, next 8 = the channel mask.
 */
function surroundAudioInfo(audio) {
    if (audio === '5.1') return (0x3f << 16) | 6;
    if (audio === '7.1') return (0x63f << 16) | 8;
    return (0x3 << 16) | 2;   // stereo
}

function derToPem(der) {
    const base64 = der.toString('base64').match(/.{1,64}/g) || [];
    return `-----BEGIN CERTIFICATE-----\n${base64.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function friendlyNetworkError(error, address, secure) {
    if (error.code === 'ECONNREFUSED') {
        return new Error(secure
            ? `${address} refused the secure connection — is Sunshine still running?`
            : `${address} refused the connection. Check the host is awake and Sunshine is running.`);
    }
    if (error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') {
        return new Error(`${address} is unreachable from this network.`);
    }
    if (error.code === 'ENOTFOUND') {
        return new Error(`Could not resolve "${address}".`);
    }
    if (error.code === 'ETIMEDOUT') {
        return new Error(`${address} did not respond.`);
    }
    return error;
}

module.exports = NvHttp;
module.exports.tag = tag;
module.exports.HTTP_PORT = HTTP_PORT;
module.exports.HTTPS_PORT = HTTPS_PORT;
