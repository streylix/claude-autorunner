'use strict';

// A BridgeSession is the bot's "in a voice channel and wired up" state. It is
// created when the user runs /link (or /join) and torn down on /leave|/unlink.
// Joining follows the SUMMONING USER like a music bot: it joins whatever voice
// channel they're currently in (config.voiceChannelId is only a fallback).

const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { config } = require('../config');
const log = require('./log');
const TtsPoller = require('./ttsPoller');
const VoicePlayer = require('./audioPlayer');
const SystemAudioCapture = require('./systemAudio');
const ReceiverHealthMonitor = require('./receiverHealth');

const SFX_DIR = path.join(__dirname, '..', '..', 'assets', 'soundeffects');
const _sfxCache = new Map();

class BridgeSession {
  constructor({ receiver, textMirror }) {
    this.receiver = receiver;     // shared VoiceReceiver
    this.textMirror = textMirror; // shared TextMirror (Heard:/Replied: chat)
    this.connection = null;
    this.player = null;
    this.poller = null;
    this.capture = null;
    this.channelId = null;
    this.guildId = null;
    this.guild = null;            // the Guild object (for member-presence checks)
    this._intentionalLeave = false; // suppress auto-recovery during /stop & rejoin
    this.botSpeakingUntil = 0;    // ms timestamp until which the BOT is playing audio
    this._gateTimer = null;       // failsafe timer that guarantees the gate reopens
    this._gateClosedLogged = false; // currently inside a logged "gate closed" episode

    // Deaf-receiver auto-recovery. Created once; gated by connection state, so it
    // idles when we're not in a call. Recovery counters survive a rejoin (the
    // monitor is never restarted mid-episode), so the hard cap actually holds.
    this.health = config.receiverHealthEnabled
      ? new ReceiverHealthMonitor({
          getState: () => this._receiverState(),
          resubscribe: () => { if (this.receiver) this.receiver.resubscribe(); },
          rejoin: () => this.rejoinForRecovery(),
          opts: {
            intervalMs: config.receiverHealthIntervalMs,
            stallMs: config.receiverStallMs,
            coldStallMs: config.receiverColdStallMs,
            cooldownMs: config.receiverRecoverCooldownMs,
            maxRejoins: config.receiverMaxRejoins,
          },
        })
      : null;
  }

  // True while the bot is playing audio (TTS/SFX) into the channel — used to gate
  // out self-voice/echo on the capture side. Self-clearing by timestamp.
  isBotSpeaking() { return Date.now() < this.botSpeakingUntil; }

  // Close the capture gate while the bot speaks for ~ms (+ an echo tail). The
  // window is HARD-CAPPED at botSpeakingMaxMs so a long/garbled/missing duration
  // can NEVER wedge capture off indefinitely, and a failsafe timer GUARANTEES the
  // gate reopens (with a logged transition). Driven by manager-TTS notifications
  // and SFX playback.
  markBotSpeaking(ms, reason = 'TTS') {
    const want = (Number(ms) > 0 ? Number(ms) : config.defaultTtsMs) + config.echoGuardTailMs;
    const capped = Math.min(want, config.botSpeakingMaxMs);
    const until = Date.now() + capped;
    if (until > this.botSpeakingUntil) this.botSpeakingUntil = until;
    if (!this._gateClosedLogged) {
      this._gateClosedLogged = true;
      log.info(`🔊 bot speaking ~${(capped / 1000).toFixed(1)}s (${reason}) — deaf-recovery paused; user capture stays ACTIVE (barge-in)${capped < want ? ' [capped to failsafe ceiling]' : ''}.`);
    }
    this._armGateFailsafe();
  }

  // Failsafe: GUARANTEE the gate reopens. Fires shortly after botSpeakingUntil;
  // if the window was extended meanwhile, it re-arms — so the gate is ALWAYS
  // open within botSpeakingMaxMs of the last markBotSpeaking, no matter what.
  _armGateFailsafe() {
    if (this._gateTimer) clearTimeout(this._gateTimer);
    const wait = Math.max(0, this.botSpeakingUntil - Date.now()) + 100;
    this._gateTimer = setTimeout(() => {
      this._gateTimer = null;
      if (this.isBotSpeaking()) { this._armGateFailsafe(); return; } // extended → wait more
      this._openGate('playback window ended');
    }, wait);
    if (this._gateTimer.unref) this._gateTimer.unref();
  }

