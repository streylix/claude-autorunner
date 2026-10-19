'use strict';

// Single-instance lock — the ROOT-CAUSE fix for duplicate message handling.
//
// Discord happily accepts several gateway sessions on one bot token and fans
// EVERY event out to all of them. So a stray `node src/index.js` started next to
// the systemd unit (easy to do while debugging, and easy to forget about — its
// stdout goes to a file or a PTY, so it is invisible in `journalctl`) makes the
// bot handle every user message twice: two attachment downloads, two forwards to
// the manager, and two posts of every outbox descriptor.
//
// So: whoever starts first owns the token. A second bridge refuses to run.
//
// The lock is a pid file in the shared runtime dir. It is advisory but robust in
// the ways that matter here: a dead holder is taken over (a SIGKILLed bridge must
// never wedge the service), a corrupt file is taken over, and release only
// removes the file if we still own it.

const fs = require('fs');
const path = require('path');

// Is this pid a live process we can't signal-check away? Treat EPERM as alive.
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err && err.code === 'EPERM'; }
}

function readLock(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
  catch (_) { return null; } // missing or corrupt → not a valid holder
}

// Try to take the lock. Returns { ok: true, release() } or { ok: false, pid, startedAt }.
// opts.self overrides our pid (tests only).
function acquire(lockPath, opts = {}) {
  const self = opts.self === undefined ? process.pid : opts.self;
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch (_) {}

  const held = readLock(lockPath);
  if (held && held.pid !== self && isAlive(held.pid)) {
    return { ok: false, pid: held.pid, startedAt: held.startedAt, release() {} };
  }

  // Write atomically (tmp + rename) so a half-written file can never be read.
  const tmp = `${lockPath}.${self}.tmp`;
  const body = JSON.stringify({ pid: self, startedAt: Date.now() });
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, lockPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    // Can't write the lock (read-only dir?) — never block the bridge over it.
    return { ok: true, degraded: err.message, release() {} };
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const cur = readLock(lockPath);
    if (cur && cur.pid !== self) return; // someone else owns it now — leave it
    try { fs.unlinkSync(lockPath); } catch (_) {}
  };
  return { ok: true, release };
}

module.exports = { acquire, isAlive };
