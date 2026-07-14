# Web-Served Remote Mode — Design (the VS Code Remote-SSH analog)

**Status:** Design only. Nothing in this document is implemented. This is the
architecture + phased plan for a "web-served server mode" that lets a user on
machine A open a browser and get a **1:1, fully interactive replica** of the
Auto-Injector interface running on headless machine B — the same terminals, the
same manager (999), the same UI, fully interactive (type into terminals, steer,
create/delete, voice-less but everything visual) — as if sitting at machine B.

This is strictly a superset of the existing **`npm run ssh-view`** tool
(`scripts/ssh-view.js`), which is a *read-only* TUI mirror built on the two
non-mutating Control API endpoints (`GET /state`, `POST /terminal/screen`).
Remote Mode reuses the same discovery/loopback/tunnel security posture but adds
**full interactivity** by bridging the Electron IPC surface — not just the
Control API — to the browser.

---

## 1. Current architecture (grounded findings)

### 1.1 Process model & how the renderer loads

- Electron app. `main.js` is the main process; `renderer.js` (~138 KB) is the
  renderer, loaded by `index.html` via a plain `<script src="renderer.js">` tag
  (`index.html:782`) after xterm and its addons are loaded as UMD bundles from
  `node_modules/` (`index.html:776-779`).
- The window is created with **`nodeIntegration: true, contextIsolation: false,
  enableRemoteModule: true`** (`main.js:340-350`). There is **no preload script**
  and **no `contextBridge`**. The renderer therefore does `require('electron')`,
  `require('@xterm/xterm')`, and `require('./src/...')` **directly at the top of
  `renderer.js`** (`renderer.js:1-35`).
- **Consequence for Remote Mode:** the renderer is *not* browser-safe as written.
  It statically `require()`s Node/Electron modules that do not exist in a browser.
  The single most important design decision below is how to neutralize those
  requires so the *same* `renderer.js` can run in a browser tab. It is feasible
  because the renderer touches Electron through exactly **one** narrow object.

### 1.2 The IPC surface — the entire bridge

The renderer talks to main through **one wrapper object**, `this.ipcHandler`
(`renderer.js:104-109`), which is the whole coupling point:

```js
this.ipcHandler = {
  send:    (channel, ...args) => ipcRenderer.send(channel, ...args),
  on:      (channel, handler) => ipcRenderer.on(channel, handler),
  removeListener: (channel, handler) => ipcRenderer.removeListener(channel, handler),
  invoke:  (channel, ...args) => ipcRenderer.invoke(channel, ...args)
};
```

However, `ipcHandler` is not used everywhere — many call sites use
`ipcRenderer.*` **directly** (e.g. `renderer.js:312-560`, `1701`, `1710`,
`1755`, `1872`). So the true bridge surface is **`ipcRenderer` itself**, which
we will shim (see §3.2). Enumerated below.

#### Renderer → main, fire-and-forget (`ipcRenderer.send` → `ipcMain.on`)

| Channel | Payload | Purpose |
| --- | --- | --- |
| `terminal-start` | `{terminalId, directory}` | Spawn a PTY (`main.js:659`) |
| `terminal-input` | `{terminalId, data}` | Keystrokes → PTY write (`main.js:857`) |
| `terminal-resize` | `{terminalId, cols, rows}` | PTY resize (`main.js:875`) |
| `terminal-close` | `{terminalId}` | Kill PTY (`main.js:893`) |
| `get-cwd` | `{terminalId}` | Ask cwd (`main.js:911`) |
| `ccbot-state-snapshot` | snapshot obj | Renderer pushes its state to main for `GET /state` (`main.js:447`) |
| `control-response` | `{requestId, result}` | Reply to a control round-trip (`main.js:455`) |

#### Main → renderer, pushes (`webContents.send` / `event.reply` → `ipcRenderer.on`)

