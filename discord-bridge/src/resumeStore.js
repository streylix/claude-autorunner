'use strict';

// Remembers, per Discord user, the LAST key they successfully /link'd with, so
// they can /resume (re-link + rejoin voice) without re-pasting the long key —
// painful on mobile.
//
// What's stored: { userId -> { key, tag, port, managerId, linkedAt } }. The
// `key` is the same paste-able link key (base64url of { port, linkToken }) — it
// carries NO control token (see linkVault.js), is revocable, and is only useful
// with local machine access. We still write the file 0600.
//
// Location: $XDG_RUNTIME_DIR/ccbot-bridge/resume.json by default. That survives
// a BOT restart (systemd --user restart doesn't clear /run/user) but is wiped on
// machine reboot — which is fine, because the vault it points at is wiped then
// too, so a resume would correctly fail with "run /link with a fresh key".

const fs = require('fs');
const path = require('path');
const log = require('./log');

function defaultStorePath() {
  const base = process.env.XDG_RUNTIME_DIR
    || `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}`;
  return path.join(base, 'ccbot-bridge', 'resume.json');
}

function storePath() {
  return process.env.CCBOT_RESUME_STORE || defaultStorePath();
}

function _readAll() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8')) || {};
  } catch (_) {
    return {}; // missing/corrupt → start empty
  }
}

function _writeAll(map) {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(map), { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (_) {}
}

// Record (or refresh) the session a Discord user last linked with.
function remember(userId, key, meta = {}) {
  if (!userId || !key) return;
  try {
    const map = _readAll();
    map[String(userId)] = {
      key: String(key),
      tag: meta.tag || null,
      port: meta.port || null,
      managerId: meta.managerId || null,
      linkedAt: Date.now(),
    };
    _writeAll(map);
  } catch (err) {
    log.warn('resume store write failed:', err.message);
  }
}

// Return the stored session for a user, or null.
function recall(userId) {
  if (!userId) return null;
  const map = _readAll();
  return map[String(userId)] || null;
}

// Drop a user's stored session.
function forget(userId) {
  try {
    const map = _readAll();
    if (map[String(userId)]) {
      delete map[String(userId)];
      _writeAll(map);
    }
  } catch (err) {
    log.warn('resume store delete failed:', err.message);
  }
}

// The most recently linked session across all users (with its userId), or null.
// Used by the startup auto-resume so a service restart re-links + rejoins on its
// own instead of stranding the bridge IDLE until someone types /resume.
function latest() {
  const map = _readAll();
  let best = null;
  for (const [userId, entry] of Object.entries(map)) {
    if (!entry || !entry.key) continue;
    if (!best || (entry.linkedAt || 0) > (best.linkedAt || 0)) best = { userId, ...entry };
  }
  return best;
}

module.exports = { remember, recall, forget, latest, storePath };
