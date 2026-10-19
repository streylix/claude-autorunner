'use strict';

// Tests for the Codex manager stand-in (T636): /manager codex opens a Codex
// terminal in the manager's directory, primes it, and records the stand-in so
// inbound Discord messages route there; /manager claude hands back. State lives
// in a small JSON file so it survives a bridge restart. Run:
//   node --test src/standIn.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbot-standin-'));
process.env.CCBOT_STANDIN_STORE = path.join(tmpDir, 'standin.json');
process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'test-guild';

const StandIn = require('./standIn');
const { config } = require('../config');

const TARGET = { host: '127.0.0.1', port: 36319, token: 'tok', managerId: 999 };

// A fake control API: records every call, answers like the app would.
function fakeFetch(overrides = {}) {
  const calls = [];
  const screen = overrides.screen != null ? overrides.screen : '>_ OpenAI Codex (v0.162.0)\n› ';
  // overrides.screens: successive /terminal/screen reads return these in order
  // (the last one repeats) — for dialogs that appear and then go away.
  const screens = overrides.screens ? overrides.screens.slice() : null;
  const stateTerminals = overrides.terminals || [{ id: 999, status: 'prompted' }, { id: 42, status: '...' }];
  global.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || 'GET', body, headers: init.headers || {} });
    const u = new URL(url);
    const json = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
    if (u.pathname === '/terminal/create') return json({ ok: true, terminalId: 42 });
    if (u.pathname === '/terminal/keys') return json({ ok: true, terminalId: body.terminalId, wrote: 1 });
    if (u.pathname === '/terminal/screen') {
      const scr = screens ? (screens.length > 1 ? screens.shift() : screens[0]) : screen;
      return json({ ok: true, terminalId: body.terminalId, screen: scr, rows: 40, cols: 120 });
    }
    if (u.pathname === '/terminal/delete') {
      if (overrides.deleteMissing) return json({ ok: false, error: 'terminal not found' }, false, 404);
      return json({ ok: true, terminalId: body.terminalId });
    }
    if (u.pathname === '/queue/add') return json({ accepted: true, terminalId: body.terminalId, type: body.type });
    if (u.pathname === '/state') return json({ terminals: stateTerminals });
    throw new Error(`unexpected fetch ${url}`);
  };
  return calls;
}

const noSleep = async () => {};

beforeEach(() => {
  try { fs.unlinkSync(process.env.CCBOT_STANDIN_STORE); } catch (_) {}
});

test('buildCodexCommand is a single shell line that starts Codex primed with the manager context', () => {
  const cmd = StandIn.buildCodexCommand();
  assert.ok(!/[\r\n]/.test(cmd), 'must be one line — a newline would submit early in the shell');
  assert.match(cmd, /^codex /);
  assert.match(cmd, /-a never/);
  assert.match(cmd, /-s workspace-write/);
  assert.match(cmd, /sandbox_workspace_write\.network_access=true/);
  assert.match(cmd, /-C \/mnt\/smalls\/claude-manager/);
  // Project trust passed on the command line, so a first-run "Trust this
  // folder?" dialog is not needed (and ~/.codex/config.toml is never edited).
  assert.match(cmd, /-c 'projects\."\/mnt\/smalls\/claude-manager"\.trust_level="trusted"'/);
});

test('buildCodexCommand opens the bridge outbox as a writable root so bin/tell can post', () => {
  // Live failure 2026-10-11: workspace-write mounts $XDG_RUNTIME_DIR read-only,
  // so post-text.js could not write its descriptor and bin/tell refused.
  const cmd = StandIn.buildCodexCommand();
  const outbox = StandIn.bridgeOutboxDir();
  assert.match(outbox, /\/ccbot-bridge\/outbox$/, 'the dir the bridge watches for descriptors');
  assert.equal(outbox, config.imageOutboxDir, 'same dir the outbox watcher reads');
  assert.ok(cmd.includes(`-c 'sandbox_workspace_write.writable_roots=${JSON.stringify([outbox])}'`), cmd);
  // Still the scoped sandbox — not a blanket bypass.
  assert.match(cmd, /-s workspace-write/);
  assert.doesNotMatch(cmd, /danger-full-access|dangerously-bypass/);
  assert.match(cmd, /\/mnt\/smalls\/claude-manager\/CLAUDE\.md/);
  assert.match(cmd, /-mnt-smalls-claude-manager\/memory\/MEMORY\.md/);
  assert.match(cmd, /bin\/tell/);
  assert.match(cmd, /CCBOT_PORT/);
});

