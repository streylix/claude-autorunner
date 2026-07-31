/**
 * Reed-Solomon recovery test.
 *
 * Encodes with the same Cauchy construction the host uses, erases shards, and
 * checks the originals come back byte-for-byte. Recovery that is subtly wrong
 * does not throw — it returns confident garbage — so the assertions compare
 * full buffers rather than lengths or checksums.
 *
 * Run: node tests/unit/moonlight-reedsolomon.test.js
 */
const crypto = require('crypto');
const rs = require('../../src/main/moonlight/reedsolomon');

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}

/** Encode data shards into parity using the same matrix as the decoder. */
function encode(data, dataShards, parityShards, size) {
    const matrix = rs.encodeMatrix(dataShards, parityShards);
    const parity = [];
    for (let j = 0; j < parityShards; j++) {
        const out = Buffer.alloc(size);
        const row = (dataShards + j) * dataShards;
        for (let i = 0; i < dataShards; i++) {
            const c = matrix[row + i];
            if (c === 0) continue;
            for (let b = 0; b < size; b++) out[b] ^= rs.mul(data[i][b], c);
        }
        parity.push(out);
    }
    return parity;
}

function scenario(label, dataShards, parityShards, size, lose) {
    const data = Array.from({ length: dataShards }, () => crypto.randomBytes(size));
    const parity = encode(data, dataShards, parityShards, size);
    const shards = [...data, ...parity];

    for (const idx of lose) shards[idx] = null;

    const out = rs.recover(shards, dataShards, parityShards, size);
    if (!out) return check(label, false, 'recover() returned null');

    const same = data.every((d, i) => d.equals(out[i]));
    check(label, same, same ? '' : 'recovered bytes differ from the original');
}

console.log('field');
check('inv(x) * x === 1 across the field', (() => {
    for (let x = 1; x < 256; x++) if (rs.mul(x, rs.inv(x)) !== 1) return false;
    return true;
})());
check('mul is commutative', rs.mul(0x57, 0x83) === rs.mul(0x83, 0x57));
check('mul by zero is zero', rs.mul(0, 0xff) === 0 && rs.mul(0xff, 0) === 0);

console.log('matrix');
check('identity block on top', (() => {
    const m = rs.encodeMatrix(4, 2);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        if (m[i * 4 + j] !== (i === j ? 1 : 0)) return false;
    }
    return true;
})());
check('inverting the identity gives the identity', (() => {
    const id = new Uint8Array(16);
    for (let i = 0; i < 4; i++) id[i * 4 + i] = 1;
    const back = rs.invertMatrix(id, 4);
    return id.every((v, i) => v === back[i]);
})());

console.log('audio shape (4 data + 2 parity)');
scenario('no loss', 4, 2, 256, []);
scenario('one data shard lost', 4, 2, 256, [1]);
scenario('two data shards lost', 4, 2, 256, [0, 3]);
scenario('one data + one parity lost', 4, 2, 256, [2, 4]);
scenario('both parity lost (data intact)', 4, 2, 256, [4, 5]);

console.log('video shape (26 data + 3 parity, 1KB shards)');
scenario('single loss', 26, 3, 1024, [7]);
scenario('three losses', 26, 3, 1024, [0, 13, 25]);
scenario('loss spanning data and parity', 26, 3, 1024, [4, 26, 27]);

console.log('unrecoverable');
(() => {
    const size = 128;
    const data = Array.from({ length: 4 }, () => crypto.randomBytes(size));
    const shards = [...data, ...encode(data, 4, 2, size)];
    shards[0] = null; shards[1] = null; shards[2] = null;   // 3 lost, only 2 parity
    check('returns null when too much is lost', rs.recover(shards, 4, 2, size) === null);
})();

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
