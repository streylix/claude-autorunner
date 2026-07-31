/**
 * Audio depacketizer — Opus frames out of the RTP stream on 48000.
 *
 * Unlike video, one RTP packet is one whole Opus frame, so there is no
 * reassembly. What there is instead is a fixed FEC block: every four data
 * packets are followed by two parity packets, so a third of the traffic on this
 * port exists purely to repair losses. Throwing it away means every lost packet
 * becomes an audible gap, and audio is far less forgiving of those than video is
 * of a dropped frame.
 *
 * Blocks are implied rather than announced. A data packet belongs to the block
 * beginning at `floor(seq / 4) * 4` and sits at `seq - base` within it; a parity
 * packet carries a 12-byte header naming its block and its own shard index.
 *
 * Ordering matters twice over. Opus is stateful, so decoding frame N+1 before N
 * leaves the decoder's history wrong and the sound grainy — and a block cannot
 * be repaired until enough of it has arrived. Both are handled by holding
 * blocks briefly and releasing them in order.
 *
 * Audio is only encrypted when SS_ENC_AUDIO is negotiated, which this client
 * does not request, so payloads here are raw Opus.
 */
const { EventEmitter } = require('events');
const rs = require('./reedsolomon');

const RTP_HEADER_SIZE = 12;
const FEC_HEADER_SIZE = 12;
const PAYLOAD_TYPE_AUDIO = 97;
const PAYLOAD_TYPE_FEC = 127;

const DATA_SHARDS = 4;
const PARITY_SHARDS = 2;
const TOTAL_SHARDS = DATA_SHARDS + PARITY_SHARDS;

// How many blocks may be outstanding before the oldest is released or written
// off. Two is enough for ordinary reordering at 5ms per packet and keeps the
// added latency far below anything audible.
const MAX_PENDING_BLOCKS = 3;

// A gap wider than this is treated as a discontinuity to skip past rather than
// a run of individually lost blocks to report.
const RESYNC_GAP_BLOCKS = 4;

class AudioDepacketizer extends EventEmitter {
    constructor() {
        super();
        this.blocks = new Map();
        this.nextBase = null;
        this.stats = { packets: 0, parity: 0, frames: 0, dropped: 0, recovered: 0 };
    }

    push(msg) {
        this.stats.packets++;
        if (msg.length <= RTP_HEADER_SIZE) return;

        // The top bit of byte 1 is the marker flag, not part of the type.
        const payloadType = msg.readUInt8(1) & 0x7f;

        if (payloadType === PAYLOAD_TYPE_AUDIO) {
            const sequence = msg.readUInt16BE(2);
            const base = Math.floor(sequence / DATA_SHARDS) * DATA_SHARDS;
            const index = sequence - base;
            this.store(base, index, msg.subarray(RTP_HEADER_SIZE));
            return;
        }

        if (payloadType !== PAYLOAD_TYPE_FEC) return;
        if (msg.length <= RTP_HEADER_SIZE + FEC_HEADER_SIZE) return;

        this.stats.parity++;
        const shardIndex = msg.readUInt8(RTP_HEADER_SIZE);
        const base = msg.readUInt16BE(RTP_HEADER_SIZE + 2);
        if (shardIndex >= PARITY_SHARDS) return;
        this.store(base, DATA_SHARDS + shardIndex, msg.subarray(RTP_HEADER_SIZE + FEC_HEADER_SIZE));
    }

    store(base, index, payload) {
        if (this.nextBase === null) this.nextBase = base;
        // Already released; a duplicate or a very late arrival.
        if (before16(base, this.nextBase)) return;

        let block = this.blocks.get(base);
        if (!block) {
            block = { shards: new Map(), size: 0 };
            this.blocks.set(base, block);
        }
        block.shards.set(index, Buffer.from(payload));
        // Every shard in a block is the same length — Sunshine encodes Opus at a
        // constant bitrate precisely so this holds.
        if (payload.length > block.size) block.size = payload.length;

        this.drain();
    }

