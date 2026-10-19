'use strict';

// Unit tests for StuckWatchManager — the periodic sweep that pushes ONE compact
// "T<id> appears stuck" line to the manager (999) when a terminal needs
// attention but will never fire a completion: prompted too long, running but
// silent, or a queued message blocked by the injection gate.
// Run: node --test src/features/StuckWatchManager.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const StuckWatchManager = require('./StuckWatchManager');

const MIN = 60 * 1000;

// Build a mock environment. Terminals live in a Map (as
// TerminalStateManager.getAllTerminals returns); the clock is injected so
// thresholds are tested without real timers. Status history is fed through the
// same eventBus events the real app emits.
function makeEnv({ terminals = new Map(), queue = [], gate = { allowed: true }, running = true, settings = {} } = {}) {
  const handlers = {};
  const dispatched = [];
  let now = 1000; // arbitrary non-zero base for the injected clock
  const eventBus = {
    on: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); },
    emit: () => {},
    fire: (name, payload) => (handlers[name] || []).forEach((cb) => cb(payload)),
  };
  const appStateStore = { getState: (k) => settings[k] };
  const gui = {
    managerInstance: { running, dispatch: (note) => { dispatched.push(note); return true; } },
    terminalStateManager: {
      getAllTerminals: () => new Map(terminals),
      getTerminal: (id) => terminals.get(id) || null,
    },
    messageQueueManager: {
      messageQueue: queue,
      canInjectToTerminal: () => gate,
    },
  };
  const mgr = new StuckWatchManager(eventBus, appStateStore, gui, { now: () => now });
  return {
    mgr, eventBus, dispatched,
    advance: (ms) => { now += ms; },
    setGate: (g) => { gate = g; },
  };
}

// Shorthand: put terminal `id` into `status` at the current injected time.
function setStatus(env, id, status) {
  env.eventBus.fire('terminal:status:changed', { terminalId: id, status, previousStatus: null, source: 'claude-hook' });
}

test('prompted beyond the threshold dispatches one compact stuck line with id + title', () => {
  const env = makeEnv({ terminals: new Map([[3, { title: 'api' }]]) });
  setStatus(env, 3, 'prompted');
  env.advance(6 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 1);
  const note = env.dispatched[0];
  assert.match(note, /T3 \("api"\) appears stuck/);
  assert.match(note, /prompted 6m/);
  assert.strictEqual(note.includes('\n'), false); // ONE compact line
});

test('prompted within the threshold does not dispatch', () => {
  const env = makeEnv({ terminals: new Map([[3, { title: 'api' }]]) });
  setStatus(env, 3, 'prompted');
  env.advance(2 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 0);
});

test('running with no PTY output beyond the threshold dispatches a silent-hang line', () => {
  const env = makeEnv({ terminals: new Map([[4, { title: 'worker' }]]) });
  setStatus(env, 4, 'running');
  env.eventBus.fire('terminal:data', { terminalId: 4, data: 'compiling…' });
  env.advance(5 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 1);
  assert.match(env.dispatched[0], /T4 \("worker"\) appears stuck/);
  assert.match(env.dispatched[0], /running 5m with no output/);
});

test('running with recent PTY output does not dispatch', () => {
  const env = makeEnv({ terminals: new Map([[4, { title: 'worker' }]]) });
  setStatus(env, 4, 'running');
  env.advance(5 * MIN);
  env.eventBus.fire('terminal:data', { terminalId: 4, data: 'still going' });
  env.advance(1 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 0);
});

test('running with no output ever recorded measures silence from entering running', () => {
  const env = makeEnv({ terminals: new Map([[4, { title: 'worker' }]]) });
  setStatus(env, 4, 'running');
  env.advance(5 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 1);
  assert.match(env.dispatched[0], /running 5m with no output/);
});

