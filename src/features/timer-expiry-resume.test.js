'use strict';

// Regression test for the manual auto-inject timer: when a countdown reaches 0,
// the injection gate must reopen so the queue drains. Same root cause as the
// usage-limit bug — TimerManager left timerRunning=true after expiry, so
// isRunning() stayed true and canInjectToTerminal kept blocking. The fix makes
// an expired timer report isRunning() === false.
// Run: node --test src/features/timer-expiry-resume.test.js
const { test } = require('node:test');
const assert = require('node:assert');

// TimerManager touches browser globals (DOM + localStorage); stub for node.
global.document = global.document || { getElementById: () => null };
global.localStorage = global.localStorage || {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};

const TimerManager = require('./TimerManager');
const { evaluateInjectionGate } = require('../messaging/injection-gate');

function makeTimer() {
  const events = [];
  const eventBus = { on() {}, emit: (n) => events.push(n) };
  const appStateStore = { getState: () => undefined, setState() {} };
  return { tm: new TimerManager(eventBus, appStateStore, null), events };
}

test('isRunning() is false once the timer has expired (even if timerRunning is still set)', () => {
  const { tm } = makeTimer();
  tm.timerRunning = true;
  tm.timerPaused = false;
  tm.timerExpired = true;
  assert.strictEqual(tm.isRunning(), false, 'expired timer must not report as running');

  tm.timerExpired = false;
  assert.strictEqual(tm.isRunning(), true, 'a live countdown still reports running');

  tm.timerPaused = true;
  assert.strictEqual(tm.isRunning(), false, 'a paused timer is not running');
});

test('REGRESSION: reaching 0 reopens the injection gate so the queue can drain', async () => {
  const { tm } = makeTimer();
  // Simulate a countdown that has just reached 0 (no real wait, no interval).
  tm.timerRunning = true;
  tm.timerPaused = false;
  tm.timerExpired = false;
  tm.timerTotalSeconds = 0;
  tm.timerStartTime = Date.now();

  await tm.decrementTimer(); // computes remaining=0 -> marks expired, emits timer:expired
  if (tm.glowingInterval) clearInterval(tm.glowingInterval); // expiry starts a glow loop; clean up

  assert.strictEqual(tm.timerExpired, true, 'timer marked expired at 0');
  assert.strictEqual(tm.isRunning(), false, 'gate input is now open');

  // The gate (what canInjectToTerminal passes) must now ALLOW injection.
  const gate = evaluateInjectionGate({
    usageLimitWaiting: false,
    timerRunning: tm.isRunning(),
    injectionPaused: false,
    terminalId: 1,
    status: '...',
    runtime: 'claude',
    messageType: 'normal',
  });
  assert.strictEqual(gate.allowed, true, 'queue can drain once the timer expires');
});
