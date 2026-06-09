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