    /** Release whole blocks in order, repairing them where necessary. */
    drain() {
        for (;;) {
            const block = this.blocks.get(this.nextBase);

            if (block && this.release(block, this.nextBase)) {
                this.blocks.delete(this.nextBase);
                this.nextBase = (this.nextBase + DATA_SHARDS) & 0xffff;
                continue;
            }

            // Head block is not ready. Wait — unless the backlog says its
            // missing pieces are never coming.
            if (this.blocks.size <= MAX_PENDING_BLOCKS) return;

            if (block) {
                this.emitPartial(block);
                this.blocks.delete(this.nextBase);
                this.nextBase = (this.nextBase + DATA_SHARDS) & 0xffff;
                continue;
            }

            // Nothing of this block arrived. After a real discontinuity —
            // a burst loss, or the host restarting its numbering — stepping one
            // block at a time would walk the whole gap, reporting hundreds of
            // losses for a stretch of audio that was never coming and drowning
            // the decoder in concealment. Jump straight to what we actually have.
            const oldest = this.oldestBase();
            if (oldest === null) return;

            const gap = (oldest - this.nextBase) & 0xffff;
            if (gap > RESYNC_GAP_BLOCKS * DATA_SHARDS) {
                this.stats.dropped++;
                this.emit('missing');
                this.nextBase = oldest;
                continue;
            }

            for (let i = 0; i < DATA_SHARDS; i++) {
                this.stats.dropped++;
                this.emit('missing');
            }
            this.nextBase = (this.nextBase + DATA_SHARDS) & 0xffff;
        }
    }

    /**
     * Emit a block if it is complete or can be made so.
     * @returns {boolean} whether the block was released
     */
    release(block, base) {
        let haveData = 0;
        for (let i = 0; i < DATA_SHARDS; i++) if (block.shards.get(i)) haveData++;

        if (haveData < DATA_SHARDS) {
            // Repair needs any four shards, parity included.
            if (block.shards.size < DATA_SHARDS || !block.size) return false;
            if (!this.repair(block)) return false;
        }

        for (let i = 0; i < DATA_SHARDS; i++) {
            this.stats.frames++;
            this.emit('frame', block.shards.get(i));
        }
        return true;
    }

    repair(block) {
        const shards = new Array(TOTAL_SHARDS).fill(null);
        for (const [index, shard] of block.shards) {
            if (index >= TOTAL_SHARDS) continue;
            shards[index] = shard.length === block.size
                ? shard
                : Buffer.concat([shard, Buffer.alloc(block.size - shard.length)]);
        }

        let recovered;
        try {
            recovered = rs.recover(shards, DATA_SHARDS, PARITY_SHARDS, block.size);
        } catch (_) {
            return false;
        }
        if (!recovered) return false;

        for (let i = 0; i < DATA_SHARDS; i++) {
            if (!block.shards.get(i)) block.shards.set(i, recovered[i]);
        }
        this.stats.recovered++;
        return true;
    }

    /** Give up on a block: emit what survived, report the rest as gaps. */
    emitPartial(block) {
        for (let i = 0; i < DATA_SHARDS; i++) {
            const shard = block.shards.get(i);
            if (shard) {
                this.stats.frames++;
                this.emit('frame', shard);
            } else {
                this.stats.dropped++;
                this.emit('missing');
            }
        }
    }

    /** Lowest block base still buffered, respecting sequence wrap-around. */
    oldestBase() {
        let oldest = null;
        for (const base of this.blocks.keys()) {
            if (oldest === null || before16(base, oldest)) oldest = base;
        }
        return oldest;
    }

    reset() {
        this.blocks.clear();
        this.nextBase = null;
    }
}

/** 16-bit sequence comparison that survives wrap-around. */
function before16(a, b) {
    return ((a - b) & 0xffff) > 0x8000;
}

module.exports = AudioDepacketizer;
module.exports.PAYLOAD_TYPE_AUDIO = PAYLOAD_TYPE_AUDIO;
