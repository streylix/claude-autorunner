/**
 * Pairing handshake test — runs the real NvHttp client against a fake host that
 * implements the server half of the GameStream protocol from the spec.
 *
 * The point is that a pairing bug does not look like a bug: a wrong hash order,
 * a digest length off by twelve bytes, or PKCS#7 padding where the protocol
 * wants zero-extension all surface identically as "wrong PIN". Testing against
 * an independent implementation of the other side catches exactly those.
 *
 * Run: node tests/unit/moonlight-pairing.test.js
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const NvHttp = require('../../src/main/moonlight/nvhttp');
const MoonlightIdentity = require('../../src/main/moonlight/identity');
const pairing = require('../../src/main/moonlight/pairing');

const HOST_PIN = '4213';
const APP_VERSION = '7.1.431.0';

let failures = 0;
function check(label, condition, detail = '') {
    if (condition) {
        console.log(`  ok   ${label}`);
    } else {
        failures++;
        console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

// ---------- a throwaway certificate for the fake host ----------

function makeCert(dir, name) {
    fs.mkdirSync(dir, { recursive: true });
    const certPath = path.join(dir, `${name}.pem`);
    const keyPath = path.join(dir, `${name}.key`);
    if (!fs.existsSync(certPath)) {
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048',
            '-keyout', keyPath, '-out', certPath,
            '-days', '30', '-nodes', '-sha256',
            '-subj', `/CN=${name}`,
        ], { stdio: 'pipe' });
    }
    return { cert: fs.readFileSync(certPath, 'utf8'), key: fs.readFileSync(keyPath, 'utf8') };
}

// ---------- the fake host ----------

/**
 * Implements /serverinfo and the four /pair phases the way Sunshine does,
 * written from the protocol rather than from the client's own helpers where it
 * matters — the hashes and the AES calls are done inline here so the test is
 * not merely checking the client against itself.
 */
function createFakeHost(serverIdentity, pin) {
    const algo = { name: 'sha256', length: 32, signature: 'RSA-SHA256' };
    const state = { paired: false, session: null };

    const serverCertSignature = MoonlightIdentity.signatureFromPem(serverIdentity.cert);

    const aes = (key, buf, mode) => {
        const c = mode === 'encrypt'
            ? crypto.createCipheriv('aes-128-ecb', key, null)
            : crypto.createDecipheriv('aes-128-ecb', key, null);
        c.setAutoPadding(false);
        const padded = buf.length % 16 === 0 ? buf : Buffer.concat([buf, Buffer.alloc(16 - (buf.length % 16))]);
        return Buffer.concat([c.update(padded), c.final()]);
    };
    const sha = (...parts) => {
        const h = crypto.createHash('sha256');
        parts.forEach((p) => h.update(p));
        return h.digest();
    };

    const wrap = (inner) => `<?xml version="1.0"?><root status_code="200">${inner}</root>`;

    const handle = (url) => {
        const query = new URL(url, 'http://x').searchParams;

        if (url.startsWith('/serverinfo')) {
            return wrap(`
                <hostname>FAKE-RIG</hostname>
                <appversion>${APP_VERSION}</appversion>
                <GfeVersion>3.23.0.74</GfeVersion>
                <uniqueid>fakehost0000</uniqueid>
                <LocalIP>127.0.0.1</LocalIP>
                <PairStatus>${state.paired ? 1 : 0}</PairStatus>
                <currentgame>0</currentgame>
                <state>SUNSHINE_SERVER_FREE</state>
                <ServerCodecModeSupport>259</ServerCodecModeSupport>
                <SupportedDisplayMode>
                    <DisplayMode><Width>1920</Width><Height>1080</Height><RefreshRate>60</RefreshRate></DisplayMode>
                    <DisplayMode><Width>2560</Width><Height>1440</Height><RefreshRate>120</RefreshRate></DisplayMode>
                </SupportedDisplayMode>`);
        }

        if (url.startsWith('/applist')) {
            return wrap(`
                <App><AppTitle>Desktop</AppTitle><ID>1</ID><IsHdrSupported>0</IsHdrSupported></App>
                <App><AppTitle>Steam Big Picture</AppTitle><ID>2</ID><IsHdrSupported>1</IsHdrSupported></App>`);
        }

        if (url.startsWith('/launch')) {
            state.session = { mode: query.get('mode'), rikeyid: query.get('rikeyid') };
            return wrap('<gamesession>1</gamesession><sessionUrl0>rtsp://127.0.0.1:48010</sessionUrl0>');
        }

        if (url.startsWith('/pair')) {
            // phase 1 — certificate exchange
            if (query.get('phrase') === 'getservercert') {
                const salt = Buffer.from(query.get('salt'), 'hex');
                state.aesKey = sha(salt, Buffer.from(pin, 'utf8')).subarray(0, 16);
                state.clientCert = Buffer.from(query.get('clientcert'), 'hex').toString('utf8');
                return wrap(`<paired>1</paired><plaincert>${Buffer.from(serverIdentity.cert, 'utf8').toString('hex')}</plaincert>`);
            }

            // phase 5 — prove the mTLS channel works
            if (query.get('phrase') === 'pairchallenge') {
                return wrap(`<paired>${state.paired ? 1 : 0}</paired>`);
            }

            // phase 2 — answer the client's challenge, pose our own
            if (query.get('clientchallenge')) {
                const clientChallenge = aes(state.aesKey, Buffer.from(query.get('clientchallenge'), 'hex'), 'decrypt').subarray(0, 16);
                state.serverSecret = crypto.randomBytes(16);
                state.serverChallenge = crypto.randomBytes(16);
                const serverResponse = sha(clientChallenge, serverCertSignature, state.serverSecret);
                const blob = aes(state.aesKey, Buffer.concat([serverResponse, state.serverChallenge]), 'encrypt');
                return wrap(`<paired>1</paired><challengeresponse>${blob.toString('hex')}</challengeresponse>`);
            }

            // phase 3 — take the client's hash, hand back our signed secret
            if (query.get('serverchallengeresp')) {
                state.clientHash = aes(state.aesKey, Buffer.from(query.get('serverchallengeresp'), 'hex'), 'decrypt').subarray(0, algo.length);
                const signer = crypto.createSign('RSA-SHA256');
                signer.update(state.serverSecret);
                const signature = signer.sign(serverIdentity.key);
                const secret = Buffer.concat([state.serverSecret, signature]);
                return wrap(`<paired>1</paired><pairingsecret>${secret.toString('hex')}</pairingsecret>`);
            }

            // phase 4 — verify the client really knew the PIN
            if (query.get('clientpairingsecret')) {
                const blob = Buffer.from(query.get('clientpairingsecret'), 'hex');
                const clientSecret = blob.subarray(0, 16);
                const signature = blob.subarray(16);

                const clientCertSignature = MoonlightIdentity.signatureFromPem(state.clientCert);
                const expected = sha(state.serverChallenge, clientCertSignature, clientSecret);

                const verifier = crypto.createVerify('RSA-SHA256');
                verifier.update(clientSecret);
                const signatureOk = verifier.verify(state.clientCert, signature);

                state.paired = expected.equals(state.clientHash) && signatureOk;
                return wrap(`<paired>${state.paired ? 1 : 0}</paired>`);
            }

            if (query.get('phrase') === 'unpair' || url.includes('/unpair')) {
                state.paired = false;
                return wrap('<paired>0</paired>');
            }
        }

        if (url.startsWith('/unpair')) {
            state.paired = false;
            return wrap('<paired>0</paired>');
        }

        return wrap('<status_message>Not Found</status_message>');
    };

    const listener = (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(handle(req.url));
    };

    const plain = http.createServer(listener);
    const secure = https.createServer({
        cert: serverIdentity.cert,
        key: serverIdentity.key,
        requestCert: true,
        rejectUnauthorized: false,
    }, listener);

    return {
        state,
        listen: () => Promise.all([
            new Promise((r) => plain.listen(NvHttp.HTTP_PORT, '127.0.0.1', r)),
            new Promise((r) => secure.listen(NvHttp.HTTPS_PORT, '127.0.0.1', r)),
        ]),
        close: () => { plain.close(); secure.close(); },
    };
}

