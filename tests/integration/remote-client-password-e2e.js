#!/usr/bin/env node
'use strict';

/**
 * remote-client-password-e2e - Full-loop verification of the Remote Mode
 * CLIENT's key→PASSWORD fallback (the VS Code Remote-SSH password prompt),
 * driving the real Electron app + the real system `ssh` binary + the real
 * SSH_ASKPASS mechanism end to end:
 *
 *   1. connect to a host whose sshd accepts ONLY password auth → the silent
 *      key attempt (BatchMode=yes) fails with an AUTH failure → the command
 *      bar surfaces the password field (needPassword), focused, labelled
 *      with the destination
 *   2. a WRONG password → clear "Wrong password for …" error, field stays
 *      for an in-place retry
 *   3. the RIGHT password → the connect proceeds exactly like the key path:
 *      session.json read over password-auth'd ssh, Remote Mode LIVE-ENABLED
 *      on the (running, remote-off) remote via the same channel, tunnel
 *      `ssh -N -L` opened with the SAME password (askpass feeds the
 *      long-lived child too), embedded view loads, marker keystroke echoes
 *      on BOTH sides
 *   4. secrecy: the password appears in NO ssh argv (/proc/<pid>/cmdline —
 *      the `ps` exposure sshpass -p has), NO app stdout/stderr, NO status
 *      line, NO recents/localStorage, and NO file on disk (work dir scan);
 *      it DOES ride the tunnel child's env (owner-only /proc/<pid>/environ),
 *      which is the askpass design
 *   5. every ssh operation of the connect (session read, ensure, settle
 *      re-reads, tunnel) authenticated with the password — counted on the
 *      server side
 *
 * THE HARNESS (and why it is not a real sshd): a non-root sshd cannot verify
 * passwords at all — password auth needs /etc/shadow (or PAM), which only
 * root can read, and this suite must run unprivileged. So the "remote sshd"
 * is a real-SSH-protocol server built on the `ssh2` package (dev dep) that
 * accepts a KNOWN password, rejects everything else, executes `exec`
 * requests through /bin/sh, and services direct-tcpip forwards — i.e. the
 * full surface the client uses. Everything on the CLIENT side (the code
 * under test) is real and untouched: the system OpenSSH binary, BatchMode
 * key attempt, SSH_ASKPASS(_REQUIRE=force) + setsid password feed, the
 * tunnel, the UI. The key-only silent path is covered by the real-sshd
 * remote-client-e2e.js, which must keep passing unchanged.
 *
 * Isolation: both app instances run with their own XDG_CONFIG_HOME; ssh runs
 * with its own UserKnownHostsFile (accept-new against the throwaway host key
 * is exercised together with password auth). Nothing in ~/.ssh is touched.
 *
 * Run headless:  xvfb-run -a node tests/integration/remote-client-password-e2e.js
 * Evidence (screenshots + transcript) goes to $CCBOT_E2E_DIR or tmp.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const WORK = process.env.CCBOT_E2E_DIR
    ? path.resolve(process.env.CCBOT_E2E_DIR)
    : path.join(os.tmpdir(), 'ccbot-e2e-remote-client-password');
const EVID = path.join(WORK, 'evidence');
const SSHD_DIR = path.join(WORK, 'sshd');
const CFG_REMOTE = path.join(WORK, 'cfg-remote');
const CFG_CLIENT = path.join(WORK, 'cfg-client');
const SSHD_PORT = Number(process.env.CCBOT_E2E_SSHD_PORT || 2399);
const USER = os.userInfo().username;
const REMOTE_SESSION = path.join(CFG_REMOTE, 'ccbot', 'session.json');

// The known-good password (with a space, quotes and a $ — must survive the
// env → askpass round trip verbatim) and a wrong one for the retry check.
const PASSWORD = 'ccbot p@ss"w0rd! $42';
const WRONG_PASSWORD = 'not-the-password';

const transcript = [];
function log(...args) {
    const line = '[' + new Date().toISOString() + '] ' + args.join(' ');
    console.log(line);
    transcript.push(line);
}
function fail(msg) {
    log('FAIL: ' + msg);
    throw new Error(msg);
}
function ok(cond, msg) {
    if (!cond) fail(msg);
    log('PASS: ' + msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, what, intervalMs = 300) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let v;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() > deadline) fail('timed out waiting for ' + what);
        await sleep(intervalMs);
    }
}

function portAnswers(port) {
    return new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('error', () => resolve(false));
        s.once('timeout', () => { s.destroy(); resolve(false); });
    });
}

function readRemoteSession() {
    try { return JSON.parse(fs.readFileSync(REMOTE_SESSION, 'utf8')); } catch (_) { return null; }
}

// ---------- the password-auth SSH server (see header for why not sshd) ----------

// authLog: one entry per CONNECTION: { methodsTried: [...], outcome }
const authLog = [];

function setupPasswordSshServer() {
    fs.rmSync(SSHD_DIR, { recursive: true, force: true });
    fs.mkdirSync(SSHD_DIR, { recursive: true, mode: 0o700 });
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', path.join(SSHD_DIR, 'host_key')], { encoding: 'utf8' });
    if (r.status !== 0) fail('ssh-keygen failed: ' + r.stderr);

    const { Server } = require(path.join(APP_ROOT, 'node_modules', 'ssh2'));
    const server = new Server({ hostKeys: [fs.readFileSync(path.join(SSHD_DIR, 'host_key'))] }, (client) => {
        const entry = { methodsTried: [], outcome: 'pending' };
        authLog.push(entry);
        client.on('authentication', (ctx) => {
            entry.methodsTried.push(ctx.method);
            if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASSWORD) {
                entry.outcome = 'password-ok';
                return ctx.accept();
            }
            // Everything else (none/publickey/wrong password): only password
            // is on offer — exactly a "no usable key" host.
            if (ctx.method === 'password') entry.outcome = 'password-wrong';
            ctx.reject(['password']);
        });
        client.on('ready', () => {
            client.on('session', (accept) => {
                const session = accept();
                session.once('exec', (acceptExec, rejectExec, info) => {
                    const stream = acceptExec();
                    const child = spawn('/bin/sh', ['-c', info.command], {
                        env: Object.assign({}, process.env, { XDG_CONFIG_HOME: CFG_REMOTE })
                    });
                    // end:false — the exit-status must go out BEFORE the
                    // channel closes, or ssh reports 255 with no stderr
                    child.stdout.pipe(stream, { end: false });
                    child.stderr.pipe(stream.stderr, { end: false });
                    child.on('close', (code) => { stream.exit(code == null ? 255 : code); stream.end(); });
                    stream.on('close', () => { try { child.kill(); } catch (_) { /* gone */ } });
                });
            });
            // direct-tcpip: the -L tunnel's data path
            client.on('tcpip', (accept, reject, info) => {
                const sock = net.connect(info.destPort, info.destIP);
                sock.on('connect', () => {
                    const ch = accept();
                    ch.pipe(sock);
                    sock.pipe(ch);
                    ch.on('close', () => sock.destroy());
                    sock.on('close', () => { try { ch.end(); } catch (_) { /* gone */ } });
                });
                sock.on('error', () => { try { reject(); } catch (_) { /* already accepted */ } });
            });
            // keepalive@openssh.com etc: any reply keeps ServerAlive happy
            client.on('request', (accept) => { if (typeof accept === 'function') accept(); });
        });
        client.on('error', () => { /* client went away; fine */ });
    });
    return new Promise((resolve) => server.listen(SSHD_PORT, '127.0.0.1', () => {
        log('password-only SSH server listening on 127.0.0.1:' + SSHD_PORT);
        resolve(server);
    }));
}

