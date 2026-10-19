#!/usr/bin/env node
'use strict';

/**
 * remote-client-e2e - Full-loop verification of the Remote Mode CLIENT
 * (top-middle ssh command bar + corner indicator + AUTO-START) using ONE
 * machine as both ends, over a real sshd and the real `ssh` binary:
 *
 *   [client Electron app] --(top-middle command bar: `ssh user@127.0.0.1 -p N`)-->
 *       ssh 127.0.0.1 (throwaway sshd)
 *       -> reads the remote instance's session.json over SSH
 *       -> if Remote Mode is not up, FIXES it over the same channel
 *          (scripts/remote-autostart.js): live-enable via POST /remote/enable
 *          when the app is running, headless CCBOT_REMOTE=1 cold start when not
 *       -> opens ssh -N -L tunnel
 *       -> embeds http://127.0.0.1:<localPort>/#k=<token> in the in-app iframe
 *
 * Verifies, in order:
 *   1. corner indicator opens the command bar at the TOP-MIDDLE; the ssh
 *      command is real editable text
 *   2. clean failures: unreachable host; app never ran on the remote
 *      (no app-root) — both surface clear, specific messages
 *   3. STATE remote-off: remote app running WITHOUT Remote Mode → connect
 *      auto-ENABLES it live (session.json gains remote.port, SAME pid — no
 *      restart), embeds, and a marker keystroke echoes on BOTH sides
 *   4. disconnect tears the tunnel down
 *   5. STATE not-running: remote app closed → connect auto-STARTS it headless
 *      (fresh session.json with remote.port + NEW live pid, spawned by the
 *      client's action), embeds, marker echo through the tunnel
 *   6. STATE remote-on (fast path): reconnect to the auto-started app —
 *      connects with NO enable/start phase, pid unchanged
 *
 * Isolation: both app instances run with their own XDG_CONFIG_HOME, so the
 * real interface/session file on this machine is never touched. SSH runs
 * against a THROWAWAY sshd (own host key, own authorized_keys, high port)
 * spawned by this script — nothing in the user's ~/.ssh is read or written.
 *
 * Run headless:  xvfb-run -a node tests/integration/remote-client-e2e.js
 * Evidence (screenshots + transcript) goes to $CCBOT_E2E_DIR or ./.e2e-remote-client.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
// The work dir MUST be on a POSIX filesystem: sshd refuses host keys with
// open permissions and the app writes 0600 session files — a repo checkout on
// NTFS/FUSE (perms not honored) would break both. tmpdir is always safe.
const WORK = process.env.CCBOT_E2E_DIR
    ? path.resolve(process.env.CCBOT_E2E_DIR)
    : path.join(os.tmpdir(), 'ccbot-e2e-remote-client');
const EVID = path.join(WORK, 'evidence');
const SSHD_DIR = path.join(WORK, 'sshd');
const CFG_REMOTE = path.join(WORK, 'cfg-remote');   // XDG_CONFIG_HOME of the "remote" instance
const CFG_CLIENT = path.join(WORK, 'cfg-client');   // XDG_CONFIG_HOME of the client instance
const SSHD_PORT = Number(process.env.CCBOT_E2E_SSHD_PORT || 2299);
const USER = os.userInfo().username;
const REMOTE_SESSION = path.join(CFG_REMOTE, 'ccbot', 'session.json');
const REMOTE_APP_ROOT_FILE = path.join(CFG_REMOTE, 'ccbot', 'app-root');

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

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// ---------- throwaway sshd ----------

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

/** The Advanced "extra ssh options" value the bar gets — the throwaway identity. */
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
    // remoteMode: true → CCBOT_REMOTE=1; false → unset (so a live
    // POST /remote/enable is allowed — '0' would force-disable it).
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

// ---------- command bar helpers ----------

async function openCommandBar(page) {
    const bar = page.locator('[data-test-id="remote-command-bar"]');
    if (await bar.isHidden()) {
        await page.click('[data-test-id="remote-indicator"]');
        await bar.waitFor({ state: 'visible', timeout: 5000 });
    }
    return bar;
}

/** Install a MutationObserver that records every status-line message. */
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

