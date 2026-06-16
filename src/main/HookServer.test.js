'use strict';

// Unit tests for HookServer's pure helpers — the queue-type normalizer that
// guards POST /queue/add so an external controller's {type} is honored instead
// of silently dropped. Run: node --test src/main/HookServer.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const HookServer = require('./HookServer');

test('normalizeQueueType keeps valid types', () => {
  assert.strictEqual(HookServer.normalizeQueueType('normal'), 'normal');
  assert.strictEqual(HookServer.normalizeQueueType('urgent'), 'urgent');
});

test('normalizeQueueType defaults unknown / missing to normal', () => {
  assert.strictEqual(HookServer.normalizeQueueType('important'), 'normal');
  assert.strictEqual(HookServer.normalizeQueueType(undefined), 'normal');
  assert.strictEqual(HookServer.normalizeQueueType(null), 'normal');
  assert.strictEqual(HookServer.normalizeQueueType(''), 'normal');
  assert.strictEqual(HookServer.normalizeQueueType(42), 'normal');
});

test('inject-now is a registered control route', () => {
  assert.ok(HookServer.CONTROL_ROUTES['/queue/inject-now']);
  assert.strictEqual(HookServer.CONTROL_ROUTES['/queue/inject-now'], 'queue-inject-now');
});
