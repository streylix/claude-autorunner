/**
 * browser-game - the main-process half of the Browser card.
 *
 * The card itself (browser.html) is a game like any other, but the page it
 * shows is the open web, which an iframe cannot render: every site worth
 * scrolling sends X-Frame-Options or a frame-ancestors CSP. So the content is a
 * <webview>, a guest in its own process with its own session — which is exactly
 * what makes the card useful (cookies survive, so you stay logged in) and
 * exactly what has to be fenced in.
 *
 * The fence is here rather than in the renderer, because the renderer is the
 * side that could be talked into asking for something:
 *
 *  - `guardAttach()` rewrites the preferences of every webview at attach time.
 *    A game that got a <webview> into the DOM still cannot hand it a preload
 *    script, Node, or the app's own session — and anything not on our partition
 *    is refused outright.
 *  - the browsing session denies permissions by default. A page that asks for
 *    the camera, the microphone or your location gets a no without a prompt.
 *  - popups never open a window. `target="_blank"` is handed back to the card,
 *    which opens it as a tab — the same thing a browser does, without a second
 *    OS window appearing on top of the app.
 *
 * Cookies and storage live under the `persist:` partition, so they are written
 * to disk beside the app's other data and are the one thing here that outlives
 * the process. `browser-game:clear` is the way back out — the card's "sign out
 * of everything" button.
 */
const { session } = require('electron');

// Its own partition, never the app's default session: the sites you scroll and
// the app's own requests (backend, pricing, transcription) must not share a
// cookie jar. `persist:` is what makes the login survive a restart.
const PARTITION = 'persist:browser-game';

// Everything else — camera, microphone, location, notifications, MIDI, USB — is
// denied without asking. None of it is needed to read a feed.
const ALLOWED_PERMISSIONS = new Set([
    'fullscreen',
    'clipboard-sanitized-write',
    'pointerLock',
]);

const isWebUrl = (url) => /^https?:\/\//i.test(url || '');

/**
 * Session policy + popup handling. Called once at startup.
 *
 * @param {Electron.App} app
 * @param {Electron.IpcMain} ipcMain
 * @param {(channel: string, payload: any) => void} broadcast  to the renderer
 */
function setupBrowserGame(app, ipcMain, broadcast) {
    const browsing = session.fromPartition(PARTITION);

    browsing.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(ALLOWED_PERMISSIONS.has(permission));
    });
    // The check handler answers the synchronous form of the same question —
    // without it a page can read "granted" for something the prompt would deny.
    browsing.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));

    app.on('web-contents-created', (_event, contents) => {
        if (contents.getType() !== 'webview') return;

        // A new window would escape the panel entirely and defeat the point of
        // staying in the app. The card gets told instead, and opens a tab —
        // which is what the link asked for in the only place it can happen.
        contents.setWindowOpenHandler(({ url }) => {
            if (isWebUrl(url) && typeof broadcast === 'function') {
                try { broadcast('browser-game:popup', { url }); } catch (_) { /* no window */ }
            }
            return { action: 'deny' };
        });

        // Only the web. Nothing gets to steer the guest at a local file or a
        // custom scheme that some other app on the machine has registered.
        contents.on('will-navigate', (event, url) => {
            if (!isWebUrl(url)) event.preventDefault();
        });
    });

    // "Sign out of everything" — the only way cookies leave the partition.
    ipcMain.handle('browser-game:clear', async () => {
        await browsing.clearStorageData();
        await browsing.clearCache();
        return { ok: true };
    });
}

/**
 * Lock down every webview the given renderer attaches.
 *
 * The app's own renderer runs with full Node and no context isolation; a guest
 * must inherit none of that, and Electron asks before each attach.
 *
 * @param {Electron.WebContents} webContents  the embedder (the app window)
 */
function guardWebviewAttach(webContents) {
    webContents.on('will-attach-webview', (event, webPreferences, params) => {
        delete webPreferences.preload;
        webPreferences.nodeIntegration = false;
        webPreferences.nodeIntegrationInSubFrames = false;
        webPreferences.contextIsolation = true;
        webPreferences.sandbox = true;
        webPreferences.webSecurity = true;

        // No partition means the default session — the app's own cookies. That
        // is never what a page from the internet should be handed.
        if (params.partition !== PARTITION) event.preventDefault();
    });
}

module.exports = { setupBrowserGame, guardWebviewAttach, PARTITION };
