# Phase 1 Audit — claude-autorunner

**Branch:** `discord-integration` · **Scope:** read-only audit (no code changed) · **Status:** awaiting approval before Phase 2.

Live instance confirmed healthy and untouched during the audit: backend `127.0.0.1:8123` up ~6 days, Postgres healthy, terminal 999 not disturbed. No process was launched, restarted, or killed; no repo file was modified. This document is the only artifact produced.

## Headline

The trust model is fundamentally **sound** — loopback binding + a per-session token is the real security boundary, and the `discord-integration` branch already added most of the right hardening (999-block at the HTTP layer, transcript path containment, opt-in backend token, `DEBUG=false` default, `ALLOWED_HOSTS` allowlist). The Phase 2 work is therefore **not** "repair a broken model." It is four things:

1. Close **one** genuine remote-control hole (no Discord user allow-list).
2. Delete a large body of dead code (~17.6k lines JS + ~120 CSS selectors + 2 backend Python files).
3. Wire up ~two dozen features that are **built but not connected**.
4. Rewrite a README that currently describes ~40% of the app, and produce three showcase GIFs.

---

## 1. Security findings

Ordered most-severe first. The no-Discord-allow-list gap leads because it is the one practical remote path to the privileged manager.

### 1.1 HIGH — No Discord user authorization (any guild member can drive the manager)
- **Where:** `discord-bridge/src/commands.js:139-174` (`/prompt`), `discord-bridge/src/index.js:121-153` (`messageCreate` auto-forward).
- **Risk:** The only gate on who may send prompts is `message.guildId === config.guildId` (`index.js:125`). There is no user allow-list / owner-ID check anywhere (grep for `allowedUser`/`ownerId`/`whitelist` returns nothing). Any member of the configured guild — or anyone invited into it, or anyone who can post in the mirror text channel — can type a message or run `/prompt`, which is injected **verbatim into the manager Claude instance (terminal 999)**. By design the manager can queue work to other terminals and steer the interface, so this is effectively remote control of a privileged local agent by anyone in the Discord server.
- **Proposed fix:** Add an allow-list of Discord user IDs (env `DISCORD_ALLOWED_USER_IDS`) enforced at the top of `commands.handle()`, in the `messageCreate` handler, and on `/link`. Reject/ignore everyone else. This is the first fix to make.

### 1.2 HIGH (inherent capability) — `terminal-keys` is arbitrary keystroke injection, incl. to 999
- **Where:** `src/main/pty-control.js:33-61` (`translateKeys`/`sendKeys`), routed at `HookServer.js:106-130` / `main.js:501-510`; consumed by `discord-bridge/src/controlApi.js:48-59`.
- **Risk:** `translateKeys` passes any unrecognized token through **literally** and `sendKeys` writes it straight to the PTY with no runtime guard and — unlike `/queue/add` — **no 999 block**. A token-holder can type arbitrary text + `enter` into any terminal; at a bare shell that is command execution. This is the intended voice-bridge mechanism, so the practical meaning is: the 32-hex-char `CCBOT_TOKEN` is an RCE-equivalent capability.
- **Proposed fix:** Keep the loopback+token boundary strict (mitigate, do not remove — it is load-bearing for the bridge). Optionally gate raw `terminal-keys` to **non-manager** terminals behind the same bare-shell/claude runtime guard `launchClaude` uses. Document in the threat model that token compromise == host compromise. Fix 1.1 closes the practical remote path.

### 1.3 MEDIUM — HookServer token comparison is not timing-safe
- **Where:** `src/main/HookServer.js:72` — `if (req.headers['x-ccbot-token'] !== this.token)`.
- **Risk:** Plain `!==` leaks match length/prefix via timing. (Contrast the backend, which correctly uses `hmac.compare_digest`, `api_security.py:51`.) Bounded by loopback-only exposure, but a co-resident local process could exploit it.
- **Proposed fix:** Use `crypto.timingSafeEqual` over equal-length buffers (guard the length mismatch first).

### 1.4 MEDIUM — Prompt injection into the manager via Discord text/file captions
- **Where:** `discord-bridge/src/controlApi.js:27-41` (`frameMemo`) via `sendVoiceMemo`.
- **Risk:** Discord message text and file captions are wrapped in a marker and injected verbatim as the manager's prompt; the manager acts on that text (could be steered to exfiltrate, queue malicious prompts, or attempt keystroke relay per 1.2). Whitespace collapsing is cosmetic, not a control.
- **Proposed fix:** Primarily closed by 1.1 (restrict who can send). Additionally, the manager's CLAUDE.md role should treat bridged input as untrusted **data**, not instructions.

### 1.5 LOW/MEDIUM — Arbitrary local-file exfiltration via image/video outbox descriptors
- **Where:** `discord-bridge/src/imageOutbox.js:79-84` → `discord-bridge/src/textMirror.js:130,169` (`postImage`/`postVideo`).
- **Risk:** A descriptor JSON dropped in the outbox dir names an **arbitrary absolute path** (`desc.image`/`desc.video`) that the bridge reads and posts to Discord — no containment check. Any same-user process that can write to the outbox dir (or a mis-directed manager) could exfiltrate `~/.ssh/id_rsa`, `/etc/passwd`, etc. Mitigated by the dir living under `$XDG_RUNTIME_DIR` (0700, same-uid only).
- **Proposed fix:** Constrain posted paths to a configured media root via `path.resolve` + `startsWith` before reading; reject escapes.

### 1.6 LOW — Electron renderer runs with full Node and no isolation
- **Where:** `main.js:339-342` — `nodeIntegration:true, contextIsolation:false, enableRemoteModule:true`.
- **Risk:** Renderer has unrestricted Node. Only loads local `index.html` today (not directly exploitable), but any future remote content or DOM injection of untrusted text into an executable context becomes RCE.
- **Proposed fix:** Long-term move to `contextIsolation:true` + preload bridge. Near-term: never load remote URLs; insert any Discord/transcript text as `textContent`, never HTML.

### 1.7 LOW — Frontend log endpoint allows log-forging (newline injection)
- **Where:** `backend/frontend_control/views.py:23-24` — `print(f"[frontend] ... {message}")`, only length-truncated, `@csrf_exempt`.
- **Risk:** `message` can contain newlines, forging fake `[frontend]` lines in the shared stdout timeline. Log-integrity nuisance only; no code execution.
- **Proposed fix:** Strip/escape CR/LF before printing.

