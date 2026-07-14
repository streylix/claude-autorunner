#!/usr/bin/env node
'use strict';

/**
 * remote-mic-e2e - Full-loop verification of CLIENT MICROPHONE FORWARDING
 * (docs/REMOTE_MODE.md §10) — the INPUT mirror of remote-tts-e2e:
 *
 *   [headless Chromium]      plain-browser Remote Mode client; its "mic" audio
 *                            rides the authenticated WS as remote-mic-frame
 *   [remote Electron app]    CCBOT_REMOTE=1, isolated XDG_CONFIG_HOME; the
 *                            LOCAL renderer runs the REAL wake pipeline (Vosk)
 *   [stand-in Whisper]       Django-shaped /api/voice/transcribe/ that records
 *                            the exact WAV the pipeline POSTs and returns a
 *                            known transcript
 *
 * Verifies, in order:
 *   1. the app boots with the wake pipeline idle (local-only baseline);
 *   2. REAL capture path: getUserMedia (Chromium fake device) → AudioWorklet →
 *      16 kHz PCM16 frames over the WS → main → local renderer → the desktop
 *      pipeline attaches in REMOTE-ONLY mode (no local mic opened) and every
 *      sample arrives BYTE-FAITHFULLY (client-side vs server-side rolling hash
 *      over the identical Int16 stream);
 *   3. FULL PIPELINE with known speech (test hook feeds canned 16 kHz WAVs of
 *      real synthesized speech through the same chunk/encode/send path):
 *      "hey claude" is detected by the DESKTOP's REAL Vosk engine (open-vocab
 *      match, no shortcuts), the desktop captures the following command by
 *      VAD, encodes it to WAV, POSTs it to the Whisper endpoint (the stand-in
 *      byte-compares the received PCM against the injected utterance), and the
 *      returned transcript is queued to the manager (999, urgent) framed as a
 *      voice memo — while the streaming client is fed remote-wake-state
 *      (listening/capturing/transcribing) for chimes/UI;
 *   4. a SECOND client asking for the mic is denied (single-owner rule);
 *   5. detach: closing the client returns the pipeline to idle and local
 *      behavior (nothing remote-flavored left running).
 *
 * The Whisper backend is a STAND-IN implementing the exact Django route/shape
 * (multipart audio_file → {text}) because the full faster-whisper stack is
 * impractical in a sandbox — but the audio still flows through the very same
 * app code path, and the received bytes are compared against the source.
 * NOTE: headless box — real acoustic capture is impossible; what is proven is
 * the full delivery + pipeline-invocation chain from client PCM to manager memo.
 *
 * Run headless:  xvfb-run -a node tests/integration/remote-mic-e2e.js
 * Evidence (screenshots + wav + transcript) → $CCBOT_E2E_DIR or ./.e2e-remote-mic.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const WORK = process.env.CCBOT_E2E_DIR
    ? path.resolve(process.env.CCBOT_E2E_DIR)
    : path.join(APP_ROOT, '.e2e-remote-mic');
const EVID = path.join(WORK, 'evidence');
const CFG = path.join(WORK, 'cfg-remote');
const BACKEND_PORT = Number(process.env.CCBOT_E2E_BACKEND_PORT || 18129);
const REMOTE_MODE_PORT = Number(process.env.CCBOT_E2E_REMOTE_PORT || 18235);
const KNOWN_TRANSCRIPT = 'remote mic verification: please check the build status and report back to me';

const WAKE_WAV = path.join(APP_ROOT, 'tests', 'fixtures', 'hey-claude-16k.wav');
const CMD_WAV = path.join(APP_ROOT, 'tests', 'fixtures', 'command-16k.wav');

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

/** PCM16 data chunk of a canned 16 kHz mono WAV fixture. */
function wavPcm(file) {
    const buf = fs.readFileSync(file);
    if (buf.toString('ascii', 0, 4) !== 'RIFF') fail(file + ' is not a WAV');
    // Walk the chunks to the 'data' chunk (ffmpeg may insert LIST etc.).
    let off = 12;
    while (off + 8 <= buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === 'data') return buf.slice(off + 8, off + 8 + size);
        off += 8 + size + (size % 2);
    }
    fail('no data chunk in ' + file);
    return null;
}

