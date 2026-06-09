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