// ---------- electron ----------

async function launchApp(_electron, { xdgConfig, collectOutput }) {
    const env = Object.assign({}, process.env, {
        XDG_CONFIG_HOME: xdgConfig,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    });
    delete env.CCBOT_REMOTE;
    delete env.CCBOT_REMOTE_PORT;
    const app = await _electron.launch({
        args: [APP_ROOT, '--no-sandbox', '--disable-gpu'],
        cwd: APP_ROOT,
        env
    });
    const outBuf = { data: '' };
    if (collectOutput && app.process()) {
        if (app.process().stdout) app.process().stdout.on('data', (d) => { outBuf.data += d; });
        if (app.process().stderr) app.process().stderr.on('data', (d) => { outBuf.data += d; });
    }
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
    return { app, page, outBuf };
}

// ---------- command bar helpers (same shapes as remote-client-e2e.js) ----------

async function openCommandBar(page) {
    const bar = page.locator('[data-test-id="remote-command-bar"]');
    if (await bar.isHidden()) {
        await page.click('[data-test-id="remote-indicator"]');
        await bar.waitFor({ state: 'visible', timeout: 5000 });
    }
    return bar;
}

async function armStatusLog(page) {
    await page.evaluate(() => {
        const el = document.querySelector('[data-test-id="remote-command-status"]');
        window.__statusLog = window.__statusLog || [];
        if (window.__statusObserver) return;
        const push = () => {
            const t = (el.textContent || '').trim();
            if (t && window.__statusLog[window.__statusLog.length - 1] !== t) window.__statusLog.push(t);
        };
        window.__statusObserver = new MutationObserver(push);
        window.__statusObserver.observe(el, { childList: true, characterData: true, subtree: true });
        push();
    });
}
const statusLog = (page) => page.evaluate(() => window.__statusLog || []);
const statusText = (page) => page.locator('[data-test-id="remote-command-status"]').textContent();