test('start() creates the terminal in the manager dir, types the codex command, confirms, persists', async () => {
  const calls = fakeFetch();
  const s = new StandIn({ sleep: noSleep });
  const r = await s.start(TARGET);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.terminalId, 42);
  assert.equal(r.confirmed, true);
  assert.equal(s.activeTerminalId(), 42);

  const create = calls.find((c) => c.url.endsWith('/terminal/create'));
  assert.ok(create, 'must POST /terminal/create');
  assert.equal(create.body.directory, '/mnt/smalls/claude-manager');
  assert.match(create.body.title, /codex/i);
  assert.equal(create.headers['X-CCBOT-Token'], 'tok');

  const keys = calls.filter((c) => c.url.endsWith('/terminal/keys'));
  assert.ok(keys.length >= 2, 'types the command, then a separate enter');
  assert.equal(keys[0].body.terminalId, 42);
  assert.match(keys[0].body.keys[0], /^codex /);
  assert.deepEqual(keys[1].body.keys, ['enter']);

  const screenReads = calls.filter((c) => c.url.endsWith('/terminal/screen'));
  assert.ok(screenReads.length >= 1, 'confirms via /terminal/screen');
  assert.equal(screenReads[0].body.scrollback, true);

  const stored = JSON.parse(fs.readFileSync(process.env.CCBOT_STANDIN_STORE, 'utf8'));
  assert.equal(stored.active, true);
  assert.equal(stored.terminalId, 42);
  assert.equal(stored.port, 36319);
  assert.equal(stored.engine, 'codex');
});

test('start() when already active returns the existing terminal and creates nothing', async () => {
  const calls = fakeFetch();
  const s = new StandIn({ sleep: noSleep });
  await s.start(TARGET);
  const before = calls.filter((c) => c.url.endsWith('/terminal/create')).length;
  const r = await s.start(TARGET);
  assert.equal(r.ok, true);
  assert.equal(r.terminalId, 42);
  assert.equal(r.alreadyActive, true);
  assert.equal(calls.filter((c) => c.url.endsWith('/terminal/create')).length, before);
});

test('start() falls back to an urgent /queue/add when the screen never shows Codex, and stays active', async () => {
  const calls = fakeFetch({ screen: 'ethan@pop-os:/mnt/smalls/claude-manager$ ' });
  const s = new StandIn({ sleep: noSleep, confirmPolls: 2 });
  const r = await s.start(TARGET);
  assert.equal(r.ok, true);
  assert.equal(r.confirmed, false);
  assert.equal(s.activeTerminalId(), 42);
  const q = calls.find((c) => c.url.endsWith('/queue/add'));
  assert.ok(q, 'retries through /queue/add');
  assert.equal(q.body.terminalId, 42);
  assert.equal(q.body.type, 'urgent');
  assert.match(q.body.content, /^codex /);
});

test('start() refuses when not linked', async () => {
  fakeFetch();
  const s = new StandIn({ sleep: noSleep });
  const r = await s.start(null);
  assert.equal(r.ok, false);
  assert.match(r.error, /not linked/);
});

test('stop() deletes the Codex terminal and clears the stored state', async () => {
  const calls = fakeFetch();
  const s = new StandIn({ sleep: noSleep });
  await s.start(TARGET);
  const r = await s.stop(TARGET);
  assert.equal(r.ok, true);
  assert.equal(r.terminalId, 42);
  assert.equal(r.deleted, true);
  assert.equal(s.activeTerminalId(), null);
  const del = calls.find((c) => c.url.endsWith('/terminal/delete'));
  assert.equal(del.body.terminalId, 42);
  const stored = JSON.parse(fs.readFileSync(process.env.CCBOT_STANDIN_STORE, 'utf8'));
  assert.equal(stored.active, false);
});

test('stop() when the terminal is already gone still clears state', async () => {
  fakeFetch();
  const s = new StandIn({ sleep: noSleep });
  await s.start(TARGET);
  fakeFetch({ deleteMissing: true });
  const r = await s.stop(TARGET);
  assert.equal(r.ok, true);
  assert.equal(r.deleted, false);
  assert.equal(s.activeTerminalId(), null);
});

test('stop() when nothing is active is a no-op', async () => {
  fakeFetch();
  const s = new StandIn({ sleep: noSleep });
  const r = await s.stop(TARGET);
  assert.equal(r.ok, true);
  assert.equal(r.wasActive, false);
});

test('state survives a restart: a fresh instance reads the active stand-in back from disk', async () => {
  fakeFetch();
  const a = new StandIn({ sleep: noSleep });
  await a.start(TARGET);
  const b = new StandIn({ sleep: noSleep });
  assert.equal(b.activeTerminalId(), 42);
  assert.equal(b.status().active, true);
  assert.equal(b.status().terminalId, 42);
});