### Secure-by-design — do NOT "fix" these
- **Loopback binding is the boundary.** HookServer `127.0.0.1:<random>` (`HookServer.js:64`); backend `127.0.0.1:8123:8123` (`docker-compose.yml:29`). No `0.0.0.0` bind exists in the repo — the external `0.0.0.0:9696` listener is **not** this app (zero references to 9696). Don't add ineffective in-container IP filters (docker userland proxy masquerades host/LAN to one gateway IP).
- **Every HookServer endpoint requires the token** — the `x-ccbot-token` check runs before routing; `/state`, `/queue`, `/queue/add`, all `/terminal/*` and `/queue/*` routes are authenticated. Body capped at 256 KB with clean drain on 403.
- **Link-key design is sound.** The Discord-transmitted key carries only `{port, linkToken}`, never the control token (`linkVault.js:49-57`); the real token is read locally from a 0600 vault under `$XDG_RUNTIME_DIR`. Keys are rotatable/revocable by overwriting the vault; `resume.json` is 0600 and tokenless.
- **`/queue/add` is guarded** — integer terminalId, non-empty content, explicit 999 block (`HookServer.js:163-167`), type normalized to `normal|urgent`.
- **PTY control input is sanitized** — `sanitizeArgs` strips control chars from `claude` args; `SESSION_ID_RE` validates resume IDs; `launchClaude` refuses unless the runtime is a bare shell.
- **Backend token auth is timing-safe + opt-in** — `hmac.compare_digest`; AllowAny only when unset.
- **`audio()` view has no path traversal** — `pk` is an int route; `audio_path` is server-generated (`tts/<id>.wav`), never client-supplied.
- **All `child_process` calls are array-form, no `shell:true`** — args to `parec`/`pacat`/`paplay`/`ffmpeg`/`ffprobe`/`adb`/`ccusage`/`claude` are config/server-derived; `subprocess.run([...])` in `wake_service.py:76` is array-form on a server temp path.
- **Django** `DEBUG` defaults false; `SECRET_KEY` required when off; `ALLOWED_HOSTS` localhost-only; CORS localhost/`file://` only.
- **No secrets committed.** `./.env` and `./discord-bridge/.env` exist on disk but are gitignored and never tracked (confirmed via `git ls-files` + history). The live `DISCORD_BOT_TOKEN` in `discord-bridge/.env` is expected operational config, not a repo leak.

**Operational note (not a repo vuln):** possession of the live bot + guild membership is the practical attack path — which is exactly why 1.1 is the priority.

---

## 2. Dead-code inventory

All claims grep-verified repo-wide (excluding `node_modules`, `backend/venv`, `.git`). "Zero refs" = no `require`/`import`/`<script src>`/IPC/event-name/string reference outside the file itself. `*.test.js` treated as legitimate.

### HIGH confidence — entire files/directories with zero external references (safe to delete)
- **`src/integration/`** (~3,340 lines) — `error-recovery-system.js`, `integration-orchestrator.js`, `system-integration-tests.js`, `workflow-validator.js`. Zero external requires; not script-tagged.
- **`src/actions/`** (~4,000+ lines incl. README) — all 8 modules + README. Entry `src/actions/index.js` never required, not in `index.html`. (Distinct from the live `src/features/ActionLogManager.js`.)
- **`src/screenshot/`** (~1,880 lines) — `screenshot-engine.js`, `screenshot-ui-controller.js`, `image-manager.js`, README. The "screenshot" strings in `main.js`/`renderer.js` are the unrelated live screenshot IPC + `screenshot.wav`.
- **Superseded duplicates:**
  - `src/terminal/terminal-manager.js` (742) — superseded by live `src/core/terminal-manager.js` (`renderer.js:10`).
  - `src/timer/timer-controller.js` (870) — superseded by live `src/features/TimerManager.js`; only consumer of `window.GlowingEffect`.
  - `src/core/ipc-handler.js` (277) — IPC surface actually lives inline in `main.js`/`renderer.js`.
- **Dead `src/utils/` modules** (~1,980 lines): `dom-cache.js`, `dom-utils.js`, `platform-utils.js`, `terminalUtils.js`, `timer-registry.js`, `uiUtils.js`. (Live utils for contrast: `bounded-collections`, `validation`, `usage-limit-parser`, `microwave-init`.)
- **Top-level `utils/` — loaded but inert:**
  - `utils/textExtraction.js` (59) — required at `renderer.js:35`, but all three destructured names appear only on the require line. Dead file + unused import.
  - `utils/api-client.js` (393) — `<script>`-loaded (`index.html:754`), exports `window.BackendAPIClient`, never instantiated; wrong port (8001) and ~20 removed routes. `renderer.js:1079` passes a plain `{baseUrl}` instead. Related dead branches: `TimerManager` constructed with 2 args (`renderer.js:156`) so `this.backendAPIClient.startTimer/pauseTimer/stopTimer` never run.
  - `utils/glowing-effect.js` (192) — `<script>`-loaded; only consumer is the dead `src/timer/timer-controller.js`. Live TimerManager does glow via CSS (`glow-pulse`).
  - `utils/completion-timer.js` (157) — loaded and self-instantiating, but operates only on `.completion-item`/`.completion-timer` DOM nodes that nothing creates. Provably inert (remove is MEDIUM because it is live-wired via script tag).
- **Unused imports in live files:** `renderer.js:35` (`getAllTextIn/getLastTextIn/cleanTerminalText`); `src/features/StatusManager.js:12` (`BoundedSet`); `src/features/UsageLimitManager.js:21` (`ipcRenderer`). (`main.js` and all `discord-bridge/src/*` came back clean.)
- **Backend dead files:** `backend/pricing/ccusage_simple_parser.py` (62, never imported — real endpoint is `pricing/views.py::execute_ccusage_simple`); `backend/terminal_backend/management/commands/runserver_8001.py` (zero refs; backend runs on 8123). Caveat: management commands are invoked by dynamic name, but nothing scripts this one → HIGH-borderline.

### MEDIUM confidence — needs a product decision, not auto-delete
- **`src/adb/`** — `adb-demo.js` (762), `adb-integration-example.js` (435), `device-manager.js` (522), `adb-manager.js` (544), README. Zero requires from outside `src/adb/` (`adb-manager.js` required only by the dead `device-manager.js` + its own tracked test). BUT commit `277de25` (recent) fixed a HIGH bug in `adb-manager.js` and `OPTIMIZATIONS.md` discusses it — looks like deliberately parked future work. The demo/example files are dead by any reading. **See ADB question in §6.**

### Dead CSS clusters in `style.css` (~120 of 358 top-level selectors, zero refs)
Verified the live UI builds DOM with different class names (notifications → `notification-item`, queue → `message-item`/`message-text`, color picker → `color-picker-title`/`-modal`). Suspicious clusters:
- **Removed-feature CSS (CLAUDE.md says these were deliberately deleted):** keyword auto-responder (`.keyword-*`, `.add/remove-keyword-btn`, `.auto-continue-btn`), Plan Mode (`.plan-mode-*`, `.preset-btn`).
- **Old todo UI:** `.todo-*`, `#clear-all-todos-btn` (todo view now renders `notification-*`).
- **Completion modal/list** (pairs with inert `utils/completion-timer.js`): `.completion-modal*`, `.completion-content/header/prompt/status/subtitle/terminal`, `.completed-icon`, `.failed-icon`, `.progress-icon`.
- **Legacy queue-item chrome:** `.message-actions/content/delete-btn/edit-btn/meta/options-btn/dropdown/terminal-dropdown`, `.message-clipboard-*`, `.message-image-*`, `.message-text-content`.
- **Removed manager-tab UI:** `#manager-dispatch-input`, `#manager-status-badge`, `#manager-tab-btn`, `.manager-dispatch/header/setup-overlay/title`.
- **Old list-style color picker:** `.color-picker-item/dot/check/list/text`.
- **Misc orphans:** `.history-item-*`, `.receipt-entry-*`, `.worker-*`, several `.timer-*`, `.add-terminal-dropdown*`, `.image-preview-*`, `.file-attachment`, `.hotkey-hint`, `.undo-btn`, `.load-more-btn`, plus ~15 generic ones. **Keep:** `.xterm-search-decorations`, `.search-highlight` (injected by the xterm search addon at runtime).

