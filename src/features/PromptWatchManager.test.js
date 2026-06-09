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
function makeEnv({ screen = PROMPT_SCREEN, running = true, settings = {} } = {}) {
  const handlers = {};
  const dispatched = [];
  const logs = [];
  const eventBus = {
    on: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); },
    emit: (name, payload) => { if (name === 'log:action') logs.push(payload); },
    fire: (name, payload) => (handlers[name] || []).forEach((cb) => cb(payload)),
  };
  const appStateStore = { getState: (k) => settings[k] };
  const gui = {
    readTerminalScreen: () => (screen == null ? { ok: false } : { ok: true, screen }),
    managerInstance: { running, dispatch: (note) => { dispatched.push(note); return true; } },
    terminalStateManager: { getTerminal: (id) => ({ title: `Worker ${id}` }) },
  };
  // schedule runs synchronously so tests need no timers
  const mgr = new PromptWatchManager(eventBus, appStateStore, gui, { schedule: (fn) => fn() });
  return { mgr, eventBus, dispatched, logs };
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

test('re-notifies after the terminal leaves the prompted state', () => {
  const { mgr, dispatched } = makeEnv();
  mgr.checkAndNotify(3, null);
  assert.strictEqual(dispatched.length, 1);
  // terminal answered -> goes back to running; key resets
  mgr.onStatusChanged({ terminalId: 3, status: 'running', source: 'claude-hook' });
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