| Channel | Payload | Purpose |
| --- | --- | --- |
| `terminal-data` | `{terminalId, content}` | **PTY output stream** (`main.js:753`) → `terminal.write()` (`renderer.js:316`) |
| `terminal-ready` | `{terminalId}` | PTY spawned (`main.js:771`) |
| `terminal-exit` | `{terminalId, exitCode, signal}` | PTY exited (`main.js:758`) |
| `terminal-error` | `{terminalId, error}` | Spawn failed (`main.js:847`) |
| `terminal-runtime` | `{terminalId, runtime}` | `claude\|shell\|unknown` from `/proc` (`main.js:560`) |
| `claude-hook-event` | hook payload | Ground-truth Claude state (`main.js:485`) |
| `queue-add-request` | `{terminalId, content, type}` | External (manager) queue add (`main.js:490`) |
| `control-request` | `{requestId, action, payload}` | Control API round-trip to renderer (`main.js:469`) |
| `create-terminal` / `close-terminal` | — / `id` | Tray/menu (`renderer.js:312-313`) |
| `tray-start-injection` / `tray-stop-injection` | — | Tray (`renderer.js:471-474`) |
| `terminal-status`, `directory-changed`, `cwd-response` | — | Misc status |

#### Renderer → main, request/response (`ipcRenderer.invoke` → `ipcMain.handle`)

~40 handlers (`main.js:621-1740`). Grouped:

- **Terminal/dir:** `manager-prepare`, `change-terminal-directory`,
  `summarize-completion`, `get-file-info`, `get-cwd`.
- **OS/UI:** `open-external-link`, `show-directory-dialog`, `handle-file-drop`,
  `save-screenshot`, `show-notification`, `update-tray-badge`,
  `start/stop/is-power-save-blocker`.
- **Data/DB (SQLite via `unified-store`):** the large `db-*` family —
  `db-get-setting`, `db-set-setting`, `db-get/save-all-settings`,
  `db-get/save/delete/clear-messages`, `db-save/load-message-queue`,
  `db-save/get/clear-message-history`, `db-get/save/clear-completions`,
  `db-save/load-preferences`, `db-get/set-app-state`, migration helpers.
- **Misc:** `get-ccusage`, `get-sound-effects`, `discord:get-link-key`,
  `backup/restore-localstorage`.

**Key insight:** the DB/`invoke` channels are pure request/response and map
cleanly onto a WebSocket RPC. The terminal `send`/push channels are streaming
and are the hard part.

### 1.3 Terminals — exactly how I/O flows today

Terminals are **node-pty PTYs living in the main process**, keyed by numeric
`terminalId` in a `ptyProcesses` Map (`main.js:745`). xterm.js instances live in
the **renderer**, keyed in `this.terminals` Map (`renderer.js:115`).

**Output path (PTY → screen):**
```
pty.onData(data)                                   // main.js:752
  → event.reply('terminal-data', {terminalId, content: data})
    → ipcRenderer.on('terminal-data')              // renderer.js:316
      → terminalData.terminal.write(content)       // xterm write, renderer.js:320
```

**Input path (keystroke → PTY):**
```
xterm term.onData(data)                            // renderer.js:1700
  → ipcRenderer.send('terminal-input', {terminalId, data})   // renderer.js:1701
    → ipcMain.on('terminal-input') → ptyProcess.write(data)  // main.js:857-871
```

**Resize:** `fitAddon.fit()` → `term.onResize` → `terminal-resize` →
`ptyProcess.resize(cols, rows)` (`renderer.js:1710`, `main.js:875`).

**Screen scrape (already exists, read-only):** `readTerminalScreen()` walks the
xterm buffer (`term.buffer.active`, `translateToString`) and returns plain text
(`renderer.js:2275-2303`). This is what powers `POST /terminal/screen` and
`ssh-view`. It is a *snapshot*, not a stream — good enough for a read-only
mirror, **not** good enough for the interactive 1:1 replica, which needs the raw
`terminal-data` byte stream.

