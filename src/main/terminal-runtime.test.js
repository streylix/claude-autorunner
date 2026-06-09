'use strict';

// Unit tests for terminal-runtime.js — runtime detection from a fake /proc tree.
// Pure node, no Electron / node-pty needed. Run: node --test src/main/terminal-runtime.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectRuntime, liveCwd, enrichSnapshot } = require('./terminal-runtime');

// Build a fake /proc node: <root>/<pid>/comm and <root>/<pid>/task/<pid>/children,
// plus an optional <root>/<pid>/cwd symlink. Mirrors the real /proc layout the
// module reads.
function writeProc(root, pid, { comm, children = [], cwd } = {}) {
  const base = path.join(root, String(pid));
  fs.mkdirSync(path.join(base, 'task', String(pid)), { recursive: true });
  fs.writeFileSync(path.join(base, 'comm'), `${comm}\n`);
  // Real kernel format: space-separated pids with a trailing space.
  fs.writeFileSync(
    path.join(base, 'task', String(pid), 'children'),
    children.length ? `${children.join(' ')} ` : ''
  );
  if (cwd) fs.symlinkSync(cwd, path.join(base, 'cwd')); // dangling symlink is fine
}

function tmpProc() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ccbot-proc-'));
}

test('detectRuntime: bash with a direct claude child => claude', () => {
  const root = tmpProc();
  writeProc(root, 100, { comm: 'bash', children: [101] });
  writeProc(root, 101, { comm: 'claude' });
  assert.strictEqual(detectRuntime(100, { procRoot: root }), 'claude');
});

test('detectRuntime: bash with only a non-claude child => shell', () => {
  const root = tmpProc();
  writeProc(root, 200, { comm: 'bash', children: [201] });
  writeProc(root, 201, { comm: 'npm' });
  assert.strictEqual(detectRuntime(200, { procRoot: root }), 'shell');
});

test('detectRuntime: claude as a grandchild => claude', () => {
  const root = tmpProc();
  writeProc(root, 300, { comm: 'bash', children: [301] });
  writeProc(root, 301, { comm: 'bash', children: [302] });
  writeProc(root, 302, { comm: 'claude' });
  assert.strictEqual(detectRuntime(300, { procRoot: root }), 'claude');
});

test('detectRuntime: root process itself is claude => claude', () => {
  const root = tmpProc();
  writeProc(root, 400, { comm: 'claude' });
  assert.strictEqual(detectRuntime(400, { procRoot: root }), 'claude');
});

test('detectRuntime: nonexistent pid => unknown', () => {
  const root = tmpProc();
  assert.strictEqual(detectRuntime(999999, { procRoot: root }), 'unknown');
});

test('detectRuntime: null/undefined pid => unknown', () => {
  const root = tmpProc();
  assert.strictEqual(detectRuntime(null, { procRoot: root }), 'unknown');
  assert.strictEqual(detectRuntime(undefined, { procRoot: root }), 'unknown');
});

test('detectRuntime: does not loop forever on a cyclic tree', () => {
  const root = tmpProc();
  writeProc(root, 500, { comm: 'bash', children: [501] });
  writeProc(root, 501, { comm: 'bash', children: [500] }); // cycle back to parent
  assert.strictEqual(detectRuntime(500, { procRoot: root }), 'shell');
});

test('liveCwd: returns the symlink target, null when missing', () => {
  const root = tmpProc();
  writeProc(root, 600, { comm: 'bash', cwd: '/live/work/dir' });
  writeProc(root, 601, { comm: 'bash' }); // no cwd symlink
  assert.strictEqual(liveCwd(600, { procRoot: root }), '/live/work/dir');
  assert.strictEqual(liveCwd(601, { procRoot: root }), null);
  assert.strictEqual(liveCwd(null, { procRoot: root }), null);
});

test('enrichSnapshot: adds runtime, overrides directory with live cwd, is pure', () => {
  const root = tmpProc();
  writeProc(root, 100, { comm: 'bash', children: [101], cwd: '/live/dir' });
  writeProc(root, 101, { comm: 'claude' });
  writeProc(root, 200, { comm: 'bash' }); // shell, no cwd symlink

  const snapshot = {
    activeTerminalId: 1,
    foo: 'bar',
    terminals: [
      { id: 1, status: '...', directory: '/old/dir', title: 'T1' },
      { id: 2, status: 'running', directory: '/keep/me', title: 'T2' },
      { id: 3, status: '...', directory: '/no/pty', title: 'T3' },
    ],
  };
  const pidFor = (id) => ({ 1: 100, 2: 200 }[id]); // id 3 has no pty

  const out = enrichSnapshot(snapshot, pidFor, { procRoot: root });

  // claude terminal: runtime claude, directory overridden by live cwd
  assert.strictEqual(out.terminals[0].runtime, 'claude');
  assert.strictEqual(out.terminals[0].directory, '/live/dir');
  // shell terminal: runtime shell, directory preserved (no live cwd available)
  assert.strictEqual(out.terminals[1].runtime, 'shell');
  assert.strictEqual(out.terminals[1].directory, '/keep/me');
  // no pty: runtime unknown, directory preserved
  assert.strictEqual(out.terminals[2].runtime, 'unknown');
  assert.strictEqual(out.terminals[2].directory, '/no/pty');
  // other top-level fields preserved
  assert.strictEqual(out.foo, 'bar');
  assert.strictEqual(out.activeTerminalId, 1);

  // input is not mutated
  assert.strictEqual(snapshot.terminals[0].runtime, undefined);
  assert.strictEqual(snapshot.terminals[0].directory, '/old/dir');
  assert.notStrictEqual(out, snapshot);
  assert.notStrictEqual(out.terminals, snapshot.terminals);
});

test('enrichSnapshot: tolerates a null/empty snapshot', () => {
  assert.strictEqual(enrichSnapshot(null, () => undefined), null);
  const noTerms = { terminals: undefined };
  assert.strictEqual(enrichSnapshot(noTerms, () => undefined), noTerms);
});
