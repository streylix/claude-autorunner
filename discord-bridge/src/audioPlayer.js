'use strict';

// Plays WAV buffers into the active voice connection, one at a time (FIFO).
// Uses @discordjs/voice. WAVs are transcoded to Opus on the fly via ffmpeg
// (StreamType.Arbitrary -> ffmpeg-static), so whatever sample rate Kokoro emits
// just works.

const { Readable } = require('stream');
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
    this._holdCheck = null;   // BARGE-IN: () => bool — true while the user is talking
    this._holdSince = 0;
    this._holdTimer = null;

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
  }

  // Enqueue a WAV buffer for playback (TTS mode, FIFO).
  enqueue(wavBuffer, label = '') {
    this.queue.push({ wavBuffer, label });
    this._next();
  }

  // SYSTEM-AUDIO mode: play a continuous live PCM stream (48kHz stereo s16le,
  // StreamType.Raw) — the default sink monitor. Replaces any prior live stream
  // (e.g. after a parec restart). The FIFO queue is unused in this mode.
  playLive(readable, label = 'system-audio') {
    this.live = true;
    try {
      const resource = createAudioResource(readable, { inputType: StreamType.Raw });
      this.player.play(resource);
      this.playing = true;
      log.info(`live system-audio stream attached (${label}).`);
    } catch (err) {
      log.error('failed to attach live stream:', err.message);
    }
  }

  // BARGE-IN: gate the START of a clip while the user is still talking. Only
  // delays starting the NEXT clip (never restarts a playing one), so it can't
  // loop. Plays anyway after bargeInMaxHoldMs so a reply is never starved.
  setHoldCheck(fn) { this._holdCheck = fn; }

  _next() {
    if (this.playing || this.queue.length === 0) return;
    if (config.bargeInEnabled && this._holdCheck && this._holdCheck()) {
      if (!this._holdSince) this._holdSince = Date.now();
      if (Date.now() - this._holdSince < config.bargeInMaxHoldMs) {
        if (!this._holdTimer) {
          this._holdTimer = setTimeout(() => { this._holdTimer = null; this._next(); }, 250);
          if (this._holdTimer.unref) this._holdTimer.unref();
        }
        return; // hold for a silence gap before reading the notification aloud
      }
      log.info('barge-in: reached the hold cap — playing the queued notification now.');
    }
    this._holdSince = 0;
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
    if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
    this._holdSince = 0;
    this.player.stop(true);
  }
}

module.exports = VoicePlayer;
