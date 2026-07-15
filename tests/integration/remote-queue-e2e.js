#!/usr/bin/env node
'use strict';

/**
 * remote-queue-e2e - Live MESSAGE-QUEUE mirror between the desktop and
 * attached Remote Mode viewers (no reconnect, no polling):
 *
 *   1. a message queued BEFORE the viewer attaches shows up at attach time
 *      (boot catch-up via 'remote-queue-request' → 'remote-queue-sync');
 *   2. a message added on the desktop appears in the remote panel within the
 *      2s budget (snapshot → main diff → 'remote-queue-sync' push);
 *   3. a DELIVERED message does not linger remotely — the reported bug.
 *      injectMessageNow (the "Send now" force path) delivers one message to
 *      the terminal; the remote panel must drop it and settle on exactly the
 *      undelivered ones;
 *   4. removing the remaining message on the desktop drops it remotely;
 *   5. clearing the (re-populated) queue on the desktop empties the panel.
 *
 * Fixture note: in this freshly-booted isolated app the runtime probe may not
 * have classified terminal 1 yet, and the injection gates deliberately FAIL
 * OPEN on unknown runtime — so an idle terminal would swallow queued fixtures
 * immediately (found the hard way: the "wiped queue" was a genuine delivery).
 * The desktop's injectionPaused flag is set for the queued phases, and the
 * delivery probe (phase 3) uses injectMessageNow — the force path that
 * bypasses the pause, exactly like the user's "Send now" button.
 *
 * Isolation: own XDG_CONFIG_HOME + ports; the production instance and its
 * manager are never touched.
 *
 * Run headless:  xvfb-run -a node tests/integration/remote-queue-e2e.js
 */

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const WORK = process.env.CCBOT_E2E_DIR
    ? path.resolve(process.env.CCBOT_E2E_DIR)
    : path.join(APP_ROOT, '.e2e-remote-queue');
const EVID = path.join(WORK, 'evidence');
const CFG = path.join(WORK, 'cfg-remote');
const REMOTE_MODE_PORT = Number(process.env.CCBOT_E2E_REMOTE_PORT || 18239);
const SYNC_BUDGET_MS = 2000;

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

async function waitFor(fn, timeoutMs, what, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let v;
        try { v = await fn(); } catch (_) { v = null; }
        if (v) return v;
        if (Date.now() > deadline) fail('timed out waiting for ' + what);
        await sleep(intervalMs);
    }
}

