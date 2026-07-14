/**
 * RemoteConnectionUI - the bottom-left "remote" indicator (the VS Code
 * Remote-SSH corner control) plus its connect panel and the embedded remote
 * view. CLIENT half of web-served Remote Mode (docs/REMOTE_MODE.md).
 *
 * What it drives (all heavy lifting is in main's src/main/remote-client.js):
 *   - indicator button, fixed bottom-left, shows idle / connecting /
 *     "Remote: host" / error states; always on top of the embedded view so
 *     there is always a way back.
 *   - connect panel: host/IP, SSH port (default 22), username, recent
 *     connections (localStorage), and an advanced section (remote session
 *     file path override + extra ssh options like -i/-o).
 *   - on connect: invokes `remote-client-connect`; main reads the remote's
 *     ~/.config/ccbot/session.json over ssh, opens the -L tunnel, and returns
 *     a loopback URL (token in the fragment). That URL is loaded in an
 *     <iframe> covering the app — the full remote interface, 1:1 interactive.
 *   - disconnect (from the panel) or an unexpected tunnel drop (pushed on the
 *     `remote-client-status` channel) tears the view down and returns to the
 *     local interface.
 *
 * The token only ever appears inside the iframe src fragment pointing at
 * 127.0.0.1:<localPort> — it is never rendered, stored, or logged here.
 *
 * This UI exists ONLY in the local desktop app: renderer.js skips it when
 * window.__CCBOT_REMOTE__ is set (a remote browser view must not offer a
 * nested remote hop).
 */

const RECENTS_KEY = 'ccbot-remote-recent-connections';
const MAX_RECENTS = 8;

class RemoteConnectionUI {
    /**
     * @param {Object} ipcHandler - { invoke, on } wrapper over ipcRenderer
     */
    constructor(ipcHandler) {
        this.ipc = ipcHandler;
        this.connection = null;   // { host, username, sshPort, localPort, url } while connected
        this.connecting = false;
        this.el = {};
    }

