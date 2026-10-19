'use strict';

// Regression tests for the single-instance lock. Run:
//   node --test src/singleInstance.test.js
//
// ROOT CAUSE this guards: a second `node src/index.js` (started by hand next to
// the systemd unit) logs into Discord with the SAME bot token. Discord accepts
// it and delivers every messageCreate to BOTH sessions, so one user message
// became two downloads + two forwards to the manager.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const singleInstance = require('./singleInstance');

function tmpLock(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccbot-lock-')), name);
}

test('an uncontended lock is acquired', () => {
  const p = tmpLock('bridge.pid');
  const held = singleInstance.acquire(p);
  assert.equal(held.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).pid, process.pid);
  held.release();
  assert.equal(fs.existsSync(p), false, 'release removes the lock file');
});

test('a lock held by a LIVE process is refused (the duplicate-bridge case)', () => {
  const p = tmpLock('bridge.pid');
  // A live pid that is not us: our own parent-independent stand-in is this
  // process itself, written under a different identity.
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const held = singleInstance.acquire(p, { self: -1 }); // pretend we're a different process
  assert.equal(held.ok, false);
  assert.equal(held.pid, process.pid);
  assert.equal(fs.existsSync(p), true, 'the incumbent lock is left untouched');
});

test('a STALE lock from a dead process is taken over', () => {
  const p = tmpLock('bridge.pid');
  // pid 2^22 is above the default pid_max on Linux — guaranteed not running.
  fs.writeFileSync(p, JSON.stringify({ pid: 4194304, startedAt: Date.now() }));
  const held = singleInstance.acquire(p);
  assert.equal(held.ok, true, 'a dead holder must not wedge the service');
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).pid, process.pid);
  held.release();
});

test('a corrupt lock file never wedges startup', () => {
  const p = tmpLock('bridge.pid');
  fs.writeFileSync(p, 'not json at all');
  const held = singleInstance.acquire(p);
  assert.equal(held.ok, true);
  held.release();
});

test('release is idempotent and never throws', () => {
  const p = tmpLock('bridge.pid');
  const held = singleInstance.acquire(p);
  held.release();
  held.release();
  assert.equal(fs.existsSync(p), false);
});

test('a lock file for someone ELSE\'s pid is not deleted on release', () => {
  const p = tmpLock('bridge.pid');
  const held = singleInstance.acquire(p);
  fs.writeFileSync(p, JSON.stringify({ pid: 4194304, startedAt: Date.now() }));
  held.release(); // must not clobber a lock we no longer own
  assert.equal(fs.existsSync(p), true);
});
