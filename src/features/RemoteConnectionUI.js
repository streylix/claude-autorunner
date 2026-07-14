/**
 * RemoteConnectionUI - the bottom-left "remote" indicator (the VS Code
 * Remote-SSH corner control), the TOP-MIDDLE ssh command bar, and the
 * embedded remote view. CLIENT half of web-served Remote Mode
 * (docs/REMOTE_MODE.md §8).
 *
 * Flow (all heavy lifting is in main's src/main/remote-client.js):
 *   - click the corner indicator → a command bar drops in at the TOP-MIDDLE
 *     of the interface. The user types a REAL, editable ssh command —
 *     `ssh ethan@pop-os`, `ssh host -p 2222`, `user@host` — parsed by
 *     src/features/ssh-command-parse.js. Advanced options (remote session
 *     file path, extra ssh options like -i, and the remote app directory
 *     for auto-start) fold out under the bar.
 *   - Connect invokes `remote-client-connect`; main reads the remote's
 *     ~/.config/ccbot/session.json over ssh and — if the remote is NOT
 *     already serving Remote Mode — AUTO-STARTS it there (live-enable via
 *     the remote's Control API when the app is running, headless
 *     CCBOT_REMOTE=1 launch when it isn't), then opens the -L tunnel and
 *     returns a loopback URL (token in the fragment). Progress for each of
 *     those phases is pushed on `remote-client-status` and shown in the
 *     bar's status line, so an auto-start never looks like a hang.
 *   - the URL is loaded in an <iframe> covering the app — the full remote
 *     interface, 1:1 interactive. The indicator turns green ("Remote:
 *     host"); clicking it while connected opens the bottom-left management
 *     popover (connection info + Disconnect).
 *   - disconnect or an unexpected tunnel drop tears the view down and
 *     returns to the local interface (reopening the command bar).
 *
 * The token only ever appears inside the iframe src fragment pointing at
 * 127.0.0.1:<localPort> — it is never rendered, stored, or logged here.
 *
 * This UI exists ONLY in the local desktop app: renderer.js skips it when
 * window.__CCBOT_REMOTE__ is set (a remote browser view must not offer a
 * nested remote hop).
 */

const { parseSshCommand } = require('./ssh-command-parse');

const RECENTS_KEY = 'ccbot-remote-recent-connections';
const MAX_RECENTS = 8;

class RemoteConnectionUI {
    /**
     * @param {Object} ipcHandler - { invoke, on } wrapper over ipcRenderer
     */
    constructor(ipcHandler) {
        this.ipc = ipcHandler;
        this.connection = null;   // { host, username, sshPort, localPort } while connected
        this.connecting = false;
        this.el = {};
    }

