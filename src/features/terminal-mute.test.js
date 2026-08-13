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
