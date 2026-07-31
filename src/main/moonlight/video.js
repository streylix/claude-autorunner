/**
 * Video depacketizer — turns Sunshine's UDP packets into whole H.264 frames.
 *
 * Each datagram is an RTP header, then Moonlight's own 16-byte video header,
 * then a slice of the frame. Three details account for essentially every way
 * this can go wrong, and all three were found the hard way:
 *
 *  1. The RTP header is 12 bytes, but 16 whenever FLAG_EXTENSION (0x10) is set
 *     in the first byte — which Sunshine always sets. Reading the Moonlight
 *     header at offset 12 yields values that look plausible and are wrong.
 *
 *  2. Roughly a tenth of the packets are Reed-Solomon parity, not picture data.
 *     They are indistinguishable by size or flags; the only way to tell is to
 *     compare the shard's index against the data-shard count, both of which are
 *     packed into `fecInfo`. Concatenating them into the frame produces a
 *     bitstream that still parses as H.264 and decodes to garbage.
 *
 *  3. Shards arrive out of order. They must be concatenated by index, not by
 *     arrival, or frames are subtly corrupt in a way that survives ffprobe.
 *
 * Parity is kept rather than thrown away: a frame missing data shards is
 * rebuilt from it (see `recoverFrame`), which is what the host is spending ~10%
 * of its bandwidth for. Only when too much of a frame is gone is it dropped and
 * a fresh IDR requested.
 */
const { EventEmitter } = require('events');
const rs = require('./reedsolomon');

const FLAG_CONTAINS_PIC_DATA = 0x01;
const FLAG_EOF = 0x02;
const FLAG_SOF = 0x04;
const FLAG_EXTENSION = 0x10;

const FIXED_RTP_HEADER_SIZE = 12;
const NV_VIDEO_HEADER_SIZE = 16;

// H.264 NAL types that make a frame independently decodable.
const NAL_IDR = 5;
const NAL_SPS = 7;
const START_CODE = Buffer.from([0, 0, 0, 1]);

// How far behind the newest frame a pending one may fall before it is written
// off. A couple of frames is ample: parity for a frame arrives immediately
// after its data, not seconds later.
const STALE_FRAME_DISTANCE = 3;

class VideoDepacketizer extends EventEmitter {
    /** @param {{hevc?: boolean}} [options] which codec the host is sending */
    constructor(options = {}) {
        super();
        this.hevc = !!options.hevc;
        this.frames = new Map();
        this.stats = { packets: 0, parity: 0, frames: 0, dropped: 0, keyframes: 0, recovered: 0 };
        this.sawKeyframe = false;
    }

    /** Feed one UDP datagram. Emits `frame` with a complete Annex B buffer. */
    push(msg) {
        this.stats.packets++;
        if (msg.length < FIXED_RTP_HEADER_SIZE + NV_VIDEO_HEADER_SIZE) return;

        const dataOffset = FIXED_RTP_HEADER_SIZE + ((msg.readUInt8(0) & FLAG_EXTENSION) ? 4 : 0);
        if (msg.length < dataOffset + NV_VIDEO_HEADER_SIZE) return;

        const frameIndex = msg.readUInt32LE(dataOffset + 4);
        const flags = msg.readUInt8(dataOffset + 8);
        const fecInfo = msg.readUInt32LE(dataOffset + 12);

        const fecIndex = (fecInfo & 0x3ff000) >> 12;
        const dataShards = (fecInfo & 0xffc00000) >>> 22;
        const fecPercentage = (fecInfo & 0xff0) >> 4;
        if (dataShards === 0) return;

        // Same rounding the host uses to size its parity block.
        const parityShards = Math.floor((dataShards * fecPercentage + 99) / 100);
        const payload = msg.subarray(dataOffset + NV_VIDEO_HEADER_SIZE);
        const isParity = fecIndex >= dataShards;

        // `!isParity` is essential: parity packets carry the SOF flag too, and a
        // parity packet arriving after its frame has already been delivered
        // would otherwise open a brand new entry holding one useless shard. That
        // ghost can never complete, lingers until it is evicted, and is counted
        // as a dropped frame — one phantom drop for every frame received.
        if ((flags & FLAG_SOF) && !isParity) {
            this.frames.set(frameIndex, {
                shards: new Map(),
                dataShards,
                parityShards,
                shardSize: 0,
                lastIndex: -1,
            });
        }

        const entry = this.frames.get(frameIndex);
        if (!entry) return;   // joined mid-frame; wait for the next SOF

        if (isParity) {
            this.stats.parity++;
            // Kept now rather than discarded: parity is the only thing that can
            // fill a hole left by a lost data packet.
            entry.shards.set(fecIndex, payload);
            this.tryComplete(frameIndex, entry);
            return;
        }

        if (!(flags & FLAG_CONTAINS_PIC_DATA)) return;

        entry.shards.set(fecIndex, payload);
        // Every shard but the last is full length; that is the size recovery
        // has to work in, so take it from a shard that is not the tail.
        if (!(flags & FLAG_EOF) && payload.length > entry.shardSize) {
            entry.shardSize = payload.length;
        }
        if (flags & FLAG_EOF) entry.lastIndex = fecIndex;

        this.tryComplete(frameIndex, entry);

        this.evictStale(frameIndex);
    }