**Critical consequence for streaming:** the authoritative terminal byte stream
(`terminal-data`) is delivered to the renderer and consumed by `xterm.write()`.
For a remote browser we need those same bytes. Two options (see §4):
(a) tap the stream in **main** (fan-out `pty.onData` to both the local renderer
and every WS client), or (b) relay from the renderer. Option (a) is cleaner and
is the recommended design — the PTY lives in main, so main is the natural
broadcast point.

### 1.4 Manager (999), `/state`, Control API, event push

- **Manager** is a real `claude` CLI session in a **concealed PTY, terminal id
  999** (`ManagerInstance`, `src/features/ManagerInstance.js:13`). It is a normal
  app terminal whose tab is hidden until selected (`noWebgl: true`,
  `ManagerInstance.js:232-237`); it is spawned via the same
  `gui.createTerminal()` / `terminal-start` path. So **the manager streams over
  the exact same `terminal-data`/`terminal-input` channels** — Remote Mode gets
  the manager for free once terminal streaming works. (It is write-protected from
  the HTTP queue API but fully interactive locally.)
- **`GET /state`** is served by `HookServer` from a **renderer-pushed snapshot**
  (`ccbot-state-snapshot`, `main.js:447-449`), enriched in main with per-PTY
  `runtime` + `directory` from `/proc` (`enrichSnapshot`, `main.js:497-503`).
- **Control API** = `HookServer` (`src/main/HookServer.js`), a **loopback-only
  (127.0.0.1) HTTP server** on an OS-assigned port, guarded by a per-session
  token via constant-time compare (`HookServer.js:60-80`). Routes in
  `HookServer.CONTROL_ROUTES` (`HookServer.js:224-234`). Mutating control
  actions round-trip to the renderer via `control-request`/`control-response`
  correlated by `requestId` (`main.js:462-475`); PTY-level ones (`terminal-keys`,
  `terminal-claude`) are handled directly in main (`main.js:507-523`).
- **Session file:** on startup main writes `~/.config/ccbot/session.json`
  (mode 0600) with `{port, token}` (`writeSessionFile`, `main.js:538-541`) and
  sets `global.__ccbotHook`. `ssh-view` reads this file to discover coordinates
  (`session-file.js`, `scripts/ssh-view.js`). **Remote Mode reuses this exact
  discovery + token.**
- There is **no WebSocket today.** All push to the renderer is Electron IPC; all
  external control is HTTP request/response. Remote Mode introduces the first WS.

### 1.5 Security posture today

- HookServer binds **127.0.0.1 only** (`HookServer.js:64`), token required on
  every request, token never leaves the host, session file is 0600, removed on
  shutdown. `ssh-view` sends the token only to `127.0.0.1` and reaches a headless
  box purely over the user's own SSH session. **Remote Mode must preserve every
  one of these invariants** — bind loopback, rely on SSH tunnel / Tailscale for
  transport, never bind `0.0.0.0`, never expose the token off-host by default.

---

## 2. Design goals & constraints

1. **Same renderer, in a browser.** Reuse `renderer.js`, `index.html`,
   `style.css`, and the xterm stack unchanged (or nearly so). The browser client
   is the real UI, not a reimplementation.
2. **Full interactivity.** Type into any terminal (incl. 999), steer, create /
   delete / rename, drive the queue, see live PTY output — 1:1 with local.
3. **Loopback-safe by construction.** Bind `127.0.0.1`; transport is the user's
   SSH tunnel or Tailscale. Never `0.0.0.0` by default. Reuse the session token.
4. **Ship as an app feature**, opt-in, off by default, toggle in settings +
   `npm run` script. Any user on this version can enable it.
5. **Coexistence.** The local Electron window and one or more remote browsers can
   be live simultaneously against the same PTYs, with sane conflict behavior.

---

## 3. Proposed architecture

### 3.1 High-level

Add a **Remote Server** in the main process: an HTTP server that (a) serves the
static app assets (`index.html`, `renderer.js`, `style.css`, `node_modules`
xterm bundles, `src/**`) and (b) upgrades to a **WebSocket** that bridges the
Electron IPC surface. The browser loads the real UI; a small **WS-IPC shim**
stands in for `ipcRenderer`, so `renderer.js` runs unmodified.