  // Reopen the capture gate (logs the transition). `forced` also clears the
  // window timestamp (used on leave so a stale future value can't latch a rejoin
  // shut). Natural reopen keeps the (now-past) timestamp as a post-gate grace
  // reference for the deaf-receiver monitor.
  _openGate(reason, forced = false) {
    if (this._gateTimer) { clearTimeout(this._gateTimer); this._gateTimer = null; }
    if (forced) this.botSpeakingUntil = 0;
    if (this._gateClosedLogged) {
      this._gateClosedLogged = false;
      log.info(`🎙️ bot finished speaking — deaf-recovery re-armed (${reason}).`);
    }
  }

  // Health snapshot for the receiver monitor: connection Ready + how many non-bot,
  // UNMUTED members are present (potential speakers) + audio staleness.
  _receiverState() {
    const ready = !!(this.connection && this.connection.state &&
      this.connection.state.status === VoiceConnectionStatus.Ready);
    let eligible = 0;
    try {
      const channel = this.guild && this.guild.channels && this.guild.channels.cache.get(this.channelId);
      if (channel && channel.members) {
        for (const m of channel.members.values()) {
          if (m.user && m.user.bot) continue;
          const v = m.voice || {};
          if (v.selfMute || v.serverMute || v.serverDeaf) continue;
          eligible += 1;
        }
      }
    } catch (_) { /* members cache miss → treat as 0, i.e. not a fault */ }
    const h = this.receiver ? this.receiver.getHealth() : { audioAgeMs: 0, everReceived: false };
    // Don't count time the BOT was speaking (capture is intentionally echo-gated)
    // as a stall — otherwise reading a long TTS would look like a deaf receiver.
    let audioAgeMs = h.audioAgeMs;
    const now = Date.now();
    if (now < this.botSpeakingUntil) audioAgeMs = 0;
    else if (this.botSpeakingUntil) audioAgeMs = Math.min(audioAgeMs, now - this.botSpeakingUntil);
    return { ready, eligible, audioAgeMs, everReceived: h.everReceived };
  }

  // Auto-recovery heavy fix: full leave + rejoin of the SAME channel, link kept.
  async rejoinForRecovery() {
    const guild = this.guild;
    const channelId = this.channelId;
    if (!guild || !channelId) { log.warn('recovery rejoin skipped — no stored channel.'); return false; }
    try {
      await this.leave();            // robust teardown (suppresses the Disconnected handler)
      await this.join(guild, channelId);
      log.info('rejoined the voice channel (recovery) — watching for audio…');
      return true;
    } catch (e) {
      log.error('recovery rejoin failed:', e.message);
      return false;
    }
  }

  isActive() {
    return !!this.connection;
  }

  // Join a specific voice channel and wire audio in both directions.
  async join(guild, channelId) {
    if (this.connection) await this.leave();

    this._intentionalLeave = false; // a fresh join re-arms the disconnect handler
    this.guildId = guild.id;
    this.guild = guild;
    this.channelId = channelId;

    const connection = joinVoiceChannel({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // must hear to receive
      selfMute: false,
    });
    this.connection = connection;

    connection.on('error', (err) => log.error('voice connection error:', err.message));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this._intentionalLeave) return; // we're tearing down on purpose (/stop or recovery)
      log.warn('voice disconnected — attempting recovery…');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch (_) {
        log.error('could not recover — leaving voice.');
        this.leave();
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    } catch (err) {
      log.error('voice never became Ready (DAVE/negotiation?):', err.message);
      this.leave();
      throw new Error(`could not connect to voice: ${err.message}`);
    }

    this.player = new VoicePlayer();
    this.player.attach(connection);
    // BARGE-IN: hold a queued TTS clip while the user is still talking (tts mode).
    this.player.setHoldCheck(() => this.receiver && this.receiver.isUserSpeaking());
    this.receiver.attach(connection);

    // Resolve (or create) the text-mirror channel for this guild — best-effort.
    if (this.textMirror) {
      try { await this.textMirror.resolve(guild); } catch (err) { log.warn('text mirror resolve failed:', err.message); }
    }

