'use strict';

// Unit tests for injection-gate.js — the pure policy behind canInjectToTerminal,
// including the P4 bare-shell guard. Run: node --test src/messaging/injection-gate.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateInjectionGate } = require('./injection-gate');

const CLEAR = {
  usageLimitWaiting: false,
  timerRunning: false,
  injectionPaused: false,
  terminalId: 1,
  status: '...',
  runtime: 'claude',
  messageType: 'normal',
};

test('allows injection into an idle Claude terminal', () => {
  assert.deepStrictEqual(evaluateInjectionGate(CLEAR), { allowed: true, reason: 'ok' });
});

test('blocks on usage limit, timer, and paused (in that precedence)', () => {
  assert.match(evaluateInjectionGate({ ...CLEAR, usageLimitWaiting: true }).reason, /usage limit/);
  assert.match(evaluateInjectionGate({ ...CLEAR, timerRunning: true }).reason, /timer/);
  assert.match(evaluateInjectionGate({ ...CLEAR, injectionPaused: true }).reason, /paused/);
});

test('blocks when there is no target terminal', () => {
  const r = evaluateInjectionGate({ ...CLEAR, terminalId: null });
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /no target terminal/);
});

test('P4: blocks NORMAL injection into a bare shell; urgent is now allowed', () => {
  const blocked = evaluateInjectionGate({ ...CLEAR, runtime: 'shell', status: '...', messageType: 'normal' });
  assert.strictEqual(blocked.allowed, false, 'should block normal into a shell');
  assert.match(blocked.reason, /bare shell/);

  const allowed = evaluateInjectionGate({ ...CLEAR, runtime: 'shell', status: '...', messageType: 'urgent' });
  assert.strictEqual(allowed.allowed, true, 'urgent must send into a shell (e.g. SSH-to-remote-Claude)');
});

test('does not block on runtime "claude" or "unknown" (fail-open when undetermined)', () => {
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, runtime: 'claude' }).allowed, true);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, runtime: 'unknown' }).allowed, true);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, runtime: undefined }).allowed, true);
});

test('status gate: normal blocks only on prompted (running no longer gates); urgent bypasses', () => {
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, status: 'running', messageType: 'normal' }).allowed, true);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, status: 'prompted', messageType: 'normal' }).allowed, false);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, status: 'running', messageType: 'urgent' }).allowed, true);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, status: 'prompted', messageType: 'urgent' }).allowed, true);
});

test('legacy "important" gets no bypass: it behaves like normal at the gate', () => {
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, status: 'prompted', messageType: 'important' }).allowed, false);
});

test('shell guard IS now bypassed by urgent (urgent sends regardless of any condition)', () => {
  const r = evaluateInjectionGate({ ...CLEAR, runtime: 'shell', status: 'running', messageType: 'urgent' });
  assert.strictEqual(r.allowed, true);
});

test('precedence: usage-limit beats the shell guard for NORMAL messages', () => {
  const r = evaluateInjectionGate({ ...CLEAR, usageLimitWaiting: true, runtime: 'shell' });
  assert.match(r.reason, /usage limit/);
});

test('urgent overrides usage-limit, timer, paused, shell, and prompted all at once', () => {
  const r = evaluateInjectionGate({
    usageLimitWaiting: true,
    timerRunning: true,
    injectionPaused: true,
    terminalId: 7,
    status: 'prompted',
    runtime: 'shell',
    messageType: 'urgent',
  });
  assert.deepStrictEqual(r, { allowed: true, reason: 'ok' });
});

test('urgent bypasses each individual gate', () => {
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, usageLimitWaiting: true, messageType: 'urgent' }).allowed, true);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, timerRunning: true, messageType: 'urgent' }).allowed, true);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, injectionPaused: true, messageType: 'urgent' }).allowed, true);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, runtime: 'shell', messageType: 'urgent' }).allowed, true);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, status: 'prompted', messageType: 'urgent' }).allowed, true);
});

test('urgent is STILL blocked when there is no target terminal (the only hard block)', () => {
  const r = evaluateInjectionGate({ ...CLEAR, terminalId: null, messageType: 'urgent' });
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /no target terminal/);
});