```
   Machine A (browser)                         Machine B (headless, app running)
 ┌────────────────────┐                       ┌───────────────────────────────────┐
 │  index.html         │   HTTP (assets)       │  RemoteServer (main process)       │
 │  renderer.js  ──────┼──────────────────────▶│   • static file server            │
 │  xterm.js           │                       │   • WS endpoint  /ws               │
 │                     │   WS  (IPC bridge)    │        │                           │
 │  ipcRenderer SHIM ◀─┼───────────────────────┼────────┤ bridges to:               │
 └────────────────────┘   pty data / input     │        ├─ ipcMain handlers (invoke)│
        ▲                                       │        ├─ pty.onData fan-out       │
        │ SSH tunnel / Tailscale                │        └─ webContents pushes       │
        │ (127.0.0.1:PORT on B)                 │   node-pty PTYs (incl. 999)        │
        └───────────────────────────────────────  local Electron window (also live) │
                                                └───────────────────────────────────┘
```

The RemoteServer is a **second server alongside HookServer** (or an extension of
it). Recommended: a **separate module** `src/main/RemoteServer.js` that shares
the HookServer token and session file, because its concerns (static assets, WS,
large streaming payloads) differ from HookServer's tight JSON control surface.

### 3.2 Running the SAME renderer in a browser — the shim (feasibility)

The renderer's browser-incompatibility is concentrated in **module `require`s**,
not in scattered API use. Assessment: **highly feasible**, because:

- The only Electron dependency the renderer needs is **`ipcRenderer`**
  (`renderer.js:1`). Everything else it `require`s (`@xterm/*`,
  `./src/**` app modules) is **plain JS that already runs in a Chromium renderer
  today** and will run in a browser tab unchanged — it is only the CommonJS
  `require()` mechanism and the `electron` module that are missing.
- xterm is already available in the page as a UMD global (`index.html:776`), and
  the app modules are plain classes.

**Approach:** serve a tiny **`remote-bootstrap.js`** loaded *before*
`renderer.js` that installs:

1. A **`require` shim** on `window`. For `require('electron')` it returns
   `{ ipcRenderer: wsIpc }` — our WS-backed shim. For `require('@xterm/xterm')`
   etc. it returns the already-loaded UMD globals. For `require('./src/...')` it
   returns modules from a small bundle (see below).
2. The **`wsIpc` object** implementing the exact `ipcRenderer` contract the
   renderer uses: `send`, `on`, `once`, `removeListener`, `invoke`. It serializes
   each call onto the WS (§3.3) and dispatches incoming pushes to registered
   `on` handlers.

**The app `./src/**` requires** are the one wrinkle: a browser has no CommonJS
loader for local paths. Two viable paths, in increasing polish:

- **v1 (fastest):** introduce a light **bundle step** (esbuild) that bundles
  `renderer.js` + `src/**` into a single `renderer.bundle.js` served to the
  browser, with `electron` marked external and provided by the shim. This is a
  one-line esbuild invocation; no source changes to the app. The Electron app
  keeps loading `renderer.js` the old way. **~1 file + a build script.**
- **v2 (no bundler):** ship a minimal AMD/CommonJS shim that pre-registers each
  `src/**` module by path. More moving parts; the esbuild route is strongly
  preferred.

**Net:** `renderer.js` itself needs **zero or near-zero changes**. The coupling
was already funneled through `ipcRenderer` + `require`, so shimming those two is
the whole job. This is the crux of why "same renderer in the browser" is
realistic here rather than a rewrite.

> One caveat: a handful of renderer features assume a real desktop (native file
> drop via `handle-file-drop`, `save-screenshot`, `show-directory-dialog`,
> power-save-blocker, tray badge). These are `invoke` calls that run **on the
> server (machine B)** — they will *work* but act on B, not A (e.g. a directory
> dialog would try to open on the headless box). v1 should **degrade** these:
> the shim answers them locally with a sensible no-op/error, or the browser uses
> HTML file inputs. Terminal + queue + manager interactivity — the point of the
> feature — is unaffected.

