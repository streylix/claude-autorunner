/**
 * MoonlightIdentity - the client certificate this machine pairs with.
 *
 * GameStream/Sunshine authentication is mutual TLS: after pairing, every
 * request on :47984 presents a client certificate, and the host recognises the
 * machine by that certificate alone. So the cert IS the pairing — regenerate it
 * and every host forgets you and has to be paired again. It is therefore
 * generated once and persisted, never rebuilt on a whim.
 *
 * Generation shells out to `openssl` rather than pulling in node-forge. Node's
 * own crypto can make an RSA keypair but cannot wrap one in an X.509
 * certificate, and openssl is already present on macOS and Linux; on Windows
 * it rides along with Git. A missing openssl is reported as a plain error
 * rather than a crash, because everything else in the games panel still works.
 *
 * The pairing handshake needs one thing that is not in the PEM: the
 * certificate's own signature bytes, which both sides fold into their challenge
 * hashes. That means a small DER walk — see `certSignature()`.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Moonlight clients all present this subject. Sunshine does not care what it
// says, but GFE was historically fussier, so keep the well-trodden value.
const SUBJECT = '/C=US/ST=CA/L=Los Angeles/O=NVIDIA/OU=NVIDIA/CN=NVIDIA GameStream Client';
const KEY_BITS = 2048;
const DAYS = 3650;

class MoonlightIdentity {
    /** @param {string} dir  directory to persist the identity in (userData/moonlight) */
    constructor(dir) {
        this.dir = dir;
        this.certPath = path.join(dir, 'client.pem');
        this.keyPath = path.join(dir, 'client.key');
        this.idPath = path.join(dir, 'uniqueid');
        this.cert = null;
        this.key = null;
        this.uniqueId = null;
    }

    /**
     * Load the identity, creating it on first run. Safe to call repeatedly.
     * @returns {{cert: string, key: string, uniqueId: string}}
     */
    load() {
        if (this.cert && this.key && this.uniqueId) return this.snapshot();

        fs.mkdirSync(this.dir, { recursive: true });

        if (!fs.existsSync(this.certPath) || !fs.existsSync(this.keyPath)) {
            this.generate();
        }

        this.cert = fs.readFileSync(this.certPath, 'utf8');
        this.key = fs.readFileSync(this.keyPath, 'utf8');

        // The unique id is a 16-hex-digit device handle echoed on every request.
        // It is not a secret and not an identity — the certificate is — but the
        // host keys some state off it, so it has to be stable too.
        if (fs.existsSync(this.idPath)) {
            this.uniqueId = fs.readFileSync(this.idPath, 'utf8').trim();
        }
        if (!this.uniqueId || !/^[0-9a-f]{16}$/i.test(this.uniqueId)) {
            this.uniqueId = crypto.randomBytes(8).toString('hex');
            fs.writeFileSync(this.idPath, this.uniqueId, 'utf8');
        }

        return this.snapshot();
    }

    snapshot() {
        return { cert: this.cert, key: this.key, uniqueId: this.uniqueId };
    }

    generate() {
        try {
            execFileSync('openssl', [
                'req', '-x509',
                '-newkey', `rsa:${KEY_BITS}`,
                '-keyout', this.keyPath,
                '-out', this.certPath,
                '-days', String(DAYS),
                '-nodes',            // no passphrase: the app must load it unattended
                '-sha256',
                '-subj', SUBJECT,
            ], { stdio: 'pipe' });
        } catch (error) {
            const detail = (error.stderr && error.stderr.toString().trim()) || error.message;
            throw new Error(`Could not create the Moonlight client certificate (openssl): ${detail}`);
        }

        // The private key is the whole of this machine's pairing. Keep it to the
        // owner even if the umask is loose.
        try { fs.chmodSync(this.keyPath, 0o600); } catch (_) { /* best effort */ }
    }

    /** PEM stripped to a single hex blob, which is how /pair wants the cert. */
    certHex() {
        this.load();
        return Buffer.from(this.cert, 'utf8').toString('hex');
    }

    /**
     * The certificate's signatureValue.
     *
     * Both sides hash this into their pairing challenges, so it has to be the
     * exact bytes — hence a DER walk rather than anything textual. An X.509
     * certificate is:
     *
     *   SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue BIT STRING }
     *
     * so the signature is simply the third element of the outer sequence.
     */
    certSignature() {
        this.load();
        return MoonlightIdentity.signatureFromPem(this.cert);
    }

    static signatureFromPem(pem) {
        const der = pemToDer(pem);
        const outer = readTlv(der, 0);
        if (outer.tag !== 0x30) throw new Error('certificate is not a DER SEQUENCE');

        let offset = outer.contentStart;
        const tbs = readTlv(der, offset);              // tbsCertificate
        offset = tbs.contentStart + tbs.length;
        const algo = readTlv(der, offset);             // signatureAlgorithm
        offset = algo.contentStart + algo.length;
        const sig = readTlv(der, offset);              // signatureValue
        if (sig.tag !== 0x03) throw new Error('certificate signature is not a BIT STRING');

        // A BIT STRING leads with a count of unused trailing bits; for a
        // signature that is always zero, and never part of the hash input.
        return der.subarray(sig.contentStart + 1, sig.contentStart + sig.length);
    }
}

function pemToDer(pem) {
    const body = String(pem)
        .replace(/-----BEGIN [^-]+-----/g, '')
        .replace(/-----END [^-]+-----/g, '')
        .replace(/\s+/g, '');
    return Buffer.from(body, 'base64');
}

/** Minimal DER tag/length reader — enough to walk a certificate's top level. */
function readTlv(buf, offset) {
    const tag = buf[offset];
    let cursor = offset + 1;
    let length = buf[cursor++];

    if (length & 0x80) {
        const count = length & 0x7f;
        if (count === 0 || count > 4) throw new Error('unsupported DER length');
        length = 0;
        for (let i = 0; i < count; i++) length = (length << 8) | buf[cursor++];
    }

    return { tag, length, contentStart: cursor };
}

module.exports = MoonlightIdentity;
module.exports.pemToDer = pemToDer;
