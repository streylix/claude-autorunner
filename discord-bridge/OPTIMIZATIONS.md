# Optimizations / Changes Log

## 2026-10-13 — T796: start a NEW thread with `--new-thread "<name>"`

Follow-up to T792, which could post into an existing thread by id but not start one.

- **`--new-thread "<name>"` on `tools/post-text.js`, `post-image.js`, `post-file.js`**, optionally
  with `--channel <name|id>` as the parent (default `#claude-voice`). The descriptor carries
  `newThread`; `imageOutbox._deliver` routes it through the new `textMirror.threadFor()`.
- **Create or reuse.** `threadFor` fetches the parent's ACTIVE threads and reuses one with the
  exact same name in that same parent (joining it if the bot isn't a member, so his replies
  reach the manager); otherwise it creates a public thread (24h auto-archive). One in-flight
  lookup per parent+name, so two quick posts can't create it twice. Thread names keep their
  spelling (spaces and capitals are fine); empty or over 100 chars is refused.
- **Never falls back.** Unlike a plain `--channel`, a failure here REFUSES the post with the
  reason (exit 1) instead of quietly posting to `#claude-voice`: an unknown parent id, a parent
  that is itself a thread, or a missing permission. Permissions are checked BEFORE creating, and
  the reason names them exactly: "Create Public Threads" / "Send Messages in Threads".
- **Output.** The result carries `threadId`, `threadName`, `parent`, `created`; the CLI prints
  `✅ Posted to thread "x" (id N, created|reused) in #parent` and a `thread id: N` line. Both
  still contain "Posted to", so `bin/tell`'s success check would match it.
- **Not in `bin/tell`.** It runs the aci-serve CLI copy, which has no `--new-thread`; there the
  flag would be read as message text. Use `node tools/post-text.js --new-thread …` from this tree.

**Tests first.** `src/textMirror.newThread.test.js`, 15 tests (create, reuse-by-name incl. join
and different-parent and a concurrent race, parent by name/id/unknown id/thread, both missing
permissions, a file post, the CLI flag). All 15 failed before the code. Suite 261 → 276, 0 failing.

**Live.** Permissions computed from the bot's roles and #claude-voice overwrites: Create Public
Threads ✅, Send Messages in Threads ✅, Manage Threads ✗. Restarted once (pid 3681578). A first
`--new-thread t796-test` created thread `<thread id>` and the second post reused that id;
the Discord API shows both messages in it and the bot as a thread member. Archived it afterwards
(as its creator; Manage Threads was not needed). Not committed.

## 2026-10-13 — T792: read his messages in any channel or thread; reply inside threads; per-channel off switch

**Before.** Only `#claude-voice` was read: the `messageCreate` handler returned on any other
channel. Posting elsewhere was possible by NAME (`--channel rma-drafts`), but a thread has no
name you can create, so there was no way to answer inside one.

**Inbound — any text channel or thread.**
- `src/channelRouting.js` (new, pure): `routeInbound()` decides each message. `#claude-voice`
  (or `DISCORD_TEXT_CHANNEL_ID`) → forwarded with **no origin**, so its wrapper is byte-for-byte
  what it was. Any other text channel or thread → forwarded with an origin, which `frameMemo`
  puts inside the existing `(Discord…)` of the wrapper:
  `💬 Typed message from the user (Discord thread "plans" (id 300) in #general; reply there with --channel 300): "…"`.
  `originMeta()` writes the same facts (`channel`, `channelId`, `thread`, `threadId`) into the
  conversation log's meta; main-channel rows keep exactly the meta they had.
- `src/inboundText.js` (new): the `messageCreate` handler moved out of `index.js` unchanged in
  every guard (dedupe, own-message, bot/webhook, guild, allow-list, attachments, skipped-file
  notice, reply context, ✅/❌ react) so it can be tested end to end with fakes. The only new
  step is the route check, placed BEFORE `linkManager.forward` (which writes the log).
- `src/index.js`: the bot joins every thread so their messages arrive: new ones on
  `threadCreate`, already-active ones once at login (`fetchActiveThreads`). Voice, the echo gate
  and the watch-only "Replied:" poller are untouched.

**Outbound — `--channel <name|id>`.** `textMirror.channelFor()` now treats a 17–20 digit value
as a channel or THREAD id: fetched via `guild.channels.fetch(id)` (which returns threads too),
never created; an unknown id falls back to the default channel with a reason, as a failed name
always did. Names keep resolve-or-create. The CLI needed no logic change (`sanitizeChannelName`
leaves digits alone), so `TELL_CHANNEL=<thread id> bin/tell` works through the
`aci-serve` CLI copy that `bin/tell` invokes too. Only usage text changed in the three post tools.