### Orphaned assets / build inputs
- `docs/images/main-interface.png` — zero refs (README uses only `docs/injectortest.gif` + `docs/images/sound-settings.png`). MEDIUM.
- `bin/manage.py` — convenience wrapper, zero refs; depends on the venv flow. MEDIUM.
- `assets/icons/icon.iconset/` (10 PNGs) — build input for `iconutil`, not runtime dead code. LOW, keep.

### Verified NOT dead (checked because they looked suspicious — do not delete)
- All 19 `assets/soundeffects/*.wav` — populated dynamically via `fs.readdir` (`main.js:1294-1300`) into the sound dropdowns.
- `src/audio/microwave-mode.js`, `src/utils/microwave-init.js`, `src/ui/loading-manager.js` — `<script>`-loaded (`index.html:751-757`).
- `src/features/prompt-detector.js` — used by live `PromptWatchManager.js:16` (interactive-menu detector, separate from deprecated output *status* parsing).
- All 24 `discord-bridge/src/*` modules referenced; `doctor.js` = `npm run doctor`; `tools/*` = npm scripts; `service/` referenced by its own install.sh.
- Backend `text_to_speech/voices.py`, `terminal_backend/api_security.py`, `frontend_control/`, `wake_service.py` — all wired.

**Total:** ~17,600 lines of provably-unreferenced JS, ~120 orphaned CSS selectors, 2 backend Python files, 1 orphaned docs image.

---

## 3. Unwired-code inventory (built but not connected)

Distinct from dead code: these are meant to be used but aren't hooked to their trigger. Each item lists the definition site and where it should connect. (Findings that live only inside never-loaded dead modules are excluded here — they belong in §2.)

### IPC channel gaps
- **`terminal-error` swallowed (HIGH).** `main.js:832` does `webContents.send('terminal-error', …)` on PTY spawn failure, but the only would-be listener (`EventBus.setupIPCForwarding`, `EventBus.js:205`) is **never called**. Spawn errors are silently dropped. **Connect:** add `ipcRenderer.on('terminal-error', …)` in renderer → `log:action` + `terminal:status:changed` (error).
- **`tray-start-injection` / `tray-stop-injection` (HIGH).** Sent from tray menu (`main.js:293,301`); no renderer listeners → the tray "Start/Stop Injection" items do nothing. **Connect:** `ipcRenderer.on` → `MessageQueueManager` start/pause.
- **Fully-registered main.js handlers the renderer never calls:** `change-terminal-directory:902`, `open-external-link:946`, `show-directory-dialog:1004`, `handle-file-drop:1020`, `save-screenshot:1061`, `get-file-info:1260`, `backup-localstorage:1311`, `restore-localstorage:1333`, the entire legacy `db-*` family (`:1390`–`:1626`), `start/stop/is-power-save-blocker:1674/1688/1703`, `show-notification:1714`, `update-tray-badge:1725`, `terminal-status-response:1220`. The last three are the intended counterparts of orphaned EventBus emits (see below).
- **Renderer listens, main never sends:** `create-terminal` (`renderer.js:319`), `close-terminal:320`, `terminal-status:453`, `directory-changed:466`.
- **Latent payload bug (for whoever wires `change-terminal-directory`):** `main.js:927` sends `terminal-data` as a raw string but `renderer.js:323` expects `{terminalId,content}`; `main.js:934` sends `terminal-exit` with no payload but `renderer.js:350` destructures it. Copy the correct `event.reply` paths (`main.js:738/808/743/812`).

### DOM controls with no listener (and listeners to missing ids)
- **File-attach cluster (HIGH).** `file-input` (`index.html:378`), `drop-zone:328`, `drop-overlay:365`, `image-preview-container:325`, `image-preview-list:326` — no drag/drop/paste/click handler anywhere. **Connect:** renderer input block or `MessageQueueManager`. (PTY injection is text-only, so images must save to disk + inject a path — the `save-screenshot` handler already exists.)
- **`terminal-scroll-behavior` `<select>`** (`index.html:404`) — zero JS refs. **Connect:** settings wiring + a PreferenceManager key.
- **Terminal search overlay** (`.search-input/.search-prev/.search-next/.search-close`, `index.html:201-211`) — `src/core/terminal-manager.js:150` creates a `SearchAddon` but never binds these or shows the overlay (currently `display:none`). **Connect:** bind the overlay + a toggle shortcut.
- **JS lookups of ids absent from index.html:** `automatic-todo-generation` (`PreferenceManager.js:404` — `generateTodoOnCompletion` has no checkbox), `microwave-mode-enabled` (`microwave-init.js:91` — toggle missing), `terminal-selector` (`UIFocusManager.js:51,133` — real ids are `-btn`/`-dropdown`; dormant since `initialize()` never called), `timer-hours/minutes/seconds-input` (`UIFocusManager.js:69-71`), `loading-progress-steps` (`loading-manager.js:28`).
- **Advertised hotkeys that do nothing (MEDIUM):** `data-hotkey` labels are cosmetic; real shortcuts (`renderer.js:725-742`) cover only T/Shift+W/I/P/S/M/Shift+H/Shift+L. Dead: Cmd+F, Cmd+K, Cmd+B, Cmd+Shift+S, Cmd+Shift+V, Cmd+Shift+. — because `UIFocusManager.initialize()` (`:279`) is constructed but never called (`renderer.js:157`).

### Feature-manager methods defined but never called
- **`NotificationManager.stopPolling()`** (`:290`) — never called; TTS polling can't stop (no `destroy()`). **Connect:** app-teardown path.
- **`InjectionManager` entirely dormant** — constructed (`renderer.js:131`) but `initialize()` (`injection-manager.js:34`) and all lifecycle methods (`onTimerExpired:90`, `onTimerStopped:106`, `onUsageLimitDetected:116`, `onInjectionComplete:321`, …) never invoked; its one live reference (`MessageQueueManager.js:1159`) calls a nonexistent `scheduleNextInjection()`. **Decision: wire or delete.**
- **MQM legacy sequential engine:** `pauseInjectionExecution:1437`, `resumeInjectionExecution:1443`, `cancelSequentialInjection:1449`, `manualInjectNextMessage:1433` reachable only via `injection:pause/resume/cancel/manual` events that are **never emitted** (live pause flips `injectionPaused` directly). Also `injectSpecificMessage:738`, `validateMessageIds:766`, `setTerminalForNextMessage:776`, `queueContinueMessage:783` — zero call sites (look like intended toolbar features). **Decision: wire or delete.**
- **`SoundManager.setPromptedKeywordsOnly()`** (`:104`) — never called; UI checkbox commented out.
- **`PreferenceManager.registerChangeHandler()`** (`:414`) — never called, so `notifyChangeHandlers` is a permanent no-op. Also dead: `exportPreferences`/`importPreferences` (`:445/450`, no UI), `setTheme:300` (theme persisted elsewhere via `renderer.js:2202`).
- `StatusManager` output-parsing methods (`updateTerminalStatusFromOutput:361` …) — deprecated detection, removal-ready, **do not rewire**.
- Lower-confidence: `ManagerInstance.isConfigured`, assorted `UsageLimitManager`/`VoiceManager`/`ActionLogManager` getters, `WakeWordManager.initialize():214` (wake word works via `preferences:applied`→`_applyConfig`; the restore path is dead).

