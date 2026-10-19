'use strict';

// DURABLE conversation log. Ships every message exchanged with the user — both
// directions, typed or spoken, text or media — to the backend so it survives
// the manager's context being wiped (/clear, compaction) and the app restarting.
//
// Same contract as log.js: fire-and-forget, never throws, never blocks and
// never fails delivery. If the backend is down, the message still goes to
// Discord and still reaches the manager; we just lose that one log row. That
// is a deliberate trade — logging is never allowed to break the bridge.
//
// Endpoint: POST /api/conversation/messages/ (backend app conversation_log).

const { config } = require('../config');
const log = require('./log');

const TIMEOUT_MS = 4000;
const WARN_THROTTLE_MS = 60_000; // an outage shouldn't flood the log stream

// Under `node --test` the endpoint is redirected to a reserved, unroutable
// address AND the transport is swapped for a sink. Two independent guards,
// because a test suite must not be able to reach the real backend at all —
// not "should not", cannot. Cleaning production up afterwards is a chore
// somebody eventually forgets.
const UNROUTABLE = 'http://127.0.0.1:1';
const UNDER_TEST = !!process.env.NODE_TEST_CONTEXT;

let lastWarnAt = 0;

function warn(msg) {
  const now = Date.now();
  if (now - lastWarnAt < WARN_THROTTLE_MS) return;
  lastWarnAt = now;
  log.warn(`conversation log: ${msg} (message delivery unaffected).`);
}

function endpoint() {
  return `${UNDER_TEST ? UNROUTABLE : config.backendUrl}/api/conversation/messages/`;
}

// The real transport: one HTTP POST. Resolves to the new id, or null.
async function fetchTransport(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res || !res.ok) {
    warn(`backend returned ${res ? res.status : 'no response'}`);
    return null;
  }
  const body = await res.json().catch(() => null);
  return body && body.id != null ? body.id : null;
}

// The test-runner transport: goes nowhere, touches no socket.
async function sinkTransport() { return null; }

let transport = UNDER_TEST ? sinkTransport : fetchTransport;

// Tests inject their own poster to observe payloads — they never stub global
// fetch for this module, so there is no path from the suite to the network.
function setTransport(fn) { transport = typeof fn === 'function' ? fn : sinkTransport; }
function resetTransport() { transport = UNDER_TEST ? sinkTransport : fetchTransport; }

// POST one row. Resolves to the new message id, or null on any failure.
async function post(payload) {
  if (!config.conversationLogEnabled) return null;
  try {
    return await transport(endpoint(), payload);
  } catch (err) {
    warn(err && err.message ? err.message : 'request failed');
    return null;
  }
}

// Build a row from loose args. `paths` may hold several saved files; the first
// goes in media_path (the indexed column) and all of them in meta.
function build(direction, { text, kind, destination, paths, meta, externalId } = {}) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  // Belt and braces behind the config default above: if a row is ever written
  // from under the test runner anyway, it is marked synthetic at write time, so
  // it can never be read back later as something the user actually said.
  const synthetic = process.env.NODE_TEST_CONTEXT ? { synthetic: true } : null;
  const row = {
    direction,
    destination: destination || 'discord',
    kind: kind || 'text',
    text: text == null ? '' : String(text),
    media_path: list[0] || '',
    meta: Object.assign({}, meta, list.length > 1 ? { media_paths: list } : null, synthetic),
  };
  if (externalId) row.external_id = String(externalId);
  return row;
}

// User -> manager. `source` is linkManager's: 'voice' | 'typed' | 'file'.
function recordInbound(opts = {}) {
  try {
    return post(build('inbound', opts));
  } catch (_) { return Promise.resolve(null); }
}

// Manager -> user (a post that actually went out to Discord).
function recordOutbound(opts = {}) {
  try {
    return post(build('outbound', opts));
  } catch (_) { return Promise.resolve(null); }
}

// Map linkManager's opts.source onto the log's `kind` column.
function kindForSource(source, paths) {
  if (Array.isArray(paths) && paths.length) return 'file';
  if (source === 'voice' || !source) return 'voice';
  return 'text';
}

module.exports = {
  recordInbound, recordOutbound, kindForSource, post, build,
  // Injection points (tests only) + the guards, exported so they can be asserted.
  setTransport, resetTransport, fetchTransport, endpoint, UNROUTABLE, UNDER_TEST,
};
