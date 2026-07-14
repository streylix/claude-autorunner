#!/usr/bin/env node
'use strict';

/**
 * remote-client-reload-e2e - Regression proof for the renderer-reload
 * orphan-tunnel bug in the Remote Mode CLIENT.
 *
 * The bug: with a remote connected, a HARD REFRESH of the renderer reset the
 * UI, but the main process kept the live connection + the `ssh -N -L` tunnel
 * child. The app still "believed" it was connected, so the next connect was
 * rejected with "Already connected — disconnect first" and the user was stuck
 * until a full app restart.
 *
 * The fix (verified here end to end over a real throwaway sshd):
 *   a. RELOAD CLEANUP — main.js tears the client connection down on a real
 *      main-frame navigation (webContents 'did-start-navigation'; the embedded
 *      remote iframe is a subframe and does NOT trigger it): after page.reload()
 *      the main-process state is idle, the forwarded port is closed, and NO
 *      orphaned `ssh -N` child remains.
 *   b. RECONNECT AFTER RELOAD — a fresh connect through the command bar
 *      SUCCEEDS (no "already connected" dead-end) and the embedded terminal
 *      echoes keystrokes.
 *   c. EXPLICIT RECONNECT WHILE CONNECTED — a second remote-client-connect
 *      SUPERSEDES the live one cleanly: new tunnel up, old tunnel torn down,
 *      exactly one ssh tunnel child.
 *   d. NORMAL DISCONNECT — still idempotent, still leaves zero ssh children,
 *      and a normal connect/disconnect UI cycle still works (no regression).
 *
 * Isolation: identical harness to remote-client-e2e.js — both app instances
 * get their own XDG_CONFIG_HOME, SSH runs against a THROWAWAY sshd (own host
 * key/authorized_keys/high port); nothing in the user's ~/.ssh or real config
 * is touched.
 *
 * Run headless:  xvfb-run -a node tests/integration/remote-client-reload-e2e.js
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
    : path.join(os.tmpdir(), 'ccbot-e2e-remote-reload');
const EVID = path.join(WORK, 'evidence');
const SSHD_DIR = path.join(WORK, 'sshd');
const CFG_REMOTE = path.join(WORK, 'cfg-remote');
const CFG_CLIENT = path.join(WORK, 'cfg-client');
const SSHD_PORT = Number(process.env.CCBOT_E2E_SSHD_PORT || 2499);
const USER = os.userInfo().username;
const REMOTE_SESSION = path.join(CFG_REMOTE, 'ccbot', 'session.json');

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

/**
 * Every live `ssh … -N … -L 127.0.0.1:<lp>:127.0.0.1:<remotePort>` tunnel
 * child pointed at OUR throwaway remote (scoped by its remote port, so
 * anything else on this machine can never match).
 */