### Backend endpoints never hit
- `/api/voice/list/` (`voice_transcription/urls.py:11`, `views.py:248`) — intended home: a transcription-history panel that doesn't exist.
- `/api/voice/clear/` (`urls.py:12`, `views.py:269`) — no client.
- `/api/tts/health/` (`text_to_speech/urls.py:14`, `views.py:220`) — nothing probes it (compose uses `/api/queue/health/`; doctor uses `/api/tts/notifications/`).
- `/api/ccusage/` (`pricing/urls.py:9`, `views.py:293`) — vestigial, replaced by host IPC `get-ccusage` (`main.js:1283`). Removal candidate.
- (`wake_service.py` IS wired via the `wake_check` view — not a finding.)

### EventBus emit/subscribe mismatches
- **`injection:started`/`injection:completed` (HIGH).** `StatusManager.js:45,49` subscribes, but MQM emits `message:injection-started`/`-completed`. Result: 'injecting' status + post-injection rescan never fire. **Fix:** subscribe to the `message:`-prefixed names (one-line).
- **`timer:manual-change`** — `UsageLimitManager.js:85` subscribes; never emitted → "user edited timer → stop auto-sync" never runs. **Emit from** the timer-edit path (`renderer.js:601-655`).
- **`terminal:removed`** — `StatusManager.js:59` subscribes; close path emits `terminal:closed` → per-terminal status entries leak.
- **Renderer→main bridges missing:** `power:save-blocker:start/stop` (`MQM:432,436`), `ui:tray-badge` (`MQM:418`), `ui:system-notification` (`MQM:425`) each have a ready main.js handler but no renderer subscriber invoking IPC. **Connect:** `eventBus.on('ui:tray-badge', …) → ipcRenderer.invoke('update-tray-badge', …)`, etc. (This also un-deads the `keepScreenAwake` setting.)
- **`sound:play`** (`TimerManager:428`) — prefix `sound` routes to the default no-op processor, not `audio` → timer-expiry alarm never plays.
- **`modal:opened/closed`, `focus:*`, `terminal:switched`** (`UIFocusManager`) — never emitted → modal focus traps + focus-follow dead (compounded by `initialize()` never called).
- Theme three-way drift: subscriber wants `theme:change`, emitter says `theme:changed`, UI case is `theme-change` — none connect (theme survives via direct `persistSetting`).
- Canonical events (`terminal:data`, `terminal:status:changed`, `log:action`) are all healthy.

### Discord bridge wiring
- Slash commands fully matched — `link/resume/stop/leave/status/prompt` all registered (`commands.js:21-52`) and dispatched (`:88-196`). No findings.
- **`LinkManager.linkFromVault()`** (`linkManager.js:49-68`) — unwired **and broken**: calls `resolveLatest()` which is neither imported nor defined (guaranteed ReferenceError). Its intended trigger — auto-link when the bot follows you into voice — is unimplemented (the `voiceStateUpdate` handler `index.js:103-111` does mute tracking only). **Connect:** add `resolveLatest()` in `linkVault.js` + an auto-join branch in `index.js`.
- `mediaInbox.composeForward` (`:71`) — superseded dead export (real path uses `linkManager.forward`→`controlApi.frameMemo`).
- `resumeStore.forget` (`:74`) — never called (MEDIUM; may be deliberate).
- `useBracketedPaste` (`config.js:171`) — defined but consumed by nothing; the `controlApi.js:12` comment claims bracketed-paste wrapping but no `\x1b[200~` write exists (knob + comment drift).

### Orphaned settings/preferences
- **Read but never writable — user cannot change them (HIGH):**
  - `managerPromptWatchEnabled` (read `PromptWatchManager.js:54`) — no writer, no UI → permanently default-on. **Connect:** settings toggle mirrored into appStateStore (copy the `managerInputEnabled` pattern, `renderer.js:2137-2151`).
  - `managerAutoPassEnabled` (read `ManagerInstance.js:283`), `managerPassIntervalMinutes` (read `:102`) — documented in CLAUDE.md but only editable by hand-editing `auto-injector.json`. **Connect:** Manager-section controls → `persistSetting`.
  - `keepScreenAwake` (read `MessageQueueManager.js:1091`) — no writer, no default → `startPowerSaveBlocker()` never runs (triple-dead with the missing bridge above).
  - `settings.sound.promptedKeywordsOnly` (read `SoundManager.js:404`) — never written; sibling `promptedSoundKeywordsOnly` stored but never read; checkbox commented out.
- **Written as defaults but never read — dead keys (`PreferenceManager.js:15-61`):** `enablePowerSaveBlocker`, `microwaveInterval`, `typewriterEffectEnabled`, `typewriterSpeed`, `completionBehavior`, `trayBarTheme`, `backgroundServiceEnabled`, `alwaysTargetPromptedTerminal`, `autoCompleteTodoEnabled`, `generateTodoOnCompletion`, `startInBackground`, `showInDock`, `autoStart`, `autoScroll`, `smoothScroll`, `showTerminalSelector`, `verticalLayout`, and effectively `voiceEnabled`.
- **Wired correctly (no action):** `managerDirectory`; all wake-word keys (`wakeWordEnabled/Phrase`, `wakeSilenceMs`, `wakeMatchThreshold`, `wakeActivationSound/StopSound`, `wakeMuteDuringCall`, `microphoneDeviceId`) incl. the discord-bridge `appSettings.js` mirror.

---

## 4. Feature inventory (both branches)

An Electron app for running many Claude Code sessions side-by-side, with a Django backend (Docker, port 8123) for transcription, TTS, pricing, and queue persistence.

### 4a. Core features (present on BOTH `main` and `discord-integration`)

**Terminals & state**
- Multi-terminal PTY grid — xterm.js + node-pty, grid layout, per-terminal selector/search/web-links. `main.js`, `src/core/terminal-manager.js`, `src/state/TerminalStateManager.js`, `index.html`.
- Terminal state via Claude Code hooks (not output scraping) — token-authed localhost HookServer; three guarded hooks (Stop/Notification/UserPromptSubmit) auto-installed into `~/.claude/settings.json`, active only inside app-spawned terminals (CCBOT_* env). `src/main/HookServer.js`, `src/main/claude-hooks-setup.js`, `src/features/StatusManager.js`.
- Per-terminal runtime detection — walks `/proc` for a `claude` process under the PTY to distinguish a live session from a bare shell (feeds the injection gate). `src/main/terminal-runtime.js`.
- Transcript reader — reads Claude's last assistant message from the session JSONL to build completion entries. `src/main/transcript-reader.js`.

