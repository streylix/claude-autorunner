#!/usr/bin/env node
'use strict';

/**
 * ssh-view — a READ-ONLY, live terminal mirror of the Auto-Injector interface.
 *
 * Purpose: let a user SSH into a (possibly headless) machine running the
 * Auto-Injector Electron app and watch the whole interface — every terminal's
 * live screen plus the manager (terminal 999) — right in their SSH session.
 *
 * READ-ONLY BY CONSTRUCTION: this tool only ever calls the two non-mutating
 * Control API endpoints — `GET /state` and `POST /terminal/screen`. It never
 * queues, injects, creates, deletes, or steers anything. There is no code path
 * here that hits a mutating endpoint.
 *
 * Discovery: an SSH login shell does NOT inherit the app's CCBOT_PORT/CCBOT_TOKEN
 * env vars, so we read the session file the app writes on startup
 * (~/.config/ccbot/session.json, 0600). --port/--token flags and CCBOT_PORT/
 * CCBOT_TOKEN env vars override it. The token is only ever sent to 127.0.0.1.
 *
 * Resilience: if the app/API is unreachable (app off, headless-display issue,
 * restarting on a new port) it shows a "waiting for app…" screen and keeps
 * retrying — it never crashes.
 *
 * Dependencies: Node built-ins only (http, readline, tty). No new packages.
 */

const http = require('http');
const readline = require('readline');
const path = require('path');

