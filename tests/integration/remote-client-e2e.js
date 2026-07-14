#!/usr/bin/env node
'use strict';

/**
 * remote-client-e2e - Full-loop verification of the Remote Mode CLIENT
 * (the VS Code Remote-SSH style corner control) using ONE machine as both
 * ends, over a real sshd and the real `ssh` binary:
 *
 *   [client Electron app] --(bottom-left UI)--> ssh 127.0.0.1 (throwaway sshd)
 *       -> reads the remote instance's session.json over SSH
 *       -> opens ssh -N -L tunnel
 *       -> embeds http://127.0.0.1:<localPort>/#k=<token> in the in-app iframe
 *   [remote Electron app] runs with CCBOT_REMOTE=1 + isolated XDG_CONFIG_HOME
 *
 * Verifies, in order:
 *   1. corner indicator exists and opens the connect panel
 *   2. a bad session path surfaces a clear error (failure handling)
 *   3. connect: ssh token read + tunnel + embedded view loads the remote UI
 *   4. the embedded remote terminal streams AND accepts keystrokes
 *      (a marker command typed in the iframe echoes back through the tunnel,
 *       and is ALSO confirmed on the remote instance's own xterm buffer)
 *   5. disconnect tears the tunnel down (forwarded port stops answering,
 *      no ssh -L child remains) and returns to the local interface
 *
 * Isolation: both app instances run with their own XDG_CONFIG_HOME, so the
 * real interface/session file on this machine is never touched. SSH runs
 * against a THROWAWAY sshd (own host key, own authorized_keys, high port)
 * spawned by this script — nothing in the user's ~/.ssh is read or written
 * (the client passes -i/-o UserKnownHostsFile via the panel's Advanced ssh
 * options, which is exactly the feature's escape hatch for custom setups).
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
const WORK = process.env.CCBOT_E2E_DIR
    ? path.resolve(process.env.CCBOT_E2E_DIR)
    : path.join(APP_ROOT, '.e2e-remote-client');
const EVID = path.join(WORK, 'evidence');
const SSHD_DIR = path.join(WORK, 'sshd');
const CFG_REMOTE = path.join(WORK, 'cfg-remote');   // XDG_CONFIG_HOME of the "remote" instance
const CFG_CLIENT = path.join(WORK, 'cfg-client');   // XDG_CONFIG_HOME of the client instance
const SSHD_PORT = Number(process.env.CCBOT_E2E_SSHD_PORT || 2299);
const REMOTE_MODE_PORT = Number(process.env.CCBOT_E2E_REMOTE_PORT || 18230);
const USER = os.userInfo().username;

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

/** The Advanced "extra ssh options" value the panel gets — the throwaway identity. */
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
        CCBOT_REMOTE: remoteMode ? '1' : '0',
        CCBOT_REMOTE_PORT: String(REMOTE_MODE_PORT),
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
    });
    const app = await _electron.launch({
        args: [APP_ROOT, '--no-sandbox', '--disable-gpu'],
        cwd: APP_ROOT,
        env
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
    return { app, page };
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

        // ---- the "remote" machine: app with CCBOT_REMOTE=1, isolated config ----
        log('launching REMOTE app instance (CCBOT_REMOTE=1, XDG_CONFIG_HOME=' + CFG_REMOTE + ')');
        remoteApp = await launchApp(_electron, { xdgConfig: CFG_REMOTE, remoteMode: true });
        const remoteSessionPath = path.join(CFG_REMOTE, 'ccbot', 'session.json');
        const session = await waitFor(() => {
            try {
                const s = JSON.parse(fs.readFileSync(remoteSessionPath, 'utf8'));
                return (s.remote && s.remote.port) ? s : null;
            } catch (_) { return null; }
        }, 30000, 'remote session.json with remote.port');
        ok(session.remote.port === REMOTE_MODE_PORT, 'remote instance advertises RemoteServer port ' + session.remote.port);

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
        await remoteApp.page.screenshot({ path: path.join(EVID, '00-remote-instance.png') });

        // ---- the client app: isolated config, remote mode OFF ----
        log('launching CLIENT app instance (XDG_CONFIG_HOME=' + CFG_CLIENT + ')');
        clientApp = await launchApp(_electron, { xdgConfig: CFG_CLIENT, remoteMode: false });
        const page = clientApp.page;

        // 1. corner indicator + panel
        const indicator = page.locator('[data-test-id="remote-indicator"]');
        await indicator.waitFor({ state: 'visible', timeout: 20000 });
        ok(true, 'bottom-left remote indicator is visible');
        const box = await indicator.boundingBox();
        const vp = page.viewportSize() || { width: 1500, height: 950 };
        ok(box && box.x < 40 && (box.y + box.height) > vp.height - 40,
            'indicator sits in the BOTTOM-LEFT corner (x=' + Math.round(box.x) + ', bottom=' + Math.round(box.y + box.height) + '/' + vp.height + ')');
        await page.screenshot({ path: path.join(EVID, '01-client-idle.png') });

        await indicator.click();
        await page.locator('[data-test-id="remote-panel"]').waitFor({ state: 'visible', timeout: 5000 });
        ok(true, 'clicking the indicator opens the connect panel');
        await page.screenshot({ path: path.join(EVID, '02-connect-panel.png') });

        // fill the form (Advanced holds the throwaway identity + the isolated session path)
        await page.fill('[data-test-id="remote-host-input"]', '127.0.0.1');
        await page.fill('[data-test-id="remote-port-input"]', String(SSHD_PORT));
        await page.fill('[data-test-id="remote-user-input"]', USER);
        await page.click('[data-test-id="remote-advanced-toggle"]');
        await page.fill('[data-test-id="remote-ssh-options-input"]', sshOptionsValue());

        // 2. failure handling first: a wrong session path must surface a clear error
        await page.fill('[data-test-id="remote-session-path-input"]', '/nonexistent/ccbot/session.json');
        await page.click('[data-test-id="remote-connect-btn"]');
        await waitFor(async () => {
            const t = await page.locator('[data-test-id="remote-panel-status"]').textContent();
            return t && /No ccbot session file|not running/i.test(t) ? t : null;
        }, 30000, 'clear "no session file" error message');
        ok(true, 'bad session path surfaces a clear "app not running there" error');
        await page.screenshot({ path: path.join(EVID, '03-connect-error.png') });

        // 3. real connect
        await page.fill('[data-test-id="remote-session-path-input"]', remoteSessionPath);
        await page.click('[data-test-id="remote-connect-btn"]');
        await waitFor(async () => {
            const t = await page.locator('[data-test-id="remote-indicator-label"]').textContent();
            return /^Remote: 127\.0\.0\.1$/.test((t || '').trim()) ? t : null;
        }, 40000, 'indicator shows "Remote: 127.0.0.1"');
        ok(true, 'indicator shows "Remote: 127.0.0.1" after connect');

        const frameEl = page.locator('[data-test-id="remote-view-frame"]');
        await page.locator('[data-test-id="remote-view-container"]').waitFor({ state: 'visible', timeout: 5000 });
        const frameSrc = await frameEl.getAttribute('src');
        ok(/^http:\/\/127\.0\.0\.1:\d+\/#k=/.test(frameSrc), 'embedded view loads a loopback tunnel URL with the token in the fragment');
        const localPort = Number(new URL(frameSrc).port);
        log('tunnel local port: ' + localPort);

        // the iframe runs the REAL remote renderer over the WS bridge
        const frame = await waitFor(async () => {
            for (const f of page.frames()) {
                if (f.url().startsWith('http://127.0.0.1:' + localPort + '/')) return f;
            }
            return null;
        }, 15000, 'embedded remote frame');
        await waitFor(async () => frame.evaluate(() => window.__ccbotRemote && window.__ccbotRemote.authed).catch(() => false),
            30000, 'embedded view WS-authenticated to the remote server');
        ok(true, 'embedded view authenticated to the remote RemoteServer over the tunnel');

        // 4. the remote terminal streams + takes input, 1:1, inside the app
        await waitFor(async () => frame.evaluate(() => {
            const g = window.terminalGUI;
            if (!g || !g.readTerminalScreen) return false;
            const s = g.readTerminalScreen(1, {});
            return !!(s && s.ok && /\$|#|%|>/.test(s.screen || ''));
        }).catch(() => false), 40000, 'remote terminal replayed into the embedded view');
        ok(true, 'remote terminal 1 rendered (with replayed screen) inside the embedded view');
        await page.screenshot({ path: path.join(EVID, '04-connected-remote-ui.png') });

        const marker = 'CCBOT_E2E_' + Math.random().toString(36).slice(2, 10).toUpperCase();
        await frame.locator('.terminal-wrapper[data-terminal-id="1"] .xterm').first().click();
        await page.keyboard.type('echo ' + marker, { delay: 25 });
        await page.keyboard.press('Enter');

        // (a) the echo must stream BACK into the embedded view's xterm buffer
        await waitFor(async () => frame.evaluate((m) => {
            const s = window.terminalGUI.readTerminalScreen(1, { scrollback: true });
            if (!s || !s.ok) return false;
            // the OUTPUT line (not the typed command): marker at line start
            return s.screen.split('\n').some((l) => l.trim() === m);
        }, marker).catch(() => false), 20000, 'marker output echoed in the embedded view');
        ok(true, 'keystrokes typed in the embedded view reached the remote PTY and the output streamed back (marker ' + marker + ')');

        // (b) belt & braces: the REMOTE instance's own xterm shows the same output
        const remoteSeen = await remoteApp.page.evaluate((m) => {
            const s = window.terminalGUI.readTerminalScreen(1, { scrollback: true });
            return !!(s && s.ok && s.screen.split('\n').some((l) => l.trim() === m));
        }, marker);
        ok(remoteSeen, 'the same marker output is on the REMOTE instance\'s own terminal (true shared PTY)');
        await page.screenshot({ path: path.join(EVID, '05-terminal-echo.png') });
        await remoteApp.page.screenshot({ path: path.join(EVID, '05b-remote-instance-same-echo.png') });

        // 5. disconnect tears everything down
        await indicator.click();
        await page.locator('[data-test-id="remote-disconnect-btn"]').waitFor({ state: 'visible', timeout: 5000 });
        await page.screenshot({ path: path.join(EVID, '06-connected-panel.png') });
        await page.click('[data-test-id="remote-disconnect-btn"]');
        await waitFor(async () => {
            const hidden = await page.locator('[data-test-id="remote-view-container"]').isHidden();
            const label = await page.locator('[data-test-id="remote-indicator-label"]').textContent();
            return hidden && !(label || '').trim();
        }, 10000, 'embedded view removed + indicator back to idle');
        ok(true, 'disconnect returns to the local interface (view gone, indicator idle)');

        await waitFor(async () => !(await portAnswers(localPort)), 10000, 'forwarded local port to close');
        ok(true, 'tunnel torn down: 127.0.0.1:' + localPort + ' no longer answers');
        const leftover = spawnSync('pgrep', ['-f', '127\\.0\\.0\\.1:' + localPort + ':127\\.0\\.0\\.1:'], { encoding: 'utf8' });
        ok(leftover.status !== 0, 'no ssh -L child process remains for the tunnel');
        await page.screenshot({ path: path.join(EVID, '07-disconnected.png') });

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
        fs.writeFileSync(path.join(EVID, 'transcript.log'), transcript.join('\n') + '\n');
        log('evidence in ' + EVID);
        process.exit(exitCode);
    }
})();
