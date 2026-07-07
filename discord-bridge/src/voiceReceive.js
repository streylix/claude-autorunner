'use strict';

// INPUT path: Discord speech -> wake-word gate -> manager (via the active link).
//
// Per speaker: capture each utterance's Opus, decode to PCM, wrap as WAV,
// transcribe locally (Whisper). Then:
//   - wake-word ON  (default): forward ONLY if the transcript starts with the
//     wake phrase ("hey claude ..."). The phrase is stripped; the rest is the
//     prompt. If the wake word is said alone, the speaker is "armed" briefly so
//     their NEXT utterance is taken as the prompt without repeating the phrase.
//   - wake-word OFF: forward every utterance.
// Forwarding goes through the LinkManager (no-op if the bot isn't linked).
//
// DAVE: voice-receive is unofficial in @discordjs/voice; the DAVE-receive fix is
// in the pinned version. See SETUP.md for the verify-on-live caveat.

const fs = require('fs');
const os = require('os');
const path = require('path');
const prism = require('prism-media');
const { EndBehaviorType } = require('@discordjs/voice');
const { config } = require('../config');
const { pcmToWav } = require('./wav');
const { transcribeWav } = require('./transcribe');
const { wakeCheck } = require('./wakeCheck');
const auth = require('./auth');
const log = require('./log');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) / 1000;

// Peak/RMS of a 16-bit PCM WAV body in dBFS — lets an EMPTY transcript be
// diagnosed as a SILENT capture (deaf receiver / muted mic) vs a Whisper miss
// (audio clearly present but no words recognized).
function audioLevel(wav) {
  const body = wav.length > 44 ? wav.subarray(44) : wav;
  const n = Math.floor(body.length / 2);
  if (!n) return { peakDb: -Infinity, rmsDb: -Infinity };
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = body.readInt16LE(i * 2);
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / n);
  const db = (v) => (v <= 0 ? -Infinity : 20 * Math.log10(v / 32768));
  return { peakDb: db(peak), rmsDb: db(rms) };
}

class VoiceReceiver {
  constructor({ linkManager, wakeSpotter }) {
    this.linkManager = linkManager;
    this.wakeSpotter = wakeSpotter;
    this.connection = null;
    this.active = new Set();          // userIds currently being captured
    this.armedUntil = new Map();      // userId -> timestamp (wake said alone)
    this.autoReplyUntil = 0;          // window after a manager reply: no wake word needed
    this.busy = false;                // serialize transcription+forward
    this.mutedUsers = new Set();      // userIds whose mic is muted (capture OFF)
    this._uttSeq = 0;                 // per-utterance file sequence
    this.lastAudioAt = 0;             // ms timestamp of the last audio activity
    this.attachedAt = 0;              // ms timestamp of the current attach
    // Wired by index.js to the BridgeSession so wake-detection plays an
    // acknowledgment sound into the channel. No-ops until set.
    this.onWakeAck = () => {};
    this.onCommandAck = () => {};
    // Wired by index.js to the text mirror — fired with the transcript of each
    // forwarded utterance ("Heard:" in chat). No-op until set.
    this.onHeard = () => {};
    // Wired by index.js to the session — true while the BOT is playing audio into
    // the channel (TTS/SFX). Only used for the OPTIONAL capture pause; the bot's
    // own voice is excluded structurally via botUserId below. No-op until set.
    this.isBotSpeaking = () => false;
    // The bot's OWN Discord user id — its output is never a user receive stream,
    // but we exclude it defensively so self-audio is never captured. Set in index.
    this.botUserId = null;
  }

  // Is the user actively talking right now? Used for the TTS barge-in hold. A
  // capture in progress is the strongest signal; a short grace covers the gap
  // between utterances.
  isUserSpeaking() {
    if (this.active.size > 0) return true;
    return this.lastAudioAt > 0 && (Date.now() - this.lastAudioAt) < config.userSpeakingGraceMs;
  }

  // In-call always-listen: no wake word, mic mute is the off switch.
  _alwaysOn() {
    return !!config.alwaysListenInCall;
  }

