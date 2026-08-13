# Fleet-management optimizations

Plain-English log of improvements to the Auto-Injector control interface, driven by
the manager (terminal 999) as product owner. Each entry is one focused change on the
project's current git branch.

---

## 2026-08-11 — Restarts were loading a DIFFERENT checkout; build identity is now reportable, and manager (999) traffic bypasses the queue gate (branch `ssh-view`, uncommitted)

**Request (Ethan).** Two problems. First, the blocker: a restart at 13:35
did not activate renderer changes — the old-format completion push
("Terminal N just finished. Its last message:") kept firing even though
`renderer.js` had `COMPLETION_PUSH_VIA_STOP_HOOK = false` and the new
`LongExecutionWatchManager` / `ManagerCheckpointManager` were wired in.
The suspected cause was a stale Electron code cache (`~/.config/auto-injector/Code Cache`
is dated 2026-06-08 and `main.js` never cleared it). Second: messages
addressed to the manager terminal must not sit in the queue.

**Investigation (the cache was a red herring).** `completion:recorded`
has exactly one emitter — `renderer.js:493`, behind the disabled flag —
so a live old-format push meant old code, which was right. But the cause
was not caching. Reading `/proc/<pid>/cwd` for the running Electron
process gave the answer in one line:

    /proc/1903600/cwd -> /media/ethan/smalls/aci-serve

`electron .` resolves `.` against the **shell's cwd**, not the repo. The
app was being launched from `/media/ethan/smalls/aci-serve` — a
detached-HEAD git **worktree** of this same repository, pinned at
`471d9ed`, two commits behind. That checkout has no
`LongExecutionWatchManager.js`, no `ManagerCheckpointManager.js`, and no
`COMPLETION_PUSH_VIA_STOP_HOOK` flag at all, so the Stop-hook push there
is unconditionally live. Restarts were loading fresh code the whole time
— just fresh code from the wrong directory. Both checkouts share one
Electron userData dir, so nothing looked wrong from the outside, and the
live app had no way to say where its code came from. That missing answer
is what let the wrong theory survive.

**Fix — build identity (the actual fix).** New `src/build-info.js`
reports the loaded code's identity: a hand-bumped `BUILD_TAG`, the
directory the code was loaded from, the git HEAD of that directory
(worktree-aware — it follows the `gitdir:` pointer when `.git` is a
file), and the mtimes of `renderer.js` / `main.js`. It is surfaced three
ways so it is visible whatever you have access to:

- `renderer.js` logs `RENDERER_BUILD_<tag> dir=… git=… renderer.js=<mtime>`
  the moment the file is parsed — the direct proof a restart re-parsed it;
- `main.js` logs the same as `[Build] MAIN_BUILD_…` at startup;
- `GET /state` on the control API now carries `build` (main's view) beside
  `rendererBuild` (the renderer's own), so the manager can query it.

Against the two checkouts the marker reads, respectively,
`dir=/media/ethan/smalls/claude-autorunner git=ssh-view@7b800ee4c0d2` and
`dir=/media/ethan/smalls/aci-serve git=(detached)@471d9eddbc26` — which
would have identified this in one query.

**Fix — cache clearing (belt-and-braces).** `main.js` now awaits
`session.defaultSession.clearCodeCaches({})` + `clearCache()` before
`createWindow()`, wrapped so a failure can never block startup. This was
not the cause and is not the cure; it costs one recompile of local files
per launch and closes the door on the theory permanently.

**Fix — instant manager delivery.** `evaluateInjectionGate` gave normal
messages the full gate treatment, including "blocked while the
destination is `prompted`". The manager parks at `prompted` between turns
as a matter of course, so a completion push aimed at 999 could wait
indefinitely for a state it may never reach on its own — it got stuck in
the queue. Inbound manager traffic is not queued work competing for a
worker's attention; it is the reporting channel (completions, stuck
watches, voice memos, Discord relays), and the manager's own judgment is
the brake on what it acts on. So destination 999 now bypasses the **soft**
gates: status (`prompted`), timer countdown, injection paused, bare-shell.

What still holds a manager message, deliberately:

- **no target terminal** — the one hard block, unchanged;
- **the usage limit** — checked *ahead of* the 999 bypass. This is where
  manager traffic parts ways with urgent, which does override it. Ethan's
  call, and the right one: during a usage-limit wait the manager can't act
  on a report anyway, so holding until reset is cleaner than buffering
  turns it will only read late;
- **the "manager input disabled" switch** — checked in
  `canInjectToTerminal` *before* the policy runs, so the bypass cannot
  defeat it, and re-checked in `_injectToTerminal`, the single sink every
  injection path flows through.

Final precedence in `evaluateInjectionGate`: no-target → urgent bypass →
usage limit → **999 bypass** → countdown → paused → bare-shell → status.

One further hole was closed while proving this end to end: the bare-shell
re-check inside `_injectToTerminal` would still have silently held
manager messages, since 999 is a hidden PTY whose runtime detection can
read `shell` — which would have re-created the exact stuck-queue symptom
one layer below the gate. 999 is now exempt there too.

**Tests.** `src/messaging/injection-gate.test.js` gains manager cases:
allowed while `prompted`; allowed with every soft gate hostile at once and
each one individually; **held** by a usage limit (alone, and with every
soft gate clear); urgent-to-999 still overrides the usage limit; the
bypass does not leak to terminal 1/99/9990; no-target still wins. New
`src/messaging/manager-gate.test.js` covers the layer above the pure
policy — normal-to-999-while-prompted is allowed, while a usage-limit
wait holds it, and both normal and urgent to 999 are held when manager
input is disabled. Full local suite: **140/140 pass**.

**Still needed from a human (not done here — the app is live).** The
running app must be launched from this checkout, or the `aci-serve`
worktree brought up to date; the code changes above take effect on the
next restart either way. After the restart, `GET /state` (or the renderer
console) reporting `tag=20260811-longexec-mgrgate-1` with
`dir=/media/ethan/smalls/claude-autorunner` confirms the new code loaded.

---

## 2026-08-11 — Manager checkpoints its session to notes after 90 min idle, then clears itself (branch `ssh-view`, uncommitted)

**Request (Ethan, via the manager).** When nothing has happened for "an
hour or two", have the manager write up what it did this session into its
notes, wait until it has actually finished writing, and only then `/clear`
its context — so the next session starts clean without losing what the
last one learned. It must never clear while the user is around.

**Investigation.** The app had no notion of "the user is here": the
message box, terminal keystrokes and voice memos all just called
`addMessage`, indistinguishable from the automated dispatches
(completion pushes, stuck notes, the pass loop) that also queue messages.
Two useful facts settled the design. Queue injection writes to the PTY
via `ipc.send('terminal-input', …)` and never passes through xterm's
`onData` (`renderer.js` ~1977) — so `onData` fires for real keystrokes
and pastes ONLY, making it a clean human-presence signal. And the
manager's own PTY output is already on the bus as `terminal:data` for
999, which is exactly the "is it still writing?" signal this needs.

**Fix.** A canonical `user:activity` event is now emitted from the three
genuine-user entry points — terminal keystrokes (`renderer.js` ~1977),
the message box's `handleAddMessage`, and `WakeWordManager`'s voice memo
— and new `src/features/ManagerCheckpointManager.js` runs the cycle on a
30s clock (constructed/started in `renderer.js` beside the change
watcher):

- **idle** (armed) — the inactivity clock resets on `user:activity` or on
  output from any NON-999 terminal. The manager's own output pointedly
  does not count, or its housekeeping would hold the clock open forever.
- 90 min silent (`INACTIVITY_THRESHOLD_MS`) → **checkpointing**: dispatch
  "Jot down everything you did this session in the notes." to 999 through
  the normal queue path.
- 999 goes active-then-quiet → **clearing**: dispatch `/clear`.
- `/clear` injects → **disarmed**, and it stays disarmed through any
  amount of further idle time. Only genuinely new activity re-arms it, so
  it cannot loop-clear.

"Active-then-quiet" reuses the change watcher's constants directly:
`QUIET_DEBOUNCE_MS` for quiet, and `RUNNING_THRESHOLD_MS` as a floor on
how long 999 must have been writing. That floor matters — injecting the
prompt echoes it into 999's own PTY, so without it an echo followed by a
slow turn start would read as "notes written" and clear the manager
before it wrote anything. A suspiciously short write is discarded and the
flow keeps waiting; if the manager never really answers, a 10-minute
timeout gives up WITHOUT clearing. Both bail-outs err the same way: a
missed clear is harmless, a premature one loses the session.

**The abort.** Any `user:activity` during checkpointing or clearing kills
the cycle immediately and pulls whatever it queued back out (matched on
999 + this module's own exact constant strings, so a user's message is
never in scope) — including a `/clear` already sitting in the queue. The
manager is never cleared mid-conversation. Worker output alone does not
abort; a background job finishing is not the user coming back.

**Tests.** `tests/unit/manager-checkpoint.test.js` — 17 cases on a mocked
clock: threshold arming, manager-output-doesn't-count, active-then-quiet
clearing exactly once, the echo guard, both abort paths, disarm/re-arm,
manager-not-running, mid-cycle manager stop, and the kill switch
(`managerInactivityCheckpointEnabled`). All pass. **Takes effect at the
next app restart.**

---

## 2026-08-11 — Terminal status is now driven by SCREEN CHANGE, not Claude hooks; long executions report when they stop (branch `ssh-view`, uncommitted)

**Request (manager, terminal 999).** The Claude Code hooks toggle
running/idle unreliably: a missed `Stop` pins a terminal at "running"
forever (so the injection gate refuses to feed it), and a missed
`UserPromptSubmit` leaves a busy terminal looking idle (so a prompt gets
injected into a live turn). Replace that toggle with a lightweight
watcher that reads ACTUAL screen change, and have it report to the
manager when a long execution stops. Must stay extremely light — no
polling, no hashing on a fast timer.

**Investigation.** The renderer already emits exactly the signal needed:
`renderer.js`'s `terminal-data` IPC handler (~line 353) fires once per
PTY output chunk and emits `terminal:data` on the bus — i.e. one event
per screen change, already on the hot path for every terminal.
`StuckWatchManager` (`src/features/StuckWatchManager.js`) established the
shape for a periodic watcher that feeds off bus events, dispatches to the
manager via `managerInstance.dispatch()` (999 is rejected by the HTTP
control API, so dispatch is the only route), and de-dupes per episode.
Its one flaw: it never prunes per-terminal state when a terminal closes.

**Fix.** New `src/features/LongExecutionWatchManager.js`, constructed and
started in `renderer.js` alongside `StuckWatchManager` (~line 181). The
hot path does one Map write per chunk — a timestamp, nothing else. All
judgement happens on a single coarse 1s interval:

- output that keeps arriving for **10s** (`RUNNING_THRESHOLD_MS`) →
  status `running`, emitted with `source: 'change-watch'`
- a **5s** gap (`QUIET_DEBOUNCE_MS`) ends the episode. If we owned the
  `running`, status goes back to `'...'` and **one** report is pushed to
  the manager with the cleaned tail of the visible screen (last 15
  non-empty lines / 800 chars, box-drawing chrome and 3+ dash runs
  stripped) via the existing `readTerminalScreen()`.
- an episode that ends before 10s resets silently — no status write, no
  report. Quick turns are noise.

Guards: terminal **999** is never tracked, never written, never
reported; `prompted` / `error` / `injecting` set by other sources are
never overridden; and the watcher only clears a `running` it set itself
(ownership drops the moment any other source writes status). On
`terminal:closed` it deletes that terminal's state — the pruning
StuckWatch omits.

The quiet window is deliberately 5s rather than the 2.5s first built: a
mid-turn gap misread as "stopped" costs a spurious manager report and
running→idle→running flapping, which is a worse failure than learning
about a real stop 2.5s later.

Two things were switched off so the watcher is the single authority.
`HOOK_STATUS_MAP` in the `claude-hook-event` handler lost its
`prompt-submit → running` and `stop → '...'` entries (`notification →
prompted` stays — it's the one dependable hook, and it's the awaiting-
input signal nothing else can see). And the Stop-hook completion push
(`completion:recorded` → `ManagerInstance.onTerminalCompletion`) is
disabled behind `COMPLETION_PUSH_VIA_STOP_HOOK = false` in renderer.js,
so completions are reported once, by the watcher, not twice.
`ManagerInstance`'s completion logic is left intact and still unit-tested
— only the emission is cut, so this reverts with a one-word edit.

**Effect.** The manager stops hearing about every trivial sub-10s turn
and starts hearing about substantial executions when they actually
finish — judged by the screen going quiet, which is observable, rather
than by a hook that may never fire. Terminals no longer get stranded in a
false "running" that blocks injection.

**Tests.** `tests/unit/long-execution-watch.test.js` — 17 cases on a
mocked clock (no timers armed): promotion at 10s, silent sub-threshold
bursts, idle + exactly-one-report on stop, the snippet cleaner, 999
exclusion, protected-status and ownership guards, close-pruning, and the
disable switch. All pass; the 164-case `src/features` + `discord-bridge`
suites still pass. Config lives at the top of the module
(`RUNNING_THRESHOLD_MS`, `QUIET_DEBOUNCE_MS`, `EVAL_INTERVAL_MS`,
`REPORT_MAX_LINES`), and `managerLongExecutionWatchEnabled` turns the
whole thing off. **Takes effect at the next app restart.**

---

## 2026-07-30 — Completion push now sends the live screen-buffer tail, not a transcript lookup (branch `ssh-view`, uncommitted)

**Request (Ethan).** Replace the completion-push text source. Instead of
`readLastAssistantText` extracting the "last assistant message" from the
session transcript (the cause of the earlier stale-message bug — the
wrong Stop hook's message could get picked), fetch the last N chars of
the terminal's actual SCREEN BUFFER — the same capture `/terminal/screen`
already returns — since that's always the terminal's true current state,
with no "which Stop hook / which message" ambiguity. N configurable via
`managerCompletionTailChars`, default 1500.

**Investigation.** The screen-capture path already exists and is reused
as-is: `renderer.js`'s `readTerminalScreen(terminalId, opts)` (~line
2518) reads the live xterm buffer (`term.buffer.active`), trims trailing
blank lines, and is the exact function backing the `/terminal/screen`
control endpoint (`handleControlRequest` ~line 2591 calls it directly).
The completion-push source was the `payload.event === 'stop'` handler in
renderer.js's hook-event listener (~line 439), which previously only
fired `completion:recorded` `if (payload.lastAssistantText)` — a field
`main.js` computes by calling `readLastAssistantText(transcript_path)`
(`src/main/transcript-reader.js:110`) synchronously when the Stop hook
lands.

**Fix.** The `'stop'` branch (`renderer.js` ~439-473) now triggers on
`payload.event === 'stop'` alone and builds `completionData.text` from
`this.readTerminalScreen(payload.terminalId, { scrollback: true }).screen`,
tail-sliced to `managerCompletionTailChars` chars (read from
`appStateStore`, falling back to 1500). `main.js`'s
`readLastAssistantText` call and `payload.lastAssistantText` are left in
place — untouched — because the opt-in `summarizeCompletions` path
(~462) still uses it for its own separate plain-English compression, now
guarded with an explicit `payload.lastAssistantText` truthiness check
since the outer condition no longer implies it. `managerCompletionTailChars`
was added to the persisted-settings load/mirror block in `setupSettings()`
(~2646, ~2666, ~2686), following the same `getPersistedSetting` → 
`appStateStore.setState` pattern as `managerPassIntervalMinutes` — it's
persisted/tunable via the same settings storage, though (per "minimal
change") no dedicated UI slider was added for it.
`src/features/ManagerInstance.js`'s bounded-history dedup (added in the
prior fix) needed **no code changes** — `onTerminalCompletion()` already
dedups on whatever `data.text` contains, so it now naturally keys on
screen-tail content instead of transcript text. Updated its comments
(~43-66) to describe the new source instead of the transcript one, and
left the `[tool_use: …]` marker check in as a harmless no-op (that shape
was transcript-specific and won't occur in raw screen text).

**Heads-up (Ethan asked this be called out):** the terminal tail is raw
TUI text — line-wrapped to the pane's column width, may include
box-drawing/prompt-decoration characters, spinner frames, partial
in-progress lines — messier than the old clean transcript prose. Accepted
tradeoff for always-current, no-staleness content.

**Tests.** `src/features/ManagerInstance.dedup.test.js`: existing dedup
tests needed no changes (they exercise `onTerminalCompletion` at the
`completion:recorded` event level, agnostic to where `text` comes from).
Added two tests documenting the new content shape: one confirming
box-drawing/wrapped-line screen text pushes and dedups correctly
verbatim, and one confirming near-duplicate frames (e.g. a spinner
character differing) are correctly treated as distinct, not falsely
deduped. All 10 tests pass: `node --test
src/features/ManagerInstance.dedup.test.js`. The renderer-side capture/
slice logic (`readTerminalScreen` + tail-slice in the hook-event handler)
has no isolated unit-test harness in this repo (renderer.js is the GUI
orchestrator, not an independently `require`-able module elsewhere) —
verified via `node --check` and code inspection only, same as the
Fix 1-3 changes.

**Remote bundle.** Re-ran `npm run build-remote` since `renderer.js`
changed again — succeeded, `dist-remote/renderer.bundle.js` timestamp
updated.

**Needs an app restart** — `setupSettings()` (loads
`managerCompletionTailChars`) and the hook-event listener changes only
take effect for a freshly-started renderer; Remote Mode also needs a
restart to serve the freshly rebuilt bundle.

---

## 2026-07-30 — SSH-view coloring, per-pane image drop, SSH copy/paste (branch `ssh-view`, uncommitted)

**Request (Ethan).** Three UI bugs: (1) terminal colors render wrong once
a pane has SSH'd into another machine, (2) dropping an image only reliably
attaches when dropped on the tiny message-input box rather than the
terminal pane itself, (3) drag-select-to-copy (and paste) doesn't work in
an SSH'd pane the way it does locally.

**1. SSH-view coloring.** Root cause: every PTY is spawned with the
terminfo name `xterm-color` (`main.js`, three spawn sites — the primary
spawn ~line 1074, the Unix/Windows fallback spawn ~line 1156, and the
legacy `change-terminal-directory` handler ~line 1293) and no `TERM`/
`COLORTERM` was set in the child environment. `xterm-color` is a very
limited legacy terminfo entry (effectively 8/16 colors, no 256-color or
truecolor). Locally this mostly goes unnoticed because many CLI tools
either don't probe capabilities hard or fall back gracefully; but `ssh`
re-negotiates color support against `$TERM` on the *remote* host, so a
remote shell/TUI sees `xterm-color` and renders a degraded/wrong palette
even though xterm.js (the renderer here) fully supports 256-color and
truecolor. Fix: all three PTY spawns now request `name: 'xterm-256color'`
and set `TERM=xterm-256color` + `COLORTERM=truecolor` in the child env
(`main.js` ~1065-1082, ~1150-1162, ~1289-1298). No xterm.js theme changes
needed — the local color theme (`src/core/terminal-manager.js`) was
already correct, it's the *remote* negotiation that was starved.
**Needs an app restart** — this only affects newly-spawned PTYs, not
terminals already running.

**2. Drag-and-drop images onto any terminal pane.** Root cause: drop
listeners were only bound to `#drop-zone` (the message-input box,
`index.html:328`), so a drop anywhere else on the terminal grid did
nothing. Fix: added a second, delegated set of `dragenter`/`dragover`/
`dragleave`/`drop` listeners on `#terminals-container` in
`renderer.js` (`setupFileAttachments()`, ~line 952) that resolve the
`.terminal-wrapper` under the cursor via `closest()`, read its
`data-terminal-id`, and make that terminal the active/queue target
(`setActiveTerminal()` or `queueTargetTerminalId`) before running the
same `attachFiles()` path the input box already used — so the image
lands as an attachment on whichever pane it was dropped on, not just
the currently-focused one. Visual feedback reuses `.terminal-drag-active`,
CSS that already existed in `style.css` (~2762) but was dead/unwired
until now. **Needs an app restart** — it's a renderer script, so a
plain window reload (Ctrl/Cmd+R) is enough, a full app restart isn't
required for this one.

**3. Copy/paste in an SSH'd terminal.** Investigation: xterm.js already
has the "common pattern" fix built in — holding Shift while dragging
(Linux/Windows) forces local text selection even when the remote program
(e.g. Claude Code's TUI running over the far end of the SSH session) has
turned on mouse-tracking and would otherwise intercept the drag as mouse
input. Paste already works unmodified in both local and SSH'd terminals,
since it goes through xterm's built-in hidden-textarea paste handling and
gets written straight to the PTY's stdin — SSH just forwards those bytes,
there's no app-side gap there. The one real gap: the Shift-drag override
only checks `e.shiftKey` on Linux/Windows; on Mac it instead requires
Option+drag *and* xterm's `macOptionClickForcesSelection` option, which
defaults to `false` — so Mac users had no drag-based way to force local
selection through an SSH'd mouse-tracking program at all. Fixed by adding
`macOptionClickForcesSelection: true` to the actual `new Terminal(...)`
construction used by the app in `renderer.js` (~line 1809 — this is the
live pane-creation path; `src/core/terminal-manager.js`'s own
`createTerminal()` carries the same option for consistency but is dead
code, not what actually builds panes). The existing right-click "Copy"
menu (`renderer.js` `showTerminalContextMenu`/`copyTerminalText`, ~2043)
remains the sure-fire fallback regardless of mouse-tracking state, since
it reads xterm's selection/buffer directly rather than relying on native
browser drag-select. **Needs an app restart** (or window reload) — same
as above, this only affects newly-created terminal panes.

---

## 2026-07-30 — Completion-push dedup fix + remote-bundle rebuild (branch `ssh-view`, uncommitted)

**Request (Ethan).** Two live bugs in the manager's completion-watch push
(the notification 999 gets when another terminal finishes a turn): (1) a
push showed a stale, intermediate assistant message instead of the
terminal's real final output, and (2) a duplicate of that stale push was
sitting unsent in the live queue (id=4), identical to one already
delivered — dedup didn't catch it. Also asked to rebuild the stale
Remote-Mode bundle once the renderer.js UI fixes above were final.

**Investigation.** `src/features/ManagerInstance.js`'s
`onTerminalCompletion()` (~line 59) dedups by comparing the new completion
text to `_lastCompletionText.get(terminalId)` — a single last-value cache.
Claude Code can legitimately fire several Stop hooks in quick succession
for what looks like one logical turn (an intermediate response, more tool
calls, then the true final one), each producing its own completion push
with whatever `readLastAssistantText` (`src/main/transcript-reader.js:110`)
finds as the latest complete assistant text at that instant. That part
works correctly — the text captured per event is genuinely accurate for
its moment. The bug is downstream: with only a single-value cache, a
sequence like **A** (pushed), **B** (different, pushed), **A** again
(re-surfacing, e.g. a duplicate/nested Stop firing) sailed straight past
the `=== ` check because it only compares against **B**, not **A** — so
the OLD text **A** gets queued a second time. This is exactly what
produced both symptoms Ethan saw: the "stale intermediate message" and
the "duplicate stuck unsent in queue" are the same root cause, since the
re-queued old push sits behind newer traffic and gets delivered later,
reading as if the manager were told the wrong/non-final result. This
buggy A,B,A-passes-all-three behavior was actually already codified as
intentional in `ManagerInstance.dedup.test.js` (pre-existing test now
rewritten below). Checked the live queue via
`GET 127.0.0.1:$CCBOT_PORT/queue` — it's currently empty, so the specific
stuck id=4 message had already drained/been delivered by the time this
was fixed; nothing needed manual cleanup.

**Fix.** `_lastCompletionText` (`ManagerInstance.js` ~46-53) is now a
`Map<terminalId, string[]>` — a bounded history (`_completionHistoryLimit
= 5`) of recently-pushed texts per terminal, instead of a single string.
`onTerminalCompletion()` (~76-84) checks `history.includes(text)` before
pushing and dedups against any recently-seen text, not just the
immediately-previous one; the array evicts its oldest entry past the
5-deep cap so memory doesn't grow unbounded over a long session.

**Tests.** `src/features/ManagerInstance.dedup.test.js`: replaced the test
that asserted the buggy "A, B, A pushes all three" behavior with one
asserting the fixed "A, B, A pushes only A and B" (dedup catches the
re-surfaced A), and added a bounded-history test confirming a text that's
aged out past the 5-entry cap is treated as new again while one still
inside the window stays deduped. All 8 tests pass:
`node --test src/features/ManagerInstance.dedup.test.js`. **Needs an app
restart** — `ManagerInstance` is instantiated once at renderer startup.

**Remote bundle rebuild.** Ran `npm run build-remote`
(`esbuild renderer.js --bundle --outfile=dist-remote/renderer.bundle.js
...`) after the drag-drop (Fix 2) and copy/paste (Fix 3) renderer.js
changes above landed. Succeeded (`⚡ Done in 34ms`, `dist-remote/
renderer.bundle.js` 1.0mb). Bundle mtime moved from Jul 15 → Jul 30;
spot-checked with `grep -c "macOptionClickForcesSelection\|
terminal-drag-active" dist-remote/renderer.bundle.js` (8 hits) to confirm
both new behaviors made it into the bundle. This bundle is what Remote
Mode serves to a browser over SSH (e.g. Ethan's Mac) — **needs the app
(or at least Remote Mode) restarted** to actually serve the freshly built
file instead of a cached one.

---

## 2026-07-30 — Recurring "Scheduled optimization pass" disabled for good (branch `ssh-view`)

**Request (Ethan).** The manager (999) kept getting a standing
"Scheduled optimization pass..." instruction dispatched to it on a timer
(default every 60 min). Ethan wants that gone permanently.

**How it works.** `src/features/ManagerInstance.js`'s `start()` no longer
arms the pass loop — the block that read `managerAutoPassEnabled` and
called `startPassLoop()` was replaced with an unconditional
`this.stopPassLoop()` (~line 320). `startPassLoop()` itself (~line 107)
now returns immediately after clearing any existing timer, so nothing can
re-arm it even if called directly. `PASS_INSTRUCTION`, `dispatchPass()`,
and the rest of the interval-scheduling code are left in place as dead
code rather than deleted, in case this is ever revisited.

**Untouched.** The completion-watch push (`onTerminalCompletion`,
`completionWatchEnabled`, the dedup-by-terminal map) is a separate
feature and was not touched — the manager still gets notified when other
terminals finish.

 — Discord "typing…" indicator while the manager works (branch `ssh-view`)

**Feature (user request).** The user couldn't tell whether the manager (999)
was working on his Discord message. The bridge now shows the bot's typing
indicator in #claude-voice from the moment an inbound message is submitted
to 999 until a reply posts.

**How it works.**
- *`discord-bridge/src/textMirror.js`*: `startTyping()` (immediate
  `channel.sendTyping()` + refresh every 7s — Discord expires at ~10s — +
  90s max-timeout auto-stop) and `stopTyping()`; both idempotent, a fresh
  start restarts the clock, ping failures are logged but never disrupt
  delivery. `stopTyping()` fires at the top of `postText`/`postImage`/
  `postVideo`/`postReplied` (any reply going out) and in `reset()`.
- *`src/linkManager.js`*: single choke point — every inbound path (typed
  auto-forward, `/prompt`, all voice-memo paths) funnels through
  `forward()`; a new optional `onForwarded` hook fires only on successful
  submit, try/caught so the indicator can never break delivery.
- *`src/index.js`*: `linkManager.onForwarded = () => textMirror.startTyping()`.
- New `src/textMirror.typing.test.js` (7 tests, mock timers); full bridge
  suite 21/21. controlApi submit sequencing untouched; systemd drop-ins
  (DISABLE_VOICE_AUTOFOLLOW=1, IN_CALL_SILENCE_MS=4000, barge-in off) intact.

**Verified / incident finding.** Lifecycle proven on live traffic (on at
submit, clock-restart on a second message, off exactly when the manager's
reply posted). BUT the user saw no indicator — diagnosed to a **Discord-side
outage**: `POST /channels/*/typing` returned HTTP 500 on all 43 guild
channels (REST-probed with the bot token; GET/channel + message posting fine)
during discordstatus.com's unresolved "API Errors" incident (started
2026-07-16 17:49 PDT, "upstream latency issue"). After the sendTyping catch
was switched from swallow to log.warn and the bridge restarted, discord.js
itself logged `sendTyping failed: Internal Server Error` on both the
immediate ping and the 7s refresh — conclusive. No code fix warranted
(retrying a cosmetic signal against a degraded endpoint is churn); the
indicator becomes visible on its own when Discord resolves the incident.
**Resolved 2026-07-17:** Discord's typing endpoint recovered (~23:40 EDT,
verified 204 via REST); the first post-recovery user message (01:42:47)
produced a clean cycle — typing on, refreshed, zero failures, off on the
next submit — i.e. the indicator is now user-visible end-to-end.

---

## 2026-07-15 — Whisper transcription: faster-whisper large-v3 (int8_float16), forced English — large-model accuracy at ~2GB VRAM (branch `ssh-view`)

**Change (user request, pivoted mid-task).** Discord voice memos and in-app
voice garbled on Whisper 'base' and auto-detect hallucinated other languages.
Original ask was openai-whisper large-v3, pivoted to **faster-whisper**
(CTranslate2) 'large-v3' at `compute_type='int8_float16'` on CUDA: large-v3
accuracy, ~2.1GB resident VRAM (vs ~10GB fp16), and decodes FASTER than the
old 'base'. Language now defaults to `'en'` everywhere.

**How it works.**

- *`backend/voice_transcription/transcription_service.py`* rewritten from
  `openai-whisper` to `faster_whisper.WhisperModel`. Same public contract
  (return-dict keys unchanged; segments materialized as dicts). Defaults:
  `model_name='large-v3'`, `language='en'`. Load path degrades gracefully:
  cuda/int8_float16 → cuda/int8 → cpu/int8, plus the existing fallback-to-
  'base' and thread-safe model cache. A `_preload_cuda12_libs()` shim
  ctypes-preloads `libcublas.so.12`/`libcudnn*.so.9` from the
  `nvidia-*-cu12` pip wheels — the image's torch is cu13-only and CT2
  dlopens the CUDA-12 sonames at inference (this was a real failure,
  caught in staging: "Library libcublas.so.12 is not found").
- *Server is authoritative:* `views.py` transcribe endpoint now ignores the
  request's `model` field and always runs large-v3 (old app builds and a
  possibly-stale Discord bridge still send 'base'); missing language coerces
  to 'en' (explicit language still wins). Voice `health/` endpoint now
  warm-loads large-v3 instead of base.
- *Callers made consistent anyway:* `src/state/AppStateStore.js`
  (`whisperModel: 'large-v3'` ×2), `src/features/VoiceManager.js` (sends
  explicit `model`/`language` fields now), `discord-bridge/src/transcribe.js`
  (defaults `large-v3`/`en`). `backend/requirements.txt`: `openai-whisper` →
  `faster-whisper` + `nvidia-cublas-cu12`/`nvidia-cudnn-cu12`.

**Verified LIVE (999-approved `docker compose restart backend`; only that
container touched).** First staged + exercised standalone via `docker compose
exec` (which caught the libcublas.so.12 failure), weights pre-downloaded to
the container's HF cache so the restart blip was seconds. After restart:
container healthy; `/api/voice/health/` reports device cuda +
whisper_loaded; a real POST to `/api/voice/transcribe/` — deliberately
sending `model=base` and no language — came back `model_used: 'large-v3'`,
`language: 'en'`, byte-perfect transcript of an espeak-generated 5.7s WAV in
**0.40s** (server-side override proven, so the stale bridge is covered).
nvidia-smi: the backend process holds **2162 MiB** resident (target 2-3GB;
fp16 openai-whisper would have been ~10GB). Manager TTS confirmed after the
restart: `POST /api/tts/speak/` synthesized fine (id 1565, bf_emma, 2875ms).
Note for later: the HF model cache lives in the container's writable layer,
so a future container RE-CREATION re-downloads ~3GB on first use — consider
a named volume for `/root/.cache/huggingface`.

**Follow-up fix 3 (2026-07-16): tightened anti-hallucination for noisy-car
use, WITHOUT breaking the 1-word interrupt commands.** Still too many
confident phantoms on ambient/car audio. Measured the voice-interrupt
stop-words ("Yes."/"No."/"Wait.", clean AND mixed over a synthetic car-noise
bed) before touching thresholds — critical finding: short real commands
legitimately score LOW avg_logprob (−0.61 to −0.80; "Wait." over car noise
= −0.802), so the commonly-suggested −0.6/−0.7 logprob floor would have
dropped real stop-words. Their no_speech_prob stays ≤0.29 though. Changes:
`NO_SPEECH_PROB_MAX` 0.6 → **0.5** (mid-gap: real ≤0.35, phantoms ≥0.68),
`AVG_LOGPROB_MIN` −1.0 → **−0.9** (below the −0.802 worst real command,
degenerate-output net only), Silero VAD `threshold=0.6` (default 0.5; road
blips don't register, commands verified to still pass; min_speech_duration
left at 250ms so a bare "no" is never clipped), plus a tiny exact-whole-
transcript blocklist of never-real artifacts only ("thanks for watching",
"thank you for watching", "please subscribe", "[music]" — NOT "thank you",
NOT stop-words). Verified live after backend-only restart: full sentence
byte-perfect; "Yes." clean and "No."/"Wait." OVER CAR NOISE all transcribe;
car-noise/pink-noise/music clips → `""`. Gate + blocklist unit-checked
against all measured values in-container; image rebuilt with the changes;
TTS healthy; still 2162 MiB resident.

**Follow-up fix 2 (same day): cross-talk hallucination — CONFIDENCE-based
post-filter (user chose this over a phrase blocklist).** On a live call,
real background/cross-talk audio passed the VAD (there IS voice activity)
and still came back as the canned "Thank you." / "Thanks for watching"
artifact. Measured on this box (large-v3 int8_float16): hallucinated
segments arrive with `no_speech_prob` ≈ 0.68–0.70, while ALL genuine speech
— clear (0.009), a real spoken bare "Thank you." (0.066), even faint badly
garbled speech (0.36) — stays ≤ 0.36. `avg_logprob` does NOT separate the
classes (hallucination −0.26 vs faint-real −0.62), which is also why
faster-whisper's own `no_speech_threshold` never fired (its suppression
additionally requires logprob < −1.0). Fix in `transcription_service.py`:
`_drop_low_confidence_segments()` drops any segment with
`no_speech_prob > 0.6` OR `avg_logprob < −1.0` (the latter purely as a
degenerate-output safety net), logging each drop with its stats for audit;
empty result ⇒ empty transcript. No phrase blocklist (a briefly-staged one
was reverted per user preference). Verified live after a backend-only
restart: noise and music-like WAVs → `""`; a genuine spoken "Thank you." →
survives (conf 0.93); the full test sentence → byte-perfect (conf 0.99,
0.39s); TTS healthy; backend still 2162 MiB resident; image rebuilt with
the filter baked in. Known residual: *reversed/nonsense speech-shaped*
audio transcribes as gibberish with GOOD confidence (no_speech 0.018) —
no filter at this layer can catch that class.

**Follow-up fix (same day): silence hallucination.** In the wild, large-v3
returned phantom "Thank you" / "Thanks for watching" on silent memos (the
classic Whisper YouTube-caption artifact). Added to the `model.transcribe()`
call: `vad_filter=True` (built-in Silero VAD skips non-speech; onnxruntime
was already present from the faster-whisper install),
`vad_parameters=dict(min_silence_duration_ms=500)`,
`condition_on_previous_text=False` (no repeating prior text into quiet
gaps), explicit `no_speech_threshold=0.6`. Verified live after another
backend-only restart: a 6s all-silence WAV → `text: ""` in 0.09s (no
"Thank you"), the speech WAV still transcribes byte-perfect in 0.37s,
backend process still 2162 MiB resident, TTS still healthy.

---

## 2026-07-31 — Games shelf: Vibe Blast becomes a library any Claude session can add to (branch `games`)

**Feature (user request).** The hold-to-Send panel stops being a single easter egg
and becomes a game library. Under the stage there is now a horizontally scrolling,
Hulu-style rail of games. Vibe Blast is the first card and the built-in; everything
else is discovered from a new `games/` folder at runtime. Any Claude session in any
terminal, the manager instance, or the user with a text editor can add a game by
writing ONE html file — no registration, no restart. Editing that file reloads it
mid-play. Also removed the "All three pieces always fit somewhere…" hint line from
the Vibe Blast board.

**How it works.**

- *Discovery is the filesystem* (`src/main/games-library.js`). It scans `games/` for
  `foo.html` or `foo/index.html` (a folder so a game can ship assets), and pulls the
  card's name from the file's `<title>` and its subtitle from an optional
  `<meta name="game-description">` — metadata out of the HTML rather than a manifest,
  because a manifest is one more file to get wrong. An `fs.watch` on the directory
  debounces save storms into one rescan and pushes the new list over IPC. Watching is
  recursive on macOS/Windows; Linux gets a watcher per subdirectory, re-added on each
  rescan so a newly created game folder picks one up.
- *Hot reload* (`src/features/GamesManager.js`). On every library change: a game that
  vanished falls back to Vibe Blast, and a game whose mtime moved WHILE BEING PLAYED
  gets its iframe re-pointed. The mtime rides in the URL as a query string, which is
  what makes the edited file actually re-fetch instead of coming back from cache.
- *Thumbnails are the game.* Each card renders the real HTML in a scaled-down iframe
  (laid out at 4x the tile, `transform: scale(0.25)`) clipped to a fixed 152x86 box.
  No cover-art convention for game authors, nothing to regenerate, and an edited game
  re-thumbnails itself. A coloured initial sits underneath — not a second code path,
  just what stays visible if the render paints nothing. The host's theme is posted
  into each thumbnail too, or Vibe Blast's card would sit in light mode in a dark app.
- *Keyboard.* Games want WASD and the arrows, which the app binds for its own hotkeys.
  Because a game runs in an iframe its keydowns land in a different document and can
  never reach the app's handlers — so the whole problem reduces to making sure the
  iframe holds focus. The frame takes `tabindex=0` and is focused on panel open, on
  card select, and on any click on the stage; a "click to play" pill appears whenever
  focus has drifted, so keypresses are never silently swallowed.
- *The panel tracks the window.* Its geometry lives in two custom properties
  (`--vibe-shift`, `--vibe-top`) that must hold PIXELS — the panel and its siblings
  move by the same distance, and a percentage transform would resolve against each
  element's own height and shear them apart. Pixels don't self-update, though, so
  the values were written once at open time and went stale on the first window
  resize: the panel kept its old height and stopped sitting on the sidebar's bottom
  edge, leaving the games flap floating short of it. A ResizeObserver on the sidebar
  (plus a scroll listener for `--vibe-top`) now re-syncs them, and a `vibe-resizing`
  class suppresses the 520ms slide during a drag — that transition is driven by the
  very value being changed, so leaving it on made the panel chase the window edge
  half a second behind. Closing resets the memo of what was last written, or
  reopening at an unchanged size would hit the no-change guard and never re-set the
  properties at all.
