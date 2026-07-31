'use strict';

// SYSTEM-AUDIO mode (AUDIO_SOURCE=system): stream EVERYTHING the machine's
// speakers play into the voice channel — TTS voice AND sound effects, chimes,
// and the morning wake-up song (which plays via mpv directly to the sink, not
// through the notification feed). This is the only way to hear non-TTS audio
// remotely.
//
// How it works:
//   1. parec captures the default sink's `.monitor` source (the post-mix output)
//      as 48kHz stereo s16le PCM — exactly @discordjs/voice's StreamType.Raw.
//   2. PipeWire/PulseAudio SUSPENDS an idle sink, and a suspended sink's monitor
//      produces NO data (verified). So we also run a silent keepalive: pacat
//      streaming /dev/zero INTO the sink keeps it "warm" so the monitor always
//      yields continuous PCM (silence when nothing real plays, real audio when
//      it does). The keepalive is inaudible.
//   3. Both children are restarted on exit so the stream is durable.
//
// Double-TTS: when this mode is on, the monitor ALREADY contains the TTS audio,
// so index.js does NOT also run the TTS poller. (Conversely, in this mode the
// user must NOT mute in-app playback, or the audio never reaches the sink to be
// captured — see SETUP.md.)

const { spawn, execFileSync } = require('child_process');
const { config } = require('../config');
const log = require('./log');

const RATE = 48000;
const CHANNELS = 2;
const FORMAT = 's16le';
const RESTART_DELAY_MS = 1000;

class SystemAudioCapture {
  constructor({ onStream }) {
    this.onStream = onStream; // (readable) => void — called with each fresh parec stdout
    this.parec = null;
    this.keepalive = null;
    this.device = null;
    this.stopped = false;
  }

  // Resolve the monitor device: explicit config override, else the default
  // sink's monitor via `pactl get-default-sink`.
  resolveDevice() {
    if (config.systemAudioDevice) return config.systemAudioDevice;
    try {
      const sink = execFileSync('pactl', ['get-default-sink'], {
        env: this._env(), encoding: 'utf8', timeout: 4000,
      }).trim();
      if (sink) return `${sink}.monitor`;
    } catch (err) {
      log.warn('pactl get-default-sink failed:', err.message);
    }
    // Special token that PulseAudio resolves to the default sink's monitor.
    return '@DEFAULT_MONITOR@';
  }

  _env() {
    return { ...process.env, PULSE_SERVER: config.pulseServer };
  }

  start() {
    this.device = this.resolveDevice();
    log.info(`system-audio capture: device "${this.device}" via ${config.pulseServer}`);
    if (config.systemAudioKeepalive) this._startKeepalive();
    // Warm the sink before opening the monitor so the first frames aren't lost.
    setTimeout(() => { if (!this.stopped) this._startParec(); }, config.systemAudioWarmupMs);
  }

  _startKeepalive() {
    if (this.stopped) return;
    // Continuous silence INTO the default sink keeps it un-suspended.
    this.keepalive = spawn('pacat', [
      `--rate=${RATE}`, `--channels=${CHANNELS}`, `--format=${FORMAT}`,
      '--raw', '--latency-msec=30', '--stream-name=ccbot-bridge-keepalive',
    ], { env: this._env(), stdio: ['pipe', 'ignore', 'ignore'] });

    // Feed it endless zeros (silence).
    try {
      const zeros = require('fs').createReadStream('/dev/zero');
      zeros.pipe(this.keepalive.stdin);
      this.keepalive.stdin.on('error', () => {});
    } catch (err) {
      log.warn('keepalive stdin error:', err.message);
    }

    this.keepalive.on('exit', (code) => {
      if (this.stopped) return;
      log.warn(`keepalive exited (code ${code}) — restarting.`);
      this.keepalive = null;
      setTimeout(() => this._startKeepalive(), RESTART_DELAY_MS);
    });
    this.keepalive.on('error', (err) => log.error('keepalive spawn error:', err.message));
    log.info('system-audio keepalive running (silent, keeps sink warm).');
  }

  _startParec() {
    if (this.stopped) return;
    this.parec = spawn('parec', [
      `--device=${this.device}`,
      `--rate=${RATE}`, `--channels=${CHANNELS}`, `--format=${FORMAT}`,
      '--raw', '--latency-msec=30', '--stream-name=ccbot-bridge-capture',
    ], { env: this._env(), stdio: ['ignore', 'pipe', 'pipe'] });

    this.parec.stderr.on('data', (d) => {
      const s = String(d).trim();
      if (s) log.warn('parec:', s);
    });
    this.parec.on('error', (err) => log.error('parec spawn error (is pulseaudio-utils installed?):', err.message));
    this.parec.on('exit', (code) => {
      if (this.stopped) return;
      log.warn(`parec exited (code ${code}) — restarting capture.`);
      this.parec = null;
      setTimeout(() => this._startParec(), RESTART_DELAY_MS);
    });

    log.success('system-audio capture live — streaming default sink monitor into the channel.');
    // Hand the fresh PCM stream to the player.
    this.onStream(this.parec.stdout);
  }

  stop() {
    this.stopped = true;
    if (this.parec) { try { this.parec.kill('SIGTERM'); } catch (_) {} this.parec = null; }
    if (this.keepalive) { try { this.keepalive.kill('SIGTERM'); } catch (_) {} this.keepalive = null; }
  }
}

module.exports = SystemAudioCapture;