async function waitConnected(page, timeoutMs) {
    await waitFor(async () => {
        const t = await page.locator('[data-test-id="remote-indicator-label"]').textContent();
        return /^Remote: 127\.0\.0\.1$/.test((t || '').trim()) ? t : null;
    }, timeoutMs, 'indicator to show "Remote: 127.0.0.1"');
    const frameSrc = await page.locator('[data-test-id="remote-view-frame"]').getAttribute('src');
    ok(/^http:\/\/127\.0\.0\.1:\d+\/#k=/.test(frameSrc), 'embedded view loads a loopback tunnel URL with the token in the fragment');
    return Number(new URL(frameSrc).port);
}

async function attachEmbedded(page, localPort) {
    const frame = await waitFor(async () => {
        for (const f of page.frames()) {
            if (f.url().startsWith('http://127.0.0.1:' + localPort + '/')) return f;
        }
        return null;
    }, 15000, 'embedded remote frame');
    await waitFor(async () => frame.evaluate(() => window.__ccbotRemote && window.__ccbotRemote.authed).catch(() => false),
        30000, 'embedded view WS-authenticated to the remote server');
    await waitFor(async () => frame.evaluate(() => {
        const g = window.terminalGUI;
        if (!g || !g.readTerminalScreen) return false;
        const s = g.readTerminalScreen(1, {});
        return !!(s && s.ok && /\$|#|%|>/.test(s.screen || ''));
    }).catch(() => false), 40000, 'remote terminal replayed into the embedded view');
    return frame;
}

async function proveEcho(page, frame) {
    const marker = 'CCBOT_PWE2E_' + Math.random().toString(36).slice(2, 10).toUpperCase();
    await frame.locator('.terminal-wrapper[data-terminal-id="1"] .xterm').first().click();
    await page.keyboard.type('echo ' + marker, { delay: 25 });
    await page.keyboard.press('Enter');
    await waitFor(async () => frame.evaluate((m) => {
        const s = window.terminalGUI.readTerminalScreen(1, { scrollback: true });
        if (!s || !s.ok) return false;
        return s.screen.split('\n').some((l) => l.trim() === m);
    }, marker).catch(() => false), 20000, 'marker output echoed in the embedded view');
    return marker;
}

// ---------- secrecy scans ----------

function sshPidsMatching(pattern) {
    const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    return r.stdout.split('\n').map((s) => Number(s.trim())).filter(Boolean);
}

function cmdlineOf(pid) {
    try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' '); } catch (_) { return ''; }
}

function environOf(pid) {
    try { return fs.readFileSync('/proc/' + pid + '/environ', 'utf8'); } catch (_) { return ''; }
}

