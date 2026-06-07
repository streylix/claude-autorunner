# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This App Is

Auto-Injector ("claude code bot") is an Electron app for running many Claude Code instances side-by-side: a grid of PTY terminals, a message queue that injects prompts into specific terminals when they're free, per-terminal state tracking (running / prompted / idle), sound notifications, voice-to-prompt transcription via Whisper, and token/cost tracking. A Django backend (port 8123) handles transcription, pricing, and queue persistence APIs.

Note: the repo path contains a space (`claude code bot`) — always quote paths in shell commands.

## Commands

```bash
./start.sh              # Start Django backend + Electron app together
./start.sh --setup      # First run: installs npm deps, creates backend venv, runs migrations
npm start               # Electron app only (voice/pricing features need the backend)
npm run dev             # Electron app with DevTools open
npm run rebuild         # Rebuild native modules (node-pty) after Node/Electron upgrades
npm run build:mac       # Package with electron-builder (also :win, :linux, :all)

# Backend alone (always use the venv — backend/venv)
cd backend && source venv/bin/activate && python manage.py runserver 8123

# UI smoke test: launches the app via Playwright, screenshots before/after
node tests/app-startup-test.js                          # screenshots only
node tests/app-startup-test.js --action full-test -v    # all interaction tests
# actions: default | create-terminal | test-buttons | test-sidebar | test-message | full-test
# Screenshots land in tests/screenshots/; compare before-/after- pairs with the Read tool.
```

There is no lint step and no fast unit-test runner; `node --check <file>` is the cheapest sanity check after edits. `tests/run-automated-tests.js` runs the integration framework in `tests/integration/`.

## Architecture

Three processes:

1. **Electron main (`main.js`)** — PTY lifecycle via node-pty (`ptyProcesses` Map keyed by terminal ID), the entire IPC surface (one large `setupIpcHandlers()` — known debt, split carefully), persistence via `src/storage/unified-store`, system tray, power-save blocking, and the **HookServer** (below). Talks to the renderer exclusively through IPC.

2. **Electron renderer (`renderer.js` + `src/`)** — `renderer.js` is a thin orchestrator (~450 lines) that instantiates modules and wires IPC; all logic lives in `src/`:
   - `src/core/` — `EventBus` (central pub/sub with category→processor routing), `EventProcessors`
   - `src/state/` — `AppStateStore` (path-based global state), `TerminalStateManager` (per-terminal state, status sets, observers), `StateManager` (cross-store sync; must be `initialize()`d)
   - `src/features/` — one manager per feature (Status, Completion, Sound, Voice, Timer, UsageLimit, Preference), each constructed with `(eventBus, appStateStore)`
   - `src/messaging/` — `MessageQueueManager` (queue CRUD + injection sequencing)
   - `src/ui/` — focus/DOM helpers
   - Modules communicate via EventBus events and the state stores — never by reaching into each other or into renderer.js internals.

3. **Django backend (`backend/`)** — apps for `voice_transcription` (Whisper), `pricing`, `message_queue`, `terminal`, `frontend_control`. Python venv lives at `backend/venv` — always activate it for any Python work.

### Canonical EventBus events

Use exactly these names/payloads; do not invent variants (`terminal:statusChanged`, `terminal:output`, etc. were bugs):

- `terminal:data` → `{ terminalId, data }` — raw PTY output
- `terminal:status:changed` → `{ terminalId, status, previousStatus, source }` — status ∈ `running | prompted | '...' | error` (`'...'` is the stale/idle state: anything not running or prompted)
- `log:action` → `{ message, type }` — user-visible action log

### Terminal state detection — Claude Code hooks, not output parsing

Terminal state comes from Claude Code itself pushing events, **not** from parsing terminal output (the legacy regex/parsing detection is deprecated and being removed):

- `main.js` starts `src/main/HookServer.js` — an HTTP listener on `127.0.0.1:<random port>` requiring a per-session token.
- Every PTY is spawned with `CCBOT_TERMINAL_ID`, `CCBOT_PORT`, `CCBOT_TOKEN` in its environment.
- `src/main/claude-hooks-setup.js` idempotently installs three guarded hooks into `~/.claude/settings.json` (Stop, Notification, UserPromptSubmit). The hooks are silent no-ops unless the `CCBOT_*` env vars are present, so they never affect Claude sessions outside this app. They're identified by the `CCBOT_PORT` marker string — `removeClaudeHooks()` uninstalls surgically.
- Event mapping: `prompt-submit` → running, `notification` → prompted (payload includes the notification message), `stop` → idle. Main forwards each as a `claude-hook-event` IPC message; the renderer translates it into `terminal:status:changed`.
- A terminal with no Claude session running emits nothing — treat "no recent hook events" as a plain-shell terminal, not an error.