    /**
     * Assemble the frame once it can be — either because every data shard
     * arrived, or because enough shards of any kind arrived to rebuild the
     * missing ones from parity.
     */
    tryComplete(frameIndex, entry) {
        // The tail shard marks the frame's extent; without it there is nothing
        // to assemble yet even if the count looks right.
        if (entry.lastIndex < 0) return;

        const need = entry.lastIndex + 1;
        let haveData = 0;
        for (let i = 0; i < need; i++) if (entry.shards.get(i)) haveData++;

        if (haveData < need) {
            // Recovery needs `dataShards` shards in total, counting parity.
            if (entry.shards.size < entry.dataShards || !entry.shardSize) return;
            if (!this.recoverFrame(entry)) return;
        }

        this.frames.delete(frameIndex);

        const ordered = [];
        for (let i = 0; i < need; i++) ordered.push(entry.shards.get(i));
        const frame = Buffer.concat(ordered);
        const keyframe = this.isKeyframe(frame);
        if (keyframe) {
            this.sawKeyframe = true;
            this.stats.keyframes++;
        }
        // A decoder handed a delta frame before any keyframe will error out.
        if (!this.sawKeyframe) return;

        this.stats.frames++;
        this.emit('frame', { data: frame, keyframe, frameIndex });
    }

    /**
     * Retire frames that are too far behind to still be completed.
     *
     * Keeping parity means a lossy frame legitimately lingers until its parity
     * arrives, so eviction is by DISTANCE behind the newest frame rather than
     * by how many are outstanding. A count-based rule fires constantly under
     * loss, and since every eviction asks for a keyframe, that turns ordinary
     * packet loss into an IDR storm that costs far more bandwidth than the loss
     * it was reacting to.
     */
    evictStale(newestIndex) {
        for (const [index, entry] of this.frames) {
            if (newestIndex - index <= STALE_FRAME_DISTANCE) continue;

            // One last attempt with whatever turned up before giving up on it.
            if (entry.lastIndex >= 0 && entry.shardSize && this.recoverFrame(entry)) {
                this.tryComplete(index, entry);
                continue;
            }
            this.frames.delete(index);
            this.stats.dropped++;
            this.emit('missing', index);
        }
    }

    /**
     * Rebuild missing data shards from parity.
     *
     * Shards must be uniform length for the maths to work, but the tail shard
     * is short by nature, so it is padded up and the trailing zeroes are simply
     * left in the bitstream — an Annex B decoder ignores them.
     *
     * @returns {boolean} whether every data shard is now present
     */
    recoverFrame(entry) {
        const { dataShards, parityShards, shardSize } = entry;
        const total = dataShards + parityShards;

        const shards = new Array(total).fill(null);
        for (const [index, shard] of entry.shards) {
            if (index >= total) continue;
            shards[index] = shard.length === shardSize
                ? shard
                : Buffer.concat([shard, Buffer.alloc(shardSize - shard.length)]);
        }

        let recovered;
        try {
            recovered = rs.recover(shards, dataShards, parityShards, shardSize);
        } catch (_) {
            return false;   // singular matrix; treat as unrecoverable
        }
        if (!recovered) return false;

        for (let i = 0; i <= entry.lastIndex; i++) {
            if (!entry.shards.get(i)) entry.shards.set(i, recovered[i]);
        }
        this.stats.recovered++;
        return true;
    }

    /**
     * True when the frame carries a parameter set or an IDR slice.
     *
     * H.264 and HEVC disagree about where the NAL type lives: H.264 puts it in
     * the low 5 bits of a one-byte header, HEVC in bits 1-6 of a two-byte one.
     * Reading an HEVC stream with the H.264 rule finds no keyframe ever, and
     * since a decoder cannot be started without one, the result is not a
     * corrupt picture but no picture at all.
     */
    isKeyframe(frame) {
        let offset = 0;
        while (offset !== -1 && offset < frame.length - 5) {
            const at = frame.indexOf(START_CODE, offset);
            if (at === -1) break;

            if (this.hevc) {
                const type = (frame[at + 4] >> 1) & 0x3f;
                // 32/33/34 = VPS/SPS/PPS, 16-21 = the IRAP slice types.
                if (type === 32 || type === 33 || type === 34 || (type >= 16 && type <= 21)) return true;
            } else {
                const type = frame[at + 4] & 0x1f;
                if (type === NAL_SPS || type === NAL_IDR) return true;
            }
            offset = at + 4;
        }
        return false;
    }
}

module.exports = VideoDepacketizer;
module.exports.FLAGS = { FLAG_CONTAINS_PIC_DATA, FLAG_EOF, FLAG_SOF, FLAG_EXTENSION };
