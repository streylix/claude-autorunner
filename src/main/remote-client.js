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
// Auto-start: the remote-side ensure script polls internally (up to 45s for a
// cold app start); this is the hard kill on that whole ssh invocation.
const ENSURE_TIMEOUT_MS = 90000;
// After a successful ensure, re-reads of the session file get a short retry
// window (the file is written a beat after the server starts listening).
const SESSION_SETTLE_TIMEOUT_MS = 15000;
const SESSION_SETTLE_INTERVAL_MS = 1000;

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

    // Optional advanced: the app's directory on the remote, for auto-START
    // when the app has never run there (no recorded app-root). Same strict
    // charset as sessionPath — it is interpolated into the remote sh command.
    const appDir = String(o.appDir || '').trim();
    if (appDir && !/^[A-Za-z0-9_~/][A-Za-z0-9_./~-]*$/.test(appDir)) {
        throw new Error('Invalid remote app directory (no spaces or shell characters).');
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
        appDir,
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
 * Non-throwing session inspection for the auto-start decision tree.
 * @returns {{state:'remote-on'|'remote-off'|'unreadable', token?:string,
 *            hookPort?:number, remotePort?:number}}
 */
function inspectRemoteSession(raw) {
    let parsed;
    try { parsed = JSON.parse(String(raw)); } catch (_) { return { state: 'unreadable' }; }
    if (!parsed || !parsed.token || !parsed.port) return { state: 'unreadable' };
    if (parsed.remote && parsed.remote.port) {
        return {
            state: 'remote-on',
            token: String(parsed.token),
            hookPort: Number(parsed.port),
            remotePort: Number(parsed.remote.port)
        };
    }
    return { state: 'remote-off', token: String(parsed.token), hookPort: Number(parsed.port) };
}

/**
 * Build the remote sh command that runs scripts/remote-autostart.js on the
 * remote machine (over the same SSH channel) to detect + fix the remote's
 * state: enable Remote Mode live in a running app, or cold-start the app
 * headless with CCBOT_REMOTE=1. See that script's header for the states.
 *
 * How the script gets found and run with NO assumptions about the remote's
 * non-interactive PATH:
 *   - the app records its install dir + Electron binary in the sh-sourceable
 *     0600 file  <cfg>/ccbot/app-root  on every startup (session-file.js) —
 *     it survives shutdown, which is the whole point (auto-START);
 *   - the Advanced "remote app directory" field overrides it;
 *   - the script runs under ELECTRON_RUN_AS_NODE on the app's own Electron
 *     binary, falling back to `node` if present.
 *
 * IMPORTANT: the command contains NO single quotes (some remote login shells
 * would mangle nested quoting) and every interpolated value has already been
 * validated against a strict no-space/no-metacharacter charset in
 * normalizeConnectOptions. Paths from the app-root file are handled by the
 * remote shell via sourcing, so they may contain anything.
 */
function buildEnsureCommand(conn) {
    // Where the ccbot config dir lives, and the exact session file to manage.
    // Left unquoted so the REMOTE shell expands ~ / ${...} (same convention as
    // DEFAULT_SESSION_CMD above; the charset makes word-splitting impossible).
    const cfgExpr = conn.sessionPath
        ? 'cfg=$(dirname ' + conn.sessionPath + ')'
        : 'cfg="${XDG_CONFIG_HOME:-$HOME/.config}/ccbot"';
    const sessionFileExpr = conn.sessionPath ? conn.sessionPath : '"$cfg/session.json"';
    const appDirLine = conn.appDir
        ? 'd=' + conn.appDir
        : 'if [ -f "$cfg/app-root" ]; then . "$cfg/app-root"; d="$CCBOT_APP_ROOT"; bin="$CCBOT_ELECTRON"; fi';

    return [
        cfgExpr,
        'd=""',
        'bin=""',
        appDirLine,
        'if [ -z "$d" ]; then echo CCBOT_ERR_NO_APP_ROOT; exit 46; fi',
        'if [ ! -d "$d" ]; then echo "CCBOT_ERR_APP_DIR:$d"; exit 47; fi',
        'if [ ! -f "$d/scripts/remote-autostart.js" ]; then echo "CCBOT_ERR_OLD_APP:$d"; exit 49; fi',
        'if [ ! -x "$bin" ]; then for c in "$d/node_modules/electron/dist/electron" "$d/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"; do if [ -x "$c" ]; then bin="$c"; break; fi; done; fi',
        'if [ ! -x "$bin" ]; then if command -v node >/dev/null 2>&1; then bin=node; else echo CCBOT_ERR_NO_NODE; exit 48; fi; fi',
        'ELECTRON_RUN_AS_NODE=1 exec "$bin" "$d/scripts/remote-autostart.js" ensure --session-file ' + sessionFileExpr
    ].join('\n');
}

// NOTE: appDirLine's else-branch sets bin from the sourced file; when the
// Advanced app dir is used, bin stays empty and the electron-binary probe
// below finds it. Marker exit codes map to the user-facing messages here:
function explainEnsureFailure(stdout, stderr, dest) {
    const out = String(stdout || '');
    if (/CCBOT_ERR_NO_APP_ROOT/.test(out)) {
        return 'The Auto-Injector app has never run on ' + dest + ' (no recorded install location), so it cannot be auto-started. ' +
            'Set "Remote app directory" under Advanced, or start the app on that machine once.';
    }
    const dirErr = out.match(/CCBOT_ERR_APP_DIR:(.*)/);
    if (dirErr) {
        return 'The app directory recorded on ' + dest + ' (' + dirErr[1].trim() + ') no longer exists. ' +
            'Set "Remote app directory" under Advanced to where the app now lives.';
    }
    const oldErr = out.match(/CCBOT_ERR_OLD_APP:(.*)/);
    if (oldErr) {
        return 'The app checkout on ' + dest + ' (' + oldErr[1].trim() + ') is too old for auto-start (missing scripts/remote-autostart.js). ' +
            'Update it, or start it there manually with CCBOT_REMOTE=1.';
    }
    if (/CCBOT_ERR_NO_NODE/.test(out)) {
        return 'Could not find a Node runtime or the app\'s Electron binary on ' + dest + ' — run npm install in the app directory there.';
    }
    // The ensure script reports its own failures as a JSON result line.
    const resultLine = out.split('\n').reverse().find((l) => l.startsWith('CCBOT_AUTOSTART_RESULT:'));
    if (resultLine) {
        try {
            const r = JSON.parse(resultLine.slice('CCBOT_AUTOSTART_RESULT:'.length));
            if (r && r.error) return 'Auto-starting Remote Mode on ' + dest + ' failed: ' + r.error;
        } catch (_) { /* fall through */ }
    }
    return classifySshFailure(stderr, dest);
}

/** Parse the ensure script's stdout into its final JSON result (or null). */
function parseEnsureResult(stdout) {
    const line = String(stdout || '').split('\n').reverse()
        .find((l) => l.startsWith('CCBOT_AUTOSTART_RESULT:'));
    if (!line) return null;
    try { return JSON.parse(line.slice('CCBOT_AUTOSTART_RESULT:'.length)); } catch (_) { return null; }
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

    /**
     * Read + classify the remote session file over SSH.
     * @returns {Promise<{state:'remote-on'|'remote-off'|'not-running',
     *                    token?:string, remotePort?:number}>}
     * Throws (with a user-facing message) on real SSH failures — bad host,
     * auth, changed host key — but NOT on "app not running": that is a state
     * the auto-start path handles.
     */
    async _readRemoteSession(conn) {
        const catCmd = conn.sessionPath ? 'cat ' + conn.sessionPath : DEFAULT_SESSION_CMD;
        const sshArgs = [...this._baseSshArgs(conn), conn.dest, catCmd];
        this.log('[RemoteClient] reading session: ssh ' + sshArgs.slice(0, -1).join(' ') + ' <cat>');
        const res = await this._execSsh(sshArgs, SESSION_READ_TIMEOUT_MS);
        if (res.code !== 0) {
            if (/No such file or directory/i.test(res.stderr)) return { state: 'not-running' };
            throw new Error(classifySshFailure(res.stderr, conn.dest));
        }
        const info = inspectRemoteSession(res.stdout);
        if (info.state === 'unreadable') {
            // The file exists but is not a valid session — don't blind-start a
            // second app instance over it; make the user look at the machine.
            throw new Error('The session file on ' + conn.host +
                ' exists but is unreadable — restart the Auto-Injector app there.');
        }
        return info;
    }

    /**
     * Run scripts/remote-autostart.js on the remote over SSH to bring Remote
     * Mode up: live-enable (app running, remote off) or headless cold-start
     * (app not running). Resolves the script's {ok, action, port} result;
     * throws a specific, user-facing Error on every failure mode.
     */
    async _ensureRemoteMode(conn, state, pub) {
        const message = state === 'remote-off'
            ? 'The app on ' + conn.host + ' is running with Remote Mode off — enabling it now (no restart)…'
            : 'The app is not running on ' + conn.host + ' — starting it in Remote Mode (this can take up to a minute)…';
        this._setState(Object.assign({ phase: 'connecting', message }, pub));

        const ensureArgs = [...this._baseSshArgs(conn), conn.dest, buildEnsureCommand(conn)];
        this.log('[RemoteClient] ensuring Remote Mode on ' + conn.dest + ' (state: ' + state + ')');
        const res = await this._execSsh(ensureArgs, ENSURE_TIMEOUT_MS);
        const result = parseEnsureResult(res.stdout);
        if (res.code !== 0 || !result || !result.ok) {
            throw new Error(explainEnsureFailure(res.stdout, res.stderr, conn.dest));
        }
        this.log('[RemoteClient] Remote Mode ' + result.action + ' on ' + conn.dest + ' (remote port ' + result.port + ')');
        return result;
    }

    /**
     * Re-read the session file until it advertises Remote Mode (the file is
     * written a beat after the server binds). Short window — the heavy
     * waiting already happened inside the ensure script.
     */
    async _awaitRemoteOn(conn) {
        const deadline = Date.now() + SESSION_SETTLE_TIMEOUT_MS;
        for (;;) {
            let info = null;
            try { info = await this._readRemoteSession(conn); } catch (_) { /* retry below */ }
            if (info && info.state === 'remote-on') return info;
            if (Date.now() > deadline) {
                throw new Error('Remote Mode was brought up on ' + conn.host +
                    ' but its session file never advertised it — try connecting again.');
            }
            await new Promise((r) => setTimeout(r, SESSION_SETTLE_INTERVAL_MS));
        }
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
            // ---- 1. read the remote's state (its session file) over SSH ----
            let session = await this._readRemoteSession(conn);

            // ---- 1b. remote not serving Remote Mode? Fix it, don't fail. ----
            // Three states (docs/REMOTE_MODE.md §8): remote-on → connect as-is;
            // remote-off → live-enable through the app's Control API (no
            // restart); not-running → cold-start the app headless with
            // CCBOT_REMOTE=1. Both fixes run remotely via
            // scripts/remote-autostart.js over this same SSH channel.
            if (session.state !== 'remote-on') {
                await this._ensureRemoteMode(conn, session.state, pub);
                this._setState(Object.assign({
                    phase: 'connecting',
                    message: 'Remote Mode is up on ' + conn.host + ' — reading its session…'
                }, pub));
                session = await this._awaitRemoteOn(conn);
            }
            const { token, remotePort } = session;

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
module.exports.inspectRemoteSession = inspectRemoteSession;
module.exports.buildEnsureCommand = buildEnsureCommand;
module.exports.explainEnsureFailure = explainEnsureFailure;
module.exports.parseEnsureResult = parseEnsureResult;
module.exports.classifySshFailure = classifySshFailure;
module.exports.findFreeLocalPort = findFreeLocalPort;