    initialize() {
        const $ = (id) => document.getElementById(id);
        this.el = {
            indicator: $('remote-indicator'),
            indicatorLabel: $('remote-indicator-label'),
            // top-middle command bar (the primary connect input)
            bar: $('remote-command-bar'),
            command: $('remote-command-input'),
            connectBtn: $('remote-connect-btn'),
            barCloseBtn: $('remote-command-close-btn'),
            advancedToggle: $('remote-advanced-toggle'),
            advancedBox: $('remote-advanced-box'),
            sessionPath: $('remote-session-path-input'),
            sshOptions: $('remote-ssh-options-input'),
            appDir: $('remote-app-dir-input'),
            recents: $('remote-recents-list'),
            barStatus: $('remote-command-status'),
            // bottom-left management popover (connected state)
            panel: $('remote-panel'),
            connectedBox: $('remote-connected-box'),
            connectedText: $('remote-connected-text'),
            disconnectBtn: $('remote-disconnect-btn'),
            panelCloseBtn: $('remote-panel-close-btn'),
            panelStatus: $('remote-panel-status'),
            // embedded remote view
            viewContainer: $('remote-view-container'),
            frame: $('remote-view-frame')
        };
        if (!this.el.indicator || !this.el.bar || !this.el.panel) {
            console.warn('RemoteConnectionUI: markup missing, skipping init');
            return;
        }

        this.el.indicator.addEventListener('click', () => {
            // Connected → manage (bottom-left popover); idle → connect (top bar).
            if (this.connection) this.togglePanel();
            else this.toggleCommandBar();
        });
        this.el.barCloseBtn.addEventListener('click', () => this.hideCommandBar());
        this.el.panelCloseBtn.addEventListener('click', () => this.hidePanel());
        this.el.connectBtn.addEventListener('click', () => this.connect());
        this.el.disconnectBtn.addEventListener('click', () => this.disconnect());
        this.el.advancedToggle.addEventListener('click', () => {
            this.el.advancedBox.classList.toggle('hidden');
        });
        this.el.bar.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
                e.preventDefault();
                this.connect();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!this.el.bar.classList.contains('hidden')) this.hideCommandBar();
            if (!this.el.panel.classList.contains('hidden')) this.hidePanel();
        });

        // Progress + unexpected tunnel state changes pushed from main. During
        // a connect this narrates the auto-start phases ("enabling Remote Mode
        // on host…", "starting the app…") in the bar's status line.
        this.ipc.on('remote-client-status', (event, status) => this.onStatusPush(status));

        this.renderIdle();
        this.renderRecents();
        console.log('🔌 RemoteConnectionUI initialized');
    }

    // ---------- top-middle command bar ----------

    toggleCommandBar() {
        if (this.el.bar.classList.contains('hidden')) this.showCommandBar();
        else this.hideCommandBar();
    }

    showCommandBar() {
        this.el.bar.classList.remove('hidden');
        this.hidePanel();
        // Prefill the most recent command as REAL, editable text (not a
        // placeholder) so reconnecting is Enter-away but fully editable.
        if (!this.el.command.value.trim()) {
            const last = this.loadRecents()[0];
            if (last) this.el.command.value = this.commandOf(last);
        }
        this.renderRecents();
        this.el.command.focus();
        this.el.command.select();
    }

    hideCommandBar() {
        this.el.bar.classList.add('hidden');
    }

    setStatus(message, isError) {
        // textContent ONLY — ssh stderr and hostnames are untrusted text.
        this.el.barStatus.textContent = message || '';
        this.el.barStatus.classList.toggle('remote-status-error', !!isError);
    }

    // ---------- bottom-left management popover ----------

    togglePanel() {
        if (this.el.panel.classList.contains('hidden')) this.showPanel();
        else this.hidePanel();
    }

    showPanel() {
        this.el.panel.classList.remove('hidden');
        const connected = !!this.connection;
        this.el.connectedBox.classList.toggle('hidden', !connected);
        if (connected) {
            const c = this.connection;
            this.el.connectedText.textContent =
                (c.username ? c.username + '@' : '') + c.host +
                ' — remote interface tunneled to 127.0.0.1:' + c.localPort;
        }
    }

    hidePanel() {
        this.el.panel.classList.add('hidden');
        this.el.panelStatus.textContent = '';
    }

    // ---------- indicator ----------

    renderIdle() {
        this.el.indicator.classList.remove('remote-connected', 'remote-connecting', 'remote-error');
        this.el.indicatorLabel.textContent = '';
        this.el.indicator.title = 'Connect to a remote machine';
    }

    renderConnecting(host) {
        this.el.indicator.classList.remove('remote-connected', 'remote-error');
        this.el.indicator.classList.add('remote-connecting');
        this.el.indicatorLabel.textContent = 'Connecting to ' + host + '…';
    }

    renderConnected() {
        const c = this.connection;
        this.el.indicator.classList.remove('remote-connecting', 'remote-error');
        this.el.indicator.classList.add('remote-connected');
        this.el.indicatorLabel.textContent = 'Remote: ' + c.host;
        this.el.indicator.title = 'Connected to ' + (c.username ? c.username + '@' : '') + c.host + ' — click to manage';
    }

    renderError() {
        this.el.indicator.classList.remove('remote-connected', 'remote-connecting');
        this.el.indicator.classList.add('remote-error');
        this.el.indicatorLabel.textContent = 'Remote: error';
    }

    // ---------- recents ----------

    /** The editable command string for a recents entry (incl. legacy shape). */
    commandOf(e) {
        if (e.command) return e.command;
        // legacy {host, username, sshPort} entries from the old form
        return 'ssh ' + (e.username ? e.username + '@' : '') + (e.host || '') +
            (e.sshPort && Number(e.sshPort) !== 22 ? ' -p ' + e.sshPort : '');
    }

    loadRecents() {
        try {
            const raw = localStorage.getItem(RECENTS_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch (_) { return []; }
    }

    saveRecent(entry) {
        try {
            const key = (e) => this.commandOf(e) + '|' + (e.sessionPath || '') + '|' + (e.sshOptions || '') + '|' + (e.appDir || '');
            const list = this.loadRecents().filter((e) => key(e) !== key(entry));
            list.unshift(Object.assign({}, entry, { lastUsed: Date.now() }));
            localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
        } catch (_) { /* recents are a convenience, never fatal */ }
    }

    renderRecents() {
        const list = this.loadRecents();
        const box = this.el.recents;
        box.textContent = '';
        if (list.length === 0) {
            box.classList.add('hidden');
            return;
        }
        box.classList.remove('hidden');
        const title = document.createElement('div');
        title.className = 'remote-recents-title';
        title.textContent = 'Recent';
        box.appendChild(title);
        for (const e of list) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'remote-recent-row';
            row.setAttribute('data-test-id', 'remote-recent-row');
            row.textContent = this.commandOf(e);
            row.addEventListener('click', () => {
                this.el.command.value = this.commandOf(e);
                this.el.sessionPath.value = e.sessionPath || '';
                this.el.sshOptions.value = e.sshOptions || '';
                this.el.appDir.value = e.appDir || '';
                if (e.sessionPath || e.sshOptions || e.appDir) this.el.advancedBox.classList.remove('hidden');
                this.connect();
            });
            box.appendChild(row);
        }
    }

    // ---------- connect / disconnect ----------

    async connect() {
        if (this.connecting || this.connection) return;

        // Parse what the user typed in the bar into host/user/port (+ inline
        // flags like -i, which merge with the Advanced ssh options).
        const command = this.el.command.value.trim();
        let parsed;
        try {
            parsed = parseSshCommand(command);
        } catch (err) {
            this.setStatus((err && err.message) || 'Could not parse that ssh command.', true);
            this.el.command.focus();
            return;
        }

        const advancedOptions = this.el.sshOptions.value.trim();
        const opts = {
            host: parsed.host,
            username: parsed.username,
            sshPort: parsed.sshPort === null ? '' : parsed.sshPort, // '' = default 22
            sessionPath: this.el.sessionPath.value.trim(),
            appDir: this.el.appDir.value.trim(),
            sshOptions: (parsed.extraArgs.join(' ') + ' ' + advancedOptions).trim()
        };

        this.connecting = true;
        this.el.connectBtn.disabled = true;
        this.el.command.disabled = true;
        this.setStatus('Connecting to ' + parsed.host + ' — reading remote session over SSH…', false);
        this.renderConnecting(parsed.host);
        try {
            const result = await this.ipc.invoke('remote-client-connect', opts);
            if (!result || !result.ok) throw new Error((result && result.error) || 'Connection failed');

            this.connection = {
                host: result.host,
                username: result.username,
                sshPort: result.sshPort,
                localPort: result.localPort
            };
            this.saveRecent({
                command,
                sessionPath: opts.sessionPath,
                sshOptions: advancedOptions,
                appDir: opts.appDir
            });

            // Load the remote interface in the embedded view. The token lives
            // only in this loopback URL's fragment.
            this.el.frame.src = result.url;
            this.el.viewContainer.classList.remove('hidden');
            this.renderConnected();
            this.setStatus('', false);
            this.hideCommandBar();
        } catch (err) {
            this.setStatus((err && err.message) || 'Connection failed', true);
            this.renderError();
            setTimeout(() => { if (!this.connection && !this.connecting) this.renderIdle(); }, 4000);
        } finally {
            this.connecting = false;
            this.el.connectBtn.disabled = false;
            this.el.command.disabled = false;
        }
    }

    async disconnect() {
        try { await this.ipc.invoke('remote-client-disconnect'); } catch (_) { /* main cleans up regardless */ }
        this.teardownView();
        this.renderIdle();
        this.hidePanel();
        this.showCommandBar();
        this.setStatus('Disconnected.', false);
    }

    teardownView() {
        this.connection = null;
        this.el.frame.src = 'about:blank';
        this.el.viewContainer.classList.add('hidden');
    }

    onStatusPush(status) {
        if (!status) return;
        // Progress narration while OUR connect() is in flight — the auto-start
        // phases (enable / headless start) take long enough that a silent bar
        // would look hung.
        if (status.phase === 'connecting' && this.connecting && status.message) {
            this.setStatus(status.message, false);
            return;
        }
        // Unexpected transitions: connect()/disconnect() handle their own UI.
        // If main says the tunnel died while we are showing a connected view,
        // drop back to local + surface why in the command bar.
        if (status.phase === 'error' && this.connection) {
            this.teardownView();
            this.renderError();
            this.hidePanel();
            this.showCommandBar();
            this.setStatus(status.error || 'The remote connection dropped.', true);
            setTimeout(() => { if (!this.connection) this.renderIdle(); }, 4000);
        }
    }
}

module.exports = RemoteConnectionUI;