**Message queue & injection**
- Message queue + injection — write prompts now; inject when the terminal is free; CRUD, sequencing, urgent/normal/force types, backend persistence. `src/messaging/MessageQueueManager.js`, `injection-manager.js`.
- Injection gate (pure policy) — precedence: usage-limit wait → timer → paused → bare-shell guard → status gate; `urgent` bypasses all but "no target". `canInjectToTerminal()` returns `{allowed, reason}`. `src/messaging/injection-gate.js`.
- Auto-inject timer. `src/features/TimerManager.js`.
- Usage-limit detection & auto-resume — parses the usage-limit notification (hook message + raw-output regex fallback), counts down to reset, holds injection, resumes. `src/features/UsageLimitManager.js`, `src/utils/usage-limit-parser.js`.

**The Manager (terminal 999)**
- Hidden manager Claude instance — real `claude` CLI in a concealed PTY (id 999) that monitors/steers via the control API (`GET /state`, `POST /queue/add`, `POST /terminal/keys`, PTY start/resume); resumes with `claude --continue`; role CLAUDE.md auto-written. `src/features/ManagerInstance.js`, `src/main/manager-session.js`.
- Recurring optimization passes — self-contained interval dispatching a standing "run a pass over routines/" instruction (default 60 min; `managerAutoPassEnabled`/`managerPassIntervalMinutes`), independent of the user timer. `ManagerInstance.startPassLoop`.
- Interactive-prompt watch — when a worker opens a genuine permission dialog/select menu (screen-buffer detector, not raw status), the manager is notified to answer. `src/features/PromptWatchManager.js`, `src/features/prompt-detector.js`.

**Voice & audio**
- Voice-to-prompt (push-to-talk) — record from a selectable mic → backend Whisper → append to the input. `src/features/VoiceManager.js`, `backend/voice_transcription/`.
- "Hey Claude" wake word (always-on, local) — Vosk (WASM, in-renderer) spots the phrase → chime → VAD-captured command → one Whisper pass → urgent voice memo to the manager. Strictness slider, configurable silence, works while hidden. `src/features/WakeWordManager.js`.
- Spoken notifications (TTS) — manager summarizes completions → `POST /api/tts/speak/` (Kokoro); Notifications tab polls/renders/auto-reads. `src/features/NotificationManager.js`, `backend/text_to_speech/`.
- Sound effects — per-event and per-terminal overrides (Half-Life 2 pack). `src/features/SoundManager.js`.

