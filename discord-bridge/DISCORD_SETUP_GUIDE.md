# Discord Voice Bridge — Step-by-Step Setup Guide

Beginner-friendly, click-by-click. Do the parts in order.

## The mental model (read this first)

- **The bot is its own always-running background service** on this machine
  (managed by systemd). You install it once; it stays up on its own and even
  **survives the auto-injector app restarting**. It is NOT tied to any terminal.
- The bot starts **"unlinked"** — logged into Discord but not yet connected to
  your manager session. That's on purpose: the manager's credentials change
  every session, so you **link** the bot to the *current* session on demand.
- **Linking** = you ask the manager for a short **key**, paste `/link <key>` in
  Discord, and the bot (a) connects to this session and (b) **hops into the
  voice channel you're currently in**, like a music bot.
- The **TOKEN** (Part A) is just the bot's Discord password — it lets the program
  log into Discord. The **link key** (Part C) is a separate, throwaway secret
  that connects the bot to your manager. They're different things.

So: **Part A** = create the bot on Discord's site. **Part B** = install the
service on this machine. **Part C** = link + talk.

---

## PART A — Discord Developer Portal (web browser)

1. Go to **<https://discord.com/developers/applications>**, log in.
2. **New Application** → name it (e.g. `Manager Voice Bridge`) → **Create**.
3. Left sidebar → **Bot**.
4. **Copy the BOT TOKEN:** click **Reset Token** → confirm → **Copy**.
   - Shown once. Save it now (Part B). Lost it? Just **Reset Token** again.
   - 🔒 Secret — anyone with it controls your bot.
5. **Privileged Gateway Intents** (scroll down on the Bot page): leave them all
   **OFF**. This bridge needs none.
6. **Invite the bot.** Easiest is to build the invite URL by hand — copy your
   **Application ID** (Portal → **General Information → Application ID**) into:
   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=3146752
   ```
   - `scope=bot+applications.commands` → the bot plus the `/link` slash command.
   - `permissions=3146752` → View Channels + Connect + Speak.
   - **No redirect URI is needed** — that's only for "Sign in with Discord" web
     logins, which this bridge doesn't use. The bot connects *out* to Discord
     with its token; Discord never calls into your machine, so there's nothing to
     host.
   - *(Prefer the OAuth2 → URL Generator UI? Same scopes/permissions. If it
     refuses to generate without a redirect, add a throwaway `http://localhost`
     under OAuth2 → Redirects and select it — it's never actually used.)*
7. **Paste the URL** into your browser, pick **your server**, **Authorize**. The
   bot appears in your server (offline until Part B). *(After authorizing you may
   see a blank/"can't connect" page if you used a localhost redirect — ignore it;
   the bot is already added.)*
