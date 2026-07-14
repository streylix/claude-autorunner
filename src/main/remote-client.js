'use strict';

/**
 * remote-client - The CLIENT half of web-served Remote Mode (the VS Code
 * Remote-SSH analog; server half in RemoteServer.js / docs/REMOTE_MODE.md).
 *
 * Lives in the Electron MAIN process of the app the user is sitting at. When
 * the user picks a machine in the bottom-left "remote" indicator UI, this
 * module automates the whole attach sequence over the user's OWN ssh setup:
 *
 *   1. `ssh <dest> cat .../ccbot/session.json` — read the remote app's 0600
 *      session file to learn the RemoteServer port + session token. The token
 *      travels only over the SSH channel, never over the network in the clear.
 *   2. Pick a free LOCAL loopback port and spawn a local-forward tunnel:
 *      `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote> <dest>`.
 *   3. Probe http://127.0.0.1:<local>/ until the tunneled RemoteServer
 *      answers, then hand the renderer a ready-to-load loopback URL with the
 *      token in the URL FRAGMENT (never sent over HTTP, never logged).
 *
 * SSH is the system `ssh` binary (spawn with an args array — no local shell),
 * so the user's ~/.ssh/config, keys, agent and known_hosts all apply.
 * BatchMode=yes means we NEVER prompt for a password — auth must come from
 * the user's existing keys/agent, and failures surface as clear UI messages.
 * Host keys: StrictHostKeyChecking=accept-new (first-seen hosts are recorded,
 * a CHANGED host key is a hard failure — same policy direction as OpenSSH's
 * own recommended default for automation).
 *
 * Loopback-safe end to end: the tunnel binds 127.0.0.1 locally, the remote
 * RemoteServer binds 127.0.0.1 remotely, and the token is only ever presented
 * to 127.0.0.1 on either end.
 *
 * Pure Node built-ins (child_process/net/http) — no Electron imports — so the
 * class is unit-testable with `node --test`.
 */

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');

// The remote command that prints the session file. ${...} is expanded by the
// REMOTE login shell (we spawn ssh with an args array, so nothing expands
// locally), which makes the default path track the remote's XDG config dir
// exactly like src/main/session-file.js does when writing it.
const DEFAULT_SESSION_CMD = 'cat "${XDG_CONFIG_HOME:-$HOME/.config}/ccbot/session.json"';

const CONNECT_TIMEOUT_S = 10;      // ssh -o ConnectTimeout for both phases
const SESSION_READ_TIMEOUT_MS = 25000; // hard kill on the session-read ssh
const TUNNEL_PROBE_TIMEOUT_MS = 15000; // how long we wait for the tunnel to answer
const TUNNEL_PROBE_INTERVAL_MS = 250;

// ---------- pure helpers (exported for unit tests) ----------

/**
 * Validate + normalize the connect options coming from the renderer form.
 * Throws Error with a user-facing message on invalid input. The charsets are
 * deliberately strict: everything here ends up in an argv for `ssh`, and a
 * value starting with `-` could be parsed as an option by ssh itself.
 */
function normalizeConnectOptions(opts) {
    const o = opts || {};
    const host = String(o.host || '').trim();
    if (!host) throw new Error('Enter a host or IP to connect to.');
    // hostname / IPv4 / bracketless IPv6; must not begin with '-'
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(host)) {
        throw new Error('Invalid host: use a hostname or IP (letters, digits, dots, dashes, colons).');
    }

    const username = String(o.username || '').trim();
    if (username && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(username)) {
        throw new Error('Invalid username.');
    }

    const portRaw = (o.sshPort === undefined || o.sshPort === null || o.sshPort === '') ? 22 : o.sshPort;
    const sshPort = Number(portRaw);
    if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
        throw new Error('Invalid SSH port (1-65535).');
    }

    // Optional advanced: absolute/tilde path to the remote session file (for
    // remotes that run with a non-default XDG_CONFIG_HOME). No quotes/spaces/
    // shell metacharacters — it is inserted into the remote `cat` command.
    const sessionPath = String(o.sessionPath || '').trim();
    if (sessionPath && !/^[A-Za-z0-9_~/][A-Za-z0-9_./~-]*$/.test(sessionPath)) {
        throw new Error('Invalid session file path (no spaces or shell characters).');
    }

    // Optional advanced: extra ssh options ("-i /path/key -o SomeOption=x").
    // Tokenized on whitespace; each token restricted to a safe charset.
    const extraArgs = [];
    const sshOptions = String(o.sshOptions || '').trim();
    if (sshOptions) {
        for (const tok of sshOptions.split(/\s+/)) {
            if (!/^[A-Za-z0-9@%_+=:,.\/-]+$/.test(tok)) {
                throw new Error('Invalid SSH option token: ' + tok);
            }
            extraArgs.push(tok);
        }
    }

    return {
        host,
        username,
        sshPort,
        sessionPath,
        extraArgs,
        dest: username ? username + '@' + host : host
    };
}

/**
 * Parse the remote session.json content. Returns { token, remotePort }.
 * Throws a user-facing Error when the app is up but Remote Mode is off.
 */
