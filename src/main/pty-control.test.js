'use strict';

// Unit tests for pty-control.js — raw-key and Claude-lifecycle control over a
// PTY, with P1's runtime signal as the safety guard. Pure node (fake ptys).
// Run: node --test src/main/pty-control.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { translateKeys, handlePtyControl } = require('./pty-control');

function fakePty(pid = 1234) {
  const writes = [];
  return { pid, writes, write: (d) => writes.push(d) };
}

// deps factory: a single terminal `id` backed by `pty`, with a runtime that can
// be a fixed value or a queue of values (for restart's before/after check).
function makeDeps({ id = 1, pty, runtime = 'shell' } = {}) {
  const runtimes = Array.isArray(runtime) ? runtime.slice() : null;
  return {
    ptyFor: (t) => (Number(t) === id ? pty : undefined),
    runtimeFor: () => (runtimes ? (runtimes.length > 1 ? runtimes.shift() : runtimes[0]) : runtime),
    sleep: () => Promise.resolve(), // no real delay in tests
  };
}

// ---- translateKeys -------------------------------------------------------

test('translateKeys maps named control keys to bytes', () => {
  assert.strictEqual(translateKeys(['Ctrl+C']), '\x03');
  assert.strictEqual(translateKeys(['Esc']), '\x1b');
  assert.strictEqual(translateKeys(['Enter']), '\r');
  assert.strictEqual(translateKeys('Ctrl+C'), '\x03'); // bare string accepted
  assert.strictEqual(translateKeys(['ctrl+c']), '\x03'); // case-insensitive
});

test('translateKeys passes unknown tokens through as literal text and concatenates', () => {
  assert.strictEqual(translateKeys(['2', 'Enter']), '2\r'); // answer menu option 2
  assert.strictEqual(translateKeys(['hello']), 'hello');
  assert.strictEqual(translateKeys(['Esc', 'Esc']), '\x1b\x1b');
});

// ---- terminal-keys -------------------------------------------------------

test('terminal-keys writes translated bytes to the pty', async () => {
  const pty = fakePty();
  const r = await handlePtyControl('terminal-keys', { terminalId: 1, keys: ['Ctrl+C'] }, makeDeps({ pty }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(pty.writes.join(''), '\x03');
});

test('terminal-keys fails cleanly for a missing terminal', async () => {
  const r = await handlePtyControl('terminal-keys', { terminalId: 9, keys: ['Esc'] }, makeDeps({ pty: fakePty() }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not found/);
});

// ---- terminal/claude start ----------------------------------------------

test('claude start on a bare shell writes "claude\\r"', async () => {
  const pty = fakePty();
  const r = await handlePtyControl('terminal-claude', { terminalId: 1, action: 'start' }, makeDeps({ pty, runtime: 'shell' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(pty.writes.join(''), 'claude\r');
});

test('claude start refuses when claude is already running (no write)', async () => {
  const pty = fakePty();
  const r = await handlePtyControl('terminal-claude', { terminalId: 1, action: 'start' }, makeDeps({ pty, runtime: 'claude' }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /already running/);
  assert.strictEqual(pty.writes.length, 0);
});

test('claude start refuses when runtime is unknown (no write — avoids shell leak)', async () => {
  const pty = fakePty();
  const r = await handlePtyControl('terminal-claude', { terminalId: 1, action: 'start' }, makeDeps({ pty, runtime: 'unknown' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(pty.writes.length, 0);
});

test('claude start accepts sanitized extra args, strips newlines', async () => {
  const pty = fakePty();
  const r = await handlePtyControl('terminal-claude',
    { terminalId: 1, action: 'start', args: '--model opus\nrm -rf /' }, makeDeps({ pty, runtime: 'shell' }));
  assert.strictEqual(r.ok, true);
  const sent = pty.writes.join('');
  assert.ok(!sent.includes('\n'), 'no embedded newline reaches the shell');
  assert.match(sent, /^claude --model opus/);
  assert.ok(sent.endsWith('\r'));
});

// ---- terminal/claude resume ---------------------------------------------

test('claude resume without sessionId uses --continue', async () => {
  const pty = fakePty();
  const r = await handlePtyControl('terminal-claude', { terminalId: 1, action: 'resume' }, makeDeps({ pty, runtime: 'shell' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(pty.writes.join(''), 'claude --continue\r');
});

test('claude resume with a valid sessionId uses --resume <id>', async () => {
  const pty = fakePty();
  const id = 'a1b2c3d4-1111-2222-3333-444455556666';
  const r = await handlePtyControl('terminal-claude', { terminalId: 1, action: 'resume', sessionId: id }, makeDeps({ pty, runtime: 'shell' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(pty.writes.join(''), `claude --resume ${id}\r`);
});

test('claude resume rejects an unsafe sessionId (no write)', async () => {
  const pty = fakePty();
  const r = await handlePtyControl('terminal-claude', { terminalId: 1, action: 'resume', sessionId: 'x; rm -rf /' }, makeDeps({ pty, runtime: 'shell' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(pty.writes.length, 0);
});

// ---- terminal/claude restart --------------------------------------------

test('claude restart interrupts then relaunches once the shell returns', async () => {
  const pty = fakePty();
  // runtime is claude before, shell after the interrupt+sleep
  const r = await handlePtyControl('terminal-claude', { terminalId: 1, action: 'restart' }, makeDeps({ pty, runtime: ['claude', 'shell'] }));
  assert.strictEqual(r.ok, true);
  const sent = pty.writes.join('');
  assert.ok(sent.includes('\x03'), 'sends Ctrl-C to interrupt');
  assert.ok(sent.endsWith('claude\r'), 'relaunches claude after the shell returns');
});

test('claude restart on a bare shell just starts claude', async () => {
  const pty = fakePty();
  const r = await handlePtyControl('terminal-claude', { terminalId: 1, action: 'restart' }, makeDeps({ pty, runtime: 'shell' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(pty.writes.join(''), 'claude\r');
});

// ---- misc ----------------------------------------------------------------

test('unknown claude action fails cleanly', async () => {
  const r = await handlePtyControl('terminal-claude', { terminalId: 1, action: 'frobnicate' }, makeDeps({ pty: fakePty() }));
  assert.strictEqual(r.ok, false);
});

test('unknown control action fails cleanly', async () => {
  const r = await handlePtyControl('nope', { terminalId: 1 }, makeDeps({ pty: fakePty() }));
  assert.strictEqual(r.ok, false);
});
