'use strict';

// Unit tests for HookServer's pure helpers — the queue-type normalizer that
// guards POST /queue/add so an external controller's {type} is honored instead
// of silently dropped. Run: node --test src/main/HookServer.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const HookServer = require('./HookServer');

// POST helper against a started HookServer: returns { status, body }.
function post(server, urlPath, json) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(json));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          'X-CCBOT-Token': server.token,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

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

test('POST /queue/add rejects targeting the manager terminal (999)', async () => {
  const received = [];
  const server = new HookServer({ onEvent: () => {}, onQueueAdd: (p) => received.push(p) });
  await server.start();
  try {
    const blocked = await post(server, '/queue/add', { terminalId: 999, content: 'rm -rf ~' });
    assert.strictEqual(blocked.status, 403);
    assert.strictEqual(received.length, 0, 'manager-targeted add must not reach onQueueAdd');

    const ok = await post(server, '/queue/add', { terminalId: 2, content: 'hello' });
    assert.strictEqual(ok.status, 202);
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].terminalId, 2);
  } finally {
    server.close();
  }
});
