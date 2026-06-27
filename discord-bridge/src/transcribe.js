'use strict';

// Transcribe a WAV buffer using the app's existing Whisper endpoint
// (POST /api/voice/transcribe/, no auth). Reuses the same backend the in-app
// voice-to-prompt feature uses, so we don't ship a second Whisper.
//
// Request: multipart/form-data with `audio_file` (+ optional `model`, `language`).
// Response: { text, transcription_id, ... }.

const { config } = require('../config');
const log = require('./log');

// Transcribe a WAV buffer. `model` defaults to 'base' (balanced). Returns the
// transcript string, or '' on failure / empty result.
async function transcribeWav(wavBuffer, { model = 'base', language } = {}) {
  if (!wavBuffer || !wavBuffer.length) return '';

  const form = new FormData();
  // Node 20+ has global Blob/FormData/fetch.
  form.append('audio_file', new Blob([wavBuffer], { type: 'audio/wav' }), 'memo.wav');
  form.append('model', model);
  if (language) form.append('language', language);

  try {
    const res = await fetch(`${config.backendUrl}/api/voice/transcribe/`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      log.error(`transcribe failed (HTTP ${res.status}): ${err.slice(0, 200)}`);
      return '';
    }
    const data = await res.json().catch(() => ({}));
    const text = (data.text || '').trim();
    if (!text) log.warn('transcribe returned empty text');
    return text;
  } catch (err) {
    log.error('transcribe request failed:', err.message);
    return '';
  }
}

module.exports = { transcribeWav };