test('restore() keeps the stand-in when its terminal is still in /state on the same port', async () => {
  fakeFetch();
  const a = new StandIn({ sleep: noSleep });
  await a.start(TARGET);
  const b = new StandIn({ sleep: noSleep });
  const r = await b.restore(TARGET);
  assert.equal(r.kept, true);
  assert.equal(b.activeTerminalId(), 42);
});

test('restore() clears the stand-in when its terminal has vanished from /state', async () => {
  fakeFetch();
  const a = new StandIn({ sleep: noSleep });
  await a.start(TARGET);
  fakeFetch({ terminals: [{ id: 999, status: 'prompted' }] });
  const b = new StandIn({ sleep: noSleep });
  const r = await b.restore(TARGET);
  assert.equal(r.kept, false);
  assert.match(r.reason, /no longer exists/);
  assert.equal(b.activeTerminalId(), null);
});

test('restore() clears the stand-in when the app port changed (app restarted → terminals gone)', async () => {
  fakeFetch();
  const a = new StandIn({ sleep: noSleep });
  await a.start(TARGET);
  const b = new StandIn({ sleep: noSleep });
  const r = await b.restore({ ...TARGET, port: 40000 });
  assert.equal(r.kept, false);
  assert.match(r.reason, /port/);
  assert.equal(b.activeTerminalId(), null);
});

test('restore() with nothing stored is a no-op', async () => {
  fakeFetch();
  const b = new StandIn({ sleep: noSleep });
  const r = await b.restore(TARGET);
  assert.equal(r.kept, false);
  assert.equal(r.reason, 'none');
});

test('a change to the store written by another process is picked up without a restart', async () => {
  fakeFetch();
  const bridge = new StandIn({ sleep: noSleep });
  assert.equal(bridge.activeTerminalId(), null);
  const cli = new StandIn({ sleep: noSleep });
  await cli.start(TARGET);
  // Force a visibly different mtime even on coarse filesystems.
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(process.env.CCBOT_STANDIN_STORE, t, t);
  assert.equal(bridge.activeTerminalId(), 42, 'the bridge sees the CLI-started stand-in');
  await cli.stop(TARGET);
  const t2 = new Date(Date.now() + 10000);
  fs.utimesSync(process.env.CCBOT_STANDIN_STORE, t2, t2);
  assert.equal(bridge.activeTerminalId(), null, 'and sees the hand-back');
});

const TRUST_SCREEN = 'Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.\n'
  + '> 1. Trust and continue\n  2. Open restricted\n  3. Open\n';

test('start() answers the Codex "Trust this folder?" dialog and still confirms', async () => {
  const calls = fakeFetch({ screens: [TRUST_SCREEN, TRUST_SCREEN, '>_ OpenAI Codex (v0.162.0)\n› '] });
  const s = new StandIn({ sleep: noSleep });
  const r = await s.start(TARGET);
  assert.equal(r.ok, true);
  assert.equal(r.confirmed, true);
  assert.equal(r.trustPrompt, true, 'reports that the dialog appeared');
  const keys = calls.filter((c) => c.url.endsWith('/terminal/keys')).map((c) => c.body.keys);
  // command, enter, then the dialog answers: Enter (default = Trust and continue), then "1"+Enter.
  assert.deepEqual(keys.slice(2), [['enter'], ['1', 'enter']]);
  assert.ok(keys.every((k) => true) && calls.filter((c) => c.url.endsWith('/terminal/keys')).every((c) => c.body.terminalId === 42));
  assert.equal(calls.filter((c) => c.url.endsWith('/queue/add')).length, 0, 'no urgent retry needed once the dialog is answered');
  const stored = JSON.parse(fs.readFileSync(process.env.CCBOT_STANDIN_STORE, 'utf8'));
  assert.equal(stored.trustPrompt, true);
});

test('start() without a trust dialog sends exactly command + enter and reports trustPrompt false', async () => {
  const calls = fakeFetch();
  const s = new StandIn({ sleep: noSleep });
  const r = await s.start(TARGET);
  assert.equal(r.trustPrompt, false);
  assert.equal(calls.filter((c) => c.url.endsWith('/terminal/keys')).length, 2);
});

test('the trust dialog is never mistaken for a running Codex', () => {
  assert.ok(StandIn.TRUST_PROMPT_RE.test(TRUST_SCREEN));
  assert.ok(!StandIn.CODEX_READY_RE.test(TRUST_SCREEN));
});
