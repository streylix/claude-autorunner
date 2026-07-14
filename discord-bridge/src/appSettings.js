'use strict';

// Read the auto-injector app's OWN persisted settings so the bridge behaves like
// you're sitting at the computer — same wake word, same enable state, same
// end-of-speech silence. We do NOT duplicate these in .env; we mirror the live
// values from the app's store (re-read when the file changes).
//
// Store location: the Electron app ("auto-injector") persists to
//   ~/.config/auto-injector/auto-injector.json   (Linux userData)
// Settings values are stored JSON-ish (e.g. "true", "sean", "2500", "\"bf_emma\"");
// coerce() recovers the real value.

const fs = require('fs');
const path = require('path');

function storePath() {
  if (process.env.APP_STORE_PATH) return process.env.APP_STORE_PATH;
  const home = process.env.HOME || require('os').homedir();
  return path.join(home, '.config', 'auto-injector', 'auto-injector.json');
}

function coerce(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return v; }
}

let _cache = { mtimeMs: 0, settings: {} };

// Read settings, re-parsing only when the file changes (cheap to call often).
function readSettings() {
  const p = storePath();
  try {
    const st = fs.statSync(p);
    if (st.mtimeMs !== _cache.mtimeMs) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      const raw = data.settings || {};
      const settings = {};
      for (const k of Object.keys(raw)) settings[k] = coerce(raw[k]);
      _cache = { mtimeMs: st.mtimeMs, settings };
    }
  } catch (_) {
    // App not installed here / store unreadable — return whatever we have.
  }
  return _cache.settings;
}

// The wake config, mirrored from the app (env may override for testing only).
function wake() {
  const s = readSettings();
  const envPhrase = process.env.WAKE_PHRASE;
  const envEnabled = process.env.WAKE_WORD_ENABLED;
  const phrase = (envPhrase || s.wakeWordPhrase || 'hey claude').toString().trim().toLowerCase();
  const enabled = envEnabled != null && envEnabled !== ''
    ? /^(1|true|yes|on)$/i.test(envEnabled)
    : (s.wakeWordEnabled != null ? !!s.wakeWordEnabled : true);
  const silenceMs = Math.max(600, Number(s.wakeSilenceMs) || 1000);
  return {
    enabled,
    phrase,
    silenceMs,
    fromApp: s.wakeWordPhrase != null,
    // Wake-acknowledgment sounds, mirrored from the app's WakeWordManager so the
    // channel feedback matches what the user hears at the desktop. Defaults are
    // the app's own defaults (activation: screenshot.wav, stop: hud4.wav).
    activationSound: s.wakeActivationSound || 'screenshot.wav',
    stopSound: s.wakeStopSound || 'hud4.wav',
  };
}

// In-call ALWAYS-LISTEN end-of-speech silence, mirrored LIVE from the app's
// "Stop after silence" slider (wakeSilenceMs) so changing it in the app changes
// how fast a Discord voice memo cuts. When the app has no persisted value we use
// a snappier default than the app's own 5000ms (that suits across-the-room
// dictation; an in-call memo wants ~1.2s). Floor 600ms so it can never be 0.
// IN_CALL_SILENCE_MS env pins it (testing / emergency override only).
function inCallSilenceMs() {
  const env = Number(process.env.IN_CALL_SILENCE_MS);
  if (Number.isFinite(env) && env > 0) return Math.max(600, env);
  const v = Number(readSettings().wakeSilenceMs);
  return Math.max(600, Number.isFinite(v) && v > 0 ? v : 1200);
}

module.exports = { readSettings, wake, inCallSilenceMs, storePath };
