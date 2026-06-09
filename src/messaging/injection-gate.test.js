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

test('P4: blocks injection into a bare shell, regardless of priority', () => {
  for (const messageType of ['normal', 'important', 'urgent']) {
    const r = evaluateInjectionGate({ ...CLEAR, runtime: 'shell', status: '...', messageType });
    assert.strictEqual(r.allowed, false, `should block ${messageType} into a shell`);
    assert.match(r.reason, /bare shell/);
  }
});

test('does not block on runtime "claude" or "unknown" (fail-open when undetermined)', () => {
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, runtime: 'claude' }).allowed, true);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, runtime: 'unknown' }).allowed, true);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, runtime: undefined }).allowed, true);
});

test('status gate: normal waits for running/prompted; urgent/important bypass', () => {
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, status: 'running', messageType: 'normal' }).allowed, false);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, status: 'prompted', messageType: 'normal' }).allowed, false);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, status: 'running', messageType: 'urgent' }).allowed, true);
  assert.strictEqual(evaluateInjectionGate({ ...CLEAR, status: 'prompted', messageType: 'important' }).allowed, true);
});

test('shell guard is NOT bypassed by urgent (a prompt must never hit bash)', () => {
  // status running would be bypassed by urgent, but the shell guard still wins
  const r = evaluateInjectionGate({ ...CLEAR, runtime: 'shell', status: 'running', messageType: 'urgent' });
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /bare shell/);
});

test('precedence: usage-limit beats the shell guard', () => {
  const r = evaluateInjectionGate({ ...CLEAR, usageLimitWaiting: true, runtime: 'shell' });
  assert.match(r.reason, /usage limit/);
});