// ---------- the run ----------

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moonlight-test-'));
    const serverIdentity = makeCert(path.join(tmp, 'host'), 'host');
    const identity = new MoonlightIdentity(path.join(tmp, 'client'));
    identity.load();

    const host = createFakeHost(serverIdentity, HOST_PIN);
    await host.listen();

    try {
        console.log('serverinfo');
        const client = new NvHttp('127.0.0.1', identity);
        const info = await client.serverInfo();
        check('reports the hostname', info.hostname === 'FAKE-RIG', info.hostname);
        check('starts unpaired', info.paired === false);
        check('parses codec support', info.codecSupport === 259, String(info.codecSupport));
        check('parses display modes', info.displayModes.length === 2 && info.displayModes[1].fps === 120);

        console.log('pairing with the right PIN');
        const stages = [];
        const result = await client.pair(HOST_PIN, (s) => stages.push(s));
        check('handshake completes', host.state.paired === true);
        check('returns the host certificate', !!result.serverCert && result.serverCert.includes('BEGIN CERTIFICATE'));
        check('reports progress stages', stages.length >= 3, stages.join(' / '));

        console.log('authenticated calls');
        const paired = new NvHttp('127.0.0.1', identity, { serverCert: result.serverCert });
        const apps = await paired.appList();
        check('lists apps', apps.length === 2, JSON.stringify(apps.map((a) => a.title)));
        check('sorts apps by title', apps[0].title === 'Desktop');
        check('reads the HDR flag', apps[1].hdr === true);

        const info2 = await paired.serverInfo();
        check('now reports paired over mTLS', info2.paired === true && info2.verified === true);

        console.log('launch');
        const session = await paired.launch('2', {
            width: 2560, height: 1440, fps: 120, audio: '5.1',
            optimizeGameSettings: false, playAudioOnHost: false,
        });
        check('sends the requested mode', host.state.session.mode === '2560x1440x120', host.state.session.mode);
        check('returns a session url', session.sessionUrl === 'rtsp://127.0.0.1:48010');
        check('mints an input key', /^[0-9a-f]{32}$/.test(session.rikey));

        console.log('certificate pinning');
        const impostor = makeCert(path.join(tmp, 'impostor'), 'impostor');
        const pinned = new NvHttp('127.0.0.1', identity, { serverCert: impostor.cert });
        let rejected = false;
        try {
            await pinned.appList();
        } catch (error) {
            rejected = /different certificate/.test(error.message);
        }
        check('rejects a host whose certificate changed', rejected);

        console.log('pairing with the wrong PIN');
        host.state.paired = false;
        const wrong = new NvHttp('127.0.0.1', identity);
        let wrongPinError = null;
        try {
            await wrong.pair('0000');
        } catch (error) {
            wrongPinError = error.message;
        }
        check('is refused', !!wrongPinError, wrongPinError || 'no error thrown');
        check('does not leave the host paired', host.state.paired === false);
    } finally {
        host.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
    console.error('test crashed:', error);
    process.exit(1);
});