- *The rail reconciles, it does not rebuild.* Selecting a game used to re-run a full
  `replaceChildren()` render, which destroyed and recreated every thumbnail iframe —
  so one click made the whole shelf drop to its placeholder and re-render, a visible
  flash. Cards are now keyed by game id and reused; a card's iframe is re-pointed
  only when that game's mtime actually moves; and order is expressed with the flex
  `order` property rather than by moving nodes, because relocating an iframe in the
  DOM reloads it. Selection now touches nothing but a CSS class. The placeholder
  behind a thumbnail is also just a plain surface now — the coloured gradient and
  the initial letter are gone, since anything decorative there reads as a flash of
  the wrong card.
- *Manual rescan.* A refresh button beside the folder icon calls a `games:refresh`
  IPC that re-runs the scan AND re-arms the watchers, then reports the new count to
  the action log. The watcher normally makes this unnecessary, but `fs.watch` does
  miss events (network mounts, editors that save by atomic rename), and re-arming
  also recovers a watched directory that was replaced wholesale.
- *Shelf head layout.* "GAMES" sits left, the folder button right, and the grip is
  absolutely centred against the head so the folder icon can't pull it off centre.
  The head carries no bottom padding (the gap lives on the rail's padding-top
  instead), because the grip centres on the head's padding box and any padding there
  would drop it below the label's optical centre. No chevron — the grip is the
  affordance.
- *The shelf collapses to nothing but its flap.* Collapsing folds away the rail AND
  the label, chevron and folder button, leaving only a centred grip tab — the whole
  bottom bar goes from 178px to 15px, so the stage gets essentially the entire panel
  and a game can run full-height. It reuses the
  right sidebar's existing convention — a `collapsed` class and a
  `panelCollapsed:games` localStorage key — but is handled in GamesManager rather
  than by renderer.js's generic `.collapse-toggle[data-collapse-target]` sweep, so
  the flap can be a full-width grip bar instead of a rotating chevron button. The
  flap itself never collapses, and the state survives a restart.
- *`games/` is tracked but its contents are not.* `games/.gitignore` contains `*` and
  `!.gitignore`, so the one tracked file in the folder is the ignore file itself —
  which keeps the directory in a fresh clone while the library stays local. Vibe Blast
  is the exception and remains a tracked file at the app root.

**Verified.** Live-probed the real app, 16/16 green, isolated `--user-data-dir`:
panel opens with rail and hint; Vibe Blast is first and active; `key-probe.html` is
discovered with its title and description; a file WRITTEN while the app runs appears
in the rail; selecting it swaps the stage and renders; EDITING it hot-reloads the
running game (rev 1 -> rev 2); DELETING it removes the card and falls back to Vibe
Blast; `d/d/s` and `ArrowLeft/ArrowUp` both drive a focused game while the app's own
single-key hotkeys stay inert; `git check-ignore` confirms games are ignored and
`git ls-files games/` returns only `.gitignore`. Measured uniform 152x86 tiles with
single-line ellipsis on long titles and descriptions; screenshotted dark and light.
A second 10/10 pass covers the flap: it collapses the rail to zero height, the stage
grows into the freed space (622px -> 785px), the collapsed bar measures 15px against
an expanded 178px with the label gone and only the grip left, the flap stays usable,
`aria-expanded` flips, the choice persists to localStorage, and a COLLAPSED shelf is
still collapsed after a full app restart with the cards intact once reopened.

**Files.** `src/main/games-library.js` (new), `src/features/GamesManager.js` (new),
`games/.gitignore` (new), `main.js`, `index.html`, `style.css`, `renderer.js`,
`src/features/VibeBlastManager.js`, `vibe-blast.html`.
---
## 2026-07-31 — Bug fixes: Claude launchable via the control API on macOS, /tmp watcher subsystem deleted, timer-expiry interval leak, double-injection hole closed (branch `perf-startup`)

**1. macOS runtime detection (`src/main/terminal-runtime.js`, fixes `POST /terminal/claude`).**
Runtime detection read `/proc`, which does not exist on darwin — every terminal
was `runtime: "unknown"` forever, so `pty-control` refused `POST
/terminal/claude` unconditionally on macOS (external controllers had to inject
the shell command as text instead). Darwin now takes ONE `ps -axo
pid,ppid,command` snapshot (cached 1.5s — the runtime watcher polls every 2.5s
and `/state` enriches per request) and walks the PTY's child tree from it. The
claude CLI rewrites its process title so argv[0] is literally `claude`; a
freshly exec'd one shows the binary path whose basename is `claude` — either
counts. An injected `procRoot` (tests/Linux) still takes the `/proc` path;
`liveCwd` stays /proc-only, so the live-directory enrichment remains
Linux-only. Verified live on macOS: `/state` reports `shell`/`claude`
correctly, `POST /terminal/claude` returns `{ok:true}`, and the terminal's
runtime flips to `claude` after launch.

**2. /tmp trigger-file subsystem deleted (`main.js`).**
Three `fs.watch`-based control channels (addmsg, clear-queue, terminal-status
via `/tmp/claude-code-*` files) were dead end-to-end: nothing in the repo
writes those files (the backend's only references are in tests for endpoints
that no longer exist; the Docker backend has no /tmp mount at all), and the
renderer never listened for any of the IPC events they sent. The
terminal-status watcher was also actively harmful: it watched ALL of `/tmp`
(waking the main process on every unrelated file event on the machine) and
registered an `ipcMain.once('terminal-status-response')` listener per event
that could never fire — a permanent listener leak. All three watchers, their
module state, and their before-quit cleanup are gone. External control lives
in the HookServer control API.

**3. Timer-expiry interval leak (`src/features/TimerManager.js` + `src/features/timer-expiry-stop.test.js`).**
When a countdown hit 0, the 100ms tick interval ran FOREVER (10 display
updates + EventBus emits per second for the life of the process), and expiry
armed a 500ms "glow" interval that only an explicit Stop cleared. Expiry now
clears the tick and sets `timerRunning=false` (`timerExpired` stays true, so
the display keeps its 00:00:00 `.expired` styling and `isRunning()` reports
false exactly as before — the injection gate behavior is unchanged). The glow
machinery is deleted outright: the classes it toggled (`glow-pulse`,
`glowing`) have NO CSS rules — it was visually dead code. New tests cover the
leak plus the tuned resume semantics: restart-after-expiry via `startTimer`,
the usage-limit release path (`stopTimer` + `startCountdown`), pause/resume,
single `timer:expired` emission, and the constructor's no-localStorage
guarantee. The pre-existing `timer-expiry-resume` gate test still passes.

**4. Injection retry chains + double injection (`src/messaging/MessageQueueManager.js` + `src/messaging/injection-retry-guard.test.js`).**
The "all target terminals busy" branch spawned an INDEPENDENT unguarded 1s
`setTimeout` chain per caller — chains stacked forever, each tick emitting a
log action (a backend POST every 3s for as long as any terminal was busy). Now
one guarded handle (`_busyRetryTimer`): a single pending retry, ever.

While in there, the DOUBLE-INJECTION question was settled: **yes, the queue
layer could inject the same message twice.** A message queued without an
explicit terminal resolves its target at pick time
(`msg.terminalId || activeTerminalId`). Neither picker checked
`currentlyInjectingMessages`, so when the active terminal changed while such a
message was mid-typing (the 150ms text→submit window), the status-change
picker re-matched the SAME message against the NEW active terminal and typed
it again — reproduced against the pre-fix code (message typed into terminals
1 AND 2). Both pickers now skip in-flight messages. Regression tests cover the
single-retry guard, retry-then-inject on release, the double-injection
scenario, and a no-over-blocking sanity check.

- Files: `src/main/terminal-runtime.js`, `main.js`,
  `src/features/TimerManager.js`, `src/messaging/MessageQueueManager.js`,
  `src/features/timer-expiry-stop.test.js`,
  `src/messaging/injection-retry-guard.test.js`.

## 2026-07-31 — Startup: 5.9s → 1.6s perceived; artificial delays and dead boot work removed (branch `perf-startup`)

**Problem (measured).** Instrumented cold starts (3 runs, isolated profile, 3
terminals + manager) put the loading overlay's disappearance at 5.9–6.1s and
renderer DOMContentLoaded at ~4.0s. Almost none of that was real work:

- The loading overlay added fixed theatrical delays — 300ms per progress step,
  800ms in `finish()` — after initialization had already completed.
- `StateManager.initialize()` synchronously read `localStorage.getItem('unifiedState')`
  on the boot path. That key is only ever written by the manual cmd+s save
  shortcut, so the read restored NOTHING — but the renderer's FIRST localStorage
  access synchronously initializes Chromium's whole storage area, which measured
  0.2–0.45s on a warm profile and multiple seconds on a fresh one.