### 3.3 WebSocket message protocol

One WS connection per browser client. All frames are JSON except optionally the
hot PTY-output path (see note). Envelope:

```jsonc
{ "t": "<type>", ... }
```

**Client → server:**

| `t` | Fields | Maps to |
| --- | --- | --- |
| `send` | `channel, args[]` | `ipcRenderer.send(channel, ...args)` → `ipcMain.on` |
| `invoke` | `id, channel, args[]` | `ipcRenderer.invoke` → `ipcMain.handle`; reply correlated by `id` |
| `hello` | `token, clientId` | Auth handshake (§3.5) |
| `resize-view` | `terminalId, cols, rows` | (same as `terminal-resize` send; listed for clarity) |

**Server → client:**

| `t` | Fields | Maps to |
| --- | --- | --- |
| `push` | `channel, args[]` | A `webContents.send(channel, ...)` the renderer listens for via `ipcRenderer.on` |
| `invoke-result` | `id, ok, result\|error` | Result of a prior `invoke` |
| `welcome` | `snapshot, terminals[]` | Post-auth bootstrap (see replay, §4.2) |

The shim's `ipcRenderer.on(channel, handler)` registrations are **local to the
browser**; the server simply forwards every `push` frame and the shim routes it
to the matching handlers. The shim's `invoke` returns a Promise resolved when the
matching `invoke-result` arrives. `send` is fire-and-forget.

This is a **transparent transport swap**: because *every* renderer↔main
interaction already goes through `send`/`on`/`invoke`, mapping those three verbs
onto `send`/`push`/`invoke` WS frames reproduces the entire experience. No
per-feature protocol design is needed — the IPC channels *are* the protocol.

> **PTY output volume note:** `terminal-data` is the highest-bandwidth channel.
> It rides the generic `push` envelope (`channel:"terminal-data"`). For v1 that
> is fine (JSON-stringify of a chunk). If profiling shows overhead, v2 can add a
> binary WS frame fast-path keyed by terminalId, bypassing JSON — an optimization,
> not a redesign.

### 3.4 Terminal streaming — exact mechanism

The recommended design **taps the PTY stream in main** so both the local
renderer and every remote browser get identical bytes:

**Output (PTY → all clients):** in `main.js:752`, `pty.onData` currently does
only `event.reply('terminal-data', …)`. Change it to also fan out to the
RemoteServer's WS clients:

```js
terminalProcess.onData((data) => {
  event.reply('terminal-data', { terminalId, content: data });   // local window (unchanged)
  remoteServer?.broadcast({ t: 'push', channel: 'terminal-data',
                            args: [{ terminalId, content: data }] });
});
```

Each browser's shim delivers it to `ipcRenderer.on('terminal-data')` →
`xterm.write()` — the **same code path** as local. Same for `terminal-ready`,
`terminal-exit`, `terminal-error`, `terminal-runtime`, `claude-hook-event`,
`queue-add-request`: these are already `webContents.send` broadcasts; wrap that
call site in a helper that *also* `remoteServer.broadcast(...)`s the same frame.

**Input (browser keystroke → PTY):** the browser xterm's `onData` →
shim `ipcRenderer.send('terminal-input', {terminalId, data})` → WS `send` frame →
server calls `ipcMain.emit('terminal-input', fakeEvent, payload)` **or** (cleaner)
the RemoteServer writes straight to `ptyProcesses.get(terminalId).write(data)`.
Recommended: route WS `send` frames for the PTY channels
(`terminal-start/input/resize/close`) **directly to the same handlers main
already runs**, by extracting the bodies of those `ipcMain.on` handlers into
plain functions both the IPC handler and the RemoteServer call. This avoids
faking Electron event objects.

