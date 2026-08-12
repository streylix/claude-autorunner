'use strict';

// Unit tests for the manager (999) side of canInjectToTerminal — the layer above
// the pure policy in injection-gate.js.
//
// Two rules meet here and their ORDER is the whole point:
//   * manager-bound messages bypass the SOFT gates — status ('prompted'),
//     countdown, pause, bare-shell — so completions and watch reports reach the
//     manager instantly (injection-gate);
//   * the user's explicit "manager input disabled" switch still blocks everything
//     bound for 999, and it is checked FIRST so the bypass can't defeat it.
// The usage limit also still holds 999 (asserted here and in injection-gate.test.js).
//
// Run: node --test src/messaging/manager-gate.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const MessageQueueManager = require('./MessageQueueManager');

const MANAGER = 999;

// Minimal collaborators — canInjectToTerminal only reads state, never renders.
function makeManager({
    managerInputEnabled = true,
    status = 'prompted',
    runtime = 'claude',
    usageLimitWaiting = false,
} = {}) {
    const settings = { managerInputEnabled };
    const appStateStore = {
        getState: (path) => (path === 'settings.managerInputEnabled' ? settings.managerInputEnabled : undefined),
        setState: () => {},
    };
    const terminalStateManager = {
        getTerminal: (id) => ({ id, status, runtime }),
    };
    const eventBus = { emit: () => {}, on: () => {}, off: () => {} };
    const mqm = new MessageQueueManager(eventBus, appStateStore, terminalStateManager, null);
    // Every SOFT gate hostile at once, so anything that gets through got through
    // on the manager bypass alone. The usage limit is opt-in per test: it is not
    // a soft gate and must hold 999.
    mqm.usageLimitWaiting = usageLimitWaiting;
    mqm.injectionPaused = true;
    mqm.timerManager = { isRunning: () => true };
    return { mqm, settings };
}

test('normal message to 999 while the manager is "prompted" -> allowed', () => {
    const { mqm } = makeManager({ managerInputEnabled: true, status: 'prompted' });
    const r = mqm.canInjectToTerminal(MANAGER, 'normal');
    assert.strictEqual(r.allowed, true, `manager-bound normal was held: ${r.reason}`);
    assert.strictEqual(r.reason, 'ok');
});

test('normal message to 999 while manager input is DISABLED -> still held', () => {
    const { mqm } = makeManager({ managerInputEnabled: false, status: '...' });
    const r = mqm.canInjectToTerminal(MANAGER, 'normal');
    assert.strictEqual(r.allowed, false, 'the disable switch must win over the 999 bypass');
    assert.match(r.reason, /manager input disabled/);
});

test('urgent to 999 while manager input is DISABLED -> still held', () => {
    const { mqm } = makeManager({ managerInputEnabled: false, status: '...' });
    const r = mqm.canInjectToTerminal(MANAGER, 'urgent');
    assert.strictEqual(r.allowed, false);
    assert.match(r.reason, /manager input disabled/);
});

test('normal message to 999 during a usage-limit wait -> still held', () => {
    const { mqm } = makeManager({ managerInputEnabled: true, status: '...', usageLimitWaiting: true });
    const r = mqm.canInjectToTerminal(MANAGER, 'normal');
    assert.strictEqual(r.allowed, false, 'the manager cannot act mid-wait; hold until reset');
    assert.match(r.reason, /usage limit/);
});

test('a worker terminal in the same hostile state is still gated', () => {
    const { mqm } = makeManager({ managerInputEnabled: true, status: 'prompted' });
    const r = mqm.canInjectToTerminal(1, 'normal');
    assert.strictEqual(r.allowed, false, 'the bypass must not leak to worker terminals');
});

test('re-enabling manager input restores instant delivery without reconstructing', () => {
    const { mqm, settings } = makeManager({ managerInputEnabled: false, status: 'prompted' });
    assert.strictEqual(mqm.canInjectToTerminal(MANAGER, 'normal').allowed, false);
    settings.managerInputEnabled = true;
    assert.strictEqual(mqm.canInjectToTerminal(MANAGER, 'normal').allowed, true);
});
