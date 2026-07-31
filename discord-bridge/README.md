# CCBOT Discord Voice Bridge (standalone)

Wake-word voice control of the **manager** (terminal 999) from a Discord voice
channel — from your phone, away from the house — with the manager's audio
(TTS, or the **whole machine output**: sound effects + the morning wake-up song)
played back into the channel.

```
   You (phone) ──speak──▶ Discord VC ──▶ [BRIDGE: wake-word gate ▶ Whisper] ──▶ /terminal/keys ▶ Manager 999
                              ▲                                                     (via the active link)
                              └──────── system-audio / TTS ◀── [BRIDGE: player] ◀── manager audio
```

It is a **standalone, always-on service** (systemd --user). It holds **no app
credentials at rest** and **survives the auto-injector app restarting**. It
reaches the app only through the documented loopback control API.

## The three ideas

1. **Persistent service.** Runs under systemd --user, auto-restarts, optionally
   starts at boot. Independent of any terminal or the Electron app's lifecycle.
   See `service/` and `DISCORD_SETUP_GUIDE.md`.

2. **Session-key linking (rotatable, local-only).** The bot starts **unlinked**.
   The manager (which holds the live `CCBOT_PORT`/`CCBOT_TOKEN`) runs
   `npm run link-key`, which mints a **revocable link-token**, stores the real
   creds in a `0600` local vault (`$XDG_RUNTIME_DIR/ccbot-bridge/vault.json`,
   loopback/tmpfs), and prints a paste-able `/link <key>`. The key carries only
   `{ port, link-token }` — **never the control token** — so a key leaked
   through Discord is useless without local machine access, and re-running the
   tool **rotates** it (old key dies; app token unchanged). On app restart, paste
   a fresh key. See `src/linkVault.js`, `tools/make-link-key.js`.

3. **Wake word + music-bot join.** `/link` joins the voice channel **you're
   currently in** (like a music bot; `DISCORD_VOICE_CHANNEL_ID` is just a
   fallback). Then only speech beginning with your **wake word** is transcribed
   and forwarded; everything else is ignored. The wake word is mirrored live from
   the app's own settings (not configured here), so it's whatever you've set in
   the app. See `src/appSettings.js`, `src/wakeWord.js`, `src/voiceReceive.js`.

## Slash commands
- `/link <key>` — start session: link to the current manager + join your channel.
- `/leave` — leave voice and unlink.
- `/status` — show link / voice / audio-mode / wake-word state.

(Requires inviting the bot with the `applications.commands` scope.)

## Audio output modes (`AUDIO_SOURCE`)
- `tts` — manager's TTS voice only (polls the notification feed). Mute in-app
  playback to avoid double audio.
- `system` — capture the default sink's `.monitor` and stream **everything** the
  speakers play (TTS + sound effects + wake-up alarm). A silent keepalive keeps
  the monitor continuous; the TTS poller is auto-disabled. Do **not** mute in-app
  playback in this mode.

## Wake-word implementation note
The main app spots the wake word with Vosk (WASM, in the renderer). There is no
working native Vosk for this Node service (`vosk` → `ffi-napi` won't build on
Node 20/22), so the bridge gates with the app's existing **local Whisper**: each
utterance is transcribed locally and only wake-prefixed ones are forwarded. Same
product intent, local-only, no native build. The spotter interface is small so a
Vosk-backed gate can replace it later.

## DAVE (mandatory E2EE voice, since March 2026)
`@discordjs/voice@^0.19.2` is pinned because that release fixes the DAVE
voice-**receive** bug; `@snazzah/davey` auto-installs. Playback under DAVE is
maintainer-confirmed; receive is "unofficial" and verify-on-live (see SETUP.md).

## Files
```
config.js              env + validation (no control creds — those come via /link)
src/index.js           service entry: login, register commands, idle until linked
src/commands.js        /link /leave /status
src/linkManager.js     holds the active link (creds) in memory; forwards to 999
src/linkVault.js       key encode/decode + the local rotatable credential vault
src/session.js         join/leave voice + run the chosen output mode
src/voiceReceive.js    capture -> wake-word gate -> forward
src/wakeWord.js        wake-phrase spotter (Whisper-text gating)
src/transcribe.js      WAV -> local Whisper -> text
src/controlApi.js      framed memo -> POST /terminal/keys (dynamic target)
src/audioPlayer.js     playback (FIFO for TTS; playLive for system audio)
src/systemAudio.js     parec monitor capture + silent keepalive
src/ttsPoller.js       TTS notification poller (tts mode)
src/dave.js  src/wav.js  src/log.js  src/doctor.js
tools/make-link-key.js  RUN IN MANAGER TERMINAL: mint/rotate a /link key
service/                systemd --user unit + install/uninstall
```

## Quick start
See **DISCORD_SETUP_GUIDE.md** (beginner, click-by-click) and **SETUP.md**
(reference). Preflight without a token: `node src/doctor.js`.