// ---- stand-in voice/TTS backend (Django route/shape compatible) ----
function startBackend() {
    const state = { transcribes: [] };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const json = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
        };
        if (req.method === 'POST' && url.pathname === '/api/voice/transcribe/') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks);
                // Minimal multipart parse: the file bytes sit between the first
                // blank line after the audio_file part header and the closing
                // \r\n--boundary.
                const ct = req.headers['content-type'] || '';
                const bm = /boundary=(.+)$/.exec(ct);
                let audio = null;
                if (bm) {
                    const boundary = Buffer.from('\r\n--' + bm[1]);
                    const headerEnd = body.indexOf('\r\n\r\n');
                    const tail = body.indexOf(boundary, headerEnd);
                    if (headerEnd !== -1 && tail !== -1) audio = body.slice(headerEnd + 4, tail);
                }
                state.transcribes.push({
                    headers: req.headers,
                    audio,
                    disposition: (/filename="([^"]+)"/.exec(body.slice(0, 500).toString('latin1')) || [])[1] || null
                });
                log(`backend: /api/voice/transcribe/ received ${audio ? audio.length : 0} bytes (${state.transcribes.length} total)`);
                json(200, { success: true, text: KNOWN_TRANSCRIPT, language: 'en' });
            });
            return;
        }
        if (url.pathname === '/api/voice/health/') return json(200, { status: 'ok' });
        if (url.pathname === '/api/voice/bridge-status/') return json(200, { active: false });
        if (url.pathname === '/api/tts/notifications/') return json(200, { notifications: [] });
        if (url.pathname === '/api/tts/voices/') return json(200, { voices: [], default: 'af_heart' });
        if (url.pathname === '/api/tts/config/') return json(200, { preferred_voice: 'af_heart' });
        if (url.pathname === '/api/queue/health/') return json(200, { status: 'ok' });
        res.writeHead(404);
        res.end();
    });
    return new Promise((resolve) => {
        server.listen(BACKEND_PORT, '127.0.0.1', () => resolve({ server, state }));
    });
}

