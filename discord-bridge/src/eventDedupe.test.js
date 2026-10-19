'use strict';

// Regression tests for the duplicate-delivery guard. Run:
//   node --test src/eventDedupe.test.js
//
// Context: one Discord message was being handled TWICE (two inbox files, two
// forwards to the manager) because a second bridge process was live on the same
// bot token — Discord delivers every gateway event to EVERY session. The lock
// (singleInstance.js) stops that at the source; this guard is the backstop, and
// it also covers gateway RESUME replays, which redeliver events to one process.

const { test } = require('node:test');
const assert = require('node:assert');

const EventDedupe = require('./eventDedupe');

test('the first sighting of an id is fresh, every repeat is a duplicate', () => {
  const d = new EventDedupe();
  assert.equal(d.seen('123'), false); // first delivery → process it
  assert.equal(d.seen('123'), true);  // second delivery → drop it
  assert.equal(d.seen('123'), true);
  assert.equal(d.seen('456'), false); // a different message is unaffected
});

test('two handlers racing on the same message id: exactly one wins', () => {
  const d = new EventDedupe();
  const id = '100000000000000002';
  const handled = [1, 2, 3, 4].filter(() => !d.seen(id));
  assert.equal(handled.length, 1, 'exactly one of four deliveries may be processed');
});

test('entries expire after the TTL so the guard never grows stale', () => {
  let now = 1000;
  const d = new EventDedupe({ ttlMs: 500, clock: () => now });
  assert.equal(d.seen('a'), false);
  now = 1400;
  assert.equal(d.seen('a'), true, 'still inside the TTL → duplicate');
  now = 1600;
  assert.equal(d.seen('a'), false, 'past the TTL → treated as new again');
});

test('memory is bounded — oldest ids are evicted past the cap', () => {
  const d = new EventDedupe({ max: 3 });
  ['a', 'b', 'c'].forEach((k) => d.seen(k));
  assert.equal(d.size, 3);
  d.seen('d'); // evicts 'a'
  assert.equal(d.size, 3);
  assert.equal(d.seen('d'), true, 'newest id is remembered');
  assert.equal(d.seen('a'), false, 'oldest id was evicted');
});

test('missing/blank ids are never deduped (fail open — never drop a real message)', () => {
  const d = new EventDedupe();
  assert.equal(d.seen(undefined), false);
  assert.equal(d.seen(undefined), false);
  assert.equal(d.seen(''), false);
  assert.equal(d.seen(null), false);
});