**Per-channel off switch.** `/manager-ignore`, `/manager-listen`, `/manager-channels`, run inside
the channel or thread they act on. State lives in `channel-ignore.json` next to the bridge
(`CHANNEL_IGNORE_PATH` overrides; gitignored), written atomically, read at startup; a corrupt
file starts empty with a warning. A thread follows its parent channel unless it has its own
entry, so `/manager-listen` inside a thread of an ignored channel re-enables just that thread.
`#claude-voice` is refused ("is the main channel and can't be ignored"). Ignored channels are
dropped before forwarding, so they are neither forwarded nor logged, and get no reaction.

**Tests first.** 41 new: `src/channelRouting.test.js` (27), `src/textMirror.threads.test.js` (6),
`src/commands.channels.test.js` (8). Before the code: the thread-id file failed 5 of 6 (the
create-by-name case already passed); the other two failed on the missing modules. Suite
220 → 261 passing, 0 failing.

**Live.** Restarted once (pid 3168386): logged in, `text mirror → #claude-voice (existing)`, and
it joined the existing thread "nyc november". Created `#t792-test` by name, then a `t792-test`
thread in it (bridge logged `joined thread "t792-test"`); posted into the thread by its id and
into the channel by its id, and checked each message was in the right place through the Discord
API. Ran one `bin/tell -` to `#claude-voice`. Deleted the test channel (its thread went with it;
deleting the thread alone got 403 because the bot lacks Manage Threads). Not committed.

**Known limits.** The "typing…" indicator still shows in `#claude-voice`, also for messages from
other channels. Private threads the bot isn't added to can't be joined.

## 2026-10-01 — T521: the bridge leaves the call when the user does, and sends no audio while he's out

The user's request, verbatim: "if i leave the call you should leave too and also know not
to send audio messages."

**Today's gap (before this fix).** `voiceStateUpdate` in `src/index.js` only ever did two
things with a state change: track mute (`receiver.setMute`) and auto-follow a join. Nothing
watched for the authorized user *leaving* — so once connected, the bridge stayed connected
and kept streaming audio into the channel (system-audio relay, the TTS→sink shim, TTS clip
playback in tts-mode, and SFX acks) regardless of whether he was still in it. There is no
outbound "audio file attachment" path in this codebase — outbound media is image/video only
(`imageOutbox.js`, `textMirror.js`); the `audio` kind in `mediaInbox.js`/`replyContext.js` is
inbound-only (user → manager).

- **`src/voiceFollowGuard.js` (new)** — two pure decision functions, unit-tested without any
  live Discord connection:
  - `userLeftTrackedChannel()` — true when the *authorized* user's old channel was the one
    we're bridging and their new one isn't (covers both a full leave and a move to another
    channel). False for anyone else, and false if they were never in our channel.
  - `shouldAutoFollow()` — the pre-existing auto-join-on-join condition, extracted verbatim
    (unchanged behavior) so it's covered by the same tests as the new leave guard (c4).
- **`src/index.js`** — `voiceStateUpdate` now checks `userLeftTrackedChannel()` first and
  calls `session.leave()` when it fires, before the (now `shouldAutoFollow()`-driven)
  auto-follow check. A new always-on `TtsPoller` (`watchOnly: true`) is created once at
  startup — independent of `session.join()`/`leave()` — whose only job is posting the
  written "Replied:" copy (`src/replyMirror.js`, new) for every terminal-999 TTS
  notification, so that copy survives the bridge leaving. Logs
  `voice leave-on-leave armed — the bridge disconnects (and sends no audio) when the
  authorized user leaves its channel.` at startup.
- **`src/session.js`** — new `canPlayAudio()` (`!!(this.connection && this.player)`): the
  single gate every outbound-audio path now checks. Added as an explicit, defense-in-depth
  re-check inside the tts-mode `onClip` and the system-mode `_playTtsToSink()` (on top of
  `leave()` already tearing the poller/capture/player down), and removed the
  `textMirror.postReplied()` call from `onManagerSpeech` (that duty moved to the new
  always-on poller in `index.js`, so it isn't posted twice while connected).

Auto-rejoin (c4) needed no new mechanism: the pre-existing auto-follow join (now driven by
`shouldAutoFollow()`) already joins the authorized user's channel whenever the bridge is
linked and idle — which `session.leave()` now correctly leaves it in, so rejoining is just
him joining a voice channel again, no manual step.

Tests: new `src/voiceFollowGuard.test.js` (11), `src/session.audioGate.test.js` (4),
`src/session.leaveOnLeave.test.js` (2, proves the real `leave()` teardown completes in
~13ms, well under the 5s budget), `src/replyMirror.test.js` (4) — 21 new, all TDD
(red confirmed before each implementation). Full suite: **147 → 168 pass, 0 fail.**

Restart: via the systemd unit (`systemctl --user restart ccbot-discord-bridge.service`),
PID 626605 → 3699520. Confirmed from the new process's own journal lines (not just the new
PID): `TTS poller seeded…`/`TTS poller running…` appearing *before* `logged in as…` (the
new always-on reply-mirror poller, which old code never created pre-login), and the new
`voice leave-on-leave armed…` line. No errors in the 20s after start. This restart also
brought up everything else already staged-but-not-running in this tree before T521 (see the
"Staged only" notes on T510/T512 above) — none of it was touched by this change.

