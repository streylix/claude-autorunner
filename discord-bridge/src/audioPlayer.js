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

class VoicePlayer {
  constructor() {
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    this.queue = [];
    this.playing = false;
    this.connection = null;

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

  // Enqueue a WAV buffer for playback.
  enqueue(wavBuffer, label = '') {
    this.queue.push({ wavBuffer, label });
    this._next();
  }

  _next() {
    if (this.playing || this.queue.length === 0) return;
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
    this.player.stop(true);
  }
}

module.exports = VoicePlayer;
