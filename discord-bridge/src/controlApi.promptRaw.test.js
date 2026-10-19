'use strict';

// T505: /prompt to a non-manager terminal must never be wrapped — the owner:
// "the /prompt command shouldn't do the wrap. regular messages r fine tho".
// queueMemo (the terminal-targeted /prompt path) queues text EXACTLY as
// typed, slash command or not. sendVoiceMemo (the 999 path) is unaffected
// and keeps framing everything, including a slash command. Run:
//   node --test src/controlApi.promptRaw.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const controlApi = require('./controlApi');

function fakeFetchCapturingBody() {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({ accepted: true }) };
    },
  };
}

test('queueMemo queues "/rc" byte-for-byte, no framing', async () => {
  const { calls, fetch } = fakeFetchCapturingBody();
  const realFetch = global.fetch;
  global.fetch = fetch;
  try {
    const r = await controlApi.queueMemo({ host: '127.0.0.1', port: 1, token: 't' }, 3, '/rc');
    assert.equal(r.ok, true);
    assert.equal(calls[0].body.content, '/rc');
  } finally { global.fetch = realFetch; }
});

test('queueMemo queues "hello there" byte-for-byte, no framing', async () => {
  const { calls, fetch } = fakeFetchCapturingBody();
  const realFetch = global.fetch;
  global.fetch = fetch;
  try {
    await controlApi.queueMemo({ host: '127.0.0.1', port: 1, token: 't' }, 3, 'hello there');
    assert.equal(calls[0].body.content, 'hello there');
  } finally { global.fetch = realFetch; }
});

test('queueMemo queues "/tmp/foo is broken" byte-for-byte, no framing', async () => {
  const { calls, fetch } = fakeFetchCapturingBody();
  const realFetch = global.fetch;
  global.fetch = fetch;
  try {
    await controlApi.queueMemo({ host: '127.0.0.1', port: 1, token: 't' }, 3, '/tmp/foo is broken');
    assert.equal(calls[0].body.content, '/tmp/foo is broken');
  } finally { global.fetch = realFetch; }
});

test('queueMemo still queues type "normal"', async () => {
  const { calls, fetch } = fakeFetchCapturingBody();
  const realFetch = global.fetch;
  global.fetch = fetch;
  try {
    await controlApi.queueMemo({ host: '127.0.0.1', port: 1, token: 't' }, 3, '/rc');
    assert.equal(calls[0].body.type, 'normal');
    assert.equal(calls[0].body.terminalId, 3);
  } finally { global.fetch = realFetch; }
});

test('queueMemo refuses an empty message with no text and no paths', async () => {
  const r = await controlApi.queueMemo({ host: '127.0.0.1', port: 1, token: 't' }, 3, '   ');
  assert.equal(r.ok, false);
  assert.match(r.error, /empty message/);
});

// ---- c2 regression: the 999 path (sendVoiceMemo) is UNCHANGED ------------

test('sendVoiceMemo still frames a slash command sent to 999 (unchanged)', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  try {
    await controlApi.sendVoiceMemo({ host: '127.0.0.1', port: 1, token: 't', managerId: 999 }, '/rc', { source: 'typed' });
    // sendKeys posts the framed text as a single-element `keys` array.
    const keysCall = calls.find((c) => c.url.endsWith('/terminal/keys') && Array.isArray(c.body.keys) && c.body.keys[0] !== 'enter');
    assert.ok(keysCall, 'expected a /terminal/keys call carrying the framed text');
    assert.match(keysCall.body.keys[0], /Typed message from the user \(Discord\)/);
    assert.match(keysCall.body.keys[0], /"\/rc"/);
  } finally { global.fetch = realFetch; }
});