function tunnelPids(remotePort) {
    const r = spawnSync('pgrep', ['-f', '127\\.0\\.0\\.1:[0-9]+:127\\.0\\.0\\.1:' + remotePort], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
}

// ---------- throwaway sshd (same recipe as remote-client-e2e.js) ----------

function setupSshd() {
    fs.rmSync(SSHD_DIR, { recursive: true, force: true });
    fs.mkdirSync(SSHD_DIR, { recursive: true, mode: 0o700 });
    const run = (cmd, args) => {
        const r = spawnSync(cmd, args, { encoding: 'utf8' });
        if (r.status !== 0) fail(cmd + ' failed: ' + r.stderr);
        return r;
    };
    run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', path.join(SSHD_DIR, 'host_key')]);
    run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', path.join(SSHD_DIR, 'client_key')]);
    fs.copyFileSync(path.join(SSHD_DIR, 'client_key.pub'), path.join(SSHD_DIR, 'authorized_keys'));
    fs.chmodSync(path.join(SSHD_DIR, 'authorized_keys'), 0o600);
    const conf = [
        'Port ' + SSHD_PORT,
        'ListenAddress 127.0.0.1',
        'HostKey ' + path.join(SSHD_DIR, 'host_key'),
        'PidFile ' + path.join(SSHD_DIR, 'sshd.pid'),
        'AuthorizedKeysFile ' + path.join(SSHD_DIR, 'authorized_keys'),
        'PubkeyAuthentication yes',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'ChallengeResponseAuthentication no',
        'UsePAM no',
        'StrictModes no',
        'AllowTcpForwarding yes',
        'LogLevel VERBOSE'
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(SSHD_DIR, 'sshd_config'), conf);
    const child = spawn('/usr/sbin/sshd', ['-f', path.join(SSHD_DIR, 'sshd_config'), '-D', '-e'], {
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { if (code) log('sshd exited ' + code + ': ' + stderr.slice(-500)); });
    return child;
}

function sshOptionsValue() {
    return [
        '-i', path.join(SSHD_DIR, 'client_key'),
        '-o', 'IdentitiesOnly=yes',
        '-o', 'UserKnownHostsFile=' + path.join(SSHD_DIR, 'known_hosts')
    ].join(' ');
}

// ---------- electron ----------

async function launchApp(_electron, { xdgConfig, remoteMode }) {
    const env = Object.assign({}, process.env, {
        XDG_CONFIG_HOME: xdgConfig,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    });
    delete env.CCBOT_REMOTE;
    delete env.CCBOT_REMOTE_PORT;
    if (remoteMode) env.CCBOT_REMOTE = '1';
    const app = await _electron.launch({
        args: [APP_ROOT, '--no-sandbox', '--disable-gpu'],
        cwd: APP_ROOT,
        env
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
    return { app, page };
}

// ---------- command bar helpers (same as remote-client-e2e.js) ----------

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
        window.__statusLog = [];
        const push = () => {
            const t = (el.textContent || '').trim();
            if (t && window.__statusLog[window.__statusLog.length - 1] !== t) window.__statusLog.push(t);
        };
        new MutationObserver(push).observe(el, { childList: true, characterData: true, subtree: true });
        push();
    });
}
const statusLog = (page) => page.evaluate(() => window.__statusLog || []);

/** Fill the full connect form (advanced incl.) and click Connect. */
async function fillAndConnect(page) {
    await openCommandBar(page);
    const advBox = page.locator('#remote-advanced-box');
    if (await advBox.isHidden()) await page.click('[data-test-id="remote-advanced-toggle"]');
    await page.fill('[data-test-id="remote-ssh-options-input"]', sshOptionsValue());
    await page.fill('[data-test-id="remote-session-path-input"]', REMOTE_SESSION);
    await page.fill('[data-test-id="remote-command-input"]', 'ssh ' + USER + '@127.0.0.1 -p ' + SSHD_PORT);
    await armStatusLog(page);
    await page.click('[data-test-id="remote-connect-btn"]');
}

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
    const marker = 'CCBOT_E2E_' + Math.random().toString(36).slice(2, 10).toUpperCase();
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

/** The main-process RemoteClient status, straight over IPC (never stale UI). */
const mainClientStatus = (page) =>
    page.evaluate(() => require('electron').ipcRenderer.invoke('remote-client-status'));

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

    let sshd = null;
    let remoteApp = null;
    let clientApp = null;
    let exitCode = 0;
    let remotePort = 0;

    try {
        // ---- throwaway sshd ----
        sshd = setupSshd();
        await waitFor(() => portAnswers(SSHD_PORT), 8000, 'sshd on :' + SSHD_PORT);
        log('sshd up on 127.0.0.1:' + SSHD_PORT);

        // ---- the "remote" machine: app WITH Remote Mode already on (fast path) ----
        log('launching REMOTE app instance with CCBOT_REMOTE=1 (XDG_CONFIG_HOME=' + CFG_REMOTE + ')');
        remoteApp = await launchApp(_electron, { xdgConfig: CFG_REMOTE, remoteMode: true });
        const session = await waitFor(() => {
            const s = readRemoteSession();
            return (s && s.token && s.remote && s.remote.port) ? s : null;
        }, 30000, 'remote session.json advertising Remote Mode');
        remotePort = session.remote.port;
        log('remote instance pid ' + session.pid + ', Remote Mode on 127.0.0.1:' + remotePort);
        await waitFor(async () => {
            const r = await remoteApp.page.evaluate(() => {
                const g = window.terminalGUI;
                if (!g || !g.readTerminalScreen) return false;
                const s = g.readTerminalScreen(1, {});
                return !!(s && s.ok && /\$|#|%|>/.test(s.screen || ''));
            }).catch(() => false);
            return r;
        }, 30000, 'remote terminal 1 shell prompt');

        // ---- the client app ----
        log('launching CLIENT app instance (XDG_CONFIG_HOME=' + CFG_CLIENT + ')');
        clientApp = await launchApp(_electron, { xdgConfig: CFG_CLIENT, remoteMode: false });
        const page = clientApp.page;
        await page.locator('[data-test-id="remote-indicator"]').waitFor({ state: 'visible', timeout: 20000 });

        // ==== 0. baseline connect ====
        await fillAndConnect(page);
        const portA = await waitConnected(page, 60000);
        await attachEmbedded(page, portA);
        ok(tunnelPids(remotePort).length === 1, 'exactly one ssh -N tunnel child while connected (port ' + portA + ')');
        await page.screenshot({ path: path.join(EVID, '01-connected-before-reload.png') });

        // ==== a. HARD REFRESH the renderer → main must clean up the orphan ====
        log('hard-reloading the renderer (page.reload) while connected…');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-test-id="remote-indicator"]').waitFor({ state: 'visible', timeout: 20000 });
        await waitFor(async () => {
            const s = await mainClientStatus(page);
            return s && s.phase === 'idle' ? s : null;
        }, 10000, 'main-process RemoteClient to reset to idle after the reload');
        ok(true, 'main-process connection state cleared by the reload (phase=idle)');
        await waitFor(async () => !(await portAnswers(portA)), 10000, 'old forwarded port to close after the reload');
        ok(true, 'old tunnel port 127.0.0.1:' + portA + ' no longer answers');
        await waitFor(async () => tunnelPids(remotePort).length === 0, 10000, 'orphaned ssh -N child to be killed');
        ok(true, 'NO orphaned ssh -N tunnel child survives the reload (pgrep clean)');
        const label = (await page.locator('[data-test-id="remote-indicator-label"]').textContent() || '').trim();
        ok(label === '', 'indicator is back to the idle (local) state after the reload');
        await page.screenshot({ path: path.join(EVID, '02-after-reload-idle.png') });

        // ==== b. fresh connect after the reload → must SUCCEED ====
        log('connecting again after the reload (the old bug dead-ended here)…');
        await fillAndConnect(page);
        const portB = await waitConnected(page, 60000);
        const statuses = await statusLog(page);
        log('post-reload connect statuses: ' + JSON.stringify(statuses));
        ok(!statuses.some((s) => /already connected|already connecting/i.test(s)),
            'no "already connected" dead-end after the reload');
        const frameB = await attachEmbedded(page, portB);
        const markerB = await proveEcho(page, frameB);
        ok(true, 'post-reload reconnect works end to end — embedded terminal echoes (marker ' + markerB + ')');
        ok(tunnelPids(remotePort).length === 1, 'exactly one ssh -N tunnel child after the reconnect');
        await page.screenshot({ path: path.join(EVID, '03-reconnected-after-reload.png') });

        // ==== c. explicit reconnect WHILE connected → supersedes cleanly ====
        log('issuing a second remote-client-connect while connected (must supersede, not fail)…');
        const res = await page.evaluate((opts) =>
            require('electron').ipcRenderer.invoke('remote-client-connect', opts), {
            host: '127.0.0.1',
            username: USER,
            sshPort: SSHD_PORT,
            sessionPath: REMOTE_SESSION,
            sshOptions: sshOptionsValue()
        });
        ok(res && res.ok === true, 'reconnect-while-connected returns ok (no "already connected" rejection): ' + JSON.stringify(res && res.error || ''));
        const portC = res.localPort;
        ok(portC && portC !== portB, 'supersede opened a NEW tunnel (port ' + portC + ', was ' + portB + ')');
        await waitFor(() => portAnswers(portC), 10000, 'new tunnel port to answer');
        await waitFor(async () => !(await portAnswers(portB)), 10000, 'old tunnel port to close after supersede');
        ok(true, 'old tunnel (127.0.0.1:' + portB + ') torn down, new tunnel (127.0.0.1:' + portC + ') live');
        await waitFor(async () => tunnelPids(remotePort).length === 1, 10000, 'exactly one tunnel child after supersede');
        ok(true, 'exactly one ssh -N tunnel child after the supersede (no leak, no double-tunnel)');
        const st = await mainClientStatus(page);
        ok(st.phase === 'connected' && st.localPort === portC, 'main-process state tracks the NEW connection');

        // ==== d. disconnect → idempotent, zero ssh children ====
        const d1 = await page.evaluate(() => require('electron').ipcRenderer.invoke('remote-client-disconnect'));
        const d2 = await page.evaluate(() => require('electron').ipcRenderer.invoke('remote-client-disconnect'));
        ok(d1 && d1.ok && d2 && d2.ok, 'disconnect is idempotent (second call is a clean no-op)');
        await waitFor(async () => !(await portAnswers(portC)), 10000, 'tunnel port to close on disconnect');
        await waitFor(async () => tunnelPids(remotePort).length === 0, 10000, 'zero ssh tunnel children after disconnect');
        ok(true, 'normal disconnect leaves ZERO ssh -N children');
        ok((await mainClientStatus(page)).phase === 'idle', 'main-process state idle after disconnect');

        // ==== d2. normal UI connect/disconnect cycle still works (no regression) ====
        // The UI still holds the pre-supersede view; reload first so it starts
        // clean, exactly like a user would after our IPC-level poking.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-test-id="remote-indicator"]').waitFor({ state: 'visible', timeout: 20000 });
        await fillAndConnect(page);
        const portD = await waitConnected(page, 60000);
        await attachEmbedded(page, portD);
        await page.click('[data-test-id="remote-indicator"]');
        await page.locator('[data-test-id="remote-disconnect-btn"]').waitFor({ state: 'visible', timeout: 5000 });
        await page.click('[data-test-id="remote-disconnect-btn"]');
        await waitFor(async () => page.locator('[data-test-id="remote-view-container"]').isHidden(), 10000, 'embedded view removed');
        await waitFor(async () => !(await portAnswers(portD)), 10000, 'forwarded port to close');
        await waitFor(async () => tunnelPids(remotePort).length === 0, 10000, 'zero tunnel children after UI disconnect');
        ok(true, 'normal UI connect → disconnect cycle unregressed (view down, port closed, no ssh children)');
        await page.screenshot({ path: path.join(EVID, '04-final-disconnected.png') });

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
        try { if (sshd) sshd.kill('SIGTERM'); } catch (_) { /* ignore */ }
        // Absolute last check: nothing pointed at our throwaway remote survives.
        if (remotePort) {
            const left = tunnelPids(remotePort);
            if (left.length) {
                log('WARNING: killing leftover tunnel pids ' + left.join(','));
                for (const pid of left) { try { process.kill(Number(pid), 'SIGKILL'); } catch (_) { /* gone */ } }
            }
        }
        fs.writeFileSync(path.join(EVID, 'transcript.log'), transcript.join('\n') + '\n');
        log('evidence in ' + EVID);
        process.exit(exitCode);
    }
})();