  // Audio-activity heartbeat for the deaf-receiver health monitor.
  markAudio() { this.lastAudioAt = Date.now(); }

  // Health snapshot consumed by ReceiverHealthMonitor.
  getHealth() {
    const ref = this.lastAudioAt || this.attachedAt || Date.now();
    return { audioAgeMs: Date.now() - ref, everReceived: this.lastAudioAt > 0 };
  }

  // Light recovery: drop any lingering per-speaker subscriptions and clear the
  // in-progress set so fresh subscriptions form on the next speaking event.
  resubscribe() {
    try {
      const rec = this.connection && this.connection.receiver;
      const subs = rec && rec.subscriptions;
      if (subs && typeof subs.forEach === 'function') {
        subs.forEach((stream) => { try { stream.destroy(); } catch (_) {} });
      }
    } catch (_) { /* best-effort */ }
    this.active.clear();
  }

  attach(connection) {
    this.connection = connection;
    this.attachedAt = Date.now();
    this.lastAudioAt = 0; // reset per attach so a fresh join starts "cold"
    const receiver = connection.receiver;
    receiver.speaking.on('start', (userId) => {
      if (userId === this.botUserId) return; // never capture the bot's own output stream
      this.markAudio(); // a real user's speaking event IS reception — feeds the health monitor
      // BARGE-IN: by default we KEEP capturing the user's per-user stream while
      // the bot speaks (their stream never contains the bot's TTS). Only pause if
      // explicitly opted in (PAUSE_CAPTURE_DURING_TTS=1).
      if (config.pauseCaptureDuringTts && this.isBotSpeaking()) return;
      if (this.active.has(userId)) return;
      if (this.mutedUsers.has(userId)) return; // muted = off switch
      // Speaker authorization: ALLOWED_SPEAKER_IDS when set, otherwise fall back
      // to the command allow-list (DISCORD_ALLOWED_USER_IDS) — speaking the wake
      // word drives the manager just like /prompt does, so an unset speaker list
      // must not mean "everyone in the channel".
      const speakers = config.allowedSpeakerIds.length
        ? config.allowedSpeakerIds : auth.allowList();
      if (!speakers.includes(String(userId))) return;
      this.active.add(userId);
      this._capture(receiver, userId).catch((err) => {
        log.error('capture error:', err.message);
        this.active.delete(userId);
      });
    });
    const w = config.wake();
    if (this._alwaysOn()) {
      log.info('voice receiver attached — ALWAYS-LISTEN in-call (no wake word; mute your mic to stop). Deferred per-utterance Whisper at the silence boundary.');
    } else {
      log.info(`voice receiver attached — wake word: ${w.enabled ? `"${w.phrase}" (from app settings)` : 'DISABLED (forward all)'}.`);
    }
  }

  detach() {
    this.connection = null;
    this.active.clear();
    this.armedUntil.clear();
    this.mutedUsers.clear();
    this.autoReplyUntil = 0;
  }

  // Track a speaker's mic mute state (driven by index.js voiceStateUpdate). When
  // muted we ignore their speech entirely — mute is the sole "stop listening".
  setMute(userId, muted) {
    if (muted) {
      if (!this.mutedUsers.has(userId)) log.info(`🔇 ${userId} muted — capture paused (mute is the off switch).`);
      this.mutedUsers.add(userId);
    } else if (this.mutedUsers.has(userId)) {
      this.mutedUsers.delete(userId);
      log.info(`🔊 ${userId} unmuted — listening again.`);
    }
  }

  // Open a brief window (after the bot plays a manager reply) during which the
  // user's next speech is forwarded WITHOUT the wake word. `clipMs` is how long
  // the reply takes to play, so the window opens once it finishes.
  openAutoReplyWindow(clipMs = 0) {
    const until = Date.now() + (Number(clipMs) || 0) + config.autoReplyWindowMs;
    if (until > this.autoReplyUntil) this.autoReplyUntil = until;
    log.info(`auto-reply window open for ~${Math.round((this.autoReplyUntil - Date.now()) / 1000)}s — reply without the wake word.`);
  }

