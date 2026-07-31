# SETUP — reference & troubleshooting

For the click-by-click walkthrough, use **DISCORD_SETUP_GUIDE.md**. This file is
the condensed reference, the design rationale, and troubleshooting.

## What you must provide
1. **Bot token** — discord.com/developers → your app → Bot → Reset Token.
2. **Guild (server) ID** — Developer Mode on → right-click server → Copy Server ID.
3. *(optional)* A default voice channel ID — normally unnecessary (the bot joins
   the channel you're in when you `/link`).

Put 1–2 in `.env` (copy from `.env.example`).

## Invite scopes & permissions
Invite the bot (OAuth2 → URL Generator) with:
- **Scopes:** `bot` **and** `applications.commands` (the latter is required for
  the `/link` slash command to register/appear).
- **Permissions:** View Channels + Connect + Speak = **`3146752`**.

Voice-receive needs no extra permission beyond Connect; the bot must not be
server-muted (`selfDeaf:false`/`selfMute:false` are set).

## Run as a persistent service
```bash
./service/install.sh          # systemd --user: install, start, auto-restart
./service/install.sh --boot   # also enable-linger (runs at boot/login)
systemctl --user status  ccbot-discord-bridge
journalctl   --user -u   ccbot-discord-bridge -f
./service/uninstall.sh        # remove
```
The service holds **no app credentials** — it idles until you `/link`, and it is
unaffected by the auto-injector app restarting. No systemd? Fallback:
`nohup node src/index.js > bridge.log 2>&1 &`.

Preflight anytime (no token needed): `node src/doctor.js`.

> **Node version:** `@discordjs/voice@0.19.2` declares `engines.node >=22.12.0`.
> Everything loads/verifies on Node 20, but prefer Node 22+ for the live voice
> run. `install.sh` warns if Node < 22 and uses `$(command -v node)` for the
> unit's `ExecStart`.

## Linking (session key) — how it works
1. The **manager** (terminal 999) holds the live `CCBOT_PORT`/`CCBOT_TOKEN`. It
   runs `npm run link-key` (`tools/make-link-key.js`), which:
   - mints a random, revocable **link-token**;
   - writes the real creds + link-token to a `0600` vault at
     `$XDG_RUNTIME_DIR/ccbot-bridge/vault.json` (loopback/tmpfs, local-only);
   - prints `/link <key>` where the key encodes only `{ port, link-token }`.
2. You paste `/link <key>` in Discord. The bot decodes it, **resolves it against
   the local vault** (reads the real token locally — it never travels through
   Discord), validates against the live control API `/state`, and links.
3. The bot then joins **your current voice channel**.

**Security properties**
- The control **token never leaves the box** — only `{port, link-token}` goes
  through Discord. A key leaked in Discord is useless without local access.
- **Rotatable:** re-running `npm run link-key` mints a new link-token and
  overwrites the vault → the previous key stops resolving immediately. The
  underlying app token is unchanged.
- Creds live in the bot's **memory only**; restarting the service unlinks (paste
  a fresh key). Keys also expire (default 1h; `--ttl <seconds>` to change).
- **Who may drive the manager is an explicit allow-list** —
  `DISCORD_ALLOWED_USER_IDS` gates every slash command and auto-forwarded text
  message, and (unless `ALLOWED_SPEAKER_IDS` overrides it) voice capture too.
  Unset = **deny everything**: guild membership alone is never enough.
- **Threat model — the control token is a full-control capability.** The
  `CCBOT_TOKEN` authorizes `/terminal/keys`, which types raw keystrokes into any
  terminal (at a bare shell that is command execution). Loopback binding + the
  0600 tmpfs vault are the boundary; anything that can read the vault or reach
  the loopback port with the token effectively owns the machine's terminals.
  Treat token compromise as host compromise — rotate with `npm run link-key`
  and never copy the vault off-box.

## Wake word
Only speech starting with the wake phrase is forwarded; the phrase is stripped
and the rest becomes the prompt. Say the phrase alone and the bot listens for
your next sentence.