### The manager instance (terminal 999)

A real `claude` CLI session in a hidden PTY that monitors and steers the interface. Configured via the `managerDirectory` setting (persistent store); boots on app start with `claude --continue` when `~/.claude/projects/<munged-dir>/` has session files, else `claude`. Its role comes from the CLAUDE.md in its directory (auto-written by `src/main/manager-session.js` if absent); its credentials are the `CCBOT_*` env vars. It uses the HookServer control API: `GET /state` (terminals + status + sessionId + transcriptPath) and `POST /queue/add` (queue a message to a terminal — still subject to the usage-limit/status injection gate). Manager id is **999, not 0** — id 0 trips `options.terminalId || 1` falsy-default landmines in main.js. Never let it target itself.

Recurring optimization passes: on start the manager arms a self-contained interval (`ManagerInstance.startPassLoop`) that dispatches a standing "run a pass" instruction to its own queue every `managerPassIntervalMinutes` (setting, default 60). Settings: `managerAutoPassEnabled` (default on), `managerPassIntervalMinutes`. This loop is deliberately **independent of the user-facing auto-inject TimerManager** — arming that timer sets the injection gate's `isRunning()` true and would block all injection. A no-stack guard skips a tick if a prior pass is still queued for 999. The pass instruction is interpreted against the routines in the manager's own directory (e.g. `routines/lyra-music-optimization.md`).

### Product decisions (do not re-add)

- **No custom auto-continue/keyword auto-responder** — Claude Code's native auto mode replaced it; AutoContinueManager was deleted deliberately.
- **No Claude Flow / "Plan Mode" integration** — gutted; don't reintroduce claude-flow hooks, env vars, or MCP coupling into the app.
- **No output-parsing state detection** — extend the hook system instead.

## Debugging Yourself

- **Live-probe the running app** (the highest-signal technique here): launch via Playwright's Electron driver and evaluate against the exposed globals — `window.terminalGUI` (all managers), `window.eventBus`, `window.stateManager`:
  ```js
  const { _electron } = require('playwright');
  const app = await _electron.launch({ args: ['.'] });
  const page = await app.firstWindow();
  await page.waitForTimeout(5000); // let init + PTY settle
  await page.evaluate(() => window.terminalGUI.eventBus.emit('log:action', { message: 'probe', type: 'info' }));
  // read xterm content: gui.terminals.get(id).terminal.buffer.active.getLine(i).translateToString(true)
  ```
  Capture `page.on('console', ...)` for renderer errors and `app.process().stdout` for main-process logs.
- **One log stream for everything**: every `log:action` event renders in the sidebar Action Log AND ships to the backend, which prints it to stdout tagged `[frontend]`. So `docker compose logs -f backend` (or the venv server's stdout) interleaves frontend activity with Django's logs in one timeline. Endpoint: `POST /api/logs/frontend/`.
- **Injection gate**: `messageQueueManager.canInjectToTerminal(id)` returns `{ allowed, reason }` — the `reason` string tells you exactly which gate blocked (usage limit, timer, paused, terminal status).
- **Unit tests**: `node tests/unit/usage-limit-and-gate.test.js` (reset-time parsing, injection gate). `node --check <file>` after every edit.
- **UI smoke + screenshots**: `node tests/app-startup-test.js` — compare before/after PNGs in tests/screenshots/ with the Read tool.
- **Hook server**: main logs `[Main] Hook server listening on 127.0.0.1:<port>` at startup; inside any app terminal, `echo $CCBOT_TERMINAL_ID $CCBOT_PORT` confirms env tagging, and `curl -X POST http://127.0.0.1:$CCBOT_PORT/hook-event -H "X-CCBOT-Token: $CCBOT_TOKEN" -d '{"terminalId":"'$CCBOT_TERMINAL_ID'","event":"stop"}'` simulates a hook firing.

## Conventions & Pitfalls

- DOM element IDs in `index.html` are **kebab-case** (`add-terminal-btn`, `message-input`, `timer-play-pause-btn`); a whole class of past bugs came from modules guessing camelCase IDs. Verify the ID exists in index.html before binding.
- `src/features/` modules export the class directly (`module.exports = Manager`); check the export style before importing — mismatches crash at startup.
- `AppStateStore` keeps Maps/Sets in state — anything that persists state must use serialization that survives them (plain `JSON.stringify` turns Maps into `{}`).
- PTY injection is text-only; anything binary (images, files) must go to disk and be referenced by absolute path in the injected prompt.
- `REFACTOR_PROGRESS.md` tracks refactor status — keep its health assessment honest; it previously claimed 87/100 while the app couldn't start.
- `backend/venv/` contains thousands of vendored files — exclude it from searches and bulk analysis (`-not -path "*/venv/*"`).
