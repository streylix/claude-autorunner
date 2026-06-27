# SETUP — what you need to provide to go live

The bridge is fully built and self-tested. To run it live you must create a
Discord bot and hand over **three values**. Follow these steps once.

---

## (a) Create the Discord application + bot, copy the token

1. Go to <https://discord.com/developers/applications> → **New Application**.
   Name it anything (e.g. "Manager Voice Bridge"). Accept the terms.
2. Left sidebar → **Bot**.
   - Click **Reset Token** → **Copy**. This is your `DISCORD_BOT_TOKEN`.
     Treat it like a password — anyone with it controls the bot. It only shows
     once; reset again if you lose it.
   - Under **Privileged Gateway Intents**: the bridge does **not** require any
     privileged intents (it uses Guilds + GuildVoiceStates, which are not
     privileged). You can leave the Presence/Server-Members/Message-Content
     toggles **off**.

## (b) Invite the bot to your server (OAuth2 URL)

1. Left sidebar → **OAuth2** → **URL Generator**.
2. Under **Scopes**, check: **`bot`**.
3. Under **Bot Permissions**, check exactly:
   - **View Channels** (Read Messages/View Channels)
   - **Connect** (join voice)
   - **Speak** (transmit audio — required for the manager's TTS playback)
   - *(optional)* **Use Voice Activity** — on by default for users; harmless.
4. Copy the generated URL at the bottom. It looks like:

   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_APP_ID&permissions=3146752&scope=bot
   ```

   `permissions=3146752` = View Channels + Connect + Speak. (If the generator
   gives a different number because you ticked extra boxes, that's fine.)
5. Open the URL in a browser, pick your server, **Authorize**. The bot now
   appears (offline) in your member list.

> Voice **receive** (hearing you) needs no special Discord permission beyond
> Connect — capturing audio is a client-side capability of the voice
> connection, not a gated permission. The bot must just be able to join and not
> be server-muted.

## (c) Get the guild ID and voice channel ID

1. Discord → **User Settings → Advanced → Developer Mode: ON**.
2. Right-click your **server icon** → **Copy Server ID** → that's
   `DISCORD_GUILD_ID`.
3. Right-click the **voice channel** you'll talk in → **Copy Channel ID** →
   that's `DISCORD_VOICE_CHANNEL_ID`.

---

## Put the three values in `.env`

```bash
cd discord-bridge
cp .env.example .env
# edit .env and set:
#   DISCORD_BOT_TOKEN=...        (from step a)
#   DISCORD_GUILD_ID=...         (from step c)
#   DISCORD_VOICE_CHANNEL_ID=... (from step c)
```

`CCBOT_PORT` / `CCBOT_TOKEN` are inherited automatically when you launch from an
app terminal — leave them blank in `.env`.

---

## Avoid double audio (important)

The Electron app **also** plays each manager TTS clip through your computer
speakers. While using the Discord bridge, **mute in-app playback** so you don't
hear every reply twice:

- In the app toolbar, click the **speaker / "Sound on"** toggle
  (`#notification-mute-btn`, tooltip "Mute / unmute all spoken notifications").
  It flips to **"Muted"**.

This is safe: muting only stops the *local* HTMLAudioElement. The backend still
records every notification, so the bridge's poller keeps receiving and playing
them into Discord. No app restart, no lost messages. Unmute when you're back at
the machine.

---

## Recommended runtime: Node 22+

`@discordjs/voice@0.19.2` declares `engines.node >= 22.12.0`. All modules load
and the non-voice paths are verified on Node 20, but for the **live voice run**
prefer Node 22+ to avoid any runtime API gap during DAVE negotiation. Install
via your version manager (e.g. `nvm install 22 && nvm use 22`) and run from that
shell. (If you stay on Node 20, the bridge will start and warn; test the voice
join and report if negotiation fails.)

---

## Run it

```bash
cd discord-bridge
./run.sh
```

or:

```bash
node src/doctor.js   # preflight: deps, backend, control API, manager 999 (no token needed)
node src/index.js    # start the bridge
```

On success you'll see in the logs (and in `docker compose logs -f backend`,
tagged `[discord-bridge]`):

```
logged in as <bot>#0000.
joined voice channel <id>.
bridge live: manager TTS -> channel, your speech -> terminal 999.
```

Then:
1. Join that voice channel from your phone/desktop.
2. Speak — within a moment the manager (terminal 999) receives your words framed
   as a 🎙️ voice memo and acknowledges aloud; its reply plays back into the
   channel within a few seconds.

---

## If voice-receive captures silence/garbage (DAVE fallback)

Voice-receive is officially "unofficial" in `@discordjs/voice`. The DAVE-receive
bug was fixed in **0.19.2** (PR #11449, RFC3550 padding) — which is what we pin —
and there are no open DAVE-receive issues, but Discord could regress it. If, on
the live test, the manager receives empty/garbled transcripts:

1. Confirm you're on `@discordjs/voice@>=0.19.2` (`npm ls @discordjs/voice`).
2. Make sure the bot is **not** server-muted and `selfDeaf:false` (it is).
3. The Python alternative (`discord.py 2.7.1` + `discord-ext-voice-recv`) is
   **NOT** a drop-in: that extension does not yet decrypt DAVE
   (issue #53 open; fix PR #54 unmerged as of June 2026). Only pursue it if the
   Node path regresses and you can apply PR #54 by hand. See `python-receiver/`.

Playback (manager → channel) under DAVE is confirmed working by the discord.js
maintainers, so the output direction should be solid regardless.
