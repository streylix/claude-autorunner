/**
 * The GameStream pairing handshake.
 *
 * Pairing proves two things at once: that the human typing the PIN is at both
 * machines, and that nobody is sitting in the middle. The shared AES key is
 * derived from the PIN, so only a client that knows the PIN can produce a
 * readable challenge; and each side signs a secret with its certificate key, so
 * a relay that merely forwards blobs cannot complete the exchange.
 *
 * The four HTTP round trips are driven by nvhttp.js. This module owns only the
 * arithmetic, in the order it happens:
 *
 *   1. getservercert       we send salt + our cert, we get the host's cert
 *   2. clientchallenge     we send a random challenge, encrypted under the PIN
 *   3. serverchallengeresp we prove we decrypted the host's challenge
 *   4. clientpairingsecret we reveal our secret, signed with our key
 *
 * Two details that are easy to get wrong and produce a silent "wrong PIN":
 *
 *   - AES is ECB with NO padding, applied blockwise. Inputs are zero-extended
 *     to a multiple of 16 rather than PKCS#7-padded.
 *   - The hash is SHA-256 on any modern host, but GFE before version 7 used
 *     SHA-1, and the digest length changes where the server's challenge starts
 *     inside the decrypted blob. `hashFor()` picks from the reported version.
 */
const crypto = require('crypto');

const BLOCK = 16;

/** GFE >= 7 (and every Sunshine build) negotiates SHA-256. */
function hashFor(appVersion) {
    const major = parseInt(String(appVersion || '').split('.')[0], 10);
    return Number.isFinite(major) && major < 7
        ? { name: 'sha1', length: 20, signature: 'RSA-SHA1' }
        : { name: 'sha256', length: 32, signature: 'RSA-SHA256' };
}

function digest(algo, ...parts) {
    const h = crypto.createHash(algo.name);
    for (const part of parts) h.update(part);
    return h.digest();
}

/** AES-128 key = the leading 16 bytes of hash(salt || pin). */
function deriveKey(algo, salt, pin) {
    return digest(algo, salt, Buffer.from(String(pin), 'utf8')).subarray(0, BLOCK);
}

/** Zero-extend to a whole number of AES blocks — not PKCS#7. */
function padBlocks(buf) {
    const remainder = buf.length % BLOCK;
    if (remainder === 0) return buf;
    return Buffer.concat([buf, Buffer.alloc(BLOCK - remainder)]);
}

function encrypt(key, plaintext) {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padBlocks(plaintext)), cipher.final()]);
}

function decrypt(key, ciphertext) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(padBlocks(ciphertext)), decipher.final()]);
}

/**
 * Split the host's reply to our challenge.
 * Layout: hash(...) of length `algo.length`, then the host's own 16-byte challenge.
 */
function splitServerChallengeResponse(algo, decrypted) {
    return {
        serverResponse: decrypted.subarray(0, algo.length),
        serverChallenge: decrypted.subarray(algo.length, algo.length + BLOCK),
    };
}

/** Split /pair's pairingsecret: 16 bytes of secret, then its signature. */
function splitPairingSecret(secretResponse) {
    return {
        secret: secretResponse.subarray(0, BLOCK),
        signature: secretResponse.subarray(BLOCK),
    };
}

function verifySignature(algo, data, signature, certPem) {
    try {
        const verifier = crypto.createVerify(algo.signature);
        verifier.update(data);
        return verifier.verify(certPem, signature);
    } catch (_) {
        return false;
    }
}

function sign(algo, data, keyPem) {
    const signer = crypto.createSign(algo.signature);
    signer.update(data);
    return signer.sign(keyPem);
}

/** A PIN the user reads off this screen and types into the host. */
function randomPin() {
    return String(crypto.randomInt(0, 10000)).padStart(4, '0');
}

module.exports = {
    BLOCK,
    hashFor,
    digest,
    deriveKey,
    encrypt,
    decrypt,
    splitServerChallengeResponse,
    splitPairingSecret,
    verifySignature,
    sign,
    randomPin,
    randomBytes: (n) => crypto.randomBytes(n),
};
