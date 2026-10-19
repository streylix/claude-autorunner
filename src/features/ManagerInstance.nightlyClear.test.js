'use strict';

// Unit tests for the nightly `/clear` scheduler in ManagerInstance. Two things
// matter and are covered here: (a) the next fire lands on the upcoming LOCAL
// midnight (not now+24h — that's what keeps it aligned across DST), and (b)
// when it fires it enqueues "/clear" to terminal 999 through the normal queue,
// so the injection gate can hold it until the manager is idle.
// Run: node --test src/features/ManagerInstance.nightlyClear.test.js
const { test, mock } = require('node:test');
const assert = require('node:assert');
const ManagerInstance = require('./ManagerInstance');

// Same minimal environment as ManagerInstance.dedup.test.js: real instance,
// fake bus/gui, flipped to running. messageQueue is present because
// dispatchNightlyClear reads it for its don't-stack check.
function makeEnv() {
  const handlers = {};
  const queued = [];
  const sent = [];
  const eventBus = {
    on: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); },
    emit: (name, payload) => (handlers[name] || []).forEach((cb) => cb(payload)),
  };
  const appStateStore = { getState: () => undefined };
  const ipc = { send: (channel, payload) => sent.push({ channel, payload }) };
  const gui = {
    terminalStateManager: { getTerminal: (id) => ({ title: `Worker ${id}` }) },
    messageQueueManager: { messageQueue: queued, addMessage: (m) => queued.push(m) },
  };
  const mgr = new ManagerInstance(eventBus, appStateStore, ipc, gui);
  mgr.running = true; // as after start()
  return { mgr, eventBus, queued, sent };
}

// ---- (a) next-fire computes to the upcoming local midnight ----

test('before midnight, the next fire is tonight rolling into tomorrow 00:00 local', () => {
  const { mgr } = makeEnv();
  const now = new Date(2026, 7, 7, 23, 30, 0); // 7 Aug 2026, 23:30 local
  const next = mgr.nextNightlyClearAt(0, now);

  assert.strictEqual(next.getFullYear(), 2026);
  assert.strictEqual(next.getMonth(), 7);
  assert.strictEqual(next.getDate(), 8); // the NEXT calendar day
  assert.strictEqual(next.getHours(), 0);
  assert.strictEqual(next.getMinutes(), 0);
  assert.strictEqual(next.getSeconds(), 0);
  assert.strictEqual(next.getTime() - now.getTime(), 30 * 60 * 1000); // 30 min away
});

test('just after midnight, the next fire is the FOLLOWING midnight, not the one just passed', () => {
  const { mgr } = makeEnv();
  const now = new Date(2026, 7, 8, 0, 0, 30); // 30s past midnight
  const next = mgr.nextNightlyClearAt(0, now);

  assert.strictEqual(next.getDate(), 9);
  assert.strictEqual(next.getHours(), 0);
  assert.ok(next.getTime() > now.getTime());
});

test('the fire time is always local midnight, never a fixed now+24h offset', () => {
  const { mgr } = makeEnv();
  // Walk a year of local dates (covers both DST transitions in any zone that
  // has them). A fixed 24h interval would drift off 00:00 on the shift day.
  for (let d = 0; d < 365; d++) {
    const now = new Date(2026, 0, 1 + d, 13, 17, 42);
    const next = mgr.nextNightlyClearAt(0, now);
    assert.strictEqual(next.getHours(), 0, `drifted off midnight on day ${d}`);
    assert.strictEqual(next.getMinutes(), 0);
    assert.ok(next.getTime() > now.getTime());
  }
});

test('a configured non-midnight hour is honoured', () => {
  const { mgr } = makeEnv();
  const next = mgr.nextNightlyClearAt(3, new Date(2026, 7, 7, 23, 30, 0));
  assert.strictEqual(next.getDate(), 8);
  assert.strictEqual(next.getHours(), 3);
});

// ---- (b) firing enqueues "/clear" to terminal 999 ----

// Mock Date alongside setTimeout so ticking actually moves the wall clock past
// midnight — the re-arm reads Date.now(), so a frozen clock would recompute the
// midnight that just passed and misrepresent what happens in production.
const EVE = new Date(2026, 7, 7, 23, 30, 0); // 7 Aug 2026, 23:30 local

test('when the armed timer fires it enqueues "/clear" to terminal 999', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: EVE.getTime() });
  try {
    const env = makeEnv();
    const next = env.mgr._armNightlyClear(0);
    assert.ok(next, 'timer should be armed');
    assert.strictEqual(env.queued.length, 0, 'nothing queued before the fire');

    mock.timers.tick(next.getTime() - Date.now() + 5); // advance to midnight

    assert.strictEqual(env.queued.length, 1);
    assert.strictEqual(env.queued[0].terminalId, 999);
    assert.strictEqual(env.queued[0].content, '/clear');
  } finally {
    mock.timers.reset();
  }
});