function parseRemoteSession(raw, host) {
    let parsed;
    try {
        parsed = JSON.parse(String(raw));
    } catch (_) {
        throw new Error('Could not read the remote session file on ' + host +
            ' — is the Auto-Injector app running there?');
    }
    if (!parsed || !parsed.token || !parsed.port) {
        throw new Error('The session file on ' + host + ' is incomplete — restart the Auto-Injector app there.');
    }
    if (!parsed.remote || !parsed.remote.port) {
        throw new Error('The Auto-Injector app is running on ' + host +
            ' but Remote Mode is OFF. Start it there with CCBOT_REMOTE=1 (or the remoteServerEnabled setting), then reconnect.');
    }
    return { token: String(parsed.token), remotePort: Number(parsed.remote.port) };
}

/**
 * Turn raw ssh stderr into a clear, actionable UI message.
 */
function classifySshFailure(stderr, dest) {
    const s = String(stderr || '');
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) {
        return 'HOST KEY CHANGED for ' + dest + ' — ssh refused to connect. Verify the machine and update ~/.ssh/known_hosts.';
    }
    if (/Host key verification failed/i.test(s)) {
        return 'Host key verification failed for ' + dest + '. Connect once from a terminal (ssh ' + dest + ') to accept the host key, then retry.';
    }
    if (/Permission denied/i.test(s)) {
        return 'SSH authentication failed for ' + dest + '. Password prompts are disabled — set up key/agent auth for this host (ssh-copy-id ' + dest + ').';
    }
    if (/No such file or directory/i.test(s)) {
        return 'No ccbot session file on ' + dest + ' — the Auto-Injector app is not running there (or is not in Remote Mode). Start it with CCBOT_REMOTE=1.';
    }
    if (/Could not resolve hostname/i.test(s)) {
        return 'Could not resolve host ' + dest + '.';
    }
    if (/Connection refused/i.test(s)) {
        return 'Connection refused by ' + dest + ' — is sshd running on that port?';
    }
    if (/(timed out|Operation timed out|Connection timeout)/i.test(s)) {
        return 'Connection to ' + dest + ' timed out.';
    }
    const firstLine = s.split('\n').map((l) => l.trim())
        .filter((l) => l && !/^Warning: Permanently added/i.test(l))[0];
    return 'SSH failed for ' + dest + (firstLine ? ': ' + firstLine : ' (unknown error).');
}

/** Find a free loopback port for the local end of the tunnel. */
function findFreeLocalPort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

// ---------- the client ----------

class RemoteClient {
    /**
     * @param {Object} [opts]
     * @param {Function} [opts.onStatus] - called with every state change:
     *   { phase: 'idle'|'connecting'|'connected'|'error', host, username,
     *     sshPort, localPort, remotePort, message, error }
     *   (never contains the token)
     * @param {Function} [opts.log] - safe logger
     */
    constructor(opts = {}) {
        this.onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
        this.log = typeof opts.log === 'function' ? opts.log : () => {};
        this.tunnelChild = null;
        this.state = { phase: 'idle' };
    }

    _setState(next) {
        this.state = Object.assign({}, next);
        try { this.onStatus(Object.assign({}, this.state)); } catch (_) { /* ignore */ }
    }

    _baseSshArgs(conn) {
        return [
            '-p', String(conn.sshPort),
            '-o', 'BatchMode=yes',                     // never prompt for a password
            '-o', 'ConnectTimeout=' + CONNECT_TIMEOUT_S,
            '-o', 'StrictHostKeyChecking=accept-new',  // record new hosts; FAIL on changed keys
            ...conn.extraArgs
        ];
    }

