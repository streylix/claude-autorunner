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

class ManagerInstance {
    constructor(eventBus, appStateStore, ipcHandler, gui) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        this.ipc = ipcHandler;
        this.gui = gui;
        this.running = false;
        this.directory = null;
        this.tabVisible = false;
    }

    // ======= UI: grid tab toggle + setup overlay =======
    initializeUI() {
        this.setupOverlay = document.getElementById('manager-setup');

        const toggleBtn = document.getElementById('manager-tab-btn');
        const startBtn = document.getElementById('manager-start-btn');
        const cancelBtn = document.getElementById('manager-setup-cancel-btn');
        const dirInput = document.getElementById('manager-directory-input');

        if (toggleBtn) toggleBtn.addEventListener('click', () => this.toggleVisible());
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                if (this.setupOverlay) this.setupOverlay.style.display = 'none';
            });
        }
        if (startBtn && dirInput) {
            startBtn.addEventListener('click', async () => {
                const dir = dirInput.value.trim();
                if (!dir) return;
                await this.ipc.invoke('db-set-setting', 'managerDirectory', dir);
                const ok = await this.start(dir);
                if (ok) {
                    if (this.setupOverlay) this.setupOverlay.style.display = 'none';
                    this.setVisible(true);
                }
            });
        }
    }

    /** Bot button: reveal/conceal the Manager tab in the terminal grid. */
    toggleVisible() {
        if (!this.running) {
            // Not running: offer setup (or boot from saved config if present)
            this.startIfConfigured().then((started) => {
                if (started) {
                    this.setVisible(true);
                } else if (this.setupOverlay) {
                    this.setupOverlay.style.display = '';
                }
            });
            return;
        }
        const terminalData = this.gui.terminals.get(MANAGER_TERMINAL_ID);
        if (!terminalData) return;
        this.setVisible(terminalData.container.classList.contains('manager-hidden'));
    }

    setVisible(visible) {
        const terminalData = this.gui.terminals.get(MANAGER_TERMINAL_ID);
        if (!terminalData) return;

        terminalData.container.classList.toggle('manager-hidden', !visible);
        const btn = document.getElementById('manager-tab-btn');
        if (btn) btn.classList.toggle('active', visible);

        if (visible) {
            requestAnimationFrame(() => {
                terminalData.fitAddon.fit();
                this.gui.setActiveTerminal(MANAGER_TERMINAL_ID);
            });
        } else if (this.gui.activeTerminalId === MANAGER_TERMINAL_ID) {
            // Hand focus back to the first visible terminal
            const next = Array.from(this.gui.terminals.keys()).find((id) => id !== MANAGER_TERMINAL_ID);
            if (next !== undefined) this.gui.setActiveTerminal(next);
        }

        this.eventBus.emit('manager:visibility', { visible });
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
            hidden: true,
            skipActive: true,
            title: 'Manager',
            lockTitle: true,
            cssClass: 'manager-terminal',
            color: 'var(--accent-warning)'
        });

        // Boot claude once the shell settles - resume if a session exists
        const bootCommand = prep.resumable ? 'claude --continue\n' : 'claude\n';
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
        this.eventBus.emit('manager:started', { directory: managerDir, resumed: prep.resumable });
        this.eventBus.emit('log:action', {
            message: `Manager instance ${prep.resumable ? 'resumed' : 'started'} in ${managerDir}`,
            type: 'success'
        });
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
        this.gui.closeTerminal(MANAGER_TERMINAL_ID);
        this.running = false;
        this.eventBus.emit('manager:stopped', {});
        this.eventBus.emit('log:action', { message: 'Manager instance stopped', type: 'warning' });
    }
}

ManagerInstance.TERMINAL_ID = MANAGER_TERMINAL_ID;

module.exports = ManagerInstance;
