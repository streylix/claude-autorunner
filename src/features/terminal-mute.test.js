'use strict';

// Unit tests for the per-terminal MUTE flag.
//
// Mute is OUTBOUND-TO-MANAGER ONLY. It suppresses exactly two things:
//   (a) the completion push ManagerInstance queues to 999 when a terminal
//       finishes a Claude turn, and
//   (b) StuckWatchManager's "appears stuck: prompted Nm" alerts.
// Everything else about a muted terminal is untouched — it is still in /state
// (with muted:true so the manager can tell silence-by-choice from silence),
// the manager can still queue into it, its screen and transcript still read.
// These tests pin BOTH halves: the suppression AND the non-effects.
// Run: node --test src/features/terminal-mute.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const HookServer = require('../main/HookServer');
const ManagerInstance = require('./ManagerInstance');
const StuckWatchManager = require('./StuckWatchManager');
const PromptWatchManager = require('./PromptWatchManager');
const LongExecutionWatchManager = require('./LongExecutionWatchManager');
const TerminalStateManager = require('../state/TerminalStateManager');
const { evaluateInjectionGate } = require('../messaging/injection-gate');

const MIN = 60 * 1000;

// ---- (a) completion push --------------------------------------------------

// Mirrors ManagerInstance.dedup.test.js's harness, plus a mutable muted set fed
// through gui.isTerminalMuted (the renderer's single read point for the flag).
function makeCompletionEnv({ muted = new Set() } = {}) {
  const handlers = {};
  const queued = [];
  const eventBus = {
    on: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); },
    emit: () => {},
    fire: (name, payload) => (handlers[name] || []).forEach((cb) => cb(payload)),
  };
  const gui = {
    terminalStateManager: { getTerminal: (id) => ({ title: `Worker ${id}`, muted: muted.has(id) }) },
    messageQueueManager: { addMessage: (m) => queued.push(m) },
    isTerminalMuted: (id) => muted.has(id),
  };
  const mgr = new ManagerInstance(eventBus, { getState: () => undefined }, {}, gui);
  mgr.running = true;
  return { mgr, eventBus, queued, muted };
}

test('completion push: a muted terminal queues nothing to the manager', () => {
  const env = makeCompletionEnv({ muted: new Set([3]) });
  env.eventBus.fire('completion:recorded', { terminalId: 3, text: 'Done.', directory: '/tmp/x' });
  assert.strictEqual(env.queued.length, 0);
});

test('completion push: an unmuted terminal is unaffected', () => {
  const env = makeCompletionEnv({ muted: new Set([3]) });
  env.eventBus.fire('completion:recorded', { terminalId: 4, text: 'Done.', directory: '/tmp/x' });
  assert.strictEqual(env.queued.length, 1);
  assert.strictEqual(env.queued[0].terminalId, 999);
  assert.match(env.queued[0].content, /Terminal 4 \("Worker 4"\)/);
});

test('completion push: unmuting restores it (the flag is read at fire time)', () => {
  const env = makeCompletionEnv({ muted: new Set([3]) });
  env.eventBus.fire('completion:recorded', { terminalId: 3, text: 'First.', directory: '/tmp/x' });
  assert.strictEqual(env.queued.length, 0);
  env.muted.delete(3);
  env.eventBus.fire('completion:recorded', { terminalId: 3, text: 'Second.', directory: '/tmp/x' });
  assert.strictEqual(env.queued.length, 1);
  assert.match(env.queued[0].content, /Second\./);
});

// ---- (b) stuck alerts -----------------------------------------------------

function makeStuckEnv(terminals) {
  const handlers = {};
  const dispatched = [];
  let now = 1000;
  const eventBus = {
    on: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); },
    emit: () => {},
    fire: (name, payload) => (handlers[name] || []).forEach((cb) => cb(payload)),
  };
  const gui = {
    managerInstance: { running: true, dispatch: (note) => { dispatched.push(note); return true; } },
    terminalStateManager: { getAllTerminals: () => new Map(terminals) },
    messageQueueManager: { messageQueue: [], canInjectToTerminal: () => ({ allowed: true }) },
    // All four watchers ask this one question; the flag lives on the terminal
    // record, exactly as the renderer's isTerminalMuted reads it.
    isTerminalMuted: (id) => !!(terminals.get(id) || {}).muted,
  };
  const mgr = new StuckWatchManager(eventBus, { getState: () => undefined }, gui, { now: () => now });
  return { mgr, eventBus, dispatched, advance: (ms) => { now += ms; } };
}

test('stuck alerts: a muted terminal prompted for ages says nothing', () => {
  const terminals = new Map([[3, { title: 'ethan', muted: true }]]);
  const env = makeStuckEnv(terminals);
  env.eventBus.fire('terminal:status:changed', { terminalId: 3, status: 'prompted' });
  env.advance(30 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 0);
});

test('stuck alerts: an unmuted terminal in the same sweep still alerts', () => {
  const terminals = new Map([
    [3, { title: 'ethan', muted: true }],
    [4, { title: 'api', muted: false }],
  ]);
  const env = makeStuckEnv(terminals);
  env.eventBus.fire('terminal:status:changed', { terminalId: 3, status: 'prompted' });
  env.eventBus.fire('terminal:status:changed', { terminalId: 4, status: 'prompted' });
  env.advance(6 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 1);
  assert.match(env.dispatched[0], /T4 \("api"\) appears stuck/);
});