**The wake word is NOT configured here** — it's mirrored LIVE from the app's own
settings (`wakeWordPhrase`, `wakeWordEnabled`, `wakeSilenceMs` in
`~/.config/auto-injector/auto-injector.json`), so the bridge uses whatever wake
word you've set in the app (change it in the app → the bridge follows). `/status`
shows the current phrase. You can override just for testing with `WAKE_PHRASE` /
`WAKE_WORD_ENABLED` in `.env`, but normally leave them unset.

**Resource sharing (no duplicate Whisper, no constant GPU):** the bridge runs
**no ASR of its own**. It gates each utterance through the backend's cheap **CPU
Vosk** endpoint (`POST /api/voice/wake-check/`), and only when the wake word
fires does it call the backend's **GPU Whisper** (`/api/voice/transcribe/`) for an
accurate command. So idle channel chatter costs only CPU Vosk; the GPU is touched
~once per real command. Knobs: `USE_SHARED_WAKE_GATE` (default on),
`COMMAND_USE_WHISPER` (default on; set **off** for ZERO GPU — uses the Vosk
transcript as the command).

*Why this design:* the `vosk` npm (native) won't build on Node 20/22 (`ffi-napi`),
and `vosk-browser` (WASM) needs browser globals (`Worker`/`AudioContext`), so the
bridge can't run Vosk locally. Instead it reuses the Vosk model the desktop app
already ships, served from the backend on CPU — one Whisper, one Vosk, both in the
backend, zero duplicates.

> **Requires a backend rebuild to activate:** the Vosk endpoint adds the `vosk`
> pip dep and mounts the model. Deploy with `docker compose up -d --build`
> (restarts only the backend — never the Electron app). Until then the bridge
> falls back to the Whisper gate if `USE_SHARED_WAKE_GATE` can't reach the
> endpoint.

## Audio output: `AUDIO_SOURCE`
| Mode | You hear | Muting rule |
|------|----------|-------------|
| `tts` (default) | Manager's TTS voice only. Misses sound effects + wake-up alarm. | **MUTE** in-app playback (toolbar speaker `#notification-mute-btn`) to avoid double audio. |
| `system` | **Everything** the speakers play (TTS + SFX + wake-up song). | **Do NOT mute** — audio must reach the sink to be captured. TTS poller auto-disabled. |

`system` mode needs `parec`/`pacat`/`pactl` (present here) and a reachable
PulseAudio/PipeWire socket. A silent **keepalive** keeps the sink's monitor
continuous (PipeWire suspends idle sinks). Switching the system's default output
device → restart the bridge to re-resolve the monitor. `system` streams the
*entire* output (music, other apps too), not just the manager.

## Verifying / troubleshooting
- `node src/doctor.js` — deps, DAVE, backend, audio tools, vault, and (if run in
  an app terminal) the live control API + manager presence.
- `/status` in Discord — link/voice/audio/wake state.
- Logs: `journalctl --user -u ccbot-discord-bridge -f`, also mirrored to the
  app's `[discord-bridge]` stream (`docker compose logs -f backend`) when
  `FORWARD_LOGS_TO_BACKEND=true`.
- **`/link` says "no active link"** → manager hasn't minted a key (or you're on a
  different machine/UID). Run `npm run link-key` in an app terminal.
- **"key superseded"** → a newer key was minted; use the latest, or re-mint.
- **"control API not reachable"** → the app/session isn't running, or creds are
  stale (app restarted) → mint a fresh key.

## DAVE (mandatory E2EE voice, March 2026) — verify-on-live
`@discordjs/voice@^0.19.2` is pinned because that release fixes the DAVE
voice-**receive** bug (PR #11449); `@snazzah/davey` auto-installs. Playback under
DAVE is maintainer-confirmed. Receive is officially "unofficial" — the fix is
shipped but only fully confirmable live. On the first "hey claude", watch the
logs for `command: "..."` → `memo delivered to terminal 999`.

If receive captures silence/garbage: confirm `npm ls @discordjs/voice` ≥ 0.19.2;
the bot isn't server-muted. The Python path (`discord-ext-voice-recv`) is **not**
a drop-in (doesn't decrypt DAVE; fix unmerged) — see `python-receiver/`.