    initialize() {
        const $ = (id) => document.getElementById(id);
        this.el = {
            indicator: $('remote-indicator'),
            indicatorLabel: $('remote-indicator-label'),
            panel: $('remote-panel'),
            form: $('remote-connect-form'),
            connectedBox: $('remote-connected-box'),
            connectedText: $('remote-connected-text'),
            host: $('remote-host-input'),
            port: $('remote-port-input'),
            user: $('remote-user-input'),
            sessionPath: $('remote-session-path-input'),
            sshOptions: $('remote-ssh-options-input'),
            advancedToggle: $('remote-advanced-toggle'),
            advancedBox: $('remote-advanced-box'),
            connectBtn: $('remote-connect-btn'),
            disconnectBtn: $('remote-disconnect-btn'),
            closeBtn: $('remote-panel-close-btn'),
            status: $('remote-panel-status'),
            recents: $('remote-recents-list'),
            viewContainer: $('remote-view-container'),
            frame: $('remote-view-frame')
        };
        if (!this.el.indicator || !this.el.panel) {
            console.warn('RemoteConnectionUI: markup missing, skipping init');
            return;
        }

        this.el.indicator.addEventListener('click', () => this.togglePanel());
        this.el.closeBtn.addEventListener('click', () => this.hidePanel());
        this.el.connectBtn.addEventListener('click', () => this.connect());
        this.el.disconnectBtn.addEventListener('click', () => this.disconnect());
        this.el.advancedToggle.addEventListener('click', () => {
            this.el.advancedBox.classList.toggle('hidden');
        });
        this.el.form.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
                e.preventDefault();
                this.connect();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.el.panel.classList.contains('hidden')) this.hidePanel();
        });

        // Unexpected tunnel state changes pushed from main (e.g. the ssh
        // process died because the network dropped).
        this.ipc.on('remote-client-status', (event, status) => this.onStatusPush(status));

        this.renderIdle();
        this.renderRecents();
        console.log('🔌 RemoteConnectionUI initialized');
    }

    // ---------- panel ----------

    togglePanel() {
        if (this.el.panel.classList.contains('hidden')) this.showPanel();
        else this.hidePanel();
    }

    showPanel() {
        this.el.panel.classList.remove('hidden');
        // Two panel modes: the connect form (idle) or connection info (connected).
        const connected = !!this.connection;
        this.el.form.classList.toggle('hidden', connected);
        this.el.connectedBox.classList.toggle('hidden', !connected);
        if (connected) {
            const c = this.connection;
            this.el.connectedText.textContent =
                (c.username ? c.username + '@' : '') + c.host +
                ' — remote interface tunneled to 127.0.0.1:' + c.localPort;
        } else {
            this.renderRecents();
            if (this.el.host) this.el.host.focus();
        }
    }

    hidePanel() {
        this.el.panel.classList.add('hidden');
    }

    setStatus(message, isError) {
        // textContent ONLY — ssh stderr and hostnames are untrusted text.
        this.el.status.textContent = message || '';
        this.el.status.classList.toggle('remote-status-error', !!isError);
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

    loadRecents() {
        try {
            const raw = localStorage.getItem(RECENTS_KEY);
            const list = raw ? JSON.parse(raw) : [];
            return Array.isArray(list) ? list : [];
        } catch (_) { return []; }
    }

    saveRecent(entry) {
        try {
            const key = (e) => (e.username || '') + '@' + e.host + ':' + e.sshPort;
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
            row.textContent = (e.username ? e.username + '@' : '') + e.host + (e.sshPort && e.sshPort !== 22 ? ':' + e.sshPort : '');
            row.addEventListener('click', () => {
                this.el.host.value = e.host || '';
                this.el.port.value = e.sshPort || 22;
                this.el.user.value = e.username || '';
                this.el.sessionPath.value = e.sessionPath || '';
                this.el.sshOptions.value = e.sshOptions || '';
                if (e.sessionPath || e.sshOptions) this.el.advancedBox.classList.remove('hidden');
                this.connect();
            });
            box.appendChild(row);
        }
    }

    // ---------- connect / disconnect ----------

    gatherForm() {
        return {
            host: this.el.host.value.trim(),
            sshPort: this.el.port.value.trim() || 22,
            username: this.el.user.value.trim(),
            sessionPath: this.el.sessionPath.value.trim(),
            sshOptions: this.el.sshOptions.value.trim()
        };
    }

    async connect() {
        if (this.connecting || this.connection) return;
        const opts = this.gatherForm();
        if (!opts.host) {
            this.setStatus('Enter a host or IP.', true);
            return;
        }
        this.connecting = true;
        this.el.connectBtn.disabled = true;
        this.setStatus('Connecting to ' + opts.host + ' — reading remote session over SSH…', false);
        this.renderConnecting(opts.host);
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
                host: result.host,
                sshPort: result.sshPort,
                username: result.username,
                sessionPath: opts.sessionPath,
                sshOptions: opts.sshOptions
            });

            // Load the remote interface in the embedded view. The token lives
            // only in this loopback URL's fragment.
            this.el.frame.src = result.url;
            this.el.viewContainer.classList.remove('hidden');
            this.renderConnected();
            this.setStatus('', false);
            this.hidePanel();
        } catch (err) {
            this.setStatus((err && err.message) || 'Connection failed', true);
            this.renderError();
            setTimeout(() => { if (!this.connection && !this.connecting) this.renderIdle(); }, 4000);
        } finally {
            this.connecting = false;
            this.el.connectBtn.disabled = false;
        }
    }

    async disconnect() {
        try { await this.ipc.invoke('remote-client-disconnect'); } catch (_) { /* main cleans up regardless */ }
        this.teardownView();
        this.renderIdle();
        this.setStatus('Disconnected.', false);
        this.showPanel();
    }

    teardownView() {
        this.connection = null;
        this.el.frame.src = 'about:blank';
        this.el.viewContainer.classList.add('hidden');
    }

    onStatusPush(status) {
        if (!status) return;
        // Only unexpected transitions matter here: connect()/disconnect()
        // already handle their own UI. If main says the tunnel died while we
        // are showing a connected view, drop back to local + surface why.
        if (status.phase === 'error' && this.connection) {
            this.teardownView();
            this.renderError();
            this.setStatus(status.error || 'The remote connection dropped.', true);
            this.showPanel();
            setTimeout(() => { if (!this.connection) this.renderIdle(); }, 4000);
        }
    }
}

module.exports = RemoteConnectionUI;
