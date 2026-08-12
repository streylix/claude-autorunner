/**
 * ManagerInstance - The hidden Claude session that manages the interface
 *
 * A real `claude` CLI session in a concealed PTY (terminal id 999), spawned in a
 * user-configured directory. Its role comes from a CLAUDE.md written into that
 * directory (control API usage, transcript reading, OPTIMIZATIONS.md logging);
 * its credentials come from the CCBOT_* env vars every app PTY inherits.
 *
 * On app restart it resumes its previous conversation via `claude --continue`
 * when Claude Code has session files for the manager directory, else starts
 * fresh with `claude`.
 */
const { resetTime24ToDate } = require('../utils/usage-limit-parser');

const MANAGER_TERMINAL_ID = 999;
const CLAUDE_BOOT_DELAY_MS = 1500; // let the shell prompt settle before typing
const DEFAULT_PASS_INTERVAL_MIN = 60;
// ---- Nightly context clear ----
const DEFAULT_NIGHTLY_CLEAR_HOUR = 0; // local midnight
const NIGHTLY_CLEAR_COMMAND = '/clear';
// After the injector's Enter, send one more. See onMessageInjected for why.
const NIGHTLY_CLEAR_CONFIRM_MS = 900;
// When re-arming right after a fire, look ahead from slightly past "now" so a
// timer that lands a hair early can't compute the SAME midnight again and
// clear twice for one night.
const NIGHTLY_CLEAR_REARM_SKEW_MS = 60 * 1000;
// The standing instruction dispatched on each scheduled pass. The manager
// interprets it against the routines in its own directory (CLAUDE.md).
// Reinforces the orchestration model: the manager dispatches to other
// terminals, it does not do the project work itself.
const PASS_INSTRUCTION =
    "Scheduled optimization pass. You are the orchestrator - do NOT edit any " +
    "project yourself. For each standing routine in your routines/ directory " +
    "(per your CLAUDE.md): check /state, and for the routine's target terminal " +
    "(create/start it if needed), queue the next instruction to THAT terminal's " +
    "Claude and read its transcript to decide follow-ups. Skip terminals that " +
    "are running or prompted; never target yourself (999); one issue per pass.";

