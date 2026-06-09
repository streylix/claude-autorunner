'use strict';

// Regression test for the usage-limit auto-resume bug: when the cooldown timer
// reaches 0, pending messages must inject automatically WITHOUT a new enqueue.
//
// Root cause: the commandeered countdown timer was never stopped at expiry, so
// canInjectToTerminal kept returning "timer still counting down" even after the
// usage-limit flag was cleared — the re-drain fired into a still-closed gate.
//
// This exercises the REAL UsageLimitManager.handleUsageLimitTimerExpiry against
// the REAL evaluateInjectionGate. Run: node --test src/features/usage-limit-resume.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// The worktree has no node_modules; shim 'electron' so the real ULM loads.
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { ipcRenderer: { on() {}, send() {}, invoke() {} } };
  return _origLoad.call(this, request, ...rest);
};
let UsageLimitManager, evaluateInjectionGate;
try {
  UsageLimitManager = require('./UsageLimitManager');
  ({ evaluateInjectionGate } = require('../messaging/injection-gate'));
} finally {
  Module._load = _origLoad;
}

function makeHarness() {
  const events = [];
  const handlers = {};
  const eventBus = {
    on: (n, h) => { (handlers[n] = handlers[n] || []).push(h); },
    emit: (n, p) => { events.push(n); (handlers[n] || []).forEach((h) => h(p)); },
  };
  const store = new Map();
  const appStateStore = { getState: (k) => store.get(k), setState: (k, v) => store.set(k, v) };

  // The countdown timer, "running" because it was commandeered for the cooldown.
  const timer = {
    _running: true, stopped: false,
    isRunning() { return this._running; },
    stopTimer() { this._running = false; this.stopped = true; },
    getRemainingSeconds() { return 100; },
    startCountdown() {},
  };

  const injected = [];
  const mqm = {
    usageLimitWaiting: true,
    messageQueue: [{ id: 'm1', terminalId: 1, type: 'normal' }],
    // Faithful drain via the REAL gate (mirrors flushAllTerminals -> canInject).
    flushAllTerminals() {
      for (const m of this.messageQueue) {
        const gate = evaluateInjectionGate({
          usageLimitWaiting: this.usageLimitWaiting,
          timerRunning: timer.isRunning(),
          injectionPaused: false,
          terminalId: m.terminalId,
          status: '...', runtime: 'claude', messageType: m.type,
        });
        if (gate.allowed) injected.push(m.id);
      }
    },
  };

  const ulm = new UsageLimitManager(eventBus, appStateStore);
  ulm.setManagers(timer, mqm);
  // MessageQueueManager resumes the queue on usageLimit:reset.
  eventBus.on('usageLimit:reset', () => {
    if (mqm.messageQueue.length > 0) mqm.flushAllTerminals();
  });
  ulm.state.waiting = true;
  ulm.state.resetTime = new Date(0);
  return { ulm, eventBus, timer, mqm, injected, events };
}

test('REGRESSION: pending messages inject when the usage-limit timer expires (no new enqueue)', async () => {
  const h = makeHarness();
  await h.ulm.handleUsageLimitTimerExpiry();
  assert.strictEqual(h.mqm.usageLimitWaiting, false, 'usage-limit flag released');
  assert.strictEqual(h.timer.stopped, true, 'commandeered timer stopped so isRunning() is false');
  assert.ok(h.events.includes('usageLimit:reset'), 'reset event emitted');
  assert.deepStrictEqual(h.injected, ['m1'], 'the stuck message injected without a new enqueue');
});

test('the timer:expired event drives the same auto-resume', async () => {
  const h = makeHarness();
  h.eventBus.emit('timer:expired');
  await new Promise((r) => setImmediate(r)); // let the async handler settle
  assert.strictEqual(h.timer.stopped, true);
  assert.deepStrictEqual(h.injected, ['m1']);
});

test('root cause: with the timer left running, the gate stays closed', () => {
  // Even with the usage-limit flag cleared, a still-"running" timer blocks.
  const r = evaluateInjectionGate({
    usageLimitWaiting: false, timerRunning: true, injectionPaused: false,
    terminalId: 1, status: '...', runtime: 'claude', messageType: 'normal',
  });
  assert.strictEqual(r.allowed, false);
  assert.match(r.reason, /timer/);
});
