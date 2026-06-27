'use strict';

// Central config: load .env (if present), then fall back to the process env that
// the launching app terminal already exports (CCBOT_PORT / CCBOT_TOKEN). Values
// from a real .env win over inherited env for the Discord-specific keys, but the
// CCBOT_* control credentials prefer the inherited env (that's the live token).

const path = require('path');
try {
  // dotenv is optional at parse time so `node --check` works pre-install.
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) { /* dotenv not installed yet — rely on process.env */ }

function bool(v, dflt) {
  if (v == null || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}
function list(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  // Discord
  discordToken: process.env.DISCORD_BOT_TOKEN || '',
  guildId: process.env.DISCORD_GUILD_ID || '',
  voiceChannelId: process.env.DISCORD_VOICE_CHANNEL_ID || '',
  allowedSpeakerIds: list(process.env.ALLOWED_SPEAKER_IDS),

  // Backend (Django) — TTS notifications + Whisper transcription
  backendUrl: (process.env.BACKEND_URL || 'http://localhost:8123').replace(/\/$/, ''),

  // Control API (Electron HookServer for terminal 999). Inherited from the
  // launching terminal by default.
  ccbotPort: int(process.env.CCBOT_PORT, NaN),
  ccbotToken: process.env.CCBOT_TOKEN || '',
  managerTerminalId: int(process.env.MANAGER_TERMINAL_ID, 999),

  // Behaviour
  ttsPollIntervalMs: int(process.env.TTS_POLL_INTERVAL_MS, 1500),
  markPlayed: bool(process.env.MARK_PLAYED, true),
  speechEndSilenceMs: int(process.env.SPEECH_END_SILENCE_MS, 900),
  minUtteranceMs: int(process.env.MIN_UTTERANCE_MS, 400),
  useBracketedPaste: bool(process.env.USE_BRACKETED_PASTE, true),
  forwardLogsToBackend: bool(process.env.FORWARD_LOGS_TO_BACKEND, true),
};

// The framing marker the manager's CLAUDE.md expects so it acknowledges aloud.
config.voiceMemoMarker =
  '🎙️ Voice memo from the user (spoken aloud, auto-transcribed — phrasing may be imperfect):';

config.controlApiBase = Number.isFinite(config.ccbotPort)
  ? `http://127.0.0.1:${config.ccbotPort}`
  : null;

// Validate and return a list of human-readable problems (empty = good to go).
function validate(cfg = config) {
  const problems = [];
  if (!cfg.discordToken) problems.push('DISCORD_BOT_TOKEN is missing (.env).');
  if (!cfg.guildId) problems.push('DISCORD_GUILD_ID is missing (.env).');
  if (!cfg.voiceChannelId) problems.push('DISCORD_VOICE_CHANNEL_ID is missing (.env).');
  if (!Number.isFinite(cfg.ccbotPort)) {
    problems.push('CCBOT_PORT not found — launch the bridge from an app terminal, or set it in .env.');
  }
  if (!cfg.ccbotToken) {
    problems.push('CCBOT_TOKEN not found — launch the bridge from an app terminal, or set it in .env.');
  }
  return problems;
}

module.exports = { config, validate };
