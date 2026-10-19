'use strict';

// Regression tests for the injection retry loop and the double-injection hole.
//
// 1) Retry guard: when every target terminal is busy, injectMessageAndContinueQueue
//    schedules ONE 1s retry. It used to spawn an independent unguarded
//    setTimeout chain per caller — chains stacked forever and each tick logged
//    an action (shipped to the backend every 3s for as long as any terminal
//    was busy).
//
// 2) Double injection: a queued message with NO explicit terminalId resolves
//    its target at pick time (msg.terminalId || activeTerminalId). If the
//    active terminal changed while such a message was mid-injection, a
//    concurrent picker (maybeAutoInject on a status change, or a second retry
//    chain) re-matched the SAME message against the NEW terminal and typed it
//    again. Both pickers now skip messages in currentlyInjectingMessages.
//
// Run: node --test src/messaging/injection-retry-guard.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const MessageQueueManager = require('./MessageQueueManager');

function makeStore(initial = {}) {
  const state = { ...initial };
  return {
    getState: (path) => state[path],
    setState: (path, value) => { state[path] = value; return true; },
    _state: state,
  };
}

function makeMqm({ terminals = {}, activeId = 1 } = {}) {
  const emitted = [];
  const eventBus = { on() {}, off() {}, emit: (n, d) => emitted.push({ n, d }) };
  const appStateStore = makeStore();
  const terminalStateManager = {
    activeTerminalId: activeId,
    getTerminal: (id) => terminals[id] || { status: '...', runtime: 'claude' },
  };
  const sent = [];
  const ipc = { send: (channel, payload) => sent.push({ channel, payload }), on() {}, removeListener() {} };
  const mqm = new MessageQueueManager(eventBus, appStateStore, terminalStateManager, ipc);
  // Neutralize persistence/backend side effects for unit testing.
  mqm.saveMessageQueue = () => {};
  mqm.saveToMessageHistory = () => {};
  mqm.markMessageAsInjectedInBackend = () => {};
  mqm.updateQueueDisplay = () => {};
  return { mqm, emitted, sent, appStateStore };
}

test('busy retry: repeated entries share ONE pending retry timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Terminal busy: status 'prompted' closes the gate for terminal 1 (the gate
  // deliberately ignores 'running' — see injection-gate.js).
  const { mqm, emitted } = makeMqm({ terminals: { 1: { status: 'prompted', runtime: 'claude' } } });
  mqm.messageQueue = [{ id: 'm1', content: 'hello', terminalId: 1 }];

  mqm.injectMessageAndContinueQueue();
  const timerAfterFirst = mqm._busyRetryTimer;
  assert.ok(timerAfterFirst, 'first blocked entry schedules a retry');

  // A second and third caller while blocked must NOT stack more chains.
  mqm.injectMessageAndContinueQueue();
  mqm.injectMessageAndContinueQueue();
  assert.strictEqual(mqm._busyRetryTimer, timerAfterFirst, 'no second timer scheduled');

  const busyLogs = () => emitted.filter(
    (e) => e.n === 'log:action' && /busy or not idle/.test(e.d && e.d.message)
  ).length;
  assert.strictEqual(busyLogs(), 1, 'only the first entry logs the wait');

  // Fire the pending retry: still blocked -> exactly one NEW retry scheduled.
  t.mock.timers.tick(1000);
  assert.ok(mqm._busyRetryTimer, 'retry rescheduled while still blocked');
  assert.notStrictEqual(mqm._busyRetryTimer, timerAfterFirst);
  assert.strictEqual(busyLogs(), 2, 'one log per real retry tick, not per caller');

  t.mock.timers.reset();
});

test('busy retry: pending retry injects once the terminal frees up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const terminals = { 1: { status: 'prompted', runtime: 'claude' } };
  const { mqm, sent } = makeMqm({ terminals });
  mqm.messageQueue = [{ id: 'm1', content: 'hello', terminalId: 1 }];

  mqm.injectMessageAndContinueQueue();
  assert.strictEqual(sent.length, 0, 'nothing typed while blocked');

  terminals[1] = { status: '...', runtime: 'claude' }; // terminal went idle
  t.mock.timers.tick(1000);

  const typed = sent.filter((s) => s.channel === 'terminal-input');
  assert.ok(typed.length >= 1, 'retry tick injected the message');
  assert.strictEqual(typed[0].payload.terminalId, 1);
  assert.match(typed[0].payload.data, /hello/);

  t.mock.timers.reset();
});

test('DOUBLE-INJECTION: active-terminal change mid-flight cannot re-inject the same message', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { mqm, sent } = makeMqm({ activeId: 1 });
  // No explicit terminal: resolves to the ACTIVE terminal at pick time.
  mqm.messageQueue = [{ id: 'm1', content: 'dangerous once', terminalId: null }];

  // Auto path picks it up for terminal 1 and starts typing (150ms submit).
  mqm.maybeAutoInject(1);
  assert.strictEqual(sent.filter((s) => s.channel === 'terminal-input').length, 1,
    'typing started on terminal 1');
  assert.ok(mqm.currentlyInjectingMessages.has('m1'), 'message marked in-flight');

  // User focuses terminal 2 while m1 is mid-injection; a status change fires
  // the auto picker for terminal 2. m1 (terminalId null) now RESOLVES to 2 —
  // before the fix this typed the same message into terminal 2 as well.
  mqm.terminalStateManager.activeTerminalId = 2;
  mqm.maybeAutoInject(2);

  const targets = sent.filter((s) => s.channel === 'terminal-input').map((s) => s.payload.terminalId);
  assert.deepStrictEqual([...new Set(targets)], [1], 'message typed into terminal 1 only');

  // Same protection on the sequential picker.
  mqm.injectMessageAndContinueQueue();
  const targets2 = sent.filter((s) => s.channel === 'terminal-input').map((s) => s.payload.terminalId);
  assert.deepStrictEqual([...new Set(targets2)], [1], 'sequential picker also skips the in-flight message');

  // Let the 150ms submit + completion run: message leaves the queue exactly once.
  t.mock.timers.tick(200);
  assert.strictEqual(mqm.messageQueue.length, 0, 'message removed after its single injection');
  assert.strictEqual(mqm.currentlyInjectingMessages.size, 0, 'in-flight tracking cleared');

  t.mock.timers.reset();
});

test('sanity: a free terminal injects immediately (guard does not over-block)', () => {
  const { mqm, sent } = makeMqm({ activeId: 1 });
  mqm.messageQueue = [{ id: 'm1', content: 'go', terminalId: 1 }];
  mqm.maybeAutoInject(1);
  assert.strictEqual(sent.filter((s) => s.channel === 'terminal-input').length, 1);
});