**Resize / late-join:** each client has its own viewport. See §4.3 for multi-
client resize policy. A newly-connected browser must be **replayed** the current
screen so it doesn't start blank — see §4.2.

### 3.5 Auth & security model

- **Reuse the HookServer session token.** The RemoteServer requires the same
  `X-CCBOT-Token` (for the initial HTTP asset fetch this is awkward in a browser,
  so use the flow below).
- **Bind `127.0.0.1` only.** The user reaches machine B via
  `ssh -L 9999:127.0.0.1:<port> B` **or** Tailscale (`tailscale serve` / direct
  to B's tailnet IP with the server still bound to loopback + Tailscale's own
  identity). **Never bind `0.0.0.0` by default.** A settings flag
  `remote.bindAddress` may allow `0.0.0.0` for advanced Tailscale users, but it
  defaults to loopback and warns loudly.
- **Browser auth flow (token can't be a header on a top-level navigation):**
  1. User runs `npm run remote` (or toggles it on); the CLI prints a one-time
     URL: `http://127.0.0.1:<port>/#k=<token>` (token in the URL *fragment*, which
     is never sent to the server or logged).
  2. `remote-bootstrap.js` reads `location.hash`, strips it immediately
     (`history.replaceState`), and uses the token only to authenticate the **WS
     `hello`** frame and as a `Sec-WebSocket-Protocol`/query on the WS upgrade.
  3. Static asset requests are gated by a **short-lived signed cookie** set by a
     `/auth?k=<token>` endpoint (double-submit against the fragment token), or —
     simpler for v1 — the asset server is unauthenticated but serves only static,
     non-secret UI files (the *data* all flows over the token-gated WS). Since the
     bundle contains no secrets and the WS is the only path to real state/PTYs,
     **v1 can leave assets open on loopback and gate exclusively at the WS
     `hello`.** This mirrors how `ssh-view` treats loopback as the trust
     boundary.
- **Token scope:** the WS `hello` token is compared with the same constant-time
  check as HookServer (`crypto.timingSafeEqual`). A bad token closes the socket.
- **No token in logs / off-host.** Fragment + cookie means the token never
  appears in server access logs. The token is the *same* one already confined to
  the host; the transport confidentiality is the SSH tunnel / Tailscale, exactly
  as `ssh-view` relies on today.

### 3.6 Multi-client behavior

- **Local window + N browsers simultaneously:** yes. PTYs are shared state in
  main; every client is a *view* + *input source*. Output is broadcast to all.
- **Input conflicts:** all clients write to the same PTY — like two people at one
  `screen`/`tmux` session. This is acceptable and matches user expectation for a
  "sit at machine B" tool. v1 does **no locking**. Optional v2: a soft
  "someone else is typing" indicator, or a read-only spectator mode toggle.
- **Resize conflicts:** a PTY has one size. Policy for v1: **last-writer-wins**,
  and the local Electron window is authoritative when present (the browser fits
  to its own xterm but the PTY size follows the most recent `resize`). Simple and
  predictable; xterm reflows gracefully on the smaller/larger clients. v2 could
  clamp to the min of all attached viewports.
- **State snapshot (`/state`, queue):** already centralized in the renderer and
  mirrored to main; all clients render from the same `ccbot-state-snapshot`
  broadcasts, so queue/terminal-list stay consistent automatically.

---

## 4. Hard problems & how they're solved

### 4.1 Two renderers, one source of truth
The **local Electron renderer remains the single owner** of app state (queue,
manager, DB writes). Remote browsers are additional renderers, BUT if two full
renderers both ran the manager/queue logic they'd double-drive it. **Resolution:**
the browser renderer runs in a **"thin/attached" mode** — a boot flag
(`window.__CCBOT_REMOTE__ = true`) tells `renderer.js` to **not** re-instantiate
authoritative singletons that must be unique (the `ManagerInstance` scheduler,
the injection loop, DB persistence), and instead render from broadcasts and send
inputs. The terminal grid, xterm views, queue display, and all *input* affordances
are fully live; the *decision loops* stay in the one local renderer.

This is the single most important correctness constraint and the main reason
"just run renderer.js in a browser" needs a small, surgical flag rather than
being truly zero-change. Concretely it means guarding a few constructor/init
calls in `initializeFeatures()` (`renderer.js:141-192`) behind
`if (!window.__CCBOT_REMOTE__)`.

> Alternative considered: run the browser as a **pure pixel/DOM mirror** of the
> local renderer (stream the buffer, like ssh-view but richer). Rejected — it
> doesn't give true interactivity per-client and duplicates what xterm already
> does well. The attached-renderer approach reuses far more code.

### 4.2 Late-join replay (blank-screen problem)
`terminal-data` is a *stream*; a browser connecting mid-session missed all prior
output. On WS connect, the server sends a **`welcome`** with, per terminal, the
current screen via the existing `readTerminalScreen(id, {scrollback:true})`
(`renderer.js:2275`) — the browser xterm `write()`s that backlog first, then
live `terminal-data` frames append. This reuses machinery that already exists for
`/terminal/screen`. (xterm has no serialize addon loaded; the plain-text buffer
dump is sufficient for a faithful catch-up, losing only color/attributes of
scrollback — acceptable for v1; v2 can add `@xterm/addon-serialize` for full
fidelity replay.)

### 4.3 Per-client resize — see §3.6 (last-writer-wins, local authoritative).

### 4.4 Native/desktop `invoke`s run on B — see §3.2 caveat (degrade file dialog,
screenshot, tray, power-save; terminal/queue/DB all work).

