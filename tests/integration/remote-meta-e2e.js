#!/usr/bin/env node
'use strict';

/**
 * remote-meta-e2e - Live terminal-METADATA sync between the desktop and
 * attached Remote Mode viewers, with NO reconnect and NO polling:
 *
 *   1. desktop renames + recolors a terminal → the remote view shows the new
 *      title/color within the 2s budget (event push over the existing WS);
 *   2. remote viewer renames a terminal → the DESKTOP applies it (the same
 *      'terminal-meta-changed' → 'remote-terminal-meta' fan-out, reversed);
 *   3. desktop creates a terminal → the remote view gains a matching view
 *      within the budget ('remote-terminal-created' push);
 *   4. desktop closes it → the remote view drops it ('remote-terminal-closed').
 *
 * Isolation: own XDG_CONFIG_HOME + ports; the machine's real app instance and
 * backend are never touched.
 *
 * Run headless:  xvfb-run -a node tests/integration/remote-meta-e2e.js
 */

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const WORK = process.env.CCBOT_E2E_DIR
    ? path.resolve(process.env.CCBOT_E2E_DIR)
    : path.join(APP_ROOT, '.e2e-remote-meta');
const EVID = path.join(WORK, 'evidence');
const CFG = path.join(WORK, 'cfg-remote');
const REMOTE_MODE_PORT = Number(process.env.CCBOT_E2E_REMOTE_PORT || 18237);
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
                // point the backend at a dead port — irrelevant to metadata sync
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
            () => !!(window.terminalGUI && window.terminalGUI.terminals && window.terminalGUI.terminals.size > 0)
        ).catch(() => false), 30000, 'local renderer booted with a terminal', 250);

        browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        await page.goto(`http://127.0.0.1:${REMOTE_MODE_PORT}/#k=${session.token}`);
        await waitFor(() => page.evaluate(
            () => window.__ccbotRemote && window.__ccbotRemote.authed
        ).catch(() => false), 20000, 'browser WS-authenticated', 250);
        await waitFor(() => page.evaluate(
            () => !!(window.terminalGUI && window.terminalGUI.terminals && window.terminalGUI.terminals.size > 0)
        ).catch(() => false), 20000, 'remote renderer booted with a terminal', 250);
        ok(true, 'remote viewer attached (authenticated WS, terminal views built)');

        const readMeta = (p, id) => p.evaluate((tid) => {
            const gui = window.terminalGUI;
            const t = gui.terminals.get(tid);
            if (!t || !t.container) return null;
            const titleEl = t.container.querySelector('.terminal-title');
            const dot = t.container.querySelector('.terminal-color-dot');
            return {
                title: titleEl ? titleEl.textContent : null,
                color: dot ? dot.style.backgroundColor : null,
                stateTitle: (gui.terminalStateManager.getTerminal(tid) || {}).title || null
            };
        }, id);

        // ---- 1. desktop rename+recolor → remote view, within budget ----
        const t0 = Date.now();
        await appPage.evaluate(() => window.terminalGUI.setTerminalMetadata(1, {
            title: 'renamed-by-desktop', color: '#ff3366'
        }));
        await waitFor(async () => {
            const m = await readMeta(page, 1);
            return m && m.title === 'renamed-by-desktop' && m.color === 'rgb(255, 51, 102)' ? m : null;
        }, 10000, 'remote view shows the desktop rename/recolor');
        const dt1 = Date.now() - t0;
        ok(dt1 <= SYNC_BUDGET_MS, `desktop title+color reached the remote view in ${dt1}ms (budget ${SYNC_BUDGET_MS}ms, no reconnect)`);
        await page.screenshot({ path: path.join(EVID, '01-remote-sees-desktop-rename.png') }).catch(() => {});

        // ---- 2. remote rename → desktop, within budget ----
        const t2 = Date.now();
        await page.evaluate(() => window.terminalGUI.setTerminalMetadata(1, { title: 'renamed-by-viewer' }));
        await waitFor(async () => {
            const m = await readMeta(appPage, 1);
            return m && m.title === 'renamed-by-viewer' ? m : null;
        }, 10000, 'desktop shows the viewer rename');
        const dt2 = Date.now() - t2;
        ok(dt2 <= SYNC_BUDGET_MS, `viewer rename reached the DESKTOP in ${dt2}ms (bidirectional sync)`);
        const desktopColor = await readMeta(appPage, 1);
        ok(desktopColor.color === 'rgb(255, 51, 102)', 'desktop kept its color through the viewer rename (partial updates merge)');

        // ---- 3. desktop creates a terminal → remote gains the view ----
        const before = await page.evaluate(() => [...window.terminalGUI.terminals.keys()]);
        const t3 = Date.now();
        const newId = await appPage.evaluate(async () => {
            const gui = window.terminalGUI;
            const prev = new Set(gui.terminals.keys());
            gui.createTerminal();
            for (let i = 0; i < 100; i++) {
                const added = [...gui.terminals.keys()].find((k) => !prev.has(k));
                if (added != null) return added;
                await new Promise((r) => setTimeout(r, 50));
            }
            return null;
        });
        ok(newId != null, `desktop created terminal ${newId}`);
        await waitFor(() => page.evaluate((tid) => window.terminalGUI.terminals.has(tid), newId), 10000,
            'remote view gained the new terminal');
        const dt3 = Date.now() - t3;
        ok(dt3 <= SYNC_BUDGET_MS, `new terminal appeared in the remote view in ${dt3}ms (was ${JSON.stringify(before)})`);
        await page.screenshot({ path: path.join(EVID, '02-remote-sees-new-terminal.png') }).catch(() => {});

        // ---- 4. desktop closes it → remote drops the view ----
        const t4 = Date.now();
        await appPage.evaluate((tid) => window.terminalGUI.closeTerminal(tid), newId);
        await waitFor(() => page.evaluate((tid) => !window.terminalGUI.terminals.has(tid), newId), 10000,
            'remote view dropped the closed terminal');
        const dt4 = Date.now() - t4;
        ok(dt4 <= SYNC_BUDGET_MS, `terminal close reached the remote view in ${dt4}ms`);

        log('ALL CHECKS PASSED');
        log(`latencies: desktop→remote meta ${dt1}ms, remote→desktop meta ${dt2}ms, create ${dt3}ms, close ${dt4}ms`);
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
