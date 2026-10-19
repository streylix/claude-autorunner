'use strict';

// Tests for the controlApi pieces backing /terminals and /prompt's terminal
// option: reading the full /state terminal list, and queueing a message to a
// non-manager terminal via POST /queue/add. Run:
//   node --test src/controlApi.terminals.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const controlApi = require('./controlApi');

test('getFullState reads terminals from GET /state', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ terminals: [{ id: 4, title: 'jade', status: 'running' }] }) };
  };
  try {
    const terminals = await controlApi.getFullState({ host: '127.0.0.1', port: 44073, token: 'tok' });
    assert.deepEqual(terminals, [{ id: 4, title: 'jade', status: 'running' }]);
    assert.equal(calls[0].url, 'http://127.0.0.1:44073/state');
    assert.equal(calls[0].init.headers['X-CCBOT-Token'], 'tok');
  } finally { global.fetch = realFetch; }
});

test('getFullState refuses when the bridge is not linked', async () => {
  await assert.rejects(() => controlApi.getFullState(null), /not linked/);
});

test('getFullState turns HTTP failures into readable errors', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503 });
  try {
    await assert.rejects(
      () => controlApi.getFullState({ port: 1, token: 't' }),
      /503/);
  } finally { global.fetch = realFetch; }
});

test('queueMemo posts RAW content to /queue/add with type normal (T505: no framing)', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ accepted: true, terminalId: 4, type: 'normal' }) };
  };
  try {
    const r = await controlApi.queueMemo({ host: '127.0.0.1', port: 44073, token: 'tok' }, 4, 'hello there');
    assert.equal(r.ok, true);
    assert.equal(calls[0].url, 'http://127.0.0.1:44073/queue/add');
    assert.equal(calls[0].init.method, 'POST');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.terminalId, 4);
    assert.equal(body.type, 'normal');
    // T505 superseded the framing this test used to require — see
    // controlApi.promptRaw.test.js for full byte-for-byte coverage.
    assert.equal(body.content, 'hello there');
  } finally { global.fetch = realFetch; }
});

test('queueMemo reports a rejection (e.g. terminal 999) instead of throwing', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'cannot queue to the manager terminal (999)' }) });
  try {
    const r = await controlApi.queueMemo({ host: '127.0.0.1', port: 44073, token: 'tok' }, 999, 'x');
    assert.equal(r.ok, false);
    assert.match(r.error, /manager terminal/);
  } finally { global.fetch = realFetch; }
});

test('queueMemo refuses when not linked', async () => {
  const r = await controlApi.queueMemo(null, 4, 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /not linked/);
});
