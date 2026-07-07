'use strict';

// Unit tests for PromptWatchManager — pushes an "awaiting input" note to the
// manager (999) when a worker terminal opens a real interactive prompt, with
// de-dup. Run: node --test src/features/PromptWatchManager.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const PromptWatchManager = require('./PromptWatchManager');

const PROMPT_SCREEN = [
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No, and tell Claude what to do differently (esc)',
].join('\n');
const PLAIN_SCREEN = ['Working on it…', '✻ Thinking (esc to interrupt)'].join('\n');

// Build a mock environment. `screen` is what readTerminalScreen returns.
// A mutable clock (advance) and screen (setScreen) let the debounce be tested
// without real timers.
function makeEnv({ screen = PROMPT_SCREEN, running = true, settings = {}, debounceMs } = {}) {
  const handlers = {};
  const dispatched = [];
  const logs = [];
  let now = 1000;            // arbitrary non-zero base for the injected clock
  let currentScreen = screen;
  const eventBus = {
    on: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); },
    emit: (name, payload) => { if (name === 'log:action') logs.push(payload); },
    fire: (name, payload) => (handlers[name] || []).forEach((cb) => cb(payload)),
  };
  const appStateStore = { getState: (k) => settings[k] };
  const gui = {
    readTerminalScreen: () => (currentScreen == null ? { ok: false } : { ok: true, screen: currentScreen }),
    managerInstance: { running, dispatch: (note) => { dispatched.push(note); return true; } },
    terminalStateManager: { getTerminal: (id) => ({ title: `Worker ${id}` }) },
  };
  // schedule runs synchronously and the clock is injected so tests need no timers
  const mgr = new PromptWatchManager(eventBus, appStateStore, gui, {
    schedule: (fn) => fn(),
    now: () => now,
    minNotifyIntervalMs: debounceMs, // undefined -> manager's default window
  });
  return {
    mgr, eventBus, dispatched, logs,
    advance: (ms) => { now += ms; },
    setScreen: (s) => { currentScreen = s; },
  };
}

test('notifies the manager once for a real prompt, with question + options + title', () => {
  const { mgr, dispatched } = makeEnv();
  mgr.checkAndNotify(3, { message: 'Claude needs your permission to use Bash' });
  assert.strictEqual(dispatched.length, 1);
  const note = dispatched[0];
  assert.match(note, /Terminal 3/);
  assert.match(note, /Worker 3/);
  assert.match(note, /awaiting input/i);
  assert.match(note, /Do you want to proceed\?/);
  assert.match(note, /1\. Yes/);
  assert.match(note, /2\. No/);
  assert.match(note, /permission to use Bash/); // notification message included
});

test('does not notify when the screen has no interactive prompt', () => {
  const { mgr, dispatched } = makeEnv({ screen: PLAIN_SCREEN });
  mgr.checkAndNotify(3, null);
  assert.strictEqual(dispatched.length, 0);
});

test('de-dupes: the same prompt only notifies once', () => {
  const { mgr, dispatched } = makeEnv();
  mgr.checkAndNotify(3, null);
  mgr.checkAndNotify(3, null);
  mgr.checkAndNotify(3, null);
  assert.strictEqual(dispatched.length, 1);
});

test('re-notifies the same prompt only after the debounce window elapses', () => {
  const { mgr, dispatched, advance } = makeEnv({ debounceMs: 5000 });
  mgr.checkAndNotify(3, null);
  assert.strictEqual(dispatched.length, 1);
  // terminal answered -> goes back to running, then the same prompt reappears
  mgr.onStatusChanged({ terminalId: 3, status: 'running', source: 'claude-hook' });
  mgr.checkAndNotify(3, null);
  assert.strictEqual(dispatched.length, 1); // still within the window -> suppressed
  advance(5001);
  mgr.checkAndNotify(3, null);
  assert.strictEqual(dispatched.length, 2);
});

test('debounce: a flickering prompt (leave + re-enter within the window) does not re-notify', () => {
  const { mgr, dispatched } = makeEnv({ debounceMs: 5000 });
  mgr.onStatusChanged({ terminalId: 3, status: 'prompted', source: 'claude-hook', detail: {} });
  // menu redraws: terminal briefly drops out of prompted then comes back, same menu
  mgr.onStatusChanged({ terminalId: 3, status: '...', source: 'claude-hook' });
  mgr.onStatusChanged({ terminalId: 3, status: 'prompted', source: 'claude-hook', detail: {} });
  assert.strictEqual(dispatched.length, 1);
});

test('debounce: a different prompt notifies immediately even within the window', () => {
  const { mgr, dispatched, setScreen } = makeEnv({ debounceMs: 5000 });
  mgr.checkAndNotify(3, null);
  assert.strictEqual(dispatched.length, 1);
  // a genuinely different menu opens before the window elapses
  setScreen(['Allow write to this file?', '❯ 1. Yes', '  2. No'].join('\n'));
  mgr.checkAndNotify(3, null);
  assert.strictEqual(dispatched.length, 2);
});

test('respects the managerPromptWatchEnabled=false setting', () => {
  const { mgr, dispatched } = makeEnv({ settings: { managerPromptWatchEnabled: false } });
  mgr.checkAndNotify(3, null);
  assert.strictEqual(dispatched.length, 0);
});

test('does nothing when the manager is not running', () => {
  const { mgr, dispatched } = makeEnv({ running: false });
  mgr.checkAndNotify(3, null);
  assert.strictEqual(dispatched.length, 0);
});

test('onStatusChanged: prompted + claude-hook triggers a notification', () => {
  const { mgr, dispatched } = makeEnv();
  mgr.onStatusChanged({ terminalId: 5, status: 'prompted', source: 'claude-hook', detail: {} });
  assert.strictEqual(dispatched.length, 1);
});

test('onStatusChanged: ignores the manager itself (999) and non-hook sources', () => {
  const { mgr, dispatched } = makeEnv();
  mgr.onStatusChanged({ terminalId: 999, status: 'prompted', source: 'claude-hook', detail: {} });
  mgr.onStatusChanged({ terminalId: 5, status: 'prompted', source: 'manual', detail: {} });
  mgr.onStatusChanged({ terminalId: 5, status: 'running', source: 'claude-hook' });
  assert.strictEqual(dispatched.length, 0);
});

test('subscribes to terminal:status:changed on construction', () => {
  const { mgr, eventBus, dispatched } = makeEnv();
  eventBus.fire('terminal:status:changed', { terminalId: 7, status: 'prompted', source: 'claude-hook', detail: {} });
  assert.strictEqual(dispatched.length, 1);
});
