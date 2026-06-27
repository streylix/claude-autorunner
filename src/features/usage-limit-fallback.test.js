'use strict';

// Regression test: the terminal:data FALLBACK usage-limit detector must actually
// engage. The bug: detectUsageLimit() called isDuplicateDetection() itself, which
// has the SIDE EFFECT of recording the reset-time key; onUsageLimitDetected() then
// called isDuplicateDetection() again, saw a "duplicate", and bailed before ever
// starting the wait — so the fallback was dead code.
// Run: node --test src/features/usage-limit-fallback.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Shim 'electron' so the real UsageLimitManager loads under plain node.
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { ipcRenderer: { on() {}, send() {}, invoke() {} } };
  return _origLoad.call(this, request, ...rest);
};
let UsageLimitManager;
try {
  UsageLimitManager = require('./UsageLimitManager');
} finally {
  Module._load = _origLoad;
}

function makeManager() {
  const handlers = {};
  const eventBus = {
    on: (n, h) => { (handlers[n] = handlers[n] || []).push(h); },
    emit: (n, p) => { (handlers[n] || []).forEach((h) => h(p)); },
  };
  const store = new Map();
  const appStateStore = { getState: (k) => store.get(k), setState: (k, v) => store.set(k, v) };
  const mgr = new UsageLimitManager(eventBus, appStateStore);
  // Stop before the real wait machinery (timer + DOM modal); just record that the
  // fallback engaged. onUsageLimitDetected awaits beginWaiting, calling it
  // synchronously, so the counter is set by the time detectUsageLimit returns.
  let began = 0;
  mgr.beginWaiting = async () => { began++; };
  return { mgr, begun: () => began };
}

const MSG = 'Claude usage limit reached. Your limit will reset at 3pm';

test('terminal-data fallback actually fires (was dead code from the double duplicate-check)', () => {
  const { mgr, begun } = makeManager();
  mgr.detectUsageLimit(MSG, 3);
  assert.strictEqual(begun(), 1, 'fallback detection must start the wait');
});

test('the fallback still de-dupes a repeat of the same reset time', () => {
  const { mgr, begun } = makeManager();
  mgr.detectUsageLimit(MSG, 3);
  mgr.detectUsageLimit(MSG, 3);
  assert.strictEqual(begun(), 1, 'the same reset time must not re-trigger the wait');
});