test('stuck alerts: unmuting does not immediately fire the episode it silenced', () => {
  // The condition was true the whole time it was muted; unmuting should not
  // dump a backlog note. The next NEW stuck episode still alerts.
  const data = { title: 'ethan', muted: true };
  const terminals = new Map([[3, data]]);
  const env = makeStuckEnv(terminals);
  env.eventBus.fire('terminal:status:changed', { terminalId: 3, status: 'prompted' });
  env.advance(30 * MIN);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 0);
  data.muted = false;
  env.mgr.sweep();
  // Still stuck and now audible: exactly one note, not one per silenced sweep.
  assert.strictEqual(env.dispatched.length, 1);
  env.mgr.sweep();
  assert.strictEqual(env.dispatched.length, 1); // de-duped as usual
});

// ---- mute must not affect anything else -----------------------------------

test('state: muted defaults false and round-trips through TerminalStateManager', () => {
  const tsm = new TerminalStateManager();
  const plain = tsm.createTerminal({ id: 1 });
  assert.strictEqual(plain.muted, false);
  const restored = tsm.createTerminal({ id: 2, muted: true });
  assert.strictEqual(restored.muted, true);
  tsm.updateTerminal(1, { muted: true });
  assert.strictEqual(tsm.getTerminal(1).muted, true);
  tsm.updateTerminal(1, { muted: false });
  assert.strictEqual(tsm.getTerminal(1).muted, false);
});

// ---- (c) prompt-watch "awaiting input" notes ------------------------------

const PROMPT_SCREEN = [
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. No, and tell Claude what to do differently (esc)',
].join('\n');

function makePromptEnv({ muted = new Set() } = {}) {
  const handlers = {};
  const dispatched = [];
  let now = 1000;
  const eventBus = {
    on: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); },
    emit: () => {},
    fire: (name, payload) => (handlers[name] || []).forEach((cb) => cb(payload)),
  };
  const gui = {
    readTerminalScreen: () => ({ ok: true, screen: PROMPT_SCREEN }),
    managerInstance: { running: true, dispatch: (note) => { dispatched.push(note); return true; } },
    terminalStateManager: { getTerminal: (id) => ({ title: `Worker ${id}` }) },
    isTerminalMuted: (id) => muted.has(id),
  };
  const mgr = new PromptWatchManager(eventBus, { getState: () => undefined }, gui, {
    schedule: (fn) => fn(),
    now: () => now,
  });
  return { mgr, dispatched, muted, advance: (ms) => { now += ms; } };
}

test('prompt watch: a muted terminal opening a real menu notifies nobody', () => {
  const env = makePromptEnv({ muted: new Set([3]) });
  env.mgr.checkAndNotify(3, { message: 'Claude needs your permission to use Bash' });
  assert.strictEqual(env.dispatched.length, 0);
});

test('prompt watch: an unmuted terminal still notifies', () => {
  const env = makePromptEnv({ muted: new Set([3]) });
  env.mgr.checkAndNotify(4, { message: 'Claude needs your permission to use Bash' });
  assert.strictEqual(env.dispatched.length, 1);
  assert.match(env.dispatched[0], /Terminal 4 \("Worker 4"\) is AWAITING INPUT/);
});

test('prompt watch: unmuting does not replay the prompt that was silenced', () => {
  // Nothing is queued while muted, so an unmute on its own is silent — the
  // note only comes back on a genuinely NEW prompt check.
  const env = makePromptEnv({ muted: new Set([3]) });
  env.mgr.checkAndNotify(3, {});
  assert.strictEqual(env.dispatched.length, 0);
  env.muted.delete(3);
  assert.strictEqual(env.dispatched.length, 0);
  env.mgr.checkAndNotify(3, {});
  assert.strictEqual(env.dispatched.length, 1);
});

test('prompt watch: the debounce entry is cleared while muted, so the first prompt after an unmute is not swallowed', () => {
  // Without the clear, the pre-mute key would still be inside the 8s window and
  // would suppress the first real prompt the user hears about after unmuting.
  const env = makePromptEnv();
  env.mgr.checkAndNotify(3, {});
  assert.strictEqual(env.dispatched.length, 1);
  env.muted.add(3);
  env.mgr.checkAndNotify(3, {});           // silenced, and drops the debounce key
  assert.strictEqual(env.dispatched.length, 1);
  env.muted.delete(3);
  env.mgr.checkAndNotify(3, {});           // same prompt, still inside the window
  assert.strictEqual(env.dispatched.length, 2);
});

// ---- (d) long-execution "execution stopped" reports ------------------------