8. **Developer Mode + IDs:** Discord app → **User Settings → Advanced →
   Developer Mode ON**. Then right-click your **server icon → Copy Server ID**
   (that's your guild ID). *(You do NOT need a channel ID — the bot joins
   whatever voice channel you're in. A fixed channel is optional.)*

✅ End of Part A: you have a **bot token** and a **server (guild) ID**.

---

## PART B — Install the bot as a service (on this machine)

> Do this in the `discord-bridge` terminal. You only do it once.

1. Go to the folder and create your settings file:
   ```bash
   cd /media/ethan/smalls/claude-autorunner/discord-bridge
   cp .env.example .env
   ```
2. Edit **`.env`** and set the two values from Part A:
   ```ini
   DISCORD_BOT_TOKEN=paste-your-bot-token
   DISCORD_GUILD_ID=paste-your-server-id
   ```
   - **Recommended** (so you also hear sound effects + the wake-up alarm, not
     just the manager's voice):
     ```ini
     AUDIO_SOURCE=system
     ```
   - Leave `DISCORD_VOICE_CHANNEL_ID` blank (the bot joins your current channel).
   - Save. `.env` is git-ignored — your token never gets committed.
3. **Install + start the always-on service:**
   ```bash
   ./service/install.sh          # install, start, auto-restart
   ./service/install.sh --boot   # ...and also start at boot/login
   ```
   It installs dependencies on first run. From now on the bot runs in the
   background regardless of this terminal.
4. Check it's alive and watch its logs:
   ```bash
   systemctl --user status ccbot-discord-bridge
   journalctl --user -u ccbot-discord-bridge -f
   ```
   You should see `logged in as ...`, `slash commands registered`, and
   `IDLE and ready`.

> No systemd? Fallback: `nohup node src/index.js > bridge.log 2>&1 &`.

---

## PART C — Link a session and talk

You repeat this whenever you want to connect (and after the app restarts).

1. **Get a link key from the manager.** Ask the manager (terminal 999) to
   generate one — it runs:
   ```bash
   npm run link-key          # i.e. node tools/make-link-key.js
   ```
   It prints a line like:
   ```
   /link eyJ2IjoxLCJwb3J0Ijoz...
   ```
   *(You can also run that yourself in any app terminal — it reads the live
   `CCBOT_*` creds from the environment.)*
2. **Join a voice channel** in your Discord server (on your phone or desktop).
3. **Paste the `/link ...` command into any text channel** and send it.
   - The bot replies (only you can see it): **“Linked ✅ … Joined #your-channel.”**
   - It hops into your voice channel. (Confirm: the bot shows as connected there.)
4. **Talk.** Say your **wake word** (whatever you've set in the app — currently
   **“sean”**) then your request, e.g.:
   > **“Sean, what's the build status?”**
   - Only speech starting with your wake word is sent to the manager; anything
     else is ignored. (You can also say just the wake word, wait, then speak.)
   - The bridge uses the app's wake word automatically — change it in the app and
     the bridge follows. `/status` shows the current word.
   - The manager receives it as a 🎙️ voice memo, answers out loud, and you hear
     the reply in the channel. In `AUDIO_SOURCE=system` mode you also hear sound
     effects and the wake-up song.
5. **Other commands:** `/status` (show link/voice/audio state), `/leave` (leave
   voice + unlink).

### Refresh / rotate the key (if it leaks, or anytime)
Just have the manager run `npm run link-key` again. The new key replaces the old
one — the previous key **immediately stops working**. Paste the new `/link ...`.
(The underlying app token never changes; only the throwaway link-token rotates.)

### After the auto-injector app restarts
The session creds change, so the bot's old link goes stale. Get a **fresh** key
from the manager and `/link` again. The bot service itself keeps running — no
reinstall.

### Stopping / restarting the bot service
```bash
systemctl --user stop    ccbot-discord-bridge
systemctl --user restart ccbot-discord-bridge
```
This never affects the auto-injector app or the manager.

---

## One honest caveat — DAVE voice encryption
Discord made voice **end-to-end encrypted (DAVE)** mandatory in March 2026.
Playback (you hearing the manager) is confirmed working with our pinned library.
**Voice-receive** (the bot capturing your mic) uses an upstream fix that's
shipped, but it's only fully **confirmable on a live test**. On your first
wake-word command, watch the logs (`journalctl --user -u ccbot-discord-bridge -f`):
you should see `wake word … command: "..."` then `memo delivered to terminal 999`.
If the transcript is empty/garbled, tell us — that's the one verify-on-live piece
(fallback notes in SETUP.md).

---

## Quick reference

| You need | Where it goes |
|----------|---------------|
| Bot token (Part A.4) | `.env` → `DISCORD_BOT_TOKEN` |
| Server ID (Part A.8) | `.env` → `DISCORD_GUILD_ID` |
| Install service | `./service/install.sh` |
| Link key (per session) | manager runs `npm run link-key` → paste `/link <key>` |
| Talk | join VC, say your wake word (app's — “sean, …”) |
| Rotate key | manager re-runs `npm run link-key` |
| Stop bot | `systemctl --user stop ccbot-discord-bridge` |
