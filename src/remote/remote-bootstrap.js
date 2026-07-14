/**
 * remote-bootstrap - Browser-side bootstrap for web-served Remote Mode.
 *
 * Loaded by the RemoteServer-transformed index.html BEFORE the bundled
 * renderer. It makes the unmodified renderer runnable in a plain browser tab:
 *
 *   1. Sets `window.__CCBOT_REMOTE__ = true` — the flag renderer.js /
 *      MessageQueueManager / ManagerInstance use to disable the authoritative
 *      singletons (injection engine, manager scheduler, DB persistence) so a
 *      browser renderer never double-drives the one true local renderer.
 *   2. Installs `window.require`, a shim resolving the handful of modules
 *      esbuild leaves external: `electron` (→ wsIpc below), `fs`/`path`
 *      (inert stubs), `vosk-browser` (wake word is desktop-only).
 *   3. Installs `wsIpc`, an `ipcRenderer`-contract object (send / on / once /
 *      removeListener / invoke) that transports every IPC verb over a single
 *      WebSocket to the RemoteServer in the Electron main process.
 *
 * Auth: the access URL carries the session token in the URL *fragment*
 * (`#k=<token>`), which is never sent over HTTP or logged. It is read once,
 * stripped from the address bar, cached in sessionStorage (so reloads work),
 * and presented only in the WebSocket `hello` frame.
 */
(() => {
    'use strict';

    window.__CCBOT_REMOTE__ = true;

    // ---- token: URL fragment -> sessionStorage ----
    let token = '';
    const m = /[#&]k=([A-Za-z0-9]+)/.exec(window.location.hash || '');
    if (m) {
        token = m[1];
        try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (_) { /* ignore */ }
        try { window.sessionStorage.setItem('ccbotRemoteToken', token); } catch (_) { /* ignore */ }
    } else {
        try { token = window.sessionStorage.getItem('ccbotRemoteToken') || ''; } catch (_) { /* ignore */ }
    }

    // ---- wsIpc: the ipcRenderer stand-in over one WebSocket ----
    const listeners = new Map();   // channel -> Set<handler>
    const pending = new Map();     // invoke id -> { resolve, reject }
    const sendQueue = [];          // frames queued until the socket is authed
    let nextInvokeId = 1;
    let sock = null;
    let authed = false;
    let authRejected = false;

    function dispatchPush(channel, args) {
        const set = listeners.get(channel);
        if (!set || set.size === 0) return;
        const fakeEvent = { channel, sender: null };
        [...set].forEach((fn) => {
            try { fn(fakeEvent, ...args); } catch (err) {
                console.error('[remote] handler for "' + channel + '" threw:', err);
            }
        });
    }

    function connect() {
        if (authRejected) return; // bad token: don't hammer the server
        const proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        sock = new WebSocket(proto + window.location.host + '/ws');
        sock.onopen = () => {
            sock.send(JSON.stringify({ t: 'hello', token }));
        };
        sock.onmessage = (ev) => {
            let frame;
            try { frame = JSON.parse(ev.data); } catch (_) { return; }
            if (frame.t === 'welcome') {
                authed = true;
                console.log('[remote] connected + authenticated; snapshot terminals:',
                    frame.snapshot && frame.snapshot.terminals ? frame.snapshot.terminals.length : 0);
                while (sendQueue.length) sock.send(sendQueue.shift());
            } else if (frame.t === 'push') {
                dispatchPush(frame.channel, frame.args || []);
            } else if (frame.t === 'invoke-result') {
                const p = pending.get(frame.id);
                if (p) {
                    pending.delete(frame.id);
                    if (frame.ok) p.resolve(frame.result);
                    else p.reject(new Error(frame.error || 'remote invoke failed'));
                }
            } else if (frame.t === 'error') {
                console.error('[remote] server error:', frame.error);
                if (frame.code === 'auth') authRejected = true;
            }
        };
        sock.onclose = () => {
            authed = false;
            if (!authRejected) setTimeout(connect, 1500); // simple reconnect
        };
        sock.onerror = () => { /* onclose fires next */ };
    }
    connect();

    function wsSend(frame) {
        const s = JSON.stringify(frame);
        if (authed && sock && sock.readyState === WebSocket.OPEN) sock.send(s);
        else sendQueue.push(s);
    }

    const wsIpc = {
        send(channel, ...args) { wsSend({ t: 'send', channel, args }); },
        on(channel, handler) {
            if (!listeners.has(channel)) listeners.set(channel, new Set());
            listeners.get(channel).add(handler);
            return wsIpc;
        },
        once(channel, handler) {
            const wrap = (...a) => { wsIpc.removeListener(channel, wrap); handler(...a); };
            return wsIpc.on(channel, wrap);
        },
        removeListener(channel, handler) {
            const set = listeners.get(channel);
            if (set) set.delete(handler);
            return wsIpc;
        },
        removeAllListeners(channel) { listeners.delete(channel); return wsIpc; },
        invoke(channel, ...args) {
            return new Promise((resolve, reject) => {
                const id = nextInvokeId++;
                pending.set(id, { resolve, reject });
                wsSend({ t: 'invoke', id, channel, args });
            });
        }
    };

    // ---- minimal node-ish globals the renderer touches ----
    if (typeof window.process === 'undefined') {
        window.process = { cwd: () => '/', env: {}, platform: 'browser', argv: [] };
    }

    const pathShim = {
        sep: '/',
        join: (...p) => p.filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
        resolve: (...p) => pathShim.join(...p),
        basename: (p) => String(p).split('/').filter(Boolean).pop() || '',
        dirname: (p) => {
            const parts = String(p).split('/');
            parts.pop();
            return parts.join('/') || '/';
        },
        extname: (p) => {
            const b = pathShim.basename(p);
            const i = b.lastIndexOf('.');
            return i > 0 ? b.slice(i) : '';
        }
    };
    const fsShim = {
        existsSync: () => false,
        readFileSync: () => { throw new Error('fs is unavailable in remote mode'); },
        promises: {}
    };

    const modules = {
        electron: {
            ipcRenderer: wsIpc,
            shell: { openExternal: (url) => { window.open(url, '_blank', 'noopener'); return Promise.resolve(); } }
        },
        fs: fsShim,
        path: pathShim,
        'vosk-browser': {
            createModel: () => Promise.reject(new Error('wake word is unavailable in remote mode'))
        }
    };

    window.require = function requireShim(name) {
        if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
        throw new Error('[remote] module not available in the browser: ' + name);
    };

    // A few modules (PreferenceManager) reference `ipcRenderer` as a bare
    // identifier without requiring it — in the browser that resolves via the
    // global scope, so point it at the same WS-backed shim.
    window.ipcRenderer = wsIpc;

    // Handy for debugging from the browser console.
    window.__ccbotRemote = { wsIpc, get authed() { return authed; } };
})();
