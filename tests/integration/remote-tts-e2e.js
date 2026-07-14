#!/usr/bin/env node
'use strict';

/**
 * remote-tts-e2e - Full-loop verification that voice notifications PLAY ON THE
 * DEVICE SHOWING THE INTERFACE (docs/REMOTE_MODE.md §9):
 *
 *   [stand-in TTS backend]  <- POST /api/tts/speak/ (what the manager does)
 *   [remote Electron app]   CCBOT_REMOTE=1, CCBOT_BACKEND_URL -> stand-in
 *   [headless Chromium]     plain-browser Remote Mode client over the WS
 *
 * Verifies, in order:
 *   1. a Remote Mode client attaching flips the LOCAL renderer's audio sink to
 *      "remote" (remoteSinkActive true — no local double-play);
 *   1b. the notifications PANEL mirrors the desktop's: a notification created
 *      BEFORE the viewer attached renders via the /api reverse-proxy history
 *      load (the WS forwarder baselines past it, so the proxy is the only
 *      possible source);
 *   2. a TTS notification fired on the server host is pushed over the
 *      authenticated WebSocket WITH its real audio bytes (byte length checked
 *      against the exact WAV the backend served);
 *   3. the browser client renders the row, creates a blob: URL from the bytes,
 *      and DRIVES PLAYBACK (audio.play() invoked and resolved, `playing` state,
 *      console markers) — i.e. the sound comes out of the viewing device;
 *   4. after playback the played-mark round-trips browser -> WS -> main ->
 *      backend (POST .../played/ observed on the stand-in);
 *   5. the LOCAL renderer rendered the same row but did NOT autoplay it;
 *   6. the client detaching flips the sink back to local, and a notification
 *      fired afterwards is NOT forwarded (it plays locally again).
 *
 * The TTS backend is a STAND-IN implementing the exact Django routes/shapes
 * (speak/, notifications/, audio/<id>/, played/) and returning REAL WAV bytes
 * (valid RIFF, 24 kHz sine) — the full Kokoro Django stack is impractical in a
 * sandbox, but every byte still flows through the very same app code path.
 * NOTE: this is a headless box — acoustic output itself cannot be captured;
 * what is proven is the full delivery + playback-invocation chain.
 *
 * Isolation: the app runs with its own XDG_CONFIG_HOME and its own ports —
 * the machine's real interface and real backend (:8123) are never touched.
 *
 * Run headless:  xvfb-run -a node tests/integration/remote-tts-e2e.js
 * Evidence (screenshots + transcript) goes to $CCBOT_E2E_DIR or ./.e2e-remote-tts.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const WORK = process.env.CCBOT_E2E_DIR
    ? path.resolve(process.env.CCBOT_E2E_DIR)
    : path.join(APP_ROOT, '.e2e-remote-tts');
const EVID = path.join(WORK, 'evidence');
const CFG = path.join(WORK, 'cfg-remote');
const BACKEND_PORT = Number(process.env.CCBOT_E2E_BACKEND_PORT || 18127);
const REMOTE_MODE_PORT = Number(process.env.CCBOT_E2E_REMOTE_PORT || 18233);

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

async function waitFor(fn, timeoutMs, what, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let v;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() > deadline) fail('timed out waiting for ' + what);
        await sleep(intervalMs);
    }
}

// ---------- a REAL (tiny) WAV: 16-bit mono PCM sine at 24 kHz ----------
function makeWav(seconds = 0.4, hz = 440, rate = 24000) {
    const n = Math.floor(seconds * rate);
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
        data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), i * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);      // PCM chunk size
    header.writeUInt16LE(1, 20);       // PCM
    header.writeUInt16LE(1, 22);       // mono
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28); // byte rate
    header.writeUInt16LE(2, 32);       // block align
    header.writeUInt16LE(16, 34);      // bits/sample
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

// ---------- stand-in TTS backend (Django route/shape compatible) ----------
function startBackend() {
    const state = { nextId: 1, notifications: [], audio: new Map(), playedPosts: [] };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const json = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        if (req.method === 'POST' && url.pathname === '/api/tts/speak/') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                let data = {};
                try { data = JSON.parse(body || '{}'); } catch (_) { /* ignore */ }
                const id = state.nextId++;
                const wav = makeWav();
                state.audio.set(id, wav);
                const n = {
                    id,
                    terminal_id: data.terminal_id != null ? String(data.terminal_id) : null,
                    terminal_name: data.terminal_name || null,
                    text: data.text || '',
                    voice: data.voice || 'af_heart',
                    speed: 1.0,
                    source: data.source || 'manager',
                    duration_ms: 400,
                    played: false,
                    created_at: new Date().toISOString(),
                    audio_url: `/api/tts/audio/${id}/`
                };
                state.notifications.push(n);
                log(`backend: /speak/ -> notification ${id} (${wav.length} wav bytes)`);
                json(201, Object.assign({ success: true }, n));
            });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/api/tts/notifications/') {
            const after = Number(url.searchParams.get('after') || 0);
            const limit = Math.min(200, Number(url.searchParams.get('limit') || 100));
            const items = state.notifications
                .filter((n) => n.id > after)
                .sort((a, b) => b.id - a.id)
                .slice(0, limit);
            return json(200, { notifications: items });
        }
        const audioMatch = /^\/api\/tts\/audio\/(\d+)\/$/.exec(url.pathname);
        if (req.method === 'GET' && audioMatch) {
            const bytes = state.audio.get(Number(audioMatch[1]));
            if (!bytes) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length });
            res.end(bytes);
            return;
        }
        const playedMatch = /^\/api\/tts\/notifications\/(\d+)\/played\/$/.exec(url.pathname);
        if (req.method === 'POST' && playedMatch) {
            const id = Number(playedMatch[1]);
            state.playedPosts.push(id);
            const n = state.notifications.find((x) => x.id === id);
            if (n) n.played = true;
            log(`backend: POST played/ for notification ${id}`);
            return json(200, { success: true });
        }
        if (url.pathname === '/api/tts/voices/') return json(200, { voices: [], default: 'af_heart' });
        if (url.pathname === '/api/tts/config/') return json(200, { preferred_voice: 'af_heart' });
        res.writeHead(404);
        res.end();
    });
    return new Promise((resolve) => {
        server.listen(BACKEND_PORT, '127.0.0.1', () => resolve({ server, state }));
    });
}

