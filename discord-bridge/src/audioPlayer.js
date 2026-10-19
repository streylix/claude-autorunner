'use strict';

// Plays WAV buffers into the active voice connection, one at a time (FIFO).
// Uses @discordjs/voice. WAVs are transcoded to Opus on the fly via ffmpeg
// (StreamType.Arbitrary -> ffmpeg-static), so whatever sample rate Kokoro emits
// just works.

const { Readable, Transform, PassThrough } = require('stream');
const {
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  entersState,
} = require('@discordjs/voice');

const log = require('./log');
const { config } = require('../config');

class VoicePlayer {
  constructor() {
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.queue = [];
    this.playing = false;
    this.connection = null;
    this._holdCheck = null;   // BARGE-IN: () => bool — true while the user is talking/writing
    this._holdMaxMs = config.bargeInMaxHoldMs;
    this._holdSince = 0;
    this._holdTimer = null;
    this._holdCapLogged = false;
    this._pausedByHold = false; // we paused the player because the user is writing
    this._pausedAt = 0;
    this.liveMuted = false;   // BARGE-IN (system mode): zero-fill the live stream

    this.player.on('error', (err) => log.error('audio player error:', err.message));
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.playing = false;
      this._next();
    });
  }

  // Subscribe a (re)connected voice connection to this player.
  attach(connection) {
    this.connection = connection;
    connection.subscribe(this.player);
    // HOLD loop: pause/resume playback and release held bursts/clips as the
    // hold check flips. 100ms granularity.
    if (!this._holdTimer) {
      this._holdTimer = setInterval(() => this._applyHold(), 100);
      if (this._holdTimer.unref) this._holdTimer.unref();
    }
  }

  // Enqueue a WAV buffer for playback (TTS mode, FIFO).
  enqueue(wavBuffer, label = '') {
    this.queue.push({ wavBuffer, label });
    this._next();
  }

  // SYSTEM-AUDIO mode: relay the default sink monitor (48kHz stereo s16le) into
  // the channel. Replaces any prior live source (e.g. after a parec restart).
  // The FIFO queue is unused in this mode.
  //
  // BURST GATE (config.systemGateEnabled, default on): the keepalive keeps the
  // monitor producing CONTINUOUS PCM, so one eternal Raw resource means the bot
  // "speaks" 24/7 — Discord's receive-side jitter buffer never gets a silence
  // gap to reset on, so it only ever GROWS: every encoder/network hiccup becomes
  // permanent added delay (observed as multi-second lag after minutes in-call).
  // Gated mode watches the PCM for sound, streams each burst as its own short
  // resource (with a pre-roll so onsets aren't clipped), and ENDS it after a
  // trailing silence — speaking stops, the buffer resets, latency stays flat.
  playLive(readable, label = 'system-audio') {
    this.live = true;
    if (!config.systemGateEnabled) return this._playLiveUngated(readable, label);
    try {
      readable.on('error', () => {}); // parec restart destroys it; 'end'/'close' follow
      this._attachGatedLive(readable, label);
      log.info(`live system-audio attached with burst gate (${label}) — threshold ${config.systemGateThreshold}, hangover ${config.systemGateHangoverMs}ms, preroll ${config.systemGatePrerollMs}ms.`);
    } catch (err) {
      log.error('failed to attach live stream:', err.message);
    }
  }

  // Legacy path: one continuous Raw resource for the life of the parec stream.
  _playLiveUngated(readable, label) {
    try {
      // BARGE-IN mute point: zero-fill payload while muted so the stream keeps
      // real-time pace (no lag build-up) and unmute is instant.
      const self = this;
      const muteable = new Transform({
        transform(chunk, _enc, cb) {
          cb(null, self.liveMuted ? Buffer.alloc(chunk.length) : chunk);
        },
      });
      readable.on('error', () => {});
      readable.pipe(muteable);
      const resource = createAudioResource(muteable, { inputType: StreamType.Raw });
      this.player.play(resource);
      this.playing = true;
      log.info(`live system-audio stream attached UNGATED (${label}).`);
    } catch (err) {
      log.error('failed to attach live stream:', err.message);
    }
  }

  _attachGatedLive(readable, label) {
    const BYTES_PER_MS = 192;                 // 48kHz * 2ch * 2B / 1000
    const FRAME_ALIGN = 4;                    // one stereo s16 sample
    const threshold = Math.max(1, config.systemGateThreshold);
    const hangoverMs = Math.max(100, config.systemGateHangoverMs);
    const prerollBytesMax = Math.max(FRAME_ALIGN, Math.floor(config.systemGatePrerollMs * BYTES_PER_MS / FRAME_ALIGN) * FRAME_ALIGN);

    // Kill any previous gated source (parec restart): its burst ends now.
    if (this._liveGate) this._liveGate.dead = true;
    const gate = { dead: false, deferred: false, burst: null, burstStartedAt: 0, burstBytes: 0, silentMs: 0, preroll: [], prerollBytes: 0, resource: null };
    this._liveGate = gate;

    const endBurst = (why) => {
      if (!gate.burst) return;
      const sentMs = Math.round(gate.burstBytes / BYTES_PER_MS);
      const playedMs = gate.resource ? Math.round(gate.resource.playbackDuration) : 0;
      const wallMs = Date.now() - gate.burstStartedAt;
      // backlog ≈ audio handed to the encoder but not yet played out. Persistent
      // growth here would mean the SENDER is falling behind (event-loop stall).
      const backlogMs = Math.max(0, sentMs - playedMs);
      log.info(`🔈 burst end (${why}): ${sentMs}ms audio over ${wallMs}ms wall, played ${playedMs}ms, sender backlog ~${backlogMs}ms.`);
      try { gate.burst.end(); } catch (_) {}
      gate.burst = null;
      gate.resource = null;
      gate.burstBytes = 0;
      gate.silentMs = 0;
    };

    const onChunk = (chunk) => {
      if (gate.dead) return;
      // BARGE-IN mute: treat the monitor as silent — stop relaying, let the
      // burst close after the hangover. Unmute re-opens on the next loud chunk.
      const loud = !this.liveMuted && this._chunkPeak(chunk, threshold);
      if (gate.burst) {
        // Audio queued but not yet played out (a HELD burst, or one paused mid-
        // way). While it exceeds the hangover, silent chunks are dropped so the
        // backlog drains in the bot's pauses — and the burst never ends (and
        // never gets replaced) with held audio still inside it.
        const backlogMs = gate.burstBytes / BYTES_PER_MS - (gate.resource ? gate.resource.playbackDuration : 0);
        if (loud) {
          gate.silentMs = 0;
          gate.burst.write(chunk);
          gate.burstBytes += chunk.length;
        } else if (backlogMs > hangoverMs) {
          // behind — skip this silent chunk
        } else if (gate.deferred) {
          gate.burst.write(chunk); // held burst: keep the short pause, never end it
          gate.burstBytes += chunk.length;
        } else {
          gate.silentMs += chunk.length / BYTES_PER_MS;
          if (gate.silentMs >= hangoverMs) {
            endBurst('trailing silence');
          } else {
            // Keep the tail smooth inside the hangover — but as ZEROS while
            // barge-in-muted, so a mute cuts the relay instantly instead of
            // leaking up to hangoverMs of bot audio.
            gate.burst.write(this.liveMuted ? Buffer.alloc(chunk.length) : chunk);
            gate.burstBytes += chunk.length;
          }
        }
        return;
      }
      if (loud) {
        // Onset: open a fresh resource seeded with the pre-roll so the first
        // syllable / chime transient isn't clipped.
        gate.burst = new PassThrough({ highWaterMark: 1 << 20 });
        gate.burstStartedAt = Date.now();
        for (const p of gate.preroll) { gate.burst.write(p); gate.burstBytes += p.length; }
        gate.preroll = [];
        gate.prerollBytes = 0;
        gate.burst.write(chunk);
        gate.burstBytes += chunk.length;
        gate.silentMs = 0;
        if (this._holdNow()) {
          // HELD: buffer the burst; _applyHold plays it when the user is done.
          gate.deferred = true;
          log.info('⏸️ bot audio held — the user is talking; it plays when they finish.');
          return;
        }
        try {
          gate.resource = createAudioResource(gate.burst, { inputType: StreamType.Raw });
          this.player.play(gate.resource);
          this.playing = true;
          log.info('🔊 burst start — relaying sink audio into the channel.');
        } catch (err) {
          log.error('burst start failed:', err.message);
          gate.burst = null;
        }
        return;
      }
      // Silence between bursts: keep a rolling pre-roll.
      gate.preroll.push(chunk);
      gate.prerollBytes += chunk.length;
      while (gate.prerollBytes > prerollBytesMax && gate.preroll.length > 1) {
        gate.prerollBytes -= gate.preroll.shift().length;
      }
    };

    readable.on('data', onChunk);
    readable.on('end', () => { if (!gate.dead) { gate.dead = true; endBurst('stream end'); } });
    readable.on('close', () => { if (!gate.dead) { gate.dead = true; endBurst('stream close'); } });
    void label;
  }

  // True if any s16le sample in the chunk exceeds the gate threshold.
  _chunkPeak(chunk, threshold) {
    // Scan every other sample (one channel) — plenty for a gate decision and
    // half the CPU. Chunk lengths from parec are 4-byte aligned.
    const n = chunk.length - (chunk.length % 2);
    for (let i = 0; i < n; i += 4) {
      const s = chunk.readInt16LE(i);
      if (s > threshold || s < -threshold) return true;
    }
    return false;
  }

  // BARGE-IN (system mode): silence the forwarded live stream (the desktop keeps
  // playing — we just stop relaying it). Logged on every transition.
  setLiveMuted(muted) {
    muted = !!muted;
    if (this.liveMuted === muted) return;
    this.liveMuted = muted;
    log.info(muted
      ? '🤫 live stream muted — user barged in over the bot.'
      : '🔊 live stream unmuted — bot audio flows again.');
  }

  // BARGE-IN (tts mode): stop ONLY the active clip. The queue is kept — the
  // hold-check gate already delays the next clip until the user stops talking.
  interrupt() {
    if (!this.playing) return;
    this.player.stop(true);
  }

  // BARGE-IN: gate the START of a clip while the user is still talking. Only
  // delays starting the NEXT clip (never restarts a playing one), so it can't
  // loop. Plays anyway after bargeInMaxHoldMs so a reply is never starved.
  //
  // HOLD (always-listen): while the hold check is true (the user is writing an
  // utterance), playback is HELD — never dropped: a clip or burst that is
  // playing is PAUSED, a new one isn't started, and all of it plays once the
  // check goes false. `maxMs` only guards a wedged check.
  setHoldCheck(fn, maxMs = config.bargeInMaxHoldMs) { this._holdCheck = fn; this._holdMaxMs = maxMs; }

  _holdNow() {
    let held = false;
    if (config.bargeInEnabled && this._holdCheck) {
      try { held = !!this._holdCheck(); } catch (_) { held = false; }
    }
    if (!held) { this._holdSince = 0; this._holdCapLogged = false; return false; }
    if (!this._holdSince) this._holdSince = Date.now();
    if (Date.now() - this._holdSince < this._holdMaxMs) return true;
    if (!this._holdCapLogged) {
      this._holdCapLogged = true;
      log.warn(`hold cap reached (${Math.round(this._holdMaxMs / 1000)}s) — playing held bot audio now.`);
    }
    return false;
  }

  _applyHold() {
    if (this._holdNow()) {
      if (!this._pausedByHold && this.player.state.status === AudioPlayerStatus.Playing && this.player.pause(true)) {
        this._pausedByHold = true;
        this._pausedAt = Date.now();
        log.info('⏸️ bot audio paused — the user started talking; it resumes when they finish.');
      }
      return;
    }
    if (this._pausedByHold) {
      this._pausedByHold = false;
      this.player.unpause();
      log.info(`▶️ held bot audio resumed after ${Date.now() - this._pausedAt}ms.`);
    }
    const gate = this._liveGate;
    if (gate && gate.deferred && gate.burst && !gate.dead) {
      gate.deferred = false;
      try {
        gate.resource = createAudioResource(gate.burst, { inputType: StreamType.Raw });
        this.player.play(gate.resource);
        this.playing = true;
        log.info(`▶️ held burst released — ${Math.round(gate.burstBytes / 192)}ms of bot audio queued.`);
      } catch (err) {
        log.error('held burst release failed:', err.message);
      }
    }
    if (!this.playing && this.queue.length) this._next();
  }

  _next() {
    if (this.playing || this.queue.length === 0) return;
    if (this._holdNow()) return; // _applyHold starts it once the user is done
    const { wavBuffer, label } = this.queue.shift();
    try {
      const resource = createAudioResource(Readable.from(wavBuffer), {
        inputType: StreamType.Arbitrary, // let ffmpeg sniff/transcode the WAV
      });
      this.playing = true;
      this.player.play(resource);
      log.info(`playing into voice channel${label ? ` (${label})` : ''} — ${this.queue.length} queued behind.`);
    } catch (err) {
      log.error('failed to start playback:', err.message);
      this.playing = false;
      // try the next item so a single bad clip doesn't wedge the queue
      setImmediate(() => this._next());
    }
  }

  async waitUntilIdle(timeoutMs = 30000) {
    try {
      await entersState(this.player, AudioPlayerStatus.Idle, timeoutMs);
    } catch (_) { /* timed out — caller can proceed */ }
  }

  stop() {
    this.queue = [];
    if (this._holdTimer) { clearInterval(this._holdTimer); this._holdTimer = null; }
    this._holdSince = 0;
    this._pausedByHold = false;
    this.player.stop(true);
  }
}

module.exports = VoicePlayer;