Nothing committed; branch unchanged (`ssh-view`).

## 2026-09-30 — T512: the voice draft is internal and durable (replaces T510's Discord draft)

The user heard the T510 design and corrected it: "I wasn't trying to see it in Discord
... that would actually be really annoying ... I think it was mainly thinking just
internally. It streams my transcription, saves it somewhere so it never goes away. And
then ... it gets sent over."

- **No draft in Discord.** The "📝 Hearing…" message and all its edits are removed:
  `draftUpdate`/`draftFinal`/`draftDiscard` are gone from `textMirror.js` and the
  `onDraft` hook is gone from the receiver and `index.js`. Discord gets only the single
  "🎙️ Heard:" line after the message is sent.
- **The draft lives on disk.** Each streamed segment is appended as one JSON line to
  `~/.local/state/ccbot-bridge/voice-drafts/<start-time>-<user>-<n>.jsonl`
  (`VOICE_DRAFT_DIR` overrides the folder) and fsynced right away. A crash or restart
  mid-utterance leaves the words so far on disk. On startup the bridge logs any unsent
  drafts it finds.
- **What goes to 999 is the stitched draft.** On any stop (silence, mute, stall,
  stream teardown, the 10-minute backstop), the last bit of audio becomes the final
  segment and the segments are joined in order and sent. The T510 whole-clip Whisper
  pass is gone, because that pass was the ~30-second wait. It now runs only if the
  stitched draft comes back empty. Stop-to-999 is now about the time to transcribe one
  segment (at most `DRAFT_MAX_SEGMENT_MS` = 15 s of audio), however long he talked.
  The trade-off: a word can be split where two segments meet. Segments are cut at pauses
  (700 ms below the voice threshold) whenever possible, and only forced at 15 s.
- **Retention.** After 999 accepts the message, a `sent` line is written and the file is
  renamed to `*.sent.jsonl`. Only `*.sent.jsonl` files older than
  `VOICE_DRAFT_RETENTION_HOURS` (default 168 = 7 days) are deleted, checked on attach
  and at most every 10 minutes after a hand-off. A draft that was never handed off
  (crash, or 999 refused it) is never deleted automatically.

Config: removed `LIVE_DRAFT_ENABLED` (streaming is now how the message is built); added
`VOICE_DRAFT_DIR`, `VOICE_DRAFT_RETENTION_HOURS=168`.

Tests: new `src/voiceReceive.durable.test.js` (4 tests):
- no Discord posts or edits while he talks, one "Heard:" after;
- the file grows 1 → 2 → 3 segment lines during the utterance, with an fsync per append;
- stop-to-999: 358 ms for a 0.6 s utterance vs 683 ms for 8 s, with Whisper emulated
  at 2x real time (a whole-clip pass would have added about 4 s);
- retention, and nothing deleted before the hand-off.

Changed T510 tests: `voiceReceive.draft.test.js` c9 now checks the draft file growing
instead of Discord edits, and its audio-coverage check adds up the stitched segments.
The shared `voiceHarness.js` lost the `onDraft` spy and gained a Whisper-delay knob and
injection timestamps. Full suite: 143 → 147 pass, 0 fail. **Staged only — the running
bridge was not restarted.**

## 2026-09-30 — T510: voice capture stalled mid-utterance; redesigned as live draft + "any stop sends"

**What broke.** At 22:16:06 UTC a capture started and never ended. About nine minutes
of speech were lost with nothing shown to him, and the stall watchdog only noticed after
he muted and unmuted. The code still had a 3-minute safety cap, and it should have ended
that capture by 22:19:06. The cap did `opusStream.destroy()`. Destroying a stream emits
`close`, never `end`, and `pipe()` does not end the decoder on `close`. The capture was
waiting for the decoder's `end`, so it hung forever: its audio was never transcribed and
the user stayed marked "being captured", so no new capture could start. The watchdog was
fooled because Discord's "speaking" events fire for every raw packet, before decryption,
and each one counted as "audio is flowing". It only fired once he stopped talking for 45s+.

**What it does now (always-listen).** It reads audio until a stop, then sends it:
- **Stop = the configured silence** (the app's "Stop after silence" slider; 4000 ms on
  this machine) with nothing louder than **-40 dBFS** (RMS over 100 ms windows). AirPod
  breathing measured -43 to -46 dBFS RMS on this call, so it counts as silence. No
  packets at all also counts as silence, whether from Discord's own VAD, lag, or a stalled
  receiver. No attempt is made to tell those apart. Whatever was captured gets sent.
