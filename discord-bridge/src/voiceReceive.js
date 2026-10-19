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
    this.lastDecodedAt = 0;           // ms timestamp of the last DECODED audio frame
    this._decodeHealthy = true;       // false after a capture saw packets but decoded nothing
    this.attachedAt = 0;              // ms timestamp of the current attach
    this.utterances = new Map();      // userId -> open always-listen utterance
    this._writing = new Set();        // utterances with real speech not yet sent (isWriting)
    // Wired by index.js to the BridgeSession so wake-detection plays an
    // acknowledgment sound into the channel. No-ops until set.
    this.onWakeAck = () => {};
    this.onCommandAck = () => {};
    // BARGE-IN: fired once per bot-speaking episode when the user's own stream
    // carries sustained real-speech energy DURING bot playback — the session
    // cuts the bot's audio so the user can talk over it. No-op until set.
    this.onBargeIn = () => {};
    this._bargeAccum = null;  // { ms, sumSq, n } accumulated while the bot speaks
    this._bargeFired = false; // one interrupt per speaking episode
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

  // True while an utterance with real speech is being captured, drafted or
  // finalized and has not been sent yet. Bot playback is HELD while it's true.
  isWriting() { return this._writing.size > 0; }

  // Hold check for the player/sink: always-listen holds on isWriting (the whole
  // utterance, pauses included); wake mode keeps the short speaking-grace hold.
  shouldHoldPlayback() {
    return this._alwaysOn() ? this.isWriting() : this.isUserSpeaking();
  }

  // In-call always-listen: no wake word; muting the mic sends what was said.
  _alwaysOn() {
    return !!config.alwaysListenInCall;
  }

  // Audio-activity heartbeat for the deaf-receiver health monitor.
  markAudio() { this.lastAudioAt = Date.now(); }

  // BARGE-IN detection, fed every decoded PCM chunk of the user's own stream.
  // Accumulates ONLY while the bot is speaking; when bargeInMinSpeechMs of
  // sustained audio reaches bargeInMinLevelDb (RMS dBFS), fire onBargeIn once
  // for this speaking episode. A too-quiet window resets the accumulator, so
  // echo bleed / short noises never trip it; the check re-arms when the bot
  // stops speaking.
  _bargeInCheck(chunk) {
    if (!config.bargeInInterruptEnabled) return;
    if (!this.isBotSpeaking()) { this._bargeAccum = null; this._bargeFired = false; return; }
    if (this._bargeFired) return;
    const a = this._bargeAccum || (this._bargeAccum = { ms: 0, sumSq: 0, n: 0 });
    const samples = Math.floor(chunk.length / 2);
    for (let i = 0; i < samples; i++) { const s = chunk.readInt16LE(i * 2); a.sumSq += s * s; }
    a.n += samples;
    a.ms += chunk.length / BYTES_PER_MS;
    if (a.ms < config.bargeInMinSpeechMs) return;
    const rms = a.n ? Math.sqrt(a.sumSq / a.n) : 0;
    const rmsDb = rms <= 0 ? -Infinity : 20 * Math.log10(rms / 32768);
    const ms = Math.round(a.ms);
    this._bargeAccum = null; // window consumed — a quiet one starts fresh
    if (rmsDb >= config.bargeInMinLevelDb) {
      this._bargeFired = true;
      try { this.onBargeIn({ rmsDb, ms }); } catch (e) { log.warn('barge-in handler failed:', e.message); }
    }
  }

  // Health snapshot consumed by ReceiverHealthMonitor.
  // Speaking events fire per UDP packet BEFORE decryption, so while decoding is
  // broken they keep lastAudioAt fresh and hide the fault (T510) — after a
  // capture that decoded nothing, only decoded audio counts as reception.
  getHealth() {
    const ref = (this._decodeHealthy ? this.lastAudioAt : this.lastDecodedAt)
      || this.attachedAt || Date.now();
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
    this._reportUnsentDrafts();
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
      this._maybeStartCapture(receiver, userId);
    });
    const w = config.wake();
    if (this._alwaysOn()) {
      log.info('voice receiver attached — ALWAYS-LISTEN in-call (no wake word; mute your mic to stop). Deferred per-utterance Whisper at the silence boundary.');
    } else {
      log.info(`voice receiver attached — wake word: ${w.enabled ? `"${w.phrase}" (from app settings)` : 'DISABLED (forward all)'}.`);
    }
  }

  _maybeStartCapture(receiver, userId) {
    if (this.active.has(userId)) return;
    if (this.mutedUsers.has(userId)) return; // muted = not listening
    // Speaker authorization: ALLOWED_SPEAKER_IDS when set, otherwise fall back
    // to the command allow-list (DISCORD_ALLOWED_USER_IDS) — speaking the wake
    // word drives the manager just like /prompt does, so an unset speaker list
    // must not mean "everyone in the channel".
    const speakers = config.allowedSpeakerIds.length
      ? config.allowedSpeakerIds : auth.allowList();
    if (!speakers.includes(String(userId))) return;
    this.active.add(userId);
    if (this._alwaysOn()) {
      try { this._captureUtterance(receiver, userId); } catch (err) {
        log.error('capture error:', err.message);
        this.active.delete(userId);
      }
      return;
    }
    this._capture(receiver, userId).catch((err) => {
      log.error('capture error:', err.message);
      this.active.delete(userId);
    });
  }

  // Unsent drafts left by a crash/restart mid-utterance: say where they are.
  _reportUnsentDrafts() {
    try {
      const unsent = fs.readdirSync(config.draftDir)
        .filter((n) => n.endsWith('.jsonl') && !n.endsWith('.sent.jsonl'));
      if (unsent.length) log.warn(`${unsent.length} unsent voice draft(s) kept in ${config.draftDir} (e.g. ${unsent[unsent.length - 1]}).`);
    } catch (_) { /* no draft dir yet */ }
    this._pruneDrafts(true);
  }

  detach() {
    // Leaving ends every open utterance — and sends what was captured. The
    // connection is cleared FIRST so a finishing utterance can't re-subscribe.
    this.connection = null;
    for (const u of [...this.utterances.values()]) u.finish('left channel');
    this.active.clear();
    this.armedUntil.clear();
    this.mutedUsers.clear();
    this.autoReplyUntil = 0;
  }

  // Track a speaker's mic mute state (driven by index.js voiceStateUpdate). When
  // muted we ignore their speech entirely — mute is the sole "stop listening".
  // In always-listen, muting is "I'm done talking": the open utterance ends at
  // once and what was captured is SENT (nothing captured → nothing sent).
  setMute(userId, muted) {
    if (muted) {
      const u = this.utterances.get(userId);
      if (!this.mutedUsers.has(userId)) {
        log.info(`🔇 ${userId} muted — ${u ? 'sending what was captured now' : 'not listening'} (mute = done talking).`);
      }
      this.mutedUsers.add(userId);
      if (u) u.finish('mute');
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
    // End-of-speech silence (VAD boundary). In always-listen it's mirrored LIVE
    // from the app's "Stop after silence" slider (wakeSilenceMs; floor 600ms,
    // default 1200ms) — read per capture so a slider change applies to the next
    // utterance. In wake mode it's short while listening for the wake word and
    // longer once capturing the command.
    const mode = this._alwaysOn()
      ? 'always-listen'
      : (this._expectingCommand(userId) ? 'command' : 'wake-listen');
    const silence = this._alwaysOn()
      ? config.inCallSilence()
      : (mode === 'command' ? config.commandSilenceMs : config.wakeListenSilenceMs);
    log.info(`capture start (${userId}): mode=${mode}, end-of-speech silence=${silence}ms`);
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: silence },
    });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });
    const chunks = [];
    opusStream.pipe(decoder);
    decoder.on('data', (c) => { chunks.push(c); this.markAudio(); this._bargeInCheck(c); });

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
      // destroy() (the cap above, or any teardown) emits 'close' but never
      // 'end', and pipe() doesn't end the decoder on close — without this the
      // capture hung forever (T510).
      opusStream.once('close', done);
    });
    this.active.delete(userId);
    // Wall-clock from the LAST decoded audio to the cut — should track `silence`
    // closely; a big gap here means the cutoff isn't what we think it is.
    const sinceLastAudio = this.lastAudioAt ? Date.now() - this.lastAudioAt : -1;
    log.info(`capture end (${userId}): ${sinceLastAudio}ms from last audio to cut (applied silence=${silence}ms, mode=${mode})`);

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
    await this._processSerial(wav, userId, durationMs);
  }

  // ALWAYS-LISTEN path. One utterance per speaker: read the audio until a STOP,
  // then send it — "if there's a stop, there's a stop". A stop is any of:
  //   - silence: no window above voiceEnergyThresholdDb for the configured
  //     silence. Breathing below the threshold is silence, and so is NO packets
  //     at all — Discord's VAD, lag and a stalled receiver all look the same and
  //     all end the utterance the same way: the captured audio is sent.
  //   - mute (setMute): sent at once.
  //   - the stream closing/erroring under us (teardown, recovery, leave).
  //   - the maxUtteranceMs memory backstop (sent; listening continues).
  // The subscription uses Manual end: the library's AfterSilence timer is only
  // armed by a delivered packet, so a stream that never got one never ended.
  // While he talks, each pause-cut segment is transcribed and appended (fsynced)
  // to a durable draft file; the message to 999 is the STITCHED draft — there
  // is no whole-clip re-transcribe at the stop (that pass was the ~30s wait).
  _captureUtterance(receiver, userId) {
    const silence = config.inCallSilence();
    this._uttSeq += 1;
    const u = {
      key: `${userId}-${this._uttSeq}`, userId, silence, startedAt: Date.now(),
      chunks: [], bytes: 0, decoded: 0, voicedMs: 0, lastVoiceAt: 0,
      win: { sumSq: 0, n: 0, ms: 0 }, levels: [],
      segIdx: 0, segBytes: 0, segVoiced: false, segs: [],
      draftChain: Promise.resolve(), fd: null, file: null,
      writing: false, done: false, finish: () => {},
    };
    log.info(`capture start (${userId}): mode=always-listen, end-of-speech silence=${silence}ms below ${config.voiceEnergyThresholdDb} dBFS`);
    const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: 960 });
    opusStream.pipe(decoder);
    decoder.on('data', (c) => this._onUtterancePcm(u, c));
    // A corrupt packet kills the decoder; the silence timer then ends the
    // utterance with everything captured so far.
    decoder.on('error', (e) => log.warn('opus decode error:', e.message));
    u.finish = (reason) => this._finishUtterance(u, reason, receiver, opusStream, decoder);
    opusStream.once('close', () => { u.streamClosed = true; u.finish('stream closed'); });
    opusStream.once('end', () => u.finish('stream ended'));
    opusStream.once('error', (e) => { log.warn('opus stream error:', e.message); u.finish('stream error'); });
    u.timer = setInterval(() => this._tickUtterance(u), 50);
    this.utterances.set(userId, u);
  }

  // Every decoded 20ms frame: keep it, and classify each voiceEnergyWindowMs
  // window as voice (resets the silence timer) or not (breathing/noise).
  _onUtterancePcm(u, c) {
    if (u.done) return;
    const now = Date.now();
    u.chunks.push(c);
    u.bytes += c.length;
    u.decoded += 1;
    this.markAudio();
    this.lastDecodedAt = now;
    this._decodeHealthy = true;
    this._bargeInCheck(c);
    const w = u.win;
    const n = Math.floor(c.length / 2);
    for (let i = 0; i < n; i++) { const s = c.readInt16LE(i * 2); w.sumSq += s * s; }
    w.n += n;
    w.ms += c.length / BYTES_PER_MS;
    if (w.ms >= config.voiceEnergyWindowMs) {
      const rms = w.n ? Math.sqrt(w.sumSq / w.n) : 0;
      const db = rms <= 0 ? -120 : 20 * Math.log10(rms / 32768);
      if (u.levels.length < 20000) u.levels.push(db);
      if (db >= config.voiceEnergyThresholdDb) {
        u.lastVoiceAt = now;
        u.voicedMs += w.ms;
        u.segVoiced = true;
        if (!u.writing) { u.writing = true; this._writing.add(u); }
      }
      u.win = { sumSq: 0, n: 0, ms: 0 };
    }
    if (u.bytes / BYTES_PER_MS >= config.maxUtteranceMs) u.finish('length cap');
  }

  _tickUtterance(u) {
    if (u.done) return;
    const now = Date.now();
    if (now - (u.lastVoiceAt || u.startedAt) >= u.silence) { u.finish('silence'); return; }
    if (!u.segVoiced) return;
    const segMs = (u.bytes - u.segBytes) / BYTES_PER_MS;
    const gap = now - u.lastVoiceAt;
    if ((segMs >= config.draftMinSegmentMs && gap >= config.draftGapMs) || segMs >= config.draftMaxSegmentMs) {
      this._cutDraftSegment(u);
    }
  }

  // Transcribe the audio since the last cut and append it to the durable draft.
  // Queued in order, so the stitched draft is always in speaking order.
  _cutDraftSegment(u) {
    const pcm = Buffer.concat(u.chunks.slice(u.segIdx));
    const ms = Math.round(pcm.length / BYTES_PER_MS);
    u.segIdx = u.chunks.length;
    u.segBytes = u.bytes;
    u.segVoiced = false;
    const idx = u.segs.push('') - 1;
    u.draftChain = u.draftChain.then(async () => {
      const text = (await transcribeWav(pcmToWav(pcm, { sampleRate: SAMPLE_RATE, channels: CHANNELS }))).trim();
      u.segs[idx] = text;
      if (text) this._appendDraft(u, { seg: idx, ms, text });
    }).catch((e) => log.warn('draft segment transcription failed:', e.message));
  }

  // DURABLE DRAFT: one JSONL file per utterance in config.draftDir, one line per
  // transcribed segment, fsynced on every append — a crash or restart
  // mid-utterance leaves the words so far on disk. Renamed *.sent.jsonl only
  // after 999 accepted the message; only those are ever pruned.
  _appendDraft(u, rec) {
    try {
      if (u.fd == null) {
        fs.mkdirSync(config.draftDir, { recursive: true });
        const stamp = new Date(u.startedAt).toISOString().replace(/[:.]/g, '-');
        u.file = path.join(config.draftDir, `${stamp}-${u.userId}-${u.key.split('-').pop()}.jsonl`);
        u.fd = fs.openSync(u.file, 'a');
      }
      fs.writeSync(u.fd, `${JSON.stringify({ at: new Date().toISOString(), ...rec })}\n`);
      fs.fsyncSync(u.fd);
    } catch (e) {
      log.warn('draft file append failed:', e.message);
    }
  }

  _closeDraft(u, handedOff) {
    if (u.fd == null) return;
    try { fs.closeSync(u.fd); } catch (_) {}
    u.fd = null;
    if (!handedOff) { log.warn(`draft kept (not handed to 999): ${u.file}`); return; }
    try { fs.renameSync(u.file, u.file.replace(/\.jsonl$/, '.sent.jsonl')); } catch (e) { log.warn('draft rename failed:', e.message); }
    this._pruneDrafts();
  }

  // RETENTION: delete *.sent.jsonl drafts older than draftRetentionHours.
  // Unsent drafts (a crash, or 999 refused the message) are never pruned.
  _pruneDrafts(force = false) {
    const now = Date.now();
    if (!force && now - (this._lastPruneAt || 0) < 10 * 60 * 1000) return;
    this._lastPruneAt = now;
    const maxAge = config.draftRetentionHours * 3600 * 1000;
    let names = [];
    try { names = fs.readdirSync(config.draftDir); } catch (_) { return; }
    for (const name of names) {
      if (!name.endsWith('.sent.jsonl')) continue;
      const file = path.join(config.draftDir, name);
      try { if (now - fs.statSync(file).mtimeMs > maxAge) fs.unlinkSync(file); } catch (_) {}
    }
  }

  // A stop: tear down this subscription, re-subscribe if his packets are still
  // arriving (so the NEXT utterance is heard), then send what was captured.
  _finishUtterance(u, reason, receiver, opusStream, decoder) {
    if (u.done) return;
    u.done = true;
    clearInterval(u.timer);
    if (this.utterances.get(u.userId) === u) this.utterances.delete(u.userId);
    this.active.delete(u.userId);
    try { opusStream.unpipe(decoder); } catch (_) {}
    try { decoder.destroy(); } catch (_) {}
    const subs = receiver.subscriptions;
    if (subs && subs.get(u.userId) === opusStream) subs.delete(u.userId);
    try { opusStream.destroy(); } catch (_) {}

    const now = Date.now();
    const durMs = u.bytes / BYTES_PER_MS;
    const thr = config.voiceEnergyThresholdDb;
    const quiet = u.levels.filter((d) => d < thr);
    const loud = u.levels.filter((d) => d >= thr).sort((a, b) => a - b);
    const f = (d) => (d == null ? 'n/a' : d.toFixed(1));
    log.info(`capture end (${u.userId}): ${reason} — ${Math.round(durMs)}ms decoded, ${Math.round(u.voicedMs)}ms above ${thr} dBFS` +
      `, ${u.lastVoiceAt ? now - u.lastVoiceAt : -1}ms since last voice (silence=${u.silence}ms)` +
      ` | levels: loudest sub-threshold ${f(quiet.length ? Math.max(...quiet) : null)}, voice p10 ${f(loud[Math.floor(loud.length * 0.1)])} dBFS`);

    // Packets arrived (that's what started this capture) but nothing decoded:
    // flag it so the health monitor stops trusting speaking events.
    if (u.decoded === 0 && this._decodeHealthy) {
      this._decodeHealthy = false;
      log.warn(`(${u.userId}) packets arrived but nothing decoded — receiver health now tracks decoded audio only.`);
    }

    // Re-subscribe at once while his packets are still arriving — the speaking
    // 'start' event only re-fires after a gap, so waiting would miss speech.
    // Only AFTER the old stream's 'close': the library's close handler deletes
    // subscriptions[userId] by id, and would orphan a newer subscription.
    const flowing = receiver.speaking && receiver.speaking.users && receiver.speaking.users.has(u.userId);
    if (reason !== 'mute' && flowing && this.connection && this.connection.receiver === receiver) {
      const resubscribe = () => {
        if (!this.connection || this.connection.receiver !== receiver) return;
        log.info(`(${u.userId}) packets still arriving — re-subscribing.`);
        this._maybeStartCapture(receiver, u.userId);
      };
      // (`opusStream.closed` flips inside destroy(), a tick BEFORE 'close' fires
      // — so track the event itself.)
      if (u.streamClosed) resubscribe(); else opusStream.once('close', resubscribe);
    }

    if (!u.writing || u.voicedMs < config.minUtteranceMs) {
      if (u.writing) this._writing.delete(u);
      if (durMs > 0) log.info(`(${Math.round(durMs)}ms) nothing above the voice threshold — breathing/noise, not sent.`);
      return;
    }
    // The tail since the last cut becomes the last draft segment.
    if (u.segVoiced) this._cutDraftSegment(u);
    const pcm = Buffer.concat(u.chunks); // kept only for the empty-draft fallback
    u.chunks = [];
    this._deliverUtterance(u, pcm, durMs, reason)
      .catch((e) => log.error('utterance delivery failed:', e.message))
      .finally(() => this._writing.delete(u));
  }

  // SEND the stitched streamed draft. At the stop only the last segment is
  // still being transcribed, so stop→999 no longer grows with utterance length.
  // A whole-clip Whisper pass runs ONLY if the draft came back empty.
  async _deliverUtterance(u, pcm, durationMs, reason) {
    await u.draftChain;
    let text = u.segs.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const wav = text ? null : pcmToWav(pcm, { sampleRate: SAMPLE_RATE, channels: CHANNELS });
    if (!text) {
      text = await this._transcribeUtteranceFile(wav, u.userId);
      if (text) {
        log.warn(`streamed draft empty — sent a whole-clip transcript instead (${text.length} chars).`);
        this._appendDraft(u, { seg: 'fallback', ms: Math.round(durationMs), text });
      }
    }
    if (!text) {
      const { peakDb, rmsDb } = audioLevel(wav);
      const fmt = (d) => (d === -Infinity ? '-inf' : d.toFixed(1));
      const silent = rmsDb < -55;
      log.info(`(${Math.round(durationMs)}ms) empty transcript — peak ${fmt(peakDb)} / rms ${fmt(rmsDb)} dBFS → ${silent ? 'SILENT capture (deaf receiver / muted mic?)' : 'audio present (likely a Whisper miss)'}.`);
      if (config.retainEmptyWav) this._retainWav(wav, u.userId, durationMs);
      this._closeDraft(u, false);
      return;
    }
    log.success(`🎙️  heard ${u.userId} (${Math.round(durationMs)}ms, ${u.segs.length} segment(s), ended by ${reason}): "${text.slice(0, 80)}" → terminal ${this.linkManager.status().managerId || 999}`);
    // Writing is over — release held playback before the ack sound plays.
    this._writing.delete(u);
    try { this.onHeard(text); } catch (e) { log.warn('onHeard mirror failed:', e.message); }
    while (this.busy) await new Promise((r) => setTimeout(r, 40));
    this.busy = true;
    let res = null;
    try {
      res = await this.linkManager.forward(text);
    } finally {
      this.busy = false;
    }
    if (res && res.ok) {
      this._appendDraft(u, { sent: true, chars: text.length });
      this._closeDraft(u, true);
      try { this.onCommandAck(); } catch (_) {}
    } else {
      this._closeDraft(u, false);
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
