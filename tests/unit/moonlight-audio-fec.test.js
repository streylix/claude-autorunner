/**
 * Audio FEC block test.
 *
 * Feeds synthetic RTP the way the host sends it — four data packets then two
 * parity — drops packets, and checks the Opus payloads come back in order and
 * intact. Block indexing is implicit (derived from the sequence number), so an
 * off-by-one here would silently reorder audio rather than fail.
 *
 * Run: node tests/unit/moonlight-audio-fec.test.js
 */
const crypto = require('crypto');
const AudioDepacketizer = require('../../src/main/moonlight/audio');
const rs = require('../../src/main/moonlight/reedsolomon');

const SHARD = 64;
let failures = 0;
const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`);
    else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

function dataPacket(sequence, payload) {
    const p = Buffer.alloc(12 + payload.length);
    p.writeUInt8(0x80, 0);
    p.writeUInt8(97, 1);              // payload type: audio
    p.writeUInt16BE(sequence, 2);
    payload.copy(p, 12);
    return p;
}

function parityPacket(base, shardIndex, payload) {
    const p = Buffer.alloc(12 + 12 + payload.length);
    p.writeUInt8(0x80, 0);
    p.writeUInt8(127, 1);             // payload type: FEC
    p.writeUInt16BE(1000 + shardIndex, 2);
    p.writeUInt8(shardIndex, 12);     // fecShardIndex
    p.writeUInt8(97, 13);             // payloadType
    p.writeUInt16BE(base, 14);        // baseSequenceNumber
    payload.copy(p, 24);
    return p;
}

/** Build one block: 4 random Opus-ish payloads plus their parity. */
function buildBlock(base) {
    const data = Array.from({ length: 4 }, () => crypto.randomBytes(SHARD));
    const matrix = rs.encodeMatrix(4, 2);
    const parity = [];
    for (let j = 0; j < 2; j++) {
        const out = Buffer.alloc(SHARD);
        const row = (4 + j) * 4;
        for (let i = 0; i < 4; i++) {
            const c = matrix[row + i];
            if (c === 0) continue;
            for (let b = 0; b < SHARD; b++) out[b] ^= rs.mul(data[i][b], c);
        }
        parity.push(out);
    }
    return { data, parity };
}

function run(label, drop, expectAllRecovered) {
    const q = new AudioDepacketizer();
    const got = [];
    let gaps = 0;
    q.on('frame', (f) => got.push(f));
    q.on('missing', () => gaps++);

    const expected = [];
    // Several blocks so the head-of-line release logic actually advances.
    for (let b = 0; b < 6; b++) {
        const base = b * 4;
        const { data, parity } = buildBlock(base);
        data.forEach((d) => expected.push(d));

        for (let i = 0; i < 4; i++) {
            if (drop(b, i, false)) continue;
            q.push(dataPacket(base + i, data[i]));
        }
        for (let j = 0; j < 2; j++) {
            if (drop(b, j, true)) continue;
            q.push(parityPacket(base, j, parity[j]));
        }
    }
    // Push enough further blocks to flush the pipeline.
    for (let b = 6; b < 10; b++) {
        const base = b * 4;
        const { data } = buildBlock(base);
        for (let i = 0; i < 4; i++) q.push(dataPacket(base + i, data[i]));
    }

    const firstSix = got.slice(0, 24);
    const intact = firstSix.length === 24 && firstSix.every((f, i) => f.equals(expected[i]));
    if (expectAllRecovered) {
        check(label, intact && gaps === 0, `gaps=${gaps} frames=${firstSix.length}`);
    } else {
        check(label, gaps > 0, 'expected gaps but saw none');
    }
}

console.log('audio FEC blocks');
run('no loss', () => false, true);
run('one data packet lost per block', (b, i, isParity) => !isParity && i === 1, true);
run('two data packets lost per block', (b, i, isParity) => !isParity && (i === 0 || i === 3), true);
run('one data + one parity lost', (b, i, isParity) => (isParity ? i === 0 : i === 2), true);
run('parity only lost (data intact)', (b, i, isParity) => isParity, true);
run('three data lost — beyond repair', (b, i, isParity) => !isParity && i < 3, false);

console.log('ordering');
(() => {
    const q = new AudioDepacketizer();
    const got = [];
    q.on('frame', (f) => got.push(f[0]));
    // Deliver a block's packets in reverse; output must still be in order.
    const { data, parity } = buildBlock(0);
    data.forEach((d, i) => { d[0] = i; });
    [3, 1, 2, 0].forEach((i) => q.push(dataPacket(i, data[i])));
    q.push(parityPacket(0, 0, parity[0]));
    check('reordered arrivals are emitted in sequence', got.join(',') === '0,1,2,3', got.join(','));
})();

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
