#!/usr/bin/env node
'use strict';

/**
 * remote-autostart - Runs ON THE REMOTE machine (over the Remote Mode
 * client's SSH channel) to make sure the Auto-Injector app there is up and
 * serving Remote Mode, WITHOUT the user having to touch that machine.
 *
 *   ensure [--session-file <path>]
 *
 * Detects the remote app's state and acts:
 *   1. app running + Remote Mode ON            -> nothing to do ("already-on")
 *   2. app running + Remote Mode OFF           -> POST /remote/enable on the
 *      loopback Control API (token from the 0600 session file — it never
 *      leaves this machine), which starts the RemoteServer live, with NO
 *      restart, then wait for session.json to advertise remote.port
 *      ("enabled")
 *   3. app NOT running (no/stale session file) -> launch the app headless,
 *      detached, with CCBOT_REMOTE=1 — via `xvfb-run -a` on display-less
 *      Linux (Electron needs an X server) — and wait for a fresh session.json
 *      with remote.port ("started")
 *
 * It is invoked by src/main/remote-client.js as
 *   ELECTRON_RUN_AS_NODE=1 <appRoot>/node_modules/electron/dist/electron \
 *       <appRoot>/scripts/remote-autostart.js ensure ...
 * so it always has a Node runtime (the app's own Electron binary) even when
 * the remote's non-interactive SSH PATH has no `node`. Under
 * ELECTRON_RUN_AS_NODE, process.execPath IS the Electron binary — which is
 * exactly what state 3 needs to relaunch the GUI app.
 *
 * Output protocol (stdout, parsed by remote-client):
 *   CCBOT_AUTOSTART_STATUS:<free text>            progress lines
 *   CCBOT_AUTOSTART_RESULT:{"ok":true,"action":"already-on|enabled|started","port":N}
 *   CCBOT_AUTOSTART_RESULT:{"ok":false,"error":"user-facing message"}
 *
 * Everything stays loopback: the Control API POST goes to 127.0.0.1 and the
 * token is read from (and stays on) this machine.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const ENABLE_WAIT_MS = 30000;   // Remote Mode ON after /remote/enable (incl. a bundle build)
const START_WAIT_MS = 45000;    // full headless app start
const POLL_MS = 500;

function status(msg) {
    process.stdout.write('CCBOT_AUTOSTART_STATUS:' + msg + '\n');
}
function finish(result, code) {
    process.stdout.write('CCBOT_AUTOSTART_RESULT:' + JSON.stringify(result) + '\n');
    process.exit(code);
}
function die(error) {
    finish({ ok: false, error }, 1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultSessionFile() {
    const base = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
        ? process.env.XDG_CONFIG_HOME
        : path.join(os.homedir(), '.config');
    return path.join(base, 'ccbot', 'session.json');
}

function readSession(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && parsed.port && parsed.token) return parsed;
        return null;
    } catch (_) { return null; }
}

/** Any HTTP answer on the hook port means the app is alive; refused = dead. */
function hookApiAlive(port) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/state', timeout: 2000 }, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function postEnable(port, token) {
    return new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1', port, path: '/remote/enable', method: 'POST',
            headers: { 'X-CCBOT-Token': token, 'Content-Type': 'application/json' },
            timeout: 20000 // may include an on-demand renderer bundle build
        }, (res) => {
            let body = '';
            res.on('data', (d) => { body += d; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch (_) { /* fall through */ }
                resolve({ statusCode: res.statusCode, body: parsed });
            });
        });
        req.on('error', (err) => resolve({ error: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'enable request timed out' }); });
        req.end();
    });
}

async function waitForRemoteOn(file, timeoutMs, { requireDifferentTo } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const s = readSession(file);
        if (s && s.remote && s.remote.port) {
            const isOld = requireDifferentTo &&
                s.pid === requireDifferentTo.pid && s.startedAt === requireDifferentTo.startedAt;
            if (!isOld) return s;
        }
        if (Date.now() > deadline) return null;
        await sleep(POLL_MS);
    }
}

function tailFile(file, maxChars) {
    try {
        const t = fs.readFileSync(file, 'utf8');
        return t.slice(-maxChars).replace(/\s+/g, ' ').trim();
    } catch (_) { return ''; }
}