// Drives the watcher's real state machine on an injected clock: an output
// episode long enough to be promoted to 'running', then silence long enough to
// close it — which is what triggers the report.
function makeLongEnv({ muted = new Set() } = {}) {
  const handlers = {};
  const dispatched = [];
  const statuses = [];
  let now = 1000;
  const eventBus = {
    on: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); },
    emit: () => {},
    fire: (name, payload) => (handlers[name] || []).forEach((cb) => cb(payload)),
  };
  const record = { id: 3, title: 'ethan', status: null, directory: '/tmp/x' };
  const gui = {
    readTerminalScreen: () => ({ ok: true, screen: 'npm test\nPASS 249 tests' }),
    managerInstance: { running: true, dispatch: (note) => { dispatched.push(note); return true; } },
    terminalStateManager: {
      getTerminal: (id) => (id === 3 ? record : null),
      setTerminalStatus: (id, status) => {
        const prev = record.status;
        record.status = status;
        statuses.push(status);
        return prev;
      },
    },
    isTerminalMuted: (id) => muted.has(id),
  };
  const mgr = new LongExecutionWatchManager(eventBus, { getState: () => undefined }, gui, { now: () => now });
  const advance = (ms) => { now += ms; };
  // One full episode: 8s of output, promoted at the 10s mark, then silence.
  const runOneExecution = () => {
    eventBus.fire('terminal:data', { terminalId: 3, data: 'x' });
    advance(4000);
    eventBus.fire('terminal:data', { terminalId: 3, data: 'x' });
    advance(4000);
    eventBus.fire('terminal:data', { terminalId: 3, data: 'x' });
    advance(2000);
    mgr.evaluate();          // -> running
    advance(6000);
    mgr.evaluate();          // quiet -> idle + report
  };
  return { mgr, dispatched, statuses, muted, record, runOneExecution };
}

test('long execution: a muted terminal finishing a long run reports nothing', () => {
  const env = makeLongEnv({ muted: new Set([3]) });
  env.runOneExecution();
  assert.strictEqual(env.dispatched.length, 0);
});

test('long execution: an unmuted terminal still reports', () => {
  const env = makeLongEnv();
  env.runOneExecution();
  assert.strictEqual(env.dispatched.length, 1);
  assert.match(env.dispatched[0], /Terminal 3 \("ethan"\).*execution stopped after 8s/s);
});

test('long execution: mute suppresses ONLY the report — status tracking is untouched', () => {
  // Status is not cosmetic here: it feeds the terminal display AND the
  // injection gate. A mute that stopped the running/idle transitions would be
  // a functional change, not a notification change.
  const muted = makeLongEnv({ muted: new Set([3]) });
  muted.runOneExecution();
  const loud = makeLongEnv();
  loud.runOneExecution();
  assert.deepStrictEqual(muted.statuses, ['running', '...']);
  assert.deepStrictEqual(muted.statuses, loud.statuses);
  assert.strictEqual(muted.record.status, '...');
});

test('long execution: unmuting does not dump the run that finished while muted', () => {
  // The episode is consumed whether or not it was reported, so nothing is
  // pending at unmute time; only the NEXT execution reports.
  const env = makeLongEnv({ muted: new Set([3]) });
  env.runOneExecution();
  assert.strictEqual(env.dispatched.length, 0);
  env.muted.delete(3);
  env.mgr.evaluate();
  assert.strictEqual(env.dispatched.length, 0);
  env.runOneExecution();
  assert.strictEqual(env.dispatched.length, 1);
});

// ---- control API ----------------------------------------------------------

function post(server, urlPath, json) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(json));
    const req = http.request({
      host: '127.0.0.1', port: server.port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'X-CCBOT-Token': server.token,
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('control API: POST /terminal/update carries muted through to the renderer', async () => {
  // The existing endpoint, not a new one: muted rides alongside title/color
  // exactly as they do. This pins the HTTP half (HookServer -> onControl); the
  // renderer half is handleControlRequest -> setTerminalMetadata.
  const seen = [];
  const server = new HookServer({
    onEvent: () => {},
    onControl: (action, payload) => { seen.push({ action, payload }); return { ok: true }; },
  });
  await server.start();
  try {
    const res = await post(server, '/terminal/update', { terminalId: 3, muted: true });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].action, 'terminal-update');
    assert.strictEqual(seen[0].payload.muted, true);
    assert.strictEqual(seen[0].payload.terminalId, 3);
    // Unmute travels the same way.
    await post(server, '/terminal/update', { terminalId: 3, muted: false });
    assert.strictEqual(seen[1].payload.muted, false);
  } finally {
    server.close();
  }
});

test('injection: the gate ignores muted — the manager can still inject', () => {
  // The gate is the single decision point for "may a message go into this
  // terminal". It takes status/timer/usage-limit inputs and has no notion of
  // mute; this pins that a muted terminal is as injectable as any other.
  const inputs = {
    terminalId: 3,
    status: '...',
    injectionPaused: false,
    usageLimitWaiting: false,
    timerRunning: false,
    isRunning: false,
  };
  const gate = evaluateInjectionGate(inputs);
  assert.strictEqual(gate.allowed, true, `gate blocked: ${gate.reason}`);
  // Same inputs with a muted terminal produce the identical verdict: mute is
  // not one of the gate's inputs at all.
  assert.deepStrictEqual(evaluateInjectionGate({ ...inputs, muted: true }), gate);
});
