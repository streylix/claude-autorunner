'use strict';

/**
 * session-file - Advertise the running app's Control API coordinates on disk.
 *
 * The Control API (HookServer) binds 127.0.0.1 on an OS-assigned port and is
 * authed by a per-app-session token. Both live only in the app's memory and in
 * each spawned PTY's env (CCBOT_PORT / CCBOT_TOKEN). A user who SSHes into a
 * headless machine running the app gets a fresh login shell that does NOT
 * inherit those vars, so read-only tools like `npm run ssh-view` have no way to
 * find the port/token.
 *
 * On startup the app writes a small session file containing the port + token so
 * a same-user local process can discover the loopback API. The file is created
 * 0600 in a 0700 dir and removed on clean shutdown. The token is a loopback-only
 * credential: it must never be sent anywhere but 127.0.0.1.
 *
 * Pure Node built-ins (fs/os/path); no Electron, so it is unit-testable and can
 * also be required by the ssh-view CLI to resolve the same canonical path.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Canonical directory for the session file: $XDG_CONFIG_HOME/ccbot, falling back
// to ~/.config/ccbot. We deliberately use the CONFIG dir (stable per-user path)
// rather than $XDG_RUNTIME_DIR, whose value can differ between the app's session
// and a later SSH login session for the same user — ssh-view must resolve the
// exact same path the app wrote.
function sessionDir() {
  const base = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(base, 'ccbot');
}

function sessionFilePath() {
  return path.join(sessionDir(), 'session.json');
}

/**
 * Write the session file with tight perms. Best-effort: never throws (a failure
 * to advertise the API must not break app startup). Returns the path on success
 * or null on failure.
 * @param {{port:number, token:string}} coords
 */
function writeSessionFile(coords) {
  try {
    if (!coords || !coords.port || !coords.token) return null;
    const dir = sessionDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Tighten perms even if the dir already existed with looser bits.
    try { fs.chmodSync(dir, 0o700); } catch (_) { /* best effort */ }

    const payload = {
      version: 1,
      // 127.0.0.1 is hard-coded: the Control API is loopback-only and the token
      // must never travel off-host.
      host: '127.0.0.1',
      port: Number(coords.port),
      token: String(coords.token),
      apiBase: `http://127.0.0.1:${Number(coords.port)}`,
      pid: process.pid,
      startedAt: new Date().toISOString()
    };
    const file = sessionFilePath();
    // Create with 0600 from the outset (mode on writeFileSync only applies when
    // the file is created), then chmod to enforce it on an existing file too.
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
    return file;
  } catch (_) {
    return null;
  }
}

/** Remove the session file on shutdown. Best-effort; never throws. */
function removeSessionFile() {
  try {
    fs.unlinkSync(sessionFilePath());
  } catch (_) {
    /* already gone / never written — fine */
  }
}

/**
 * Read + parse the session file. Returns the parsed object or null if missing/
 * unreadable/invalid. Used by the ssh-view CLI for API discovery.
 */
function readSessionFile() {
  try {
    const raw = fs.readFileSync(sessionFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.port && parsed.token) return parsed;
    return null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  sessionDir,
  sessionFilePath,
  writeSessionFile,
  removeSessionFile,
  readSessionFile
};