- After removing that read, the storage-init cost just moved to the NEXT
  boot-path localStorage reader (TimerManager's constructor, then
  RemoteConnectionUI's recents render). The cost lands on whoever touches
  localStorage first.
- `createTray()` ran before `createWindow()`, spending ~60–80ms loading the tray
  icon before first paint.
- Each visible terminal loaded its WebGL addon synchronously during session
  restore (10–85ms per terminal, GPU-state dependent).
- `NotificationManager._renderItem` ran a whole-document `lucide.createIcons()`
  per notification row — 100 full-document scans while loading history at boot.
- `AppStateStore.setState` deep-cloned the ENTIRE app state on every call "for
  history" — and never read the clone. setState runs on every PTY output chunk
  and keystroke.

**Fix.**

- *`src/ui/loading-manager.js`*: `completeStep` advances immediately and
  `finish()` hides immediately — the overlay now tracks real work. The renderer
  ties the final step to `restoreTerminalsAndQueue()` actually resolving.
- *`src/state/StateManager.js`*: the dead `unifiedState` restore is deleted
  outright (deferring was rejected: restoring a months-old manual cmd+s snapshot
  at boot would be wrong even if it were fast).
- *Boot-path localStorage policy*: no synchronous localStorage access before the
  overlay is down. All three legitimate readers now restore on a new
  `app:boot:complete` event emitted right after the overlay hides: TimerManager
  display values, the sidebar panel collapse state, and the remote-connection
  recents list (invisible inside the closed command bar anyway; re-rendered on
  open). Plain `requestIdleCallback` was tried first and rejected — "idle"
  arrives during the restore chain's IPC await gaps, re-inserting the stall.
- *`main.js`*: window before tray.
- *`renderer.js`*: the WebGL addon attaches in an idle slot after first paint;
  terminals open on the DOM renderer and upgrade transparently (skipped if the
  terminal closed meanwhile).
- *`src/features/NotificationManager.js`*: `lucide.createIcons({ root })` scoped
  to the affected row/button.
- *`src/state/AppStateStore.js`*: the never-read `deepClone(this.state)` in
  `setState` is gone (per-chunk allocation, measured ~28µs per call at current
  state size — pure waste).

**Measured result (same probe, 3 runs before/after).** Loading overlay down:
5.88–6.06s → **1.33–1.95s**. Renderer DOMContentLoaded: ~4.03s → **0.44–0.50s**.
Terminals restored: ~4.6–5.0s → **1.27–1.55s**. First paint unchanged (~0.5s).

- Files: `src/ui/loading-manager.js`, `src/state/StateManager.js`,
  `src/state/AppStateStore.js`, `src/features/TimerManager.js`,
  `src/features/RemoteConnectionUI.js`, `src/features/NotificationManager.js`,
  `renderer.js`, `main.js`.
## 2026-07-31 — Scratchpad: a live-markdown notes tab in the left sidebar (branch `scratchpad`)

**Feature (user request).** The left sidebar gets a fifth tab, **Scratchpad**: one
persistent markdown document with an Obsidian-style live-preview editor. Formatting
appears as you type, and the raw `**`/`#`/`` ` `` syntax characters reveal themselves
only when the caret is on or next to the thing they format. It is a single document
per app instance — not a note list, no title, no save button.

**Where the technique came from.** Ported from the note-body editor in **Peridot**,
the user's React note-taking app on the Pop OS box
(`/media/ethan/smalls/peridot/src/components/MarkdownEditor.jsx`). Worth recording:
the task asked for a project called "Paradox", which does not exist on that machine —
Peridot is the note app with this editor, and it is what was studied.

**How it works.**

- *The document is always plain markdown.* Nothing is rewritten into HTML. Formatting
  is a decoration layer painted on top of the text by CodeMirror 6, which is what keeps
  undo/redo, selection, arrow keys and the clipboard behaving like a normal textarea —
  and why copying a formatted region yields the raw source (CodeMirror's copy handler
  slices the document, not the DOM).
- *Two caret-proximity rules* (`src/features/ScratchpadManager.js`). Inline markers
  (`**`, `*`, `~~`, `` ` ``, `[…](…)`) reveal when the selection overlaps the parent
  styled span, tested inclusively at both ends so a caret sitting directly adjacent
  counts as inside. Block markers (`#`, `>`, `-`, `1.`, ```` ``` ````, `---`) reveal when
  the caret is anywhere on the same line — a span rule there would flicker mid-word.
  Because only decorations change, the document never changes when syntax toggles, so
  the caret cannot jump and fast typing cannot drop characters.
- *The task checkbox is the one exception* and uses the SPAN rule rather than the line
  rule (user call): the raw `- [x]` returns only when the caret is on or next to the
  marker itself, so writing a task's text doesn't make the box flicker away.
- *Sizing.* The editor runs at 26px — roughly 2x the sidebar's usual 13px, since notes
  are read rather than scanned like log output. Every other size in the block is
  em-relative so headings, code, bullets and the checkbox all track that one number.
  The checkbox needs an explicit `font-size: inherit`: form controls don't inherit it,
  so its em units would otherwise resolve against the browser's ~13px control default
  and the box would stay tiny however large the text got.
- *Widgets where hiding is not enough.* Bullets become `•` (ordered lists keep their
  number), `- [ ]` becomes a real checkbox that edits the source `[x]` on click, `---`
  becomes a rule. The ``` fence rows are collapsed with `display:none` rather than
  emptied, since a plain replace would leave two blank rows inside the code block.
- *Vendored CodeMirror* (`vendor/codemirror-md.js`, built by `npm run build:editor`
  from `scripts/codemirror-entry.js`). The `@codemirror/*` packages are ESM-only and
  `renderer.js` is a classic CommonJS script, so they are pre-bundled to a `CM6`
  global. A plain `<script>` tag also means Remote Mode gets the editor for free —
  `RemoteServer` already serves static files under the app root.
- *Persistence* reuses the existing store: debounced `db-set-setting` /
  `db-get-setting` IPC into `unified-store` under the `scratchpad` key (plus
  `scratchpadCaret`). No second mechanism was invented.
- *Tab wiring* follows the existing pattern exactly — a `sidebar-nav-btn` in
  `index.html` and one more entry in `ActionLogManager`'s `VIEWS` map.

**Verified.** Live-probed the real Electron app with the Playwright driver, 57/57
checks green, run against an isolated `--user-data-dir` (a first pass raced the
user's own running instance, which shares the store). Covered: the tab switches and
leaves the other four views untouched; all thirteen element types render inline;
each one reveals its syntax with the caret on it and re-hides when the caret leaves;
the task marker reveals on/adjacent to `- [ ]` and keeps its widget while the caret
is out in the task text;
caret-adjacent reveal works from both sides; typing 64 characters at zero delay drops
and reorders nothing and leaves the caret at the end; undo/redo; select-all copy
returns byte-identical raw markdown; and content survives a full app restart, restored
exactly and re-rendered. Screenshots taken in both dark and light themes — the CSS
uses only COLOR_PALETTE.md tokens, so the light theme needs no overrides.

**Files.** `src/features/ScratchpadManager.js` (new), `scripts/codemirror-entry.js`
(new), `vendor/codemirror-md.js` (new, built), `index.html`, `style.css`,
`renderer.js`, `src/features/ActionLogManager.js`, `package.json`.

## 2026-07-15 — Voice STOP-WORD INTERRUPT: saying "no …" (or "wait …") cuts off the manager's current turn and takes over (branch `ssh-view`)

**Feature (user request).** The manager sometimes keeps over-processing an
earlier message. Now, when a transcribed Discord voice message BEGINS with a
configured stop word, the bridge sends ESC to the manager terminal (999) —
aborting its in-flight turn — and then injects the whole message (stop word
not stripped), making it the freshest input.

**How it works.**

- *Bridge (`discord-bridge/src/controlApi.js`).* `sendVoiceMemo` (the single
  inject sink) checks the message's first token — lowercased, punctuation
  trimmed, so Whisper's "No," matches — against the stop-word list for
  `source === 'voice'` only (typed/file messages never interrupt). On match:
  `/terminal/keys ["esc"]` first, a 250 ms settle, then the normal
  text + enter injection. An ESC failure is non-fatal — the message is
  always delivered.
- *Live config (`discord-bridge/src/appSettings.js`).* `interruptStopWords()`
  mirrors the app's persisted `interruptStopWords` setting from
  `~/.config/auto-injector/auto-injector.json` on every call (mtime-cached,
  same pattern as `wakeSilenceMs`) — edits apply to the NEXT voice message
  with no bridge restart. Code default `["no"]`; the user's active config is
  set to `["no","wait"]` per his request (he can remove "wait" in the UI if
  it false-triggers).
- *Settings UI (`index.html` + `renderer.js` + `style.css`).* "Interrupt stop
  words" in Settings → voice section: a chip list with per-word remove and an
  add box (input normalized like the bridge's matcher). Persists through
  PreferenceManager → `db-set-setting` → the same store the bridge mirrors.

**Verified.** Bridge unit suite (`controlApi.stopword.test.js`, 8/8, stub
control API): ESC fires FIRST then text+enter; normal/mid-sentence/typed
messages don't trigger; a LIVE list change flips behavior on the very next
message; ESC failure still injects. Headless UI probe on an isolated app:
default chip "no", adding "Wait!" normalizes to `wait`, removing works, and
the bridge's own mirror function read the edited store as the UI left it.
Production bridge restarted on the new code and auto-resumed: "linked to
session — manager 999 … reachable". Caveat noted: the running (pre-UI) app
serializes its settings cache on write, so an app-side settings save before
its next restart could drop the hand-seeded `interruptStopWords` — the
bridge then falls back to `["no"]`, and the value is durable once the app
picks up this commit.

## 2026-07-15 — Remote Mode: live MESSAGE-QUEUE mirror — the SSH view stops showing already-delivered messages (branch `ssh-view`)

**User report.** The message-queue panel in the SSH remote view was stale:
messages already injected into terminals kept showing as queued until a
reconnect.

**Fix (same fan-out pattern as the terminal-metadata sync).** The local
renderer already ships its full queue in every `ccbot-state-snapshot` (sent
on each `message:queue-updated`, i.e. on every add / inject / remove /
update / clear). Main now diffs the snapshot's queue (JSON compare, so
status-only snapshots don't spam the socket) and pushes `remote-queue-sync`
to every attached WS client; the remote's `MessageQueueManager` applies it
via a new `applyRemoteQueueMirror` — pure state+display, no persistence, no
injection, guarded to remote renderers only. Boot catch-up: a welcome-time
push would race the bundle's listener registration, so the remote sends
`remote-queue-request` once its handlers are wired and the RemoteServer
answers that one client from main's snapshot cache.

**Debugging worth remembering.** The first e2e "failure" was the mirror
working perfectly: in a freshly-booted isolated app the runtime probe hasn't
classified terminals yet, the injection gates deliberately fail OPEN on
unknown runtime, and an idle bare-shell terminal swallowed the fixtures
immediately — the "wiped" queue was a genuine delivery (stack trace:
`_finishInjection`). The e2e now pauses auto-injection for the queued phases
and uses mark-urgent + `injectMessageNow` as the delivery probe.

**Verified headlessly** (`tests/integration/remote-queue-e2e.js`, isolated
instance): boot catch-up for a pre-attach message; live add → remote 23 ms;
Send-now delivery → panel settled without the delivered message 257 ms
(incl. typing); remove → 19 ms; clear (re-populated first) → 20 ms — all
within the 2 s budget, no reconnect, no polling. Regressions: unit suite
174/174; remote-meta-e2e still green (meta 15/21 ms, create 127 ms).

## 2026-07-14 — Single-file TTS model: speed/voice honored everywhere, pre-TTS cue on Discord, turn-taking hold restored (branch `ssh-view`)

**User reports (follow-ups to the burst-gate/TTS→sink work, live in-call).**
(1) TTS played at 1.0× instead of the configured `ttsPlaybackSpeed=1.25`.
(2) The short pre-TTS cue click (the renderer's heads-up chime) no longer
reached Discord. (3) TTS started playing OVER the user while still talking.

**Architecture (user's directive).** The backend generator (`/api/tts/speak/`,
untouched) is the single source of truth: it synthesizes ONE file at the user's
`ttsPlaybackSpeed` + `ttsPreferredVoice` (callers pass speed — the manager
already does; voice defaults from the backend's own preferred-voice config,
which the app syncs). Every consumer — desktop renderer, remote viewers, the
Discord bridge — plays that same file UNMODIFIED.

**Changes.**
- `NotificationManager._startAudio` no longer applies `playbackRate` to a clip
  that carries its own synthesis speed (prevents the Mac playing 1.25×-files at
  ~1.56×); legacy speed-1.0 rows keep the client rate so history sounds right.
  The Test button now bakes the speed into the sample. `manager-session.js`
  codifies "always pass speed". Remote bundle rebuilt (`npm run build-remote`)
  so attached viewers pick this up on refresh — no app restart.
- Bridge shim now plays the SAME cue click (`click2.wav`) immediately before
  each clip, and the gate pre-roll deepened 120→400ms: the click was being
  swallowed by the Discord client's stream-start ramp when it sat at the very
  head of a fresh burst; behind a 400ms silent lead-in it survives. Cue+voice
  ride one burst (gap ≪ 500ms hangover): click → voice, no gap.
- Turn-taking restored on the sink path: the shim holds each readout while
  `receiver.isUserSpeaking()` (up to `bargeInMaxHoldMs`), then plays the FULL
  reply — playback is serialized per row (awaited paplay) so clips never
  overlap, and the echo gate is re-marked at actual playback time so a held
  clip can't be transcribed as the user. Interrupt stays OFF via the existing
  `BARGE_IN_INTERRUPT_ENABLED=false` systemd drop-in.

**Verified live** (#1461, speed 1.25 bf_emma, duration 3925ms): cue+clip on the
sink 218ms after synthesis, one burst of 4410ms (400 preroll + ~130 click +
3925 voice), 4021ms wall vs 3980ms played — zero steady-state drift.

## 2026-07-14 — Discord voice round-trip: TTS restored on Discord, output latency made flat (burst gate), silence slider verified live (branch `ssh-view`)

**User reports (live in a Discord call, viewing from the Mac over SSH).**
(1) The manager's TTS voice was completely inaudible on Discord while it played
perfectly on the Mac. (2) Sounds that did reach Discord (the hud4 "sent" chime)
arrived ~5 s late, so the whole ask→answer loop felt ~5 s slow. (3) The "Stop
after silence" slider seemed to have no effect on in-call capture.

**Where the seconds actually went (measured, journalctl timestamps).**
- *Input path was honest:* last-audio → capture cut tracked the slider exactly
  (802 ms at 1000 ms, 2288–2305 ms at 2500 ms), Whisper 90–950 ms, then
  `/terminal/keys` writes straight to the manager PTY (no queue, no gates) with
  a 180 ms text→Enter delay. Stop→injected ≈ 1.1–2 s at the 1000 ms setting.
- *The slider works and always did:* today's log shows applied silence moving
  5000→3000→2500→1000→2500 as it was dragged; the remote panel's writes go over
  the WS (`db-set-setting`, no allowlist) into `auto-injector.json`, which the
  bridge re-reads per capture. The value had been left at 2500 (each renderer
  caches prefs independently — a second stale panel can silently rewrite it);
  set back to the intended 1000 via the app's own WS invoke.
- *TTS silent on Discord — root cause:* the v1 "no-double-play" rule. With a
  Remote Mode viewer attached, the local renderer suppressed TTS playback, so
  nothing reached the `auto_null` sink whose monitor the bridge streams
  (`AUDIO_SOURCE=system`). Discord went silent precisely because the Mac was
  watching. Fixed app-side by terminal 1's verified DUAL-OUTPUT patch (applied,
  tests 11/11, commit `74a376b`): renderer keeps playing with viewers attached.
  Until the app's next restart picks that up, the bridge runs a TTS→sink shim:
  it fetches each clip and paplays it into the sink itself — `auto` mode plays
  only while a viewer is attached AND the running app predates the patch
  (process start time vs patched-file mtime), so it steps aside automatically
  after the restart. Verified live: synthesis → audible on Discord in ~1.4 s
  (poll ≤1.5 s + 0.3 s sink→channel), Mac copy via the WS forwarder in ≤2 s.
- *The ~5 s everything-late feeling — root cause:* the bridge streamed the sink
  monitor as ONE eternal Opus stream. The keepalive keeps the monitor producing
  continuous PCM, so the bot "spoke" 24/7 and Discord's adaptive jitter buffer
  never got a silence gap to reset on — every hiccup became permanent added
  delay that only grew with call time. Fixed with a **burst gate** in the
  bridge player: watch the PCM for sound (s16 peak > 300 ≈ −41 dBFS), stream
  each burst as its own resource seeded with 120 ms pre-roll, end it after
  500 ms trailing silence. The bot now starts/stops speaking like a human,
  the receive buffer resets per burst, and latency stays flat. Measured after
  restart: chime = 720 ms burst, sender backlog 10–140 ms; a 14 s TTS clip
  split naturally across a sentence pause into 6.9 s + 4.1 s bursts. Barge-in
  mute now zero-fills inside the hangover so muting cuts the relay instantly.

**Knobs** (bridge `.env`): `SYSTEM_GATE_ENABLED/THRESHOLD/HANGOVER_MS/PREROLL_MS`,
`TTS_TO_SINK=auto|always|off`, `REMOTE_VIEW_PORT`. Expected stop-talking →
manager-injected ≈ 1.1–2 s at the 1000 ms slider; sounds → user's ear well
under 1 s plus Discord's own transport (~0.2 s), instead of an ever-growing
multi-second buffer.

## 2026-07-14 — Remote Mode: live terminal-metadata sync — renames, colors, create/close reach every attached view in milliseconds (branch `ssh-view`)

**User report.** Terminal title/color changes and add/remove didn't show up in
the SSH remote view without reconnecting.

**Fix.** `setTerminalMetadata` (the one funnel behind the inline rename
editor, the color picker, and the Control API's `terminal-update`) now sends
`terminal-meta-changed` to main, which fans it out to every attached renderer
as a `remote-terminal-meta` push over the existing WS — event-driven, no
polling. Receivers apply through the same method with a `fromSync` guard so
the originator's echo can't loop. Bidirectional: a rename in the remote view
lands on the desktop (where it persists) and vice versa. Create/close already
broadcast; verified they ride the same fan-out. The `/state` snapshot also
refreshes on metadata changes so the manager sees current titles.

**Verified headlessly** (`tests/integration/remote-meta-e2e.js`, isolated
instance): desktop→remote title+color 3 ms, remote→desktop rename 4 ms (color
survives partial updates), create→view 50 ms, close→drop 6 ms — all far inside
the 2 s budget, without reconnecting. Full unit suite: 174/174 pass.
See docs/REMOTE_MODE.md §11.

## 2026-07-14 — Remote Mode UI cleanup + mic-picker polish: one connect button, no floating mic, click-away dismiss, explicit Off + auto-resume (branch `ssh-view`)

**User reports (viewing from the Mac over SSH).** (1) Two stacked `<>` buttons
bottom-left: the embedded remote view renders the same `index.html` as the
desktop, so the footer's connect indicator painted as a DEAD blue button right
under the outer app's live green "Remote: host" pill (RemoteConnectionUI
deliberately never initializes in a remote view — the markup still did).
(2) A large floating circular mic button (injected by `remote-mic.js`) sat
bottom-left overlapping the message input. (3) The connect/SSH panel only
closed via a tiny X.

**Fixes.**

1. *One connect button (`src/remote/remote-bootstrap.js`).* The bootstrap now
   hides `#remote-indicator` before first paint in every remote client — only
   the outer desktop app offers a connect control (no nested remote hops
   anyway).
2. *Floating mic button removed (`src/remote/remote-mic.js`, `renderer.js`).*
   Settings → Microphone is now the single mic control in the remote view: it
   gained an explicit **"Off — don't stream this device's mic"** row (also the
   default for a first-time viewer — never streams without an opt-in), picking
   a device starts/re-targets the stream, and the choice persists per-browser
   and **auto-resumes on the next connect**, so the wake word works over SSH
   without reopening Settings every time. While streaming, the app's own voice
   button carries the wake-state glow (green listening / yellow capturing /
   blue transcribing) instead of a second floating control. Picking "Off" (or
   never opting in) leaves the manual voice button on the browser-default mic.
3. *Click-away dismiss (`RemoteConnectionUI.js`, `index.html`, `style.css`).*
   The X buttons on the connect bar and the management popover are gone; a
   pointerdown anywhere outside the open panel dismisses it (Esc still works).
   The corner indicator keeps its toggle, and a connect in flight pins the bar
   open so the status line / password prompt can't vanish mid-attempt.

**Verified headlessly** (isolated app + headless Chromium, own ports/config —
the production instance untouched): `remote-mic-e2e` now additionally asserts
no `#remote-mic-btn`, hidden inner indicator (`display:none` computed), no X
buttons, outside-click dismiss + inside-click survival, the picker listing the
BROWSER's fake devices with Off first/selected, selection starting the stream
on the exact picked device (track label echoed), the voice-button glow, and
Off stopping the stream — all before the unchanged wake-word/Whisper pipeline
phases, which still pass (real Vosk detection, byte-exact WAV, memo to 999).
`remote-tts-e2e` gained a panel-mirror probe: a notification created BEFORE
the viewer attaches renders in the client's Notifications panel via the /api
reverse-proxy history load (provably not WS-pushed). NOTE: TTS dual-output
(desktop sink + viewer simultaneously) was implemented and e2e-verified here,
then handed to terminal 2 with the Discord-audio workstream — the verified
patch is preserved for T2; this tree reverted to the ship-state suppression
behavior to avoid concurrent edits.

## 2026-07-14 — Remote Mode: the mic picker now selects the VIEWER's microphone; voice button, TTS read-aloud and the notifications list now work over SSH (branch `ssh-view`)

**Bugs (reported by the user, viewing from his Mac over SSH).** (1) Settings →
Microphone was useless in the remote view: it didn't list the Mac's mics, and
selecting anything did nothing — worse, it would have overwritten the DESKTOP's
saved microphone with a device id that only exists on the Mac. The remote mic
forwarder (`remote-mic.js`) always captured the browser's default device. (2) The
voice button was dead remotely: the renderer fetched the Whisper/TTS backend at
`http://localhost:8123`, which in a browser is the VIEWER's machine (and CORS
blocks it even when one exists). (3) No TTS read-aloud and an empty Notifications
panel in the remote view — root cause found live: Electron's Node resolves
`localhost` to `::1` first with no IPv4 fallback, while the Docker backend
publishes on `127.0.0.1` only, so the main-process TTS remote forwarder got
ECONNREFUSED on every poll, silently, forever — not one notification was ever
pushed to a browser client (the Discord bridge worked because it's a separate
plain-node process).

**Fixes.**

1. *Backend base URL (`src/utils/backend-url.js`).* Default host is now
   `127.0.0.1` (kills the ::1 trap for every main-process consumer, including
   the TTS forwarder), and in a Remote Mode browser it resolves to `''` — all
   `/api/...` fetches go same-origin to the server that served the page.
2. *`/api/*` reverse proxy (`src/main/RemoteServer.js`).* The RemoteServer now
   streams any-method `/api/*` requests to the desktop's loopback backend, so
   the browser's Whisper transcription, TTS notification list/audio, and
   frontend-log calls all work over the one tunneled port. Same trust boundary
   as before: loopback bind + the user's SSH tunnel.
3. *Per-viewer mic picker (`renderer.js`, `src/remote/remote-mic.js`,
   `src/features/VoiceManager.js`).* In the remote view the Settings mic picker
   enumerates THIS browser's inputs; the choice is stored per-browser
   (localStorage), never in the shared preference. Picking a mic (re)starts the
   remote-mic stream on that exact device (deviceId-exact capture with fallback
   to default if it vanished), so wake word + voice pipeline listen to the
   selected Mac mic; the voice button records from it too. The desktop's own
   picker/preference behavior is untouched, as is the single-owner relay rule.
4. *Notifications list mirror (`renderer.js`).* A remote client now loads the
   notification history and polls through the proxy, so the panel is populated
   remotely; the id watermark + items map dedupe rows/playback against the WS
   audio pushes (whichever arrives first wins).

**Verified.** `tests/integration/remote-mic-e2e.js`, `remote-tts-e2e.js`,
`remote-client-e2e.js` all pass on the change (headless Xvfb, isolated
instances, real Vosk); plus live headless-Chromium verification against the
deployed `aci-serve` server on :8130 — see the goal's evidence.

---

## 2026-07-14 — Remote Mode client: renderer reload no longer orphans the tunnel; reconnect supersedes stale state (branch `ssh-view`)

**Bug (reproduced by the user).** With a remote connected, a HARD REFRESH of the
renderer reset the UI, but the main process kept the live connection and the
`ssh -N -L` tunnel child. The app still believed it was connected, so the next
connect was rejected with "Already connected — disconnect first" and the only
way out was a full app restart — with the orphaned ssh tunnel still running.

**Fix — two independent layers.**

1. *Renderer-lifecycle cleanup (`main.js`, createWindow).* The main window's
   webContents now tears the Remote Mode client connection down whenever the
   MAIN frame really navigates (`did-start-navigation`, main-frame + not
   same-document — a reload of index.html; the embedded remote iframe is a
   subframe and never triggers it), and on `render-process-gone` /
   `destroyed`. Handles both the Electron 26+ event-object shape and the
   legacy positional args. So a refresh (or a crashed renderer) kills the
   tunnel child and resets main-process state to idle immediately.
2. *Reconnect supersedes (`src/main/remote-client.js`).* `connect()` no longer
   hard-fails on "already connected/connecting". Every connect and disconnect
   bumps a connection GENERATION; a new connect first kills any existing
   tunnel, and an in-flight connect checkpoints the generation after every
   await and aborts (rejecting with `superseded: true`, never clobbering the
   newer operation's state) when it has been overtaken. `disconnect()` stays
   idempotent and now also cancels an in-flight connect. So even if some
   future path leaves stale state behind, the user can ALWAYS just connect
   again.

**Verified (headless Xvfb, isolated XDG_CONFIG_HOME, real throwaway sshd —
`tests/integration/remote-client-reload-e2e.js`).** (a) connect → `page.reload()`
→ main-process state idle, forwarded port closed, ZERO orphaned `ssh -N`
children (pgrep scoped to the test's remote port); (b) a fresh connect after
the reload SUCCEEDS (status log shows no "already connected") and the embedded
terminal echoes a marker end to end; (c) a second `remote-client-connect`
while connected supersedes cleanly — new tunnel up, old one torn down, exactly
ONE ssh child; (d) disconnect is idempotent and leaves zero ssh children, and
a normal UI connect→disconnect cycle still passes. Regressions: the full
original `remote-client-e2e.js` (auto-enable, auto-start, fast path) and
`remote-client-password-e2e.js` (password auth path) both pass unchanged;
`node --test` suite 162/163 (the one failure is the pre-existing, unrelated
`tests/unit/usage-limit-and-gate.test.js`). New unit tests cover supersede /
in-flight-abort / idempotent-disconnect (`src/main/remote-client.test.js`,
34/34).

- Files: `main.js`, `src/main/remote-client.js`, `src/main/remote-client.test.js`,
  `tests/integration/remote-client-reload-e2e.js`.

## 2026-07-14 — Remote Mode client: SSH password fallback, VS Code style (branch `ssh-view`)

**Goal.** Connecting to a remote previously required working key/agent auth
(`BatchMode=yes`) and silently failed without it. Now it behaves like VS Code
Remote-SSH: keys are tried first, silently; if — and only if — authentication
fails, a password field appears in the top-middle command bar (labelled with
the destination, focused), and the typed password authenticates the retry. A
wrong password gives a clear "Wrong password for …" and an in-place retry.
Advanced also offers a "use password authentication" opt-in that asks up
front. Working keys keep connecting exactly as before, with no prompt.

**How the password reaches ssh (and where it never goes).** The retry runs
every ssh operation of the connect — the session-file read, the
ensure/auto-start step, the settle re-reads, and the long-lived `ssh -N -L`
tunnel — through the new secret-free `scripts/ssh-askpass.sh` helper:
`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` plus a detached (`setsid`) spawn,
with the password riding only in that ssh child's environment
(`CCBOT_SSH_PASSWORD`). It is never in an argv (the `ps` exposure
`sshpass -p` has), never on disk, never logged, never in status events,
never saved to recents, and cleared from the UI whenever the bar closes.
`sshpass -e` (env mode) is the fallback mechanism; a clear message appears if
neither is usable. Wrong passwords fail fast (`NumberOfPasswordPrompts=1`);
auth failures are distinguished from unreachable-host and host-key errors,
which keep their specific messages; host keys stay `accept-new`.

**Files.** `src/main/remote-client.js` (auth modes, isAuthFailure/
sshFailureToError, askpass invocation), `scripts/ssh-askpass.sh` (new),
`main.js` (needPassword over IPC), `src/features/RemoteConnectionUI.js` +
`index.html` + `style.css` (password row + opt-in checkbox), docs
(`docs/REMOTE_MODE.md` §8).

**Verified.** Unit tests (`src/main/remote-client.test.js`, 30 pass) cover
auth classification and argv/env separation. New end-to-end
`tests/integration/remote-client-password-e2e.js` (headless, real OpenSSH +
real askpass against a real-protocol password-only SSH server — an
unprivileged sshd cannot verify passwords, so the server side is the `ssh2`
dev dependency): key attempt fails → prompt appears → wrong password →
clear retry → right password → live-enable + tunnel + embedded terminal
echo, then a secrecy sweep proving the password appears in no argv/`ps`
output, no log, no localStorage, and no file on disk. The key-only path is
still covered by `remote-client-e2e.js` against a real sshd, unchanged.

## 2026-07-13 — Remote Mode: voice notifications play on the device SHOWING the interface (branch `ssh-view`)

**Goal.** When the user watches the interface remotely (browser tab or the
in-app embedded client), spoken notifications must come out of THAT device —
not only out of the (usually headless) app host where nobody is listening.

**The path as found.** TTS was host-locked end to end: the manager POSTs
`/api/tts/speak/` to the Django backend (loopback :8123, Kokoro synthesizes a
WAV + persists a Notification row); the LOCAL renderer's NotificationManager
polls `/api/tts/notifications/` every 3s and plays `audio_url` through an
HTMLAudioElement — audio on the app host only. In Remote Mode the browser
renderer was simply not initialized for notifications (the backend loopback is
unreachable from the viewer's machine — `localhost:8123` there is the WRONG
machine). `discord-bridge/src/audioPlayer.js` is the separate Discord-voice
playback path — untouched and orthogonal.

**What changed.** New `src/main/tts-remote-forwarder.js`: while ≥1 remote
client is attached (RemoteServer's new `onClientsChanged` hook), main — where
the backend loopback IS reachable — polls the same endpoint, fetches each
fresh notification's WAV, and pushes it (base64, with metadata) to every
attached client over the EXISTING token-gated WebSocket
(`remote-tts-notification`). The remote renderer
(`NotificationManager.initializeRemote`) turns the bytes into a `blob:` URL,
renders the row, and plays it with the same queue/chime machinery — sound on
the viewing device, both for a plain browser and the embedded iframe (one
renderer path). Played-marks ride back over the WS (`remote-tts-played` →
main POSTs `/played/`). No new ports, no re-implemented TTS.

**Which device plays (no double-play).** ≥1 remote client attached → the
client(s) play; the local renderer holds AUTO playback (push
`remote-clients-changed` + boot invoke `remote-clients-count`; rows still
render and an explicit ▶ replay is always honored locally). 0 clients → local
playback exactly as before. The forwarder re-baselines on every attach so
history never replays into a fresh client. A plain browser blocking the first
autoplay requeues the clip and plays it on the first click/keypress.

**Verified** (headless: Xvfb Electron + headless Chromium + a Django-shaped
stand-in TTS backend serving real WAV bytes through the same code path —
`xvfb-run -a node tests/integration/remote-tts-e2e.js`): the pushed audio
arrived at the client byte-for-byte (19244 === 19244), the client drove
playback (blob src, `play()` resolved, `playing=true`, currentTime advancing),
the played-mark round-tripped client → WS → main → backend, the local renderer
never touched its audio element, and after detach a new notification played
locally again. Acoustic output itself can't be captured headless; the full
delivery + playback-invocation chain is what's proven. Plus 11 unit tests
(`tts-remote-forwarder.test.js`, `NotificationManager.remote.test.js`,
`NotificationManager.local-sink.test.js`) and a clean re-run of
`remote-client-e2e.js` (embedded-client regression).


## 2026-07-13 — Remote Mode CLIENT: in-app "Connect to a remote machine" (VS Code Remote-SSH style; branch `ssh-view`)

**Goal.** The other half of Remote Mode: a corner control IN the app so a user
on their laptop can attach to a remote machine's running interface with one
click — no browser tab, no manual `ssh -L`, no copying tokens.

**What was built.** A VS Code-style indicator pinned to the BOTTOM-LEFT corner
of the interface opens a "Connect to a remote machine" panel (host/IP, SSH
port defaulting to 22, username, recent connections remembered locally, plus
an Advanced section: remote session-file path override and extra ssh options
like `-i`). On Connect the app does the whole attach sequence automatically:
(1) it shells out to the system `ssh` (so the user's own `~/.ssh/config`,
keys, agent and known_hosts apply; `BatchMode=yes` means it can never hang on
a password prompt) and reads the remote's
`${XDG_CONFIG_HOME:-$HOME/.config}/ccbot/session.json` to learn the remote
RemoteServer port and session token — the token only ever travels inside the
SSH channel; (2) it spawns and owns an `ssh -N -L 127.0.0.1:<free-local>
:127.0.0.1:<remote>` tunnel child (`ExitOnForwardFailure`, keepalives, killed
on disconnect and on app quit); (3) once the tunneled server answers, it loads
the remote interface in a full-window sandboxed iframe — the remote machine's
terminals, manager and queue, 1:1 interactive, inside the app. The indicator
turns green ("Remote: host"); clicking it gives Disconnect, which tears the
tunnel down and returns to the local interface. Unexpected tunnel drops are
pushed to the renderer and produce a clear message instead of a dead view.
Clear, specific error messages cover: no ccbot session file (app not running
there), app running but Remote Mode OFF (says to set CCBOT_REMOTE=1), ssh
auth failure, changed/unverified host key, unreachable host. New files:
`src/main/remote-client.js` (main-process client, pure Node, strict input
validation so form values can never be parsed as ssh options),
`src/features/RemoteConnectionUI.js` (indicator/panel/iframe UI, skipped in
remote browser views — no nested hops); wired in `main.js` (3 IPC handlers +
quit cleanup), `renderer.js`, `index.html`, `style.css`. Design doc §8 in
`docs/REMOTE_MODE.md`.

**Verified end-to-end (headless Xvfb, real ssh + sshd, this machine as both
ends).** `tests/integration/remote-client-e2e.js` (committed; un-ignored in
.gitignore) launches a throwaway sshd (own host/client keys on a high port —
nothing in the user's ~/.ssh read or written) and TWO isolated app instances
(separate XDG_CONFIG_HOMEs; the machine's real interface untouched): one with
CCBOT_REMOTE=1 as the "remote", one as the client. Playwright then drives the
real UI: corner button opens the panel; a deliberately wrong session path
surfaces the clear "no session file / not running" error; a real connect
reads the token over ssh, opens the tunnel, and the embedded iframe
WS-authenticates and renders the remote terminal (replayed screen); a marker
command typed INTO the embedded view echoes back both in the embedded xterm
AND on the remote instance's own window (same PTY, proving the full
keystroke→ssh-tunnel→WS→PTY→broadcast loop); Disconnect hides the view,
returns the indicator to idle, closes the forwarded port and leaves no ssh
child. 16/16 checks passed; screenshots + transcript captured. Unit tests:
14 new (`src/main/remote-client.test.js`) — validation, session parsing,
ssh-stderr classification — all green; full tracked suite 120/120.

**Known gaps (v1).** Host keys use `accept-new` (first contact auto-recorded;
CHANGED keys still hard-fail — no interactive fingerprint prompt yet); no
"start Remote Mode on the remote machine for me" — the remote must already
run with CCBOT_REMOTE=1; one remote at a time; the local interface keeps
running underneath the embedded view (by design, so local terminals continue).

## 2026-07-13 — Remote Mode MVP: the full interface served to a browser over HTTP+WebSocket (branch `ssh-view`)

**Goal.** The VS Code Remote-SSH analog designed in `docs/REMOTE_MODE.md`: a
browser on another machine (via SSH tunnel / Tailscale) gets a 1:1, fully
interactive replica of the running interface — every terminal, the manager
(999), the queue, the whole UI — so a headless box needs no monitor. Strictly a
superset of the read-only `npm run ssh-view`.

**How it works.** A new `src/main/RemoteServer.js` (loopback-only, off by
default; enable with `CCBOT_REMOTE=1` or the `remoteServerEnabled` setting)
serves the app's real `index.html` — transformed at request time to load
`src/remote/remote-bootstrap.js` plus an esbuild bundle of the unmodified
`renderer.js` + `src/**` (`npm run build-remote`; `electron`/`fs`/`path`/
`vosk-browser` external, `__dirname` defined) — and upgrades to a WebSocket
that bridges the entire Electron IPC surface: `send`/`invoke` frames dispatch
to the very same `ipcMain` handlers (captured registration maps in `main.js`),
and every `webContents.send` push now fans out through `broadcastToRenderers`
to the local window AND all attached browsers, including the raw
`terminal-data` PTY stream. The bootstrap installs a `require` shim and a
`wsIpc` object implementing the `ipcRenderer` contract, so the SAME renderer
runs unchanged in the browser.

**Correctness (the hard part).** A second full renderer must not double-drive
the app. `window.__CCBOT_REMOTE__` guards: the injection engine (single sink
`_injectToTerminal` plus the sequential paths), queue/history persistence, the
manager scheduler (no boot typing, no pass loop, no completion watch — the
browser only ATTACHES a view of the live 999 PTY), `ccbot-state-snapshot`
(also dropped server-side), and the completion summarizer. `terminal-start`
for an existing PTY attaches + replays the current screen (late-join catch-up
via the existing `readTerminalScreen` path) instead of respawning — enforced
in both the RemoteServer and main's handler. Browser-added queue messages are
forwarded (`remote-queue-add`) to the authoritative local queue and echo back
to every view; terminals created/closed in ANY renderer sync to all others
(`remote-terminal-created`/`-closed`).

**Security.** Same posture as ssh-view: binds `127.0.0.1` only, reuses the
HookServer session token (constant-time compare at the WS `hello`; bad token →
socket closed), token travels only in the URL *fragment* (`/#k=<token>`,
stripped immediately, never in server logs), transport is the user's SSH
tunnel or Tailscale. The remote port is advertised in the 0600 session file;
`npm run remote-url` prints the access URL + tunnel line.

**Verified running (headless, Xvfb + real headless Chromium against the live
app):** WS auth (bad token rejected 4403 / good token → `welcome` snapshot),
the real renderer boots in the browser with zero fatal errors, terminals AND
the live manager (999, mid-session Claude UI) render with replayed screens,
keystrokes typed in the browser xterm reach the PTY and echo back, resize
round-trips (`stty size` reports the new dims), remote invokes read AND write
the real store, a snapshot poisoning attempt from the WS is dropped, a
terminal created in the browser appears in the local renderer's `/state` and
is a live echoing PTY. 9/9 protocol + 7/7 + 5/5 browser checks passed.

**Known gaps (v1).** Queue edits/removals/injections don't live-sync to a
remote's queue *display* (adds do; the authoritative queue is always the local
one); replay is plain text (colors of the backlog are lost); desktop-only
invokes (file dialogs, tray) act on the host; no settings-UI toggle yet (env
var / setting only); PTY frames ride JSON (binary fast-path deferred).

## 2026-07-11 — Desktop app: one silence setting for both voice paths + barge-in on spoken notifications (STAGED — loads at the next app reload; branch `discord-integration`)

**Goal.** The user's voice should work through BOTH Discord and the desktop app,
governed by the ONE app "Stop after silence" setting, with barge-in on both.

**Finding: the single setting already reaches the desktop path.** The desktop
end-of-speech cutoff is `WakeWordManager.silenceMs`, fed live from the same
`wakeSilenceMs` preference the bridge now mirrors (`_checkVad` uses it as the
sole trailing-silence stop). The Django backend has NO silence logic at all — it
transcribes complete WAV uploads (no VAD, no silence parameter), so no backend
change and **no process restart of any kind** was needed. The only mismatch was
the clamp: desktop floored the value at 1000 ms while the new slider floor is
600 ms — `WakeWordManager._applyConfig` now clamps at 600 ms to match the bridge.
(`VoiceManager` push-to-talk is manual-only — no cutoff to unify.)

**Barge-in on spoken notifications.** Previously a mid-readout speech onset only
HELD the clip (pause → resume in place, force-played-through after 3 holds or
4 s — "completion is the priority"). Per the new product decision the user now
has the floor: `NotificationManager._interruptCurrentPlayback` STOPS the
readout outright on speech onset — no hold, no resume, the notification is
finalized as played, and the log notes where it was cut ("stopped the readout at
~3.5s/9.0s (~38%)"). Queued notifications still wait for silence before
starting; the hands-free reply window is deliberately NOT opened on an
interrupt (the user is already talking). Echo can't trip it: the existing gate
raises the VAD threshold 3× during playback (+400 ms tail) with a ~340 ms
sustained-run requirement — the same guard shape as the bridge's 350 ms/−40 dB.
Legacy hold-and-resume remains behind the `ttsBargeInInterrupt` preference
(default ON; no UI toggle yet).

**Tests.** `NotificationManager.test.js` + `tts-echo-gate.test.js` updated: the
hold tests now pin legacy mode explicitly; new tests cover interrupt mode
(stops for good, finalizes played, queued clips survive, replays don't double-
mark) and both modes of the loud-barge-in echo-gate test. 20/20 pass
(`node --test`).

**How to load it (user action, whenever ready).** These are renderer files —
the running Auto-Injector is untouched (restarting it would kill the manager,
so nothing was restarted). The changes take effect at the next deliberate app
relaunch/reload, which also loads the earlier-staged slider floor
(index.html `wake-silence-ms` min 2000→600, step 100).

---

## 2026-07-11 — Discord bridge: barge-in / interruptible TTS + auto-follow into voice (branch `discord-integration`)

**Barge-in.** The voice loop was walkie-talkie: once the bot started reading a
reply, the user had to wait it out. Now, when the user starts really speaking
while the bot is playing, the bot cuts its own audio so the user can talk over
it naturally.

- **Detection** (`voiceReceive.js` `_bargeInCheck`, fed every decoded 20 ms PCM
  chunk of the user's own receive stream — which we already capture during
  playback since `pauseCaptureDuringTts` defaults off): accumulate only while
  the bot is speaking; fire when ≥ `bargeInMinSpeechMs` (350 ms) of sustained
  audio measures ≥ `bargeInMinLevelDb` (−40 dBFS RMS). A too-quiet window resets
  the accumulator, so echo bleed and coughs can't trip it; fires once per
  speaking episode and re-arms when the bot goes quiet.
- **Action** (`session.interruptPlayback`): logs where the reply was cut
  ("at ~4.2 s (~35%) into the reply" — from the episode start + expected
  duration now tracked in `markBotSpeaking`). In **tts** mode it stops only the
  active clip (`player.interrupt()`; the queue is kept and the existing
  hold-check delays the next clip until the user finishes). In **system** mode
  (the live config — one continuous parec stream of the desktop sink) the
  desktop audio can't be stopped from the bridge, so the forwarded stream is
  MUTED in real time (a zero-fill Transform — no lag build-up, instant unmute);
  `_openGate`'s guaranteed reopen path un-mutes when the speaking window ends.
- New env knobs: `BARGE_IN_INTERRUPT_ENABLED` (default on),
  `BARGE_IN_MIN_SPEECH_MS` (350), `BARGE_IN_MIN_LEVEL_DB` (−40).

**Auto-follow** (`index.js` voiceStateUpdate + startup auto-resume): when an
authorized user joins a voice channel while the bridge is linked but idle, the
bot now joins them automatically — no `/resume` after a service restart.

Verified offline: syntax + module-load pass; detection fires at ~360 ms on loud
sustained speech, never on quiet audio, once per episode, re-arms per episode;
mute/unmute cycle confirmed against a stubbed player. Live verification happens
at the next safe bridge restart (deliberately deferred — the user was mid-
conversation; restart only in an idle window).

---

## 2026-07-11 — Discord bridge: app "Stop after silence" slider now controls the in-call voice-memo cutoff (branch `discord-integration`)

**Problem.** Changing the end-of-speech silence slider in the app did nothing to
Discord voice memos — every memo took ~5 seconds of silence to end.

**Root cause (two layers).**
1. **Stale process.** The live bridge service had been running since Jul 1 —
   a work-in-progress build from before commit `4645606`. In that build the
   in-call cutoff was tied to the app's `wakeSilenceMs`, whose default had been
   raised to **5000 ms** on Jun 25 (`d306bc7`, for across-the-room dictation)
   and was unset in the store — hence the constant ~5 s. The service was never
   restarted when the newer code landed, so nothing the user changed reached it.
2. **Decoupled by design in HEAD.** The current code had gone the other way:
   always-listen used a fixed `inCallSilenceMs` (1500 ms, env-only) and ignored
   the app slider entirely — so even after a restart the slider would still
   have done nothing. The 6 s auto-reply window was ruled out: it never feeds
   the always-listen silence choice.

**Change.**
- `discord-bridge/src/appSettings.js` — new `inCallSilenceMs()`: mirrors the
  app's `wakeSilenceMs` LIVE (re-read per capture, so a slider change applies to
  the very next utterance), floor **600 ms**, snappy **1200 ms** default when the
  app value is unset. `IN_CALL_SILENCE_MS` env pins it for testing only.
- `discord-bridge/config.js` — `config.inCallSilence()` (function, replaces the
  static `inCallSilenceMs`).
- `discord-bridge/src/voiceReceive.js` — `_capture` uses the live value and now
  logs, per utterance, `capture start: mode=…, end-of-speech silence=…ms` and
  `capture end: …ms from last audio to cut` so the applied cutoff is visible in
  the journal.
- `index.html` — the "Stop after silence" slider minimum lowered 2000 → 600 ms
  (step 500 → 100) so sub-2 s values are actually reachable in the app UI.
- `discord-bridge/src/index.js` + `resumeStore.js` — startup **auto-resume**:
  after a service restart the bridge re-links the last saved session and rejoins
  the user's current voice channel on its own (previously it idled until a
  manual `/resume`, which made every restart drop the relay).
- `discord-bridge/.env` — `DISCORD_ALLOWED_USER_IDS` set (user-approved): the
  Phase-2 deny-by-default auth from `4645606` went live for the first time with
  this restart and would otherwise have denied all commands/voice.

**Result.** With the user's current app value (2000 ms) the memo cuts ~2 s after
speech stops instead of ~5 s; dragging the slider down to ~1.2 s now takes
effect on the next utterance, no restart needed. One-off test
(`config.inCallSilence()`): app value respected, 600 ms floor, 1200 ms default,
env override — 6/6 pass. **Verified live 2026-07-11 14:19**: per-capture log
shows `applied silence=5000ms` and `capture end: 4798ms from last audio to cut`
— wall-clock matches the applied value, and the applied value matches the app
store exactly (the store's `wakeSilenceMs` had been changed 2000→5000 at 14:07,
so the mirror is demonstrably live). The slider now genuinely drives the
cutoff; drag it down for snappier memos.

---

## 2026-06-30 — Discord bridge: source-tagged forward framing + decouple text from voice (branch `discord-integration`)

**Fix 1 — framing by source.** A TYPED channel message was reaching the manager
wrapped in the VOICE-memo framing ("spoken aloud, auto-transcribed"), which is
wrong. `controlApi.frameMemo`/`sendVoiceMemo` + `linkManager.forward` now take a
`source` (and `paths`) so the wrapper matches how the input arrived. New formats:
- **voice** (transcribed speech): `🎙️ Voice memo from the user (spoken aloud, auto-transcribed — phrasing may be imperfect): "<text>"`
- **typed** (plain message or /prompt): `💬 Typed message from the user (Discord): "<text>"` — verbatim, no spoken/transcribed language.
- **file** (image/video): `📎 The user sent a file (Discord): <path>` · with caption → `… <path> — message: "<caption>"` · multiple → `📎 The user sent 2 files (Discord): <p1> | <p2>`.

Voice callers (`voiceReceive`) are unchanged (default source 'voice'); `/prompt`
and the auto-forward `messageCreate` pass `source: paths.length ? 'file' : 'typed'`.
(Single-line PTY constraint still collapses newlines to spaces on inject.)

**Fix 2 — text/files/forwarding no longer require a voice channel.** The
text-mirror channel was only resolved on voice `join()`, so outbox posts
(post-text/post-image), the mirror, and inbound forwarding only worked while in a
voice call. Now the channel is resolved at **login** (`index.js onReady` →
`textMirror.resolve(guild)`, with `guild.channels.fetch()` if the cache is cold),
so all of that works whenever the bot is online/linked. Only live audio capture
still needs a voice channel. Outbox CLI messages updated ("as soon as it is online
— no voice channel needed").

**Preserved.** Voice/always-listen, deaf-recovery, /stop, image-send, key logic —
untouched.

**Verified (bridge-only restart).** `node --check` + require-smoke clean. framing
suite — **14/14** (voice/typed/file wrappers + `sendVoiceMemo` branches on the
wire; empty-typed rejected, file-no-caption still sends). Regressions: autofwd 15,
/prompt 18. **Live:** restarted → `text mirror → #claude-voice (existing)` resolved
AT LOGIN (no voice), and `post-text` posted immediately (`📝 posted manager text …
not TTS'd`) while NOT in a voice channel — confirming the decouple.

---

## 2026-06-30 — Discord bridge: auto-forward all messages + manager text posts (branch `discord-integration`)

**Feature A — auto-forward every user message (no /prompt needed)** (`src/index.js`
`messageCreate`). When linked, ANY plain text the user types in the mirror channel
is forwarded to the manager automatically, exactly like a voice memo
(`linkManager.forward`); any image/video dropped is saved locally and its path
appended (`mediaInbox`). Text + media in one message → one combined forward. A
✅/⚠️ reaction confirms receipt. Unlinked → skipped silently (no channel spam);
`/prompt` still works (it's an interaction, not a channel message, so no
double-send). **Feedback-loop guard:** the bot's OWN messages are never forwarded
— filtered on `author.id === client.user.id` PLUS any bot/webhook author. So the
Heard/Replied mirrors, image posts, and the new manager-text posts can't loop.

**Feature B — manager posts TEXT to chat, NOT spoken by TTS** (`src/textMirror.js`
`postText`, `src/imageOutbox.js`, `tools/post-text.js`). The manager can now put
arbitrary text (e.g. clickable LINKS that TTS can't convey) straight into the
channel AS THE BOT. Reuses the existing outbox: a `{ "text": "…" }` descriptor in
`$XDG_RUNTIME_DIR/ccbot-bridge/outbox/` (same dir/watcher as post-image) → the
bridge posts it via `channel.send` — a plain Discord message that NEVER touches the
TTS/notification path, so it is not read aloud. Chunks over Discord's 2000-char
limit. Because it's the bot's own message, Feature A's self-ignore excludes it from
being forwarded back (no loop).

**How the manager posts text:**
```
cd /media/ethan/smalls/claude-autorunner/discord-bridge
node tools/post-text.js "Here's the PR: https://github.com/…/pull/42"
# or:  npm run post-text -- "…"
# raw: write {"text":"…"} to $XDG_RUNTIME_DIR/ccbot-bridge/outbox/<name>.json
```
It posts within ~1s once the bot is in a channel; it is NOT TTS'd and NOT looped
back to the manager.

**Preserved.** Voice/always-listen, /prompt, outbound post-image, deaf-recovery,
/stop, key logic — untouched.

**Verified (bridge-only restart).** `node --check` + require-smoke clean.
auto-forward + text-outbox suite — **15/15**: postText posts raw content + chunks
>2000 + blank/no-channel guards; outbox posts a `{text}` descriptor (and `{image}`
still works); post-text CLI writes the descriptor; self-ignore matrix (own message
/ other bot / webhook ignored; user text/image while linked → forward; unlinked /
empty → skip). /prompt regression 18/18. Live: bridge restarted, probe → Message
Content available, logged in clean, post-text CLI queued a descriptor. **Needs a
live call** to confirm plain-typing → manager and manager text post → channel
end-to-end.

---

## 2026-06-30 — Discord bridge: /prompt (typed) + inbound image/video → manager (branch `discord-integration`)

**Feature.** The user can now reach the manager (terminal 999) by TYPING and by
sending IMAGES/VIDEOS in Discord, not just voice. (Personal convenience — same
control-API path as voice.)

- **Typed prompt** (`src/commands.js`): `/prompt text:<…> [media:<attachment>]`.
  When linked, the text is forwarded to the manager via the EXACT same path a voice
  memo uses (`linkManager.forward` → `sendVoiceMemo`), so it arrives instantly,
  identically framed. Unlinked → clear ephemeral "run /link or /resume" note.
- **Inbound media** (`src/mediaInbox.js`): an attachment on `/prompt`, OR a plain
  image/VIDEO dropped in the text-mirror channel, is downloaded to a known local
  dir and its local PATH is attached to the forwarded message so the manager (same
  machine) can open it. Accepts images (png/jpg/gif/webp/…) AND videos
  (mp4/mov/webm/mkv/…); multiple attachments; per-message cap (`INBOUND_MAX_MEDIA`,
  10); size cap (`INBOUND_MEDIA_MAX_BYTES`, 25MB) — oversized/undownloadable files
  are skipped with a stated reason. Plain drops get a ✅/⚠️ reaction.
- **Message format the manager receives:**
  - typed: `🎙️ Voice memo from the user (…): "<your text>"` (the existing voice
    framing — manager treats it like any spoken memo).
  - media: the same framing wrapping `<caption?>  📎 N file(s) saved locally: <path1> | <path2>`,
    e.g. `… : "look at this 📎 1 file saved locally: /run/user/1000/ccbot-bridge/inbox/1782-ab12-screen.png"`.
    The manager reads the absolute path(s) after `saved locally:` (split on ` | `).
- **Where files land:** `$XDG_RUNTIME_DIR/ccbot-bridge/inbox/` (=
  `/run/user/1000/ccbot-bridge/inbox/`), named `<ts>-<rand>-<originalname>.<ext>`.
- **Intent safety** (`src/index.js`): plain drops need the privileged Message
  Content gateway intent. A throwaway **probe login** checks it BEFORE building the
  real client, so the bridge never crash-loops if it's disabled — it just logs a
  note and disables plain drops (/prompt still works). Probe confirmed it IS enabled
  for this bot. Added the non-privileged `GuildMessages` intent for `messageCreate`.

**Preserved.** Always-listen voice, outbound post-image, deaf-recovery, /stop, key
logic — all untouched.

**Verified (bridge-only restart).** `node --check` + require-smoke clean. /prompt +
media-inbox suite — **18/18**: composeForward formatting; isMedia accepts
image+video, rejects others; downloads image+video, skips oversized + non-media,
preserves extensions, honors the per-message cap; /prompt unlinked→note,
text→exact forward, text+media→caption + 📎 path. Live: bridge restarted, probe
→ "Message Content available", logged in clean, `/prompt` registered. New config:
`CCBOT_MEDIA_INBOX`, `INBOUND_MEDIA_MAX_BYTES`, `INBOUND_MAX_MEDIA`,
`ENABLE_MESSAGE_CONTENT`. **Needs a live call** to confirm a typed /prompt + an
image/video land on the manager end-to-end.

---

## 2026-06-30 — Wake-mute-during-call: why the toggle "does nothing" (branch `discord-integration`)

**Symptom.** Toggling **"Mute local-mic wake word while the Discord bot is in a
call"** had no observable effect — the local mic still fired the wake word even
with the bot in a voice call.

**Investigation — all four links of the chain traced.**
1. **UI → preference** (OK). `renderer.js` reads/writes the `wakeMuteDuringCall`
   pref against `#wake-mute-during-call`; `PreferenceManager.updatePreference`
   emits `preference:changed`.
2. **Preference → app gate** (OK). `WakeWordManager._applyConfig` maps the pref
   to `muteWhileBotActive` and calls `_syncBotPoll()`; the only wake trigger
   (`_matchPhrase` → `_onWakeDetected`, line 454) is gated by
   `_isWakeMuted() = muteWhileBotActive && _botInCall`; `_pollBotStatus` polls
   `GET /api/voice/bridge-status/` every 3 s and fails safe to *not muted*.
   App unit suite passes 8/8.
3. **Bridge → backend reporting** (THE break — code-completeness). The app only
   learns the bot is in a call if the bridge POSTs that state to the backend.
   That reporter (`discord-bridge/src/bridgeStatus.js` `startBridgeStatusReporter`,
   `active = isLinked() && session.isActive()`, heartbeat every 2.5 s) was
   **never invoked from the committed `discord-bridge/src/index.js`** — 945126b
   deliberately deferred the "2-line index.js wiring" to the discord-bridge
   refactor. That refactor (working tree) now wires it: `index.js:30` requires it
   and `index.js:53/84` calls `startBridgeStatusReporter({ linkManager, session })`
   with the **same** `linkManager`/`session` instances the slash commands mutate
   (`commands.handle(interaction, { linkManager, session })`), so `/link`/`/join`
   set `session.connection` (→ `isActive()` true) and `/stop`/`/leave` null it
   (`session.js:309`, → un-mute). The handoff is complete in the working tree.
4. **Backend endpoint** (not deployed — live 404). The committed
   `bridge_status` view/route (single daphne process, 8 s monotonic TTL fail-safe)
   is correct, but the **running backend container is a stale build**:
   `GET http://localhost:8123/api/voice/bridge-status/` returns **404**. The
   endpoint only goes live on the next backend rebuild.

**Root cause.** Two deploy-pending gaps, no defect in the branch code: (a) the
bridge's status reporter was wired only in the (uncommitted) discord-bridge
refactor, so any bridge started before it never reported; (b) the running backend
predates the `bridge-status` endpoint and 404s it. With both undeployed,
`_botInCall` can never become true, so `_isWakeMuted()` is always false and the
toggle has no effect.

**Resolution (no code change required on the branch — already correct).** The
feature works once the stack is redeployed on the user's next deliberate restart:
rebuild the backend so the endpoint exists, and restart the bridge so it runs the
wired `index.js`. Bot joins → local wake word mutes within ≤5.5 s; bot leaves (or
crashes) → it returns within ≤5.5 s (≤8 s TTL on crash). Fails safe (mic keeps
working) whenever the backend is unreachable.

**Verified offline (no Electron/backend/bridge restart).** App unit suite 8/8;
`node --check` clean on `bridgeStatus.js`, `index.js`, `session.js`,
`linkManager.js`, `WakeWordManager.js`; live `GET` confirms the 404; URL prefix
`/api/voice/bridge-status/` confirmed; `session.isActive()`/`leave()` connection
lifecycle confirmed.

**Optional hardening (not done — would touch the T3 discord-bridge refactor).**
Capture the reporter handle and call its `report()` right after join/leave so the
mute reacts in ≤3 s (one app-poll) instead of ≤5.5 s, tightening the brief
double-trigger window at the moment the bot joins.

---

## 2026-06-30 — Discord link key: no more time-based expiry (branch `discord-integration`)

**Problem.** The link/sync key time-expired on a **1-hour TTL** — annoying churn.

**What the TTL was.** `linkVault.writeVault` stamped `expiresAt = now + ttlSec*1000`
(default **3600s**), `resolveKey` rejected once `Date.now() > expiresAt`, and both
callers passed `ttlSec: 3600` (`tools/make-link-key.js --ttl` default, and the
frontend `main.js` `discord:get-link-key` handler).

**Change.** A minted key now has **no time limit** — `expiresAt: null`. It stays
valid until one of the two events that already invalidate it independently of time:
(1) the app/bridge **restarts** (control port rotates → old key's port/linkToken no
longer match the vault), or (2) the user **Regenerates** (new linkToken overwrites
the vault). Specifically:
- `linkVault.writeVault`: `expiresAt = Number(ttlSec) > 0 ? now + ttlSec*1000 : null`
  (default null). `resolveKey`: only enforces expiry `if (record.expiresAt && …)` —
  null is skipped. Legacy keys that carry a real past `expiresAt` are still
  honored (backward compatible).
- `make-link-key.js` default `--ttl` 0 (opt-in TTL preserved); prints "valid until
  the app/bridge restarts or you regenerate (no time limit)".
- Frontend `main.js` handler: `ttlSec = 0`; the reuse/"valid" check treats null
  `expiresAt` as valid so it won't re-mint/churn. Widget + `/status` reworded to
  "valid until restart or Regenerate" when there's no expiry.

**Preserved.** Deaf-recovery, /stop, image-send, text-mirror, /link, /resume — all
untouched (only the expiry semantics changed).

**Verified (bridge-only restart; no Electron/backend).** `node --check` clean
(bridge + main.js + widget). No-expiry suite — **9/9**: default mint has null
expiry and resolves; a year-old null-expiry key still resolves; **restart**
(port/linkToken change) still invalidates; **regenerate** (new linkToken) still
invalidates; legacy past-expiry key still rejected; frontend valid-check reuses on
null expiry (no churn) and re-mints on port change. Live: restarted the bridge,
minted a key → "no time limit", vault `expiresAt = null`, `resolveKey` accepts it.
A key now persists for the whole life of the running bridge.

---

## 2026-06-30 — Discord bridge: image sending (manager → Discord) (branch `discord-integration`)

**Feature.** The bot can now post IMAGE attachments (e.g. a screenshot) into the
text-mirror channel, triggered by the manager.

**Mechanism (reuses the existing local manager↔bridge channel).** The bridge and
manager already share a local runtime dir for linking (`vault.json` under
`$XDG_RUNTIME_DIR/ccbot-bridge/`). Image sending reuses that exact channel — no
backend change, no new network port — so it deploys by restarting only the bridge.
The manager drops a tiny JSON descriptor `{ image, caption }` into
`…/ccbot-bridge/outbox/`; the bridge watches it (`src/imageOutbox.js`, polls 1s) and
posts the image via `textMirror.postImage()`. (The "natural" path — an image field
on the TTS notification the bridge already polls — would need a backend schema
change + backend restart, which is out of scope here; the file-drop is the same
spirit, fully bridge-local and testable now.)

**How to trigger** (manager runs, on the same machine):
```
cd /media/ethan/smalls/claude-autorunner/discord-bridge
node tools/post-image.js /abs/path/to/screenshot.png "optional caption"
# or:  npm run post-image -- /abs/path/to/screenshot.png "caption"
# raw: write {"image":"/abs/path.png","caption":"..."} to $XDG_RUNTIME_DIR/ccbot-bridge/outbox/<name>.json
```
The descriptor is written atomically (tmp+rename) so the bridge never reads a
half-written file. It posts within ~1s once the bot is in a voice channel; if it
isn't yet, the descriptor stays queued (and stale ones are swept after 5 min).

**Size limit (criterion 3).** Oversized images (> `IMAGE_MAX_BYTES`, default 8MB —
Discord free-tier safe) are downscaled via ffmpeg (scale to `IMAGE_MAX_WIDTH`=1920
+ JPEG); if still too big, it logs and skips gracefully rather than erroring the
send.

**Inbound (criterion 5) — deferred.** Forwarding user-posted images to the manager
needs the privileged **Message Content** gateway intent (attachments aren't
delivered without it) + a `messageCreate` handler; skipped to keep the main feature
clean and avoid changing the bot's intents. Can add if that intent is enabled in
the Discord developer portal.

**Preserved.** Voice, text mirror (Heard/Replied), all commands — untouched
(`postImage` is additive; `_post`/`postHeard`/`postReplied` unchanged).

**Verified (no Electron/backend restart; bridge-only).** `node --check` +
require-smoke clean. Image suite — **11/11**: posts an attachment with caption;
graceful skip on no-channel / missing-file / oversized-beyond-downscale; outbox
consumes a descriptor (calls postImage, deletes it), leaves it queued when not in a
channel, sweeps stale (TTL); the CLI writes a correct descriptor. Downscale recipe
validated on a real 4000px image. New config: `CCBOT_IMAGE_OUTBOX`,
`IMAGE_POLL_INTERVAL_MS`, `IMAGE_DESCRIPTOR_TTL_MS`, `IMAGE_MAX_BYTES`,
`IMAGE_MAX_WIDTH`. **Needs a live call** to confirm an image actually appears in
the channel end-to-end.

---

## 2026-06-29 — Frontend: link-key widget shows the BARE key (branch `discord-integration`)

**Tweak.** The Settings → Discord Voice Bridge widget now shows and copies just the
RAW key string, not the `/link <key>` form. `DiscordLinkKeyManager` fills the field
from `res.key` (was `res.command`), so Copy puts the bare key on the clipboard.
Label changed to "Discord link key" with a static hint: "In Discord, paste this
after **/link** — or just type **/resume** to rejoin without it." (`index.html`,
`src/features/DiscordLinkKeyManager.js`.) `node --check` clean. Frontend-only;
takes effect on the next deliberate Electron restart.

---

## 2026-06-29 — Discord bridge: kill the TTS dead zone, allow barge-in (branch `discord-integration`)

**Problem.** After the stuck-gate fix, a DEAD ZONE remained: the user's speech was
not captured (a) DURING the bot's TTS playback and (b) for a few seconds after.
The echo gate paused ALL user capture while the bot spoke (+ a tail), so the user
couldn't talk over the bot or immediately after.

**Insight.** Discord voice receive is PER-USER. The bot's TTS is OUTPUT (the
`AUDIO_SOURCE=system` machine-loopback streamed into the channel) — it is NEVER
part of a user's receive stream. So the bot can safely capture the user's own
per-user stream while playing its TTS; the only "self-audio" to exclude is the
bot's OWN stream, which it never receives anyway. The blanket time-gate was an
over-correction.

**Fix** (`src/voiceReceive.js`, `src/index.js`, `config.js`, `src/session.js`).
- **No more capture pause by default.** The time-based capture gate is now opt-in
  (`PAUSE_CAPTURE_DURING_TTS`, default OFF). By default user capture stays fully
  ACTIVE during and after TTS — no dead zone, full barge-in.
- **Exclude only the bot's own stream.** The receiver now drops `speaking` events
  for its own `botUserId` (wired from `client.user.id`), so self-audio is excluded
  structurally rather than by pausing everyone.
- **Bot-speaking window kept ONLY for deaf-recovery suppression** (not capture):
  it still prevents a long reply with a silent user from being mistaken for a deaf
  receiver, but no longer gates the mic. Logs reworded accordingly
  (`🔊 bot speaking ~Ns … user capture stays ACTIVE (barge-in)`).

**Net:** the user can talk over the bot AND immediately after, captured every
time, no dead zone — while the bot still never transcribes its own voice. Users on
open speakers who hit acoustic echo can set `PAUSE_CAPTURE_DURING_TTS=1`.

**Verified (no Electron relaunch; bridge-only restart).** `node --check` +
require-smoke clean. echo/barge-in suite — **18/18**: barge-in default (user
forwarded while bot speaks), opt-in pause drops, **bot's own stream never
subscribed**, real user subscribed, plus the existing barge-in hold/cap. Full
regression: gateFix 11, health 11, stopLeave 10, alwaysListen 10, wake 28, resume
13, textMirror 9 — all green. New config: `PAUSE_CAPTURE_DURING_TTS` (default off);
`ECHO_GUARD_TAIL_MS` now only affects recovery suppression. **Needs a live call**
to confirm no dead zone during/after playback.

---

## 2026-06-29 — Discord bridge: FIX echo gate stuck closed (regression) (branch `discord-integration`)

**Regression.** The self-voice echo gate shipped earlier got STUCK CLOSED: after
the bot read a TTS notification, capture stayed paused and never recovered.

**Root cause (measured).** `markBotSpeaking(row.duration_ms)` set `botSpeakingUntil`
to `now + duration_ms + tail` with NO upper bound — and real manager TTS replies
are LONG (live data: `duration_ms` of 43525, **60200**, 27775ms; the manager reads
its whole response aloud). So one long reply gated capture ~60s, and back-to-back
replies kept extending the window, parking it minutes into the future. Worse,
`_receiverState()` forced `audioAgeMs = 0` for the entire window, so the
deaf-receiver monitor saw "fresh" and never recovered — capture looked permanently
dead.

**Fix.**
- **Hard failsafe ceiling** (`config.botSpeakingMaxMs`, default 90s): the gate
  window is `min(duration_ms + tail, ceiling)`, so a long/garbled/missing duration
  can NEVER latch capture off. 90s comfortably covers real replies (~60s) so normal
  replies still gate for their true length (no echo) and reopen right after.
- **Guaranteed reopen + logged transitions** (`src/session.js`). A failsafe timer
  fires after the window and reopens the gate (re-arming if the window was
  extended), independent of any "playback finished" event — which `AUDIO_SOURCE=
  system` doesn't provide. Every transition logs with a reason:
  `🔇 capture gate CLOSED for ~Ns — bot speaking (manager reply)` /
  `🎙️ capture gate OPEN — capture resumed (…)`. `/stop` + leave force-open the gate.
- **Recovery no longer suppressed by the gate.** The `audioAge=0` discount is now
  bounded by the capped window; after the gate reopens, the real stall age grows
  again, so a genuinely deaf receiver is recovered regardless of gate history.
- **No long-speech cutoff.** `maxUtteranceMs` raised 30s → 180s so a long monologue
  isn't truncated (the AfterSilence VAD already segments normal speech at pauses).

**Net:** after the bot finishes a reply, capture reopens within ~1s (≤ the 90s
failsafe even for a bogus duration); the user can talk after every reply,
indefinitely.

**Verified (no Electron relaunch; bridge-only restart).** `node --check` +
require-smoke clean. New gate-fix suite — **11/11**: huge duration capped to the
ceiling; normal reply gates ~its duration; TTS start→end reopens; **end-event-never-
fires → failsafe still reopens**; recovery discounted during the gate but un-
suppressed after; forced-open on leave; long-utterance backstop ≥120s. Full
regression: echoBarge 16, health 11, stopLeave 10, alwaysListen 10, wake 28, resume
13, textMirror 9 — all green. New config: `BOT_SPEAKING_MAX_MS` (90000). **Needs a
live call** to confirm the stuck-gate symptom is gone end-to-end.

---

## 2026-06-29 — Discord bridge: self-voice echo gate + TTS barge-in (branch `discord-integration`)

**Problem.** Listening broke every time the bot read a notification aloud. With
`AUDIO_SOURCE=system` the whole machine output (TTS + SFX) is streamed INTO the
channel; the bot's own voice (and its acoustic echo through the user's room) was
being captured + transcribed + forwarded as if it were the user — looping and
wedging the receiver — and TTS also talked over the user.

**Self-voice / echo gate** (`src/session.js`, `src/voiceReceive.js`, `src/index.js`).
The session now tracks a `botSpeakingUntil` window, set whenever the bot plays
audio: on each manager-TTS notification (`row.duration_ms` + an 800ms echo tail,
fires in both audio modes) and on every SFX/ack (`playSound`). The receiver asks
`session.isBotSpeaking()` and, while true, refuses to capture/transcribe/forward:
gated at the `speaking:start` handler, again at capture-end (a clip that
overlapped playback), and a backstop in `_processAlwaysOn` (a clip that waited on
the serialization queue). So the bot's own audio can never be mistaken for a
command. Composes with the deaf-receiver monitor: `_receiverState()` discounts
bot-speaking time from the stall age (audioAge=0 while speaking; capped to
time-since-it-ended after), so reading a long TTS is never mistaken for a deaf
receiver and never triggers a false recovery.

**Barge-in** (`src/audioPlayer.js`, `src/session.js`). A lightweight
voice-activity signal — `receiver.isUserSpeaking()` (a capture in progress, or
audio within `userSpeakingGraceMs`) — gates the START of a queued TTS clip in
tts mode: the player holds the clip while the user is talking and plays it after
a silence gap, with an 8s max-hold so a reply is never starved. It only delays
*starting* the next clip (never restarts a playing one), so it can't loop —
reusing the autorunner barge-in lesson. NOTE: in `AUDIO_SOURCE=system` the
manager's TTS is played by the OS (the bridge doesn't own that playback), so true
barge-in there needs upstream coordination; the echo gate (the actual fix for the
breakage) works in both modes.

**Preserved.** Always-listen, mute=off, wake word, text mirror, /resume, /link,
/stop, deaf-receiver recovery — all intact.

**Verified (no Electron relaunch; bridge-only restart).** `node --check` +
require-smoke clean. New echo/barge-in suite — **16/16**: bot-speaking window math
+ tail; `_receiverState` discounts bot-speech (age 0 during, capped after);
`isUserSpeaking` (active capture / grace); echo gate drops an utterance while the
bot speaks and forwards normally otherwise; barge-in holds a clip while the user
talks, plays on silence, and plays anyway past the max-hold cap. Regressions:
health 11, stopLeave 10, alwaysListen 10, wake 28, resume 13, textMirror 9 — all
green. New config: `ECHO_GATE_ENABLED`, `ECHO_GUARD_TAIL_MS`, `DEFAULT_TTS_MS`,
`SFX_GATE_MS`, `BARGE_IN_ENABLED`, `USER_SPEAKING_GRACE_MS`, `BARGE_IN_MAX_HOLD_MS`.
**Needs a live call to fully confirm** the "breaks every time it reads a message"
symptom is gone and that TTS-into-channel + user-capture no longer feed back.

---

## 2026-06-29 — Discord bridge: deaf-receiver auto-recovery + /stop escape hatch (branch `discord-integration`)

**Problem.** Two confirmed-live failures: (a) the voice RECEIVER silently goes
deaf — the VoiceConnection stays "Ready" but stops delivering audio (no speaking
events, no packets) after a mute/unmute or network blip; nothing errors so it
never self-recovers (observed ~7 min of zero audio while the user was unmuted and
talking). (b) The bot got STUCK in a call with no way out — `/resume` only
rejoins, and the wedged connection couldn't be killed from the user side, forcing
a full service restart.

**Auto-recovery** (`src/receiverHealth.js`, wired in `src/session.js`,
`src/voiceReceive.js`). The receiver now stamps `lastAudioAt` on every speaking
event AND every decoded audio chunk. A `ReceiverHealthMonitor` ticks every 10s
and recovers when the signal says deaf — **Ready + ≥1 non-bot, UNMUTED member
present + no audio for a while**. Everyone quiet/muted/absent is explicitly NOT a
fault. Confidence-tiered threshold: 45s once audio has flowed (we KNOW it can
hear), 120s if nothing's been heard yet (could be a quiet call). Recovery ladder,
lightest first, with a 15s cooldown and a hard cap of 3 rejoins before it gives
up (no thrash): **1.** re-subscribe (drop stale subscriptions); **2.** full
leave + rejoin of the same channel. Counters reset only when audio actually
returns, so the cap survives a rejoin. Logs `⚠️ receiver stalled Ns …`,
`⚠️ still deaf … rejoining (n/3)`, `✅ reception restored`.

**/stop escape hatch** (`src/commands.js`, `src/session.js`). New `/stop` cleanly
leaves the call and stops listening but stays LINKED (so `/resume` rejoins).
`session.leave()` is now robust: it FORCE-destroys the connection even when wedged
(destroys both our handle and any connection discord.js still tracks for the
guild) and sets `_intentionalLeave` so the Disconnected auto-recovery can't fight
the teardown. `/leave` still also unlinks (unchanged). Reply: "🛑 Left the call …
/resume to rejoin." `/stop` is the manual escape hatch; the monitor is the
automatic one — they share the same robust teardown.

**Empty-transcript diagnostics** (`src/voiceReceive.js`). On an empty transcript
we now log the clip's duration + peak/RMS dBFS and classify it: "SILENT capture
(deaf receiver / muted mic?)" vs "audio present (likely a Whisper miss)" —
distinguishing a deaf receiver from a Whisper miss. `RETAIN_EMPTY_WAV=1` keeps
that one clip on disk for inspection.

**Preserved.** Always-listen, mute=off, wake word, text mirror, /resume, /link —
all untouched (regression suites green).

**Verified (no Electron relaunch; bridge-only restart).** `node --check` +
require-smoke clean. Health-monitor decision ladder with a deterministic fake
clock — **11/11**: healthy→idle, everyone-muted→idle, not-Ready→idle, stall→light
then escalate after cooldown, backoff blocks double-acting, rejoin-restores→reset,
persistent-deaf caps at 3 then gives up, cold-start patience (50s no-op / 130s
acts). `/stop` + robust-leave + audioLevel — **10/10**: leave force-destroys a
wedged connection, stays linked, suppresses auto-recovery; `/stop` doesn't unlink;
`/leave` still unlinks; silence→-inf dBFS, loud→high RMS. Regressions: alwaysListen
10, wake 28, resume 13, textMirror 9 — all green. New config:
`RECEIVER_HEALTH_*`, `RECEIVER_STALL_MS`/`COLD_STALL_MS`, `RECEIVER_MAX_REJOINS`,
`RETAIN_EMPTY_WAV`. **Needs a live call to fully confirm** the real deaf-state
detection + that a leave+rejoin actually restores reception in the wild.

---

## 2026-06-29 — Frontend: copyable Discord link key in Settings (branch `discord-integration`)

**Feature.** The current Discord `/link` key is now visible and one-click
copyable in the app — the user grabs it from the UI instead of asking a model to
mint one.

- **Where:** Settings (gear icon) → new **"Discord Voice Bridge"** group, directly
  below "Wake Word". Shows a readonly, ready-to-paste **`/link <key>`** field with
  **Copy** + **Regenerate** buttons, a status line (control port + expiry), and a
  hint that `/resume` rejoins without a key. (`index.html`, styled with the
  existing `setting-group`/`setting-btn` classes; a `.setting-btn.copied`
  success-accent added to `style.css`.)
- **Never stale, never rejected** (`main.js` IPC `discord:get-link-key`). The main
  process builds the key from the LIVE `hookServer.port` + `hookServer.token`
  using the bridge's own `discord-bridge/src/linkVault`. It reuses the current
  vault token when it's still valid for THIS port (stable display, no churn);
  if the port rotated, the token expired, or the user clicked Regenerate, it
  `writeVault`s a fresh token — exactly like `make-link-key`. So the displayed
  key is always one the bridge's `resolveKey` accepts. Settings re-fetches on
  every open.
- **Renderer widget** (`src/features/DiscordLinkKeyManager.js`, wired in
  `renderer.js setupSecondaryUI`): fetches via IPC, renders, Copy →
  `navigator.clipboard` with a "✓ Copied!" flash, Regenerate mints fresh.
  Degrades gracefully ("control API not running yet — reopen Settings") if the
  hook server isn't up.

**Safety.** Only the link key (port + revocable link-token) is ever surfaced —
never the control token (it stays in the main process / vault). No backend or
Electron relaunch performed; this is code-only and takes effect on the user's
next deliberate app restart.

**Verified (no relaunch).** `node --check` clean on `main.js`, `renderer.js`, the
new manager. A contract test against the REAL `linkVault` (temp vault, live link
untouched) — **12/12**: fresh-mint key accepted by `resolveKey`; "current" key is
stable across opens; port-rotation mints a fresh accepted key; Regenerate rotates
(old key rejected, new accepted); expired vault re-mints. Full-app UI verified on
the user's next restart (can't relaunch mid-session).

---

## 2026-06-29 — Discord bridge: always-listening in-call + text mirror (branch `discord-integration`)

**Feature.** While the bot is in a Discord voice call it now ALWAYS listens (no
wake word — muting your mic is the off switch), transcribes one utterance at a
time on the silence boundary, forwards to the manager, and mirrors everything
into a Discord text channel. Built on the `discord-integration` branch (off dev);
the `/resume` + wake-word work is preserved intact.

- **Always-on in-call, mute = off** (`src/voiceReceive.js`, `src/index.js`).
  When `alwaysListenInCall` is on (default), the wake-word gate is bypassed
  in-call: every utterance is captured and forwarded. The bot tracks each
  speaker's mute via `voiceStateUpdate` (selfMute/serverMute) and treats MUTE as
  the sole "stop" — a muted speaker is skipped and any in-flight capture dropped
  (muting also stops audio anyway; this adds explicit gating + logging). The
  wake-word code path is untouched and still used when `ALWAYS_LISTEN_IN_CALL=0`.
- **Deferred per-utterance Whisper** (`src/voiceReceive.js`). End-of-speech is
  Discord's `AfterSilence` VAD (`inCallSilenceMs`, default 1500). On that
  boundary the buffered utterance is written to a per-utterance temp WAV file and
  submitted to Whisper exactly ONCE — never streaming/continuous — then cleaned
  up (falls back to the in-memory buffer if disk I/O fails).
- **Text mirror** (`src/textMirror.js`, `src/session.js`). A dedicated channel
  gets "🎙️ **Heard:**" (your transcript, on forward) and "💬 **Replied:**" (the
  manager's reply, from `TtsPoller.onNotification` `row.text`). Channel resolves:
  `DISCORD_TEXT_CHANNEL_ID` → existing `#claude-voice` → create it (needs the bot
  to have Manage Channels). If none works it disables itself with a clear log and
  voice keeps running. All posts are fire-and-forget.
- **Status** (`src/commands.js`). `/status` shows the listening mode + text
  channel.

**Invariants preserved.** Local-mic wake word + the bridge-status
mute-while-in-call heartbeat (no double-trigger) are untouched; only the link key
(port + revocable link-token) ever crosses Discord — the mirror posts only your
own transcript and the manager's reply text, never creds. No new privileged
intents (message-send needs none; `voiceStateUpdate` uses the existing
GuildVoiceStates intent). Channel auto-create needs the bot to hold Manage
Channels, else set `DISCORD_TEXT_CHANNEL_ID`.

**Verified (automated).** `node --check` clean across the bridge; module
require-smoke clean. Live-backend + mock harnesses: always-listen path forwards a
non-wake utterance + mirrors "Heard:" + acks; **mute drops capture** and unmute
resumes; the per-utterance file is written, transcribed, and cleaned up; silence
forwards nothing (**10/10**). Text mirror: resolve order (id → existing → create
→ graceful null), label/whitespace/truncation formatting, blank skipped
(**9/9**). New config: `ALWAYS_LISTEN_IN_CALL` (default on), `IN_CALL_SILENCE_MS`
(1500), `TEXT_MIRROR_ENABLED`, `DISCORD_TEXT_CHANNEL_ID`, `DISCORD_TEXT_CHANNEL_NAME`.
**Pending live in-call E2E (criterion 6)** before commit.

---

## 2026-06-28 — Mute local-mic wake word while the Discord bot is in a call

**Goal.** Stop the wake word DOUBLE-triggering when the user is in the same room
as the host mic AND the Discord bot is in the call: saying the phrase should fire
once (via the bot), not also via the local mic. New opt-in setting in the
wake-word settings panel: "Mute local-mic wake word while Discord bot is in a
call". When ON and the bot is active (linked + in a voice channel), the local
wake word is suppressed; when the bot isn't in a call, local wake word works
normally.

**How the app learns the bot is active (3 components).**
1. **Bridge → backend (`discord-bridge/src/bridgeStatus.js`, new).** A
   fire-and-forget heartbeat (mirroring `log.js`) POSTs `active =
   linkManager.isLinked() && session.isActive()` to the backend every ~2.5s.
   `session.isActive()` (`!!this.connection`) is the authoritative in-voice
   signal. Wired in `src/index.js` (`startBridgeStatusReporter`).
2. **Backend (`voice_transcription/views.py` + `urls.py`).** New
   `GET|POST /api/voice/bridge-status/` backed by an in-memory singleton with a
   monotonic timestamp + 8s TTL (mirrors `wake_service`, no DB/migration). POST
   records `{active, last_seen}`; GET returns active **only** if reported within
   the TTL — so if the bridge crashes/quits the flag goes stale and the app
   un-mutes itself (fail-safe).
3. **Renderer (`src/features/WakeWordManager.js`).** New preference
   `wakeMuteDuringCall` (default off). While the spotter is enabled AND the pref
   is on, it polls `/api/voice/bridge-status/` every 3s (mirrors
   NotificationManager's poll) into `_botInCall`; an unreachable backend fails
   safe to "not in call". Suppression is at the single `_onWakeDetected()`
   chokepoint via `_isWakeMuted() = muteWhileBotActive && _botInCall` — the
   always-on RMS speech gate (`_updateSpeechSignal` / `speech:active`) and the
   post-notification reply window are deliberately left untouched.

**UI.** Toggle added to the Wake Word settings group (`index.html`
`#wake-mute-during-call`), wired through `PreferenceManager` (default
`wakeMuteDuringCall: false`) and `renderer.js` `setupSettings` (sync + change),
following the existing `wake-word-enabled` pattern.

**Verified (no deploy — Electron NOT restarted, manager 999 left alive).**
- Renderer: `src/features/wake-mute-during-call.test.js` — 8 tests: pref ON + bot
  in call → suppressed; bot not in call → fires; pref OFF → fires; pref mapping
  (bulk + live); `_applyBotStatus`; the poll drives suppression end-to-end
  (active→suppressed, inactive→fires); poll failure fails safe; the TTS speech
  gate still fires while muted. Full feature suite green; `node --check` clean.
- Backend: exercised the real Django URL+view+TTL in a throwaway container
  (host code overlaid, live server untouched): initial inactive → active POST →
  active → stale-by-TTL → inactive → inactive POST → inactive. ✅
- Bridge: `computeActive` truth table + the reporter POSTs `{"active":true}` to
  `…/api/voice/bridge-status/` (stubbed fetch). ✅

**Deploy / coordination notes.** Electron picks this up on the next deliberate
restart. The backend image is baked (not bind-mounted), so the endpoint needs a
backend rebuild (`docker compose up -d --build backend`); it ships alongside the
already-staged `wake_check` backend work. The bridge wiring in
`discord-bridge/src/index.js` (2 lines: require + `startBridgeStatusReporter`)
was left in the working tree (NOT committed) to avoid bundling T3's large
in-progress `index.js` refactor — coordinate with the discord-bridge terminal to
fold it in; it deploys on the next bridge restart regardless.

---

## 2026-06-28 — Discord bridge: `/resume` — reconnect without re-pasting the key

**Problem.** Re-linking the bot meant pasting the long base64 link key every time
— painful on mobile, where the user lives.

**Feature.** A new `/resume` slash command re-links and rejoins the user's current
voice channel using the LAST key they successfully `/link`'d with — no paste.

- **Per-user memory** (`src/resumeStore.js`). On every successful `/link`, the
  bot records `discordUserId -> { key, tag, port, managerId, linkedAt }` in a
  small 0600 JSON store at `$XDG_RUNTIME_DIR/ccbot-bridge/resume.json`. The stored
  `key` is the same paste-able link key (port + revocable link-token, **no**
  control token — see `linkVault.js`). It survives a **bot restart** (systemd
  --user restart doesn't clear `/run/user`); it's wiped on machine reboot, which
  is correct because the vault it points at is wiped then too.
- **`/resume` flow** (`src/commands.js`). Look up the caller's stored key →
  re-run `linkManager.link(storedKey)`, which re-resolves it against the live
  vault AND re-validates the control API. On success, rejoin the user's current
  voice channel (shared `joinCurrentChannel` helper, same as `/link`). Clear,
  actionable errors otherwise: **no saved session** ("run /link <key> once") and
  **stored key no longer valid** (rotated / expired / manager gone → "run /link
  <key> with a fresh key"). `/leave` intentionally keeps the saved mapping so a
  later `/resume` still works. `/status` now shows whether a resume is available.

**Why it's safe.** `/resume` re-uses the exact same vault + control-API validation
as `/link`, so it can never connect to a stale/rotated session — it either
reconnects to a genuinely-live session or fails with guidance. No new trust path.

**Verified.** 13/13 mock-driven tests on the real `commands.handle` + `resumeStore`:
`/resume` with no prior link errors cleanly (no link attempt, no join); `/link`
then leave→`/resume` reconnects using the stored key and rejoins; a now-invalid
stored key yields the clean "run /link" error with no rejoin; the store persists
across a simulated restart and is 0600. `npm run check` clean. Tunable:
`CCBOT_RESUME_STORE` (store path). Pending the user's live confirmation before
commit.

---

## 2026-06-27 — Audit fixes: two HIGH-severity autorunner bugs

From the all-projects bug-swarm audit; user approved fixing the **highs only**
(mediums/lows deferred).

**1. Device screenshots corrupted by UTF-8 decoding (`src/adb/adb-manager.js`).**
`executeCommand()` accumulated stdout with `output += data.toString()` — a lossy
UTF-8 decode of every chunk (invalid byte sequences collapse to U+FFFD). For text
commands that's fine, but `takeScreenshot()` then rebuilt the PNG via
`Buffer.from(result.output, 'binary')`, and the bytes were already destroyed, so
the screenshot was garbage. Fix: accumulate raw `Buffer` chunks
(`stdoutChunks.push(...)`) and `Buffer.concat` them; resolve with both a string
`output` (backward-compatible for text callers) and a raw `outputBuffer`.
`takeScreenshot` now uses `result.outputBuffer`. Added an injectable `this.spawn`
seam so the binary path is unit-testable.

**2. Fallback usage-limit detection was dead code
(`src/features/UsageLimitManager.js`).** `isDuplicateDetection(resetTime)` has a
side effect — it records the minute-precision reset-time key and returns false
only the first time. `detectUsageLimit()` (the raw `terminal:data` fallback)
called it at line 114 (recording the key), then called `onUsageLimitDetected()`,
which called `isDuplicateDetection()` *again* — now the key existed, so it
reported a duplicate and bailed before `beginWaiting()`. The fallback never once
engaged the gate. Fix: drop the redundant pre-check in `detectUsageLimit()` and
let `onUsageLimitDetected()` be the single dedup/cooldown authority (mirrors the
primary hook path). Genuine duplicates are still deduped (verified).

**Verified (no deploy — Electron NOT restarted, manager 999 left alive).** New
`src/adb/adb-manager.test.js` (fake spawn streaming non-UTF-8 PNG bytes: raw
bytes survive intact; the old string path is shown lossy) and
`src/features/usage-limit-fallback.test.js` (fallback now fires; repeats still
de-dupe). Both confirmed RED with the fixes stashed, GREEN with them applied;
full feature + adb suites green; `node --check` clean. Deploys on the next
deliberate Electron restart. Mediums/lows from the audit left for later.

---

## 2026-06-27 — Spoken notifications: echo gate + guaranteed completion

**Follow-up to the talk-over fix below.** Two remaining gaps: (1) the spoken
notification's own audio, picked up by the mic, tripped the always-on RMS VAD
(`WakeWordManager._updateSpeechSignal`) and paused the readout — self-inflicted
interruptions; (2) under *truly continuous* talking a held clip never received a
`speech:idle`, so it could stall indefinitely, and the old loop-guard *dropped*
the message at the cap rather than finishing it. The user's priority: a
notification must **always complete** and **never loop or stall**, whether the
trigger is the user talking or echo — lean toward letting it play through.

**Echo gate (`WakeWordManager.js`).** While a notification is actually playing
(plus a short `TTS_ECHO_TAIL_MS = 400` tail), the VAD raises its gate from the
sensitive floor (`RMS_VOICE_THRESHOLD = 0.010`) to `RMS_BARGE_IN_THRESHOLD =
0.030`, so only sound clearly louder than the speaker echo — a real, close-mic
barge-in — counts as "user speaking". `NotificationManager` now emits
`tts:playback {active}` on every start/resume/pause/end; WakeWordManager tracks
it (`_setTtsPlayback` / `_inTtsEchoWindow`). Outside playback the floor is
unchanged, so normal speech sensitivity and wake-word capture are untouched.
`RMS_BARGE_IN_THRESHOLD` is the tunable knob (lower = easier to interrupt the
TTS and more echo false-positives; higher = harder to barge in).

**Guaranteed completion (`NotificationManager.js`).** A barge-in still gets a
brief resume-in-place hold, but completion is now bounded two ways and the
backstop **plays through** instead of dropping: (a) a held clip that the user
never lets clear is force-resumed by a `MAX_HELD_MS = 4000` watchdog and flagged
play-through; (b) a clip interrupted `MAX_HOLDS_PER_MESSAGE = 3` times is flagged
play-through immediately. A play-through clip is resumed in place and **never
paused again** (`_playThrough` set), so continuous talking can neither loop nor
stall it — it finishes. The cap path no longer marks-played-and-drops.

**Real barge-in preserved.** A genuinely loud interruption above the gate still
pauses and resumes-in-place; only echo (and very soft over-talking) is ignored.

**Verified (no deploy — Electron NOT restarted, manager 999 left alive).** New
`src/features/tts-echo-gate.test.js` wires both managers on one bus: TTS echo
during playback does NOT hold; a loud barge-in still holds then resumes in place;
non-TTS sensitivity is unchanged; the gate persists for the tail. Updated
`NotificationManager.test.js`: repeated interruptions play through to completion
(not dropped, not looped, resumed in place), and a watchdog force-resumes a clip
the user keeps talking over. All feature suites green (NotificationManager 4,
tts-echo-gate 4, PromptWatchManager 11, others); `node --check` clean on both
modules and `renderer.js`. Deploys on the next deliberate Electron restart;
`RMS_BARGE_IN_THRESHOLD` can be tuned then if echo is louder/quieter in practice.

---

## 2026-06-27 — Spoken notifications: stop the talk-over replay loop

**Problem (live user report).** Talking — or background noise — while a TTS
notification was being read aloud interrupted it, went silent, and **reset the
message back to the start**. With continuous talking/noise it looped the *same*
message forever and never finished.

**Root cause (renderer, `src/features/NotificationManager.js`).** The "hold while
talking" feature handled a mid-readout interruption by pausing the clip and
`playQueue.unshift(n)`-ing it back to the front, then — on the trailing-silence
release — restarting it via `_startAudio`, which reassigns `audio.src` and so
**plays from position 0**. There was no resume offset and no cap on restarts, so
each `speech:active`/`speech:idle` cycle replayed the whole clip (chime included)
from the top. The continuous-noise driver is acoustic feedback: the spoken
notification itself is picked up by the mic, trips the always-on RMS VAD
(`WakeWordManager._updateSpeechSignal`), and re-fires the hold — an endless
restart-from-0 loop. The Django backend and the Discord bridge were ruled out:
the backend serves each row once (client advances a monotonic `lastSeenId`
cursor), and the bridge in its default system-audio mode just relays the
desktop's own playback verbatim — so the loop was entirely the renderer's.

**Fix.** An interrupted clip now **resumes from where it paused instead of
restarting**: on hold we only `pause()` (the audio element keeps its `src` and
`currentTime`) and track it in a separate `_held` slot — never re-queued — so
`_drainQueue` resumes it with a bare `audio.play()` (no chime, no `src` reload,
no rewind). A loop guard (`MAX_HOLDS_PER_MESSAGE = 3`) caps interruptions per
clip; past the cap we stop deferring, mark it played server-side, and move on —
so noise/echo can never restart-and-replay forever. `_enqueuePlay` now de-dupes
against the playing/held/queued ids so the same notification can't be queued
twice. Explicit user replays abandon any held clip (shared audio element).

**Verified (no deploy — Electron NOT restarted, manager 999 left alive).** New
unit tests `src/features/NotificationManager.test.js` (fake `Audio`/`fetch`/DOM):
a mid-playback interruption resumes from the same position without reloading
`src`; five back-to-back interruptions do **not** loop — the clip is marked
played and dropped after the cap; duplicate enqueue is ignored. RED first
(3 fail on the old code), then GREEN (3/3 pass); `node --check` clean on the
module and `renderer.js`.

**Not changed (deliberate).** The Discord bridge's separate auto-reply→forward
content feedback loop (speech re-triggering *new* manager replies) is a distinct
issue, out of scope for this symptom. Residual follow-up: the always-on VAD has
no echo/output gating, so the TTS output can still trip a hold or two before a
clip completes — an acoustic-echo-cancellation / "ignore mic while TTS plays"
pass would smooth that, but the loop guard already bounds it.

---

## 2026-06-27 — Discord bridge: reliable wake→command pickup + wake sound on detection

**Problems (live user testing).** Two failures in the Discord voice bridge
(`discord-bridge/src/voiceReceive.js`):

1. **Speech after the wake word often didn't come through.** Commands the user
   spoke after saying "sean" frequently never reached the manager.
2. **The wake/"blade" sound didn't fire when the user went silent after the wake
   word** — it appeared gated on actually capturing a command.

**Root cause (measured, not guessed).** The bridge gates every utterance through
the cheap CPU **Vosk** endpoint (`/api/voice/wake-check/`) to avoid running GPU
Whisper on idle chatter, and only matches the wake word against that transcript.
Synthesizing test speech and POSTing the exact 48 kHz-stereo WAV the bridge
produces to both endpoints showed Vosk **mishears the short wake name**:

| spoken | Vosk (gate) | Whisper |
|--------|-------------|---------|
| "sean" | `sean` ✓ (fragile on mic) | `Sean` ✓ |
| "sean what is the status" | **`sure what is the status`** ✗ | `Sean, what is the status?` ✓ |

`soundex("sure")=S600 ≠ soundex("sean")=S500` and `lev=2 > 1`, so the wake
spotter **rejected the whole "sean <command>" utterance** ("no wake word —
ignoring"). Whisper heard it perfectly. Two consequences: the inline wake+command
in one breath was dropped (Bug 1), and because detection failed there was no
`onWakeAck` (Bug 2). A second, independent Bug-1 cause: the *armed follow-up*
path ran the command through Vosk first and `return`ed on empty/garbled Vosk
output — discarding a valid command **before Whisper ever saw it**.

**Fix.** Restructured `_processSerial` around "am I expecting a command?":

- **Expecting a command** (armed after a lone wake word, or inside the post-reply
  auto-reply window): the utterance *is* the command → transcribe **straight to
  Whisper** (Vosk fallback only if Whisper is empty). Never gate a command
  through Vosk. The arm/window is consumed only on a real forward; an empty
  transcript keeps listening instead of dropping it.
- **Detecting** (not expecting a command): cheap Vosk gate first (fast path,
  no GPU when it clearly contains the wake word); if it **doesn't** match,
  **escalate short utterances (≤ `wakeEscalateMaxMs`, default 12 s) to Whisper**
  to confirm the wake word before giving up — this recovers the
  Vosk-garbled "sean <command>". The wake-ack sound fires the **instant** the
  wake word is detected, before/independent of any follow-up command (silence
  after the wake word still chimes).
- Timing for breathing room: command end-of-speech silence 1.5 s → **2.0 s**,
  armed-follow-up window 8 s → **10 s**, plus a `maxUtteranceMs` (30 s) capture
  cap so a non-stop talker still gets transcribed.

New/changed config (`discord-bridge/config.js`): `wakeEscalateMaxMs` (default
12000; 0 = pure GPU-saving, no escalation), `maxUtteranceMs` (30000),
`commandSilenceMs` 1500→2000, `wakeFollowupMs` 8000→10000, `minUtteranceMs`
250→200.

**GPU note.** Escalation runs Whisper on short utterances the Vosk gate didn't
match — in a manager-control channel (mostly commands, Discord only fires capture
on real voice activity) this is a few extra short clips, the right trade for not
dropping commands. Set `WAKE_ESCALATE_MAX_MS=0` to revert to Vosk-only gating.

**Verified.** A harness drove the **real** `VoiceReceiver._processSerial` against
the **live backend** with synthesized WAVs (lone wake, inline wake+command,
two-step armed command, non-wake chatter): **14/14** assertions passed —
including the escalation log "wake word recovered by Whisper escalation (Vosk
missed it)" on the inline case, the chime firing on a lone wake with silence
after, and non-wake chatter still ignored (no false trigger). `npm run check`
clean. Pending live confirmation by the user before commit.

### Follow-up (same day) — reliable wake DETECTION + audible/logged wake sound

**Live retest.** The forwarding fix worked (command reached terminal 999, and
Whisper escalation recovered the wake word). But detection was still flaky: the
speech engines kept rendering a lone "sean" as near-homophones the matcher then
**rejected** — observed live: `don, john, jon, on, dawn, dawn stone, done, dumb`.
And the wake/"blade" sound never fired on silence-after-wake (because detection
failed, `onWakeAck` was never reached — and `playSound` logged nothing, so it was
invisible).

**Why soundex alone missed them.** "sean" is /ʃɔːn/. The mishearings keep the
-awn/-on rime but change the onset (SH→D/J/G…), and classic soundex keys off the
first letter, so it scatters them (`S500` vs `J500` vs `D500`) and the wake match
fails.

**Fix — a position-gated WEAK homophone layer (`src/wakeWord.js`).** Added a
curated set of common-word homophones for the wake name (`don/dawn/done/john/
jon/on/dumb/…`, the -awn/-on family). To avoid false triggers on normal speech,
a weak match counts **only** when it (1) **leads** the utterance, (2) is in a
**short** utterance (≤ `WAKE_WEAK_MAX_TOKENS`, default **2**), and (3) is
**Whisper-confirmed**. `WakeSpotter.check()` now returns `via: 'strong' | 'weak'`.

**Confidence policy (`src/voiceReceive.js _detectWake`).** Trust the cheap Vosk
gate only for a **strong** match; anything weaker (Vosk empty / wrong / a mere
homophone) escalates short utterances to Whisper and requires Whisper to land on
a wake variant. So a bare low-confidence Vosk guess never triggers — a weak
homophone is accepted only when Whisper independently agrees.

**Wake sound — now fires on detection AND is logged.** The ack fires the instant
the wake word matches, before/independent of any command (`🗡️ wake word
DETECTED … playing wake sound now`), and `session.playSound` now logs each play
(`🔊 wake-sound: played "<file>"`) and warns if it's skipped (no channel /
missing file). Resolved sound: `screenshot.wav` (present), `AUDIO_SOURCE=system`
→ paplay to the local sink, relayed into the channel.

**Verified.** `wakeWord` matcher unit tests **28/28** (every observed mishearing
detected; `turn it on` / `i am done with that` / `on the server` / unrelated
words rejected). A live-backend harness fed TTS of the actual mishearings through
the **real** `_processSerial`: `Done!`/`John`/`Dawn` → confirmed-via-Whisper →
wake sound fired → armed; `turn it on please` → ignored; inline + non-wake
regressions intact (**11/11**). `npm run check` clean. New tunables:
`WAKE_WEAK_MAX_TOKENS` (default 2). Pending the user's live re-test before commit.

---

## 2026-06-25 — Voice end-of-speech silence cutoff raised 3.0s → 5.0s

**Problem.** Dictating a voice memo from across the room, the user was cut off
mid-thought: the command capture finalizes and submits after a fixed window of
trailing silence, and the old window was too short for slower, more distant speech.

**Exact current value found.** The end-of-speech timeout is
`WakeWordManager.silenceMs` — the SOLE thing that ends a command capture once speech
has started (`_checkVad`: `if ((now - this._lastVoiceAt) > this.silenceMs) stop`).
Its value comes from the `wakeSilenceMs` preference, but that key was **not persisted**
in the user's store, so the live value was the code default of **3000 ms (3.0s)** (the
"~3.5s" estimate was slightly high). It is read **live per recording**, not cached at
startup.

**Change.** Raised the default to **5000 ms (5.0s)** at every default site so a fresh
install and the unset-preference fallback both use 5.0s:
- `src/features/WakeWordManager.js` — `this.silenceMs = 5000` (constructor default) and
  the `_applyConfig` fallback `Number(prefs.wakeSilenceMs) || 5000`.
- `src/features/PreferenceManager.js` — default `wakeSilenceMs: 5000`.
- `renderer.js` — the two `p.wakeSilenceMs || 3000` UI fallbacks → `|| 5000`.
- `index.html` — "Stop after silence" slider `value="5000"` and label `5.0s` (range
  unchanged at 2000–10000, so the user can still tune it).

**Why this is the right knob.** `silenceMs` is the only trailing-silence end-of-speech
stop (there is deliberately no max-duration cap — long continuous speech is never cut),
and it's re-read on every VAD poll, so the change applies the moment the in-memory value
updates. The separate `SPEECH_IDLE_MS` (notification-hold debounce) was left untouched.

**Live vs. pending.** The committed code changes do NOT alter the already-running
renderer's in-memory `this.silenceMs` (still 3000 until the renderer reloads), so the new
default is **pending the next deliberate app restart**. Because the value is read live and
applied via `preference:changed`, the user can also make it take effect **immediately with
zero process disruption** by dragging the Settings → "Stop after silence" slider to 5.0s
(emits `preference:changed` → `_applyConfig` sets `silenceMs` live, and persists it). No
restart was performed for this change to avoid dropping the manager session (terminal 999).

---

## 2026-06-25 — Spoken notifications wait until the user stops talking (full barge-in hold)

**Problem.** Spoken (TTS) notifications could read out over the user while they were
mid-sentence talking to the assistant. An earlier pass (2026-06-24, commit `119db8d`)
added a partial fix — the wake word firing halted the *in-flight* clip — but it (a)
only reacted to the wake word, not to the user actually speaking, (b) **dropped** the
halted clip and the whole backlog, and (c) did nothing to stop the *next* queued
notification from starting while the user was still talking. The follow-up ("don't
autoplay new notifications while the user is speaking") was explicitly deferred.

**What we built.**

1. **A real "is the user speaking right now" signal.** `WakeWordManager._onAudioFrame`
   already computes per-frame mic RMS, but only used it *inside* a wake-command capture.
   Added `_updateSpeechSignal(rms)` which runs in **every** mic state and emits
   edge-triggered `speech:active` / `speech:idle` EventBus events — same RMS threshold
   and sustained-run gate as the wake VAD (so room blips don't trip it). The falling
   edge is detected in the frame handler itself because the Web Audio ScriptProcessor
   keeps firing during silence. Trailing silence before `speech:idle`: `SPEECH_IDLE_MS`
   (600ms), long enough not to flap between words of a sentence. The signal is also
   force-released on mic teardown so a held notification never gets stuck.

2. **A playback gate in `NotificationManager`.** It now tracks why it believes the user
   is speaking in a `_speakingSources` set, fed by three inputs: the new
   `speech:active/idle` (continuous RMS), `wake:state` `capturing`/`transcribing` (an
   active voice-command window), and `voice:button-state` `recording`/`processing` (the
   manual push-to-talk button). While any source is active — or within a trailing
   release window — `_drainQueue()` **holds**: queued notifications stay in order and
   nothing plays.

3. **Resume after a short silence, in order, nothing dropped.** When the last speaking
   source clears, a `SPEAKING_RELEASE_MS` (700ms) timer starts; if the user speaks again
   it's cancelled. On fire, the queue drains oldest-first. Combined with the 600ms RMS
   trailing silence that's a **~1.3s total quiet window** before a deferred notification
   reads out — within the requested ~1–1.5s. If a notification is mid-readout when the
   user starts talking, `_holdCurrentPlayback()` pauses it and **re-queues it to the
   front** (replaced the old drop-the-backlog `stopCurrentPlayback`, now removed), so the
   interrupted readout replays once the user is silent instead of being lost.

**No regression when silent.** With no speech (and the manual button idle), no source is
ever added, `_isUserSpeaking()` stays false, and notifications autoplay promptly exactly
as before. If the wake word is disabled there's no mic graph and thus no `speech:*`
events, so the manual-recording source is the only gate — silent operation is unchanged.

**Files.** `src/features/WakeWordManager.js` (signal: `SPEECH_IDLE_MS`,
`_updateSpeechSignal`, teardown release), `src/features/NotificationManager.js` (gate:
`_setupSpeakingGate`, `_addSpeakingSource`/`_removeSpeakingSource`, `_isUserSpeaking`,
`_holdCurrentPlayback`, `_drainQueue` guard, `SPEAKING_RELEASE_MS`).

**How to verify (requires a restart — not performed automatically; see note).** Restart
the app, enable the wake word, and trigger a notification (or let the manager post one)
while talking: it should not play until ~1.3s after you stop. Live-probe without a
restart by emitting the signal on the running renderer:
`window.eventBus.emit('speech:active', {})` (queue holds) then
`window.eventBus.emit('speech:idle', {})` (drains ~700ms later).

---

## 2026-06-24 — Stop chime on the silent no-speech auto-close of a wake/auto-wake window

**Problem (UX gap from testing #41).** When the auto-wake listening window opens after
a notification and the user says NOTHING, it closes on the no-speech timeout — but
silently. There was no audible cue that capture had stopped, so the user couldn't tell
the mic was no longer listening.

**Root cause.** The "done listening" stop chime (`this.stopSound`, `hud4.wav`) was only
played in `_onCommandRecorded` (`WakeWordManager.js`), on the path where audio is kept
and transcribed. The no-speech timeout in `_checkVad` calls `_stopCommandCapture(true)`
(abort=true); that routes into `_onCommandRecorded`'s discard branch, which returns
**before** the chime line — so the silent auto-close played nothing.

**Fix.** Play `_playChime(this.stopSound)` in the no-speech-timeout branch of
`_checkVad`, immediately before the abort. Now every natural termination of the listen
window fires the same stop sound exactly once:

- Speech captured & transcribed → `_onCommandRecorded` (existing play).
- Closed on trailing silence after speech → same transcribe path (existing play).
- **No-speech timeout with nothing said → new play in `_checkVad` (the gap, now fixed).**

**No double-play, by inspection.** The two play sites are mutually exclusive: the
no-speech branch fires only when the user never started speaking and then aborts (whose
discard branch returns before the transcribe-path chime); the transcribe path fires only
on the non-abort stop. The deliberate `cancelCapture` (user taps the yellow mic) and
`disable()` paths are intentionally left silent — they're user/system-initiated, not the
silent auto-close this addresses.

**Restart needed?** Yes — `WakeWordManager` runs in the renderer and is wired at app
start; the new chime activates on the next Electron launch. The app was NOT restarted as
part of this change.

---

## 2026-06-24 — Auto-wake after a notification (reply without the wake word)

**Want.** Make notification → reply a natural conversational turn: when a notification
finishes reading aloud, automatically open the capture flow for a brief window so the
user can fire back a reply immediately, no wake word needed. Only on the FIRST read-out
(not replays), and it must not fight the existing wake-word → halt-notification behavior.

**How it works (EventBus, decoupled — two managers, no reach-in).**
- `NotificationManager._onPlaybackEnded()` (the TTS `'ended'` handler) now emits a new
  `notification:read-complete` event — but only when the finished clip was a **first
  read-out** (not a replay) AND **nothing else is queued** AND not muted. First-vs-replay
  is tracked with a `_currentIsReplay` flag: set false when a clip starts from the
  autoplay queue (`_drainQueue`), true in `replay()`. The "nothing else queued" snapshot
  is taken before draining, so in a backlog only the LAST notification opens the window.
- `WakeWordManager` subscribes to `notification:read-complete` and calls the new
  `startPostNotificationCapture()`, which runs the **same** capture flow as the wake word
  (refactored into a shared `_beginCapture()`), tagged `_captureSource =
  'post-notification'`. It is a no-op unless the spotter is enabled and idle-listening
  (`state === 'listening'`), so it never interrupts an in-flight capture and can't clash
  with the wake path.
- **Listen window** = the configured stop-after-silence (`wakeSilenceMs`): `_beginCapture`
  passes `noSpeechMs: this.silenceMs`, so if the user doesn't start replying within that
  window the capture closes quietly (the same VAD silence logic as wake otherwise).
- **Tagging (routed to the manager):** `_sendToManager` keeps the verbatim
  `🎙️ Voice memo from the user` marker (the manager's CLAUDE.md keys off it) but, for a
  post-notification capture, frames it as `🎙️ Voice memo from the user [auto-started
  reply, right after a notification was read out — no wake word; …]` so the manager knows
  it's an immediate reply, not a wake capture. `_captureSource` resets to `'wake'` in
  `_resumeListening()` (one-shot).

**No conflict with wake → halt (the prior feature).** Auto-wake only fires on a
notification's *natural* completion with an empty queue. If the user instead says the
wake word mid-playback, `stopCurrentPlayback()` **pauses** the audio — which does not fire
`'ended'` — so that interrupted notification never triggers auto-wake (no double-capture).
When auto-wake starts and emits `wake:state 'capturing'`, the halt listener's
`stopCurrentPlayback()` is a clean no-op (the notification already ended, queue empty).

**Requires next app restart** (renderer modules). Per the constraint, the live Electron
app was NOT restarted (that would kill the manager 999 + all terminals).

**How to test (after the next restart, with the wake word enabled).** (1) Trigger a
notification: `curl -s -X POST http://localhost:8123/api/tts/speak/ -H 'Content-Type:
application/json' -d '{"text":"Reply test: say something after this finishes."}'`.
(2) When it finishes reading out, the activation chime plays and the mic opens — speak a
reply with no wake word; it should transcribe and reach the manager framed as an
"auto-started reply". (3) Stay silent instead → it closes quietly after the configured
stop-after-silence. (4) Press replay on an already-played notification → it must NOT
re-open the window. (5) Say the wake word mid-readout → the notification halts and only
the normal wake capture runs (no second auto-capture).

**Verified.** `node --check` passes on both managers; event wiring
(`notification:read-complete` ↔ `startPostNotificationCapture`) and the
first-play/replay gating confirmed by inspection. Live mic behavior to be confirmed by
the user after restart.

---

## 2026-06-24 — Kokoro TTS device detection (CUDA > MPS > CPU)

**Want.** Kokoro TTS should run on the GPU on a CUDA box (this RTX 3090 machine) and
fall back to CPU on a Mac, instead of always CPU.

**Change (`backend/text_to_speech/tts_service.py`).** Added `_resolve_device()` —
probes torch once and returns `'cuda'` if `torch.cuda.is_available()`, else `'mps'` on
Apple Silicon (`torch.backends.mps.is_available()`, guarded for older torch), else
`'cpu'`; any probe failure degrades to CPU. `_get_pipeline()` now passes the resolved
value as `KPipeline(..., device=device)`. Confirmed the installed **kokoro 0.9.4**
`KPipeline.__init__` accepts `device: Optional[str]` (forwarded to `KModel(...).to(device)`).
Safe and portable: no behavior change on a CPU host, GPU/MPS where available.

**BLOCKER found — the container is CPU-only by design, so this resolves to CPU here.**
The host is GPU-ready (`docker info` shows `Default Runtime: nvidia`, toolkit installed,
RTX 3090 present), but the backend image **deliberately installs the CPU-only torch
wheel** (`backend/Dockerfile:22`, commented "roughly halving image size") — so inside
the container `torch` is `2.x+cpu` and `cuda.is_available()` is `False` regardless of the
GPU. The backend code is also **baked into the image** (no code volume mount), so a plain
`docker compose restart backend` picks up neither the GPU nor this edit.

**Resolution — user approved the rebuild; GPU now active.** Two infra changes shipped:
- `backend/Dockerfile`: torch now installs from the **default PyPI wheel (CUDA build)**
  instead of the CPU-only index (`pip install torch`). Image grew ~3.02GB → **6.33GB**.
- `docker-compose.yml`: added `NVIDIA_VISIBLE_DEVICES=all` +
  `NVIDIA_DRIVER_CAPABILITIES=compute,utility` to the backend service so the nvidia
  container runtime actually exposes the RTX 3090 (the GPU was not being passed through
  before, even though the host default runtime is nvidia).

Rebuilt and recreated **only** the backend container (`docker compose build backend`
then `docker compose up -d --no-deps backend`). The Electron front-end, manager (999),
all terminals, and the Postgres `db` container were left untouched — verified after:
control-API `/state` listed all terminals alive, `db` still `Up 5 hours`, only `backend`
recreated. No volumes were pruned or touched (the host holds many other projects' DB
volumes — all off-limits).

**Verified GPU + speedup.** In-container: `torch 2.12.1+cu130`, `cuda.is_available()`
True, device `NVIDIA GeForce RTX 3090`. Kokoro model params load on `cuda:0` (≈578 MB
GPU mem). Warm single-sentence synth: **0.83s on CPU → 0.05s on GPU (~16× faster)**; the
real `POST /api/tts/speak/` endpoint returned HTTP 201 in ~0.09s. Brief TTS/voice outage
during the backend recreate, as expected; service healthy afterward.

**Activation note:** these are backend-container changes and are already live (backend
recreated). No Electron/front-end restart was performed.

**Want.** When the wake word fires and the user is about to speak a command, any
notification currently being read aloud (Kokoro TTS) must stop immediately so the
assistant isn't talking over them.

**Where the audio lives.** Spoken notifications are played in the renderer by
`NotificationManager`: a single reused `HTMLAudioElement` (`this.audio`) streams the
clip from the Django backend (`localhost:8123` `audio_url`), preceded by a short
heads-up chime (`this.headsUp`), with a small FIFO autoplay queue. (The backend only
synthesizes/serves the audio; playback and timing are entirely client-side.)

**Change (`src/features/NotificationManager.js`).** Added `stopCurrentPlayback()` —
pauses the current spoken clip and the heads-up chime, clears the autoplay backlog so a
queued clip can't immediately start over the user, and resets `playing`/`_currentId`.
The interrupted notification is left un-marked-as-played and stays in history (the user
can replay it); normal autoplay resumes for the next NEW notification. It does not touch
the persistent mute toggle. Wired via the EventBus (the codebase's decoupled pattern,
not cross-module reach-in): `WakeWordManager` already emits `wake:state` with
`{state:'capturing'}` the instant the wake word activates command capture, so
`NotificationManager` subscribes to `wake:state` and calls `stopCurrentPlayback()` on
`'capturing'`. The wake activation chime (a separate WakeWordManager audio element) is
unaffected.

**Scope note.** This implements the clear "halt on wake" requirement. A second, related
request ("…if the wake-up is currently active, do not delay to play the current
notification…") was cut off and is deferred for manager clarification — i.e. whether to
also SUPPRESS new notifications from autoplaying while a capture is in progress. Not done
here; today only the in-flight readout is halted.

**Activation / restart.** Renderer-module change — it takes effect on the user's **next
manual app restart**. Per the hard constraint, the Electron app was NOT restarted (that
would kill every terminal including the manager 999).

**How to test (after the next manual restart).** (1) Trigger a spoken notification so a
readout begins — e.g. `curl -s -X POST http://localhost:8123/api/tts/speak/ -H
'Content-Type: application/json' -d '{"text":"This is a long test notification being
read aloud so there is time to interrupt it."}'`. (2) While it is speaking, say the
configured wake word. (3) Expect: the readout cuts off immediately (activation chime
still plays, mic stays open for the command). Alternatively live-probe a freshly-loaded
app: `window.terminalGUI.eventBus.emit('wake:state', { state: 'capturing' })` while a
notification plays and confirm it stops.

**Verified.** `node --check` passes; the `wake:state` subscription and
`stopCurrentPlayback()` are present and wired.

---

## 2026-06-24 — Manager doctrine: the dimmed autosuggestion is not the user

**Want.** The manager (999) inspects terminals via `/terminal/screen` and decides
whether a terminal is "user-driven" (leave it alone) or idle (step in). Claude Code
renders a dimmed/greyed autosuggestion in the prompt's input line — text it proposes,
which the user has not typed. The manager must never mistake that for the user typing or
for a user instruction.

**Change (`src/main/manager-session.js`).** Added a permanent note to the generated
manager role doc (`MANAGER_CLAUDE_MD`), right after the screen-reading guidance: the
dimmed prompt-line autosuggestion is Claude Code's own suggestion ONLY — never a user
instruction and never evidence the user is driving a terminal; only actually-submitted
input or a genuinely running/prompted turn counts as user activity. Bumped
`MANAGER_MD_VERSION` v8 → v9 so existing manager directories get the refreshed doc on
next boot (the writer only rewrites when the in-file version marker is stale).

**Verified.** `node --check` passes; the version marker is `v9` and the note is present
in the template.

---

## 2026-06-24 — Voice dictation: never cut off mid-speech; honor the configured silence

**Want.** When you wake the assistant and speak a command, it must (1) keep listening
for as long as you keep talking — no matter how long — and (2) stop only after the
amount of trailing silence YOU configured ("Stop after silence", set to 3s), not some
other number. It had been cutting off mid-sentence and taking ~5s to stop despite the
3s setting.

**Which path it was.** Traced to the in-app wake-word capture (`WakeWordManager`), not
the Django transcription backend (which only transcribes an uploaded clip — no
silence logic) and not the manual mic button (`VoiceManager`, which records until you
click again — no auto-stop). The wake-word path is the one that "stops after silence"
and sends a voice memo to the manager, matching the symptom.

**Why "set 3s but ~5s".** The setting wiring is actually correct end-to-end: the
`#wake-silence-ms` slider persists `wakeSilenceMs` and emits a live `preference:changed`
that `WakeWordManager` applies immediately. There is no hardcoded `5000` in the path —
the running value is 3000ms. Two real causes remained: (a) the silence clock
(`_lastVoiceAt`) was refreshed by *every* audio frame above a fixed RMS gate, so room
tone/breathing during natural pauses kept nudging it — the configured value behaved as
a "minimum clean-silence gap" that drifts longer, not a wall-clock timer from when you
stop; the same fixed gate (0.015, too high) also froze the clock during quiet trailing
speech and clipped sentence ends; and (b) a separate hardcoded `maxCommandMs` 60s cap
hard-stopped long speech regardless of silence. (Also: `wakeSilenceMs` was missing from
the persisted store — consistent with the earlier stale-lock persistence freeze — so a
post-freeze slider change wouldn't have survived a restart; that lock is now cleared.)

**Change (`src/features/WakeWordManager.js`, `src/features/PreferenceManager.js`).**
- **Unlimited duration:** removed the `maxCommandMs` cap entirely (field, the
  `wakeMaxCommandMs` preference + its now-dead default). Long continuous speech is
  never cut by a time limit.
- **Silence is the sole stop:** `_checkVad` now, once speech has started, ends capture
  *only* when `now - _lastVoiceAt > silenceMs` (the user's configured value). The only
  other guard is a pre-speech bail (≈8s) that fires *only if you never start talking*,
  so a stray activation can't record forever — it can never interrupt actual speech.
- **Configured seconds = real trailing silence:** the silence clock now resets only on
  a short *sustained* voiced run (`VOICE_RUN_FRAMES = 2`, ~170ms) instead of any single
  frame, so isolated noise spikes during a pause can't stretch the stop past the set
  value; and the RMS gate was lowered 0.015 → 0.010 so quiet/trailing speech still
  registers (fixing the mid-sentence clip). Net: set 3s ⇒ stop ~3s after you actually
  stop talking. The value still applies live (no restart) via `preference:changed`.

**Verified.** `node --check` passes on both files; no remaining `maxCommandMs` /
`wakeMaxCommandMs` references anywhere. (VAD timing behavior to be confirmed live by the
user against a real utterance.)

---

## 2026-06-24 — Stale terminals resurrecting on restart: a frozen store caused by a dead lock file

**Want.** Old, unused terminals (e.g. the defunct SSH leftovers "Caltrack mobile" and
"jade", plus orphans like "Lyra") kept reappearing after a restart even though they'd
been deleted live. The persisted store needed to permanently match the live terminals so
nothing dead comes back.

**Root cause (the real bug).** Terminals persist to `~/.config/auto-injector/auto-injector.json`
under `settings.terminalMetadata` (written by `renderer.js` `persistTerminalMetadata()`,
read at launch by `restoreTerminalsAndQueue()`). The store had been **frozen since
2026-06-11**: a stale, empty lock file `auto-injector.json.lock` (left behind ~5 minutes
after the last good write, almost certainly a crash mid-write) was blocking every
subsequent save. `AtomicStore.acquireLock()` creates the lock with an exclusive `wx`
flag, so it kept hitting `EEXIST`, spun for its 15s timeout, and threw — so **no setting
had persisted for ~13 days**. Because `createBackup()` runs *before* the lock step in
`processQueue`, the 5-minute backups kept appearing (all identical copies of the frozen
file), which masked the failure. Result: the store was a June-11 snapshot, the manager's
live deletes never saved, and every restart restored the old June-11 terminal list.

**Fix (no app restart needed).** Investigated read-only, backed up the store first
(`backups/auto-injector-PRE-DBCLEAN-…json`), then moved the stale lock aside (to
`backups/STALE-LOCK-removed-…lock`, reversible) so writes could resume. Then triggered a
clean re-persist through the normal path — the same control API the manager uses,
`POST /terminal/update {terminalId:1}` — which fires `persistTerminalMetadata()`. That
rebuilds the metadata from the **live** terminals and writes it through `AtomicStore`,
updating both the on-disk file and the main-process in-memory cache. No manual JSON
surgery (which would have been clobbered by the cache anyway) and no restart.

**Result.** Persisted `terminalMetadata` now exactly equals live state — `1=limerence`,
`2=validate`, `3=db-fix` (manager 999 is excluded by design). Orphans gone: old
`2=Caltrack mobile`, `6=jade`, and stale `1=Lyra` no longer exist. Verified writes are
healthy again: the store mtime now advances on every save and the lock is created and
released cleanly each cycle (no lingering `.lock`/`.tmp`). The cleanup is durable across
the next restart.

**Latent bug worth a code follow-up (not done here).** `AtomicStore`'s lock has no
staleness/age check and no recovery — any crash mid-write bricks all persistence
indefinitely and silently. Worth adding a stale-lock breaker (e.g. ignore/reclaim a lock
older than the 15s timeout) and surfacing write failures instead of swallowing them.

---

## 2026-06-23 — Task J: Tap the yellow mic to cancel an auto-listening capture

**Want.** If the wake word triggers when the user didn't mean it, tapping the (yellow)
mic button should cancel the in-flight command capture — nothing transcribed, nothing
sent — without disturbing the button's other two behaviors.

**Where the click handler branches (renderer.js).** The single `#voice-btn` click handler
now branches on state up front: if `wakeWordManager.isCapturing()` is true (the YELLOW
`wake-listening` state), it calls `wakeWordManager.cancelCapture()` and **returns early** —
so the cancel does NOT also fall through to `eventBus.emit('voice:toggle')` (no
double-trigger, no manual recording started from the same click). Otherwise the existing
`voice:toggle` flow runs unchanged: a tap in the NORMAL state still starts manual
recording, a tap during the red `.recording` state still stops it.

**The WakeWordManager cancel path (new).**
- `isCapturing()` → `this.state === 'capturing'`. The renderer uses this (the authoritative
  manager state, not just the CSS class) to decide the tap means "cancel".
- `cancelCapture()` — no-op unless capturing; logs the cancellation, emits `wake:state`
  `'idle'` (clears the yellow immediately), then calls the existing
  `_stopCommandCapture(true)`. The `abort=true` flag is the key: it stops the recorder and,
  in `_onCommandRecorded`, routes to the `if (this._abortCapture) { discard; resume; return }`
  branch — which clears `commandChunks` and returns **before** the `transcribeBlob` /
  `_sendToManager` calls. After that, `_resumeListening()` rebuilds the recognizer and
  re-emits `wake:state 'listening'`, so the spotter keeps working for next time.

**How nothing can be sent after a cancel.** The only transcription/send path is
`_onCommandRecorded` → `transcribeBlob` → `_sendToManager`, and it is gated entirely behind
`!this._abortCapture`. `cancelCapture()` sets that flag (via `_stopCommandCapture(true)`)
*before* the recorder's async `onstop` fires, the VAD timer is cleared in the same call so
it can't re-stop with a non-abort flag, and the captured chunks are discarded. So once
cancelled, the recorded audio is dropped and neither Whisper nor the manager queue is ever
reached.

**Safety.** Branches only the YELLOW case; the normal/red manual paths are untouched.
`node --check` passes on `renderer.js` and `WakeWordManager.js`. (Live mic can't be
exercised here — to test: trigger the wake word, then tap the yellow mic mid-capture →
the yellow clears, the action log shows "Wake capture cancelled — nothing transcribed or
sent", and nothing is queued to the manager; a tap with the button idle still starts a
manual recording, and a tap while red still stops it.)

---

## 2026-06-23 — BUGFIX (Task I): Wake word false-triggered on non-keyword speech (root cause: grammar-restricted recognizer)

**Reported.** Saying "Mo" (and other random speech) triggered the wake phrase
"miranda". The exact-phrase + average-confidence gate added earlier was NOT rejecting
non-keyword speech.

**Root cause (confirmed, not guessed).** The Vosk spotter was **grammar-restricted**.
`_rebuildRecognizer` built `new this.model.KaldiRecognizer(16000, JSON.stringify([phrase,
'[unk]']))`. A Kaldi recognizer constrained to a tiny grammar **snaps any incoming audio
to the nearest in-grammar token** — so a short noise like "Mo" decoded to "miranda", and
because that was the model's best (only) in-grammar hypothesis it came back with *high*
confidence. That simultaneously defeated the exact-text match (the snapped text literally
*was* "miranda") and the confidence gate (the snapped confidence was inflated). No
threshold tuning could fix a recognizer that can only ever output the phrase.

**The fix — open-vocabulary decoding + whole-word match + confidence backstop, final-only.**
1. **Removed the grammar.** `_rebuildRecognizer` now constructs `new
   this.model.KaldiRecognizer(16000)` (full open vocabulary). Random speech now
   transcribes as ITSELF — "mo" → "mo", never "miranda" — so the snap-to-phrase problem
   that caused the false positives is gone at the root. The bundled
   `vosk-model-small-en-us` is a full model, so no new asset is needed.
2. **Whole-word phrase match.** `_onResult` now requires the wake phrase to appear as a
   **contiguous whole-word** sequence in the transcription (new `_findPhrase` helper),
   not a loose substring — so "amanda"/"veranda"/"mirandaesque" don't match, and a
   multi-word phrase like "hey claude" must appear as those two words in order.
3. **Confidence backstop on the matched words only.** The average confidence is now
   computed over just the matched phrase words (previously: all words), and must clear
   `matchThreshold`. With open-vocab the confidence is meaningful again (no longer
   inflated by grammar snapping), so it genuinely rejects mumbled near-homophones.
4. **Final-result only.** Dropped the `partialresult` trigger (and the old `_onPartial`).
   Partials carry no confidence and flicker through interim near-words, so triggering on
   them fought the "never false-trigger" goal. Triggering on the final result (fired at
   the natural pause after the wake word, before the command) costs only a little latency.

**Why this hits the target (≈100% true-negative, genuine still works).** Non-keyword
speech essentially never decodes to the exact word "miranda" as a standalone token in an
open-vocabulary model, so it can't pass the whole-word match — the primary filter — which
is what drives false positives to ~zero. A clear, genuine "miranda" decodes to "miranda"
with high confidence and passes both gates. Less-clear utterances may occasionally miss
(decode as a homophone or score under threshold), which is the deliberate accuracy-over-
sensitivity trade the user asked for.

**Strict default + working slider.** `wakeMatchThreshold` default raised **0.6 → 0.75**
in all four places (PreferenceManager default, WakeWordManager init, the `#wake-threshold`
slider `value` + its `75%` label, and renderer `syncWakeUI`'s fallback). The slider still
feeds `wakeMatchThreshold` live via `_applyConfig` (clamped 0–0.95) and now meaningfully
changes behavior because the confidence is real: raise it toward 0.95 to reject more
borderline matches, lower it if a genuine phrase is missed.

**Safety.** `node --check` passes on `WakeWordManager.js`, `PreferenceManager.js`,
`renderer.js`; no dangling refs to the removed `_onPartial`/`partialresult`/old
`_matchConfidence`. The manual (red) voice-recording path is untouched.

**Can't validate live mic here — how to test.** Relaunch the app on this branch (renderer
code loads at startup) with wake word enabled. Expected: saying **"Mo"** and assorted
random words/sentences = **no activation** (watch the action log — no "Heard …" line);
saying the real phrase **"miranda"** clearly = **activates** (chime + "Heard 'miranda'").
If genuine detection feels too strict, lower the Wake-word strictness slider; if anything
still slips through, raise it.

---

## 2026-06-23 — BUGFIX (Task H): Settings forms showed hardcoded defaults, not saved values

**The bug.** Opening Settings showed the wake-phrase input as "hey claude" even though
detection was correctly listening for the real saved phrase ("miranda" — saying it
worked). The form was displaying the HTML/JS default, not the persisted value. The new
sliders (wakeSilenceMs, injectionDelayMs, wakeMatchThreshold) had the same gap.

**Root cause (timing).** Preferences load asynchronously: `preferenceManager.initialize()`
(renderer.js:192) is **async and not awaited** — it does `await db-get-all-settings` and
only then populates `preferenceManager.preferences` and emits `preferences:applied`. But
`setupSecondaryUI` runs `syncWakeUI()` / `syncInjDelay()` **synchronously during init**, so
they read the *constructor defaults* (`'hey claude'`, 3000, 0.6, 400). Those sync functions
were never re-run — not on the load completing, not on settings-modal open — so the form
stayed frozen on defaults. Detection, by contrast, reads the saved phrase because
`WakeWordManager` subscribes to `preferences:applied` (fired after the DB load) — the exact
event the form ignored. So form and detection diverged.

**The fix (renderer.js).** Reflect the saved values at the right moments:
1. `syncWakeUI()` now also sets the two wake-sound `<select>` values from prefs (once their
   options exist), in addition to phrase/silence/threshold.
2. Captured both reflectors as `this._syncVoiceSettingsForms = () => { syncWakeUI(); syncInjDelay(); }`.
3. Subscribed it to `preferences:applied`, so when the async DB load finishes the form
   re-reflects the real saved values.
4. Called it again on every settings-modal **open** (`openSettings`), which covers the
   round-trip case (change → reopen → see the change; values are kept live in
   `preferenceManager.preferences` by `updatePreference`) and any missed load event.

Saving still flows the other direction unchanged: the input `change`/`input` handlers call
`preferenceManager.updatePreference(...)`, which persists AND emits `preference:changed`, which
`WakeWordManager._applyConfig` consumes live — so form↔detection stay in sync both directions.

**Verified each control loads its saved value:** wake phrase, wakeSilenceMs slider,
wakeMatchThreshold slider, injectionDelayMs slider, and the two wake-sound selects all read
from `preferenceManager.preferences` via the re-run path. The mute toggle (Task G) already
initialized correctly — it restores via `preferences:applied` → `_applyMutedState` →
`_updateMuteButtonUI`. The theme/sound/manager-input/TTS controls were already correct (they
read from awaited `getPersistedSetting` values in `wireSettingsControls`, not the un-awaited
`preferences`). `node --check` passes; the manual voice path is untouched.

---

## 2026-06-23 — Tasks F & G verified complete (no code change needed)

**F — "Manager input" disabled blocks EVERY path to terminal 999.** Confirmed fully
implemented: `MessageQueueManager.isManagerInputDisabled()` reads
`appStateStore.getState('settings.managerInputEnabled')` **live at send time**; two
enforcement points cover all paths — `canInjectToTerminal` short-circuits for tid 999
*before* `evaluateInjectionGate` (so even **urgent** is blocked), and a universal guard at the
top of `_injectToTerminal` (the single sink for both auto and force/"Send now") blocks the
force path that skips the gate. The auto "terminal finished → notify manager" push is also
suppressed at source in `ManagerInstance.onTerminalCompletion` (`!this.completionWatchEnabled`
returns early). The renderer mirrors the toggle into `appStateStore` at load and on every
change (immediate, no restart), and re-enabling calls `maybeAutoInject(999)` to flush held
messages. Default = enabled.

**G — Mute notifications is a real persistent toggle.** Confirmed: `#notification-mute-btn`
is a stateful `mute-toggle` (toggles `is-muted`, sets `aria-pressed`, swaps the icon
volume-2↔volume-x, swaps the label "Sound on"↔"Muted"). Muting pauses BOTH the spoken clip
and the heads-up chime and the queue stops draining (`_drainQueue` guard), so ALL playback is
silenced. State persists as the `notificationsMuted` preference and restores on
`preferences:applied`/`preference:changed` via `_applyMutedState` (no persist, no loop) plus
`_updateMuteButtonUI` on first toolbar render — survives restart.

---

## 2026-06-23 — Voice: 3s stop delay + yellow "listening" mic indicator

**The problem.** With wake-word auto-listening on, the only feedback that the system
was actively hearing your command was the activation sound — the mic button gave no
visual cue. The red/spinner button states were wired only to the *manual* VoiceManager;
the wake-word system emitted its own `wake:state` events but nothing in the renderer
listened to them. The trailing-silence cutoff was also a slightly sluggish 5 seconds.

**What changed.**

1. **Faster stop-after-silence: 5s → 3s.** Lowered the wake-word VAD trailing-silence
   default in all four places it lived: `WakeWordManager`'s `this.silenceMs` initializer
   and its `wakeSilenceMs` load fallback, the settings slider's default `value` plus its
   `3.0s` label in `index.html`, and the renderer's load-default in `syncWakeUI()`.
   Slider min/max/step (2s–10s) were left untouched, so a user can still dial it back up.

2. **Yellow "listening" + spinner feedback on the mic.** Added a `wake:state` listener in
   `renderer.js` (right beside the existing manual `voice:button-state` listener). It maps
   the wake-word states onto the `#voice-btn`: `capturing` (recording your command) adds a
   new `wake-listening` class for a pulsing yellow/gold glow; `transcribing` reuses the
   exact same `.processing` spinner the manual flow uses, so transcription looks identical
   in both modes; `listening`/`idle`/`error` clear both classes back to normal. The state
   strings were verified against what `WakeWordManager` actually emits.

3. **Independent yellow path in CSS.** Added `.wake-listening` rules in `style.css` modeled
   on the existing red `.recording` rules but in gold (`#f5c542`) — yellow background/border,
   a yellow box-shadow glow, and a gentle `wake-listening-pulse` keyframe. The mic icon stays
   visible (no spinner during capture). The red manual `.recording` path is untouched, so
   manual (red) and auto (yellow) feedback stay fully independent.

**Why it's safe.** The manual `voice:button-state` wiring and the red `.recording` CSS were
not modified, so manual recording and its blue spinner behave exactly as before. `transcribing`
reuses the existing `.processing` class/keyframes rather than introducing a parallel spinner.
`node --check` passes on `renderer.js` and `WakeWordManager.js`.

---

## 2026-06-23 — Manager-input gating fix + a real mute toggle (Tasks F, G)

Two changes, left uncommitted for review.

### F. "Manager input" disabled now blocks EVERY path to the manager (999)

**Root cause of the leak.** The "manager input" toggle (Notifications-tab + settings
checkboxes `#manager-input-enabled` / `#manager-input-enabled-setting`, persisted as
`managerCompletionWatchEnabled`, default **enabled/true**) only drove
`ManagerInstance.setCompletionWatchEnabled`, which gates a *single* path — the auto
"terminal finished → notify manager" push in `onTerminalCompletion`. Every other route to
terminal 999 was ungated: the **urgent** voice-memo (`WakeWordManager` →
`addMessage({terminalId:999, type:'urgent'})`), the `PromptWatchManager` push, normal queue
injection, and the manager's own `/queue/add` control API. Worse, two structural bypasses let
urgent/forced messages through even at the gate: `evaluateInjectionGate` lets **urgent bypass
everything**, and `injectMessageNow` ("Send now"/force) **skips the gate entirely** and calls
`_injectToTerminal` directly. So an urgent message reached the manager despite the toggle.

**Fix — gate at the injection chokepoint, read live.** Added `MANAGER_TERMINAL_ID = 999` and
`isManagerInputDisabled()` to `MessageQueueManager`; the latter reads
`appStateStore.getState('settings.managerInputEnabled')` **at send time** (never cached;
`undefined`/`true` = enabled, only explicit `false` disables). Two enforcement points:
1. `canInjectToTerminal` short-circuits to `{allowed:false, reason:'manager input disabled'}`
   for tid 999 — placed **before** `evaluateInjectionGate`, so it also blocks urgent. This
   covers the auto path (`maybeAutoInject`), the toolbar/manual path
   (`manualInjectNextMessage`), and the legacy `injectMessageAndContinueQueue` — all of which
   consult `canInjectToTerminal`.
2. A universal guard at the top of `_injectToTerminal` (the single sink for both the auto and
   the force/"Send now" paths) — guarantees no path injects to 999 while disabled. The message
   stays queued and flushes when re-enabled.

Renderer mirrors the toggle into `appStateStore` (`settings.managerInputEnabled`) both at
startup load and on every toggle change, so flipping it takes effect immediately with no
restart; re-enabling also calls `maybeAutoInject(999)` to flush any held messages. The pure
`evaluateInjectionGate` policy (and its unit tests) was deliberately left untouched.

**Default kept:** enabled (`managerCompletionWatchEnabled` default `true`). **Confirmed blocked
when disabled:** urgent voice-memo → `addMessage(999,'urgent')` → `maybeAutoInject(999)` →
`canInjectToTerminal(999,'urgent')` returns blocked *before* the urgent bypass; force "Send now"
→ `_injectToTerminal` top guard returns early; auto completion push → suppressed at
`onTerminalCompletion` *and* blocked at the gate. `node --check` passes.

### G. Mute notifications is now a real, persistent toggle switch

**What changed.** The bare `#notification-mute-btn` icon button became a stateful toggle
(`class="mute-toggle"`, `aria-pressed`, an icon + a `.mute-toggle-label`). New CSS gives an
unmistakable two-state look: subdued "Sound on" (volume-2) when unmuted, filled red
"Muted" (volume-x) when muted. `NotificationManager` was split into `_applyMutedState()`
(applies to playback + UI, no persist — used by the restore/sync event handlers) and
`setMuted()` (applies **and** persists by emitting `preference:update`), avoiding a feedback
loop with `PreferenceManager`. Muting now pauses BOTH the spoken clip and the heads-up chime,
and `_drainQueue`'s existing `this.muted` guard keeps the whole queue from draining until
unmuted (silences ALL playback, not just the current clip). State persists under the new
`notificationsMuted` preference (default `false`) and is restored on `preferences:applied`,
so it survives navigation/restart; `_updateMuteButtonUI()` is also called on first toolbar
render. `node --check` passes; the manual voice path and wake-word B/C/D work are untouched.

---

## 2026-06-23 — Wake word: verify the stop-delay, expose send delay, cut false positives

Three changes to the voice/queue stack (Tasks B–D). All left uncommitted for review.

### A. Barge-in guard — REMOVED by user decision

This task originally added a self-trigger guard that muted the wake-word listener while the
app's own TTS/NotificationManager audio played (a `tts:playback` event broadcast from
`NotificationManager`, a `this.suppressed` flag + `_resumeTimer` and `PLAYBACK_RESUME_TAIL_MS`
tail in `WakeWordManager`, plus detection gates). **It was fully removed at the user's request**
because of the stuck-listening risk (if the resume signal were ever missed, the spotter could
stay muted). False positives are instead handled by the stricter wake-word matching/threshold
in Task D. Reverted cleanly: `NotificationManager` and `WakeWordManager` are back to their
pre-Task-A behavior for the TTS/wake interaction, with no orphaned flags, listeners, methods,
or constants (`grep` confirms zero references to the removed symbols).

### B. Verified the "Stop after silence" slider end-to-end (and fixed the real default)

**Verified wiring (already worked):** slider `#wake-silence-ms` `input` handler
(`renderer.js:1003-1006`) updates the `#wake-silence-value` label live AND calls
`preferenceManager.updatePreference('wakeSilenceMs', …)`, which persists
(`PreferenceManager.updatePreference` → `savePreference`) and emits `preference:changed`.
`WakeWordManager` subscribes and applies it **live** via `_applyConfig` →
`this.silenceMs = Math.max(1000, …)`; the VAD consumes `this.silenceMs` to end capture.

**Bug found + fixed.** `PreferenceManager`'s default still said `wakeSilenceMs: 5000`, which
is emitted on `preferences:applied` and would override the constructor's 3000 for any fresh
user — so the earlier "3s default" change was being defeated at the authoritative source.
Changed that default to `3000`. Now the default is genuinely 3s everywhere.

### C. Exposed the "Queue send delay" in Settings

**Investigation.** The only pref-backed injection delay, `injectionDelayMs` (default 1000),
lived in `MessageQueueManager.scheduleNextInjection`, which belongs to the **legacy** sequential
engine that the live per-terminal parallel path (`maybeAutoInject` → `_injectToTerminal`)
superseded — so that knob is effectively dead. The real "delay before the next queued message
is sent to a terminal" in the live engine was the hardcoded `400ms` re-drain in
`_finishInjection`. There was no Settings control either way, and `MessageQueueManager.preferences`
was never populated (stayed `{}`), so even the existing consumer never read a saved value.

**What changed.** Added a "Queue send delay" slider (`#injection-delay-ms`, readout
`#injection-delay-value`, range 0–3000ms step 100, default **400** to match the existing
hardcoded re-drain), wired in `renderer.js` to persist `injectionDelayMs` and update its label
live. `MessageQueueManager.setupEventListeners` now mirrors `preferences:applied` /
`preference:changed` into `this.preferences`, and `_finishInjection` reads
`this.preferences.injectionDelayMs` (fallback 400) for the re-drain wait. Default 400 preserves
current behavior exactly. (Bonus: populating `this.preferences` also makes the previously-dead
`keepScreenAwake` read live.)

### D. Stricter wake matching + a "Wake-word strictness" slider

**Matching mechanism found.** The Vosk recognizer used a grammar restricted to
`[phrase, '[unk]']`, and `_onPartial` fired `_onWakeDetected` on a loose **substring** match
(`norm.includes(phrase)`) for BOTH partial and final results — no confidence check at all.
Partial/interim hypotheses are the biggest false-positive source.

**What tightened (highest-leverage).** (1) Final results now go through a new `_onResult` that
requires an **exact** phrase match plus an **average word-confidence ≥ `matchThreshold`**
(`setWords(true)` is requested so confidences are available; if absent it falls back to the
exact-text match rather than blocking). (2) `_onPartial` now requires an **exact** phrase match
instead of a substring. Both are strictly tighter than before.

**New setting.** "Wake-word strictness" slider (`#wake-threshold`, readout
`#wake-threshold-value`, range 0–0.95 step 0.05, default **0.6**, shown as a percentage),
persisted as `wakeMatchThreshold` and applied live in `WakeWordManager._applyConfig`
(`this.matchThreshold`, clamped 0–0.95). Higher = stricter.

**Real phrase preserved.** A clearly spoken "hey claude" resolves to exactly the phrase under
the restricted grammar with high confidence (typically ≫0.6), so it still fires; the default
0.6 only rejects garbled, low-confidence near-matches. The slider lets the user raise strictness
toward 0.95 if false positives persist, or lower it if their genuine phrase is missed.

**Safety.** `node --check` passes on all changed files (`renderer.js`, `WakeWordManager.js`,
`PreferenceManager.js`, `MessageQueueManager.js`; `NotificationManager.js` was reverted to
pre-Task-A state). Could not launch the Electron app in this environment; verified by code
inspection, syntax checks, and tracing each pref → consumer path. The manual voice path and
red `.recording` UI remain untouched.

---

## 2026-06-08 — P1: Reliable per-terminal `runtime` (and live `directory`) in `/state`

**The problem.** The manager could not reliably tell, from `GET /state`, whether a
terminal was running Claude, sitting at a bare shell, or idle *inside* Claude. The
`status` field (`running`/`prompted`/`...`) is driven by Claude Code hooks, and
`sessionId`/`directory` were only filled in *after* the first hook fired — so a
freshly launched Claude read `sessionId: null` and looked identical to a bare shell
(both showed status `...`). The only workaround was dumping `/terminal/screen` and
eyeballing the TUI.

**What changed.** Each terminal in `/state` now carries a new `runtime` field:

- `"claude"` — Claude Code is genuinely running in this PTY
- `"shell"`  — a bare shell (or a non-Claude command)
- `"unknown"` — no live PTY / process gone

It is derived from the PTY's real process tree (via `/proc`), independent of whether
any hook has fired. The signal is exact: the `claude` CLI names its process
`claude`, so a descendant of the PTY's shell with that process name means Claude is
alive; a shell with no such descendant is a bare shell. The same pass also reads each
PTY's **live working directory** from the process and uses it for `directory`, so the
directory is correct immediately on a fresh terminal instead of `null`.

**Why it helps.** Combined with the existing `status`, the manager can now read state
without screen-dumping:

| `runtime` | `status`   | meaning                                  |
|-----------|------------|------------------------------------------|
| `shell`   | (any)      | bare shell — unsafe to inject a prompt   |
| `claude`  | `...`      | idle in Claude                           |
| `claude`  | `running`  | Claude running a turn                    |
| `claude`  | `prompted` | Claude awaiting input                    |

**Where the code lives.**
- New module `src/main/terminal-runtime.js` — pure, `/proc`-based detection
  (`detectRuntime`, `liveCwd`, `enrichSnapshot`); no Electron/node-pty dependency.
- `main.js` — the hook server's `getState` now wraps the renderer's cached snapshot
  with `enrichSnapshot(...)`, computed fresh on every `/state` GET. `HookServer.js`
  and the renderer are untouched.
- Tests: `src/main/terminal-runtime.test.js` (10 cases, `node --test`), plus a
  real-`/proc` sanity check confirming a live claude-shell reads `claude` and a bare
  shell reads `shell`.

**Backward compatibility.** Purely additive — `runtime` is a new field and `status`
semantics are unchanged. Existing consumers keep working.

**Requires a restart to take effect.** The only live-process change is the
`getState` wiring in `main.js`, which is loaded once at app startup. The running app
keeps serving the old `/state` until the Electron app is quit and relaunched. The new
module and tests do not affect the running app.

---

## 2026-06-08 — P1.5: Notify the manager when a worker is awaiting input

**The problem.** The interface already pushes a message to the manager (terminal
999) when a worker *finishes* a turn, but it stayed silent when a worker became
*blocked waiting on a human* — a permission dialog or an interactive menu. As the
orchestrator, the manager was blind to blocked workers and only learned of them if a
human said so, which defeats hands-off management.

**The catch.** The raw `prompted` status is not trustworthy as a "needs input"
signal: Claude's idle Notification hook also fires during long, high-effort thinking
turns, so triggering on status alone would spam the manager.

**What changed.** When a worker transitions into `prompted` (from a Claude hook), the
interface now waits briefly for the menu to paint, reads that terminal's on-screen
buffer, and only notifies the manager when the screen actually shows an interactive
prompt — detected by Claude's selector signature (the `❯` selection cursor next to
two or more numbered options). A long thinking turn shows no such menu, so it is
suppressed. The push reuses the manager's existing dispatch path (queues to 999) and
includes the terminal id + title, the notification message, and the parsed
**question and its options**, so the manager can answer without dumping the screen.

**Why the screen check is also the shell guard.** A bare shell cannot render a Claude
`❯` numbered menu, so requiring that on-screen signature inherently prevents notifying
on shell noise — P1's `runtime` field is not even needed here.

**De-dup.** A prompt is announced once per occurrence (keyed on its question +
options); the key resets when the terminal leaves `prompted`, so a genuinely new
prompt later is announced again.

**Where the code lives.**
- New `src/features/prompt-detector.js` — pure parser
  `detectPrompt(screen) -> { question, options } | null`.
- New `src/features/PromptWatchManager.js` — subscribes to
  `terminal:status:changed`, screen-checks on the prompted transition, de-dupes, and
  dispatches the note to 999. Gated by a new `managerPromptWatchEnabled` setting
  (defaults on). Touches neither `ManagerInstance` nor `main.js`.
- `renderer.js` — extracted a reusable `readTerminalScreen()` (the `/terminal/screen`
  endpoint now uses it too) and instantiated `PromptWatchManager`.
- Tests: 8 detector cases + 9 watcher cases (`node --test`), covering boxed/unboxed
  permission prompts, select menus, plain prose, thinking turns, de-dup, the
  enable/disable setting, and the 999 self-exclusion.

**Scope note.** Detects interactive menu/permission prompts (what was asked for).
Free-text prompts with no menu are out of scope for now.

**Requires the same restart.** The change is in the renderer (loaded at startup), so
it takes effect on the same relaunch as P1.

---

## 2026-06-08 — P2: Claude lifecycle + raw-key control endpoints

**The problem.** There was no clean way to start, resume, or restart Claude in a
terminal, or to send a control key (Esc, Ctrl-C, Enter). The only lever was queueing
the literal text `claude` as if typing at a shell — and when a terminal's state was
ambiguous, multi-line messages leaked into bash and ran as commands.

**What changed.** Two new control endpoints:

- `POST /terminal/keys` — `{ terminalId, keys }` where `keys` is a string or array
  of tokens. Named keys (`Ctrl+C`, `Esc`, `Enter`, `Up`, `Shift+Tab`, …) become the
  right control bytes; anything else is sent literally, so you can mix them — e.g.
  `["2","Enter"]` answers menu option 2. Writes straight to the PTY (bypasses the
  injection queue/gate, on purpose — Ctrl-C must work even mid-timer).
- `POST /terminal/claude` — `{ terminalId, action }`:
  - `start` — runs `claude` (with optional sanitized `args`), **only if the terminal
    is a bare shell** (`runtime === 'shell'`). Refuses if Claude is already running
    or the runtime is unknown — this is what prevents the multi-line-into-bash leak.
  - `resume` — `claude --continue`, or `claude --resume <sessionId>` when a valid
    (`[A-Za-z0-9._-]+`) session id is given; same shell-only guard.
  - `restart` — if Claude is running, interrupts it (Ctrl-C twice), waits for the
    shell to return, then relaunches; if already at a shell, just starts.

**Why it's main-side.** Unlike terminal create/delete (a renderer/xterm concern),
these are PTY-level. The PTYs and P1's `/proc` runtime detector both live in main, so
main handles these actions directly — writing to the PTY with no renderer round-trip
and using `runtime` as the guard. The renderer is untouched.

**Safety.** Session ids are pattern-validated; `args` have control characters and
newlines stripped, so a value can't smuggle an extra command past the trailing
carriage return.

**Where the code lives.**
- New `src/main/pty-control.js` — `translateKeys()` + `handlePtyControl()` (raw keys,
  start/resume/restart), dependency-injected and unit-tested (15 cases).
- `src/main/HookServer.js` — two new routes added to `CONTROL_ROUTES`.
- `main.js` — `onControl` now routes `terminal-keys` / `terminal-claude` to
  `handlePtyControl` (with `ptyFor`/`runtimeFor`/`sleep`), everything else still
  round-trips to the renderer.

**Requires the same restart.** Routes and the main-side handler are loaded at startup.

---

## 2026-06-08 — P4: Injection leak-guard (don't inject prompts into a bare shell)

**The problem.** A bare shell shows status `...` (idle), which passed the injection
gate — so a queued prompt was written into bash and each line ran as a command
("command not found"). The gate had no way to know the terminal wasn't running Claude.

**What changed.** The injection gate now refuses to inject into a terminal whose
ground-truth runtime is a bare shell. A blocked message is **not lost** — it stays
queued (dequeue only happens after a successful write) and injects once Claude is
running. The guard sits above the status gate, so even `urgent`/`important` cannot
push a prompt into bash. It triggers only on a definitive `shell`; `claude`,
`unknown`, and not-yet-known all fail open, so injection is never broken when the
runtime is undetermined.

**How the renderer learns the runtime.** A lightweight watcher in main polls each
PTY's `/proc` runtime (~2.5s, pushes only on change) and sends it to the renderer,
which stores it on the terminal. The gate reads it synchronously — no blocking IPC in
the gate, and the leak-critical claude→shell transition is caught within one poll.

**Coherent story across P1/P1.5/P2/P4.** P4 *blocks* the leak; P2 gives the *fix*
(`POST /terminal/claude start`); P1 + P1.5 give the *visibility* (the `runtime` field
and the awaiting-input notification). A prompt queued to a bare shell now waits
safely until Claude is started, instead of running as shell commands.

**Behavior change to note.** Previously a `normal` message to an idle bare-shell
terminal would inject (and leak). Now it is held in the queue with the reason
`terminal N is a bare shell (no Claude session)` until that terminal runs Claude.

**Where the code lives.**
- New `src/messaging/injection-gate.js` — pure `evaluateInjectionGate(state)` holding
  the full gate precedence including the shell guard (8 tests). The existing
  `canInjectToTerminal` was refactored to gather state and delegate to it (every
  prior reason preserved; the shell guard added).
- `main.js` — the `/proc` runtime watcher (`setInterval`, push-on-change).
- `renderer.js` — stores pushed `runtime` on the terminal via a `terminal-runtime`
  IPC handler.

**Requires the same restart.** The watcher (main) and the IPC handler (renderer) load
at startup.

---

## 2026-06-08 — BUGFIX: queue didn't auto-resume when a usage limit lapsed

**The bug.** When a terminal was paused by a usage/session limit, the interface ran a
countdown to the reset time. When that countdown hit 0, the queued messages should
have injected automatically — but the queue stayed frozen until something else (e.g.
enqueuing a new message) kicked it. Observed live with 4 messages stuck after a reset.

**Root cause (traced, not guessed).** The injection gate refuses to inject while
`timerManager.isRunning()` is true. `TimerManager` only clears its countdown interval
on an error or an explicit `stopTimer()` — when a countdown reaches 0 it sets
`timerExpired = true` but **leaves `timerRunning = true`**, so `isRunning()` stays
true indefinitely. The usage-limit "limit cleared" handler
(`UsageLimitManager.handleUsageLimitTimerExpiry`) released the *usage-limit* half of
the gate (`usageLimitWaiting = false`) and emitted `usageLimit:reset`, but never
released the *timer* half. So when `MessageQueueManager` re-drained on
`usageLimit:reset`, `canInjectToTerminal` still returned "timer still counting down"
and nothing injected. The enqueue path (`maybeAutoInject`) worked later only because
by then the gate happened to be open — matching the observed "drains the instant a
new message is enqueued."

**The fix.** `handleUsageLimitTimerExpiry` now stops the commandeered timer
(`timerManager.stopTimer()`) right after clearing `usageLimitWaiting`, before emitting
`usageLimit:reset`. With both halves of the gate released, the existing re-drain
injects the pending messages automatically — no new enqueue needed.

**Regression test.** `src/features/usage-limit-resume.test.js` drives the **real**
`UsageLimitManager.handleUsageLimitTimerExpiry` against the **real**
`evaluateInjectionGate`: a message queued, usage-limit waiting, timer "running";
firing expiry must release both gate halves and inject the message with no new
enqueue. (Loads the real ULM in plain node via an `electron` require shim.) Plus a
test asserting the `timer:expired` event drives the same resume, and one pinning the
root cause (a still-"running" timer blocks the gate).

**Related latent issue (NOT fixed — out of scope).** The same root cause means a
*manual* auto-inject timer expiring would also leave `isRunning()` true and block
injection. Only the usage-limit path is fixed here; the general timer-expiry case is a
separate decision.

**Requires the same restart.** The fix is in `UsageLimitManager.js` (renderer), loaded
at startup, so it takes effect on the same relaunch as the rest.

---

## 2026-06-08 — P3: Transcript read endpoint (last N parsed messages)

**The problem.** Reading what a worker has been doing meant the manager hand-parsing a
big JSONL transcript off disk. The app only ever extracted the single last assistant
message (for completions); there was no way to get the recent conversation.

**What changed.** New `POST /terminal/transcript` `{ terminalId, limit? }` returns the
last N (default 20, max 100) **conversational turns** as
`{ role: "user"|"assistant", text, ts }`, oldest-first:

- Human prompts and assistant replies are included.
- Assistant turns that only call tools become a compact `[tool_use: Bash, Edit]`
  marker so activity is visible without dumping raw tool output.
- Sidechain (subagent) entries, thinking blocks, and raw tool_result output are
  skipped. Each message is truncated to 4000 chars.

The terminal's transcript path is resolved **server-side** from the `/state` snapshot
(never from a caller-supplied path), and a terminal with no session yet returns a
clean `ok:false` instead of an error.

**Where the code lives.**
- `src/main/transcript-reader.js` — generalized from last-assistant-only to add
  `readRecentMessages()` (the parser) and `buildTranscriptResponse()` (resolves the
  path from the snapshot and shapes the response). The existing
  `readLastAssistantText()` is unchanged. Reads a 4 MB tail (enough for ~20 turns
  even amid large tool output).
- `src/main/HookServer.js` — `/terminal/transcript` route added to `CONTROL_ROUTES`.
- `main.js` — `onControl` handles `terminal-transcript` locally (a main-side file
  read), resolving the path from the cached snapshot.
- Tests: `src/main/transcript-reader.test.js` (9 cases) over a fixture matching the
  real schema, plus a sanity run against a real transcript.

**Backward compatible.** Purely additive; `readLastAssistantText`/completions
unaffected.

**Requires the same restart.** The route and handler load at startup.

---

## 2026-06-08 — BUGFIX: manual auto-inject timer didn't resume the queue at 0

**The bug (same class as the usage-limit one).** When a manual auto-inject timer
counted down to 0, the queue did not drain. The auto-inject feature is "wait N, then
inject", but injection never fired after the wait.

**Root cause.** `TimerManager.isRunning()` returned `timerRunning && !timerPaused`.
A countdown that reaches 0 sets `timerExpired = true` but leaves `timerRunning = true`
(the interval is only cleared on error/explicit stop). So `isRunning()` stayed true
after expiry, and `canInjectToTerminal` kept blocking with "timer still counting
down" — the same stuck-gate as the usage-limit bug, but on the general timer path.

**The fix.** `isRunning()` now also excludes the expired state:
`timerRunning && !timerPaused && !timerExpired`. An expired timer is not "running", so
at 0 the gate reopens and the existing `timer:expired → MessageQueueManager.handleTimerExpired → drain`
path injects the pending messages. This is the source-level fix and complements the
usage-limit fix above: the `isRunning()` change covers the countdown-reaches-0 path;
the `UsageLimitManager.stopTimer()` change still covers the usage-limit wall-clock
path (limit lifts while the timer is mid-count, before `timerExpired` is set).

Every `isRunning()` caller wants `false` after expiry (the injection gate and the
injection-loop guard both block while it's true; the usage-limit manager only consults
it during active waits, where `timerExpired` is false), so the change is safe.

**Regression test.** `src/features/timer-expiry-resume.test.js` drives the **real**
`TimerManager` to 0 (via `decrementTimer`) and asserts `isRunning()` is false and the
**real** `evaluateInjectionGate` then allows injection — i.e. the queue can drain.

**Requires the same restart.** The fix is in `TimerManager.js` (renderer).

---

## 2026-06-09 — BUGFIX: cost calculator never worked (ran ccusage in the wrong process)

**The bug (recurring).** The pricing/cost view always showed an error or nothing.
Earlier passes "wired" the UI (`98a9d0d`) but the numbers never appeared.

**Root cause (proven live, not guessed).** The renderer fetched
`POST http://localhost:8123/api/ccusage/`, and the Django backend ran
`npx ccusage daily --json` to read the Claude Code logs in `~/.claude/projects`.
But per the project's own rule the backend runs **in Docker**, and that container
(a) ships **no Node/npx** and (b) does **not mount** the host's `~/.claude`. So the
endpoint could only ever return `{"success":false,"error":"ccusage unavailable
(npx/Node not found on PATH)"}` — confirmed with a live `curl` against the running
container, and `docker compose exec backend which npx node` returns nothing. The
data ccusage needs (Node + the logs) lives **only on the host**, so no amount of
renderer/backend wiring could fix it. Every prior attempt patched the wrong layer.

**The fix (right layer).** Run ccusage in the **Electron main process**, which runs
on the host where `npx` and `~/.claude/projects` both exist. New
`src/main/ccusage.js` shells out to `npx -y ccusage daily --json`, shapes the JSON
exactly like the old backend response, and is exposed over IPC as `get-ccusage`.
`renderer.js#loadPricingData()` now calls `ipcHandler.invoke('get-ccusage')`
instead of fetching the backend. The Docker backend is no longer in the cost path
at all, so it works in the default Docker deployment.

**How verified.**
- Unit: `src/main/ccusage.test.js` (8 cases, `node --test`) — daily/weekly/total
  math + rounding, today/week windowing, and the failure modes (npx missing,
  timeout, auth error, non-JSON) all return clean `{success:false}` without throwing.
- Runtime (live-probed the real app via Playwright on this branch): IPC
  `get-ccusage` returned real figures (daily **$44.45**, weekly **$1052.12**, total
  **$3222.67** over 44 days), and after `loadPricingData()` the DOM cost cards read
  `$44.45 / $1052.12 / $3222.67`, `#pricing-data` visible, `#pricing-error` hidden.

**Restart needed?** Yes — the change is in `main.js` (IPC handler, loaded once at
startup) + the renderer, so the running app must be relaunched onto this branch.
Verified post-(fresh-launch). No backend/Docker dependency remains for pricing.

---

## 2026-06-09 — BUGFIX: message input box didn't grow/shrink with content

**The bug.** The `#message-input` textarea stayed one row tall no matter how much
was typed; long multi-line prompts were stuck behind a tiny scrollbar instead of
the box expanding.

**Root cause.** A `<textarea>` does not auto-size to its content — that always
requires JS to measure `scrollHeight` and set the height. The CSS
(`.chat-input #message-input`) already had `min-height`/`max-height:200px`/
`overflow-y:auto`, but nothing ever updated the element's height, so it never grew.

**The fix.** `renderer.js` now binds an `input` handler that does the standard
auto-size dance: set `height='auto'` (so it can shrink), then
`height = scrollHeight + 'px'` (so it grows). The CSS `max-height:200px` caps it
and `overflow-y:auto` takes over with a scrollbar past that. It's also reset after
a message is sent (textarea cleared → collapse back to one row) and sized once on
startup.

**How verified (live-probed the real app via Playwright).** Typing 1/3/6/10/30
lines produced heights 28 → 67 → 125 → 200 (capped) → 200 (capped, scrollbar
active), and removing text shrank it back through 67 → 28. No per-keystroke height
creep (border-box is clean). Assertions: grows ✓, caps at max with scroll ✓,
shrinks back to one row ✓.

**Restart needed?** Yes — renderer change, loaded at startup; relaunch the app onto
this branch.

---

## 2026-06-09 — Sound effects: close the cold-start gap + delete a broken duplicate path

**Status going in.** Reported "still broken" across multiple prior attempts. Live
investigation on this branch (Playwright, real button clicks) showed the core path
already FUNCTIONS: `new Audio('./assets/soundeffects/confirm.wav').play()` resolves
and plays, `cloneNode()` plays too (the earlier "cloneNode is the bug" theory was
wrong), the toggle flips `soundManager.soundEnabled`, and the three test buttons
each call `playSound` with the audio loaded (`readyState 4`). So there was no
single dead switch — but there WERE two real defects worth fixing.

**Defect 1 — cold-start window.** `setupSettings()` wired the sound toggle and
test buttons only AFTER `await soundManager.initialize()` (an IPC dir-read), and it
first did 7 *sequential* `getPersistedSetting` IPC awaits. So for ~1-2s after
launch the sound controls were unbound — toggling did nothing. **Fix:** load the 7
persisted settings in parallel (`Promise.all`) and wire the controls BEFORE the
async sound-file load. The sound `<select>`s repopulate when files arrive — keyed
on `sound:update-ui` (emitted at the END of `initialize()`, after stale-pref
healing) rather than `sound:files-loaded` (mid-init, pre-heal, which would leave
the dropdown on a non-existent `.mp3` → blank). Repopulation is idempotent
(`sel.onchange`, not `addEventListener`). Measured: toggle now wired within ~1s of
launch; dropdowns show all 20 real `.wav` files with a valid healed selection
(`confirm.wav`) by ~2s.

**Defect 2 — broken duplicate sound path.** `CompletionManager` had its OWN
`checkCompletionSoundTrigger`/`playCompletionSound`/`testCompletionSound` that ran
on every completion in parallel with SoundManager's. It used the wrong asset dir
(`new Audio('sounds/…')` — the files live in `assets/soundeffects/`) and a setting
key (`completionSoundEnabled`) that is never set, so it silently failed every time.
**Fix:** removed it; completion/prompted/injection sound is owned solely by
`SoundManager`. Verified a `running→'...'` status change still plays via SoundManager
with no error and the removed methods are gone.

**How verified (live).** Steady-state sampling 1-9s after launch: toggle wired,
20-file dropdown, valid selection; test buttons fire `playSound` with audio loaded;
completion event plays through SoundManager; removed CM methods are `undefined`.

**⚠ Restart REQUIRED — this is the crux of "still broken".** All sound logic is in
the renderer, loaded once at startup. A running instance from before this branch
keeps the old (unwired / mid-init-gated) behavior no matter what you toggle. **You
must quit and relaunch the app onto this branch (rebuild if packaged).**

**If it is STILL silent after a clean relaunch of this branch, check, in order:**
1. **You're actually on this branch / freshly rebuilt** — not a stale Electron
   process. Confirm the dropdowns list real `.wav` files (beep/click/confirm/…); if
   they show `.mp3` names, you're on old code.
2. **System audio output device** — Electron plays to the OS default sink. Verify
   the machine's output device/volume isn't muted or routed to a dead device
   (other app audio audible?). `play()` resolving (it does here) means the app did
   its part; silence after that is an output-routing/hardware issue, not the app.
3. **The ~1-2s cold-start window is now fixed** — toggling immediately on launch
   works; you no longer need to wait. If you toggled during that old gap before,
   that symptom is gone.
4. The "sound effects" master toggle is ON (it defaults OFF), and the per-sound
   `<select>` is not set to `none`.

---

## 2026-06-09 — BUGFIX: to-dos weren't persisted (lost on reload/restart)

**The bug.** "To-dos" (the per-terminal record of completed Claude turns, shown in
the To-dos / completions panel) vanished on every reload/restart.

**Root cause.** `CompletionManager` held completions ONLY in an in-memory
`this.completionItems = new Map()`. Nothing ever wrote them to disk and nothing
loaded them back, so a fresh renderer always started empty. (The codebase still had
unused `api-client.js` methods pointing at a `/todos/items/` backend, but that
Django app was deliberately removed — `INSTALLED_APPS` and `urls.py` no longer have
it — so those calls would 404. Persisting there would mean resurrecting a deleted
app.)

**The fix (right layer = the app's existing local store).** Persist completions to
the same `electron-store`-backed unified store that already holds `messages`,
`messageHistory`, and `settings` — i.e. the app's local "database". Added:
- `unified-store.js`: a `completions` array in the schema + `getCompletions` /
  `saveCompletions` (capped to the 500 most recent) / `clearCompletions`.
- `main.js`: `db-get-completions` / `db-save-completions` / `db-clear-completions`
  IPC handlers.
- `CompletionManager`: takes the ipc wrapper; `persistCompletions()` (debounced
  250ms, serializes a JSON-safe view that drops live timer handles) is called on
  every record/create/status-change/summary; `loadPersistedCompletions()` rehydrates
  the Map and re-renders oldest-first on startup, and bumps the id counter past the
  restored max to avoid collisions.
- `renderer.js`: passes `ipcHandler` into `CompletionManager` and calls
  `loadPersistedCompletions()` during `finalizeInitialization()`.

**Why local store, not Postgres.** The backend `todos` app was intentionally
deleted, and every other client-side record (messages, history, settings) already
lives in the unified store. Matching that keeps one persistence path and needs no
backend/Docker round-trip. (Switching to Postgres later would mean re-adding the
Django app — a larger product decision, not a bugfix.)

**How verified (live, across an ACTUAL restart).** Recorded a hook completion via
`completion:recorded` → it appeared in `#todo-list` AND `db-get-completions`
returned it. **Quit the app, relaunched it**, and the same to-do was back in
`#todo-list` and in `completionItems` (map size 1, mark present). Test data was
cleared afterward so the real store stays clean.

**Restart needed?** The fix takes effect on relaunch (main IPC + renderer load at
startup). Once running this branch, to-dos persist continuously — no restart needed
between sessions, that's the whole point.

---

## 2026-06-09 — BUGFIX: sound test buttons + dropdowns stayed unclickable after enabling

**Symptom (precise repro).** In Settings, after checking the "Sound Effects" enable
checkbox, the three sound `<select>`s and "Test" buttons stayed non-interactive —
they behaved as if still disabled and never responded to mouse clicks. This is the
*real* defect behind the long-running "sound is broken" reports, and the prior pass
([above](#2026-06-09--sound-effects-close-the-cold-start-gap--delete-a-broken-duplicate-path))
missed it.

**Why the prior pass missed it.** That pass verified the test buttons by calling
`button.click()` in a Playwright probe. Programmatic `.click()` (and dispatched
events) fire a handler *regardless of `pointer-events`* — CSS `pointer-events: none`
only blocks real pointer hit-testing, not synthetic clicks. So the probe reported
"buttons fire" while a real user's mouse was still blocked. The probe tested the
handler, not the gate.

**Root cause.** `style.css` gates the whole group on a class:
```css
#sound-selection-group        { opacity: .5; pointer-events: none; }
#sound-selection-group.enabled{ opacity: 1;  pointer-events: auto; }
```
But the renderer's `reflectSoundGroup(on)` only set inline
`soundGroup.style.opacity` and **never added/removed the `.enabled` class**.
Nothing anywhere toggled `.enabled`. So `pointer-events: none` always won and every
select/test button was permanently unclickable; checking the box merely changed the
dimming, which *looked* like it should have enabled them.

**The fix (one line, in `renderer.js`).** Make `reflectSoundGroup` toggle the class
the CSS actually keys on instead of poking inline opacity:
```js
const reflectSoundGroup = (on) => { if (soundGroup) soundGroup.classList.toggle('enabled', !!on); };
```
The CSS rule already handles both the opacity and the `pointer-events` flip, so the
class is the single correct switch. Runs on init (reflecting the persisted state)
and on every checkbox `change`.

**How verified (live, real gate not synthetic click).** Playwright probe against the
running app: with the checkbox OFF, `getComputedStyle('#sound-selection-group')
.pointerEvents === 'none'` and no `.enabled` class; after dispatching the checkbox
`change` ON, `pointerEvents === 'auto'`, the `.enabled` class is present, the
20-file dropdown is populated, and the test button's handler fires. The
`pointer-events` computed-value check is the true test of whether a real mouse click
would land — that's what the prior pass failed to assert.

**Restart needed?** Yes — sound wiring lives in the renderer, loaded once at
startup. Quit and relaunch onto this branch (rebuild if packaged) for the fix to
take effect.

---

## 2026-06-09 — BUGFIX: message history was invisible, not loaded, and clobbered

**Symptom.** The message-history feature didn't work: the history modal never
opened, and even when reached the list was empty across reloads/restarts.

**Three independent defects (all on the path to "history works"):**

**1 — Modal had no wiring.** `index.html` had the full markup (`#message-history-btn`,
`#message-history-modal`, `#clear-history-btn`, `#history-list`) and MQM kept a
`BoundedArray` of history, but nothing in the renderer opened the modal or rendered
the list — so history was structurally invisible. **Fix (`renderer.js`):** wire
open/close/backdrop-click/clear and a `renderHistory()` that lists items newest-first
(terminal + timestamp meta, `textContent` body = XSS-safe), plus a live refresh on
`message:history-updated` while the modal is open.

**2 — Persisted but never loaded back.** `saveToMessageHistory()` (called on every
injection) pushed to the in-memory array, but nothing wrote it to disk and
`MQM.loadMessageHistory()` was never called at startup. **Fix:** `persistMessageHistory()`
writes to the unified store (`db-set-setting 'messageHistory'`, same channel/pattern
the queue uses) on every record/clear; `renderer.js` calls
`messageQueueManager.loadMessageHistory()` right after `restoreQueue()` in
`finalizeInitialization()`. Note the store round-trips a `JSON.stringify`'d array
back as a *parsed array* (electron-store deserializes), so both load paths use the
`typeof raw === 'string' ? JSON.parse(raw) : raw` guard — identical to `restoreQueue`.

**3 — A second writer clobbered it.** `PreferenceManager` had its own
`loadMessageHistory`/`saveMessageHistory` for the *same* `messageHistory` store key,
capped at 100 and fed from a `preferences.messageHistory` copy that was loaded once
at startup and never updated as messages injected. On settings import
(`saveAllPreferences`) it wrote that stale copy back, wiping the session's messages.
Its `messageHistory:loaded` event had no listeners (dead path). **Fix:** removed
PreferenceManager's load/save of `messageHistory` entirely; `MessageQueueManager` is
now the sole owner of that key.

**How verified (live, Playwright against the running app).** Recorded a marked item
via `saveToMessageHistory` → present in memory; opened the modal via its button →
modal `show` + the item rendered in `#history-list`; read it back from the store;
wiped the in-memory array and called `loadMessageHistory()` → the item came back
(true persistence proof, not just a same-session read); `clearMessageHistory()` →
gone from both the store and the list. Test data cleared afterward.

**Restart needed?** Yes — renderer wiring + the startup history load take effect on
relaunch. After that, history persists continuously.

---

## 2026-06-09 — BUGFIX: Shift+wheel didn't scroll the terminal grid horizontally

**Symptom.** Holding Shift and scrolling the mouse wheel over the terminal grid did
nothing — there was no way to page horizontally through terminal chunks with the
wheel.

**Two root causes (both had to be fixed):**

**1 — xterm swallowed the wheel event.** The grid (`#terminals-container`, the
`layout-scroll` flex container with `overflow-x: auto`) is horizontally scrollable
when there's more than one chunk, but a wheel event over a terminal is consumed by
xterm's own scrollback handler and never bubbles to the container. **Fix:** a
**capture-phase** `wheel` listener on the container (registered once in
`setupEventListeners`) with `{ passive: false, capture: true }`. Capture runs the
container's handler before xterm's (which sits on a descendant), and `stopPropagation`
+ `preventDefault` keep the gesture from reaching the terminal. Guarded on
`e.shiftKey` and on the grid actually being horizontally scrollable
(`scrollWidth > clientWidth`), so it's a no-op otherwise and plain wheels are
untouched.

**2 — `scroll-snap` ate sub-page nudges.** First attempt did
`scrollLeft += e.deltaY`. That visibly fired (preventDefault ran) but the grid never
moved, because the container has `scroll-snap-type: x mandatory` with each chunk a
full-width (100%) snap point — any scrollLeft that isn't on a snap boundary snaps
straight back to the nearest one (verified live: `scrollLeft = 200` → reads back `0`;
`scrollLeft = clientWidth` → sticks). **Fix:** advance a whole **page** per gesture —
`scrollBy({ left: sign(delta) * clientWidth, behavior: 'smooth' })` — which lands
exactly on the adjacent chunk's snap point. Throttled to one page per 350ms
(via `e.timeStamp`) so a single wheel gesture's momentum doesn't skip several pages.

**How verified (live, TRUSTED wheel via Playwright mouse/keyboard).** Spawned 6
terminals (chunk size 4 → multiple chunks → `scrollWidth 2249 > clientWidth 749`),
moved the pointer over a terminal, held Shift: wheel forward paged `scrollLeft` 0 →
750 (one snap-aligned page); wheel back returned it to 0; a plain (no-Shift) wheel
left the grid scroll at its snap point unchanged. Note: synthetic
`new WheelEvent({deltaY})` does **not** carry usable deltas here — a real
`page.mouse.wheel` was required to exercise this honestly.

**Restart needed?** Yes — the listener is wired once at renderer startup.

---

## 2026-06-09 — BUGFIX: todo output panel always said "No terminal output available"

**Symptom.** Every todo item's output (shown in the completion-details modal) read
"No terminal output available", even when that terminal had output.

**Root cause.** `CompletionManager` fetches a terminal's live data through a
synchronous request/callback event — `this.eventBus.emit('completion:request:terminalData',
{ terminalId, callback })` — in both `recordHookCompletion` and
`displayCompletionOutput`. **Nothing in the renderer listened for that event**, so the
callback was never invoked and `terminalData` stayed `null`. `displayCompletionOutput`
then hit its `if (!terminalData)` branch → "No terminal output available" every time
(and the todo's colour/name fell back to defaults). Confirmed by grepping: only
`emit('completion:request:terminalData', …)` existed, zero `.on(...)`.

**Fix (`renderer.js`).** Register the missing provider next to the other terminal
eventBus listeners. It resolves the terminal from the state store and answers the
callback synchronously (EventBus dispatch is synchronous, same pattern as
`preference:get`):
```js
this.eventBus.on('completion:request:terminalData', ({ terminalId, callback }) => {
    if (typeof callback !== 'function') return;
    const t = this.terminalStateManager.getTerminal(parseInt(terminalId, 10));
    if (!t) return;
    callback({ lastOutput: t.lastOutput || '', color: t.color || this.getTerminalColor(terminalId),
               name: t.title || `Terminal ${terminalId}` });
});
```
`displayCompletionOutput` already extracts the text between `⏺` and `╭` from
`lastOutput` — it just never received any data to extract from.

**How verified (live, Playwright).** Created a terminal, set its `lastOutput` to
`…⏺ Hello output line 1\n  line 2\n╭…`, fired a `completion:recorded` hook, opened the
todo's modal → output panel showed **"Hello output line 1  line 2"** (the extracted
text) instead of the "No terminal output available" placeholder. Test data cleared.

**Restart needed?** Yes — the listener is wired once at renderer startup.

---

## 2026-06-09 — BUGFIX: todo "#N" badge always showed "#0"

**Symptom.** The top-right badge on every todo item read "#0", never a real value.

**Root cause.** `renderCompletionItem` rendered
`<span class="completion-prompt-number">#${completionItem.promptNumber}</span>`, and
`promptNumber` was set from `terminalData?.promptCount`. But (a) the `terminalData`
callback never fired (see the output-panel bug above) and, more fundamentally,
(b) **`promptCount` does not exist anywhere in the codebase** — the terminal state
object has no such field, so even with the callback wired the badge would still be 0.
There was no real data source behind the badge.

**Fix (`CompletionManager.renderCompletionItem`).** Render the value the item actually
carries and that the user asked for — the **terminal id** —
`#${completionItem.terminalId}`. It's always present (set at creation and persisted by
`_serializeCompletion`), so the badge now identifies which terminal each todo belongs
to. (Reviving a real per-terminal "prompt count" would be a new feature with no
existing source; the terminal id is the meaningful identifier we have.)

**How verified (live, Playwright).** Spawned several terminals, fired a hook completion
for a non-1 terminal (id 7), and read the badge → **"#7"**, matching the item's
`dataset.terminal`, instead of "#0". Test data cleared.

**Restart needed?** Yes — renderer code loads once at startup.

---

## 2026-06-09 — BUGFIX: todo "set X ago" timer was frozen at "0m 0s"

**Symptom.** Every todo's elapsed timer read "0m 0s" and never advanced.

**Root cause.** `renderCompletionItem` hardcodes `<span class="completion-timer">0m 0s
</span>`, and the only code that updated it was the per-item interval in
`startCompletionMonitoring`, which (a) is started **only** by `createCompletionItem`
(the in-progress path) and (b) ticks **only while `status === 'in-progress'`**.
Hook-driven todos are created by `recordHookCompletion` with `status: 'completed'` and
never call `startCompletionMonitoring`, and restored todos aren't monitored either —
so nothing ever wrote their timer and it stayed at the literal "0m 0s". (The separate
`completion-timer.js` / `CompletionTimerManager` is dead code — the global
`completionTimerManager` it guards on is never instantiated.)

**Fix (`CompletionManager`).** Added one shared 1-second ticker (`startElapsedTicker`
in the constructor → `updateElapsedTimers`) that drives **every** rendered todo from
its own `startTime`: it writes `now − startTime` as "Xm Ys" to each item's
`.completion-timer`, so completed hook items and restored items all count up live
("set X ago"). `renderCompletionItem` also seeds the value immediately on render
(restored items have a past `startTime`, so the hardcoded "0m 0s" would otherwise be
wrong until the next tick). `startTime` is already persisted by `_serializeCompletion`,
so restored items show the correct age.

**How verified (live, Playwright).** Fresh hook todo: "0m 0s" → after ~3.2s → "0m 3s"
(advancing). Backdated an item's `startTime` by 125s and forced a tick → seeded
**"2m 5s"** immediately, then advanced to "2m 6s" after ~2.5s. Test data cleared.

**Restart needed?** Yes — renderer code loads once at startup.

---

## 2026-06-10 — BUGFIX: voice button recorded but every transcription failed (400)

**Symptom.** Clicking the mic button started/stopped recording normally, but every
attempt ended in "❌ Transcription failed" and no text ever reached the message input.

**Root cause.** Form-field name mismatch on the upload. `VoiceManager.transcribeAudio`
posted the blob as `formData.append('audio', …)`, but the backend's
`AudioUploadSerializer` (backend/voice_transcription/serializers.py) declares
`audio_file = serializers.FileField()` — so Django rejected every request with
`400 {"audio_file": ["No file was submitted."]}`. The button, recording flow, event
wiring, health check, and backend endpoint were all fine.

**Fix (`src/features/VoiceManager.js`).** Renamed the form field to `audio_file` to
match the serializer.

**How verified (live, Playwright + fake media device).** Launched the app with
`--use-fake-device-for-media-stream`, clicked the voice button, recorded ~3s, stopped.
Before: 400 "No file was submitted". After: upload accepted, Whisper ran, pipeline
completed with "⚠️ No speech detected" (the fake device emits a tone, not speech) and
the button returned to ready — the full happy path now works.

**Restart needed?** Yes — renderer code loads once at startup.

---

## 2026-06-10 — BUGFIX: terminal 1's saved name never showed after restart

**Symptom.** Renaming terminal 1 worked for the session, but after a restart the
header showed "Terminal 1" again (the store actually held the custom name — e.g. a
long-saved "Lyra" was sitting in `terminalMetadata`, never displayed).

**Root cause.** `createTerminal()` (renderer.js) reuses the static terminal-1 wrapper
shipped in index.html instead of building chrome. That reuse branch synced only the
color dot from restored metadata; the dynamic-wrapper branch sets
`.terminal-title.textContent` but the reuse branch never did, so the static
"Terminal 1" text was left in place while the state manager (and persistence) carried
the real name. Save was never the problem — restore-to-DOM was.

**Fix (`renderer.js`, createTerminal static-wrapper branch).** Sync the title too:
set the wrapper's `.terminal-title` text from `options.title` when provided,
mirroring the dynamic branch.

**How verified (live, Playwright, two sessions).** Renamed terminal 1 via
`setTerminalMetadata(1, {title})`, closed the app, relaunched: DOM title and state
manager both showed the new name. Original name restored afterward.

**Restart needed?** Yes — renderer code loads once at startup.

---

## 2026-06-10 — CHANGE: two message types only; 'normal' no longer waits on 'running'

**Request.** Remove the 'important' priority; keep 'urgent' and 'normal'. Normal's
send condition: destination terminal isn't 'prompted' AND the auto-inject timer
isn't running (or is at 0). The 'running' state is finnicky and gets stuck, so its
role in the normal-inject gate is removed (the underlying running-state bug is
deliberately NOT fixed here).

**Exact new condition.** `normal` injects iff `terminal.status !== 'prompted'` AND
`!timerManager.isRunning()` — `isRunning()` is already false when the countdown is
stopped, paused, or expired at 0, which matches "isn't running or not at 0". The
usage-limit, paused (master send toggle), and bare-shell guards are unchanged and
still apply to both types. `urgent` is unchanged: jumps to the queue front and
bypasses the status gate (but never the bare-shell guard).

**Changes.**
- `src/messaging/injection-gate.js` — status gate now blocks non-urgent only on
  'prompted'; 'running' no longer gates. 'important' bypass removed.
- `src/messaging/MessageQueueManager.js` — `VALID_TYPES = ['normal','urgent']`
  (legacy/API 'important' coerces to 'normal' via normalizeType, so stale queue
  items and control-API callers degrade gracefully); queue badge now urgent-only;
  "Mark important" menu option removed; comments updated.
- `renderer.js` / `index.html` / `style.css` — Important removed from the input-bar
  priority selector (UI shows Normal/Urgent only).
- `src/main/manager-session.js` — manager control-API docs rewritten for the
  two-type system and the new normal condition.
- `src/messaging/injection-gate.test.js` — updated; 9/9 pass, including a new
  legacy-'important'-gets-no-bypass case.

**How verified (live, Playwright + node --test).** In the running app:
priority menu = [normal, urgent]; normalizeType('important') → 'normal';
normal while status 'running' → allowed; while 'prompted' → blocked
("terminal 1 is prompted"); while a 60s countdown armed → blocked ("timer still
counting down"); after stopping the timer → allowed. urgent allowed while
'prompted'. All 9 injection-gate unit tests pass.

**Restart needed?** Yes — renderer code loads once at startup. The manager's
CLAUDE.md template only applies to newly-written manager directories; an existing
manager dir keeps its old doc text until regenerated.

---

## 2026-06-10 — voice: real processing spinner + microphone device picker

**Symptoms.** (1) While a recording was being transcribed, the whole mic button
(icon included) rotated — the `.processing` CSS applied `animation:
processing-spin` to the button element itself. (2) Recordings came back silent
for users whose system-default input isn't the real microphone, and there was no
way to choose the input device.

**Fixes.**
- `style.css` — `.processing` no longer rotates the button. The mic icon (svg) is
  hidden in that state and a dedicated circular `::after` spinner ring takes its
  place (reuses the previously-unused `processing-spin-circle` keyframes; the old
  whole-button `processing-spin` keyframes are deleted).
- Microphone picker: new "Microphone" select in the settings modal
  (`#microphone-select`, index.html). `renderer.js` repopulates it on every
  settings open via `enumerateDevices()` (a throwaway `getUserMedia` first, so
  device labels are exposed); changes persist as the `microphoneDeviceId`
  preference (PreferenceManager default: `'default'`).
- `src/features/VoiceManager.js` — picks the persisted device up on load
  (`preferences:applied`) and live (`preference:changed`); records with
  `deviceId: { exact: … }`, falling back to the system default (with a warning in
  the action log) if the saved device is unplugged/stale. Also logs
  "🎙️ Using microphone: <label>" at record start so a wrong-input capture is
  visible immediately.

**How verified (live, Playwright + fake media devices).** During processing the
button's computed `animation-name` is `none`, the svg is `display:none`, and the
`::after` pseudo-element spins with `processing-spin-circle` at 50% border-radius
(a circle). Settings shows "System default" + "Fake Audio Input 1/2" with labels;
selecting one updates `voiceManager.microphoneDeviceId` and the preference, and
`buildAudioConstraints()` yields `{deviceId:{exact:…}}`. After an app restart the
saved device is restored onto VoiceManager (also proven with a marker id via
`db-get-setting` round-trip). Probe reset the setting to 'default' afterward.

**Restart needed?** Yes — renderer/CSS load once at startup.

---

## 2026-06-10 — voice: spinner escaped the button; silent recordings now diagnosed

**Symptoms.** (1) The processing spinner rendered OUTSIDE the mic button (above
it) while the button itself went flat blue. (2) Real-mic recordings kept ending
in "No speech detected" with no way to tell whether the mic captured anything.

**Root cause (spinner).** `#voice-btn` carries `.hotkey-enabled`, whose hotkey
tooltip ALSO styles `::after` (`position:absolute; bottom:100%`, blue pill
background, hover opacity). The spinner rule only set the properties it needed,
so the tooltip's positioning/background bled through the cascade and the ring
ended up above the button. Fix: the processing `::after` now pins every
layout/visual property (absolute, top/left 50%, margin-centered — not
transform-centered, since the spin animation owns `transform`) and the
tooltip's `::before` arrow is suppressed during processing.

**Silent-recording diagnostics (`VoiceManager`).** A WebAudio analyser now
meters the live input during recording and tracks the peak level:
- peak < 1% → the upload is skipped and the action log states the capture was
  silent, naming the device ("🔇 ... from <label>. Pick a different input in
  Settings → Microphone, or check OS input volume/mute.")
- otherwise the peak is logged ("🎚️ Recording peak input level: N%") so a
  too-quiet mic is visible even when Whisper finds no words.
Uploads are also now named by their real container (`recording.webm`/`ogg`/...,
from the MediaRecorder mime type) instead of a fake `recording.wav`, so the
backend's temp-file suffix matches the actual bytes.

**How verified (live, Playwright + fake media device).** During processing the
`::after` computed style is absolute at top/left 13px with -7px margins (dead
center of the 30px button), transparent background, opacity 1, spinning
`processing-spin-circle`; `::before` is display:none; an element screenshot
shows the white ring inside the blue circular button. Action log for a 2.5s
fake-device recording: "🎙️ Using microphone: Fake Default Audio Input" →
"🎚️ Recording peak input level: 93%" → (tone, not speech) "No speech detected".

**Restart needed?** Yes.

---

## 2026-06-16 — Urgent messages actually send + queue control features

**Why urgent messages were silently vanishing.** Two independent defects, both
fixed:

1. **The control API dropped the `type` field.** `POST /queue/add {type:"urgent"}`
   was ignored — `HookServer.onQueueAdd` only forwarded `{terminalId, content}`,
   and the renderer's `queue-add-request` handler likewise omitted `type`. So an
   externally-queued message always inherited the UI's `selectedMessageType`
   (normal), never the caller's. Now `HookServer` validates the incoming `type`
   against the allowed set (`HookServer.normalizeQueueType`, mirroring
   `MessageQueueManager.VALID_TYPES = ['normal','urgent']`, default `normal`) and
   forwards it; the renderer reads `type` and passes it to `addMessage`. The
   canonical validator stays `MessageQueueManager.normalizeType`, which runs again
   in the renderer.

2. **Urgent didn't bypass the bare-shell guard.** A terminal SSH'd into a remote
   machine running Claude is detected *locally* as `runtime:'shell'` (no local
   `claude` process in `/proc`), so the injection gate's bare-shell guard ate
   urgent messages bound for that remote session. Per "urgent must send regardless
   of any condition," `evaluateInjectionGate` now lets `messageType === 'urgent'`
   bypass **every** gate — usage-limit, timer, paused, bare-shell, and the
   prompted-status gate. The ONLY remaining hard block for urgent is a missing
   target terminal (`terminalId == null` — nothing to inject into). Every gate is
   left fully intact for `normal`. The accepted trade-off: an urgent prompt could
   land in a genuine bare bash; that's acceptable because urgent is an explicit
   human/manager override. Tests in `injection-gate.test.js` were updated (normal-
   into-shell still blocked; urgent-into-shell now allowed) and extended (urgent
   overrides each gate individually and all at once; urgent still blocked with no
   target).

**Instant-send endpoint (force inject now).** New control route
`POST /queue/inject-now {messageId}` → `HookServer.CONTROL_ROUTES['/queue/inject-now']`
→ main forwards it → renderer's `handleControlRequest('queue-inject-now')` calls
`MessageQueueManager.injectMessageNow`, which types straight to the PTY via
`_injectToTerminal` and bypasses the pause/timer/usage-limit gate. A dedicated
per-message "Send now" button was added to each queue row (alongside the existing
"Send immediately" menu item).

**Retarget a queued message.** `POST /queue/update` now also accepts `terminalId`
to move a queued message to a different destination. `applyControlUpdate`
validates the target exists (`terminalStateManager.getTerminal`) before moving it,
so a typo'd id can't strand the message on a phantom terminal; combinable with
`content`/`type`. The queue menu gained "Move to <terminal>" options listing every
known terminal except the message's current one (and excluding the manager).

**Copy text out of a terminal pane (human UI).** Right-clicking a terminal now
shows a small context menu with "Copy selection" (xterm `getSelection`) and "Copy
visible buffer" (reads the viewport lines via `buffer.getLine`/`translateToString`),
writing to the clipboard via `navigator.clipboard`. Action-log feedback reports how
many chars were copied.

**Verification.** Pure-module unit tests: `injection-gate.test.js` (12) and the new
`HookServer.test.js` (3) all pass; the related `timer-expiry-resume`,
`usage-limit-resume`, and `pty-control` suites (20) still pass. `node --check`
clean on `renderer.js`, `MessageQueueManager.js`, `HookServer.js`.

**Restart needed?** Yes — changes touch the main process (`HookServer.js`) and
`renderer.js`, which only take effect after the Electron app is restarted. A human
must run it (a restart kills all terminals including the manager): `./start.sh`.

---

## 2026-06-16 — Manager role template updated to v4 (orchestrator doctrine)

**Why.** The manager's role doc (`MANAGER_CLAUDE_MD` in `src/main/manager-session.js`)
is the template stamped into every manager directory's `CLAUDE.md`. The manager rewrote
its own canonical doc at `/media/ethan/smalls/claude-manager/CLAUDE.md` (now versioned
`v4`) to make the manager a pure **engineering orchestrator** — it plans, delegates,
and reviews but does NO implementation itself.

**What changed.** The body of the `MANAGER_CLAUDE_MD` template literal now reproduces
that v4 source file verbatim (everything after the marker line), and `MANAGER_MD_VERSION`
was bumped `v3 → v4` so `ensureManagerClaudeMd` refreshes existing manager directories
on next boot instead of leaving a stale doc. The literal still begins with the
interpolated `${MANAGER_MD_MARKER}` (the `<!-- ccbot-manager-md:v4 -->` comment is
produced by interpolation, not hardcoded). The embedded markdown was escaped for the
template literal (backslashes doubled for the curl line-continuations, backticks
escaped; no `${...}` occur in the doc, and `$CCBOT_PORT`/`$CCBOT_TOKEN` need no
escaping as they have no brace).

**Most important new content preserved:** the section "## The One Hard Rule — You Do
NOT Touch Projects" — the manager makes no code changes ever, delegates everything
outside its own directory to terminals it stands up, and its sole role is keeping
those sessions unblocked and meeting acceptance criteria. The doc also documents the
new `/queue/inject-now` and `terminalId`-retarget endpoints shipped in the prior entry.

**How verified.** Generated the literal programmatically and confirmed the rendered
string is byte-for-byte identical to the source file (`rendered === source: true`).
`node -e "require('./src/main/manager-session.js')"` loads cleanly; `node --check`
passes.

**Restart needed?** Yes — `manager-session.js` runs in the main process, and the
refreshed doc is only written when the manager next boots, which happens on app start.

---

## Discord voice bridge — talk to the manager (999) from a Discord voice channel

**Date:** 2026-06-26. **Branch:** dev. **Scope:** new, fully self-contained
service under `discord-bridge/`. **Nothing in the running Electron app, the
manager PTY, or the backend was modified or restarted** — this is purely
additive and reaches the app only through the documented loopback control API.

**Goal.** Let the user join a Discord voice channel (e.g. from their phone, away
from the house), speak, and have that reach the manager terminal 999 as a framed
voice memo; the manager's spoken TTS replies play back into the same channel.

**What was built.** A standalone Node (CommonJS) process in `discord-bridge/`:
- `config.js` — loads `.env` + inherits `CCBOT_PORT`/`CCBOT_TOKEN` from the
  launching app terminal; validates; exposes the 🎙️ voice-memo marker.
- OUTPUT (manager → channel): `src/ttsPoller.js` polls
  `GET /api/tts/notifications/?after=<lastId>&limit=50`, **seeds `lastId` from
  the newest row on startup so history is never replayed**, downloads each new
  `audio_url` WAV, and hands it to `src/audioPlayer.js` (a FIFO
  `@discordjs/voice` player, ffmpeg-transcoded). Optionally marks `…/played/`.
- INPUT (channel → 999): `src/voiceReceive.js` captures each speaker's Opus via
  `VoiceReceiver` (silence-gap utterance segmentation + a min-duration gate to
  drop clicks), decodes to PCM (`prism-media`), wraps as WAV (`src/wav.js`),
  transcribes via the app's existing Whisper endpoint
  `POST /api/voice/transcribe/` (field `audio_file`), then delivers the text to
  terminal 999 via `POST /terminal/keys` (`src/controlApi.js`). That path has
  **no 999 block** (unlike `/queue/add`). The memo is framed with the literal
  marker the manager's CLAUDE.md watches for, and multi-line memos are wrapped in
  bracketed-paste (`ESC[200~ … ESC[201~`) + trailing Enter so they don't submit
  early in Claude's TUI.
- `src/dave.js` (DAVE presence check), `src/log.js` (stdout + optional mirror to
  the app's unified `[frontend]`/`[discord-bridge]` log stream), `src/doctor.js`
  (no-token preflight), `run.sh`, `README.md`, `SETUP.md`, and
  `python-receiver/README.md` (fallback notes).

**DAVE (mandatory E2EE voice since March 2026) — the load-bearing decision.**
Researched against primary sources. Pinned `@discordjs/voice@^0.19.2`
**on purpose**: PR #11449 (merged 2026-03-13, shipped 0.19.2) fixes the DAVE
voice-**receive** bug (RFC3550 padding not stripped → garbled/zero capture);
0.19.0/0.19.1 receive is broken. `@snazzah/davey` (0.1.12) auto-installs as a
hard dep of voice — no manual wiring; playback under DAVE is maintainer-confirmed
working. The Python path (`discord.py 2.7.1` + `discord-ext-voice-recv`) is NOT
viable as a drop-in: that extension doesn't decrypt DAVE (issue #53 open, fix
PR #54 unmerged), so Node is the only reliable receive path today.

**Double-audio note.** The in-app NotificationManager also plays each TTS clip.
Documented fix: toggle the app's mute button (`#notification-mute-btn`,
persisted `notificationsMuted`) — it silences only the local HTMLAudioElement;
the backend notification feed the bridge polls is unaffected. No restart, no
lost messages.

**How verified (without a live Discord token).**
- `npm install` clean (106 pkgs); all native deps load on Node 20
  (`@discordjs/voice`, `@discordjs/opus`, `sodium-native`, `prism-media`,
  `ffmpeg-static`, `@snazzah/davey` v0.1.12).
- `node src/doctor.js`: backend TTS endpoint reachable; control API `/state`
  reachable with manager 999 present (status running); CCBOT creds inherited.
- INPUT pieces (no keys sent to 999): framing + bracketed-paste keys array
  correct; `POST /api/voice/transcribe/` multipart round-trip returns HTTP 200
  on Node 20 (silence → empty text, as expected).
- OUTPUT data path: poller seed correctly skips history; rewinding lastId by 1
  downloads a real 1.19 MB WAV from the backend (backend state untouched —
  `markPlayed` stubbed in the test).
- `node --check` passes for every JS file; `bash -n run.sh` clean.

**Known runtime note.** `@discordjs/voice@0.19.2` declares `engines.node
>=22.12.0`. All modules load and the non-voice paths verify on the system's
Node 20; SETUP.md recommends Node 22+ for the live voice run.

**Still needed to go live (handed to user in SETUP.md):** a Discord bot token,
guild ID, and voice channel ID. Acceptance (bot joins channel; manager TTS plays
in; user speech reaches 999 as a framed memo; app never restarted) is verified
end-to-end only after the user provides the token.

**Restart needed?** No. The bridge is a separate process; the Electron app and
manager were never touched.

### Discord bridge enhancement — system-audio capture (hear EVERYTHING, not just TTS)

**Date:** 2026-06-26. **Branch:** dev. **Still uncommitted** (per user: nothing
commits until the live token test passes). Additive to `discord-bridge/`.

**Why.** TTS-notification polling only catches TTS clips, so a remote user would
miss system sound effects, chimes, and especially the morning **wake-up song**
(plays via mpv straight to the sink, not through the notification feed).

**What.** New `AUDIO_SOURCE` flag:
- `tts` (default) — existing behavior: poll the notification feed, play TTS only.
- `system` — capture the machine's audio OUTPUT (the default sink's `.monitor`)
  and stream it into the channel, so the remote user hears *everything* the
  speakers play. In this mode the TTS poller is **auto-disabled** (the monitor
  already contains the TTS audio → no double-play).

**Implementation.** `src/systemAudio.js`: `parec` captures
`<default-sink>.monitor` as 48kHz/stereo/s16le (Discord-ready `StreamType.Raw`),
fed to a new `VoicePlayer.playLive()` continuous resource. Because PipeWire
**suspends idle sinks** (verified: a suspended sink's monitor emits no data), a
silent **keepalive** (`pacat < /dev/zero` into the sink) keeps it warm so the
monitor is continuous. Both children auto-restart on exit; `stop()` kills both.
Device auto-resolves via `pactl get-default-sink` (override:
`SYSTEM_AUDIO_DEVICE`); socket from `PULSE_SERVER` (default `/run/user/<uid>/pulse/native`).
Config: `AUDIO_SOURCE`, `PULSE_SERVER`, `SYSTEM_AUDIO_DEVICE`,
`SYSTEM_AUDIO_KEEPALIVE`, `SYSTEM_AUDIO_WARMUP_MS`.

**Muting interaction (documented in SETUP.md).** Opposite rules per mode:
`tts` mode → MUTE in-app playback (bridge polls backend independently). `system`
mode → do NOT mute (audio must reach the sink to be captured).

**How verified (no Discord token needed).**
- Probed env: PipeWire 1.0.3 (PulseAudio compat), uid 1000, socket present,
  `parec`/`pacat`/`pactl` present, default sink monitor RUNNING.
- Proved the idle-suspend problem empirically: raw monitor capture yielded 0
  bytes when idle, ~2s only while a beep played.
- Proved the keepalive fix: warmed sink + low-latency parec → **4.98s of
  continuous PCM in a 5s window**.
- Module smoke test (`SystemAudioCapture` through real code): `onStream` fired,
  **3.27s continuous PCM in a 3.3s window** with no real audio playing; clean
  `stop()` left **no orphan parec/pacat processes**.
- `doctor.js` in system mode: all tool/socket/device checks green, monitor
  resolves to `alsa_output.pci-0000_11_00.6.analog-stereo.monitor`.
- All `node --check` pass.

**Still unverified (needs live token):** the captured stream actually arriving in
the Discord channel under DAVE, and the wake-up alarm being audible remotely —
both part of the live test.

### Discord bridge — major re-architecture: standalone service + rotatable session-key link + wake word

**Date:** 2026-06-26. **Branch:** dev. **Still uncommitted** (no commit until the
live token test). Reworks `discord-bridge/` from a terminal-bound TTS relay into a
persistent, linkable, wake-word voice assistant.

**1) Standalone persistent service.** The bot no longer depends on the
discord-bridge terminal or the Electron app's lifecycle. `service/install.sh`
installs a `systemd --user` unit (`ccbot-discord-bridge.service`, auto-restart,
optional `--boot` enable-linger), `uninstall.sh` removes it. The service holds
**no app credentials at rest** and idles until linked, so it survives the
auto-injector app restarting. (`systemd-analyze verify` clean after moving
`StartLimitIntervalSec`/`Burst` to `[Unit]`.) `nohup` fallback documented.

**2) Rotatable, local-only session-key linking.** The bot starts UNLINKED. The
manager (terminal 999, holds live `CCBOT_PORT`/`CCBOT_TOKEN`) runs
`npm run link-key` (`tools/make-link-key.js`): mints a random revocable
**link-token**, writes the real creds + token to a `0600` vault at
`$XDG_RUNTIME_DIR/ccbot-bridge/vault.json` (loopback/tmpfs), and prints a
paste-able `/link <key>`. **The pasted key carries only `{port, link-token}` —
never the control token** — so a key leaked through Discord is useless without
local machine access. The bot resolves the key against the vault locally
(`src/linkVault.js`), validates against the live control API `/state`, and holds
creds in memory only (`src/linkManager.js`). **Rotation** = re-run the tool → new
link-token overwrites the vault → old key stops resolving; the app token never
changes. Keys expire (default 1h, `--ttl`). This honors: rotatable, decoupled
from the raw token, local-only loopback, manager-generated, START-SESSION via
`/link`.

**3) Wake word + music-bot join.** `/link` (slash command) joins the voice
channel the **invoking user is currently in** (`interaction.member.voice` —
`DISCORD_VOICE_CHANNEL_ID` is now only an optional fallback). Then only speech
beginning with the wake phrase (default "hey claude") is forwarded; the phrase is
stripped, the remainder is the prompt; saying the phrase alone arms a short
follow-up window (`src/wakeWord.js`, `src/voiceReceive.js`). Slash commands:
`/link`, `/leave`, `/status` (`src/commands.js`); requires the
`applications.commands` invite scope.

**Wake-word implementation decision (honest).** The app uses Vosk via
vosk-browser (WASM, renderer). For this Node service there is **no working native
Vosk**: the `vosk` npm depends on `ffi-napi`, which fails to build on Node 20/22
(node-gyp error, reproduced), and there's no pure-JS Vosk. Chosen path:
**Whisper-text gating** — transcribe each utterance with the app's existing local
Whisper and forward only wake-prefixed ones. Same product intent, local-only, no
native build. Trade-off (documented): every utterance is transcribed locally to
check for the wake word. The spotter interface is small so a Vosk-backed
gate (e.g. a backend endpoint) can replace it later.

**4) System-audio output retained** (TTS + sound effects + wake-up alarm), now
started per-session by `src/session.js` on link.

**5) DM-call research (non-blocking).** Confirmed: no Discord bot DM-voice-call
API and no conversational-AI voice primitive exist in mid-2026; the Social SDK is
games-only. Guild voice channel + `@discordjs/voice` remains the only path. No
architecture change.

**How verified (no Discord token).**
- All modules `require` cleanly; `node --check` passes for every file; slash
  command defs build (`link, leave, status`).
- **Full link path tested against the LIVE control API** (this terminal has real
  `CCBOT_*`): minted a key → bot resolved + validated → manager 999 reachable
  (running) → linked ✅; **rotation** re-mint correctly invalidated the old key
  ("superseded"). (No keys sent to 999 — `forward()` not called.)
- Wake spotter unit tests 6/6 (including "hey cloud" mishearing, wake-alone,
  no-wake, mid-sentence wake).
- Service wiring smoke: with a fake token the process loads everything and fails
  ONLY at Discord login (`TokenInvalid`) — all wiring sound.
- `doctor.js` green: deps, DAVE v0.1.12, backend, audio tools/monitor (system
  mode), vault detection, live control API + manager presence.
- systemd unit renders + `systemd-analyze verify` clean.

**Still needs the token (live test):** Discord login, slash-command registration
in the guild, `/link` join-current-channel, DAVE voice-receive of "hey claude"
→ forward to 999, and audio playback (TTS + system audio incl. the wake-up alarm)
into the channel.

### Discord bridge — shared CPU wake-gate (stop pegging the GPU with constant Whisper)

**Date:** 2026-06-26. **Branch:** dev. **Uncommitted; built but NOT deployed**
(bot is off + backend not rebuilt — pending the user's thermal all-clear).

**Problem.** The bridge already used the backend's *shared* Whisper (no duplicate
model in VRAM), but it transcribed EVERY captured utterance to find the wake word
— and Whisper loads on `cuda` (RTX 3090), so constant channel chatter meant
constant GPU inference, contributing to a thermal emergency.

**Fix — gate on cheap CPU before the GPU.** Added a Vosk wake-word endpoint to the
backend and made the bridge gate through it:
- **Backend:** `backend/voice_transcription/wake_service.py` (`VoskWakeService`,
  CPU, lazy-loads the app's existing `vosk-model-small-en-us` — extracts the
  shipped tarball), new `POST /api/voice/wake-check/` view + URL, `vosk==0.3.45`
  in `requirements.txt`, and a `docker-compose.yml` change mounting
  `./assets/models:/models:ro` + `VOSK_MODEL_PATH`. Vosk is CPU-only — no GPU, no
  duplicate model (reuses the desktop app's model).
- **Bridge:** `src/wakeCheck.js` posts each utterance to the CPU Vosk endpoint;
  `src/voiceReceive.js` now gates on that transcript and only calls the GPU
  Whisper (`/api/voice/transcribe/`) AFTER the wake word fires (for an accurate
  command). Idle chatter = CPU Vosk only; GPU ≈ once per real command. Flags:
  `USE_SHARED_WAKE_GATE` (default on), `COMMAND_USE_WHISPER` (default on; off =
  zero-GPU, use the Vosk transcript as the command).

**Why not local Vosk in the bot.** Native `vosk` npm won't build on Node 20/22
(`ffi-napi`); `vosk-browser` (WASM) needs browser globals (`Worker`/`AudioContext`)
so it won't run headless in Node. Centralizing Vosk in the backend (CPU) is the
clean "share the resource" answer and reuses the model the app already ships.

**Net resources:** one Whisper (backend GPU, only on wake), one Vosk (backend
CPU, the gate), zero duplicates in the bot.

**Verified (no deploy):** bot `node --check` + require-smoke clean; backend
`python -m py_compile` clean for wake_service/views/urls; `docker compose config`
valid; live wake config still mirrors the app ("sean").

**To activate (when temps are safe):** `docker compose up -d --build` (rebuilds
ONLY the backend for the `vosk` dep + model mount; never touches the Electron
app), then bring the bot back (`systemctl --user enable --now ccbot-discord-bridge`)
and `/link`. Until rebuilt, the endpoint 404s and the bridge falls back to the
Whisper gate.

---

# Phase 2 audit-driven improvements (2026-07-06)

Prompted by a user-directed audit + improvement pass. Phase 1 was a read-only
audit (security, dead code, unwired code, feature inventory for both branches,
README + showcase plan) — the full report is saved to `PHASE1_AUDIT.md`. Phase 2
(this log) implements the approved fixes. HARD RULE throughout: never restart or
kill the LIVE app / control API / Discord bridge / terminal 999 — all running and
testing happens on an ISOLATED sandbox instance. Edits stay uncommitted for the
user to apply on their own restart.

## Workstream 1 — Isolated test interface (DONE, verified)

Stood up a fully self-contained sandbox so features/security/showcases can be
exercised without touching the live instance. Everything below is distinct from
live and was verified before/after launch (live `:8123` stayed healthy and up
6 days; live `~/.claude/settings.json` mtime unchanged).

- **`docker-compose.test.yml`** (new) — a STANDALONE isolated backend, not an
  override (compose appends `ports`, so an override would re-bind live's 8123
  and collide). Brought up as its own project: `docker compose -p ccbot-test -f
  docker-compose.test.yml up -d --wait`. Binds ONLY `127.0.0.1:8124`; own
  Postgres with its own project-scoped volume (`ccbot-test_ccbot-test-pgdata`);
  inline throwaway env (DEBUG on, no secrets). Live containers/volume untouched.
- **`src/utils/backend-url.js`** (new) — single source of truth for the Django
  backend base URL. Defaults to `http://localhost:8123` (live behaviour
  unchanged); honours `CCBOT_BACKEND_URL` (or `BACKEND_URL`) so a process can be
  pointed at the `:8124` sandbox. Fixes the audit's hardcoded-URL smell.
  Rewired the 8 hardcoded `http://localhost:8123` call sites to use it:
  `NotificationManager.js`, `WakeWordManager.js`, `ActionLogManager.js`,
  `VoiceManager.js` (transcribe + health), `renderer.js` (voice client + TTS
  voices fetch), and `manager-session.js` (the manager's CLAUDE.md TTS
  instructions now interpolate the backend URL, so the sandbox manager targets
  :8124 too). All files `node --check` clean; no stray `localhost:8123` left in
  app code (only a test fixture).
- **`.ccbot-test/`** (new, gitignored) — the sandbox harness:
  - `env.sh` — shared isolation env: `CCBOT_BACKEND_URL=:8124`, `HOME=`sandbox
    (isolates `~/.claude` hooks + manager session files), sandbox
    `CCBOT_LINK_VAULT` / `CCBOT_IMAGE_OUTBOX` / `CCBOT_MEDIA_INBOX`. Deliberately
    does NOT override `XDG_RUNTIME_DIR` so the PulseAudio socket still resolves.
  - `verify.js` — Playwright probe that launches the sandbox app and asserts
    every boundary distinct from live (backend :8124, sandbox HOME, sandbox
    vault, HookServer port != live, sandbox-only hooks). Result: all 6 checks
    PASS; sandbox HookServer bound 45225 (live is 43971).
  - `launch.sh` — visible launcher for driving features / recording, with an
    optional `--synth-mic` (per-process `PULSE_SOURCE`, never the global
    default).
  - `mic-setup.sh` — loads/unloads a PulseAudio virtual mic (null-sink +
    remap-source `ccbot_test_mic`) and plays a clip into it. ADDITIVE +
    REVERSIBLE; never runs `set-default-source`, so live's real wake mic is
    never hijacked.
  - `recordings/wake_sean.wav` — validated the TTS-synth-to-file path on :8124
    (`POST /api/tts/speak/ {"text":"sean"}` -> `GET /api/tts/audio/1/`), a 66 KB
    24 kHz WAV. This is the synthetic wake-word clip that lets the wake-word test
    and showcase self-trigger without a live human voice.
- **`.gitignore`** — added `.env.test` and `/.ccbot-test/` so sandbox artifacts
  and any test env never get committed.

**Wake word confirmed (not assumed):** the live persisted phrase is `"sean"`
(not "hey claude", which is only the code default), threshold `0.95`, silence
`4500ms` — corroborated by the existing `discord-bridge/config.js` note that
Vosk garbles the short name. Recorded in `PHASE1_AUDIT.md` §5.1 with the
synthetic-TTS driving design and the confidentiality note (use a neutral demo
phrase in the sandbox so the real wake name isn't shown).

## Decisions (user-approved)
- Test backend = DEDICATED `:8124` with the `CCBOT_BACKEND_URL` override (not
  sharing live :8123).
- SKIP provisioning a live test Discord bot; still implement + logic-test the
  Discord user allow-list security fix; user verifies the live Discord leg later.
- Remove the dead ADB tree (explanation to accompany the removal in Workstream 3).

## Workstream 2 — Security fixes (DONE, verified in sandbox)

Implements audit findings 1.1, 1.3, 1.5, 1.7 (PHASE1_AUDIT.md §1), plus the
threat-model notes for 1.2 and 1.6. Nothing here touches the live processes —
all runtime verification happened against the isolated `:8124` backend or pure
Node unit tests. All edited files pass `node --check` / `py_compile`.

- **1.1 (HIGH) Discord user allow-list — `discord-bridge/src/auth.js` (new) +
  `auth.test.js` (new, 4/4 pass).** `DISCORD_ALLOWED_USER_IDS` (comma-separated
  Discord user IDs) is now enforced at every entry point that can drive the
  manager:
  - every slash command incl. `/link` and `/prompt` (`commands.js` top of
    `handle()` — unauthorized users get an ephemeral deny that includes their
    own ID so they can allow themselves);
  - the `messageCreate` auto-forward (`index.js` — unauthorized posts are
    silently ignored);
  - **voice capture** (`voiceReceive.js`) — previously an unset
    `ALLOWED_SPEAKER_IDS` meant *every speaker in the channel* could wake-word
    the manager; it now falls back to the command allow-list, so speaking is
    gated exactly like typing. `ALLOWED_SPEAKER_IDS`, when set, still overrides.
  **DENY BY DEFAULT:** with the env unset, ALL commands/forwards are refused
  (the bot replies with the caller's ID + one-line setup instructions, and logs
  a loud startup warning). Documented in `.env.example` and SETUP.md.
  ⚠️ **User action on next bridge restart:** set
  `DISCORD_ALLOWED_USER_IDS=<your Discord user ID>` in `discord-bridge/.env`,
  or the (currently offline) bridge will refuse you too when it comes back.

- **1.3 (MEDIUM) Timing-safe HookServer token compare —
  `src/main/HookServer.js`.** The `x-ccbot-token` check now uses
  `crypto.timingSafeEqual` over equal-length buffers (length checked first —
  safe, token length is fixed) instead of `!==`, closing the timing side
  channel a co-resident local process could probe.

- **1.5 (LOW/MED) Outbox path containment — `discord-bridge/src/pathGuard.js`
  (new), wired into `imageOutbox.js`.** Descriptor `image`/`video` paths are
  resolved with `realpathSync` (defeats symlink escapes), must be regular
  files, and must live under an allowed root (the bridge runtime dir, the
  media inbox, the OS tmpdir, or `CCBOT_MEDIA_ROOTS` extras). Functionally
  tested: legit path ALLOWED; `/etc/passwd`, `../` traversal, and a symlink
  pointing at `/etc/passwd` all REFUSED.

- **1.7 (LOW) Frontend-log newline strip —
  `backend/frontend_control/views.py`.** `ts`/`level`/`message` are scrubbed
  of CR/LF and all C0 control chars before printing, so a crafted log entry
  can no longer forge fake `[frontend]` lines in the shared stdout timeline.
  **Verified live in the sandbox** (required rebuilding the sandbox backend
  image — the test compose bakes `./backend` at build time): a payload with
  embedded `\n[frontend] [error] FORGED` now prints as ONE flattened line.

- **1.2 threat-model note — `discord-bridge/SETUP.md`.** Documented that the
  control token is a full-control capability (`/terminal/keys` = raw
  keystrokes = command execution at a shell): token compromise ≈ host
  compromise; loopback + the 0600 vault are the boundary; rotate with
  `npm run link-key`.

- **1.6 guidance — `main.js`.** Comment at the `webPreferences` block: the
  renderer has full Node (no contextIsolation), so never load remote URLs and
  insert untrusted text only via `textContent`; contextIsolation + preload is
  the long-term fix. (No behavior change — deliberate, per audit: not directly
  exploitable today.)

Live instance checked before/after: `:8123` healthy, containers up, nothing
restarted.

## Workstream 3 — Dead-code removal (DONE)

Removed the audit's HIGH-confidence dead set (PHASE1_AUDIT.md §2): **39 files,
19,112 lines**, every one re-verified zero-referenced immediately before
deletion (grep across index.html, renderer.js, main.js, src/**, backend —
excluding node_modules/venv). The sandbox app was then booted via the
Playwright probe: renderer initializes, HookServer binds, all isolation checks
still PASS.

**The ADB story (user asked what the stray ADB call was).** `src/adb/` was a
complete, self-contained **Android Debug Bridge** integration: device
discovery, connection monitoring, and Android screenshot capture via
`adb shell screencap -p` (plus a demo UI and integration examples). It arrived
early in the project's life (commit `eeec9d2` "fixed missing dependencies"),
was clearly intended as a future "watch/control an Android device from the
grid" feature, but was **never wired** into main.js, renderer.js, or
index.html — no IPC handler, no script tag, nothing constructs it. It even
received a recent bug fix (commit `277de25`, binary screenshot corruption)
without ever becoming reachable. So the "stray ADB call" was the unreachable
`spawn(adb, ['shell','screencap','-p'])` inside this parked module — dead by
any runtime measure. Per the user's decision, the whole tree (incl. its test)
is now removed; it lives in git history if ever wanted again.

**Deleted directories:** `src/integration/` (error-recovery/orchestrator/
self-test framework, ~3.3k lines), `src/actions/` (action recording system,
~4k), `src/screenshot/` (screenshot engine, ~1.9k), `src/adb/` (above),
`src/terminal/` + `src/timer/` (superseded duplicates of the live
`src/core/terminal-manager.js` / `src/features/TimerManager.js`).

**Deleted files:** `src/core/ipc-handler.js` (IPC actually lives in
main.js/renderer.js); dead `src/utils/`: `dom-cache.js`, `dom-utils.js`,
`platform-utils.js`, `terminalUtils.js`, `timer-registry.js`, `uiUtils.js`;
the whole top-level `utils/` (`textExtraction.js` — required but all imports
unused; `api-client.js` — script-loaded, never instantiated, wrong port 8001;
`glowing-effect.js` — only consumer was the deleted timer-controller;
`completion-timer.js` — operated on DOM nodes nothing creates);
`backend/pricing/ccusage_simple_parser.py` (never imported);
`backend/terminal_backend/management/commands/runserver_8001.py` (backend
runs on 8123); `docs/images/main-interface.png` (unreferenced).

**Live-file edits that went with it:** index.html — dropped the three dead
`<script>` tags (`glowing-effect`, `api-client`, `completion-timer`);
renderer.js — dropped the unused `textExtraction` require; StatusManager —
unused `BoundedSet` import; UsageLimitManager — unused `ipcRenderer` import;
MessageQueueManager — stale comment pointing at ipc-handler.js; TimerManager —
removed the dead third constructor param + three `if (this.backendAPIClient)`
branches that could never run (renderer constructs it with 2 args; the class
does its glow via CSS). All edited files `node --check` clean; a repo-wide
sweep confirms zero dangling references to any deleted path.

**CSS pass (delegated subagent, verified):** 261 dead blocks removed — 253
rule blocks + 8 orphaned `@keyframes` — covering 111 verified-dead class/id
names; `style.css` went 6,321 → 4,441 lines. Every removal was grep-verified
against index.html + all live JS first. Audit candidates that turned out LIVE
were kept: `.history-item(-content/-meta)`, `.image-preview-container/-list`,
the live `.timer-*` set, `.todo-content`, `.todo-search`,
`.color-picker-title/-modal`, `.manager-setup(-text/-row)`,
`.message-edit-input`. Braces verified balanced (664/664); no empty @media
blocks left.

**Kept (deliberately):** `bin/manage.py` (venv-flow convenience, audit-MEDIUM,
not in the approved HIGH set); `assets/icons/icon.iconset/` (build input);
all soundeffects (dynamically enumerated); `.xterm-search-decorations` /
`.search-highlight` CSS (runtime-injected by the xterm search addon).

## Workstream 4 — Wiring fixes: built-but-disconnected code (DONE, probe-verified)

Implements PHASE1_AUDIT.md §3. Every item below was verified live in the
sandbox app: a Playwright probe launched the isolated instance and asserted
17/17 checks PASS (controls exist, state mirrors load, events land, overlay
toggles, chips render). Live app untouched.

**Event-name mismatches (silent feature outages, one-line fixes):**
- `StatusManager` now subscribes to `message:injection-started` /
  `message:injection-completed` (the names MQM actually emits) — the
  'injecting' status pill and the post-injection rescan fire again for the
  first time. Also `terminal:closed` (the event the close path emits) instead
  of the never-emitted `terminal:removed` — per-terminal status entries no
  longer leak on close.
- `SoundManager` gained the missing generic `sound:play` handler — the
  timer-expiry alarm (`TimerManager` emits `sound:play {type:'timer-expired'}`)
  is audible for the first time.
- The timer inline-edit path now emits `timer:manual-change`, so
  `UsageLimitManager` stops auto-syncing the timer when the user takes manual
  control (previously subscribed but never fired).

**IPC gaps:**
- `terminal-error` (PTY spawn failure after all retries) now has a renderer
  listener: logs the error to the Action Log and marks the terminal `error`.
  Previously silently dropped.
- Tray menu "Start/Stop Injection" now works — listeners drive the master
  send switch (`toggleSending`), same as the queue-header button.
- Renderer→main bridges added for MQM's emitted-but-unheard events:
  `ui:tray-badge` → `update-tray-badge`, `ui:system-notification` →
  `show-notification`, `power:save-blocker:start/stop` →
  `start/stop-power-save-blocker`. All four main-process handlers existed;
  nothing invoked them.

**Settings that existed in code but the user could never change (new UI):**
- Settings modal, manager group: "Manager answers permission prompts"
  (`managerPromptWatchEnabled`), "Recurring optimization passes"
  (`managerAutoPassEnabled`), "Pass interval" slider
  (`managerPassIntervalMinutes`, 15–240m). All three were read-only keys
  documented in CLAUDE.md but editable only by hand-editing the store file.
- "Keep screen awake while injecting" (`keepScreenAwake`) — routed through
  PreferenceManager so MQM picks it up live; un-deads the power-save-blocker
  path end to end (setting → gate → IPC bridge → Electron blocker).
- "Terminal Scroll Behavior" select wired (`smart` = xterm native follow;
  `always` = force scroll on every output). The unimplementable "preserve"
  option was dropped from the markup rather than shipped as a lie.
- Prompted-sound "Keywords Only" checkbox un-commented and wired
  (`promptedSoundKeywordsOnly` → SoundManager, which already read it).

**File attach + search (dead DOM, now functional):**
- The whole file-attach cluster works: drag-drop onto the input area (with
  the drop overlay), paste-image into the message box (saved to disk via the
  existing `save-screenshot` IPC), and the hidden `#file-input`. Attachments
  render as removable chips in the previously-invisible preview strip and are
  appended to the message as absolute paths (PTY injection is text-only).
  New minimal `.attachment-chip` CSS.
- Per-terminal search overlay bound to the always-loaded xterm SearchAddon:
  incremental find, Enter/Shift+Enter, prev/next buttons, n/m match counter
  (via `onDidChangeResults` + decorations), Escape/× to close. Dynamic
  terminals build their own overlay (only terminal 1 shipped one). Shortcut:
  Cmd+F (mac) / Ctrl+Shift+F (bare Ctrl+F would shadow readline's
  forward-char).
- App teardown wired: `beforeunload` → `gui.cleanup()`, which now also stops
  the TTS notification poller (`NotificationManager.stopPolling()` — defined
  but never called).

**Wire-vs-delete decisions executed:**
- **InjectionManager deleted** (`src/messaging/injection-manager.js`, 521
  lines + renderer construction + the gui compatibility shims it alone
  consumed). It was constructed but never initialized, and MQM's only
  delegation call hit a method it didn't have (`scheduleNextInjection`) —
  the audit's "wedged lock" bug. MQM now always uses its own scheduler.
- **MQM legacy sequential-engine remnants deleted:** the five
  `injection:start/pause/resume/cancel/manual` subscriptions (events nothing
  emits) and their only-reachable-that-way methods, plus zero-call-site
  methods `injectSpecificMessage`, `validateMessageIds`,
  `setTerminalForNextMessage`, `queueContinueMessage`. The live
  `startSequentialInjection`/`maybeAutoInject` paths are untouched.
- **PreferenceManager dead keys deleted** (18 written-but-never-read defaults:
  autoScroll, smoothScroll, alwaysTargetPromptedTerminal, autoStart,
  showTerminalSelector, autoCompleteTodoEnabled, generateTodoOnCompletion,
  typewriterEffectEnabled, typewriterSpeed, microwaveInterval,
  startInBackground, enablePowerSaveBlocker, showInDock, trayBarTheme,
  completionBehavior, backgroundServiceEnabled, verticalLayout + the
  never-called methods setTheme, setVerticalLayout, registerChangeHandler/
  notifyChangeHandlers, exportPreferences/importPreferences, updatePref).
  `voiceEnabled` and `notificationsMuted` were audit-listed but turned out
  read — kept. Added `keepScreenAwake: false` (now genuinely consumed).
- **`LinkManager.linkFromVault()` fixed** — it called an undefined
  `resolveLatest()` (guaranteed ReferenceError). Implemented
  `linkVault.resolveLatest()` (reads the 0600 vault directly — local-trust
  shortcut, no pasted key) with the same expiry checks; unit-tested
  write→resolve roundtrip. The voice auto-join *trigger* is deliberately NOT
  wired (needs the live Discord leg the user will verify later).
- Bridge cleanups: dead `useBracketedPaste` config knob removed and the
  `controlApi.js` comment fixed (memos are single-line collapsed; no
  bracketed-paste write ever existed); superseded `mediaInbox.composeForward`
  export removed (real path is `linkManager.forward` → `frameMemo`).
- **Backend `/api/ccusage/` removed** along with the whole unrouted
  `pricing/views.py` + `pricing/urls.py` (the DRF router was removed long ago;
  ccusage really runs on the HOST via IPC since the container has no Node —
  the endpoint could only ever 503). Pricing models/migrations kept. Sandbox
  backend rebuilt: health 200, `/api/ccusage/` now 404.

**Left alone (deliberate):** `StatusManager`'s deprecated output-parsing
methods (marked for the hook-migration cleanup, do-not-rewire);
`UIFocusManager` (dormant; its hotkeys were reimplemented directly in
renderer.js long ago); `resumeStore.forget` (plausibly-intentional API);
`/api/voice/list|clear/`, `/api/tts/health/` (harmless surface, may get a
history panel later); main.js's registered-but-unused IPC handlers (several
are now consumed by the new bridges; the db-* family backs live settings).

## Workstream 5 — README rewrite + metadata cleanup (DONE)

- **`README.md` rewritten** (47 → ~150 lines). The old version described ~40%
  of the app ("message queue + terminal grid"); the new one covers what
  actually defines it: grouped features (Terminals & queueing / The Manager /
  Voice / Tracking), a "How it works" section (hooks-not-parsing, the
  HookServer + control API, the three processes), install for all three modes
  (Docker default / --venv / frontend-only, incl. the first-run Vosk model
  download and the espeak-ng note), configuration highlights, and a
  clearly-scoped "Discord voice bridge (discord-integration branch)" section
  that links to the bridge's own docs instead of duplicating them. Voice is
  no longer mislabeled "experimental". Acknowledgments now credit Vosk and
  Kokoro. The main-branch content stands alone; the Discord section is
  explicitly branch-scoped — so the README serves BOTH branches.
- **`package.json`** — replaced placeholder author ("Auto-Injector
  <auto-injector@example.com>") with streylix, stale description with the
  real pitch, and generic keywords with claude-code/voice/electron ones.
- **`start.sh`** — removed the dead legacy Python Discord bot launcher
  (`.bot-config` / `discord_bot.py` / `run_bot.sh`, ~38 lines) that predates
  and is unrelated to `discord-bridge/`; left a pointer comment. The current
  bridge is a systemd service that start.sh deliberately does not manage.
  `bash -n` + JSON-parse validated.

## Workstream 6 — Self-recording showcase GIFs (DONE)

Produced three Loom-style showcase GIFs, all recorded against the ISOLATED
sandbox (backend :8124, sandbox HOME, `--user-data-dir` under `.ccbot-test/`)
on a throwaway Xvfb display `:99` — the live app, its display, the live
backend, and the live Discord bridge were never touched (verified before/after:
live :8123 = 200, bridge = active, live `~/.claude/settings.json` mtime
unchanged at Jul 1). Committed to `docs/showcase/` and referenced from the new
README's "In action" section.

**Clean demo profile** (`.ccbot-test/`): sandbox `~/.claude` (own credentials
copied 0600, own `.claude.json` with onboarding done + the demo dirs
pre-trusted so no trust dialog blocks the capture), two dummy projects
(`demo-projects/demo-blog`, `todo-cli`), a scratch manager dir with a fake
`routines/demo-routine.md`, and a NEUTRAL demo wake word ("hey claude", NOT the
real personal wake word) so nothing private is shown. Sandbox TTS
(`POST /api/tts/speak/` on :8124) synthesized the spoken clips
(`wake_heyclaude.wav`, `wake_command.wav`, `voice_command.wav`); the sandbox
notification rows were then wiped so history starts clean.

**Synthetic-mic driving** (fully hands-off, no live human voice): a PulseAudio
null-sink + remap-source (`ccbot_test_mic`) loaded ADDITIVELY — never
`set-default-source`, so the live wake mic could not be hijacked. The sandbox
Electron got the virtual mic per-process via `PULSE_SOURCE`; clips were played
into the sink on cue. Loaded for the recordings, unloaded after.

**The three takes** (Playwright drives the UI, ffmpeg x11grab records, two-pass
palette GIF, cropped to the app window for privacy):
- **`manager.gif`** (43s) — open the Manager view, target the manager in the
  selector, type "check state + queue a summary task to terminal 1"; the real
  manager Claude session reads the control API, reports the fleet state, queues
  the message to terminal 1, and terminal 1 answers "This is Auto-Injector…".
  The full steer-the-fleet loop, captured live.
- **`wake-word.gif`** (28s) — the Wake Word settings section, then the
  synthetic "hey claude" fires the detector (logged: matched similarity 1.00 ≥
  strictness 0.75), the command is captured + Whisper-transcribed + forwarded
  to the manager as an urgent voice memo — all while the window shows the grid.
- **`voice-mode.gif`** (20s) — click the mic, play the synthetic command, stop;
  the Action Log shows the Whisper pipeline and "Add input validation to the
  signup form." lands in the message input, then queues.

**Objective wake-word validation:** before recording, a headless dry run
asserted the pipeline end to end — the synthetic clip drove
`wake:state` listening → capturing → transcribing and produced the queued memo.
Whisper transcribed the clean synthetic speech at 0.97 confidence. So "does the
synth clip trigger?" is answered YES at the demo settings (neutral phrase,
0.75 strictness); the real-box caveat (short name "sean" @ 0.95) is avoided by
using the neutral demo phrase, exactly as the plan intended.

**Notes / caveats for the user:**
- The GIFs show `ethan@pop-os` and `/media/ethan/…` sandbox paths in the shell
  prompt — fine for your own/internal use; for a fully public showcase, record
  under a throwaway OS account (per PHASE1_AUDIT §5). Nothing else sensitive is
  in frame (sandbox `~/.claude`, so no Pager key; neutral wake word; wiped
  history).
- Harmless pre-existing log noise seen during capture:
  `PreferenceManager.loadMessageQueue` logs "Unexpected end of JSON input" when
  the persisted `messageQueue` setting is an empty string. Not introduced here
  and not worth a fix mid-audit, but noting it — a one-line guard
  (`if (savedQueue)` already exists; the empty-string case slips through) would
  silence it.

## SSH View — read-only remote mirror of the interface (ssh-view branch)

Added a read-only way to watch the whole Auto-Injector interface from an SSH
session, so a headless machine (no monitor) running the app can still be observed
live.

- New CLI `npm run ssh-view` (`scripts/ssh-view.js`): a terminal UI that lists
  every terminal (id, title, runtime/status) from `GET /state` and shows the
  selected terminal's live screen from `POST /terminal/screen`, auto-refreshing
  about every 1.5s. Arrow/j-k keys and number keys switch terminals; the manager
  (terminal 999) is always shown; `g` toggles a condensed grid of all terminals;
  `s` toggles scrollback; `q`/Ctrl-C quits. It is read-only by construction — it
  only ever calls those two non-mutating endpoints and never queues, injects,
  creates, deletes, or steers. Built on Node built-ins only (no new dependencies).
- Auth/discovery: an SSH login shell does not inherit the app's CCBOT_PORT/
  CCBOT_TOKEN, so on startup the app now writes a `0600` session file at
  `~/.config/ccbot/session.json` (via `src/main/session-file.js`) containing the
  loopback port + token; `ssh-view` reads it. `--port`/`--token` flags and the
  CCBOT_* env vars override it. The file is removed on clean shutdown. The token
  is only ever sent to 127.0.0.1.
- Resilient: if the Control API is unreachable it shows a "waiting for app…"
  screen and keeps retrying (re-resolving the port/token each time), never
  crashing.
- Docs: `docs/SSH_VIEW.md`. Files touched: `main.js` (write/remove the session
  file around the hook-server lifecycle), `package.json` (script), `.gitignore`
  (un-ignore the new script).

## 2026-07-14 — Remote Mode client: top-middle ssh command bar + AUTO-START of the remote (branch `ssh-view`)

Reworked the Remote Mode CLIENT connect flow (docs/REMOTE_MODE.md §8) so that
connecting to another machine is one typed ssh command — and works even when
the remote app is not running or not serving Remote Mode.

- **Command bar (primary connect input).** Clicking the bottom-left corner
  indicator now opens a command bar at the TOP-MIDDLE of the interface. The
  user types the actual ssh command as real, editable text — `ssh
  ethan@pop-os`, `ssh host -p 2222`, `user@host`, `-p`/`-l`/`-i` in any
  position, `ssh://user@host:port` — parsed by the new pure module
  `src/features/ssh-command-parse.js` (unit-tested); unknown ssh flags merge
  into the Advanced ssh options and everything is re-validated against
  remote-client's strict charsets. The most recent command pre-fills as
  editable text; recents are one click. Advanced… folds out with the session
  file path, extra ssh options, and a new "remote app directory" field. The
  old host/port/user form is gone; the bottom-left panel is now purely the
  connected-state management popover (info + Disconnect).
- **Auto-start Remote Mode on the remote.** On Connect the client reads the
  remote session file over SSH and handles all three states instead of
  erroring: (1) Remote Mode on → connect as before; (2) app running with
  Remote Mode OFF → the new `scripts/remote-autostart.js` runs on the remote
  (over the same SSH channel, under ELECTRON_RUN_AS_NODE on the app's own
  Electron binary — no `node`-on-PATH assumption) and POSTs the new
  loopback Control API route `POST /remote/enable`, which starts the
  RemoteServer LIVE with no restart (main.js `startRemoteMode()` is now
  shared by boot + runtime enable; the renderer bundle is esbuilt on demand
  if missing; `remoteServerEnabled` is persisted; session.json is rewritten
  with the remote port); (3) app NOT running → the same script cold-starts it
  headless + detached with CCBOT_REMOTE=1 (`xvfb-run -a` + `--no-sandbox` on
  display-less Linux; direct launch on macOS) and polls for a fresh
  session.json (45 s). Discovery of where the app lives on a stopped machine:
  the app now writes a persistent, sh-sourceable `~/.config/ccbot/app-root`
  file (app dir + Electron binary path; paths only, no secrets; 0600; NOT
  removed on shutdown) via session-file.js. Every phase is narrated in the
  command bar status line; every failure mode has a specific message (app
  never ran there → set the app dir; dir gone; checkout too old; no
  node/electron; xvfb missing; start timeout with remote log tail; stale
  token; plus the existing ssh auth/host-key/unreachable classes) and the
  whole ensure step has a 90 s hard kill — nothing silently hangs. Security
  posture unchanged: BatchMode (no passwords), loopback-only everywhere, the
  token never leaves the remote (the enable POST happens on the remote
  itself against 127.0.0.1).
- **Verified end-to-end headless** (`xvfb-run -a node
  tests/integration/remote-client-e2e.js`, work dir on a POSIX fs under tmp
  because the repo drive is FUSE/NTFS and sshd rejects world-readable host
  keys): real sshd + isolated XDG_CONFIG_HOMEs; command bar proven at the
  top-middle with real editable text; clear errors for an unreachable host
  and for a remote with no recorded app; remote app running WITHOUT Remote
  Mode → Connect live-enabled it (session.json gained remote.port with the
  SAME pid — no restart) and a typed marker echoed in both the embedded view
  and the remote's own xterm; app CLOSED → Connect cold-started it (fresh
  session.json, NEW live pid spawned by the client's action) and the
  embedded terminal echoed; reconnect fast path showed no enable/start phase
  and the same pid; disconnect closed the forwarded port with no ssh -L
  child left. Unit suite: 153 tests, 152 pass — the one failure
  (`tests/unit/usage-limit-and-gate.test.js`) is a pre-existing, untracked
  (gitignored) local file unrelated to this work.
- Files: `src/features/ssh-command-parse.js` (+`.test.js`),
  `src/features/RemoteConnectionUI.js`, `index.html`, `style.css`,
  `scripts/remote-autostart.js`, `src/main/remote-client.js` (+`.test.js`),
  `src/main/session-file.js`, `src/main/HookServer.js`, `main.js`,
  `tests/integration/remote-client-e2e.js`, `docs/REMOTE_MODE.md`,
  `.gitignore`.

## 2026-07-14 — Remote Mode: CLIENT MICROPHONE FORWARDING — full remote voice, desktop-processed (branch `ssh-view`)

The INPUT mirror of the §9 voice-output forwarding (docs/REMOTE_MODE.md §10).
A user viewing the interface remotely (browser tab / embedded client iframe)
can now TALK to the manager: their device's microphone is captured locally and
streamed to the desktop, where the EXISTING voice pipeline — Vosk wake-word
spotting and Whisper transcription, both unchanged and both on the desktop —
processes it. Combined with §9's output forwarding the loop is fully remote:
say "hey claude …" into the laptop, the desktop detects + transcribes + routes
the memo to the manager (999), and the answer plays back on the laptop.

- **Client capture** (`src/remote/remote-mic.js`, served + injected by
  `RemoteServer` for browser clients only): floating mic toggle button →
  `getUserMedia` → AudioWorklet tap (ScriptProcessor fallback) → 16 kHz mono
  PCM16 in ~85 ms frames (matching the desktop's own frame cadence so the VAD
  tuning holds) → `remote-mic-frame`/`remote-mic-state` frames over the SAME
  authenticated WebSocket. ~32 KB/s; no new ports, no new auth surface.
  Permission denial and disconnects are handled; the button mirrors the
  desktop pipeline state (listening/capturing/transcribing) via
  `remote-wake-state` pushes and plays the configured activation/stop chimes
  on the viewing device.
- **Single-owner rule + relay** (`src/main/RemoteServer.js`, `main.js`): at
  most one client streams at a time (first-come; later starters get
  `remote-mic-denied`; owner disconnect dispatches a synthetic detach so the
  pipeline never hangs). Main relays the owner's frames to the LOCAL renderer
  only — never re-broadcast to other viewers.
- **Desktop routing** (`src/features/RemoteMicSink.js` + a remote-source mode
  in `src/features/WakeWordManager.js`): frames feed the SAME recognizer, VAD,
  capture, Whisper POST (`/api/voice/transcribe/`) and voice-memo framing as
  local mic audio. Which-mic rule (mirror of §9's no-double-play rule): while
  a remote mic streams, IT is the input and the local mic is ignored; with the
  local wake word off (or a mic-less headless host) the pipeline runs in
  REMOTE-ONLY mode — no local `getUserMedia` is ever opened; with no remote
  client attached, local behavior is byte-identical to before.
- **Verified end-to-end headless** (`xvfb-run -a node
  tests/integration/remote-mic-e2e.js`): isolated XDG_CONFIG_HOME, stand-in
  Django-shaped Whisper endpoint (full faster-whisper impractical in-sandbox;
  the audio still flows the real app path and the stand-in byte-compares it).
  Proven: real fake-device getUserMedia+worklet capture delivers frames
  BYTE-FAITHFULLY (client vs server rolling hash over the identical Int16
  stream); canned SYNTHESIZED SPEECH (piper, committed as
  tests/fixtures/*.wav) injected through the same send path is detected by
  the desktop's REAL Vosk engine ("hey claude" → capturing); the VAD stops
  the capture; the POSTed 16 kHz WAV CONTAINS the injected utterance
  byte-for-byte; the known transcript comes back and lands in the manager
  queue (999, urgent, verbatim voice-memo framing); a second client is
  denied; disconnect releases the mic and the pipeline returns to idle.
  Unit tests: `src/features/WakeWordManager.remote-source.test.js`,
  `src/main/RemoteServer.mic.test.js` (suite: 174/175 pass; the one failure
  is the pre-existing untracked `tests/unit/usage-limit-and-gate.test.js`).
- Files: `src/remote/remote-mic.js`, `src/features/RemoteMicSink.js`,
  `src/features/WakeWordManager.js`, `src/main/RemoteServer.js` (+
  `RemoteServer.mic.test.js`), `main.js`, `renderer.js`,
  `tests/integration/remote-mic-e2e.js`, `tests/fixtures/hey-claude-16k.wav`,
  `tests/fixtures/command-16k.wav`, `.gitignore`, `docs/REMOTE_MODE.md`.

## 2026-07-24 — Manager monitoring: stuck-terminal watchdog + completion-push dedup (CODE READY, NOT YET APPLIED — needs app restart)

Two token-efficiency/reliability fixes for manager (999) monitoring, greenlit
from the monitoring diagnosis. **The running app has NOT been restarted** — a
restart kills every PTY (all workers AND the manager, per the `before-quit`
cleanup in main.js), and T11 is mid-flight; the manager will coordinate the
restart window.

- **Stuck-terminal watchdog** (`src/features/StuckWatchManager.js`, NEW): a
  30s renderer-side sweep that pushes ONE compact line to 999 (e.g.
  `T3 ("api") appears stuck: prompted 6m`) when a terminal needs attention
  but will never fire a completion: prompted > 5 min (menu or not — covers
  the no-menu idle-prompt gap PromptWatch deliberately suppresses), running
  with no PTY output > 4 min (silent hang), or a queued message held by the
  injection gate > 5 min (includes the gate's reason string). Fed entirely
  from existing bus events (`terminal:status:changed`, `terminal:data`) — no
  new plumbing. De-dupes per stuck-episode (a cleared condition resets it; a
  NEW condition joining re-notifies with both facts). Thresholds are
  constants at the top of the file; opt-out via the
  `managerStuckWatchEnabled` setting (default on). Wired in `renderer.js`
  beside PromptWatchManager.
- **Completion-push dedup** (`src/features/ManagerInstance.js`): per-terminal
  last-pushed-text memory; a re-push identical to the previous one from the
  same terminal is dropped — this kills the 3-4x stale-duplicate flood caused
  by `readLastAssistantText` walking back past tool-only turns. Pushes whose
  text is only a `[tool_use: …]` marker are skipped outright. Only
  consecutive duplicates dedup (A, B, A still pushes all three).
- TDD: `src/features/StuckWatchManager.test.js` (15 tests) +
  `src/features/ManagerInstance.dedup.test.js` (7 tests), red first, then
  green; full suite `node --test src/features/ src/main/` = 184/184 pass.
- Files: `src/features/StuckWatchManager.js` (+ test),
  `src/features/ManagerInstance.js` (+ dedup test), `renderer.js`.

## 2026-08-07 — Manager nightly `/clear` (daily context reset at local midnight)

**Why.** The manager (999) is a long-lived session that accumulates context all
day — completion pushes from every terminal, prompt-watch notes, stuck-watch
notes. It now clears itself once a night so each day starts lean, instead of the
operator remembering to do it by hand.

- **Scheduler** (`src/features/ManagerInstance.js`, sibling to the pass loop):
  `startNightlyClear()` / `stopNightlyClear()` / `_armNightlyClear()` /
  `dispatchNightlyClear()`. At the configured hour (default 0 = local midnight)
  it enqueues the literal message `/clear` to terminal 999.
- **Mechanism: the queue, not a direct PTY write.** The clear goes through the
  same `dispatch()` → `messageQueueManager.addMessage()` path the old
  `dispatchPass()` used. That matters because the queue's injection gate only
  injects when the target terminal is idle: a clear armed for midnight lands at
  the first idle moment at-or-after midnight and can never truncate a turn the
  manager is in the middle of. Writing `/clear\r` straight to the PTY via
  `pty-control` would mean reimplementing that idle check here and would still
  race a turn that starts between the check and the write.
- **Midnight alignment via self-rescheduling `setTimeout`, not a 24h
  `setInterval`.** Each night it recomputes the ms until the next local
  hour:00 using the existing cross-midnight builder
  `resetTime24ToDate()` from `src/utils/usage-limit-parser.js` (constructs
  hour:00 on today's local calendar date, rolls to tomorrow if already past).
  Recomputing the wall-clock target rather than adding a fixed 86,400,000 ms is
  what keeps it pinned to 00:00 across DST — on a 23- or 25-hour day the next
  delay is simply shorter or longer. When re-arming immediately after a fire it
  looks ahead from now+60s, so a timer landing a hair early cannot re-target the
  midnight that just passed and clear twice for one night.
- **A confirming Enter after the injected `/clear`.** Claude Code pops its
  slash-command palette as `/clear` is typed; if that palette is still open when
  the injector's Enter (sent 150ms after the text) lands, the Enter is consumed
  accepting the highlighted entry and the command sits unsent in the input box.
  `onMessageInjected()` follows the manager's own `/clear` with one more Enter
  ~900ms later. Both paths converge: if `/clear` already ran, the extra Enter
  hits an empty prompt and does nothing; if the palette ate the first one, this
  submits it. Scoped by terminal id AND content, so ordinary injection is
  untouched.
- **Settings, safe defaults.** `managerNightlyClearEnabled` (default ON — only
  an explicit `false` disables) and `managerNightlyClearHour` (default 0,
  out-of-range values fall back to 0), read the same way
  `managerPassIntervalMinutes` was: `appStateStore.getState()` first, then
  `ipc.invoke('db-get-setting', …)`. No settings-panel UI was added; set them
  with `db-set-setting` if the default midnight isn't wanted.
- **Lifecycle / double-arm guard.** Armed in `start()` (right after the
  now-permanently-disabled `stopPassLoop()` call, and after the Remote Mode
  early-return, so only the local renderer that owns the manager schedules a
  clear — a browser viewer must not also fire one into the shared session).
  Cancelled in `stop()`. `startNightlyClear()` calls `stopNightlyClear()` first,
  so re-entry never leaves two timers running. `dispatchNightlyClear()` also
  skips if a `/clear` is still sitting in 999's queue.
- **Tests**: `src/features/ManagerInstance.nightlyClear.test.js` (16 tests,
  mirrors the dedup test's fake-bus/gui style) — next-fire lands on the upcoming
  local midnight, stays on 00:00 across a full year of dates (a fixed-24h
  scheduler would drift on the DST day), fires → enqueues `/clear` to 999,
  re-arms for the FOLLOWING midnight, don't-stack guard, disabled-setting
  respected, out-of-range hour clamped, confirming Enter fires only for the
  manager's own `/clear`. Full suite `node --test src/features/ src/main/
  src/messaging/ src/utils/` = **215/215 pass**.
- **Activation**: takes effect on the next app restart (the scheduler is armed
  in `ManagerInstance.start()`). Not restarted as part of this change — a
  restart also restarts the manager.
- Files: `src/features/ManagerInstance.js`,
  `src/features/ManagerInstance.nightlyClear.test.js` (new).
## Moonlight card: the keyboard only goes to the game when you ask for it

- Problem: starting a stream made the whole app impossible to type in. The card
  grabbed focus the moment the first video frame arrived, and its key handler
  calls `preventDefault()` on every key it recognises — so the terminals and the
  message box silently stopped receiving anything. It persisted after closing
  the games panel, because the handler only checked whether a stream was
  running, not whether the card was even on screen.
- Why it was missed: the keyboard had been "verified" with synthetic
  `dispatchEvent` and by calling the send path directly. Both bypass focus
  entirely, so they proved the wire format and nothing about whether a real
  keystroke ever arrives. Every check below was done by actually typing.
- Fix: an explicit `streamKeyboardActive` flag, false by default and never set
  by the app itself. Only a pointerdown on the video turns it on. It goes off
  when focus leaves the card, when the panel closes (the bridge forwards
  `games:panel-closed`, since a closed panel only goes `inert` and the iframe
  never hears about it), when the stream stops, and on Cmd/Ctrl+Escape. The key
  handler returns early unless the flag is set AND the panel is visible AND a
  stream is running — otherwise the event is not touched at all, so the rest of
  the app behaves as though the card did not exist.
- One subtlety worth keeping: the click handler calls `preventDefault()`, which
  also suppresses the browser's focus move. Focus is therefore taken explicitly
  in the pointerdown handler. Without that, whether keys reached the game
  depended on whatever else had happened to focus the frame — it worked
  intermittently, which is worse than never working.
- Also removed: pointer lock, which could never have worked here. A `file://`
  document inside a `file://` root has an opaque origin and Chromium refuses it
  with "WrongDocumentError: The root document of this element is not valid for
  pointer lock." That is also why Escape used to yank the mouse — the browser
  steals Escape only to break out of a lock. With no lock, Escape reaches the
  game like any other key, which is what a game menu needs. The cost is
  relative-motion aim; the "Capture the mouse" setting is disabled rather than
  removed so it does not read as a toggle that does nothing.
- Verified by typing, not by inspection: stream running but unclicked → app
  typing normal; click the picture → W/arrows/Enter/Escape reach the game;
  click back to the app mid-stream → typing returns; close the panel mid-stream
  → typing works everywhere; stop and reopen → no focus theft. Run twice for
  flakiness. Unit suites (pairing, Reed-Solomon, audio FEC) still pass.
- Files: `moonlight.html`, `src/features/MoonlightBridge.js`.

## Moonlight card: removed

- Removed at the user's request after the input model proved unworkable in the
  panel. The streaming itself was fine — H.264 video, Opus audio, mouse, and
  FEC recovery all worked against a real Sunshine host — but keyboard handling
  never became something you could live with alongside the terminals.
- The root difficulty, for anyone tempted to try again: the card is a `file://`
  document inside a `file://` root. That opaque origin means Chromium refuses
  pointer lock outright ("WrongDocumentError: The root document of this element
  is not valid for pointer lock"), so the mouse can never be captured, and key
  routing has to be arbitrated by hand between the card and the app. Every
  attempt at that arbitration either swallowed the app's keystrokes or failed to
  deliver the game's. Serving the card from a real origin (http://localhost)
  rather than file:// would remove the constraint and is where a second attempt
  should start.
- The sections above describing the card are kept as a record of what was built
  and what was learned; none of that code is in the tree any more.
- Files removed: `moonlight.html`, `src/main/moonlight/` (13 modules),
  `src/features/MoonlightBridge.js`, `tests/unit/moonlight-*.test.js`, plus the
  wiring in `main.js`, `renderer.js`, `src/features/GamesManager.js` and the
  `.gitignore` carve-out.

## 2026-08-13 — Per-terminal MUTE: silence ALL FOUR of a terminal's automatic reports to the manager (CODE READY, NOT YET APPLIED — needs a restart Ethan schedules)

**The problem.** Ethan drove one of his own terminals by hand for hours. Every
turn it finished pushed a completion into the manager's queue, and on top of
that the stuck watchdog kept filing `appears stuck: prompted 5m` — which was
just Ethan thinking. None of it was useful: the manager was not managing that
terminal. His ask: "maybe you should be allowed to mute terminals from sending
things to you, via a button at the terminal header somewhere, that either I or
you can toggle on/off."

**What mute does.** A per-terminal flag that suppresses ALL FOUR of the
automatic notification paths a worker terminal has into the manager's queue —
not two. Muting a terminal makes it stop reporting itself, full stop:

1. **completion pushes** — `ManagerInstance.onTerminalCompletion()`, the
   "Terminal N ("title") just finished. Its last message:" note queued to 999
   on every Stop hook;
2. **stuck alerts** — `StuckWatchManager.sweep()`, the "appears stuck: prompted
   Nm / running Nm with no output / queued message blocked Nm" line;
3. **awaiting-input notes** — `PromptWatchManager.checkAndNotify()`, the
   "Terminal N is AWAITING INPUT — it has an interactive prompt open" note with
   the question and its options;
4. **long-execution reports** — `LongExecutionWatchManager._reportStopped()`,
   the "execution stopped after Ns. Last output:" note with a screen tail.

The first version shipped only 1 and 2, because those were the two paths behind
the complaint. That was too narrow and the manager said so: the feature Ethan
asked for is "mute terminals from sending things to you", and a mute that still
lets a terminal ping about its own on-screen prompts is leaky — he would have
hit exactly that noise the first time he muted his terminal and kept working in
it. If he is driving a terminal by hand he can see its prompt himself; that is
the premise of muting it. 3 and 4 were folded in on the same reasoning.

**Those four are the complete set.** Everything else that reaches 999 is either
the user talking to the manager directly (the message box; `WakeWordManager`'s
voice memos, which are urgent-priority and must never be muted) or the manager's
own housekeeping, which is not attributable to any terminal (`dispatchPass`, the
nightly `/clear`, `ManagerCheckpointManager`'s fleet-idle checkpoint). None of
those are a terminal reporting itself, so none are in scope for mute.

**What mute pointedly does NOT do.** It is outbound-to-manager only. The
manager can still queue messages into a muted terminal — the injection gate has
no notion of mute and never gained one — can still read it with
`/terminal/screen`, still sees it in `/state` with a live `status`, and Claude
Code keeps writing its transcript. In particular `LongExecutionWatchManager` is
the sole authority for the running↔idle status, and mute stops only its
*report*, never its status writes: status feeds the terminal display AND the
injection gate, so silencing that would have been a functional change wearing a
notification change's clothes. The terminal behaves normally in every other
respect; it just stops narrating itself.

**Where the state lives.** `muted` is a field on the terminal's record in
`TerminalStateManager`, defaulting to false. It rides along with title and
colour everywhere those already travel: persisted in the `terminalMetadata`
setting (so it survives a restart), restored through `createTerminal`, synced to
other renderers over `remote-terminal-meta`, and pushed into main's `/state`
snapshot. No new store, no new setting key, no new IPC channel.

**Two ways to toggle it.**

- *The header button.* A bell beside the close (x). Muted is deliberately not a
  subtle tint — Ethan needs to see which terminals are silenced across a grid of
  four without clicking anything — so the bell turns into a filled amber
  **MUTED** pill, the header takes an amber wash and the title goes amber with
  it. Unmuted is a plain quiet icon button.
- *The control API.* `POST /terminal/update {terminalId, muted}` — the existing
  rename/recolour endpoint, extended the same way title and colour are handled
  rather than getting an endpoint of its own. `GET /state` reports `muted` per
  terminal, which is the point: the manager has to be able to tell "deliberately
  silenced" apart from "nothing is happening", or silence means nothing.

**Terminal 999 cannot be muted.** It is the recipient, so the control would do
nothing there. Its header renders no mute button at all, `setTerminalMetadata`
refuses the flag for 999, and `/terminal/update` rejects it with an explicit
error rather than silently accepting it.

**The subtlety that matters most: unmuting must not dump a backlog.** Three of
the four watchers keep per-terminal episode/de-dupe state, and each had to be
handled so that lifting a mute does not immediately fire notes about conditions
that were true the whole time the terminal was silenced:

- *Stuck sweep* — skipping a muted terminal clears its notified-episode key.
  Without that, unmuting a terminal that had been sitting "prompted" for an hour
  would fire instantly. Unmuting starts clean; the next genuinely new stuck
  episode still alerts.
- *Prompt watch* — the muted skip drops the terminal's debounce entry. Here the
  failure mode is the mirror image: a stale key left behind would be inside the
  8s cooldown and would *swallow* the first real prompt after an unmute.
- *Long execution* — the episode is deleted whether or not it was reported, so
  nothing accumulates while silenced and only the NEXT execution reports. No
  change was needed; it is pinned by a test so a future edit cannot regress it.

The completion push keeps no episode state (it is fired per Stop hook), so there
is nothing to clear — its dedup history is per-text and unaffected.

**Verification.** `src/features/terminal-mute.test.js` (17 tests): each of the
four paths suppressed when muted and unaffected when not; an unmuted terminal in
the same stuck sweep still alerting while its muted neighbour is silent; all
three backlog cases above, including the prompt-watch swallow (which fails
without the debounce clear); long-execution status transitions asserted
IDENTICAL muted vs unmuted (`['running', '...']`), proving mute touches only the
report; `muted` defaults false and round-trips through `TerminalStateManager`;
`POST /terminal/update {muted}` carrying the flag over real HTTP to the control
handler; and `evaluateInjectionGate` returning an identical verdict with and
without mute, i.e. mute is not one of its inputs. Non-effects re-checked after
folding in paths 3 and 4: no `muted` reference exists anywhere in
`src/messaging/` (injection), `transcript-reader.js`, or `HookServer.js`, and
`readTerminalScreen` — what `/terminal/screen` calls — has no mute check.
(Prompt watch no longer reads the screen for a muted terminal, but that is its
own internal read; the manager's `/terminal/screen` endpoint is untouched.)
Full suite `node --test src/features/ src/main/ src/messaging/` = 257/257 pass.
The remote bundle (`esbuild renderer.js`) still builds.

**Reviewed without restarting.** A restart kills the manager session, so the
button was reviewed from a standalone extract instead: `scripts/build-terminal-header-preview.js`
pulls the real header markup out of `index.html`, the real stylesheet, and the
real `muteButtonHtml()` / `applyMuteChrome()` out of `renderer.js`, renders four
terminals (unmuted, muted, hover, and the manager with no button) and — with
`--shot` — screenshots both themes to `docs/screenshots/terminal-mute-{dark,light}.png`.
Same technique as the settings-modal preview, for the same reason.

**One read point.** All four watchers ask the same question the same way —
`gui.isTerminalMuted(id)`, evaluated at fire time, never cached — so there is a
single place to look when mute misbehaves and no chance of four subtly different
notions of "muted".

**Files.** `src/state/TerminalStateManager.js`, `renderer.js`, `main.js`,
`index.html`, `style.css`, and the four watchers:
`src/features/ManagerInstance.js`, `src/features/StuckWatchManager.js`,
`src/features/PromptWatchManager.js`,
`src/features/LongExecutionWatchManager.js`. Plus `src/main/manager-session.js`
(role doc → v10: the endpoint, the `/state` field, and the fact that all four
paths go quiet, so the manager treats a muted terminal's silence as expected and
looks at it directly when it needs to know),
`src/features/terminal-mute.test.js` (new),
`scripts/build-terminal-header-preview.js` (new).