---

## 5. Files to add / change

### New files
- **`src/main/RemoteServer.js`** — HTTP static server + WS bridge; `broadcast()`,
  per-client auth, replay `welcome`, routes WS `send`/`invoke` to main handlers.
  Binds `127.0.0.1`, shares HookServer token + session file.
- **`src/remote/remote-bootstrap.js`** — browser-side: `require` shim + `wsIpc`
  (`ipcRenderer` replacement) + hash-token handling + `window.__CCBOT_REMOTE__`.
- **`src/remote/index.remote.html`** — thin variant of `index.html` that loads
  `remote-bootstrap.js` before the bundled renderer, and drops desktop-only tags.
- **`scripts/remote.js`** + `"remote"` npm script — start/advertise the server,
  print the tunnel instructions and one-time URL (mirrors `ssh-view.js` ergonomics).
- **`scripts/build-remote.js`** (or an esbuild call in `package.json`) — bundle
  `renderer.js` + `src/**` → `renderer.bundle.js` with `electron` external.
- **`docs/REMOTE_MODE.md`** — this document.

### Changed files
- **`main.js`** — instantiate `RemoteServer` next to `hookServer` (gated by a
  setting, default off); wrap the PTY-output and `webContents.send` broadcast
  call sites so they also `remoteServer.broadcast(...)`; extract the bodies of
  the `terminal-start/input/resize/close` `ipcMain.on` handlers into plain
  functions the RemoteServer can call directly.
- **`renderer.js`** — guard the must-be-singleton inits in `initializeFeatures`
  behind `!window.__CCBOT_REMOTE__` (manager scheduler, injection loop,
  DB-authoritative writes). No change to the terminal/xterm/`ipcHandler` code.