test('a queued message blocked by the injection gate beyond the threshold dispatches with the gate reason', () => {
  const env = makeEnv({
    terminals: new Map([[5, { title: 'ssh box' }]]),
    queue: [{ id: 'm1', terminalId: 5, type: 'normal' }],
    gate: { allowed: false, reason: 'terminal is prompted' },
  });
  env.mgr.sweep();            // first sighting starts the blocked clock
  env.advance(6 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 1);
  assert.match(env.dispatched[0], /T5 \("ssh box"\) appears stuck/);
  assert.match(env.dispatched[0], /queued message blocked 6m \(terminal is prompted\)/);
});

test('a blocked message that becomes injectable clears the blocked clock', () => {
  const env = makeEnv({
    terminals: new Map([[5, { title: 'ssh box' }]]),
    queue: [{ id: 'm1', terminalId: 5, type: 'normal' }],
    gate: { allowed: false, reason: 'terminal is prompted' },
  });
  env.mgr.sweep();
  env.advance(3 * MIN);
  env.setGate({ allowed: true });
  env.mgr.sweep();            // unblocked -> episode resets
  env.setGate({ allowed: false, reason: 'terminal is prompted' });
  env.mgr.sweep();            // blocked again -> clock restarts from here
  env.advance(3 * MIN);
  env.mgr.sweep();            // only 3m into the NEW episode -> quiet
  assert.strictEqual(env.dispatched.length, 0);
});

test('de-dupes: the same stuck episode notifies only once across sweeps', () => {
  const env = makeEnv({ terminals: new Map([[3, { title: 'api' }]]) });
  setStatus(env, 3, 'prompted');
  env.advance(6 * MIN);
  env.mgr.sweep();
  env.advance(1 * MIN);
  env.mgr.sweep();
  env.advance(1 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 1);
});

test('a cleared condition resets the episode so a later stuck notifies again', () => {
  const env = makeEnv({ terminals: new Map([[3, { title: 'api' }]]) });
  setStatus(env, 3, 'prompted');
  env.advance(6 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 1);
  setStatus(env, 3, 'running'); // user answered; terminal moves on
  env.eventBus.fire('terminal:data', { terminalId: 3, data: 'ok' });
  env.mgr.sweep();              // healthy -> episode cleared
  setStatus(env, 3, 'prompted');
  env.advance(6 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 2);
});

test('a NEW condition joining an already-notified episode re-notifies with both facts', () => {
  const env = makeEnv({
    terminals: new Map([[3, { title: 'api' }]]),
    queue: [{ id: 'm1', terminalId: 3, type: 'normal' }],
    gate: { allowed: true },
  });
  setStatus(env, 3, 'prompted');
  env.advance(6 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 1);
  env.setGate({ allowed: false, reason: 'terminal is prompted' });
  env.mgr.sweep();            // blocked clock starts
  env.advance(6 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 2);
  assert.match(env.dispatched[1], /prompted 12m/);
  assert.match(env.dispatched[1], /queued message blocked 6m/);
});

test('never watches the manager terminal itself (999)', () => {
  const env = makeEnv({ terminals: new Map([[999, { title: 'Manager' }]]) });
  setStatus(env, 999, 'prompted');
  env.advance(10 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 0);
});

test('respects the managerStuckWatchEnabled=false setting', () => {
  const env = makeEnv({
    terminals: new Map([[3, { title: 'api' }]]),
    settings: { managerStuckWatchEnabled: false },
  });
  setStatus(env, 3, 'prompted');
  env.advance(10 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 0);
});

test('does nothing when the manager is not running', () => {
  const env = makeEnv({ terminals: new Map([[3, { title: 'api' }]]), running: false });
  setStatus(env, 3, 'prompted');
  env.advance(10 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 0);
});

test('terminals with no status history (plain shells) never trip prompted/silent checks', () => {
  const env = makeEnv({ terminals: new Map([[6, { title: 'bash' }]]) });
  env.advance(60 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 0);
});

test('start()/stop() arm and clear the sweep interval', () => {
  const env = makeEnv();
  env.mgr.start();
  assert.ok(env.mgr.sweepTimer);
  env.mgr.stop();
  assert.strictEqual(env.mgr.sweepTimer, null);
});
