# Fleet-management optimizations

Plain-English log of improvements to the Auto-Injector control interface, driven by
the manager (terminal 999) as product owner. Each entry is one focused change on the
`auto-optimize/<date>` branch.

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
