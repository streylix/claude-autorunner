'use strict';

// Central config. Loads .env if present. Philosophy: .env carries ONLY what's
// genuinely Discord/bridge-specific (bot identity + how you want to hear audio).
// Everything behavioural — wake word, enable state, end-of-speech silence — is
// mirrored LIVE from the app's own settings (see appSettings.js), so the bridge
// acts like you're at the computer. Control creds arrive at runtime via /link.
// Infra values (backend URL, timings, paste mode) are fixed sensible defaults,
// overridable by env only for the rare edge case.

const path = require('path');
try {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch (_) { /* dotenv not installed yet */ }

const appSettings = require('./src/appSettings');

function bool(v, dflt) {
  if (v == null || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}
function list(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function runtimeBase() {
  return process.env.XDG_RUNTIME_DIR
    || `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}`;
}

const config = {
  // ── .env: Discord identity (required) ──
  discordToken: process.env.DISCORD_BOT_TOKEN || '',
  guildId: process.env.DISCORD_GUILD_ID || '',

  // ── .env: optional ──
  voiceChannelId: process.env.DISCORD_VOICE_CHANNEL_ID || '', // fallback only; normally joins your channel
  allowedSpeakerIds: list(process.env.ALLOWED_SPEAKER_IDS),
  // AUTHORIZATION allow-list: Discord user IDs permitted to drive the manager
  // (slash commands + auto-forwarded text). The manager (terminal 999) is a
  // privileged local agent, so guild membership alone is NOT enough. When this
  // is UNSET the bridge DENIES all commands by default (see src/auth.js) and
  // tells the user their ID so they can allow themselves. Comma-separated.
  allowedUserIds: list(process.env.DISCORD_ALLOWED_USER_IDS),

  // ── .env: how you hear the manager ──
  // 'system' (default): the whole machine output — TTS + sound effects + wake-up
  // alarm. 'tts': manager's TTS voice only.
  audioSource: (process.env.AUDIO_SOURCE || 'system').trim().toLowerCase(),

  // ── Fixed defaults (env override only if you must) ──
  backendUrl: (process.env.BACKEND_URL || 'http://localhost:8123').replace(/\/$/, ''),
  pulseServer: process.env.PULSE_SERVER || `/run/user/${process.getuid ? process.getuid() : 1000}/pulse/native`,
  systemAudioDevice: (process.env.SYSTEM_AUDIO_DEVICE || '').trim(),
  systemAudioKeepalive: bool(process.env.SYSTEM_AUDIO_KEEPALIVE, true),
  systemAudioWarmupMs: int(process.env.SYSTEM_AUDIO_WARMUP_MS, 1200),
  // How long the speaker stays "armed" after the wake word fires alone, waiting
  // for the command utterance. Generous so the user can react to the wake sound
  // and then speak without the arm expiring.
  wakeFollowupMs: int(process.env.WAKE_FOLLOWUP_MS, 10000),
  minUtteranceMs: int(process.env.MIN_UTTERANCE_MS, 200),
  // End-of-speech silence for utterance segmentation. SHORT while listening for
  // the wake word (snappy detection → the wake sound fires ~immediately), LONGER
  // once we're capturing the actual command so a mid-sentence pause doesn't cut
  // the user off. (NOT tied to the app's wakeSilenceMs, which made detection
  // wait ~4.5s.)
  wakeListenSilenceMs: int(process.env.WAKE_LISTEN_SILENCE_MS, 700),
  commandSilenceMs: int(process.env.COMMAND_SILENCE_MS, 2000),
  // ALWAYS-LISTEN (in-call): while the bot is in a voice channel and the mic is
  // unmuted, capture every utterance with NO wake word (muting the mic is the off
  // switch). Each utterance is buffered to a file and transcribed once at its
  // end-of-speech silence boundary (deferred Whisper, never streaming).
  alwaysListenInCall: bool(process.env.ALWAYS_LISTEN_IN_CALL, true),
  inCallSilenceMs: int(process.env.IN_CALL_SILENCE_MS, 1500),
  // Absolute backstop on a single CONTINUOUS capture (no silence gap). High
  // enough that real speech — including long monologues — is never cut; the
  // AfterSilence VAD already segments normal speech at pauses well below this.
  maxUtteranceMs: int(process.env.MAX_UTTERANCE_MS, 180000),
  // DEAF-RECEIVER auto-recovery. The Discord voice receiver can silently stop
  // delivering audio while the connection stays "Ready" (a known voice quirk,
  // often after a mute/unmute or a network blip). We watch for "Ready + an
  // unmuted non-bot member present + no audio for a while" and recover: a light
  // re-subscribe first, then a full leave+rejoin, with cooldown + a hard cap so
  // it never thrashes. Everyone quiet/muted is NOT treated as a fault.
  receiverHealthEnabled: bool(process.env.RECEIVER_HEALTH_ENABLED, true),
  receiverHealthIntervalMs: int(process.env.RECEIVER_HEALTH_INTERVAL_MS, 10000),
  receiverStallMs: int(process.env.RECEIVER_STALL_MS, 45000),        // after audio was flowing
  receiverColdStallMs: int(process.env.RECEIVER_COLD_STALL_MS, 120000), // never heard anything yet
  receiverRecoverCooldownMs: int(process.env.RECEIVER_RECOVER_COOLDOWN_MS, 15000),
  receiverMaxRejoins: int(process.env.RECEIVER_MAX_REJOINS, 3),
  // On an EMPTY transcript, log the clip's duration + audio level (RMS/peak) so a
  // silent capture (deaf receiver) is distinguishable from a Whisper miss; set
  // RETAIN_EMPTY_WAV=1 to keep that one WAV on disk for inspection.
  retainEmptyWav: bool(process.env.RETAIN_EMPTY_WAV, false),
  // BARGE-IN: capture the user's OWN per-user receive stream even WHILE the bot
  // is playing TTS. Discord voice receive is per-user; the bot's TTS is OUTPUT (a
  // separate stream) and is never in the user's receive stream — so capturing
  // during playback hears the user, not the bot. Default OFF (no pause) so there
  // is NO dead zone during or after playback. Set PAUSE_CAPTURE_DURING_TTS=1 to
  // restore the old pause (e.g. on open speakers where acoustic echo is a problem).
  pauseCaptureDuringTts: bool(process.env.PAUSE_CAPTURE_DURING_TTS, false),
  // How long after TTS to keep SUPPRESSING deaf-receiver recovery (NOT capture) —
  // so a long reply with the user silent isn't mistaken for a deaf receiver.
  echoGuardTailMs: int(process.env.ECHO_GUARD_TAIL_MS, 500),
  defaultTtsMs: int(process.env.DEFAULT_TTS_MS, 4000),           // fallback TTS length if duration_ms missing
  // HARD FAILSAFE: the gate can NEVER stay closed longer than this, no matter
  // what duration_ms says — so a long/garbled/missing value can't wedge capture
  // off forever. Comfortably covers real spoken replies (~60s) with margin.
  botSpeakingMaxMs: int(process.env.BOT_SPEAKING_MAX_MS, 90000),
  sfxGateMs: int(process.env.SFX_GATE_MS, 1500),                 // gate window for a short SFX/ack sound
  // BARGE-IN: don't START a TTS clip while the user is still talking (tts mode,
  // where the bridge owns the player) — hold it until a short silence gap.
  bargeInEnabled: bool(process.env.BARGE_IN_ENABLED, true),
  userSpeakingGraceMs: int(process.env.USER_SPEAKING_GRACE_MS, 600), // treat user as "still talking" this long after last audio
  bargeInMaxHoldMs: int(process.env.BARGE_IN_MAX_HOLD_MS, 8000),     // safety: play anyway after holding this long
  // Mirror voice activity into a Discord TEXT channel ("Heard:" what you said,
  // "Replied:" the manager's response). Channel resolves: DISCORD_TEXT_CHANNEL_ID
  // → an existing channel named textChannelName → create it (needs Manage
  // Channels). Graceful if none works (voice keeps running).
  textMirrorEnabled: bool(process.env.TEXT_MIRROR_ENABLED, true),
  textChannelId: process.env.DISCORD_TEXT_CHANNEL_ID || '',
  textChannelName: (process.env.DISCORD_TEXT_CHANNEL_NAME || 'claude-voice').trim(),
  // IMAGE SENDING: the manager drops a tiny JSON descriptor { image, caption }
  // into this local outbox dir (same shared runtime dir as the link vault — the
  // existing manager↔bridge local channel); the bridge watches it and posts the
  // image as a Discord attachment into the text-mirror channel. No backend change.
  imageOutboxDir: process.env.CCBOT_IMAGE_OUTBOX || path.join(runtimeBase(), 'ccbot-bridge', 'outbox'),
  // INBOUND media (user → manager): /prompt attachments and plain image/VIDEO drops
  // are downloaded here so the manager (same machine) can open them.
  mediaInboxDir: process.env.CCBOT_MEDIA_INBOX || path.join(runtimeBase(), 'ccbot-bridge', 'inbox'),
  inboundMediaMaxBytes: int(process.env.INBOUND_MEDIA_MAX_BYTES, 25 * 1024 * 1024), // Discord upload cap
  inboundMaxMedia: int(process.env.INBOUND_MAX_MEDIA, 10),
  // Plain image/video DROPS in the channel need the privileged Message Content
  // gateway intent (attachments aren't delivered without it) — must ALSO be enabled
  // in the Discord developer portal. /prompt with an attachment works either way.
  enableMessageContent: bool(process.env.ENABLE_MESSAGE_CONTENT, true),
  imagePollIntervalMs: int(process.env.IMAGE_POLL_INTERVAL_MS, 1000),
  imageDescriptorTtlMs: int(process.env.IMAGE_DESCRIPTOR_TTL_MS, 300000), // drop stale descriptors after 5 min
  imageMaxBytes: int(process.env.IMAGE_MAX_BYTES, 8 * 1024 * 1024),       // Discord free-tier safe limit
  imageMaxWidth: int(process.env.IMAGE_MAX_WIDTH, 1920),                  // downscale target if oversized
  // VIDEO SENDING: same outbox channel as images/text. The manager drops a
  // { video, caption } descriptor; the bridge re-encodes it with ffmpeg to fit
  // under Discord's upload cap (H.264 mp4 + AAC, iteratively clamping bitrate /
  // downscaling) and posts it as an attachment. Cap is per-server-boostable, so
  // it's configurable via env or a per-descriptor override from the CLI.
  videoMaxBytes: int(process.env.CCBOT_VIDEO_MAX_BYTES || process.env.VIDEO_MAX_BYTES, 8 * 1024 * 1024),
  videoMaxWidth: int(process.env.VIDEO_MAX_WIDTH, 1280),                  // downscale ceiling when re-encoding
  videoAudioBitrateK: int(process.env.VIDEO_AUDIO_BITRATE_K, 96),        // AAC audio budget (kbit/s)
  videoEncodePreset: (process.env.VIDEO_ENCODE_PRESET || 'veryfast').trim(),
  // ffmpeg/ffprobe binaries. System ffmpeg (libx264 + aac) is preferred; the
  // bundled ffmpeg-static is the fallback (see textMirror). ffprobe has no static
  // fallback, so duration is parsed from ffmpeg's own output if it's missing.
  ffmpegPath: (process.env.FFMPEG_PATH || '/usr/bin/ffmpeg').trim(),
  ffprobePath: (process.env.FFPROBE_PATH || '/usr/bin/ffprobe').trim(),
  // Vosk garbles short wake NAMES ("sean" -> "sure"/"shawn"), which would drop a
  // valid wake+command. When the cheap Vosk gate doesn't clearly contain the
  // wake word, escalate utterances UP TO this long to GPU Whisper to confirm the
  // wake word before giving up. Set 0 to disable (pure GPU-saving mode).
  wakeEscalateMaxMs: int(process.env.WAKE_ESCALATE_MAX_MS, 12000),
  // After the bot plays a manager reply, briefly capture the user's reply WITHOUT
  // requiring the wake word (mirrors the app's auto-wake-after-notification).
  autoReplyWindowMs: int(process.env.AUTO_REPLY_WINDOW_MS, 6000),
  // Gate the wake word with the backend's cheap CPU Vosk endpoint so the GPU
  // Whisper only runs after the wake word fires (default on — saves the GPU).
  useSharedWakeGate: bool(process.env.USE_SHARED_WAKE_GATE, true),
  // After the wake word fires, re-transcribe that one utterance with Whisper for
  // an accurate command. Set false for ZERO GPU (use the Vosk transcript as-is).
  commandUseWhisper: bool(process.env.COMMAND_USE_WHISPER, true),
  ttsPollIntervalMs: int(process.env.TTS_POLL_INTERVAL_MS, 1500),
  markPlayed: bool(process.env.MARK_PLAYED, true),
  // Delay between writing the command text and sending the Enter to terminal 999
  // (mirrors the app's 150ms; separate keystroke so the TUI submits, see controlApi).
  submitDelayMs: int(process.env.SUBMIT_DELAY_MS, 180),
  forwardLogsToBackend: bool(process.env.FORWARD_LOGS_TO_BACKEND, true),
};

// Live wake config, mirrored from the APP (not .env). Call fresh — it re-reads
// the app's settings file when it changes, so changing your wake word in the app
// just works here too.
config.wake = () => appSettings.wake();

// Framing markers so the manager can tell HOW the input arrived. Voice keeps the
// original wording (the manager's CLAUDE.md watches for it). Typed = verbatim text
// (no "spoken/transcribed" language). File = an attachment saved to a local path.
config.voiceMemoMarker =
  '🎙️ Voice memo from the user (spoken aloud, auto-transcribed — phrasing may be imperfect):';
config.typedMemoMarker = '💬 Typed message from the user (Discord):';
config.fileMemoMarker = '📎 The user sent'; // + " a file/N files (Discord): <paths>"

function validate(cfg = config) {
  const problems = [];
  if (!cfg.discordToken) problems.push('DISCORD_BOT_TOKEN is missing (.env).');
  if (!cfg.guildId) problems.push('DISCORD_GUILD_ID is missing (.env) — needed to register slash commands and join voice.');
  return problems;
}

module.exports = { config, validate };