// Reuse the app's canonical session-file resolver so we always read the exact
// path the app wrote. Fall back to an inline reader if the module is missing
// (e.g. run from a partial checkout) so discovery still degrades gracefully.
let readSessionFile;
try {
  ({ readSessionFile } = require(path.join(__dirname, '..', 'src', 'main', 'session-file')));
} catch (_) {
  const fs = require('fs');
  const os = require('os');
  readSessionFile = function readSessionFileFallback() {
    try {
      const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      const raw = fs.readFileSync(path.join(base, 'ccbot', 'session.json'), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && parsed.port && parsed.token ? parsed : null;
    } catch (e) {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Config / CLI args
// ---------------------------------------------------------------------------
const REFRESH_MS = 1500;      // live-screen auto-refresh cadence
const HTTP_TIMEOUT_MS = 3000; // per-request timeout
const MANAGER_ID = 999;
const HOST = '127.0.0.1';     // loopback ONLY — the token must never leave the host

function parseArgs(argv) {
  const out = { port: null, token: null, scrollback: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = argv[++i];
    else if (a === '--token' || a === '-t') out.token = argv[++i];
    else if (a.startsWith('--port=')) out.port = a.slice(7);
    else if (a.startsWith('--token=')) out.token = a.slice(8);
    else if (a === '--scrollback') out.scrollback = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  process.stdout.write(
    'ccbot ssh-view — read-only live mirror of the Auto-Injector interface\n\n' +
    'Usage: npm run ssh-view [-- --port N --token HEX --scrollback]\n\n' +
    'Discovery order for port/token:\n' +
    '  1. --port/--token flags\n' +
    '  2. CCBOT_PORT / CCBOT_TOKEN env vars\n' +
    '  3. ~/.config/ccbot/session.json (written by the app on startup)\n\n' +
    'Keys: ↑/↓ or j/k select · ←/→ cycle · 1-9 jump · g grid · s scrollback · r refresh · q quit\n'
  );
  process.exit(0);
}

/**
 * Resolve the live {port, token} each time we (re)connect, so a restarted app
 * on a new port is picked up automatically. Precedence: CLI flags > env >
 * session file. Returns null if nothing is available yet.
 */
function resolveCoords() {
  const port = args.port || process.env.CCBOT_PORT || null;
  const token = args.token || process.env.CCBOT_TOKEN || null;
  if (port && token) return { port: Number(port), token: String(token), source: 'flags/env' };
  const sess = readSessionFile();
  if (sess && sess.port && sess.token) {
    // Flags/env may partially override the session file.
    return {
      port: Number(port || sess.port),
      token: String(token || sess.token),
      source: 'session-file'
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP (loopback only)
// ---------------------------------------------------------------------------
function apiRequest(method, urlPath, coords, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: HOST,               // never anything but loopback
      port: coords.port,
      path: urlPath,
      method,
      headers: Object.assign(
        { 'X-CCBOT-Token': coords.token },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
      )
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode === 403) return reject(new Error('403 (bad token)'));
        try {
          resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null });
        } catch (e) {
          resolve({ status: res.statusCode, json: null, raw: buf });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(HTTP_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

const getState = (coords) => apiRequest('GET', '/state', coords);
const getScreen = (coords, terminalId, scrollback) =>
  apiRequest('POST', '/terminal/screen', coords, { terminalId, scrollback: !!scrollback });

// ---------------------------------------------------------------------------
// ANSI / rendering helpers
// ---------------------------------------------------------------------------
const ESC = '\x1b[';
const ANSI = {
  clear: ESC + '2J' + ESC + 'H',
  home: ESC + 'H',
  hideCursor: ESC + '?25l',
  showCursor: ESC + '?25h',
  altScreen: ESC + '?1049h',
  mainScreen: ESC + '?1049l',
  reset: ESC + '0m',
  dim: ESC + '2m',
  bold: ESC + '1m',
  inverse: ESC + '7m',
  fgGreen: ESC + '32m',
  fgYellow: ESC + '33m',
  fgCyan: ESC + '36m',
  fgRed: ESC + '31m',
  fgGray: ESC + '90m'
};

// Pad/truncate plain text to exactly `width` visible columns. Input must be
// ANSI-free (the /terminal/screen payload is plain text), so char length ==
// visible length.
function fit(str, width) {
  str = (str == null ? '' : String(str)).replace(/[\t\r\n]/g, ' ');
  if (str.length > width) return str.slice(0, width);
  return str + ' '.repeat(width - str.length);
}

function runtimeBadge(rt) {
  switch (rt) {
    case 'claude': return ANSI.fgGreen + 'claude' + ANSI.reset;
    case 'shell': return ANSI.fgYellow + 'shell ' + ANSI.reset;
    case 'unknown': return ANSI.fgGray + 'unknwn' + ANSI.reset;
    default: return ANSI.fgGray + fit(rt || '?', 6) + ANSI.reset;
  }
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const state = {
  coords: null,
  connected: false,
  lastError: null,
  terminals: [],       // from /state (+ synthetic manager if absent)
  selectedIndex: 0,
  screen: '',          // selected terminal's screen text
  screenMeta: null,    // {rows, cols}
  screenError: null,
  gridScreens: new Map(), // id -> {screen|error} in grid mode
  mode: 'single',      // 'single' | 'grid'
  scrollback: args.scrollback,
  updatedAt: 0
};

function selectedTerminal() {
  return state.terminals[state.selectedIndex] || null;
}

// Merge in a synthetic manager entry if /state didn't list terminal 999, so the
// manager is always mirror-able (the task requires seeing it).
function normalizeTerminals(list) {
  const terms = Array.isArray(list) ? list.slice() : [];
  if (!terms.some((t) => Number(t.id) === MANAGER_ID)) {
    terms.push({ id: MANAGER_ID, title: 'Manager', status: '—', runtime: 'unknown', synthetic: true });
  }
  // Stable order: real terminals by id ascending, manager last.
  terms.sort((a, b) => {
    if (Number(a.id) === MANAGER_ID) return 1;
    if (Number(b.id) === MANAGER_ID) return -1;
    return Number(a.id) - Number(b.id);
  });
  return terms;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const coords = resolveCoords();
    if (!coords) {
      state.connected = false;
      state.coords = null;
      state.lastError = 'no session file / CCBOT_* env — is the app running?';
      render();
      return;
    }
    state.coords = coords;

    let res;
    try {
      res = await getState(coords);
    } catch (e) {
      state.connected = false;
      state.lastError = e.message;
      render();
      return;
    }
    if (!res || res.status !== 200 || !res.json) {
      state.connected = false;
      state.lastError = res ? ('HTTP ' + res.status) : 'no response';
      render();
      return;
    }

    state.connected = true;
    state.lastError = null;
    state.terminals = normalizeTerminals(res.json.terminals);
    state.updatedAt = res.json.updatedAt || Date.now();
    if (state.selectedIndex >= state.terminals.length) {
      state.selectedIndex = Math.max(0, state.terminals.length - 1);
    }

    if (state.mode === 'grid') {
      await fetchAllScreens(coords);
    } else {
      await fetchSelectedScreen(coords);
    }
    render();
  } finally {
    refreshing = false;
  }
}

async function fetchSelectedScreen(coords) {
  const term = selectedTerminal();
  if (!term) return;
  try {
    const res = await getScreen(coords, Number(term.id), state.scrollback);
    if (res.json && res.json.ok) {
      state.screen = res.json.screen || '';
      state.screenMeta = { rows: res.json.rows, cols: res.json.cols };
      state.screenError = null;
    } else {
      state.screen = '';
      state.screenError = (res.json && res.json.error) || ('HTTP ' + res.status);
    }
  } catch (e) {
    state.screen = '';
    state.screenError = e.message;
  }
}

async function fetchAllScreens(coords) {
  const results = await Promise.all(state.terminals.map(async (t) => {
    try {
      const res = await getScreen(coords, Number(t.id), false);
      if (res.json && res.json.ok) return [t.id, { screen: res.json.screen || '' }];
      return [t.id, { error: (res.json && res.json.error) || ('HTTP ' + res.status) }];
    } catch (e) {
      return [t.id, { error: e.message }];
    }
  }));
  state.gridScreens = new Map(results);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function dims() {
  return {
    cols: Math.max(40, process.stdout.columns || 80),
    rows: Math.max(10, process.stdout.rows || 24)
  };
}

function render() {
  const { cols, rows } = dims();
  const lines = [];

  // Title bar
  const title = ' CCBOT SSH VIEW ' + ANSI.fgRed + '[READ-ONLY]' + ANSI.reset;
  const status = state.connected
    ? ANSI.fgGreen + '● live' + ANSI.reset + '  ' + ANSI.dim + '127.0.0.1:' + (state.coords ? state.coords.port : '?') + ANSI.reset
    : ANSI.fgRed + '○ waiting for app…' + ANSI.reset;
  lines.push(ANSI.bold + fit('', 0) + title + '   ' + status);
  lines.push(ANSI.fgGray + '─'.repeat(cols) + ANSI.reset);

  if (!state.connected) {
    renderDisconnected(lines, cols, rows);
  } else if (state.mode === 'grid') {
    renderGrid(lines, cols, rows);
  } else {
    renderSingle(lines, cols, rows);
  }

  // Footer help
  while (lines.length < rows - 1) lines.push('');
  const help = state.mode === 'grid'
    ? ' g single · ↑↓/jk & 1-9 select · r refresh · q quit'
    : ' ↑↓/jk & 1-9 select · ←→ cycle · g grid · s scrollback · r refresh · q quit';
  lines[rows - 1] = ANSI.fgGray + fit(help, cols) + ANSI.reset;

  process.stdout.write(ANSI.home + lines.slice(0, rows).map((l) => l + ESC + 'K').join('\n'));
}

function renderDisconnected(lines, cols, rows) {
  const msg = [
    '',
    '   The Auto-Injector app / Control API is not reachable.',
    '',
    '   ' + ANSI.dim + (state.lastError || 'unknown error') + ANSI.reset,
    '',
    '   Retrying every ' + (REFRESH_MS / 1000) + 's… (start the app to connect)',
    '',
    '   Discovery: ~/.config/ccbot/session.json  or  CCBOT_PORT/CCBOT_TOKEN env.'
  ];
  msg.forEach((m) => lines.push(m));
}

function renderSingle(lines, cols, rows) {
  const SIDEBAR = Math.min(34, Math.max(24, Math.floor(cols * 0.3)));
  const MAIN = cols - SIDEBAR - 1;
  const bodyRows = rows - 4; // minus title(2) and footer(1) and header row below

  // Build sidebar cell lines
  const side = [];
  side.push(ANSI.bold + fit(' TERMINALS (' + state.terminals.length + ')', SIDEBAR) + ANSI.reset);
  state.terminals.forEach((t, i) => {
    const sel = i === state.selectedIndex;
    const idLabel = (Number(t.id) === MANAGER_ID ? '999*' : String(t.id)).padEnd(4);
    const name = fit(t.title || ('Terminal ' + t.id), SIDEBAR - 4 - 7 - 2);
    // runtimeBadge carries ANSI, so fit() the plain part separately then append.
    const plain = ' ' + idLabel + name + ' ';
    const line = fit(plain, SIDEBAR - 6) + runtimeBadge(t.runtime);
    side.push(sel ? ANSI.inverse + ANSI.fgCyan + fit(' ' + idLabel + name, SIDEBAR) + ANSI.reset
                  : line);
  });

  // Main pane header + screen
  const term = selectedTerminal();
  const headerTxt = term
    ? ' #' + term.id + '  ' + (term.title || '') + '  [' + (term.runtime || '?') + ']'
        + (term.status ? '  ' + term.status : '')
        + (state.scrollback ? '  (scrollback)' : '')
    : ' (no terminal)';
  const main = [];
  main.push(ANSI.bold + ANSI.fgCyan + fit(headerTxt, MAIN) + ANSI.reset);

  if (state.screenError) {
    main.push(ANSI.fgRed + fit('  screen unavailable: ' + state.screenError, MAIN) + ANSI.reset);
  } else {
    const screenLines = state.screen.split('\n');
    // Show the tail so the newest output is visible.
    const visible = screenLines.slice(Math.max(0, screenLines.length - (bodyRows - 1)));
    visible.forEach((l) => main.push(fit(l, MAIN)));
  }

  // Compose rows
  for (let i = 0; i < bodyRows; i++) {
    const s = side[i] !== undefined ? side[i] : fit('', SIDEBAR);
    const m = main[i] !== undefined ? main[i] : fit('', MAIN);
    // Sidebar cells already padded to SIDEBAR (or contain ANSI at full width).
    lines.push(padVisible(s, SIDEBAR) + ANSI.fgGray + '│' + ANSI.reset + m);
  }
}

// Ensure a (possibly ANSI-containing) sidebar cell occupies SIDEBAR columns.
// Our sidebar builders already fit() the plain text to width before adding
// ANSI, so this is mostly a passthrough; for safety, pad rows that are clearly
// short of the target visible width.
function padVisible(s, width) {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  if (visible < width) return s + ' '.repeat(width - visible);
  return s;
}

function renderGrid(lines, cols, rows) {
  const bodyRows = rows - 3; // title(2) + footer(1)
  const n = state.terminals.length;
  const ncols = cols >= 120 ? 3 : (cols >= 80 ? 2 : 1);
  const nrows = Math.max(1, Math.ceil(n / ncols));
  const cellW = Math.floor((cols - (ncols - 1)) / ncols);
  const cellH = Math.max(3, Math.floor(bodyRows / nrows));

  // Precompute each cell's text lines.
  const cells = state.terminals.map((t, i) => {
    const sel = i === state.selectedIndex;
    const data = state.gridScreens.get(t.id);
    const header = (sel ? ANSI.inverse : ANSI.bold)
      + fit(' #' + t.id + ' ' + (t.title || '') + ' [' + (t.runtime || '?') + ']', cellW)
      + ANSI.reset;
    const contentLines = [];
    if (!data) contentLines.push(ANSI.dim + fit('  …', cellW) + ANSI.reset);
    else if (data.error) contentLines.push(ANSI.fgRed + fit('  ' + data.error, cellW) + ANSI.reset);
    else {
      const sl = (data.screen || '').split('\n');
      const tail = sl.slice(Math.max(0, sl.length - (cellH - 1)));
      tail.forEach((l) => contentLines.push(fit(l, cellW)));
    }
    const cellLines = [header].concat(contentLines);
    while (cellLines.length < cellH) cellLines.push(fit('', cellW));
    return cellLines.slice(0, cellH);
  });

  for (let gr = 0; gr < nrows; gr++) {
    for (let cr = 0; cr < cellH; cr++) {
      let rowStr = '';
      for (let gc = 0; gc < ncols; gc++) {
        const idx = gr * ncols + gc;
        const cell = cells[idx];
        const cellLine = cell ? cell[cr] : fit('', cellW);
        rowStr += cellLine;
        if (gc < ncols - 1) rowStr += ANSI.fgGray + '│' + ANSI.reset;
      }
      lines.push(rowStr);
    }
    if (gr < nrows - 1) lines.push(ANSI.fgGray + '─'.repeat(cols) + ANSI.reset);
  }
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------
function moveSelection(delta) {
  if (!state.terminals.length) return;
  state.selectedIndex = (state.selectedIndex + delta + state.terminals.length) % state.terminals.length;
  render();
  // Fetch the newly selected screen right away for responsiveness.
  if (state.coords && state.mode === 'single') {
    fetchSelectedScreen(state.coords).then(render).catch(() => {});
  }
}

function jumpTo(n) {
  if (n >= 1 && n <= state.terminals.length) {
    state.selectedIndex = n - 1;
    render();
    if (state.coords && state.mode === 'single') {
      fetchSelectedScreen(state.coords).then(render).catch(() => {});
    }
  }
}

function setupInput() {
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('keypress', (str, key) => {
    if (!key) return;
    if ((key.ctrl && key.name === 'c') || key.name === 'q') return cleanupExit();
    switch (key.name) {
      case 'up': case 'k': moveSelection(-1); break;
      case 'down': case 'j': moveSelection(1); break;
      case 'left': moveSelection(-1); break;
      case 'right': moveSelection(1); break;
      case 'g':
        state.mode = state.mode === 'grid' ? 'single' : 'grid';
        if (state.coords) refresh();
        else render();
        break;
      case 's':
        state.scrollback = !state.scrollback;
        if (state.coords) fetchSelectedScreen(state.coords).then(render).catch(() => {});
        break;
      case 'r':
        refresh();
        break;
      default:
        if (str && /^[1-9]$/.test(str)) jumpTo(Number(str));
        break;
    }
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let refreshTimer = null;
let exited = false;

function cleanupExit() {
  if (exited) return;
  exited = true;
  if (refreshTimer) clearInterval(refreshTimer);
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch (_) {}
  process.stdout.write(ANSI.showCursor + ANSI.mainScreen);
  process.stdout.write('ssh-view closed.\n');
  process.exit(0);
}

function main() {
  process.stdout.write(ANSI.altScreen + ANSI.hideCursor + ANSI.clear);
  setupInput();
  process.stdout.on('resize', () => render());
  process.on('SIGINT', cleanupExit);
  process.on('SIGTERM', cleanupExit);
  // Never let an unexpected error kill the mirror; log to the restored screen.
  process.on('uncaughtException', (e) => {
    try { process.stdout.write(ANSI.showCursor + ANSI.mainScreen); } catch (_) {}
    process.stderr.write('ssh-view error: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
  });

  refresh();
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

main();