- **Mute = send now.** Muting ends the utterance at once and sends what was captured.
  If nothing was captured, nothing is sent. (Before, a mute threw the audio away.)
- **A stream that closes or errors** (teardown, recovery, leaving) also ends the
  utterance and sends it. After any stop, if his packets are still arriving, the bridge
  re-subscribes right away so the next utterance is heard. It waits for the old
  stream's `close` first, because the voice library's close handler deletes the
  subscription by user id and would otherwise orphan the new one.
- *(Superseded by T512 above: the draft is no longer shown in Discord, and 999 now gets the stitched draft rather than a whole-clip pass.)*
  **Live draft.** While he talks, each chunk of speech that ends in a short pause is
  transcribed, and one "📝 Hearing…" message in #claude-voice is edited in place.
  Nothing goes to 999 until the stop. Then the **whole utterance** is transcribed in one
  Whisper pass (so no words are split at chunk boundaries) and sent as **one** message.
  The draft message becomes "🎙️ Heard:". If the final pass comes back empty, the draft
  text is sent instead.
- **No silent drop for long talk.** The 3-minute cap is gone. A 10-minute memory
  backstop remains, and hitting it sends what was captured and keeps listening.
- **Bot audio waits while he is writing** (`isWriting`). TTS clips and relayed sink
  bursts are paused or not started, never dropped, and play once his message has been
  sent. This covers the live `AUDIO_SOURCE=system` relay, which had no hold at all.
  That is why the bot talked over him.
- The watchdog now trusts only decoded audio after a capture saw packets but decoded
  nothing, so a decryption stall escalates to re-subscribe/rejoin.

New config keys (defaults): `VOICE_ENERGY_THRESHOLD_DB=-40`, `VOICE_ENERGY_WINDOW_MS=100`,
`LIVE_DRAFT_ENABLED=true`, `DRAFT_MIN_SEGMENT_MS=3000`, `DRAFT_GAP_MS=700`,
`DRAFT_MAX_SEGMENT_MS=15000`, `WRITING_HOLD_MAX_MS=660000`; `MAX_UTTERANCE_MS`
180000 → 600000. Each capture-end log line now prints the loudest sub-threshold window
and the 10th-percentile voice window, so the threshold can be tuned from real calls.

Tests: `src/voiceReceive.stall.test.js` (2; both failed on the old code),
`src/voiceReceive.draft.test.js` (8), `src/audioPlayer.hold.test.js` (3), with the shared
fake receiver in `src/voiceHarness.js`. Full suite: 130 → 143 pass, 0 fail.
**Staged only — the running bridge was not restarted.** The aci-serve copy
(`/mnt/smalls/aci-serve/discord-bridge`) has the same old code and was not changed.

## 2026-09-30 — T505: `/prompt` to a specific terminal stops wrapping the text

A real use exposed the bug: at 01:46 EDT the owner ran `/prompt text:"/rc" terminal:3`,
and terminal 3 received the literal string `💬 Typed message from the user (Discord):
"/rc"` instead of running `/rc` — the queue-to-a-terminal path (`controlApi.queueMemo`,
added in T492) called `frameMemo()` unconditionally, same as the 999 path does.

First pass matched a slash-command first token (`^/[A-Za-z][\w-]*$`) and left it
unwrapped while still framing everything else. The owner overrode that mid-task:
**"the /prompt command shouldn't do the wrap. regular messages r fine tho"** — so the
fix is unconditional. `queueMemo` no longer calls `frameMemo` at all: whatever was
typed is queued byte-for-byte, slash command or not. The 999 path
(`sendVoiceMemo`/`frameMemo`, used by `/prompt` with no `terminal` option, voice
memos, and file drops to the manager) is untouched — it still frames everything,
verified by a new regression test that sends a slash command to 999 and asserts it
still comes out wrapped.

**File attachments / reply-to quotes on the terminal path:** with framing gone there
is no more "📎 the user sent a file" lead-in. A caption's text is queued exactly as
typed; if a file is attached its raw local path(s) are appended after the caption
(plain, space-separated, still no label) so the destination terminal at least knows
what arrived, rather than silently losing the reference. Reply-to quoting
(`opts.replyTo`) is dropped for this path — moot in practice, since `/prompt` never
passes `replyTo` today (only the plain-message auto-forward-to-999 path in
`index.js` does).

Unit tests (`src/controlApi.promptRaw.test.js`, 6 tests): `"/rc"`, `"hello there"`,
and `"/tmp/foo is broken"` are each asserted queued **byte-for-byte**, `type: normal`
is unchanged, an all-whitespace message is still refused, and one regression test
confirms `sendVoiceMemo` still frames a slash command sent to 999. Full suite:
**124 → 130 pass, 0 fail** (was 124/0 at the end of T492).

