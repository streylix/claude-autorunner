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

// ---- TTS→sink shim helpers -------------------------------------------------

// Is a Remote Mode viewer attached? Ground truth (RemoteServer.clients.size)
// isn't exposed over HTTP, so use the observable proxy: any ESTABLISHED TCP
// connection on the app's Remote Mode port. (HTTP keep-alives on that port only
// exist while a viewer is open, so this tracks attach state closely enough for
// a 10s-cached audio-routing decision.)
function remoteViewerAttached() {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('ss', ['-Htn', 'state', 'established', `( sport = :${config.remoteViewPort} )`],
      { timeout: 2000 }, (err, stdout) => {
        if (err) return resolve(true); // can't tell → assume attached (the case the shim exists for)
        resolve(String(stdout).trim().length > 0);
      });
  });
}

// Does the RUNNING app already have the TTS dual-output patch (renderer keeps
// feeding the sink with viewers attached)? Inferred: the app's main process
// started AFTER the patched renderer source's mtime. Pre-restart the file is
// newer than the process (patch just landed) → false → shim plays. After the
// app's next restart the process is newer → true → shim steps aside.
const DUAL_OUTPUT_SENTINEL = path.resolve(__dirname, '..', '..', 'src', 'features', 'NotificationManager.js');
function appHasDualOutput() {
  try {
    const src = fs.readFileSync(DUAL_OUTPUT_SENTINEL, 'utf8');
    if (!src.includes('DUAL OUTPUT')) return false;       // patch not in the tree at all
    const mtimeMs = fs.statSync(DUAL_OUTPUT_SENTINEL).mtimeMs;
    const pidLine = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
    // Find the electron process that owns the Remote Mode port via /proc/net?
    // Simpler: use the oldest "electron" process cmdline-matching the app path.
    let appStartMs = null;
    const btime = Number((fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)$/m) || [])[1]) * 1000;
    for (const pid of pidLine) {
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch (_) { continue; }
      if (!cmd.includes('electron') || !cmd.includes('claude-autorunner')) continue;
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const startTicks = Number(fields[19]); // starttime, field 22 overall
        const hz = 100; // USER_HZ on Linux x86
        const startMs = btime + (startTicks / hz) * 1000;
        if (appStartMs == null || startMs < appStartMs) appStartMs = startMs;
      } catch (_) { /* raced exit */ }
    }
    if (appStartMs == null) return false; // app not found → keep shimming
    return appStartMs > mtimeMs;
  } catch (_) {
    return false; // can't tell → keep shimming (worst case is a brief double-play post-restart, fixed by TTS_TO_SINK=off)
  }
}

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
    this._speakStartedAt = 0;     // when the current speaking episode began (barge-in progress)
    this._speakExpectedMs = 0;    // its expected length
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
    const now = Date.now();
    // Track the episode start + expected length so a barge-in can report roughly
    // where in the reply the user cut in.
    if (!this.isBotSpeaking()) { this._speakStartedAt = now; this._speakExpectedMs = capped; }
    const until = now + capped;
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
    // BARGE-IN cleanup: the speaking window is over — if a barge-in muted the
    // live stream, un-mute it here (this path is GUARANTEED by the failsafe).
    if (this.player && this.player.liveMuted) this.player.setLiveMuted(false);
    if (this._gateClosedLogged) {
      this._gateClosedLogged = false;
      log.info(`🎙️ bot finished speaking — deaf-recovery re-armed (${reason}).`);
    }
  }

  // BARGE-IN: the user started really speaking while the bot was playing a reply
  // — cut the bot's audio so they can talk over it. tts mode stops the active
  // clip (queue kept; the hold gate delays the next clip until they finish);
  // system mode mutes the forwarded live stream for the rest of the reply (the
  // desktop keeps playing locally — the remote user only hears Discord).
  interruptPlayback(meta = {}) {
    if (!this.player || !this.isBotSpeaking()) return;
    const now = Date.now();
    const at = this._speakStartedAt ? ((now - this._speakStartedAt) / 1000).toFixed(1) : null;
    const pct = this._speakStartedAt && this._speakExpectedMs
      ? Math.min(99, Math.round(((now - this._speakStartedAt) / this._speakExpectedMs) * 100))
      : null;
    const level = Number.isFinite(meta.rmsDb) ? ` (speech ${meta.rmsDb.toFixed(1)} dBFS over ${meta.ms}ms)` : '';
    const where = at != null ? ` at ~${at}s${pct != null ? ` (~${pct}%)` : ''} into the reply` : '';
    log.info(`✋ barge-in: user cut in${level} — stopping bot audio${where}.`);
    if (config.audioSource === 'system') {
      this.player.setLiveMuted(true); // un-muted by _openGate when the window ends
    } else {
      this.player.interrupt();
      // The clip is dead — reopen the gate now instead of waiting out its length.
      this._openGate('barge-in interrupt', true);
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
      log.info('AUDIO_SOURCE=system — streaming the whole machine output (TTS + sound effects + wake-up alarm).');
      this.capture = new SystemAudioCapture({ onStream: (s) => this.player.playLive(s) });
      this.capture.start();
      // TTS → SINK shim (config.ttsToSink): with a Remote Mode viewer attached,
      // the RUNNING app's renderer suppresses local TTS playback (v1 double-play
      // rule), so nothing hits the sink monitor and Discord goes silent. Fetch
      // each clip and paplay it into the sink ourselves. 'auto' also detects
      // when a DUAL-OUTPUT app build is running (renderer feeds the sink again)
      // and steps aside, so this never doubles after the app's next restart.
      this.poller = new TtsPoller({
        watchOnly: config.ttsToSink === 'off',
        onClip: async (wav, row) => this._playTtsToSink(wav, row),
        onNotification: onManagerSpeech,
      });
      await this.poller.seed();
      this.poller.start();
      if (config.ttsToSink !== 'off') {
        log.info(`TTS→sink shim active (mode=${config.ttsToSink}) — bridge paplays TTS clips the app's renderer suppresses.`);
      }
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

  // TTS → SINK shim (system mode). Decide whether the BRIDGE must paplay this
  // clip into the sink because the app's renderer won't:
  //   'always' → play; 'off' → never reached (poller is watch-only);
  //   'auto'   → play only while (a) a Remote Mode viewer is attached (that is
  //              when the v1 renderer suppresses local playback) AND (b) the
  //              RUNNING app predates the dual-output patch. (b) is inferred by
  //              comparing the app process's start time against the patched
  //              renderer file's mtime — self-corrects at the app's next restart
  //              with no manual step.
  async _playTtsToSink(wav, row) {
    try {
      const verdict = await this._ttsSinkVerdict();
      if (!verdict.play) {
        log.info(`tts→sink: #${row.id} skipped — ${verdict.why}.`);
        return;
      }
      // TURN-TAKING HOLD: never START a readout while the user is still talking
      // (mirrors the tts-mode player's bargeInEnabled gate, which this sink path
      // bypasses). Once started it plays through — interrupt is disabled via the
      // BARGE_IN_INTERRUPT_ENABLED=false drop-in.
      if (config.bargeInEnabled && this.receiver) {
        const t0 = Date.now();
        while (this.receiver.isUserSpeaking() && Date.now() - t0 < config.bargeInMaxHoldMs) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const held = Date.now() - t0;
        if (held >= 200) log.info(`tts→sink: held #${row.id} for ${held}ms until the user finished talking.`);
      }
      // ECHO GATE: (re)mark right before actual playback so the capture gate
      // covers the REAL cue+clip window even after a long hold. (onManagerSpeech
      // already marked at row-detection time; this re-aligns it.)
      this.markBotSpeaking((row.duration_ms || config.defaultTtsMs) + 500, 'tts cue+clip');
      const rowAgeMs = row.created_at ? Math.max(0, Date.now() - new Date(row.created_at).getTime()) : null;
      log.success(`🗣️ tts→sink: cue + clip #${row.id} into the sink (${verdict.why})${rowAgeMs != null ? ` — ${rowAgeMs}ms after synthesis` : ''}.`);
      // PRE-TTS CUE, then the voice — the same click-then-speech every other
      // surface plays (the renderer's heads-up chime), as ONE burst: the click
      // lands in the gate's pre-roll cushion, the voice follows within the
      // hangover so Discord hears click → voice with no gap.
      const cue = path.join(SFX_DIR, 'click2.wav');
      if (fs.existsSync(cue)) await this._paplayToSink(cue, `cue for #${row.id}`);
      const tmp = path.join(require('os').tmpdir(), `ccbot-tts-${row.id}.wav`);
      fs.writeFileSync(tmp, wav);
      // Await completion so back-to-back rows play in order, never overlapped
      // (the poller awaits onClip per row — this IS the FIFO).
      await this._paplayToSink(tmp, `clip #${row.id}`);
      try { fs.unlinkSync(tmp); } catch (_) {}
    } catch (e) {
      log.warn('tts→sink error:', e.message);
    }
  }

  // paplay a file into the sink and resolve when it finishes (never rejects).
  _paplayToSink(file, label) {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      try {
        const p = spawn('paplay', [file], {
          env: { ...process.env, PULSE_SERVER: config.pulseServer },
          stdio: 'ignore',
        });
        p.on('error', (e) => { log.warn(`tts→sink: paplay ${label} failed:`, e.message); fin(); });
        p.on('exit', fin);
      } catch (e) {
        log.warn(`tts→sink: paplay ${label} spawn error:`, e.message);
        fin();
      }
    });
  }

  // Cached (10s) decision for the 'auto' mode.
  async _ttsSinkVerdict() {
    if (config.ttsToSink === 'always') return { play: true, why: 'TTS_TO_SINK=always' };
    if (config.ttsToSink !== 'auto') return { play: false, why: `TTS_TO_SINK=${config.ttsToSink}` };
    const now = Date.now();
    if (this._sinkVerdictCache && now - this._sinkVerdictCache.at < 10000) return this._sinkVerdictCache.v;
    let v;
    const attached = await remoteViewerAttached();
    if (!attached) {
      v = { play: false, why: 'no remote viewer attached — the app renderer plays the sink itself' };
    } else if (appHasDualOutput()) {
      v = { play: false, why: 'dual-output app build is running — its renderer feeds the sink even with viewers attached' };
    } else {
      v = { play: true, why: 'remote viewer attached and the running app suppresses local playback' };
    }
    this._sinkVerdictCache = { at: now, v };
    return v;
  }

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