function scanTreeForPassword(dir) {
    const hits = [];
    const walk = (d) => {
        let entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!e.isFile()) continue;
            try {
                if (fs.statSync(p).size > 50 * 1024 * 1024) continue;
                if (fs.readFileSync(p, 'latin1').includes(PASSWORD)) hits.push(p);
            } catch (_) { /* unreadable = not a leak we made */ }
        }
    };
    walk(dir);
    return hits;
}

// ---------- main ----------

(async () => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(EVID, { recursive: true });
    fs.mkdirSync(CFG_REMOTE, { recursive: true });
    fs.mkdirSync(CFG_CLIENT, { recursive: true });

    const { _electron } = require(path.join(APP_ROOT, 'node_modules', 'playwright'));

    log('building remote renderer bundle (npm run build-remote)…');
    const build = spawnSync('npm', ['run', 'build-remote'], { cwd: APP_ROOT, encoding: 'utf8' });
    if (build.status !== 0) fail('build-remote failed: ' + (build.stderr || '').slice(-500));

    let sshServer = null;
    let remoteApp = null;
    let clientApp = null;
    let exitCode = 0;

    try {
        // ---- the password-only "sshd" ----
        sshServer = await setupPasswordSshServer();
        await waitFor(() => portAnswers(SSHD_PORT), 8000, 'ssh server on :' + SSHD_PORT);

        // Sanity: BatchMode ssh (the key path) must fail with an AUTH error.
        // MUST be an async spawn: the SSH server lives in THIS process, so a
        // spawnSync here would starve the event loop and deadlock the probe.
        const probe = await new Promise((resolve) => {
            const child = spawn('ssh', [
                '-p', String(SSHD_PORT), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
                '-o', 'ConnectTimeout=10', '-o', 'UserKnownHostsFile=' + path.join(SSHD_DIR, 'known_hosts_probe'),
                USER + '@127.0.0.1', 'true'
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', (d) => { stderr += d; });
            const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* gone */ } }, 20000);
            child.on('close', (status) => { clearTimeout(timer); resolve({ status, stderr }); });
        });
        ok(probe.status !== 0 && /Permission denied/i.test(probe.stderr),
            'server offers NO key auth: BatchMode ssh fails with "Permission denied" (auth failure, not transport)');

        // ---- the "remote" machine: app running WITHOUT Remote Mode ----
        log('launching REMOTE app instance with Remote Mode OFF (XDG_CONFIG_HOME=' + CFG_REMOTE + ')');
        remoteApp = await launchApp(_electron, { xdgConfig: CFG_REMOTE });
        const sessionOff = await waitFor(() => {
            const s = readRemoteSession();
            return (s && s.port && s.token) ? s : null;
        }, 30000, 'remote session.json (Remote Mode off)');
        ok(!sessionOff.remote, 'remote instance runs WITHOUT Remote Mode (live-enable will ride the password channel)');
        const offPid = sessionOff.pid;
        await waitFor(async () => {
            return remoteApp.page.evaluate(() => {
                const g = window.terminalGUI;
                if (!g || !g.readTerminalScreen) return false;
                const s = g.readTerminalScreen(1, {});
                return !!(s && s.ok && /\$|#|%|>/.test(s.screen || ''));
            }).catch(() => false);
        }, 30000, 'remote terminal 1 shell prompt');

        // ---- the client app ----
        log('launching CLIENT app instance (XDG_CONFIG_HOME=' + CFG_CLIENT + ')');
        clientApp = await launchApp(_electron, { xdgConfig: CFG_CLIENT, collectOutput: true });
        const page = clientApp.page;
        const rendererConsole = [];
        page.on('console', (m) => rendererConsole.push(m.text()));

        await openCommandBar(page);
        // Advanced: point at the isolated session file + a throwaway known_hosts
        // (accept-new + password in the SAME connect), and no agent keys.
        await page.click('[data-test-id="remote-advanced-toggle"]');
        await page.fill('[data-test-id="remote-session-path-input"]', REMOTE_SESSION);
        await page.fill('[data-test-id="remote-ssh-options-input"]',
            '-o UserKnownHostsFile=' + path.join(SSHD_DIR, 'known_hosts') + ' -o IdentitiesOnly=yes');
        await page.fill('[data-test-id="remote-command-input"]', 'ssh ' + USER + '@127.0.0.1 -p ' + SSHD_PORT);
        await armStatusLog(page);

        // ==== 1. key attempt fails → the password field appears ====
        const pwRow = page.locator('[data-test-id="remote-password-row"]');
        ok(await pwRow.isHidden(), 'password field is hidden before any auth failure');
        await page.click('[data-test-id="remote-connect-btn"]');
        await pwRow.waitFor({ state: 'visible', timeout: 30000 });
        const authMsg = (await statusText(page)) || '';
        ok(/Key authentication failed .*127\.0\.0\.1.*password/i.test(authMsg),
            'clear key-auth-failed message asks for the password: "' + authMsg + '"');
        const label = await page.locator('#remote-password-label').textContent();
        ok(new RegExp('SSH password for ' + USER + '@127\\.0\\.0\\.1').test(label),
            'password field is labelled with the destination (' + label.trim() + ')');
        const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
        ok(focused === 'remote-password-input', 'password input receives focus for immediate typing');
        await page.screenshot({ path: path.join(EVID, '01-password-prompt-after-key-failure.png') });

        // ==== 2. WRONG password → clear retryable error ====
        await page.fill('[data-test-id="remote-password-input"]', WRONG_PASSWORD);
        await page.click('[data-test-id="remote-connect-btn"]');
        await waitFor(async () => {
            const t = await statusText(page);
            return t && /Wrong password for/i.test(t) ? t : null;
        }, 30000, '"Wrong password" error');
        ok(await pwRow.isVisible(), 'password field stays visible for an in-place retry');
        ok(await page.locator('[data-test-id="remote-view-container"]').isHidden(), 'no view was embedded on a wrong password');
        await page.screenshot({ path: path.join(EVID, '02-wrong-password-error.png') });

        // ==== 3. RIGHT password → full connect incl. live-enable + tunnel ====
        await page.fill('[data-test-id="remote-password-input"]', PASSWORD);
        await page.click('[data-test-id="remote-connect-btn"]');
        const localPort = await waitConnected(page, 90000);
        const statuses = await statusLog(page);
        log('connect statuses: ' + JSON.stringify(statuses));
        ok(statuses.some((s) => /Remote Mode off|enabling it now|no restart/i.test(s)),
            'the auto-start (live-enable) phase ran over the password channel');
        const sessionOn = readRemoteSession();
        ok(sessionOn && sessionOn.remote && sessionOn.remote.port && sessionOn.pid === offPid,
            'Remote Mode was live-enabled (remote.port present, SAME pid ' + offPid + ') via password-auth\'d ssh');
        const frame = await attachEmbedded(page, localPort);
        await page.screenshot({ path: path.join(EVID, '03-connected-via-password.png') });
        const marker = await proveEcho(page, frame);
        ok(true, 'live terminal: keystrokes echo through the password-auth\'d tunnel (marker ' + marker + ')');
        const remoteSeen = await remoteApp.page.evaluate((m) => {
            const s = window.terminalGUI.readTerminalScreen(1, { scrollback: true });
            return !!(s && s.ok && s.screen.split('\n').some((l) => l.trim() === m));
        }, marker);
        ok(remoteSeen, 'the same marker is on the REMOTE instance\'s own terminal (true shared PTY)');
        await page.screenshot({ path: path.join(EVID, '04-terminal-echo.png') });

        // ==== 4. secrecy: argv/ps, logs, storage, disk ====
        const tunnelPids = sshPidsMatching('127\\.0\\.0\\.1:' + localPort + ':127\\.0\\.0\\.1:');
        ok(tunnelPids.length >= 1, 'found the live ssh -N -L tunnel process (pid ' + tunnelPids.join(',') + ')');
        for (const pid of tunnelPids) {
            ok(!cmdlineOf(pid).includes(PASSWORD), 'tunnel pid ' + pid + ' argv (/proc/cmdline — what `ps` shows) does NOT contain the password');
        }
        const psOut = spawnSync('ps', ['auxww'], { encoding: 'utf8' }).stdout || '';
        ok(!psOut.includes(PASSWORD), '`ps auxww` output does not contain the password anywhere');
        const env0 = environOf(tunnelPids[0]);
        ok(env0.includes('CCBOT_SSH_PASSWORD=' + PASSWORD) || env0.includes('SSHPASS=' + PASSWORD),
            'the tunnel child DOES carry the password in its env (owner-only /proc/environ) — the askpass design');
        let envMode = 0;
        try { envMode = fs.statSync('/proc/' + tunnelPids[0] + '/environ').mode & 0o777; } catch (_) { /* raced */ }
        ok((envMode & 0o044) === 0, '/proc/<tunnel>/environ is not world/group-readable (mode ' + envMode.toString(8) + ')');
        ok(!clientApp.outBuf.data.includes(PASSWORD), 'client app stdout/stderr (main-process logs) never contain the password');
        ok(!rendererConsole.join('\n').includes(PASSWORD), 'renderer console never contains the password');
        ok(!statuses.join('\n').includes(PASSWORD), 'the status line never contains the password');
        const stored = await page.evaluate(() => JSON.stringify(localStorage));
        ok(!stored.includes(PASSWORD), 'localStorage (incl. recents) never contains the password');
        const diskHits = scanTreeForPassword(WORK).filter((p) => !p.startsWith(EVID));
        ok(diskHits.length === 0, 'no file on disk contains the password (work-dir scan)' + (diskHits.length ? ': ' + diskHits.join(', ') : ''));

        // ==== 5. every ssh op authenticated with the password ====
        const okConns = authLog.filter((e) => e.outcome === 'password-ok').length;
        const wrongConns = authLog.filter((e) => e.outcome === 'password-wrong').length;
        const keyOnlyConns = authLog.filter((e) => e.outcome === 'pending').length; // never got past none/publickey
        log('server auth log: ' + JSON.stringify(authLog));
        ok(keyOnlyConns >= 1, 'the silent key attempt reached the server and offered no password (' + keyOnlyConns + ' key-only connection(s))');
        ok(wrongConns >= 1, 'the wrong password was really presented and rejected (' + wrongConns + ' connection(s))');
        ok(okConns >= 3, 'session read + ensure/settle + tunnel each re-authenticated with the password (' + okConns + ' password-auth\'d connections)');

        // ==== 6. disconnect tears the tunnel down ====
        await page.click('[data-test-id="remote-indicator"]');
        await page.locator('[data-test-id="remote-disconnect-btn"]').waitFor({ state: 'visible', timeout: 5000 });
        await page.click('[data-test-id="remote-disconnect-btn"]');
        await waitFor(async () => !(await portAnswers(localPort)), 10000, 'forwarded local port to close');
        ok(true, 'disconnect tore the password-auth\'d tunnel down');
        const pwVal = await page.inputValue('[data-test-id="remote-password-input"]');
        ok(pwVal === '', 'the password input was cleared after the successful connect');

        log('ALL CHECKS PASSED');
    } catch (err) {
        exitCode = 1;
        log('E2E FAILED: ' + (err && err.stack || err));
        try {
            if (clientApp) await clientApp.page.screenshot({ path: path.join(EVID, 'ZZ-failure-client.png') });
            if (remoteApp) await remoteApp.page.screenshot({ path: path.join(EVID, 'ZZ-failure-remote.png') });
        } catch (_) { /* best effort */ }
    } finally {
        try { if (clientApp) await clientApp.app.close(); } catch (_) { /* ignore */ }
        try { if (remoteApp) await remoteApp.app.close(); } catch (_) { /* ignore */ }
        try { if (sshServer) sshServer.close(); } catch (_) { /* ignore */ }
        fs.writeFileSync(path.join(EVID, 'transcript.log'), transcript.join('\n') + '\n');
        log('evidence in ' + EVID);
        process.exit(exitCode);
    }
})();