**Tracking, logging, misc**
- Token/cost tracking — `npx ccusage` on the host (backend can't see `~/.claude`); Pricing view. `src/main/ccusage.js`, `main.js` (`get-ccusage`).
- Unified action log — every `log:action` renders in the sidebar AND ships to the backend, printed tagged `[frontend]`, so `docker compose logs -f backend` is one merged timeline. `src/features/ActionLogManager.js`.
- Settings/preferences store. `src/features/PreferenceManager.js`.
- Clipboard screenshot saving (`save-screenshot` IPC, `main.js` ~1060).
- System tray, power-save blocking, `backgroundThrottling:false`.
- Django backend apps: `voice_transcription` (Whisper), `text_to_speech` (Kokoro + notification feed), `pricing`, `message_queue`, `frontend_control`; Docker + Postgres default.

**Present-but-dormant (README honesty):** ADB integration (`src/adb/`) and the Action Recording System (`src/actions/`) are complete modules but not wired into `main.js`/`renderer.js`/`index.html`. Treat as inactive/experimental.

### 4b. What `discord-integration` ADDS (delta vs main, ~5,300 committed lines / 48 files)

A standalone Discord voice-bridge service (systemd --user; discord.js + @discordjs/voice with DAVE E2EE). Holds **no app credentials at rest**, survives app restarts, reaches the app only via the loopback control API after `/link`.

**Flow:** speak in the voice channel → wake-word gate (cheap CPU Vosk via backend) → GPU Whisper → framed voice memo typed into manager 999 via `POST /terminal/keys` → manager's TTS replies stream back into the channel.

**Slash commands** (`src/commands.js`): `/link <key>` (link + join your channel), `/resume` (re-link with last key, no paste), `/stop` (leave call, stay linked), `/leave` (leave + unlink), `/status`, `/prompt` (typed message + optional image/video attachment).

**Security model — link vault** (`src/linkVault.js`, `tools/make-link-key.js`): manager mints a rotatable link-token; real CCBOT creds live only in a 0600 tmpfs vault; the pasted key carries `{port, linkToken}` only; keys expire (default 1h), re-minting revokes instantly. App-side: `main.js` `discord:get-link-key` IPC + `src/features/DiscordLinkKeyManager.js` (Settings widget showing a copy/regenerate `/link <key>`).

**Per-file roles (`discord-bridge/src/`):**
| File | Role |
|---|---|
| `index.js` | Service entry: login, register commands, idle-until-linked lifecycle, plain image/video drops |
| `commands.js` | Slash-command definitions & handlers |
| `session.js` | "In a voice channel and wired up" state; join/leave follows the summoning user |
| `linkManager.js` | Active link creds in memory only; validates against live `/state` |
| `linkVault.js` | Key encode/decode + the rotatable local credential vault |
| `resumeStore.js` | Per-Discord-user last-used key (0600) for `/resume` |
| `voiceReceive.js` | Per-speaker Opus → PCM → WAV → wake gate → forward |
| `wakeWord.js` | Phonetic (Soundex + edit-distance) wake-phrase matcher on transcript text |
| `wakeCheck.js` | Cheap CPU wake gating via the backend Vosk endpoint |
| `transcribe.js` | WAV → the app's existing Whisper endpoint |
| `controlApi.js` | Frames memos with the voice-memo marker; `POST /terminal/keys` to 999 |
| `ttsPoller.js` | Polls the TTS notification feed; new clips → audio player |
| `audioPlayer.js` | FIFO WAV playback into the voice connection (ffmpeg → Opus) |
| `systemAudio.js` | `AUDIO_SOURCE=system`: streams the whole machine's audio out (parec on the sink monitor) |
| `textMirror.js` | Mirrors activity into a text channel ("Heard:"/"Replied:"), auto-creates `#claude-voice`, posts media |
| `mediaInbox.js` | Inbound media saved locally so the manager can open by path |
| `imageOutbox.js` | Outbound: watches a descriptor dir; manager drops `{image|video|text,caption}` JSON → posts to Discord |
| `bridgeStatus.js` | Heartbeats "linked + in a call" so the app can mute its local wake word |
| `receiverHealth.js` | Detects a silently-deaf voice receiver and auto-recovers (re-subscribe → rejoin ladder) |
| `appSettings.js` | Live-mirrors the desktop app's settings (wake phrase/enable/silence) |
| `dave.js` | DAVE (mandatory E2EE voice) presence check |
| `wav.js`/`log.js`/`doctor.js` | PCM→WAV wrapper; logger (mirrors into `[frontend]`); tokenless preflight checker |

**Support:** `service/` (systemd unit + install/uninstall), `tools/` (`make-link-key.js`, `post-image/text/video.js`), `run.sh`, `config.js` (no control creds), docs `README.md`/`SETUP.md`/`DISCORD_SETUP_GUIDE.md`, `python-receiver/README.md` (Python fallback investigated — not viable, doesn't decrypt DAVE).

**App & backend changes on the branch:**
- Wake-word mute during calls (`WakeWordManager.js`) — polls bridge-status and suppresses the local mic wake word while the bot is in a call; fails safe via heartbeat TTL. Plus VAD tuning + a TTS echo gate.
- Notification talk-over prevention (`NotificationManager.js`) — spoken notifications hold while the user speaks and **resume from where they paused** (never restart), with interruption caps + max-hold.
- New backend endpoints (`voice_transcription/`): `POST /api/voice/wake-check/` (CPU Vosk, new `wake_service.py`, no GPU) and `POST/GET /api/voice/bridge-status/` (8s TTL heartbeat).
- Backend security hardening: `terminal_backend/api_security.py` (opt-in `X-CCBOT-API-Token`), `DEBUG=false` default + required `SECRET_KEY`, `ALLOWED_HOSTS` allowlist, per-view throttles.
- Control-API hardening: `HookServer.js` rejects queueing to 999 at the HTTP boundary; `transcript-reader.js` confines reads to `~/.claude/projects`.
- Bug fixes: bare-shell guard re-check on the direct "send now" path (`MessageQueueManager.js`); revived dead usage-limit raw-output fallback (`UsageLimitManager.js`); ADB `screencap` binary-PNG corruption fix (`adb-manager.js`); new unit tests.

**IMPORTANT — untracked working-tree modules (functional in the tree, NOT yet committed to the branch):** `discord-bridge/src/`: `commands.js`, `session.js`, `mediaInbox.js`, `imageOutbox.js`, `textMirror.js`, `resumeStore.js`, `receiverHealth.js`, `systemAudio.js`, `wakeCheck.js`, `wakeWord.js`, `appSettings.js`, `linkManager.js`, `linkVault.js` — plus `backend/voice_transcription/wake_service.py`, `src/features/DiscordLinkKeyManager.js`, `discord-bridge/DISCORD_SETUP_GUIDE.md`, `discord-bridge/service/`, `discord-bridge/tools/`. (These match the `git status` "??" list.) They should be committed as part of finishing the branch.

**Experimental / caveat flags:** Discord voice-receive under DAVE is officially "unofficial" in @discordjs/voice (0.19.2 pinned); the Vosk wake-check endpoint needs a backend rebuild to activate (falls back to Whisper gating until then); `AUDIO_SOURCE=system` streams the machine's ENTIRE audio output, not just the manager.

---

## 5. README + showcase plan

### README assessment
Current top-level `README.md` (47 lines) is **accurate but ~40% complete**. It reads like a "message queue + terminal grid" tool and omits the features that actually define the app now.

**Missing:** the Manager (999), the wake word, spoken TTS notifications, the Discord bridge, the Manager view in the UI, the unified log stream, the first-run Vosk model download (~39 MB). **Stale:** voice labeled "experimental" (it's a mature multi-layer subsystem). **Adjacent cleanup:** `package.json` metadata is stale; `start.sh:414-451` still references a legacy `.bot-config`/`discord_bot.py` Python bot unrelated to the new `discord-bridge/` (flag, don't let the README document it). The `discord-bridge/` docs are current and good — link to them, don't duplicate.

**Proposed outline (~120-150 lines):** pitch + hero GIF → grouped features (Terminals & queueing / The Manager / Voice / Tracking) → the three showcase GIFs → "How it works" (hooks-not-parsing, the Manager loop, the backend) → Install & run (`./start.sh` Docker default / `--venv` / frontend-only, incl. the Vosk download + espeak-ng note) → Configuration highlights → a clearly-marked "Discord voice bridge (discord-integration branch)" section pointing to `DISCORD_SETUP_GUIDE.md` + `SETUP.md` → License/Acknowledgments (add Vosk + Kokoro). Keep the main-branch content as the body; scope the Discord section explicitly to the branch.

### Showcase-GIF feasibility
**Platform confirmed:** X11 (`XDG_SESSION_TYPE=x11`), Pop!_OS. **Installed:** `ffmpeg`, `scrot`, `xdotool`. **Not installed (optional upgrades):** `gifski`, `peek`, ImageMagick `convert`. Recipe (no installs needed):
```bash
# Record a fixed region (place the window there first; xdotool can position it):
ffmpeg -f x11grab -framerate 15 -video_size 1600x1000 -i :0.0+160,40 -c:v libx264 -preset ultrafast take.mp4
# Two-pass palette GIF:
ffmpeg -i take.mp4 -vf "fps=12,scale=960:-1:flags=lanczos,palettegen" pal.png
ffmpeg -i take.mp4 -i pal.png -filter_complex "fps=12,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer" out.gif
```
The capture-time crop (`+X,Y` offset + `-video_size`) is the single best privacy mitigation. GIFs carry no audio → voice features must prove themselves visually (status pills changing, transcription appearing) with a post-added caption overlay for the spoken line.

**Clean demo profile — the one move that neutralizes every showstopper:** a clean demo user account (fresh `~/.claude`, stock wallpaper, empty desktop, Do-Not-Disturb on) with a fresh checkout, a scratch manager directory (demo CLAUDE.md + a fake `routines/demo-routine.md`), 1-2 dummy projects ("demo-blog", "todo-cli"), and the isolated backend DB (§6). Close browser/Slack/Discord-desktop except where required.

**Three separate showcases:**

**(a) Manager instance — ~100% auto-capturable, no voice needed.**
Sequence: app with 2-3 idle demo terminals → click sidebar **Manager** → type into the Manager input ("check state of all terminals and queue a README task to terminal 1") → the manager's `GET /state`/`POST /queue/add` activity shows, the message lands in terminal 1's queue, terminal 1 flips idle→running (hook event), Action Log streams it → optional closer: terminal 1 finishes and the completion is pushed to the manager's queue. Drive by hand with ffmpeg running, or script via Playwright against the **isolated** instance (never the live app).

**(b) Wake word — now SELF-DRIVING via synthetic TTS (see §5.1); no live human voice required.**
Sequence: open Settings → Wake Word section (toggle, phrase, strictness) for ~3s → close → desktop visible, app possibly unfocused (the "works while hidden" money shot) → a synthesized wake-word clip is played into a virtual mic on cue → activation/chime moment → captured command appears, queued to the manager, manager view + Action Log react. Set the silence cutoff to ~2.5-3s for the demo so there's no dead tail. (Earlier plan said this needed the user to speak live — §5.1 removes that dependency.)

**(c) Voice mode — also SELF-DRIVING via synthetic TTS (see §5.1); the user is no longer strictly required.**
Sequence: script the mic-button click (recording state visible) → a synthesized command clip ("*add input validation to the signup form*") is played into the virtual mic within the record window → script the stop click → Whisper transcription lands in the message input (editable) → send/inject → message queued → injected → terminal flips to running → optional second act: terminal finishes and a spoken TTS notification appears in the Notifications tab. The mic-button clicks are scriptable (Playwright/xdotool on the isolated instance) and the audio is the same virtual-mic feed as (b).

**Confidential-exposure — four SHOWSTOPPERS, all killed by the clean demo profile:**
1. Real `ethan` username + `/media/ethan/smalls/...` paths in every shell prompt/tab.
2. The real manager directory / transcripts / routines (e.g. `lyra-music-optimization.md`) and `OPTIMIZATIONS.md`.
3. **The Pager API key in `~/.claude/CLAUDE.md`** — exposed if any on-screen Claude session prints its context or opens that file. (A demo account has its own `~/.claude` — strongest reason for the clean account.)
4. Persisted real queue/notification history in a reused profile/backend DB (survives restarts — a fresh profile + fresh DB is mandatory, not just a restart).
5. **The real wake word `"sean"`** — a personal name, visible in the Settings "Wake Word" field and any caption. Mitigation: set the isolated demo instance's wake word to a neutral phrase (e.g. "hey claude"); its own prefs mean the real value never appears (see §5.1).
Lesser risks (mitigated by cropping to the window + DND): tray icons, other windows, mic device names in the dropdown (don't open it), the `managerDirectory` path field in Settings (scroll directly to the Wake Word section, verify no real path is in frame).

**Auto vs user split, summarized:** with §5.1 (synthetic-TTS driving) all three are hands-off — the recorder, UI setup, on-screen reactions, AND the spoken wake word / voice command are auto-driven. The user is only needed to validate the live Discord leg (skipped for now) and to eyeball the final GIFs.

### 5.1 Self-driving wake-word (and voice-mode) via synthetic TTS

Goal: trigger the wake-word detector — and speak voice-mode commands — with a **synthesized** clip instead of a live human voice, so both the objective test and the showcase recording run themselves.

**Confirmed wake word (verified, not assumed):** the ACTUAL persisted phrase on this box is **`"sean"`** (from `~/.config/auto-injector/auto-injector.json`: `wakeWordPhrase:"sean"`, `wakeMatchThreshold:"0.95"` (near-exact), `wakeSilenceMs:"4500"`, `wakeWordEnabled:"true"`). The `'hey claude'` in `WakeWordManager.js:86` / `PreferenceManager.js:27` / bridge `appSettings.js:52` is only the DEFAULT; the live value is `sean`. This is corroborated by `discord-bridge/config.js:152`, which documents *"Vosk garbles short wake NAMES ('sean' → 'sure'/'shawn')"* and adds a Whisper-escalation fallback specifically because a short name is hard for the cheap Vosk gate.

**Implication of the short name + 0.95 threshold:** a synthetic "sean" is exactly the hard case the code already warns about — Vosk may garble it and 0.95 is near-exact, so a TTS clip is NOT guaranteed to trigger at the live settings. The plan treats "does the synth clip trigger?" as something to **validate**, with fallbacks, not assume (see steps below).

**Step 1 — synthesize the wake word to a WAV file.** The backend already exposes this: `POST /api/tts/speak/ {text:"sean"}` runs Kokoro (`tts_service.synthesize_to_file`, `text_to_speech/views.py:118`), stores `<id>.wav`, and it's downloadable via `GET /api/tts/audio/<id>/` (FileResponse). **Do this against the ISOLATED `:8124` backend, never live** — the LIVE app's `NotificationManager` polls `/api/tts/notifications/` and auto-reads new notifications aloud, so POSTing to `:8123` would make the live machine speak "sean" and pollute the live feed. (Alternative: call the Kokoro model directly inside the isolated backend container to synthesize a bare WAV with no Notification row. Preferred if we don't want a stray notification even on the test instance.) Pick a Kokoro voice that reads the name most clearly; also synthesize the voice-mode command clips (e.g. "add input validation to the signup form") the same way.

**Step 2 — route the WAV into the detector's mic input (PulseAudio virtual mic).** Tooling confirmed present: `pactl`, `pacmd`, `parec`, `paplay`, `ffmpeg`. `WakeWordManager` reads the mic via `navigator.mediaDevices.getUserMedia` (`:292-311`) and falls back to `{audio:true}` (the default source) when `microphoneDeviceId==='default'`. Plumbing (additive + fully reversible; run against the running Pulse daemon, unload when done):
```bash
# Create a null sink; its .monitor becomes a source, remapped to look like a mic.
SINK=$(pactl load-module module-null-sink sink_name=ccbot_test_sink \
       sink_properties=device.description=ccbot_test_sink)
MIC=$(pactl load-module module-remap-source master=ccbot_test_sink.monitor \
      source_name=ccbot_test_mic source_properties=device.description=ccbot_test_mic)
# On cue (while recording / during the test), play the clip INTO the sink:
paplay --device=ccbot_test_sink sean.wav
# Cleanup:
pactl unload-module "$MIC"; pactl unload-module "$SINK"
```
**Critical live-safety rule:** do NOT run `pactl set-default-source ccbot_test_mic` — changing the GLOBAL default source would hijack the LIVE app's wake-word mic (it could go deaf or false-trigger). Instead scope the virtual mic to the ISOLATED instance only, two safe options: (i) launch the test Electron with per-process env `PULSE_SOURCE=ccbot_test_mic` so only that process defaults to the virtual mic; or (ii) set the test instance's `microphoneDeviceId` preference to the enumerated virtual-mic device id (its own userData store, so live is untouched). Loading/unloading the null-sink module itself is harmless to live (it only adds a device); only default-source changes are dangerous.

**Step 3 — use it two ways.**
- **Objective test (isolated interface):** with the app listening, `paplay` the "sean" clip and assert the detector fires — subscribe to the `wake:state` event / the resulting `terminal:status:changed` or the urgent memo queued to the manager. If it does NOT trigger at live settings (likely, given the short-name/0.95 caveat), the test either lowers the isolated instance's `wakeMatchThreshold`, or uses a clearer multi-syllable demo phrase, or relies on the Whisper-escalation path — and the test documents which. This gives a real pass/fail on wake detection with no human.
- **Self-recording showcase:** start `ffmpeg x11grab`, then `paplay` the clip on cue; the GIF shows the app reacting. Add a caption overlay for the spoken line.

**Voice-mode reassessment:** YES — the same virtual mic drives voice mode too. Script the mic-button click (Playwright/xdotool on the isolated instance) → `paplay` the command clip within the record window → script the stop click → Whisper transcribes it into the input. Whisper is robust to clean synthetic speech, so voice mode is lower-risk than the wake word. Net: BOTH demos can be fully self-driving; no live human voice is required for either.

**Confidentiality of the wake word itself:** `"sean"` is a personal name and would be visible in the Settings "Wake Word" field and in captions. For a public showcase, set the **isolated demo instance's** wake word to a neutral phrase (e.g. "hey claude") — the demo instance has its own prefs, so this reveals nothing about the real configuration. The real `sean` value stays only in the live profile.

---

## 6. Isolated test-interface design

I mapped the live instance's footprint so the sandbox provably cannot collide.

**Live instance uses:** backend `127.0.0.1:8123` (compose project `claude-autorunner`, volume `ccbot-pgdata`); Postgres not host-exposed; Electron HookServer on a random loopback port + per-session token; default Electron userData (`~/.config/...`); link vault + outbox/inbox under `$XDG_RUNTIME_DIR/ccbot-bridge/`; real Discord bot token in `discord-bridge/.env`, real guild; hooks in `~/.claude/settings.json`.

**Test instance — every axis distinct:**

| Axis | Live | Isolated test | Mechanism |
|------|------|---------------|-----------|
| Backend port | `127.0.0.1:8123` | `127.0.0.1:8124` | override compose file, map `8124:8123` |
| Compose project / DB volume | `claude-autorunner` / `ccbot-pgdata` | `ccbot-test` / `ccbot-test-pgdata` | `COMPOSE_PROJECT_NAME=ccbot-test` |
| Backend secrets | live `.env` | own `SECRET_KEY`/PG creds/token | separate `.env.test` |
| Electron userData | `~/.config/...` | scratch dir | `--user-data-dir=<scratch>/ccbot-test-userdata` |
| `HOME` / `~/.claude` (hooks + manager sessions) | real | scratch HOME | run test Electron with `HOME=<scratch>` → hooks write to scratch `~/.claude`, manager boots clean |
| HookServer port | random loopback | random loopback (auto) | inherently non-colliding; verify at runtime ≠ live |
| Link vault / outbox / inbox | `$XDG_RUNTIME_DIR/ccbot-bridge` | scratch paths | `CCBOT_LINK_VAULT`, `CCBOT_IMAGE_OUTBOX`, `CCBOT_MEDIA_INBOX` |
| Manager dir | real | scratch demo dir + fake routines | set in the test userData store |
| Discord bot | real token, real guild | separate test bot + scratch guild, OR skip Discord leg | separate `.env.test` (see Decision B) |
| Mic / wake audio | real hardware mic (default source) | dedicated PulseAudio virtual mic (`ccbot_test_mic`) | `module-null-sink` + `module-remap-source`; scope to the test process via `PULSE_SOURCE=ccbot_test_mic` — NEVER global `set-default-source` (would hijack live's wake mic). See §5.1. |

**Pre-launch collision checklist (verify every launch):** distinct backend port ✓ · distinct compose project/volume ✓ · distinct userData ✓ · distinct HOME/`~/.claude` ✓ · distinct vault/outbox/inbox ✓ · HookServer port ≠ live at runtime ✓ · no second bridge on the live bot token ✓. Never run `start.sh`/`npm start` in a way that hits the live profile or ports.

### Decisions — RESOLVED (user approved Phase 2)

- **Decision A → DEDICATED `:8124` backend** with the `CCBOT_BACKEND_URL` override (Option A1). Full data isolation; not sharing live `:8123`.
- **Decision B → SKIP provisioning a live test Discord bot** (Option B2) for now. The Discord user allow-list security fix is still implemented and unit/logic-tested without a live bot; the user verifies the live Discord leg later.
- **ADB → REMOVE.** Dead per the audit; the commit log / OPTIMIZATIONS.md will explain what the ADB (Android Debug Bridge) call was for and where it came from, then remove it.

The original analysis for each decision is retained below for the record.

**Decision A — test backend: dedicated `:8124` vs share live `:8123`.**
The frontend hardcodes `http://localhost:8123` in ~8 places (`VoiceManager.js`, `WakeWordManager.js:75`, `NotificationManager.js:14`, `ActionLogManager.js:13`, `renderer.js:1079,2270`). So a test app pointed at `:8124` first needs a small `CCBOT_BACKEND_URL` env override added to those modules — which is itself a legitimate improvement (the hardcoding is a wiring smell).
- **Option A1 (recommended):** dedicated `:8124` backend with its own DB volume + the URL override. Full data isolation — required for clean showcase notification/queue history and for exercising the wake-check/bridge-status endpoints without touching live rows.
- **Option A2:** test app shares the live `:8123` backend (zero code change). Fine for wiring/UI tests, but writes to the shared Postgres (queue/logs/notifications) — not clean for showcases.
- **Recommendation:** A1.

**Decision B — Discord leg: dedicated test bot vs skip.**
A second bridge on the **live** bot token would disconnect the live bot (that would disturb live — not allowed).
- **Option B1:** provision a dedicated test bot token + a scratch test guild for full end-to-end Discord testing.
- **Option B2 (default if you don't provision one):** don't launch a second bridge; test the control/link path (linkVault, controlApi, HookServer) directly without Discord.
- **Recommendation:** B2 unless you want the Discord voice loop demonstrated end-to-end, in which case B1 with a throwaway bot.

**ADB question.** `src/adb/adb-manager.js` + `device-manager.js` are unwired from the UI but were recently bug-fixed (commit `277de25`) and discussed in `OPTIMIZATIONS.md` — they look like intentionally-parked future work rather than forgotten code. **Keep parked (delete only the demo/example files), or cut the whole `src/adb/` tree?** The `adb-demo.js` / `adb-integration-example.js` files are dead by any reading regardless.

---

## Prioritized Phase 2 ordering (on approval)

1. **Provision the isolated test interface** (incl. the `CCBOT_BACKEND_URL` override per Decision A) and run the collision checklist. Nothing else starts until the sandbox is verified distinct from live.
2. **Security fixes:** 1.1 Discord allow-list (first), 1.3 timing-safe token compare, 1.5 outbox path containment, 1.7 log newline strip. (1.2 as a threat-model note; 1.6 as guidance.)
3. **Wiring fixes**, in impact order, each verified in the sandbox: (i) `terminal-error` path; (ii) `injection:started/completed` naming; (iii) renderer→main bridges (`ui:tray-badge`, `ui:system-notification`, `power:save-blocker:*`) + tray Start/Stop listeners + `keepScreenAwake`; (iv) Manager settings UI (`managerPromptWatchEnabled`, `managerAutoPassEnabled`, `managerPassIntervalMinutes`); (v) file-attach cluster + `terminal-scroll-behavior` + search overlay; (vi) `NotificationManager.stopPolling()` teardown; (vii) `LinkManager.linkFromVault()` fix or removal.
4. **Wire-vs-delete decisions** resolved: InjectionManager, the MQM legacy sequential engine, the dead preference keys.
5. **Dead-code removal** (§2 HIGH set) — after the ADB call: the four dead directories, the two superseded duplicates + `ipc-handler.js`, the dead `src/utils/` + top-level `utils/` files, the unused imports, the two backend Python files, the orphaned docs image, and the orphaned CSS clusters.
6. **README rewrite** (both branches) + `package.json`/legacy-`start.sh`-bot cleanup.
7. **Showcase GIFs:** auto-capture the Manager demo in the sandbox; deliver an exact shot-list + the one-command recording recipe for the wake-word and voice-mode takes the user records live.
8. **Log every change** in plain English to `OPTIMIZATIONS.md`.

**Status:** APPROVED. Decisions A (dedicated `:8124`), B (skip live test bot), and ADB (remove) are settled above. Phase 2 proceeds under the standing safety rules (never restart/kill the live app/control-API/bridge/terminal 999; all running/testing on the isolated instance with verified-distinct ports/token/paths; stay on `discord-integration`; no commits; log every change to `OPTIMIZATIONS.md`).