    await this._startOutput();
    if (this.health) this.health.start(); // idempotent — arms once, survives rejoins
    log.success(`joined voice channel ${channelId} — bridge audio is live.`);
    return true;
  }

  async _startOutput() {
    // When the manager speaks a reply, open the receiver's auto-reply window so
    // the user can answer without the wake word. Fires in BOTH modes.
    const onManagerSpeech = (row) => {
      if (String(row.terminal_id) !== '999') return;
      // ECHO GATE: the bot is about to speak this reply into the channel — gate
      // capture for its duration (+ tail) so we don't transcribe our own voice.
      this.markBotSpeaking(row.duration_ms, 'manager reply');
      if (this.receiver) this.receiver.openAutoReplyWindow(row.duration_ms);
      // Mirror the manager's reply into the text channel ("Replied:").
      if (this.textMirror && row.text) this.textMirror.postReplied(row.text);
    };

    if (config.audioSource === 'system') {
      log.info('AUDIO_SOURCE=system — streaming the whole machine output (TTS + sound effects + wake-up alarm). TTS polling disabled to avoid doubling.');
      this.capture = new SystemAudioCapture({ onStream: (s) => this.player.playLive(s) });
      this.capture.start();
      // Watch-only poller: detects manager replies (for the auto-reply window)
      // without downloading/playing them (the monitor already relays the audio).
      this.poller = new TtsPoller({ watchOnly: true, onNotification: onManagerSpeech });
      await this.poller.seed();
      this.poller.start();
    } else {
      this.poller = new TtsPoller({
        onClip: async (wav, row) => this.player.enqueue(wav, `#${row.id}`),
        onNotification: onManagerSpeech,
      });
      await this.poller.seed();
      this.poller.start();
      log.info('AUDIO_SOURCE=tts — playing TTS notifications only. (Mute in-app playback to avoid doubling.)');
    }
  }

  // Play a short acknowledgment sound INTO the channel.
  //   - system mode: paplay to the local sink; the monitor we're capturing
  //     relays it into the channel (no interruption of the live stream).
  //   - tts mode: enqueue the wav on the FIFO player.
  playSound(name, label = 'sfx') {
    if (!name) { log.warn(`${label}: no sound configured — skipping.`); return; }
    if (!this.connection) { log.warn(`${label}: not in a voice channel — can't play "${name}".`); return; }
    const file = path.join(SFX_DIR, name);
    if (!fs.existsSync(file)) { log.warn(`${label}: sound file not found: ${file}`); return; }
    // ECHO GATE: this SFX is about to play into the channel — gate capture briefly
    // so the sound isn't picked up + transcribed as if it were the user.
    this.markBotSpeaking(config.sfxGateMs, 'sound effect');
    try {
      if (config.audioSource === 'system') {
        const p = spawn('paplay', [file], {
          env: { ...process.env, PULSE_SERVER: config.pulseServer },
          stdio: 'ignore',
        });
        p.on('error', (e) => log.warn(`${label}: paplay failed:`, e.message));
        log.info(`🔊 ${label}: played "${name}" to the local sink (relayed into the channel).`);
      } else if (this.player) {
        let buf = _sfxCache.get(file);
        if (!buf) { buf = fs.readFileSync(file); _sfxCache.set(file, buf); }
        this.player.enqueue(buf, `sfx:${name}`);
        log.info(`🔊 ${label}: enqueued "${name}" to the voice player.`);
      }
    } catch (e) {
      log.warn(`${label}: playSound error:`, e.message);
    }
  }

  playWakeAck() { this.playSound(config.wake().activationSound, 'wake-sound'); }
  playCommandAck() { this.playSound(config.wake().stopSound, 'command-sound'); }

  // Cleanly leave the call and stop listening. FORCE-destroys the connection even
  // if it's wedged/deaf (the scenario that left the bot stuck), and suppresses the
  // Disconnected auto-recovery so it can't fight the teardown. Does NOT unlink —
  // state is preserved so /resume can bring it right back.
  async leave() {
    this._intentionalLeave = true; // tell the Disconnected handler this is on purpose
    this._openGate('left channel', true); // never leave the gate latched closed
    try { if (this.poller) this.poller.stop(); } catch (_) {}
    try { if (this.capture) this.capture.stop(); } catch (_) {}
    try { if (this.player) this.player.stop(); } catch (_) {}
    try { if (this.receiver) this.receiver.detach(); } catch (_) {}

    // Destroy BOTH our handle AND any connection discord.js still tracks for this
    // guild, so a wedged connection always actually goes away.
    const conns = new Set();
    if (this.connection) conns.add(this.connection);
    try {
      const tracked = this.guildId && getVoiceConnection(this.guildId);
      if (tracked) conns.add(tracked);
    } catch (_) {}
    for (const conn of conns) {
      try {
        if (!conn.state || conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
      } catch (e) { log.warn('connection destroy:', e.message); }
    }

    this.connection = null;
    this.player = null;
    this.poller = null;
    this.capture = null;
    log.info('left voice channel.');
  }
}

module.exports = BridgeSession;
