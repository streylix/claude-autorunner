# CCBOT Discord Voice Bridge

Talk to the **manager** (terminal 999) of the auto-injector from a Discord voice
channel — from your phone, away from the house — and hear its spoken TTS replies
play back into that channel.

```
                 ┌─────────────────────── discord-bridge (this) ───────────────────────┐
 You (phone) ──▶ │  VoiceReceiver ─▶ Whisper (/api/voice/transcribe) ─▶ /terminal/keys │ ──▶ Manager 999
 Discord VC      │                                                          (framed memo)│
            ◀── │  VoicePlayer  ◀─ WAV ◀─ TtsPoller (/api/tts/notifications) ◀───────────│ ◀── Manager TTS
                 └──────────────────────────────────────────────────────────────────────┘
```

It is a **standalone Node process**. It never touches the Electron app or the
manager PTY except through the documented loopback control API
(`POST /terminal/keys`). Starting or killing this bridge has **zero** effect on
the running app, the manager session, or any alarms.

## Quick start

```bash
cd discord-bridge
cp .env.example .env        # then fill in the 3 Discord values — see SETUP.md
./run.sh                    # installs deps on first run, then starts
```

Preflight without a token: `node src/doctor.js`.

**You must provide:** a Discord bot token, the server (guild) ID, and the voice
channel ID. Step-by-step instructions: **[SETUP.md](./SETUP.md)**.

## How it works

### OUTPUT — manager voice → Discord (`src/ttsPoller.js`, `src/audioPlayer.js`)
- Polls `GET /api/tts/notifications/?after=<lastId>&limit=50` (no auth).
- On startup, **seeds `lastId` from the newest row** so history is not replayed.
- For each new row, fetches `<audio_url>` (a real WAV) and streams it into the
  voice channel via `@discordjs/voice` (ffmpeg-transcoded). Optionally POSTs
  `…/played/`.
- **Double audio:** the in-app player also plays each clip. Mute in-app playback
  while bridging (see SETUP.md → "Avoid double audio").

### INPUT — Discord speech → manager 999 (`src/voiceReceive.js`, `src/transcribe.js`, `src/controlApi.js`)
- Captures each speaker's Opus stream (`VoiceReceiver`), decodes to PCM, and on
  a silence gap wraps it as WAV.
- Transcribes via the app's existing Whisper endpoint
  (`POST /api/voice/transcribe/`, field `audio_file`, no auth).
- Forwards the text to terminal 999 via `POST /terminal/keys` (no 999 block,
  unlike `/queue/add`), framed with the 🎙️ voice-memo marker so the manager
  acknowledges aloud. Multi-line memos use bracketed-paste so they don't submit
  early in Claude's TUI.

## DAVE (mandatory E2EE voice, since March 2026)
- `@discordjs/voice@0.19.2` is pinned **on purpose**: that release (PR #11449)
  fixes the DAVE voice-**receive** bug; 0.19.0/0.19.1 capture broken audio.
- `@snazzah/davey` (the DAVE implementation) auto-installs as a hard dependency
  of voice — no manual wiring. `src/dave.js` just verifies it's present and logs
  the version at startup.
- Sending/playback under DAVE is maintainer-confirmed working. Receive is
  officially "unofficial"; fallback notes in SETUP.md.

## Config
All via `.env` (see `.env.example`). Notable knobs:
`TTS_POLL_INTERVAL_MS`, `MARK_PLAYED`, `SPEECH_END_SILENCE_MS`,
`MIN_UTTERANCE_MS`, `USE_BRACKETED_PASTE`, `ALLOWED_SPEAKER_IDS`,
`FORWARD_LOGS_TO_BACKEND`.

## Files
```
config.js            env loading + validation; exposes the voice-memo marker
src/index.js         orchestrator: login, join voice, wire poller + receiver
src/ttsPoller.js     OUTPUT: poll notifications, seed, download WAVs
src/audioPlayer.js   OUTPUT: FIFO playback into the voice connection
src/voiceReceive.js  INPUT: capture Opus, decode, gate, hand to transcribe
src/transcribe.js    INPUT: WAV -> Whisper backend -> text
src/controlApi.js    INPUT: framed memo -> POST /terminal/keys -> 999
src/wav.js           PCM -> WAV container helper
src/dave.js          DAVE availability check / report
src/log.js           stdout + optional mirror to the app's unified log stream
src/doctor.js        no-token preflight (deps, backend, control API, manager 999)
python-receiver/     notes on the (non-drop-in) discord.py fallback
```

## Logs
With `FORWARD_LOGS_TO_BACKEND=true`, bridge activity also appears in
`docker compose logs -f backend`, tagged `[discord-bridge]`, interleaved with
the rest of the app's timeline.