  // True when we're expecting an actual command (armed after wake, or inside the
  // post-reply auto-reply window) — use a longer end-silence so it isn't cut off.
  _expectingCommand(userId) {
    const now = Date.now();
    return now < (this.armedUntil.get(userId) || 0) || now < this.autoReplyUntil;
  }

  async _capture(receiver, userId) {
    // End-of-speech silence (VAD boundary). In always-listen we use one steady
    // in-call value; in wake mode it's short while listening for the wake word
    // and longer once capturing the command.
    const silence = this._alwaysOn()
      ? config.inCallSilenceMs
      : (this._expectingCommand(userId) ? config.commandSilenceMs : config.wakeListenSilenceMs);
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: silence },
    });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });
    const chunks = [];
    opusStream.pipe(decoder);
    decoder.on('data', (c) => { chunks.push(c); this.markAudio(); });

    // Safety cap: end an over-long capture so we still transcribe + forward what
    // we have instead of waiting on a talker who never pauses.
    const cap = setTimeout(() => {
      try { opusStream.destroy(); } catch (_) {}
    }, config.maxUtteranceMs);

    await new Promise((resolve) => {
      const done = () => { clearTimeout(cap); resolve(); };
      decoder.once('end', done);
      decoder.once('error', (e) => { log.warn('opus decode error:', e.message); done(); });
      opusStream.once('error', (e) => { log.warn('opus stream error:', e.message); done(); });
    });
    this.active.delete(userId);

    // If they muted mid-utterance, drop it — mute is the off switch.
    if (this.mutedUsers.has(userId)) {
      log.info(`(${userId}) muted during capture — dropping utterance.`);
      return;
    }

    // Optional capture pause (PAUSE_CAPTURE_DURING_TTS): drop a clip that
    // overlapped bot playback. OFF by default so barge-in works.
    if (config.pauseCaptureDuringTts && this.isBotSpeaking()) {
      log.info(`capture paused (bot speaking) — dropping overlapping utterance.`);
      return;
    }

    const pcm = Buffer.concat(chunks);
    const durationMs = pcm.length / BYTES_PER_MS;
    if (durationMs < config.minUtteranceMs) return; // drop clicks/coughs

    const wav = pcmToWav(pcm, { sampleRate: SAMPLE_RATE, channels: CHANNELS });
    if (this._alwaysOn()) {
      await this._processAlwaysOn(wav, userId, durationMs);
    } else {
      await this._processSerial(wav, userId, durationMs);
    }
  }

  // ALWAYS-LISTEN path: no wake word. Buffer the completed utterance to a
  // per-utterance FILE, transcribe it ONCE with Whisper (deferred — this only
  // runs after the silence boundary, never streaming), then forward to the
  // manager and mirror "Heard:" into the text channel.
  async _processAlwaysOn(wav, userId, durationMs) {
    while (this.busy) await new Promise((r) => setTimeout(r, 40));
    this.busy = true;
    try {
      if (this.mutedUsers.has(userId)) return; // muted = off
      // Optional capture-pause backstop (PAUSE_CAPTURE_DURING_TTS only).
      if (config.pauseCaptureDuringTts && this.isBotSpeaking()) {
        log.info('capture paused (bot speaking) — dropping queued utterance.');
        return;
      }
      const text = await this._transcribeUtteranceFile(wav, userId);
      if (!text) {
        // Diagnose: was the captured audio actually silent (deaf receiver / muted
        // mic) or did Whisper just miss audible speech?
        const { peakDb, rmsDb } = audioLevel(wav);
        const fmt = (d) => (d === -Infinity ? '-inf' : d.toFixed(1));
        const silent = rmsDb < -55;
        log.info(`(${Math.round(durationMs)}ms) empty transcript — peak ${fmt(peakDb)} / rms ${fmt(rmsDb)} dBFS → ${silent ? 'SILENT capture (deaf receiver / muted mic?)' : 'audio present (likely a Whisper miss)'}.`);
        if (config.retainEmptyWav) this._retainWav(wav, userId, durationMs);
        return;
      }
      log.success(`🎙️  heard ${userId} (${Math.round(durationMs)}ms): "${text.slice(0, 80)}" → terminal ${this.linkManager.status().managerId || 999}`);
      try { this.onHeard(text); } catch (e) { log.warn('onHeard mirror failed:', e.message); }
      const res = await this.linkManager.forward(text);
      if (res && res.ok) { try { this.onCommandAck(); } catch (_) {} }
    } finally {
      this.busy = false;
    }
  }

  // Write the buffered utterance to a per-utterance WAV file and submit THAT file
  // to Whisper. The on-disk buffer is the "deferred" segment: one transcription
  // per completed utterance. Cleaned up afterwards; falls back to the in-memory
  // buffer if disk I/O fails so a transient FS error never loses a command.
  async _transcribeUtteranceFile(wav, userId) {
    const dir = path.join(os.tmpdir(), 'ccbot-bridge-utt');
    let file = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this._uttSeq += 1;
      file = path.join(dir, `utt-${userId}-${this._uttSeq}.wav`);
      fs.writeFileSync(file, wav);
      return await transcribeWav(fs.readFileSync(file));
    } catch (err) {
      log.warn('utterance-file transcription failed, using in-memory buffer:', err.message);
      try { return await transcribeWav(wav); } catch (_) { return ''; }
    } finally {
      if (file) { try { fs.unlinkSync(file); } catch (_) {} }
    }
  }

  // Retain one empty-transcript clip on disk for inspection (RETAIN_EMPTY_WAV=1).
  _retainWav(wav, userId, durationMs) {
    try {
      const dir = path.join(os.tmpdir(), 'ccbot-bridge-empty');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `empty-${userId}-${Date.now()}-${Math.round(durationMs)}ms.wav`);
      fs.writeFileSync(file, wav);
      log.info(`retained empty-transcript clip → ${file}`);
    } catch (e) { log.warn('retain empty wav failed:', e.message); }
  }

  async _processSerial(wav, userId, durationMs) {
    while (this.busy) await new Promise((r) => setTimeout(r, 40));
    this.busy = true;
    try {
      const w = config.wake();

      // Wake word disabled → every utterance is a command (needs an accurate
      // transcript, so GPU Whisper).
      if (!w.enabled) {
        const text = await transcribeWav(wav);
        if (text) {
          log.info(`(${Math.round(durationMs)}ms) "${text}" — forwarding (wake disabled).`);
          await this.linkManager.forward(text);
        }
        return;
      }

      this.wakeSpotter.setPhrase(w.phrase);

      const now = Date.now();
      const armed = (this.armedUntil.get(userId) || 0) > now;
      const autoReply = now < this.autoReplyUntil;

      // ── EXPECTING A COMMAND (armed after wake, or post-reply window) ──
      // This utterance IS the command. Transcribe it ACCURATELY (Whisper) — do
      // NOT route it through the cheap Vosk gate, which silently drops valid
      // commands when Vosk returns empty or mishears a word.
      if (armed || autoReply) {
        const how = armed ? 'armed follow-up' : 'auto-reply';
        const transcript = await this._accurateTranscript(wav);
        if (!transcript) {
          // Nothing intelligible — keep waiting; don't consume the arm/window.
          log.info(`(${how}) empty transcript while expecting a command — still listening…`);
          return;
        }
        const command = this.wakeSpotter.stripWake(transcript).trim();
        if (!command) {
          // Only the wake word again → re-arm, re-ack, keep listening.
          this.armedUntil.set(userId, Date.now() + config.wakeFollowupMs);
          try { this.onWakeAck(); } catch (_) {}
          log.info(`wake word repeated by ${userId} — still listening for the command…`);
          return;
        }
        // Real command → consume the arm AND the auto-reply window, forward it.
        this.armedUntil.delete(userId);
        this.autoReplyUntil = 0;
        await this._forwardCommand(command, userId, how);
        return;
      }

      // ── DETECTION (not expecting a command) ──
      const det = await this._detectWake(wav, durationMs);
      if (!det) return;

      // WAKE DETECTED → fire the acknowledgment sound IMMEDIATELY, before/▶
      // independent of whether any command follows. Silence after the wake word
      // still chimes. Logged so we can confirm the sound actually fires.
      try { this.onWakeAck(); } catch (e) { log.warn('wake-ack failed:', e.message); }
      log.success(`🗡️  wake word DETECTED (${det.via}) from ${userId} in "${det.transcript.slice(0, 60)}" — playing wake sound now.`);

      const inlineCommand = (det.command || '').trim();
      if (!inlineCommand) {
        // Wake word alone → arm and wait for the command utterance.
        this.armedUntil.set(userId, Date.now() + config.wakeFollowupMs);
        log.success(`armed ${userId} for ${Math.round(config.wakeFollowupMs / 1000)}s — listening for your command…`);
        return;
      }
      await this._forwardCommand(inlineCommand, userId, 'inline');
    } finally {
      this.busy = false;
    }
  }

  // Decide whether the wake word is present. Returns { command, transcript, via }
  // (command = text after the wake word, '' for a lone wake) or null.
  //
  // Confidence policy: trust the cheap Vosk gate ONLY for a STRONG match (exact /
  // soundex / small edit-distance — high confidence). Anything weaker (Vosk
  // empty, no match, or only a common-word homophone) is LOW confidence, so we
  // escalate short utterances to GPU Whisper and require Whisper to confirm. Weak
  // homophone matches ("sean" → "don"/"on") are therefore NEVER accepted on a
  // bare Vosk guess — only when Whisper independently lands on a wake variant.
  async _detectWake(wav, durationMs) {
    const gateRaw = config.useSharedWakeGate ? await wakeCheck(wav) : await transcribeWav(wav);
    const gateText = (gateRaw || '').trim();
    const gm = this.wakeSpotter.check(gateText);

    // High-confidence: Vosk clearly contains the wake phrase.
    if (gm.detected && gm.via === 'strong') {
      let command = gm.command;
      // Re-transcribe an inline command accurately (Vosk garbles command words too).
      if (command && config.commandUseWhisper) {
        const am = this.wakeSpotter.check((await transcribeWav(wav)).trim());
        if (am.detected) command = am.command;
      }
      return { command, transcript: gateText, via: 'vosk' };
    }

    // Low-confidence → confirm with Whisper (covers Vosk empty / wrong / weak).
    if (config.wakeEscalateMaxMs > 0 && durationMs <= config.wakeEscalateMaxMs) {
      const acc = (await transcribeWav(wav)).trim();
      const am = this.wakeSpotter.check(acc);
      if (am.detected) {
        log.info(`wake confirmed via Whisper (${am.via}); Vosk heard "${gateText.slice(0, 40)}" → ${gm.via || 'no match'}.`);
        return { command: am.command, transcript: acc, via: `whisper/${am.via}` };
      }
      if (gateText || acc) log.info(`no wake word — ignoring: vosk="${gateText.slice(0, 40)}" whisper="${acc.slice(0, 40)}"`);
      return null;
    }

    if (gateText) log.info(`no wake word — ignoring: "${gateText.slice(0, 60)}"`);
    return null;
  }

  // Accurate transcript for a command utterance: Whisper if enabled, falling
  // back to the cheap Vosk transcript (also covers Whisper returning empty).
  async _accurateTranscript(wav) {
    let t = '';
    if (config.commandUseWhisper) t = (await transcribeWav(wav)).trim();
    if (!t) t = (await wakeCheck(wav).catch(() => '')).trim();
    return t;
  }

  // Forward an already-clean command to the manager and play the command-ack.
  async _forwardCommand(command, userId, how) {
    command = (command || '').trim();
    if (!command) {
      log.warn(`(${how}) empty command after stripping wake word — not forwarding.`);
      return;
    }
    log.success(`command from ${userId} (${how}): "${command}" → terminal ${this.linkManager.status().managerId || 999}`);
    const res = await this.linkManager.forward(command);
    if (res && res.ok) { try { this.onCommandAck(); } catch (_) {} }
  }
}

module.exports = VoiceReceiver;
module.exports.audioLevel = audioLevel; // exported for tests