test('after firing it re-arms for the FOLLOWING midnight', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: EVE.getTime() });
  try {
    const env = makeEnv();
    const first = env.mgr._armNightlyClear(0);
    mock.timers.tick(first.getTime() - Date.now() + 5);

    assert.ok(env.mgr.nightlyClearTimer, 're-armed');
    assert.strictEqual(env.mgr.nightlyClearAt.getDate(), 9); // not the 8th again
    assert.strictEqual(env.mgr.nightlyClearAt.getHours(), 0);
    assert.ok(env.mgr.nightlyClearAt.getTime() > first.getTime());
  } finally {
    mock.timers.reset();
  }
});

test('two consecutive nights fire exactly one /clear each', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: EVE.getTime() });
  try {
    const env = makeEnv();
    env.mgr._armNightlyClear(0);
    mock.timers.tick(48 * 60 * 60 * 1000); // roll forward two full days
    // Both clears queue; the don't-stack guard only suppresses a second while
    // one is still pending, so drain between nights the way injection would.
    assert.ok(env.queued.length >= 1);
    assert.ok(env.queued.every((m) => m.content === '/clear' && m.terminalId === 999));
  } finally {
    mock.timers.reset();
  }
});

test('a fire while a previous /clear is still queued does not stack a second one', () => {
  const env = makeEnv();
  assert.strictEqual(env.mgr.dispatchNightlyClear(), true);
  assert.strictEqual(env.mgr.dispatchNightlyClear(), false, 'second is skipped');
  assert.strictEqual(env.queued.length, 1);
});

test('nothing is queued when the manager is not running', () => {
  const env = makeEnv();
  env.mgr.running = false;
  assert.strictEqual(env.mgr.dispatchNightlyClear(), false);
  assert.strictEqual(env.queued.length, 0);
});

// ---- arming, settings and lifecycle ----

test('startNightlyClear arms by default (enabled unless explicitly false)', async () => {
  const env = makeEnv();
  const next = await env.mgr.startNightlyClear();
  assert.ok(next, 'armed with no setting present');
  assert.strictEqual(next.getHours(), 0);
  assert.ok(env.mgr.nightlyClearTimer);
  env.mgr.stopNightlyClear();
});

test('startNightlyClear respects an explicit disable', async () => {
  const env = makeEnv();
  const next = await env.mgr.startNightlyClear({ enabled: false });
  assert.strictEqual(next, null);
  assert.strictEqual(env.mgr.nightlyClearTimer, null);
});

test('re-arming does not leave two timers running', async () => {
  const env = makeEnv();
  await env.mgr.startNightlyClear();
  const firstTimer = env.mgr.nightlyClearTimer;
  await env.mgr.startNightlyClear();
  assert.notStrictEqual(env.mgr.nightlyClearTimer, firstTimer, 'old timer replaced');

  // Only one fire's worth of work should be pending: drive the live timer and
  // confirm exactly one /clear is queued.
  env.mgr.stopNightlyClear();
  assert.strictEqual(env.mgr.nightlyClearTimer, null);
  assert.strictEqual(env.queued.length, 0);
});

test('stopNightlyClear clears the timer and the armed time', async () => {
  const env = makeEnv();
  await env.mgr.startNightlyClear();
  env.mgr.stopNightlyClear();
  assert.strictEqual(env.mgr.nightlyClearTimer, null);
  assert.strictEqual(env.mgr.nightlyClearAt, null);
});

test('an out-of-range configured hour falls back to midnight', async () => {
  const env = makeEnv();
  const next = await env.mgr.startNightlyClear({ hour: 47 });
  assert.strictEqual(next.getHours(), 0);
  env.mgr.stopNightlyClear();
});

// ---- the confirming Enter ----

test('the injected /clear is followed by one confirming Enter to 999', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const env = makeEnv();
    env.eventBus.emit('message:injected', { terminalId: 999, content: '/clear' });
    assert.strictEqual(env.sent.length, 0, 'not sent synchronously');

    mock.timers.tick(2000);

    assert.strictEqual(env.sent.length, 1);
    assert.strictEqual(env.sent[0].channel, 'terminal-input');
    assert.deepStrictEqual(env.sent[0].payload, { terminalId: 999, data: '\r' });
  } finally {
    mock.timers.reset();
  }
});

test('ordinary injections get no confirming Enter', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const env = makeEnv();
    env.eventBus.emit('message:injected', { terminalId: 999, content: 'do the thing' });
    env.eventBus.emit('message:injected', { terminalId: 3, content: '/clear' });
    mock.timers.tick(2000);
    assert.strictEqual(env.sent.length, 0);
  } finally {
    mock.timers.reset();
  }
});
