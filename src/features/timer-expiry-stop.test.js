'use strict';

// Regression tests for the timer-expiry interval leak: reaching 0 must STOP
// the 100ms tick (it previously ran forever, emitting display updates 10x/sec
// for the life of the process), while preserving the tuned resume semantics —
// the injection gate opens on expiry, and both the manual restart path
// (startTimer) and the usage-limit path (stopTimer + startCountdown) still
// work after an expiry.
// Run: node --test src/features/timer-expiry-stop.test.js

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

function makeTimer() {
  const events = [];
  const eventBus = { on() {}, off() {}, emit: (n) => events.push(n) };
  const appStateStore = { getState: () => undefined, setState() {} };
  return { tm: new TimerManager(eventBus, appStateStore), events };
}

/** Drive the timer to expiry without waiting: simulate a countdown at 0. */
async function expire(tm) {
  tm.timerRunning = true;
  tm.timerPaused = false;
  tm.timerExpired = false;
  tm.timerTotalSeconds = 0;
  tm.timerStartTime = Date.now();
  // Give it a live interval handle so we can observe it being cleared.
  tm.timerInterval = setInterval(() => {}, 100000);
  await tm.decrementTimer();
}

test('expiry stops the 100ms tick interval (no orphaned interval)', async () => {
  const { tm } = makeTimer();
  await expire(tm);

  assert.strictEqual(tm.timerExpired, true, 'timer marked expired');
  assert.strictEqual(tm.timerInterval, null, 'tick interval cleared on expiry');
  assert.strictEqual(tm.timerRunning, false, 'timer no longer running after expiry');
  assert.strictEqual(tm.isRunning(), false, 'injection gate input is open');
});

test('no glow interval exists anymore (classes it toggled had no CSS)', async () => {
  const { tm } = makeTimer();
  await expire(tm);
  assert.strictEqual(tm.glowingInterval, undefined, 'glow machinery removed');
  assert.strictEqual(typeof tm.startGlowingEffect, 'undefined', 'no glow starter');
});

test('expiry emits timer:expired exactly once', async () => {
  const { tm, events } = makeTimer();
  await expire(tm);
  // A second decrement tick (if any raced in) must not re-fire expiry.
  await tm.decrementTimer();
  assert.strictEqual(events.filter((e) => e === 'timer:expired').length, 1);
});

test('RESUME: startTimer works after an expiry (fresh countdown)', async () => {
  const { tm } = makeTimer();
  await expire(tm);

  tm.timerHours = 0;
  tm.timerMinutes = 0;
  tm.timerSeconds = 30;
  await tm.startTimer();

  assert.strictEqual(tm.timerRunning, true, 'restarted');
  assert.strictEqual(tm.timerExpired, false, 'expiry flag cleared on restart');
  assert.ok(tm.timerInterval, 'tick interval armed again');
  assert.strictEqual(tm.isRunning(), true, 'gate closes again during countdown');

  tm.stopTimer();
  assert.strictEqual(tm.timerInterval, null, 'stop clears the interval');
});

test('RESUME: usage-limit path (stopTimer then startCountdown) works after expiry', async () => {
  const { tm } = makeTimer();
  await expire(tm);

  // UsageLimitManager's release path: stop, then start a fresh cooldown.
  tm.stopTimer();
  tm.startCountdown(120);

  assert.strictEqual(tm.timerRunning, true, 'cooldown running');
  assert.strictEqual(tm.timerExpired, false, 'not expired');
  assert.strictEqual(tm.isRunning(), true, 'gate blocks during cooldown');
  assert.strictEqual(tm.timerTotalSeconds, 120, 'cooldown length applied');

  tm.stopTimer();
});

test('pause/resume still works on a live countdown (untouched semantics)', async () => {
  const { tm } = makeTimer();
  tm.timerHours = 0;
  tm.timerMinutes = 5;
  tm.timerSeconds = 0;
  await tm.startTimer();
  assert.strictEqual(tm.isRunning(), true);

  tm.pauseTimer();
  assert.strictEqual(tm.timerPaused, true);
  assert.strictEqual(tm.timerInterval, null, 'pause clears the interval');
  assert.strictEqual(tm.isRunning(), false);

  await tm.startTimer(); // resume
  assert.strictEqual(tm.timerPaused, false);
  assert.ok(tm.timerInterval, 'resume re-arms the interval');
  assert.strictEqual(tm.isRunning(), true);

  tm.stopTimer();
});

test('constructor does not touch localStorage (deferred to app:boot:complete)', () => {
  let touched = false;
  const orig = global.localStorage.getItem;
  global.localStorage.getItem = () => { touched = true; return null; };
  try {
    const handlers = {};
    const eventBus = {
      on: (n, fn) => { handlers[n] = fn; },
      off() {},
      emit() {},
    };
    const appStateStore = { getState: () => undefined, setState() {} };
    // eslint-disable-next-line no-new
    new TimerManager(eventBus, appStateStore);
    assert.strictEqual(touched, false, 'no localStorage read in the constructor');
    // The deferred restore is wired and runs on the boot-complete signal.
    assert.strictEqual(typeof handlers['app:boot:complete'], 'function');
    handlers['app:boot:complete']();
    assert.strictEqual(touched, true, 'restore runs on app:boot:complete');
  } finally {
    global.localStorage.getItem = orig;
  }
});