(async () => {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(EVID, { recursive: true });
    fs.mkdirSync(CFG, { recursive: true });

    let playwright;
    try { playwright = require('playwright'); } catch (_) { fail('playwright not installed'); }

    let app = null;
    let browser = null;
    let exitCode = 0;
    try {
        log('launching app (CCBOT_REMOTE=1, isolated XDG_CONFIG_HOME)');
        app = await playwright._electron.launch({
            args: [APP_ROOT, '--no-sandbox', '--disable-gpu'],
            cwd: APP_ROOT,
            env: Object.assign({}, process.env, {
                XDG_CONFIG_HOME: CFG,
                CCBOT_REMOTE: '1',
                CCBOT_REMOTE_PORT: String(REMOTE_MODE_PORT),
                CCBOT_BACKEND_URL: 'http://127.0.0.1:1',
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
        }, 30000, 'session.json with remote.port', 250);
        ok(session.remote.port === REMOTE_MODE_PORT, 'RemoteServer up on :' + session.remote.port);

        await waitFor(() => appPage.evaluate(
            () => !!(window.terminalGUI && window.terminalGUI.messageQueueManager && window.terminalGUI.terminals.size > 0)
        ).catch(() => false), 30000, 'local renderer booted', 250);

        const localQueueLen = () => appPage.evaluate(() => window.terminalGUI.messageQueueManager.messageQueue.length);
        const remoteQueue = (p) => p.evaluate(() => ({
            state: window.terminalGUI.messageQueueManager.messageQueue.map((m) => ({ id: m.id, content: m.content, type: m.type })),
            domCount: document.querySelectorAll('#message-list .message-item').length
        }));

        // ---- 1. queue a message BEFORE the viewer attaches (boot catch-up).
        // Pause auto-injection first so fixtures deterministically STAY queued
        // (see fixture note in the header).
        await appPage.evaluate(() => { window.terminalGUI.messageQueueManager.injectionPaused = true; });
        await appPage.evaluate(() => window.terminalGUI.messageQueueManager.addMessage({
            content: 'queued-before-attach', terminalId: 1, type: 'normal'
        }));
        await sleep(1200); // would-be delivery window: len must SURVIVE it
        ok((await localQueueLen()) === 1, 'desktop queued a message before any viewer attached (still queued after 1.2s)');

        browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        await page.goto(`http://127.0.0.1:${REMOTE_MODE_PORT}/#k=${session.token}`);
        await waitFor(() => page.evaluate(
            () => window.__ccbotRemote && window.__ccbotRemote.authed
        ).catch(() => false), 20000, 'browser WS-authenticated', 250);
        await waitFor(() => page.evaluate(
            () => !!(window.terminalGUI && window.terminalGUI.messageQueueManager)
        ).catch(() => false), 20000, 'remote renderer booted', 250);

        const boot = await waitFor(async () => {
            const q = await remoteQueue(page);
            return (q.state.length === 1 && q.state[0].content === 'queued-before-attach' && q.domCount === 1) ? q : null;
        }, 10000, 'boot catch-up queue in the remote view');
        ok(true, `BOOT CATCH-UP: pre-attach message visible in the remote panel (state+DOM: "${boot.state[0].content}")`);

        // ---- 2. live ADD on the desktop → remote within budget ----
        const t2 = Date.now();
        await appPage.evaluate(() => window.terminalGUI.messageQueueManager.addMessage({
            content: 'live-added-message', terminalId: 1, type: 'normal'
        }));
        await waitFor(async () => {
            const q = await remoteQueue(page);
            return (q.state.length === 2 && q.domCount === 2 && q.state.some((m) => m.content === 'live-added-message')) ? q : null;
        }, 10000, 'live add reflected remotely');
        const dt2 = Date.now() - t2;
        ok(dt2 <= SYNC_BUDGET_MS, `live ADD reached the remote panel in ${dt2}ms (budget ${SYNC_BUDGET_MS}ms)`);
        await page.screenshot({ path: path.join(EVID, '01-remote-two-queued.png') }).catch(() => {});

        // ---- 3. DELIVERY probe: force-inject one message ("Send now" path —
        //         bypasses the pause) — the remote panel must NOT keep showing
        //         it after delivery (the reported stale bug) ----
        const injectedId = boot.state[0].id;
        const t3 = Date.now();
        // Mark it urgent first: by now the runtime probe has classified
        // terminal 1 as a bare shell, and the shell guard holds NORMAL
        // messages even on the force path — urgent is the documented bypass.
        await appPage.evaluate((id) => {
            const mq = window.terminalGUI.messageQueueManager;
            mq.applyControlUpdate({ messageId: id, type: 'urgent' });
            mq.injectMessageNow(id);
        }, injectedId);
        await waitFor(() => appPage.evaluate(
            () => window.terminalGUI.messageQueueManager.messageQueue.length === 1
        ), 20000, 'desktop delivered the force-injected message (queue 2→1)');
        await waitFor(async () => {
            const q = await remoteQueue(page);
            return (q.state.length === 1 && q.domCount === 1 && !q.state.some((m) => m.id === injectedId)) ? q : null;
        }, 10000, 'delivered message absent from the remote panel');
        const dt3 = Date.now() - t3;
        ok(true, `DELIVERED message not lingering remotely ${dt3}ms after Send-now (includes typing time)`);
        await page.screenshot({ path: path.join(EVID, '02-remote-after-delivery.png') }).catch(() => {});

        // ---- 3b. REMOVE the remaining message on the desktop → remote drops it ----
        const removeId = (await remoteQueue(page)).state[0].id;
        const t3b = Date.now();
        await appPage.evaluate((id) => window.terminalGUI.messageQueueManager.deleteMessage(id), removeId);
        await waitFor(async () => {
            const q = await remoteQueue(page);
            return (q.state.length === 0 && q.domCount === 0) ? q : null;
        }, 10000, 'removed message dropped from the remote panel');
        const dt3b = Date.now() - t3b;
        ok(dt3b <= SYNC_BUDGET_MS, `REMOVE reached the remote panel in ${dt3b}ms`);

        // ---- 4. CLEAR on the desktop → remote panel empties.
        // Re-populate first (clearing an empty queue would test nothing).
        await appPage.evaluate(() => {
            const mq = window.terminalGUI.messageQueueManager;
            mq.addMessage({ content: 'clear-me-1', terminalId: 1, type: 'normal' });
            mq.addMessage({ content: 'clear-me-2', terminalId: 1, type: 'normal' });
        });
        await waitFor(async () => {
            const q = await remoteQueue(page);
            return (q.state.length === 2 && q.domCount === 2) ? q : null;
        }, 10000, 'two clear-fixtures visible remotely');
        const t4 = Date.now();
        await appPage.evaluate(() => window.terminalGUI.messageQueueManager.clearQueue());
        await waitFor(async () => {
            const q = await remoteQueue(page);
            return (q.state.length === 0 && q.domCount === 0) ? q : null;
        }, 10000, 'remote panel emptied after clear');
        const dt4 = Date.now() - t4;
        ok(dt4 <= SYNC_BUDGET_MS, `CLEAR reached the remote panel in ${dt4}ms`);

        log('ALL CHECKS PASSED');
        log(`latencies: add→remote ${dt2}ms, delivery→settled ${dt3}ms (incl. typing), remove→remote ${dt3b}ms, clear→remote ${dt4}ms`);
    } catch (err) {
        exitCode = 1;
        log('E2E FAILED: ' + ((err && err.stack) || err));
        try {
            if (app) await (await app.firstWindow()).screenshot({ path: path.join(EVID, 'ZZ-failure-app.png') });
        } catch (_) { /* best effort */ }
    } finally {
        try { if (browser) await browser.close(); } catch (_) { /* ignore */ }
        try { if (app) await app.close(); } catch (_) { /* ignore */ }
        fs.writeFileSync(path.join(EVID, 'transcript.log'), transcript.join('\n') + '\n');
        log('evidence in ' + EVID);
        process.exit(exitCode);
    }
})();