- **`package.json`** — `remote` + `build-remote` scripts, add `esbuild` (dev dep)
  and `ws` (or use Node's built-in `http` + a tiny WS impl; `ws` is simplest).
- **Settings UI (`index.html` + PreferenceManager)** — an opt-in "Remote web
  access" toggle + bind-address selector (loopback default) + "copy access URL".

### Deliberately unchanged
- xterm stack, `style.css`, the Control API/HookServer semantics, the session
  file format, `ssh-view.js`.

---

## 6. Phased plan

**Phase 0 — Bundle & boot (prove the renderer runs in a browser).**
esbuild bundle of `renderer.js`+`src/**` with `electron` external; a stub
`wsIpc` that no-ops. Serve `index.remote.html` over plain HTTP on loopback; load
it in a browser; confirm the UI paints (no live data yet). *Exit:* the interface
renders in Chrome pointed at `127.0.0.1:<port>` with no console-fatal `require`s.

**Phase 1 — Read-only live mirror over WS (superset of ssh-view).**
WS `hello` auth; server broadcasts `terminal-data` + snapshot pushes; `welcome`
replay. Browser shows live terminals updating, but input disabled. *Exit:* watch
all terminals + manager live in a browser tab, catch-up on join.

**Phase 2 — Full interactivity.**
Wire `terminal-input`/`resize`/`start`/`close`, `invoke` RPC (DB + control), the
`__CCBOT_REMOTE__` singleton guards, and desktop-invoke degradation. *Exit:* type
into any terminal (incl. 999), create/delete/rename, drive the queue from the
browser, 1:1 with local; local + browser coexist.

**Phase 3 — Hardening & polish.**
Cookie/fragment auth flow, bind-address setting + warnings, settings toggle +
"copy URL", multi-client resize policy, reconnect/backoff in the shim,
`addon-serialize` full-fidelity replay, optional binary PTY fast-path, spectator
mode. *Exit:* shippable, documented, opt-in.

**MVP (v1) = Phases 0–2** on loopback with WS-`hello` token gating and open
static assets. **Fuller (v2) = Phase 3.**

---

## 7. Effort & risk

**Effort (rough):**
- Phase 0: **0.5–1 day** (esbuild config is the only real work; the shim caveats).
- Phase 1: **1–2 days** (WS server, broadcast fan-out, replay).
- Phase 2: **2–4 days** (input routing, invoke RPC, the singleton-guard audit in
  `renderer.js` — this is the fiddly part; must not double-run the manager/queue).
- Phase 3: **2–4 days** (auth polish, settings, multi-client, fidelity).
- **Total ~1–1.5 weeks** for a solid v1+partial v3, dominated by Phase 2's
  correctness audit, not by new infrastructure.

**Top risks / unknowns:**
1. **Singleton double-drive (highest).** If the browser renderer re-runs the
   `ManagerInstance` scheduler or injection loop, it will double-steer terminals
   or double-write the DB. Mitigation: the `__CCBOT_REMOTE__` guard + a careful
   audit of every stateful init in `initializeFeatures`. This is the make-or-break
   correctness item.
2. **`require('./src/**')` in the browser.** Solved by esbuild bundling, but any
   dynamic/conditional `require` in the app tree could slip the bundle. Low risk;
   the codebase uses static top-level requires.
3. **PTY output bandwidth over WS + tunnel.** A `yes`-flooding terminal could
   swamp the socket. Mitigation: coalesce `terminal-data` chunks per animation
   frame server-side; binary fast-path in v2; per-client backpressure.
4. **node-pty is native + main-side only.** Fine — PTYs stay in main; the browser
   never needs node-pty (it only has xterm). No native module ships to the
   browser. This is actually *why* the split is clean.
5. **Auth ergonomics in a browser.** Token-in-fragment + loopback-only is the
   pragmatic v1; a mis-set `bindAddress: 0.0.0.0` would expose the box. Mitigation:
   default loopback, explicit warning, and document the SSH-tunnel/Tailscale path
   as the intended transport (identical to `ssh-view`'s model).
6. **Desktop-only invokes** (dialogs, screenshot, tray) acting on machine B, not
   A. Mitigation: degrade/no-op in remote mode; not core to the feature.

**Bottom line:** the architecture is unusually favorable for this because the
renderer already funnels *all* main communication through `ipcRenderer`'s three
verbs and the PTYs already live in main. Remote Mode is therefore a **transport
swap + a broadcast fan-out + a singleton guard**, reusing `renderer.js`,
`index.html`, `style.css`, xterm, the Control API token, and the session-file
discovery essentially unchanged — not a rewrite.
