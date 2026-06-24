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
const MANAGER_TERMINAL_ID = 999;
const CLAUDE_BOOT_DELAY_MS = 1500; // let the shell prompt settle before typing
const DEFAULT_PASS_INTERVAL_MIN = 60;
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
        // Completion watching: push every other terminal's finish (with its
        // last message) into the manager's own queue so it can chain follow-up
        // work autonomously. Set from the managerCompletionWatchEnabled setting
        // in start(); the subscription is wired once here and gated at fire time.
        this.completionWatchEnabled = true;
        this.eventBus.on('completion:recorded', (data) => this.onTerminalCompletion(data));
    }

    /**
     * React to another terminal finishing a Claude turn. The Stop hook's
     * last-assistant text (captured in main, emitted as completion:recorded)
     * is pushed into the manager's queue so it can decide whether the work is
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
        this.stopPassLoop();
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

        // Arm the recurring optimization-pass loop unless explicitly disabled.
        let autoPass = this.appStateStore.getState('managerAutoPassEnabled');
        if (autoPass == null) {
            try { autoPass = await this.ipc.invoke('db-get-setting', 'managerAutoPassEnabled'); } catch { /* default on */ }
        }
        if (autoPass !== false && autoPass !== 'false') {
            this.startPassLoop();
        }

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
        this.gui.closeTerminal(MANAGER_TERMINAL_ID);
        this.running = false;
        this.updateView(); // restore the setup form in the sidebar tab
        this.eventBus.emit('manager:stopped', {});
        this.eventBus.emit('log:action', { message: 'Manager instance stopped', type: 'warning' });
    }
}

ManagerInstance.TERMINAL_ID = MANAGER_TERMINAL_ID;

module.exports = ManagerInstance;