Applied identically to `/mnt/smalls/aci-serve/discord-bridge` (same file, same
diff, new test file copied verbatim) — `controlApi.js`'s live-vs-aci-serve diff is
unchanged at 55 lines (all pre-existing divergence from before this task; see the
T492 entry below), and the two new/edited test files diff empty between trees.
aci-serve suite: 82 → 88 pass, 0 fail.

**Deployed**: old PID 3486160 (up since 2026-09-29 12:40:20 EDT) → new PID 3316674
(up since 2026-09-30 01:53:17 EDT), back within 5s of `systemctl --user restart
ccbot-discord-bridge`. Journal confirmed both commands re-registered as one guild
command-set call: `slash commands registered in guild <guild id>.`
(preceded by `logged in as auto-injector#0250.`, followed by `authorization active
— 1 allowed user id(s).`).

**Closes T492's open c7** (a real, non-999 `/prompt` invocation): the owner's own
01:46 EDT send is it — bridge journal: `typed message queued to terminal 3 (type:
normal): "💬 Typed message from the user (Discord): "/rc""` (the OLD, still-framed
output; this task is the fix for exactly that line). The journal also shows the
owner ran `/terminals` first, one minute earlier: `interaction received: type=2
command=terminals from streylix` at 01:45:41, closing that command's live-use
gap too.

## 2026-09-29 — T492: `/terminals`, and a `terminal` option on `/prompt`

Two new capabilities, both from the owner's own words: "command to list terminals
and their id in discord", then "the /prompt command doesn't have an argument for
what terminal to put it in".

**`/terminals`** — a new slash command, gated by the same allow-list/link checks as
every other command. Reads `GET /state` fresh at the moment of the command (no
caching) and replies with one line per terminal — `` `id` — title — status ``,
sorted by id — plus a header showing the row count next to the `/state` count so
the two are visibly the same (`formatTerminals` in `src/commands.js`, pure and unit
tested: sorted output, a terminal with status `...`, an empty list, and the
row/state count match). Live-invoked by the owner at 01:45:41 EDT the next day
(`interaction received: type=2 command=terminals from streylix`, no error
following it).

**`/prompt` gains an optional `terminal` integer option**, default 999 (omitting it
is byte-for-byte the old behaviour — same `linkManager.forward()` call). A non-999
id is validated against a fresh `GET /state` read before anything is saved or
queued; an unknown id is refused with the list of valid ids and nothing is queued.
A valid non-999 id goes through a new path — `linkManager.queueToTerminal()` →
`controlApi.queueMemo()` → `POST /queue/add` — instead of the manager-only
`/terminal/keys` route (`/queue/add` refuses terminal 999 by design, so 999 keeps
using `/terminal/keys` via `sendVoiceMemo`). Live-invoked by the owner at 01:46:11
EDT: `typed message queued to terminal 3 (type: normal): "💬 Typed message from the
user (Discord): "/rc""` (see the 2026-09-30 T505 entry above — the framing in that
line was itself the next bug).

**Applied identically in `/mnt/smalls/aci-serve/discord-bridge`.** That tree and
this one already differed in 14 files before this task (T457's open question,
left alone) — `commands.js`, `controlApi.js`, and `linkManager.js` were three of
them (aci-serve has no `/dump`, `/clear`, or `conversationLog.js`). Every line this
task added is byte-for-byte identical between the two trees; the measured diff
count on each touched file is unchanged from its pre-task baseline
(`commands.js`: 99→99, `controlApi.js`: 54→55 — the `+1` is only the
`module.exports` line, since aci-serve doesn't export `getScreen`/`sendRawLine`,
`linkManager.js`: 34→45 — the `+11` is only the `conversationLog.recordInbound`
call, since aci-serve has no `conversationLog.js`). The three new test files
(`commands.terminals.test.js`, `commands.prompt.terminal.test.js`,
`controlApi.terminals.test.js`) are copied verbatim and diff empty across trees.

Unit tests: 22 new (`commands.terminals.test.js`, `commands.prompt.terminal.test.js`,
`controlApi.terminals.test.js`). Live suite: 102 → 124 pass, 0 fail. aci-serve
suite: 60 → 82 pass, 0 fail.

**Deployed**: old PID 2025044 (up since 2026-09-24 12:21:00 EDT) → new PID 3486160
(up since 2026-09-29 12:40:20 EDT), back within 5s. Journal: `logged in as
auto-injector#0250.` / `slash commands registered in guild
<guild id>.` / `authorization active — 1 allowed user id(s).` Confirmed
independently via Discord's own REST API (`GET
/applications/{id}/guilds/{guild}/commands`) that `terminals` and `prompt`
(options: `text`, `media`, `terminal` — none required) were live on the guild.
Fallback named before restarting (never needed): `POST
http://127.0.0.1:8123/api/tts/speak/` — independent of the bridge process; the
Electron app's `NotificationManager` speaks it locally regardless of bridge state.