// ---------- main ----------
(async () => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(EVID, { recursive: true });
    fs.mkdirSync(CFG, { recursive: true });

    const playwright = require(path.join(APP_ROOT, 'node_modules', 'playwright'));

    log('building remote renderer bundle (npm run build-remote)…');
    const build = spawnSync('npm', ['run', 'build-remote'], { cwd: APP_ROOT, encoding: 'utf8' });
    if (build.status !== 0) fail('build-remote failed: ' + (build.stderr || '').slice(-500));

    const { server: backendServer, state: backend } = await startBackend();
    log('stand-in TTS backend on 127.0.0.1:' + BACKEND_PORT + ' (real WAV bytes, Django-shaped routes)');

    let app = null;
    let browser = null;
    let exitCode = 0;

    try {
        // ---- the "server" machine: app with Remote Mode ON, isolated config ----
        log('launching app (CCBOT_REMOTE=1, isolated XDG_CONFIG_HOME, backend -> stand-in)');
        app = await playwright._electron.launch({
            args: [APP_ROOT, '--no-sandbox', '--disable-gpu'],
            cwd: APP_ROOT,
            env: Object.assign({}, process.env, {
                XDG_CONFIG_HOME: CFG,
                CCBOT_REMOTE: '1',
                CCBOT_REMOTE_PORT: String(REMOTE_MODE_PORT),
                CCBOT_BACKEND_URL: 'http://127.0.0.1:' + BACKEND_PORT,
                ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
            })
        });
        const appPage = await app.firstWindow();
        await appPage.setViewportSize({ width: 1400, height: 900 }).catch(() => {});

        const sessionPath = path.join(CFG, 'ccbot', 'session.json');
        const session = await waitFor(() => {
            try {
                const s = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                return (s.remote && s.remote.port) ? s : null;
            } catch (_) { return null; }
        }, 30000, 'session.json with remote.port');
        ok(session.remote.port === REMOTE_MODE_PORT, 'RemoteServer up on :' + session.remote.port);

        await waitFor(() => appPage.evaluate(
            () => !!(window.terminalGUI && window.terminalGUI.notificationManager)
        ).catch(() => false), 30000, 'local renderer booted');
        const localSink = () => appPage.evaluate(
            () => window.terminalGUI.notificationManager.remoteSinkActive
        );
        ok((await localSink()) === false, 'no client attached yet → local renderer is the audio sink');

        // A notification created BEFORE any viewer attaches: the WS forwarder
        // baselines PAST it on attach, so if it shows up in the client's panel
        // it can only have come through the /api reverse proxy history load —
        // that is the "notifications panel is no longer empty over SSH" proof.
        const preAttach = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/tts/speak/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'History row from before the viewer attached.', source: 'manager' })
        }).then((r) => r.json());
        ok(Number.isInteger(preAttach.id), `pre-attach notification ${preAttach.id} created (panel-history probe)`);

        // ---- the "viewer" device: plain headless Chromium over the WS ----
        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']
        });
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        const consoleLines = [];
        page.on('console', (msg) => {
            const t = msg.text();
            consoleLines.push(t);
            if (t.startsWith('[remote-tts]') || t.startsWith('[remote]')) log('browser console: ' + t);
        });
        await page.goto(`http://127.0.0.1:${REMOTE_MODE_PORT}/#k=${session.token}`);
        await waitFor(() => page.evaluate(
            () => window.__ccbotRemote && window.__ccbotRemote.authed
        ).catch(() => false), 20000, 'browser WS-authenticated');
        ok(true, 'headless Chromium attached as a Remote Mode client (authenticated WS)');
        await waitFor(() => consoleLines.some((l) => l.includes('[remote-tts] client sink ready')),
            20000, 'remote client TTS sink ready marker');
        ok(true, 'remote client announced its TTS sink (playback will happen on the viewing device)');

        // 1. the LOCAL renderer flips its audio sink to the remote viewer(s)
        await waitFor(async () => (await localSink()) === true, 10000, 'local remoteSinkActive=true');
        ok(true, 'LOCAL renderer suppresses auto playback while the viewer is attached (no double-play)');

        // 1b. NOTIFICATIONS PANEL MIRROR: the pre-attach row loads into the
        // client's panel via the /api reverse proxy (loadHistory) — the WS
        // forwarder never pushed it (watermark baselined past it on attach).
        await page.waitForSelector(`.notification-item[data-id="${preAttach.id}"]`, { timeout: 15000, state: 'attached' });
        const preAttachPushed = consoleLines.some((l) => l.includes(`[remote-tts] notification ${preAttach.id} received over WS`));
        ok(!preAttachPushed, 'pre-attach row was NOT WS-pushed — it can only have come through the /api proxy');
        ok(true, `NOTIFICATIONS PANEL: pre-attach notification ${preAttach.id} rendered in the remote client via the proxied history load`);

        // 2-4. fire a TTS notification on the "server" (what the manager does)
        const speakRes = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/tts/speak/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: 'Remote audio verification: this should play on the viewing device.',
                terminal_id: 999,
                terminal_name: 'manager',
                source: 'manager'
            })
        }).then((r) => r.json());
        const nid = speakRes.id;
        const wavBytes = backend.audio.get(nid).length;
        ok(Number.isInteger(nid), `notification ${nid} created on the server backend (${wavBytes} wav bytes)`);

        // audio bytes arrive at the CLIENT over the WS
        const recvLine = await waitFor(
            () => consoleLines.find((l) => l.includes(`[remote-tts] notification ${nid} received over WS`)),
            20000, 'client received-bytes marker'
        );
        const recvBytes = Number((/\((\d+) audio bytes\)/.exec(recvLine) || [])[1]);
        ok(recvBytes === wavBytes,
            `client received the audio over the WS: ${recvBytes} bytes === backend wav ${wavBytes} bytes`);

        // the row renders in the client's Notifications tab (attached, not
        // necessarily visible — the tab may not be the active view)
        await page.waitForSelector(`.notification-item[data-id="${nid}"]`, { timeout: 10000, state: 'attached' });
        ok(true, 'notification row rendered in the remote client UI');

        // playback is DRIVEN on the client: blob src + play() resolved + playing state
        await waitFor(
            () => consoleLines.some((l) => l.includes(`[remote-tts] playback started on this device for notification ${nid}`)),
            20000, 'client playback-started marker'
        );
        const playState = await page.evaluate(() => {
            const nm = window.terminalGUI.notificationManager;
            return {
                src: nm.audio.src,
                playing: nm.playing,
                currentId: nm._currentId,
                paused: nm.audio.paused,
                currentTime: nm.audio.currentTime
            };
        });
        ok(playState.src.startsWith('blob:'),
            'client audio element is playing the pushed bytes via a blob: URL (' + playState.src.slice(0, 30) + '…)');
        ok(playState.currentId === nid || consoleLines.some((l) => l.includes('playback started on this device')),
            'HTMLAudioElement.play() was invoked with the pushed audio data');
        log(`client play state: playing=${playState.playing} paused=${playState.paused} t=${playState.currentTime}`);
        // Visual evidence: switch the client's sidebar to the Notifications tab.
        await page.click('[data-test-id="todo-nav-btn"]').catch(() => {});
        await page.waitForSelector(`.notification-item[data-id="${nid}"]`, { timeout: 5000 }).catch(() => {});
        await page.screenshot({ path: path.join(EVID, '01-client-notification-playing.png') });

        // played-mark round-trips: browser -> WS -> main -> backend POST
        await waitFor(() => backend.playedPosts.includes(nid), 20000, 'played POST on the backend');
        ok(true, 'clip finished on the client and the played-mark round-tripped over the WS to the backend');

        // 5. the LOCAL renderer rendered the row but did NOT play it
        const localState = await appPage.evaluate(() => {
            const nm = window.terminalGUI.notificationManager;
            return {
                hasRow: nm.items.size > 0,
                playing: nm.playing,
                queued: nm.playQueue.length,
                src: nm.audio.src || ''
            };
        });
        // (the PRE-attach notification legitimately played locally — only the
        // post-attach one must have been kept off the local audio element)
        ok(localState.playing === false && localState.queued === 0
            && !localState.src.includes(`/api/tts/audio/${nid}/`),
            'LOCAL renderer did not play the forwarded notification (no double-play on the app host)');
        await appPage.screenshot({ path: path.join(EVID, '02-local-app-suppressed.png') });

        // 6. detach → sink flips back local; later notifications are NOT forwarded
        await page.close();
        await waitFor(async () => (await localSink()) === false, 10000, 'local remoteSinkActive=false');
        ok(true, 'client detached → the LOCAL renderer is the audio sink again');

        const speak2 = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/tts/speak/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: 'Back to local playback.', source: 'manager' })
        }).then((r) => r.json());
        // local poller (3s cadence) picks it up and drives local playback
        await waitFor(() => appPage.evaluate((id) => {
            const nm = window.terminalGUI.notificationManager;
            return nm.items.has(id) && (nm.playing || nm.playQueue.length > 0 || nm._currentId === id || nm.audio.src.includes(`/api/tts/audio/${id}/`));
        }, speak2.id).catch(() => false), 20000, 'local playback path engaged for post-detach notification');
        ok(true, `post-detach notification ${speak2.id} entered the LOCAL play path (audio routed back to the app host)`);

        log('ALL CHECKS PASSED');
        log('NOTE: headless run — acoustic output itself cannot be captured; verified the full');
        log('delivery + playback-invocation chain (bytes over WS, blob URL, play() driven, played-mark round-trip).');
    } catch (err) {
        exitCode = 1;
        log('E2E FAILED: ' + ((err && err.stack) || err));
        try {
            if (app) await (await app.firstWindow()).screenshot({ path: path.join(EVID, 'ZZ-failure-app.png') });
        } catch (_) { /* best effort */ }
    } finally {
        try { if (browser) await browser.close(); } catch (_) { /* ignore */ }
        try { if (app) await app.close(); } catch (_) { /* ignore */ }
        try { backendServer.close(); } catch (_) { /* ignore */ }
        fs.writeFileSync(path.join(EVID, 'transcript.log'), transcript.join('\n') + '\n');
        log('evidence in ' + EVID);
        process.exit(exitCode);
    }
})();