    /** Run ssh once, capture output. Resolves { code, stdout, stderr }. */
    _execSsh(args, timeoutMs) {
        return new Promise((resolve) => {
            const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            let done = false;
            const finish = (code) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ code, stdout, stderr });
            };
            const timer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch (_) { /* gone */ }
                stderr += '\nConnection timeout';
                finish(255);
            }, timeoutMs);
            child.stdout.on('data', (d) => { stdout += d; });
            child.stderr.on('data', (d) => { stderr += d; });
            child.on('error', (err) => { stderr += String(err.message || err); finish(255); });
            child.on('close', (code) => finish(code == null ? 255 : code));
        });
    }

    /** Probe the tunneled RemoteServer until it answers HTTP on loopback. */
    _probeTunnel(localPort, child) {
        const deadline = Date.now() + TUNNEL_PROBE_TIMEOUT_MS;
        const tryOnce = () => new Promise((resolve) => {
            const req = http.get({ host: '127.0.0.1', port: localPort, path: '/', timeout: 2000 }, (res) => {
                res.resume();
                resolve(res.statusCode > 0);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
        return new Promise((resolve, reject) => {
            const loop = async () => {
                if (child.exitCode !== null || child.signalCode !== null) {
                    reject(new Error('__TUNNEL_EXITED__'));
                    return;
                }
                if (await tryOnce()) { resolve(true); return; }
                if (Date.now() > deadline) {
                    reject(new Error('The SSH tunnel opened but the remote interface did not answer on the forwarded port.'));
                    return;
                }
                setTimeout(loop, TUNNEL_PROBE_INTERVAL_MS);
            };
            loop();
        });
    }

    /**
     * The full attach sequence. Resolves
     *   { ok:true, host, username, sshPort, localPort, remotePort, url }
     * where url = http://127.0.0.1:<localPort>/#k=<token> (loopback-only; the
     * token rides the fragment exactly like `npm run remote-url` prints it).
     * Rejects with a user-facing Error on any failure; state/status events are
     * emitted along the way.
     */
    async connect(opts) {
        if (this.state.phase === 'connecting') throw new Error('Already connecting — wait or disconnect first.');
        if (this.state.phase === 'connected') throw new Error('Already connected — disconnect first.');

        const conn = normalizeConnectOptions(opts);
        const pub = { host: conn.host, username: conn.username, sshPort: conn.sshPort };
        this._setState(Object.assign({ phase: 'connecting', message: 'Reading remote session over SSH…' }, pub));

        try {
            // ---- 1. fetch the remote session file over SSH ----
            const catCmd = conn.sessionPath ? 'cat ' + conn.sessionPath : DEFAULT_SESSION_CMD;
            const sshArgs = [...this._baseSshArgs(conn), conn.dest, catCmd];
            this.log('[RemoteClient] reading session: ssh ' + sshArgs.slice(0, -1).join(' ') + ' <cat>');
            const res = await this._execSsh(sshArgs, SESSION_READ_TIMEOUT_MS);
            if (res.code !== 0) throw new Error(classifySshFailure(res.stderr, conn.dest));
            const { token, remotePort } = parseRemoteSession(res.stdout, conn.host);

            // ---- 2. open the local-forward tunnel ----
            this._setState(Object.assign({ phase: 'connecting', message: 'Opening SSH tunnel…' }, pub));
            const localPort = await findFreeLocalPort();
            const tunnelArgs = [
                ...this._baseSshArgs(conn),
                '-N',                                   // no remote command — tunnel only
                '-o', 'ExitOnForwardFailure=yes',
                '-o', 'ServerAliveInterval=15',
                '-o', 'ServerAliveCountMax=3',
                '-L', '127.0.0.1:' + localPort + ':127.0.0.1:' + remotePort,
                conn.dest
            ];
            this.log('[RemoteClient] tunnel: ssh ' + tunnelArgs.join(' '));
            const child = spawn('ssh', tunnelArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
            let tunnelStderr = '';
            child.stderr.on('data', (d) => { tunnelStderr += d; });
            this.tunnelChild = child;

            // Unexpected tunnel death while connected -> tell the UI.
            child.on('close', () => {
                if (this.tunnelChild === child && this.state.phase === 'connected') {
                    this.tunnelChild = null;
                    this.log('[RemoteClient] tunnel to ' + conn.dest + ' dropped');
                    this._setState(Object.assign({
                        phase: 'error',
                        error: 'The SSH tunnel to ' + conn.dest + ' dropped. Reconnect when the machine is reachable again.'
                    }, pub));
                }
            });

            // ---- 3. wait until the tunneled interface answers ----
            try {
                await this._probeTunnel(localPort, child);
            } catch (err) {
                this._killChild(child);
                if (this.tunnelChild === child) this.tunnelChild = null;
                if (err && err.message === '__TUNNEL_EXITED__') {
                    throw new Error(classifySshFailure(tunnelStderr, conn.dest));
                }
                throw err;
            }

            const connectedState = Object.assign({
                phase: 'connected',
                localPort,
                remotePort,
                message: 'Connected to ' + conn.dest
            }, pub);
            this._setState(connectedState);
            this.log('[RemoteClient] connected: 127.0.0.1:' + localPort + ' -> ' + conn.dest + ' -> 127.0.0.1:' + remotePort);

            // Token goes ONLY into the returned loopback URL fragment (for the
            // embedded view). It is never put in state/status events or logs.
            return {
                ok: true,
                host: conn.host,
                username: conn.username,
                sshPort: conn.sshPort,
                localPort,
                remotePort,
                url: 'http://127.0.0.1:' + localPort + '/#k=' + token
            };
        } catch (err) {
            this._setState(Object.assign({ phase: 'error', error: (err && err.message) || 'Connection failed' }, pub));
            throw err;
        }
    }

    _killChild(child) {
        if (!child) return;
        try { child.kill('SIGTERM'); } catch (_) { /* gone */ }
        const t = setTimeout(() => {
            try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch (_) { /* gone */ }
        }, 2000);
        if (t.unref) t.unref();
    }

    /** Tear the tunnel down and return to local-only. Safe to call anytime. */
    disconnect() {
        const child = this.tunnelChild;
        this.tunnelChild = null;
        if (child) this._killChild(child);
        this._setState({ phase: 'idle' });
        return { ok: true };
    }

    getStatus() {
        return Object.assign({}, this.state);
    }
}

module.exports = RemoteClient;
module.exports.normalizeConnectOptions = normalizeConnectOptions;
module.exports.parseRemoteSession = parseRemoteSession;
module.exports.classifySshFailure = classifySshFailure;
module.exports.findFreeLocalPort = findFreeLocalPort;