## 2026-09-24 — `/clear`: reset the manager's context from Discord

There is now a one-word `/clear` slash command. It runs Claude Code's **own**
`/clear` inside the manager terminal (999), which starts it on a fresh, empty
context.

It used to be tempting to do this with `/prompt "clear"`, but that doesn't work:
`/prompt` wraps whatever you type as `💬 Typed message from the user (Discord):
"clear"`, so the manager just receives a message containing the word "clear"
and nothing resets. `/clear` skips the wrapper. It types the raw text `/clear` at
the manager's prompt, waits the usual short beat, then presses enter. These are
the same two `POST /terminal/keys` calls, sent to the same terminal
(`managerId`, else 999), that `/prompt` uses, just without the framing
(`sendRawLine` in `src/controlApi.js`, `LinkManager.sendRaw`).

The safety checks are unchanged. The allow-list check runs before `/clear`
like every other command, and `/clear` makes the same "are we linked?" check
`/prompt` does. Against a fake control API, an unauthorised user, an empty
allow-list, and an unlinked bridge all sent **zero** requests. `/prompt` itself
is byte-for-byte unchanged.

Checked on a throwaway Claude Code session, never the live manager: typing
`/clear` opens Claude Code's slash-command menu with `/clear` itself at the top,
and enter runs it. The earlier conversation disappeared from the screen.
`/clear` isn't written to the conversation log, because it's a control action,
not something the user said.

`/clear` is a registered guild slash command like the others, so it appears in
Discord once the bridge restarts and re-registers.

## 2026-08-26 — Post to any channel with `--channel`, and send a draft as a FILE

Drafts written into Discord scrolled away in `#claude-voice` along with everything
else, so there was no way to go back to one and iterate on it. Two changes fix that.

- **`--channel <name>` on `tools/post-text.js`, `post-image.js` and the new
  `post-file.js`.** The named channel is looked up in the guild, created if it
  isn't there, and cached — so `--channel rma-drafts` creates `#rma-drafts` the
  first time and lands in that same channel every time after. This generalises the
  resolve-or-create the mirror already did for its one hardwired channel
  (`textMirror._doResolve`) into `textMirror.channelFor(name)`; it did not need a
  new mechanism.
- **`tools/post-file.js <path>` posts a plain-text file as a real attachment.** A
  long draft belongs in ONE file Ethan can download, edit and hand back, not spread
  across chat messages. Takes `.md`, `.txt`, `.json`, `.csv`, `.log` and friends;
  refuses anything else and anything over the 8MB cap (`TEXT_FILE_MAX_BYTES`)
  rather than posting a cut-off file. It reuses `pathGuard` for path containment
  and `AttachmentBuilder` exactly as `postImage`/`postVideo` already do.

**Names are normalised the same way on both sides** (`src/outbox.js`,
`sanitizeChannelName`): lowercase, spaces and underscores to dashes, punctuation
dropped, capped at Discord's 100 characters. `--channel "RMA Drafts"` and
`--channel rma-drafts` are the same channel, so a messier spelling can't create a
duplicate.

**Nothing fails silently any more.** The tools used to print "queued" and exit,
which looked identical whether the post landed or not. The bridge now writes a
result file next to the descriptor and the CLI waits for it and prints what
actually happened: `✅ Posted to #rma-drafts`, or a loud `⚠️ Could not use
#rma-drafts: the bot lacks Manage Channels — posted to the DEFAULT channel
#claude-voice instead`, or `❌ NOT posted: <the bridge's own reason>` with exit 1.
`--no-wait` keeps the old fire-and-forget behaviour.

**The default path is untouched.** No `--channel` means the default mirror channel,
same as before — that's the path the manager's own updates and the voice mirror
use. `postText`'s existing 2000-char chunking was deliberately left exactly as it
is; it already splits long posts across messages without losing anything, which was
mistaken for truncation. The voice mirror's `_post()` is likewise unchanged.

**Verified live.** 102/102 tests (19 new: name normalisation and its idempotence,
create-once-then-reuse including three concurrent posts, existing-channel lookup,
the no-Manage-Channels and unusable-name fallbacks, deleted-channel recovery,
default-path isolation, chunking unchanged, and the file type/size/empty refusals).
Bridge restarted on the running worktree — logged in as auto-injector#0250, text
mirror → #claude-voice. Then, live in Ethan's server: a default post landed in
`#claude-voice`; `--channel rma-drafts` created `#rma-drafts` and posted; `--channel
"RMA Drafts"` landed in the same channel; `post-file.js` delivered
`wd-rma-letter.md` (1198 bytes, `text/markdown`) as a downloadable attachment;
`post-image.js --channel` delivered a PNG there; and a post after a full bridge
restart resolved the existing channel ("existing named channel" in the log) instead
of creating another. The Discord API reports exactly one channel named
`rma-drafts`. A 12.16MB file was refused with `❌ NOT posted: t043-oversize.md is
12.16MB, over the 8MB cap — not posting a truncated file` and exit 1.