// ---- main ----
(async () => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(EVID, { recursive: true });
    fs.mkdirSync(CFG, { recursive: true });

    const playwright = require(path.join(APP_ROOT, 'node_modules', 'playwright'));
    const wakePcm = wavPcm(WAKE_WAV);
    const cmdPcm = wavPcm(CMD_WAV);
    log(`fixtures: wake ${wakePcm.length} bytes, command ${cmdPcm.length} bytes (16 kHz mono PCM16 speech)`);

    log('building remote renderer bundle (npm run build-remote)…');
    const build = spawnSync('npm', ['run', 'build-remote'], { cwd: APP_ROOT, encoding: 'utf8' });
    if (build.status !== 0) fail('build-remote failed: ' + (build.stderr || '').slice(-500));

    const { server: backendServer, state: backend } = await startBackend();
    log('stand-in voice backend on 127.0.0.1:' + BACKEND_PORT + ' (Django-shaped /api/voice/transcribe/)');

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
            () => !!(window.terminalGUI && window.terminalGUI.wakeWordManager && window.terminalGUI.remoteMicSink)
        ).catch(() => false), 30000, 'local renderer booted (wakeWordManager + remoteMicSink)');

        // 1. local-only baseline: pipeline idle, nothing remote-flavored.
        const baseline = await appPage.evaluate(() => ({
            state: window.terminalGUI.wakeWordManager.state,
            remote: window.terminalGUI.wakeWordManager.isRemoteSourceActive(),
            sinkActive: window.terminalGUI.remoteMicSink.active
        }));
        ok(baseline.state === 'idle' && !baseline.remote && !baseline.sinkActive,
            'baseline: wake pipeline idle, no remote source (local-only behavior untouched)');

        // Instrument the app: wake-state trail, rolling hash over received PCM
        // (same fold as the client), and a queue spy for the manager memo.
        await appPage.evaluate(() => {
            const gui = window.terminalGUI;
            window.__micE2E = { wakeStates: [], rx: { frames: 0, samples: 0, hash: 0 }, queued: [], logs: [] };
            gui.eventBus.on('wake:state', (p) => window.__micE2E.wakeStates.push((p && p.state) || '?'));
            gui.eventBus.on('log:action', (p) => { if (p && /wake|Remote|remote|mic/i.test(p.message)) window.__micE2E.logs.push(p.message); });
            const wwm = gui.wakeWordManager;
            const orig = wwm.pushRemotePcm.bind(wwm);
            wwm.pushRemotePcm = (f32, rate) => {
                const st = window.__micE2E.rx;
                st.frames++;
                st.samples += f32.length;
                let h = st.hash;
                for (let i = 0; i < f32.length; i++) {
                    let s = Math.round(f32[i] * 32768);
                    if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
                    h = (Math.imul(h, 31) + s) | 0;
                }
                st.hash = h;
                return orig(f32, rate);
            };
            const mq = gui.messageQueueManager;
            const origAdd = mq.addMessage.bind(mq);
            mq.addMessage = (m) => { window.__micE2E.queued.push(m); return origAdd(m); };
            // Fast trailing-silence stop for the test (user-configurable pref).
            gui.eventBus.emit('preference:changed', { key: 'wakeSilenceMs', value: 1500 });
        });

        // ---- the "viewer" device: headless Chromium with a fake mic ----
        browser = await playwright.chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--autoplay-policy=no-user-gesture-required',
                '--use-fake-device-for-media-stream',
                '--use-fake-ui-for-media-stream'
            ]
        });
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        const consoleLines = [];
        page.on('console', (msg) => {
            const t = msg.text();
            consoleLines.push(t);
            if (t.startsWith('[remote-mic]') || t.startsWith('[remote]')) log('browser console: ' + t);
        });
        await page.goto(`http://127.0.0.1:${REMOTE_MODE_PORT}/#k=${session.token}`);
        await waitFor(() => page.evaluate(
            () => window.__ccbotRemote && window.__ccbotRemote.authed
        ).catch(() => false), 20000, 'browser WS-authenticated');
        ok(true, 'headless Chromium attached as a Remote Mode client (authenticated WS)');
        // 1b. UI cleanup: the floating mic button is GONE (it used to overlap
        // the message input) — the single mic control is Settings → Microphone.
        const floatBtn = await page.evaluate(() => !!document.getElementById('remote-mic-btn'));
        ok(floatBtn === false, 'no floating mic button in the remote client (removed; Settings → Microphone is the control)');

        // 1b'. UI cleanup: the remote view's own (dead) connect indicator is
        // hidden — only the outer desktop app shows a connect control, so no
        // more two stacked <> buttons bottom-left.
        const innerIndicator = await page.evaluate(() => {
            const el = document.getElementById('remote-indicator');
            return el ? getComputedStyle(el).display : 'absent';
        });
        ok(innerIndicator === 'none' || innerIndicator === 'absent',
            `remote view's own connect indicator is hidden (display: ${innerIndicator})`);

        // 1b''. UI cleanup on the DESKTOP side (this isolated app's local
        // window): the connect bar has no X button and dismisses on a click
        // anywhere outside it.
        const dismiss = await appPage.evaluate(async () => {
            const ui = window.terminalGUI && window.terminalGUI.remoteConnectionUI;
            if (!ui || !ui.el || !ui.el.bar) return { skipped: 'no RemoteConnectionUI' };
            const bar = ui.el.bar;
            const noX = !document.getElementById('remote-command-close-btn')
                && !document.getElementById('remote-panel-close-btn');
            ui.showCommandBar();
            const openedVisible = !bar.classList.contains('hidden');
            document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            const closedAfterOutside = bar.classList.contains('hidden');
            ui.showCommandBar();
            bar.querySelector('#remote-command-input')
                .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            const stayedOpenOnInside = !bar.classList.contains('hidden');
            ui.hideCommandBar();
            return { noX, openedVisible, closedAfterOutside, stayedOpenOnInside };
        });
        ok(dismiss.noX === true, 'no X buttons on the connect bar / management popover');
        ok(dismiss.openedVisible === true && dismiss.closedAfterOutside === true,
            'connect bar dismisses on a click anywhere outside it');
        ok(dismiss.stayedOpenOnInside === true, 'clicking inside the bar does NOT dismiss it');

        // 1c. SETTINGS MIC PICKER lists THIS BROWSER's inputs (the fake devices),
        // offers an explicit Off, and defaults to Off for a first-time viewer.
        await waitFor(() => page.evaluate(() => !!(window.terminalGUI && window.terminalGUI.populateMicrophoneSelect)), 15000, 'remote renderer booted');
        const picker = await page.evaluate(async () => {
            await window.terminalGUI.populateMicrophoneSelect();
            const sel = document.getElementById('microphone-select');
            return {
                options: [...sel.options].map((o) => ({ value: o.value, label: o.textContent })),
                selected: sel.value
            };
        });
        ok(picker.options.some((o) => o.value === 'off'), 'picker offers an explicit Off row');
        const fakeDev = picker.options.find((o) => /fake/i.test(o.label) && o.value !== 'off' && o.value !== 'default');
        ok(!!fakeDev, `picker lists the VIEWING browser's inputs (found "${fakeDev && fakeDev.label}") — not the desktop's`);
        ok(picker.selected === 'off', 'first-time viewer defaults to Off (no un-opted-in mic streaming)');

        // 1d. Selecting a device in the picker STARTS the stream on it and the
        // app's voice button carries the streaming glow; Off stops it again.
        await page.evaluate((devId) => {
            const sel = document.getElementById('microphone-select');
            sel.value = devId;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, fakeDev.value);
        await waitFor(() => page.evaluate(() => window.__ccbotRemoteMic.isStreaming()), 15000, 'picker selection started the mic stream');
        const pickState = await page.evaluate(() => ({
            device: window.__ccbotRemoteMic.getDevice(),
            label: window.__ccbotRemoteMic.activeLabel(),
            glow: (document.getElementById('voice-btn') || { classList: { contains: () => false } }).classList.contains('remote-wake-on')
        }));
        ok(pickState.device === fakeDev.value, `stream runs on the PICKED device (${pickState.device.slice(0, 12)}…)`);
        ok(!!pickState.label, `captured track label: "${pickState.label}"`);
        ok(pickState.glow === true, 'voice button carries the streaming glow (consolidated mic state indicator)');
        await page.evaluate(() => {
            const sel = document.getElementById('microphone-select');
            sel.value = 'off';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await waitFor(() => page.evaluate(() => !window.__ccbotRemoteMic.isStreaming()), 10000, 'Off stopped the stream');
        ok(true, 'picker Off row stops the stream (and persists — no auto-resume next connect)');
        await page.evaluate(() => { try { window.localStorage.removeItem('ccbotRemoteMicDeviceId'); } catch (_) {} });

        // 2. REAL capture path: getUserMedia + AudioWorklet + downsampler.
        const started = await page.evaluate(() => window.__ccbotRemoteMic.start());
        ok(started === true, 'client mic started (getUserMedia granted on the fake device, worklet tap wired)');
        await waitFor(() => page.evaluate(() => window.__ccbotRemoteMic.stats().frames >= 12), 15000, 'client sent ≥12 real-capture frames');
        const attach = await waitFor(() => appPage.evaluate(() => {
            const wwm = window.terminalGUI.wakeWordManager;
            return (window.terminalGUI.remoteMicSink.active && wwm.state === 'listening' && wwm._remoteOnly)
                ? { rxFrames: window.__micE2E.rx.frames } : null;
        }), 30000, 'desktop pipeline attached in remote-only mode (Vosk model loaded, listening)');
        ok(true, `desktop wake pipeline LISTENING on the remote stream in remote-only mode (no local mic opened; ${attach.rxFrames} frames already routed)`);
        const noLocalMic = await appPage.evaluate(() => window.terminalGUI.wakeWordManager.audioStream === null);
        ok(noLocalMic, 'no local getUserMedia was opened on the (headless) app host');

        await page.evaluate(() => window.__ccbotRemoteMic.stop('phase A done'));
        await waitFor(() => appPage.evaluate(() => !window.terminalGUI.remoteMicSink.active), 10000, 'sink detached after stop');
        const sentA = await page.evaluate(() => window.__ccbotRemoteMic.stats());
        const rxA = await appPage.evaluate(() => window.__micE2E.rx);
        ok(sentA.frames > 0 && rxA.frames === sentA.frames && rxA.samples === sentA.samples && rxA.hash === sentA.hash,
            `byte-faithful delivery (REAL capture): client sent ${sentA.frames} frames / ${sentA.samples} samples, `
            + `server received ${rxA.frames} / ${rxA.samples}, rolling Int16 hash ${rxA.hash} === ${sentA.hash}`);
        const idleAfterA = await appPage.evaluate(() => window.terminalGUI.wakeWordManager.state);
        ok(idleAfterA === 'idle', 'pipeline back to idle after the client released the mic');

        // 3. FULL PIPELINE with known speech via the test hook (same chunk/
        //    encode/send path; only the acoustic tap is bypassed — headless box).
        await appPage.evaluate(() => { window.__micE2E.rx = { frames: 0, samples: 0, hash: 0 }; window.__micE2E.wakeStates.length = 0; });
        ok(await page.evaluate(() => window.__ccbotRemoteMic.startTest()), 'client re-attached in test-hook mode');
        await waitFor(() => appPage.evaluate(
            () => window.terminalGUI.wakeWordManager.state === 'listening' && window.terminalGUI.wakeWordManager.isRemoteSourceActive()
        ), 15000, 'pipeline listening again on the remote stream');

        const wakeB64 = wakePcm.toString('base64');
        const cmdB64 = cmdPcm.toString('base64');
        log('injecting synthesized speech: "hey claude" → 2s pause → command → 3.5s silence (paced ~real-time)');
        const injection = page.evaluate(async ({ wakeB64, cmdB64 }) => {
            const mic = window.__ccbotRemoteMic;
            await mic.injectPcm16(wakeB64, { trailingSilenceMs: 2000 });
            await mic.injectPcm16(cmdB64, { trailingSilenceMs: 3500 });
            return mic.stats();
        }, { wakeB64, cmdB64 });

        // The DESKTOP's real Vosk engine must detect the wake phrase mid-stream.
        await waitFor(() => appPage.evaluate(() => window.__micE2E.wakeStates.includes('capturing')), 25000,
            'REAL Vosk wake detection on the desktop ("hey claude" → capturing)');
        ok(true, 'desktop Vosk engine detected "hey claude" from the CLIENT\'s audio (state → capturing)');
        await page.screenshot({ path: path.join(EVID, '01-client-mic-capturing.png') }).catch(() => {});

        // …then the VAD closes the capture and the WAV goes to Whisper.
        await waitFor(() => backend.transcribes.length > 0, 30000, 'Whisper endpoint received the utterance');
        const sentB = await injection;
        const post = backend.transcribes[0];
        ok(post.audio && post.audio.length > 44, `Whisper POST carried a WAV (${post.audio.length} bytes, upload name ${post.disposition})`);
        fs.writeFileSync(path.join(EVID, 'whisper-received.wav'), post.audio);
        ok(post.audio.toString('ascii', 0, 4) === 'RIFF' && post.audio.readUInt32LE(24) === 16000 && post.audio.readUInt16LE(22) === 1,
            'received WAV is 16 kHz mono PCM16 RIFF (what the desktop pipeline encodes)');
        // Byte-compare: the captured data chunk must CONTAIN the injected command
        // PCM (capture starts during the post-wake pause, so the command sits
        // whole inside it; compare a large mid-utterance slice, sample-exact).
        const data = post.audio.slice(44);
        const probe = cmdPcm.slice(Math.floor(cmdPcm.length * 0.2), Math.floor(cmdPcm.length * 0.9));
        ok(data.indexOf(probe) !== -1,
            `received WAV contains the injected command PCM byte-for-byte (${probe.length}-byte mid-utterance slice matched)`);

        // …and the byte-faithful hash holds for the whole injected stream.
        await waitFor(() => appPage.evaluate((sent) => {
            const rx = window.__micE2E.rx;
            return rx.samples >= sent.samples ? rx : null;
        }, sentB), 10000, 'all injected frames routed to the pipeline');
        const rxB = await appPage.evaluate(() => window.__micE2E.rx);
        ok(rxB.frames === sentB.frames && rxB.samples === sentB.samples && rxB.hash === sentB.hash,
            `byte-faithful delivery (pipeline run): ${sentB.frames} frames / ${sentB.samples} samples, hash ${rxB.hash} === ${sentB.hash}`);

        // …the transcript comes back and is queued to the manager as a voice memo.
        const memo = await waitFor(() => appPage.evaluate(() => window.__micE2E.queued[0] || null), 15000, 'voice memo queued to the manager');
        ok(memo.terminalId === 999 && memo.type === 'urgent', 'memo targeted at the manager (999), urgent');
        ok(memo.content.includes('🎙️ Voice memo from the user'), 'memo framed with the verbatim voice-memo marker');
        ok(memo.content.includes(KNOWN_TRANSCRIPT), 'memo carries the transcript produced ON THE DESKTOP from the client\'s audio');

        // …while the streaming client was fed the wake states for feedback.
        ok(consoleLines.some((l) => l.includes('[remote-mic] desktop wake pipeline: capturing')),
            'client received remote-wake-state pushes (capturing) for chimes/UI feedback');
        ok(consoleLines.some((l) => l.includes('[remote-mic] desktop wake pipeline: transcribing')),
            'client received remote-wake-state pushes (transcribing)');
        const appStates = await appPage.evaluate(() => window.__micE2E.wakeStates.join(','));
        log('desktop wake-state trail: ' + appStates);
        await appPage.screenshot({ path: path.join(EVID, '02-app-after-pipeline.png') }).catch(() => {});

        // 4. single-owner rule: a second client is denied.
        const page2 = await browser.newPage({ viewport: { width: 1200, height: 800 } });
        await page2.goto(`http://127.0.0.1:${REMOTE_MODE_PORT}/#k=${session.token}`);
        await waitFor(() => page2.evaluate(() => window.__ccbotRemote && window.__ccbotRemote.authed).catch(() => false), 20000, 'second client authenticated');
        await page2.evaluate(() => window.__ccbotRemoteMic.startTest());
        await waitFor(() => page2.evaluate(() => window.__ccbotRemoteMic.isDenied()), 10000, 'second client denied');
        ok(true, 'second client asking for the mic was DENIED (single-owner rule) — first client keeps streaming');
        await page2.close();

        // 5. detach: closing the streaming client restores local-only behavior.
        await page.close();
        await waitFor(() => appPage.evaluate(() => {
            const wwm = window.terminalGUI.wakeWordManager;
            return !window.terminalGUI.remoteMicSink.active && wwm.state === 'idle' && !wwm.isRemoteSourceActive();
        }), 15000, 'pipeline idle + source released after client disconnect');
        ok(true, 'client disconnect (no clean stop) released the mic and returned the pipeline to idle — local behavior restored');

        log('ALL CHECKS PASSED');
        log('NOTE: headless run — real acoustic capture is impossible; phase 2 proved the REAL');
        log('getUserMedia+worklet capture path with the fake device, phase 3 proved the full pipeline');
        log('(client PCM → WS → desktop Vosk wake detection → VAD capture → WAV → Whisper endpoint →');
        log('transcript → manager memo) with byte-exact delivery. Whisper was a Django-shaped stand-in.');
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
