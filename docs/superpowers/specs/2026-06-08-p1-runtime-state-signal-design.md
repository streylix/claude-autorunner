# P1 — Reliable per-terminal `runtime` (+ live directory) in `/state`

**Date:** 2026-06-08
**Branch:** `auto-optimize/2026-06-08`
**Status:** Approved (design), pending implementation

## Problem

The manager (terminal 999) drives the fleet through the loopback control API but
cannot reliably tell, from `GET /state`, whether a terminal is:

- running Claude Code,
- a **bare shell** at a prompt (or running a non-Claude command), or
- **idle inside Claude**.

`status` is hook-driven (`running | prompted | '...'`) and `sessionId` is only
populated reactively from the first hook that fires — so a freshly launched Claude
reads `sessionId: null` and a bare shell looks identical to "idle in Claude" (both
`'...'`). Today the only workaround is dumping `/terminal/screen` and eyeballing the
TUI chrome. This also underlies the injection leak (P4): a bare shell passes the
normal-priority gate, so a multi-line prompt gets written into bash and each line
runs as a command.

## Goal

Add an additive, ground-truth `runtime` field to each terminal in `/state`,
derived from the PTY's foreground process — independent of whether any hook has
fired yet. Also surface a **live `directory`** read from the process so it is
correct on fresh terminals before the first hook.

## Key calibration finding

The `claude` CLI sets its process `comm` to literally `claude` (verified across
many live instances, including the manager: `comm=claude cmd=claude --continue
--dangerously-skip-permissions`). The process tree is `electron → bash (PTY shell,
this is pty.pid) → claude`. So a descendant whose `comm === 'claude'` is an
unambiguous "Claude is alive in this PTY" signal; a `bash` with no such descendant
is a shell. No fragile cmdline parsing required.

## Design

### New module: `src/main/terminal-runtime.js`

Pure, dependency-free (only `fs`/`path`), `procRoot`-injectable so it is
unit-testable in plain node without Electron or node-pty.

- `detectRuntime(pid, { procRoot = '/proc' }) -> 'claude' | 'shell' | 'unknown'`
  - `pid == null` or `/proc/<pid>` unreadable → `'unknown'`.
  - BFS the process tree from `pid` via `/proc/<pid>/task/<pid>/children`,
    capped (`MAX_DEPTH ~6`, `MAX_NODES ~200`) as a runaway guard.
  - Any node (root included) with `comm === 'claude'` → `'claude'`.
  - Tree readable, no claude found → `'shell'`.
- `liveCwd(pid, { procRoot }) -> string | null` — `readlink /proc/<pid>/cwd`,
  `null` on failure.
- `enrichSnapshot(snapshot, pidFor, opts) -> snapshot'` — pure; clones the
  snapshot, and for each terminal adds `runtime` and, when `liveCwd` succeeds,
  overrides `directory` with the live value (falls back to the existing
  hook-derived value when `/proc` read fails). Never mutates its input.

### Integration: one call site in `main.js`

The HookServer is constructed with `getState: () => rendererStateCache`. Wrap it:

```js
const { enrichSnapshot } = require('./src/main/terminal-runtime');
// ...
getState: () => enrichSnapshot(
  rendererStateCache,
  (id) => ptyProcesses.get(id)?.pid
),
```

`runtime`/`directory` are computed **fresh on every `/state` GET**, in main (where
the PTYs and `/proc` live) — never stale, no new IPC. `HookServer.js` and
`renderer.js` are untouched.

### How this resolves the ambiguity (combined with existing `status`)

| `runtime` | `status` | meaning |
|-----------|----------|---------|
| `shell`   | (any)    | bare shell — unsafe to inject a prompt |
| `claude`  | `'...'`  | idle in Claude |
| `claude`  | `running`| Claude running a turn |
| `claude`  | `prompted` | Claude awaiting input |

No change to `status` semantics — `runtime` is purely additive and backward
compatible.

## Testing (TDD)

`src/main/terminal-runtime.test.js` (node's built-in `node:test`), fixture `/proc`
dirs built in a tmp dir:

1. `detectRuntime`: bash → claude child ⇒ `claude`
2. `detectRuntime`: bash → non-claude child ⇒ `shell`
3. `detectRuntime`: claude as grandchild ⇒ `claude`
4. `detectRuntime`: root comm is claude ⇒ `claude`
5. `detectRuntime`: nonexistent pid ⇒ `unknown`
6. `detectRuntime`: null/undefined pid ⇒ `unknown`
7. `liveCwd`: returns symlink target; `null` when missing
8. `enrichSnapshot`: adds `runtime`, overrides `directory` with live cwd, leaves
   input unmutated, handles missing pid (⇒ `unknown`, keeps existing directory)

Run: `node --test src/main/terminal-runtime.test.js`.

## Reuse for P1.5 (prompt-pending notification)

`detectRuntime` becomes the guard so the manager is only notified of
"awaiting approval" when `runtime === 'claude'` — never on shell noise.

## Restart implications

Only the `getState` wiring in `main.js` touches the live process; it requires
**quitting and relaunching the Electron app** to take effect. The new module and
its tests do not affect the running app. This work stays on the branch; the user
chooses when to apply the restart.

## Out of scope (deliberately)

- Distinguishing "shell at a prompt" vs "shell running a command" (both are
  `shell` for injection-safety purposes).
- Live `sessionId` resolution (separate concern; `runtime` is the must-have).
- Any change to `status`, hooks, or the injection gate (that is P4).