### Follow-up — post drafts from where they actually live

Using the above surfaced the real gap: `pathGuard` only allowed
`$XDG_RUNTIME_DIR/ccbot-bridge`, its inbox, and `/tmp`, so a draft kept in
`/media/ethan/smalls/claude-manager/notes/rma/` had to be **copied to `/tmp`** before
it could be posted. That leaves two copies of the same draft — the one Ethan edits
and the one the manager keeps — which drift apart the moment either is touched.

Fixed by adding that one directory as a trusted root, through the extension point
that already exists rather than by weakening the check:

```
# discord-bridge/.env
CCBOT_MEDIA_ROOTS=/media/ethan/smalls/claude-manager/notes
```

`pathGuard.allowedRoots()` already reads `CCBOT_MEDIA_ROOTS` and **adds** it to the
built-in roots, and `config.js` loads `.env` through dotenv, so the same value
reaches both the bridge (systemd `EnvironmentFile`) and the `post-*` CLI in one
place. Containment is otherwise untouched: still realpath-resolved (no symlink
escape), still regular-files-only, still deny-by-default. Verified that it now
accepts `notes/rma/*.md` while still refusing `~/.bashrc`, `/etc/passwd`, and
`claude-manager/CLAUDE.md` — a *sibling* of the new root, which confirms one
directory was added rather than the whole manager tree. Documented in
`.env.example` so a fresh setup can find the knob.

**Verified live.** Bridge restarted (pid 1259814); `CCBOT_MEDIA_ROOTS` confirmed
present in `/proc/<pid>/environ`. `post-file.js --channel rma-red` posted
`notes/rma/wd-rma-red-B01MHE9D.md` straight from its real location — no `/tmp` copy
— and it arrived in `#rma-red` as a 4335-byte `text/markdown` attachment whose
SHA-256 matches the file on disk byte for byte
(`2f4f07c5…d2a5`).

## 2026-08-10 — New `/dump <terminal_id>` command: raw tail of a terminal's live screen

Reading what a terminal is *currently showing* meant asking the manager for it.
`/dump` gets it straight from Discord.

- **`/dump terminal_id:<n> [chars:<n>]`** replies with the last ~1800 characters of
  that terminal's live xterm screen in a code block, raw. `999` is the manager.
  `chars` overrides the size and is clamped to 100–1900 so the reply always fits
  inside Discord's 2000-char message cap (header + code fence included). A ``` in
  the terminal output can't break out of the fence.
- **Authorization is the existing gate, not a new one.** `commands.handle()` already
  runs `auth.isAuthorized(interaction.user.id)` before dispatching *any* command, so
  `/dump` is allow-list-only (currently just Ethan) for free; everyone else gets the
  standard "not authorized" reply and never sees a byte of terminal content.
- **`controlApi.getScreen()`** (new) POSTs to the existing control-API route
  `POST /terminal/screen` with `X-CCBOT-Token` and `{terminalId, scrollback:false}`.
  Read-only — it types nothing into the terminal. Reached through
  `linkManager.readScreen()`, matching how `forward()` routes control calls, so
  commands.js still never touches the link credentials directly.
- **Failure modes all answer, none crash the bridge:** not linked → "run /link";
  missing/invalid id → usage hint; unknown terminal → "terminal not found"; app down
  → "control API unreachable on 127.0.0.1:<port> — is the app running?". Replies are
  ephemeral, like the other privileged commands.

**Verified.** `npm test` 50/50 (14 new tests: cap/clamp/fence-escaping/empty-screen,
the control-API request shape and its error paths, and the auth gate driven through
`handle()` for both an allow-listed and a non-allow-listed user). Bridge restarted —
logged in, slash commands registered, text mirror → #claude-voice, linked to manager
999. Discord reports the guild command set as `/link /leave /status /resume /stop
/prompt /dump`. A live `/dump 999` returned the manager's real screen (1160 chars),
and `/dump 42` returned `❌ Couldn't read terminal 42: terminal not found`.

## 2026-08-07 — Every Discord message was handled twice (root cause: two bridge processes)

**Symptom.** One message sent → the bot did everything twice. One screenshot landed in
the inbox as two files 7ms apart (`1786133922274-…png` and `1786133922281-…png`), an
earlier `.mov` the same way, and the manager's replies posted to `#claude-voice` twice
(13 identical back-to-back posts in one 60-message window).

**Root cause.** A *second* `node src/index.js` was running alongside the systemd unit —
the kind of stray you leave behind while debugging. Discord lets several gateway
sessions share one bot token and delivers **every event to every session**, so both
processes handled the same message: two downloads, two forwards to manager 999, and
both watchers posting the same outbox descriptor. It was invisible in `journalctl`
because the stray's stdout went to a file/PTY, not to journald — the journal showed
only one of each pair, which is what made this look like a code bug for so long.
Proof: the manager's transcript for 20:18:42 holds a single prompt containing **both**
saved paths concatenated, and running a second instance on purpose reproduced it —
both processes logged the same `messageCreate` id 9ms apart.

