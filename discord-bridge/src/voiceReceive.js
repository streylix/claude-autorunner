'use strict';

// INPUT path: Discord speech -> manager 999.
//
// Subscribes to each speaking user's Opus stream via @discordjs/voice's
// VoiceReceiver, decodes Opus -> 48kHz stereo s16le PCM (prism-media), and on a
// silence gap wraps the PCM in a WAV, transcribes it (Whisper backend), and
// forwards the text to terminal 999 framed as a voice memo.
//
// NOTE ON DAVE: voice-receive is unofficial in @discordjs/voice and its status
// under mandatory DAVE E2EE (March 2026) is the highest-risk part of this build.
// `src/doctor.js` and SETUP.md document how to confirm capture works; if the
// Node path decodes to silence under DAVE, switch RECEIVE_BACKEND to the Python
// fallback (python-receiver/, discord-ext-voice-recv) — see SETUP.md.

const prism = require('prism-media');
const { EndBehaviorType } = require('@discordjs/voice');
const { config } = require('../config');
const { pcmToWav } = require('./wav');
const { transcribeWav } = require('./transcribe');
const { sendVoiceMemoToManager } = require('./controlApi');
const log = require('./log');

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
// bytes of PCM per ms, used to gate out clicks/coughs
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) / 1000;

class VoiceReceiver {
  constructor() {
    this.connection = null;
    this.active = new Set(); // userIds currently being captured (dedupe)
    this.busy = false;       // serialize transcription+inject so memos arrive in order
  }

  attach(connection) {
    this.connection = connection;
    const receiver = connection.receiver;

    // `start` fires when a user begins transmitting. We open one decode pipeline
    // per utterance and close it after the configured silence gap.
    receiver.speaking.on('start', (userId) => {
      if (this.active.has(userId)) return;
      if (config.allowedSpeakerIds.length && !config.allowedSpeakerIds.includes(userId)) return;
      this.active.add(userId);
      this._capture(receiver, userId).catch((err) => {
        log.error('capture error:', err.message);
        this.active.delete(userId);
      });
    });

    log.info('voice receiver attached — listening for speakers.');
  }

  async _capture(receiver, userId) {
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: config.speechEndSilenceMs },
    });

    const decoder = new prism.opus.Decoder({
      rate: SAMPLE_RATE,
      channels: CHANNELS,
      frameSize: 960,
    });

    const chunks = [];
    opusStream.pipe(decoder);
    decoder.on('data', (c) => chunks.push(c));

    await new Promise((resolve) => {
      const done = () => resolve();
      decoder.once('end', done);
      decoder.once('error', (e) => { log.warn('opus decode error:', e.message); done(); });
      opusStream.once('error', (e) => { log.warn('opus stream error:', e.message); done(); });
    });

    this.active.delete(userId);

    const pcm = Buffer.concat(chunks);
    const durationMs = pcm.length / BYTES_PER_MS;
    if (durationMs < config.minUtteranceMs) {
      log.info(`ignored short utterance (${Math.round(durationMs)}ms) from ${userId}.`);
      return;
    }

    log.info(`captured ${Math.round(durationMs)}ms from ${userId} — transcribing.`);
    const wav = pcmToWav(pcm, { sampleRate: SAMPLE_RATE, channels: CHANNELS });
    await this._processSerial(wav, userId);
  }

  // Transcribe + deliver one utterance at a time so memos reach 999 in order.
  async _processSerial(wav, userId) {
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
    this.busy = true;
    try {
      const text = await transcribeWav(wav, { model: 'base' });
      if (!text) {
        log.warn(`empty transcript from ${userId} — not forwarding.`);
        return;
      }
      log.info(`transcript from ${userId}: "${text}"`);
      await sendVoiceMemoToManager(text);
    } finally {
      this.busy = false;
    }
  }
}

module.exports = VoiceReceiver;