class ManagerInstance {
    constructor(eventBus, appStateStore, ipcHandler, gui) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        this.ipc = ipcHandler;
        this.gui = gui;
        this.running = false;
        this.directory = null;
        this.tabVisible = false;
        this.passTimer = null; // recurring optimization-pass interval
        this.nightlyClearTimer = null; // nightly /clear (self-rescheduling setTimeout)
        this.nightlyClearAt = null;    // Date the armed timer is aiming at
        // Completion watching: push every other terminal's finish (with its
        // last message) into the manager's own queue so it can chain follow-up
        // work autonomously. Set from the managerCompletionWatchEnabled setting
        // in start(); the subscription is wired once here and gated at fire time.
        this.completionWatchEnabled = true;
        // terminalId -> bounded history (array, oldest first) of recently pushed
        // completion texts (now the tail of the terminal's live screen buffer -
        // see renderer.js's 'stop' hook handling - not a transcript extraction).
        // Claude Code can fire several genuine Stop hooks in quick succession for
        // what looks like one logical turn, so consecutive pushes can repeat.
        // Comparing only against the LAST push let an intermediate text
        // re-surface and re-queue after a different/newer completion had already
        // superseded it (A, B, A all passed) — a stale, already-delivered message
        // could sit duplicated and unsent in the manager's queue. Keeping a short
        // history so any recently-seen text is deduped, not just the latest.
        this._lastCompletionText = new Map();
        this._completionHistoryLimit = 5;
        this.eventBus.on('completion:recorded', (data) => this.onTerminalCompletion(data));
        this.eventBus.on('message:injected', (data) => this.onMessageInjected(data));
    }

    /**
     * React to another terminal finishing a Claude turn. On a Stop hook,
     * renderer.js captures the TAIL of that terminal's live screen buffer
     * (same capture as /terminal/screen, length set by the
     * managerCompletionTailChars setting, default 1500 chars) and emits it as
     * completion:recorded — the screen buffer is always the terminal's actual
     * current state, so unlike a transcript "last assistant message" lookup
     * there's no "which Stop hook / which message" staleness. That tail is
     * pushed into the manager's queue so it can decide whether the work is
     * done or needs a follow-up. By design there is NO mechanical loop cap -
     * the manager's own judgment ("this terminal's work is complete, do
     * nothing") is the only brake. Self-exclusion (999) prevents the manager
     * reacting to its own turns, which would loop forever.
     */
    onTerminalCompletion(data) {
        if (!this.running || !this.completionWatchEnabled) return;
        if (!data || data.terminalId == null) return;
        if (data.terminalId === MANAGER_TERMINAL_ID) return; // never react to self
        const terminal = this.gui.terminalStateManager.getTerminal(data.terminalId);
        const title = (terminal && terminal.title) || `Terminal ${data.terminalId}`;
        const dir = data.directory ? ` in ${data.directory}` : '';
        const text = (data.text || '').trim() || '(no message text)';
        // Legacy safety net: a bare "[tool_use: …]" marker (the old transcript
        // extraction's shape for a tool-only turn) carries nothing worth a
        // manager turn. The screen-buffer tail won't produce this shape, but
        // it's a harmless no-op check to leave in place.
        if (/^\[tool_use:.*\]$/.test(text)) return;
        // Drop a re-push identical to any recently-seen text from this terminal
        // (not just the immediately-previous one — see the field comment above).
        const history = this._lastCompletionText.get(data.terminalId) || [];
        if (history.includes(text)) return;
        history.push(text);
        if (history.length > this._completionHistoryLimit) history.shift();
        this._lastCompletionText.set(data.terminalId, history);
        // Dynamic facts only — how to announce/decide is standing guidance in the
        // manager's CLAUDE.md (the "Completions are pushed to you" and "Spoken
        // notifications" sections), so it is NOT repeated per message.
        const note =
            `Terminal ${data.terminalId} ("${title}")${dir} just finished. Its last message:\n\n` +
            `${text}`;
        this.dispatch(note);
    }

    /**
     * Live on/off for routing terminal completions to the manager. The user can
     * flip this from the Notifications tab / settings when the volume gets
     * overwhelming; the completion:recorded subscription stays wired and is
     * gated here at fire time (see onTerminalCompletion).
     */
    setCompletionWatchEnabled(enabled) {
        this.completionWatchEnabled = !!enabled;
        try {
            this.eventBus.emit('log:action', {
                message: `Manager input ${this.completionWatchEnabled ? 'enabled' : 'paused'} — completions ${this.completionWatchEnabled ? 'will be' : 'will not be'} sent to the manager`,
                type: 'info',
            });
        } catch (_) { /* ignore */ }
    }

    // ======= RECURRING OPTIMIZATION PASSES =======
    /**
     * Start the recurring pass loop. Independent of the user-facing auto-inject
     * timer ON PURPOSE: arming that timer sets the injection gate's
     * isRunning()=true and would block all injection. This loop just dispatches
     * the standing pass instruction to the manager's queue every interval; the
     * queue + gate handle idle-waiting, so passes never pile up or interrupt
     * running work.
     * @param {number} [intervalMs] - override (tests); defaults to the setting
     */
    async startPassLoop(intervalMs) {
        // Disabled permanently — see OPTIMIZATIONS.md. Left in place (dead)
        // rather than deleted so the interval-scheduling logic isn't lost.
        this.stopPassLoop();
        return;
        // eslint-disable-next-line no-unreachable
        let ms = intervalMs;
        if (ms == null) {
            let mins = this.appStateStore.getState('managerPassIntervalMinutes');
            if (mins == null) {
                try { mins = await this.ipc.invoke('db-get-setting', 'managerPassIntervalMinutes'); } catch { /* default below */ }
            }
            ms = (Number(mins) > 0 ? Number(mins) : DEFAULT_PASS_INTERVAL_MIN) * 60 * 1000;
        }
        this.passTimer = setInterval(() => this.dispatchPass(), ms);
        this.eventBus.emit('log:action', {
            message: `Manager auto-pass loop armed (every ${Math.round(ms / 60000)} min)`,
            type: 'info'
        });
    }

    stopPassLoop() {
        if (this.passTimer) {
            clearInterval(this.passTimer);
            this.passTimer = null;
        }
    }

    /** Queue one optimization pass for the manager (gated like any dispatch). */
    dispatchPass() {
        if (!this.running) return false;
        // Don't stack passes: skip if a prior pass is still queued for 999
        const alreadyQueued = this.gui.messageQueueManager.messageQueue
            .some((m) => m.terminalId === MANAGER_TERMINAL_ID);
        if (alreadyQueued) {
            this.eventBus.emit('log:action', {
                message: 'Manager pass skipped - previous instruction still queued',
                type: 'info'
            });
            return false;
        }
        return this.dispatch(PASS_INSTRUCTION);
    }

    // ======= NIGHTLY CONTEXT CLEAR =======
    /**
     * The manager is a long-lived session: completion pushes, prompt watches and
     * stuck-watch notes accumulate in its context all day. This arms a daily
     * `/clear` so it starts each day lean.
     *
     * Mechanism: the clear is ENQUEUED to the manager's own queue (id 999) via
     * the same dispatch() path dispatchPass() uses — NOT written straight to the
     * PTY. That's deliberate: the message queue's injection gate only injects
     * when the target terminal is idle, so a clear armed for midnight lands at
     * the first idle moment at-or-after midnight and can never truncate a turn
     * the manager is in the middle of. A direct PTY write would need that
     * idle-check reimplemented here and would still race a turn that starts
     * between the check and the write.
     *
     * @param {{hour?: number, enabled?: boolean}} [opts] - overrides (tests)
     * @returns {Promise<Date|null>} the armed fire time, or null if not armed
     */
    async startNightlyClear(opts = {}) {
        this.stopNightlyClear(); // never double-arm

        let enabled = opts.enabled;
        if (enabled == null) {
            enabled = this.appStateStore.getState('managerNightlyClearEnabled');
            if (enabled == null) {
                try { enabled = await this.ipc.invoke('db-get-setting', 'managerNightlyClearEnabled'); } catch { /* default on */ }
            }
        }
        // Default ON: only an explicit false disables it.
        if (enabled === false || enabled === 'false') return null;

        let hour = opts.hour;
        if (hour == null) {
            hour = this.appStateStore.getState('managerNightlyClearHour');
            if (hour == null) {
                try { hour = await this.ipc.invoke('db-get-setting', 'managerNightlyClearHour'); } catch { /* default below */ }
            }
        }
        hour = Number(hour);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) hour = DEFAULT_NIGHTLY_CLEAR_HOUR;

        const next = this._armNightlyClear(hour);
        if (next) {
            this.eventBus.emit('log:action', {
                message: `Manager nightly /clear armed for ${next.toLocaleString()}`,
                type: 'info'
            });
        }
        return next;
    }

    /**
     * The next local wall-clock time the clear should fire. Delegates to the
     * usage-limit parser's cross-midnight builder: it constructs hour:00 on
     * today's LOCAL calendar date and rolls to tomorrow when that moment has
     * already passed.
     * @returns {Date|null}
     */
    nextNightlyClearAt(hour, now = new Date()) {
        return resetTime24ToDate(hour, 0, now);
    }

    /**
     * Arm one shot and re-arm from scratch after it fires. Recomputing the
     * wall-clock target each night (rather than adding a fixed 24h) is what
     * keeps it pinned to local midnight across DST shifts — on a 23- or 25-hour
     * day the next delay is simply shorter or longer.
     * @param {Date} [reference] - compute the next fire relative to this instant
     */
    _armNightlyClear(hour, reference = new Date()) {
        this.stopNightlyClear();
        const next = this.nextNightlyClearAt(hour, reference);
        if (!next) return null;
        const delay = Math.max(0, next.getTime() - Date.now());
        this.nightlyClearAt = next;
        this.nightlyClearTimer = setTimeout(() => {
            this.nightlyClearTimer = null;
            this.dispatchNightlyClear();
            // Re-arm from just past now so an early-firing timer can't re-target
            // the midnight that just passed.
            this._armNightlyClear(hour, new Date(Date.now() + NIGHTLY_CLEAR_REARM_SKEW_MS));
        }, delay);
        return next;
    }

    stopNightlyClear() {
        if (this.nightlyClearTimer) {
            clearTimeout(this.nightlyClearTimer);
            this.nightlyClearTimer = null;
        }
        this.nightlyClearAt = null;
    }

    /** Queue the nightly `/clear` for the manager (injects when it goes idle). */
    dispatchNightlyClear() {
        if (!this.running) return false;
        // Don't stack: if last night's clear is somehow still waiting for the
        // manager to go idle, queueing another would clear twice in a row.
        const alreadyQueued = (this.gui.messageQueueManager.messageQueue || [])
            .some((m) => m.terminalId === MANAGER_TERMINAL_ID && m.content === NIGHTLY_CLEAR_COMMAND);
        if (alreadyQueued) {
            this.eventBus.emit('log:action', {
                message: 'Manager nightly /clear skipped - one is still queued',
                type: 'info'
            });
            return false;
        }
        return this.dispatch(NIGHTLY_CLEAR_COMMAND);
    }

    /**
     * Follow the injected `/clear` with one extra Enter.
     *
     * Claude Code pops its slash-command palette as `/clear` is typed. If that
     * palette is still open when the injector's Enter (sent 150ms after the
     * text) lands, the Enter is consumed accepting the highlighted entry rather
     * than running it, and the command sits in the input box unsent. A second
     * Enter converges both ways: if `/clear` already ran, this lands on an empty
     * prompt and does nothing; if the palette ate the first one, this submits.
     * Scoped to the manager's own `/clear` so ordinary injection is untouched.
     */
    onMessageInjected(data) {
        if (!data || data.terminalId !== MANAGER_TERMINAL_ID) return;
        if (data.content !== NIGHTLY_CLEAR_COMMAND) return;
        if (!this.ipc || typeof this.ipc.send !== 'function') return;
        setTimeout(() => {
            try {
                this.ipc.send('terminal-input', { terminalId: MANAGER_TERMINAL_ID, data: '\r' });
            } catch (_) { /* terminal gone */ }
        }, NIGHTLY_CLEAR_CONFIRM_MS);
    }

    // ======= UI: left-sidebar Manager tab =======
    // The manager is no longer a hidden grid terminal toggled in/out of the
    // main view. It lives in its own left-sidebar tab (#manager-view) alongside
    // Action Log / Completions / Pricing: a setup form until a directory is
    // configured, then the manager terminal mounted in #manager-terminal-mount.
    initializeUI() {
        this.setupForm = document.getElementById('manager-setup');
        this.terminalMount = document.getElementById('manager-terminal-mount');

        const navBtn = document.getElementById('manager-nav-btn');   // sidebar tab button
        const startBtn = document.getElementById('manager-start-btn');
        const dirInput = document.getElementById('manager-directory-input');

        if (startBtn && dirInput) {
            // Repopulate the field with the persisted directory so a restart
            // shows the saved path (the setting persists fine; the form just
            // never reflected it, which read as "it didn't save"). If the saved
            // dir is gone, auto-start fails silently — at least the user can see
            // and correct the path here instead of facing a blank field.
            this.ipc.invoke('db-get-setting', 'managerDirectory')
                .then(saved => { if (saved && !dirInput.value.trim()) dirInput.value = saved; })
                .catch(() => { /* settings store unavailable - leave field blank */ });

            startBtn.addEventListener('click', async () => {
                const dir = dirInput.value.trim();
                if (!dir) return;
                await this.ipc.invoke('db-set-setting', 'managerDirectory', dir);
                await this.start(dir);
            });
        }

        // When the Manager tab is revealed: boot it if configured, then re-fit +
        // focus the terminal (fit() on a hidden tab computes garbage dimensions).
        this.eventBus.on('ui:sidebar-view-changed', ({ viewId }) => {
            const active = viewId === 'manager-view';
            if (navBtn) navBtn.classList.toggle('active', active);
            if (!active) return;
            if (!this.running) this.startIfConfigured();
            this.updateView();
            const td = this.gui.terminals.get(MANAGER_TERMINAL_ID);
            if (td) requestAnimationFrame(() => {
                try { td.fitAddon.fit(); } catch { /* not laid out */ }
                td.terminal.focus();
            });
        });

        this.updateView();
    }

    /** Setup form vs. mounted terminal, driven by whether the manager runs. */
    updateView() {
        const running = this.running;
        if (this.setupForm) this.setupForm.style.display = running ? 'none' : '';
        if (this.terminalMount) this.terminalMount.style.display = running ? '' : 'none';
    }

    isConfigured() {
        return !!this.appStateStore.getState('managerDirectory');
    }

    isRunning() {
        return this.running;
    }

    /** Start the manager if a directory is configured (called at app init). */
    async startIfConfigured() {
        // Prefer in-memory state, fall back to the app's persistent settings
        // store (set via: ipcRenderer.invoke('db-set-setting', 'managerDirectory', dir))
        let dir = this.appStateStore.getState('managerDirectory');
        if (!dir) {
            try {
                dir = await this.ipc.invoke('db-get-setting', 'managerDirectory');
            } catch { /* settings store unavailable - stay disabled */ }
        }
        const enabled = this.appStateStore.getState('managerEnabled');
        if (!dir || enabled === false) return false;
        return this.start(dir);
    }

    async start(managerDir) {
        if (this.running) return true;

        // Remote Mode (docs/REMOTE_MODE.md): a browser renderer ATTACHES to the
        // already-running manager instead of driving it. Build the xterm view
        // for 999 (the RemoteServer attaches it to the live PTY and replays the
        // screen instead of respawning), but do NOT boot claude, arm the pass
        // loop, or react to completions — the local renderer owns all of that.
        // Running both would double-type into the manager and double-dispatch.
        if (typeof window !== 'undefined' && window.__CCBOT_REMOTE__) {
            this.directory = managerDir;
            this.gui.createTerminal({
                id: MANAGER_TERMINAL_ID,
                directory: managerDir,
                mountTarget: document.getElementById('manager-terminal-mount'),
                noWebgl: true,
                skipActive: true,
                title: 'Manager',
                lockTitle: true,
                cssClass: 'manager-terminal',
                color: 'var(--accent-warning)'
            });
            this.running = true;
            this.completionWatchEnabled = false; // dispatch loop is local-only
            this.updateView();
            this.eventBus.emit('log:action', {
                message: `Attached to the manager instance in ${managerDir} (remote view)`,
                type: 'info'
            });
            return true;
        }

        // Main process validates the dir, writes the role CLAUDE.md if absent,
        // and checks ~/.claude/projects/<munged>/ for a resumable session.
        const prep = await this.ipc.invoke('manager-prepare', managerDir);
        if (!prep || !prep.ok) {
            this.eventBus.emit('log:action', {
                message: `Manager not started: ${prep ? prep.error : 'prepare failed'} (${managerDir})`,
                type: 'error'
            });
            return false;
        }

        this.directory = managerDir;
        this.gui.createTerminal({
            id: MANAGER_TERMINAL_ID,
            directory: managerDir,
            // Mount into the left-sidebar Manager tab, not the main grid.
            mountTarget: document.getElementById('manager-terminal-mount'),
            noWebgl: true, // tab is hidden until selected; don't burn a WebGL context
            skipActive: true,
            title: 'Manager',
            lockTitle: true,
            cssClass: 'manager-terminal',
            color: 'var(--accent-warning)'
        });

        // Boot claude once the shell settles - resume if a session exists.
        // Auto mode (--permission-mode auto): the manager runs unattended and
        // lets Claude Code auto-handle permissions, but does NOT use
        // --dangerously-skip-permissions (full bypass). Its allow/deny rules in
        // .claude/settings.local.json plus the HookServer token still fence off
        // risky ops. Written by manager-prepare before this boots.
        const bootCommand = prep.resumable
            ? 'claude --continue --permission-mode auto\n'
            : 'claude --permission-mode auto\n';
        setTimeout(() => {
            this.ipc.send('terminal-input', {
                terminalId: MANAGER_TERMINAL_ID,
                data: bootCommand
            });
        }, CLAUDE_BOOT_DELAY_MS);

        // First boot in a fresh directory hits Claude Code's folder-trust
        // dialog ("1. Yes, trust" is preselected). The manager dir is
        // user-chosen and app-bootstrapped, so confirm it; if claude is
        // already past the dialog this is a harmless empty Enter.
        if (!prep.resumable) {
            setTimeout(() => {
                this.ipc.send('terminal-input', {
                    terminalId: MANAGER_TERMINAL_ID,
                    data: '\r'
                });
            }, CLAUDE_BOOT_DELAY_MS + 5000);
        }

        this.running = true;
        this.updateView(); // swap the setup form for the dispatch input + terminal
        this.eventBus.emit('manager:started', { directory: managerDir, resumed: prep.resumable });
        this.eventBus.emit('log:action', {
            message: `Manager instance ${prep.resumable ? 'resumed' : 'started'} in ${managerDir}`,
            type: 'success'
        });

        // Recurring optimization-pass loop permanently disabled — see
        // OPTIMIZATIONS.md. startPassLoop()/dispatchPass() are kept as dead
        // code but never called; stopPassLoop() guards against any stray timer.
        this.stopPassLoop();

        // Nightly context clear: default on, local midnight. Armed here (after
        // the Remote Mode early-return above) so only the LOCAL renderer that
        // owns the manager schedules it — a browser viewer must not also fire a
        // /clear into the shared session.
        await this.startNightlyClear();

        // Completion watching (autonomous work-loop): default on. When enabled,
        // every other terminal's finish is pushed into the manager's queue.
        let watch = this.appStateStore.getState('managerCompletionWatchEnabled');
        if (watch == null) {
            try { watch = await this.ipc.invoke('db-get-setting', 'managerCompletionWatchEnabled'); } catch { /* default on */ }
        }
        this.completionWatchEnabled = !(watch === false || watch === 'false');
        return true;
    }

    /** Queue an instruction for the manager (injects when it's idle). */
    dispatch(instruction) {
        // Remote Mode: automated dispatches (completion watch, prompt watch,
        // pass loop) belong to the local renderer alone. User-typed messages to
        // 999 still work remotely via the queue's remote-queue-add forwarding.
        if (typeof window !== 'undefined' && window.__CCBOT_REMOTE__) return false;
        if (!this.running || !instruction) return false;
        this.gui.messageQueueManager.addMessage({
            content: instruction,
            terminalId: MANAGER_TERMINAL_ID
        });
        this.eventBus.emit('log:action', {
            message: 'Instruction queued for manager instance',
            type: 'info'
        });
        return true;
    }

    stop() {
        if (!this.running) return;
        this.stopPassLoop();
        this.stopNightlyClear();
        this.gui.closeTerminal(MANAGER_TERMINAL_ID);
        this.running = false;
        this.updateView(); // restore the setup form in the sidebar tab
        this.eventBus.emit('manager:stopped', {});
        this.eventBus.emit('log:action', { message: 'Manager instance stopped', type: 'warning' });
    }
}

ManagerInstance.TERMINAL_ID = MANAGER_TERMINAL_ID;

module.exports = ManagerInstance;