**Fix.**

- `src/singleInstance.js` (new) — a pid-file lock in the shared runtime dir
  (`$XDG_RUNTIME_DIR/ccbot-bridge/bridge.pid`). First bridge up owns the token; a
  second one exits with an explanation and the pid to kill, before it ever logs in.
  A dead or corrupt lock is taken over, so a SIGKILLed bridge can't wedge the service.
- `src/eventDedupe.js` (new) — a bounded TTL/LRU guard keyed by Discord snowflake id,
  applied to `messageCreate` and `interactionCreate` in `src/index.js`. Defence in
  depth: it also covers a gateway RESUME replaying dispatches to a single process.
  Fail-open (a missing id is never treated as a duplicate — dropping a real message
  is worse than a rare repeat).
- `src/imageOutbox.js` — a descriptor is now *claimed* with an atomic `rename()` to
  `*.posting` before it's posted, so two watchers can never both post it. A failed
  post renames it back for the next tick (retry behaviour unchanged), and abandoned
  claims are swept after the existing TTL.

**Verified.** `npm test` (new `node --test src/` script) — 36/36 pass, including new
regression tests for the dedupe guard, the lock, and one-descriptor-one-post. Service
restarted; a second `node src/index.js` is now refused with `Another bridge is already
running on this bot token (pid …)` and leaves the incumbent's lock intact. One
attachment → one inbox file → one forward.

## 2026-08-02 — Save inbound audio attachments (voice memos)

`src/mediaInbox.js` previously only accepted image/video/text attachments; Discord
voice messages (`.ogg`/`.oga`, `audio/ogg`) and other audio attachments were skipped
with "not an image/video/text file".

- Added `AUDIO_EXT` list (`.ogg .oga .m4a .mp3 .wav .opus .aac .flac`) and a new
  `'audio'` kind in `kindOf()`, matched by `contentType` starting with `audio/` OR
  a known audio extension — same extension-sniffing safety pattern already used for
  image/video/text (contentType is a hint, never trusted blindly).
- No changes needed to `isMedia()`/`saveAttachments()` — they already operate purely
  off `kindOf()` returning non-null.

Verified: `node --check src/mediaInbox.js` clean; `kindOf()` sanity-checked in isolation
for `{name:'voice-message.ogg', contentType:'audio/ogg'}` → `'audio'`, plus existing
image/text/video cases still correct.

Restarted `ccbot-discord-bridge` (systemd --user service). Confirmed back up: logged in,
slash commands registered, linked to manager 999 (status: running), auto-resumed link —
no errors in logs.

## 2026-10-02 — T457 + T523: rejected attachments are reported; long Heard:/Replied: echoes are split, not cut

**T457 (attachments vanished silently).** Two filters dropped an unsupported file (e.g. `.html`)
before anything could report it: `all.filter(isMedia)` inside `saveAttachments`, and
`.filter(mediaInbox.isMedia)` in the `messageCreate` handler in `src/index.js` (whose
`return` then swallowed a captionless file whole). Ported the fix from
`aci-serve/discord-bridge` (not the whole file; the trees had diverged):
- `src/mediaInbox.js`: one `ACCEPTED` table replaces the four ext/content-type conditions;
  `.html`/`.htm` accepted as text; `saveAttachments` now records every rejected file in
  `skipped` with `rejectionReason()` and a log line; new `skippedNotice()` gives one wording.
  **Kept live-only:** the `audio` kind (`ACCEPTED` includes it; the rejection text says audio
  works), and the unchanged `_saveOne` size/ext logic. Not ported: aci-serve's lack of audio.
- `src/index.js`: hands ALL attachments to `saveAttachments`; replies with `skippedNotice`
  (names the file) whether or not the message also has text or another saved file.
- `src/commands.js` (`/prompt`) needed no change: it already surfaces `skipped`.
- Tests: `src/mediaInbox.test.js` (9; aci-serve's 8 plus an audio-kept check).

**T523 (long echoes cut).** `_post` did `.slice(0, 1900)`. Now `chunkText()` splits at 2000 with
the label on the first message only; posts are chained so chunks and consecutive echoes stay in
order. The three caption sites (`postFile`/`postImage`/`postVideo`) go through
`_sendWithCaption`: the file rides on the first piece and the rest follow as plain messages, so
captions SPLIT (a visible marker would still have lost the text). A body that fits is one message.
Tests: `src/textMirror.longBody.test.js` (7; 4 fail on the old code).

Suite: 168 → 184 passing, 0 failing. Not restarted; not committed.