/** State 3: launch the app headless + detached with CCBOT_REMOTE=1. */
function startHeadless(sessionFile) {
    const cfgDir = path.dirname(sessionFile);                 // .../ccbot
    const xdgConfigHome = path.dirname(cfgDir);               // the app's XDG_CONFIG_HOME
    const logFile = path.join(cfgDir, 'remote-autostart.log');
    try { fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 }); } catch (_) { /* ok */ }

    // Under ELECTRON_RUN_AS_NODE process.execPath IS the app's Electron
    // binary; otherwise (plain `node` invocation) find it in the app tree.
    let electronBin = process.env.ELECTRON_RUN_AS_NODE ? process.execPath : null;
    if (!electronBin || !path.basename(electronBin).toLowerCase().includes('electron')) {
        for (const c of [
            path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron'),
            path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        ]) {
            try { fs.accessSync(c, fs.constants.X_OK); electronBin = c; break; } catch (_) { /* next */ }
        }
    }
    if (!electronBin) {
        die('Could not find the app\'s Electron binary under ' + APP_ROOT + '/node_modules — run `npm install` there.');
    }

    const env = Object.assign({}, process.env, {
        CCBOT_REMOTE: '1',
        XDG_CONFIG_HOME: xdgConfigHome
    });
    delete env.ELECTRON_RUN_AS_NODE; // the child must boot the real GUI app

    let cmd;
    let args;
    if (process.platform === 'linux' && !process.env.DISPLAY) {
        // Headless Linux: Electron needs an X server — use a throwaway Xvfb.
        const has = spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' });
        if (has.status !== 0) {
            die('This machine has no display and xvfb-run is not installed — install it (e.g. `sudo apt install xvfb`) so the app can start headless.');
        }
        // --no-sandbox: the SUID chrome-sandbox helper is often unavailable in
        // headless/unattended contexts; same-user loopback-only trust model.
        cmd = 'xvfb-run';
        args = ['-a', electronBin, APP_ROOT, '--no-sandbox', '--disable-gpu'];
    } else {
        // A live display (or macOS, which needs an active login session).
        cmd = electronBin;
        args = [APP_ROOT];
    }

    status('launching the app headless: ' + cmd + ' (log: ' + logFile + ')');
    const out = fs.openSync(logFile, 'a');
    const child = spawn(cmd, args, {
        cwd: APP_ROOT,
        env,
        detached: true,           // own session: survives this ssh connection closing
        stdio: ['ignore', out, out]
    });
    child.unref();
    return { child, logFile };
}

async function ensure(sessionFile) {
    const existing = readSession(sessionFile);

    if (existing) {
        const alive = await hookApiAlive(existing.port);
        if (alive) {
            // State 1: already fully on.
            if (existing.remote && existing.remote.port) {
                finish({ ok: true, action: 'already-on', port: existing.remote.port }, 0);
            }
            // State 2: running, Remote Mode off -> enable live, no restart.
            status('app is running with Remote Mode off - enabling it live (no restart)');
            const res = await postEnable(existing.port, existing.token);
            if (res.error) die('The app is running but its Control API rejected the enable call: ' + res.error);
            if (res.statusCode === 403) die('The session file on this machine is stale (token mismatch). Restart the Auto-Injector app there.');
            if (res.statusCode !== 200 || !res.body || !res.body.ok) {
                die('Could not enable Remote Mode: ' + ((res.body && res.body.error) || ('HTTP ' + res.statusCode)) +
                    (res.body && res.body.error && /old|unknown|no send handler|no invoke handler/i.test(res.body.error)
                        ? ' — the app running there may be too old for live enable; restart it with CCBOT_REMOTE=1.' : ''));
            }
            const s = await waitForRemoteOn(sessionFile, ENABLE_WAIT_MS);
            if (!s) die('Remote Mode was enabled but session.json never advertised it (waited ' + (ENABLE_WAIT_MS / 1000) + 's).');
            finish({ ok: true, action: 'enabled', port: s.remote.port }, 0);
        }
        status('found a stale session file (app not answering) - starting fresh');
    } else {
        status('app is not running - starting it in Remote Mode');
    }

    // State 3: not running (or stale). Start headless + wait for a NEW session.
    const { child, logFile } = startHeadless(sessionFile);
    let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });

    const deadline = Date.now() + START_WAIT_MS;
    for (;;) {
        const s = await waitForRemoteOn(sessionFile, 0, { requireDifferentTo: existing });
        if (s) finish({ ok: true, action: 'started', port: s.remote.port }, 0);
        if (exited && exited.code !== 0 && exited.code !== null) {
            die('The app exited during startup (code ' + exited.code + '). Log tail: ' + (tailFile(logFile, 400) || '(empty)'));
        }
        if (Date.now() > deadline) {
            die('Started the app but session.json never appeared with Remote Mode on (waited ' + (START_WAIT_MS / 1000) + 's). Log tail: ' + (tailFile(logFile, 400) || '(empty)'));
        }
        await sleep(POLL_MS);
    }
}

// ---- CLI ----
(async () => {
    const argv = process.argv.slice(2);
    const command = argv[0];
    if (command !== 'ensure') {
        die('Usage: remote-autostart.js ensure [--session-file <path>]');
    }
    let sessionFile = null;
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--session-file') sessionFile = argv[++i];
    }
    sessionFile = path.resolve(sessionFile || defaultSessionFile());
    status('session file: ' + sessionFile);
    try {
        await ensure(sessionFile);
    } catch (err) {
        die('Unexpected auto-start failure: ' + (err && err.message || err));
    }
})();
