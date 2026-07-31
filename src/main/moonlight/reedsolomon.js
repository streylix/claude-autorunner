/**
 * Reed-Solomon erasure decoding over GF(2^8).
 *
 * This recovers shards the network lost. Both streams carry parity the host
 * already computed — roughly 10% of video packets and a third of audio ones —
 * and without this code all of it is discarded and the loss becomes a dropped
 * frame or a gap in the sound.
 *
 * The parameters have to match the encoder exactly or reconstruction produces
 * plausible-looking rubbish rather than an error:
 *
 *   - the field is GF(2^8) with primitive polynomial 285 (0x11D)
 *   - parity rows form a CAUCHY matrix, not the more common Vandermonde:
 *       P[j][i] = 1 / ((parityCount + i) XOR j)
 *     which is what nanors — the library the reference client uses — builds.
 *
 * Decoding is the textbook erasure procedure: take any `dataShards` surviving
 * shards, assemble the rows of the encode matrix that produced them, invert
 * that square matrix, and multiply it back through the survivors.
 */

// ---------- GF(2^8) ----------

const POLYNOMIAL = 0x11d;
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function buildTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= POLYNOMIAL;
    }
    // Doubled so a log sum never needs a modulo.
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}());

function mul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
}

function div(a, b) {
    if (a === 0) return 0;
    if (b === 0) throw new Error('divide by zero in GF(256)');
    return EXP[LOG[a] + 255 - LOG[b]];
}

function inv(a) {
    if (a === 0) throw new Error('no inverse of zero in GF(256)');
    return EXP[255 - LOG[a]];
}

// ---------- matrices ----------

/**
 * The full encode matrix: `dataShards` identity rows on top, then the Cauchy
 * parity rows. Row r of this matrix times the data vector gives shard r.
 */
function encodeMatrix(dataShards, parityShards) {
    const rows = dataShards + parityShards;
    const m = new Uint8Array(rows * dataShards);

    for (let i = 0; i < dataShards; i++) m[i * dataShards + i] = 1;

    for (let j = 0; j < parityShards; j++) {
        const row = (dataShards + j) * dataShards;
        for (let i = 0; i < dataShards; i++) {
            m[row + i] = inv((parityShards + i) ^ j);
        }
    }
    return m;
}

/** Gauss-Jordan inversion of a square GF(256) matrix, in place on a copy. */
function invertMatrix(src, n) {
    const a = Uint8Array.from(src);
    const out = new Uint8Array(n * n);
    for (let i = 0; i < n; i++) out[i * n + i] = 1;

    for (let col = 0; col < n; col++) {
        // Find a row with a non-zero entry in this column.
        let pivot = col;
        while (pivot < n && a[pivot * n + col] === 0) pivot++;
        if (pivot === n) throw new Error('matrix is singular; cannot recover');

        if (pivot !== col) {
            for (let k = 0; k < n; k++) {
                let t = a[col * n + k]; a[col * n + k] = a[pivot * n + k]; a[pivot * n + k] = t;
                t = out[col * n + k]; out[col * n + k] = out[pivot * n + k]; out[pivot * n + k] = t;
            }
        }

        const scale = inv(a[col * n + col]);
        if (scale !== 1) {
            for (let k = 0; k < n; k++) {
                a[col * n + k] = mul(a[col * n + k], scale);
                out[col * n + k] = mul(out[col * n + k], scale);
            }
        }

        for (let row = 0; row < n; row++) {
            if (row === col) continue;
            const factor = a[row * n + col];
            if (factor === 0) continue;
            for (let k = 0; k < n; k++) {
                a[row * n + k] ^= mul(a[col * n + k], factor);
                out[row * n + k] ^= mul(out[col * n + k], factor);
            }
        }
    }
    return out;
}

/**
 * Rebuild the missing data shards.
 *
 * @param {(Buffer|null)[]} shards  length dataShards+parityShards, null where lost
 * @param {number} dataShards
 * @param {number} parityShards
 * @param {number} shardSize       every shard must be exactly this long
 * @returns {Buffer[]|null}        the data shards, or null if too many were lost
 */
function recover(shards, dataShards, parityShards, shardSize) {
    const total = dataShards + parityShards;

    const present = [];
    for (let i = 0; i < total && present.length < dataShards; i++) {
        if (shards[i] && shards[i].length === shardSize) present.push(i);
    }
    // Fewer survivors than data shards is unrecoverable by definition.
    if (present.length < dataShards) return null;

    // Nothing missing among the data shards: no work to do.
    let complete = true;
    for (let i = 0; i < dataShards; i++) {
        if (!shards[i] || shards[i].length !== shardSize) { complete = false; break; }
    }
    if (complete) return shards.slice(0, dataShards);

    const encode = encodeMatrix(dataShards, parityShards);

    // The rows that actually produced the shards we still have.
    const sub = new Uint8Array(dataShards * dataShards);
    for (let r = 0; r < dataShards; r++) {
        const src = present[r] * dataShards;
        sub.set(encode.subarray(src, src + dataShards), r * dataShards);
    }

    const inverse = invertMatrix(sub, dataShards);

    const out = new Array(dataShards);
    for (let i = 0; i < dataShards; i++) {
        if (shards[i] && shards[i].length === shardSize) {
            out[i] = shards[i];
            continue;
        }
        const rebuilt = Buffer.alloc(shardSize);
        for (let r = 0; r < dataShards; r++) {
            const coefficient = inverse[i * dataShards + r];
            if (coefficient === 0) continue;
            const shard = shards[present[r]];
            for (let b = 0; b < shardSize; b++) {
                rebuilt[b] ^= mul(shard[b], coefficient);
            }
        }
        out[i] = rebuilt;
    }
    return out;
}

module.exports = { recover, encodeMatrix, invertMatrix, mul, div, inv, EXP, LOG };
