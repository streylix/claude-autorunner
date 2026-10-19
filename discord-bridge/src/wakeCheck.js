'use strict';

// Cheap CPU wake-word transcription via the backend's shared Vosk endpoint
// (POST /api/voice/wake-check/). This is the GATE: it runs on every utterance
// but costs almost nothing (CPU Vosk, no GPU), so the expensive GPU Whisper is
// only invoked AFTER the wake word is detected. Reuses the same Vosk model the
// desktop app ships — zero duplicate resources.

const { config } = require('../config');
const log = require('./log');

// Returns Vosk's best-effort transcript of the WAV (for wake-word gating), or ''.
async function wakeCheck(wavBuffer) {
  if (!wavBuffer || !wavBuffer.length) return '';
  const form = new FormData();
  form.append('audio_file', new Blob([wavBuffer], { type: 'audio/wav' }), 'utt.wav');
  try {
    const res = await fetch(`${config.backendUrl}/api/voice/wake-check/`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      log.warn(`wake-check failed (HTTP ${res.status}) — is the backend rebuilt with Vosk?`);
      return '';
    }
    const data = await res.json().catch(() => ({}));
    return (data.text || '').trim();
  } catch (err) {
    log.warn('wake-check request failed:', err.message);
    return '';
  }
}

module.exports = { wakeCheck };