async function typeCommandAndConnect(page, command) {
    await openCommandBar(page);
    await page.fill('[data-test-id="remote-command-input"]', command);
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

/** Locate the embedded frame + wait for WS auth + terminal replay. */
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

/** Type a marker into embedded terminal 1 and wait for its echo (output line). */
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

async function disconnect(page, localPort) {
    await page.click('[data-test-id="remote-indicator"]');
    await page.locator('[data-test-id="remote-disconnect-btn"]').waitFor({ state: 'visible', timeout: 5000 });
    await page.click('[data-test-id="remote-disconnect-btn"]');
    await waitFor(async () => page.locator('[data-test-id="remote-view-container"]').isHidden(), 10000,
        'embedded view removed');
    await waitFor(async () => !(await portAnswers(localPort)), 10000, 'forwarded local port to close');
    ok(true, 'disconnect tore the tunnel down (127.0.0.1:' + localPort + ' no longer answers)');
}

// ---------- main ----------

(async () => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(EVID, { recursive: true });
    fs.mkdirSync(CFG_REMOTE, { recursive: true });
    fs.mkdirSync(CFG_CLIENT, { recursive: true });

    const { _electron } = require(path.join(APP_ROOT, 'node_modules', 'playwright'));

    // The remote instance serves an esbuild bundle of the renderer to the
    // embedded view — rebuild it so it can never be stale vs. the sources.
    log('building remote renderer bundle (npm run build-remote)…');
    const build = spawnSync('npm', ['run', 'build-remote'], { cwd: APP_ROOT, encoding: 'utf8' });
    if (build.status !== 0) fail('build-remote failed: ' + (build.stderr || '').slice(-500));

    let sshd = null;
    let remoteApp = null;
    let clientApp = null;
    let autoStartedPid = null;
    let exitCode = 0;

    try {
        // ---- throwaway sshd ----
        sshd = setupSshd();
        await waitFor(() => portAnswers(SSHD_PORT), 8000, 'sshd on :' + SSHD_PORT);
        log('sshd up on 127.0.0.1:' + SSHD_PORT);
        const probe = spawnSync('ssh', [
            '-p', String(SSHD_PORT), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
            '-i', path.join(SSHD_DIR, 'client_key'), '-o', 'IdentitiesOnly=yes',
            '-o', 'UserKnownHostsFile=' + path.join(SSHD_DIR, 'known_hosts'),
            USER + '@127.0.0.1', 'echo SSH_OK'
        ], { encoding: 'utf8' });
        ok(/SSH_OK/.test(probe.stdout), 'throwaway sshd accepts key auth for ' + USER + '@127.0.0.1:' + SSHD_PORT);

        // ---- the "remote" machine: app WITHOUT Remote Mode (state 2) ----
        log('launching REMOTE app instance with Remote Mode OFF (XDG_CONFIG_HOME=' + CFG_REMOTE + ')');
        remoteApp = await launchApp(_electron, { xdgConfig: CFG_REMOTE, remoteMode: false });
        const sessionOff = await waitFor(() => {
            const s = readRemoteSession();
            return (s && s.port && s.token) ? s : null;
        }, 30000, 'remote session.json (Remote Mode off)');
        ok(!sessionOff.remote, 'remote instance is running WITHOUT Remote Mode (no remote block in session.json)');
        ok(fs.existsSync(REMOTE_APP_ROOT_FILE), 'remote instance recorded its install location (app-root file)');
        const offPid = sessionOff.pid;
        log('remote instance pid ' + offPid);

        // remote terminal 1 must be a live PTY before the client attaches
        await waitFor(async () => {
            const r = await remoteApp.page.evaluate(() => {
                const g = window.terminalGUI;
                if (!g || !g.readTerminalScreen) return false;
                const s = g.readTerminalScreen(1, {});
                return !!(s && s.ok && /\$|#|%|>/.test(s.screen || ''));
            }).catch(() => false);
            return r;
        }, 30000, 'remote terminal 1 shell prompt');
        log('remote terminal 1 has a live shell prompt');
        await remoteApp.page.screenshot({ path: path.join(EVID, '00-remote-instance-remote-off.png') });

        // ---- the client app: isolated config ----
        log('launching CLIENT app instance (XDG_CONFIG_HOME=' + CFG_CLIENT + ')');
        clientApp = await launchApp(_electron, { xdgConfig: CFG_CLIENT, remoteMode: false });
        const page = clientApp.page;

        // ==== 1. indicator → TOP-MIDDLE command bar with real editable text ====
        const indicator = page.locator('[data-test-id="remote-indicator"]');
        await indicator.waitFor({ state: 'visible', timeout: 20000 });
        const ibox = await indicator.boundingBox();
        const vp = page.viewportSize() || { width: 1500, height: 950 };
        ok(ibox && ibox.x < 40 && (ibox.y + ibox.height) > vp.height - 40,
            'indicator sits in the BOTTOM-LEFT corner');
        await page.screenshot({ path: path.join(EVID, '01-client-idle.png') });

        const bar = await openCommandBar(page);
        const bbox = await bar.boundingBox();
        const centerX = bbox.x + bbox.width / 2;
        ok(Math.abs(centerX - vp.width / 2) < 60 && bbox.y < 120,
            'command bar appears at the TOP-MIDDLE (center x=' + Math.round(centerX) + '/' + vp.width + ', y=' + Math.round(bbox.y) + ')');
        await page.fill('[data-test-id="remote-command-input"]', 'ssh someone@example');
        const typed = await page.inputValue('[data-test-id="remote-command-input"]');
        ok(typed === 'ssh someone@example', 'the ssh command is REAL editable text in the input (not a placeholder)');
        await page.screenshot({ path: path.join(EVID, '02-command-bar.png') });

        // ==== 2a. clean failure: unreachable host ====
        await armStatusLog(page);
        await page.fill('[data-test-id="remote-command-input"]', 'ssh ' + USER + '@127.0.0.1 -p 1');
        await page.click('[data-test-id="remote-connect-btn"]');
        await waitFor(async () => {
            const t = await page.locator('[data-test-id="remote-command-status"]').textContent();
            return t && /refused|unreachable|failed/i.test(t) ? t : null;
        }, 30000, 'clear "connection refused" error');
        ok(true, 'unreachable host surfaces a clear error message');
        await page.screenshot({ path: path.join(EVID, '03-error-bad-host.png') });

        // ==== 2b. clean failure: app never ran there (no app-root) ====
        // Advanced: throwaway ssh identity + a session path whose config dir
        // has no session.json AND no app-root file.
        await page.click('[data-test-id="remote-advanced-toggle"]');
        await page.fill('[data-test-id="remote-ssh-options-input"]', sshOptionsValue());
        await page.fill('[data-test-id="remote-session-path-input"]', '/nonexistent/ccbot/session.json');
        await page.fill('[data-test-id="remote-command-input"]', 'ssh ' + USER + '@127.0.0.1 -p ' + SSHD_PORT);
        await page.click('[data-test-id="remote-connect-btn"]');
        await waitFor(async () => {
            const t = await page.locator('[data-test-id="remote-command-status"]').textContent();
            return t && /never run on|Remote app directory/i.test(t) ? t : null;
        }, 30000, 'clear "app never ran there" error');
        ok(true, 'missing app on the remote surfaces the specific auto-start error (set app dir / run once)');
        await page.screenshot({ path: path.join(EVID, '04-error-no-app-root.png') });

        // ==== 3. STATE remote-off → live AUTO-ENABLE (no restart) ====
        await page.fill('[data-test-id="remote-session-path-input"]', REMOTE_SESSION);
        const CMD = 'ssh ' + USER + '@127.0.0.1 -p ' + SSHD_PORT;
        await typeCommandAndConnect(page, CMD);
        const localPort1 = await waitConnected(page, 60000);
        const statuses1 = await statusLog(page);
        log('connect statuses: ' + JSON.stringify(statuses1));
        ok(statuses1.some((s) => /Remote Mode off|enabling it now|no restart/i.test(s)),
            'UI narrated the live-enable phase ("…running with Remote Mode off — enabling it now (no restart)…")');
        const sessionOn = readRemoteSession();
        ok(sessionOn && sessionOn.remote && sessionOn.remote.port,
            'session.json now advertises Remote Mode (remote.port=' + (sessionOn.remote && sessionOn.remote.port) + ') — enabled by the client\'s action');
        ok(sessionOn.pid === offPid, 'SAME app pid (' + offPid + ') — Remote Mode was enabled live, with NO restart');

        const frame1 = await attachEmbedded(page, localPort1);
        ok(true, 'embedded view authenticated + replayed after auto-enable');
        await page.screenshot({ path: path.join(EVID, '05-connected-after-live-enable.png') });
        const marker1 = await proveEcho(page, frame1);
        ok(true, 'keystrokes typed in the embedded view reached the remote PTY and echoed back (marker ' + marker1 + ')');
        const remoteSeen = await remoteApp.page.evaluate((m) => {
            const s = window.terminalGUI.readTerminalScreen(1, { scrollback: true });
            return !!(s && s.ok && s.screen.split('\n').some((l) => l.trim() === m));
        }, marker1);
        ok(remoteSeen, 'the same marker output is on the REMOTE instance\'s own terminal (true shared PTY)');
        await page.screenshot({ path: path.join(EVID, '06-terminal-echo.png') });
        await remoteApp.page.screenshot({ path: path.join(EVID, '06b-remote-instance-same-echo.png') });

        // ==== 4. disconnect ====
        await disconnect(page, localPort1);
        const leftover = spawnSync('pgrep', ['-f', '127\\.0\\.0\\.1:' + localPort1 + ':127\\.0\\.0\\.1:'], { encoding: 'utf8' });
        ok(leftover.status !== 0, 'no ssh -L child process remains for the tunnel');

        // ==== 5. STATE not-running → headless AUTO-START ====
        log('closing the remote instance (session.json is removed; app-root persists)');
        await remoteApp.app.close();
        remoteApp = null;
        await waitFor(() => !fs.existsSync(REMOTE_SESSION), 15000, 'remote session.json removed on shutdown');
        ok(fs.existsSync(REMOTE_APP_ROOT_FILE), 'app-root file SURVIVES shutdown (auto-start discovery)');

        // The command bar is already open (disconnect reopens it) with the
        // command still there as editable text — connect again.
        await typeCommandAndConnect(page, CMD);
        await page.screenshot({ path: path.join(EVID, '07-autostart-in-progress.png') });
        const localPort2 = await waitConnected(page, 120000);
        const statuses2 = await statusLog(page);
        log('connect statuses: ' + JSON.stringify(statuses2));
        ok(statuses2.some((s) => /not running on|starting it in Remote Mode/i.test(s)),
            'UI narrated the cold-start phase ("app is not running — starting it in Remote Mode…")');
        const sessionStarted = readRemoteSession();
        ok(sessionStarted && sessionStarted.remote && sessionStarted.remote.port,
            'a FRESH session.json with remote.port appeared — created by the app the CLIENT auto-started');
        ok(sessionStarted.pid !== offPid && pidAlive(sessionStarted.pid),
            'a NEW app instance is alive on the "remote" (pid ' + sessionStarted.pid + ', old was ' + offPid + ')');
        autoStartedPid = sessionStarted.pid;

        const frame2 = await attachEmbedded(page, localPort2);
        const marker2 = await proveEcho(page, frame2);
        ok(true, 'embedded terminal echoes keystrokes on the AUTO-STARTED instance (marker ' + marker2 + ')');
        await page.screenshot({ path: path.join(EVID, '08-connected-after-autostart.png') });

        // ==== 6. STATE remote-on: the fast path, no enable/start phase ====
        await disconnect(page, localPort2);
        await typeCommandAndConnect(page, CMD);
        const localPort3 = await waitConnected(page, 45000);
        const statuses3 = await statusLog(page);
        log('connect statuses: ' + JSON.stringify(statuses3));
        ok(!statuses3.some((s) => /enabling it now|starting it in Remote Mode|not running on/i.test(s)),
            'fast path: reconnect to an already-serving remote shows NO enable/start phase');
        ok(readRemoteSession().pid === autoStartedPid, 'fast path: pid unchanged (no second instance spawned)');
        await attachEmbedded(page, localPort3);
        ok(true, 'fast path: embedded view authenticated again');
        await page.screenshot({ path: path.join(EVID, '09-fast-path-reconnect.png') });
        await disconnect(page, localPort3);

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
        // The auto-started instance is NOT playwright-owned — kill it by pid.
        try {
            if (autoStartedPid && pidAlive(autoStartedPid)) {
                process.kill(autoStartedPid, 'SIGTERM');
                for (let i = 0; i < 20 && pidAlive(autoStartedPid); i++) await sleep(250);
                if (pidAlive(autoStartedPid)) process.kill(autoStartedPid, 'SIGKILL');
                log('auto-started instance (pid ' + autoStartedPid + ') stopped');
            }
        } catch (_) { /* ignore */ }
        try { if (sshd) sshd.kill('SIGTERM'); } catch (_) { /* ignore */ }
        fs.writeFileSync(path.join(EVID, 'transcript.log'), transcript.join('\n') + '\n');
        log('evidence in ' + EVID);
        process.exit(exitCode);
    }
})();
