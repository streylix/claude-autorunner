'use strict';

// Unit tests for the completion-push dedup in ManagerInstance. data.text is
// the tail of the terminal's live screen buffer (raw TUI text - see
// renderer.js's 'stop' hook handling / readTerminalScreen), not a transcript
// "last assistant message" extraction - these tests are agnostic to that
// source and just exercise the dedup/dispatch logic on whatever text arrives.
// Run: node --test src/features/ManagerInstance.dedup.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const ManagerInstance = require('./ManagerInstance');

// Minimal environment: real ManagerInstance with a fake bus/gui, flipped to
// running so onTerminalCompletion flows through the real dispatch() into the
// (fake) message queue. Node has no `window`, so dispatch's remote guard passes.
function makeEnv() {
  const handlers = {};
  const queued = [];
  const eventBus = {
    on: (name, cb) => { (handlers[name] = handlers[name] || []).push(cb); },
    emit: () => {},
    fire: (name, payload) => (handlers[name] || []).forEach((cb) => cb(payload)),
  };
  const appStateStore = { getState: () => undefined };
  const gui = {
    terminalStateManager: { getTerminal: (id) => ({ title: `Worker ${id}` }) },
    messageQueueManager: { addMessage: (m) => queued.push(m) },
  };
  const mgr = new ManagerInstance(eventBus, appStateStore, {}, gui);
  mgr.running = true; // as after start(); completionWatchEnabled defaults true
  return { mgr, eventBus, queued };
}

function completion(env, terminalId, text) {
  env.eventBus.fire('completion:recorded', { terminalId, text, directory: '/tmp/x' });
}

test('pushes a completion to the manager queue with id, title and text', () => {
  const env = makeEnv();
  completion(env, 3, 'All tests pass.');
  assert.strictEqual(env.queued.length, 1);
  assert.strictEqual(env.queued[0].terminalId, 999);
  assert.match(env.queued[0].content, /Terminal 3 \("Worker 3"\)/);
  assert.match(env.queued[0].content, /All tests pass\./);
});

test('drops an identical re-push for the same terminal', () => {
  const env = makeEnv();
  completion(env, 3, 'All tests pass.');
  completion(env, 3, 'All tests pass.');
  completion(env, 3, 'All tests pass.');
  assert.strictEqual(env.queued.length, 1);
});

test('a different text from the same terminal pushes again', () => {
  const env = makeEnv();
  completion(env, 3, 'Step one done.');
  completion(env, 3, 'Step two done.');
  assert.strictEqual(env.queued.length, 2);
});

test('the same text from DIFFERENT terminals is not cross-deduped', () => {
  const env = makeEnv();
  completion(env, 3, 'Done.');
  completion(env, 4, 'Done.');
  assert.strictEqual(env.queued.length, 2);
});

test('dedup checks recent history, not just the last push: A, B, A pushes only A and B', () => {
  const env = makeEnv();
  completion(env, 3, 'A');
  completion(env, 3, 'B');
  completion(env, 3, 'A');
  assert.strictEqual(env.queued.length, 2);
  assert.match(env.queued[0].content, /\bA\b/);
  assert.match(env.queued[1].content, /\bB\b/);
});

test('history is bounded per terminal: text re-surfacing after the limit pushes again', () => {
  const env = makeEnv();
  // completionHistoryLimit is 5 - push 6 distinct texts so 'msg-0' ages out,
  // then re-push it: it's no longer in the retained history, so it goes again.
  for (let i = 0; i < 6; i++) completion(env, 3, `msg-${i}`);
  assert.strictEqual(env.queued.length, 6);
  completion(env, 3, 'msg-0');
  assert.strictEqual(env.queued.length, 7);
  // But a text still within the retained window is still deduped.
  completion(env, 3, 'msg-5');
  assert.strictEqual(env.queued.length, 7);
});

test('skips pushes whose text is just a [tool_use: …] marker', () => {
  const env = makeEnv();
  completion(env, 3, '[tool_use: Bash, Read]');
  assert.strictEqual(env.queued.length, 0);
});

test('whitespace-padded duplicates still dedup (text is trimmed before compare)', () => {
  const env = makeEnv();
  completion(env, 3, 'All tests pass.');
  completion(env, 3, '  All tests pass.\n');
  assert.strictEqual(env.queued.length, 1);
});

// data.text is now the tail of the terminal's live screen buffer (raw TUI
// text: box-drawing chars, wrapped lines, spinner frames), not a transcript
// "last assistant message". These document that the push/dedup path handles
// that shape correctly, unmodified.
test('raw screen-buffer tail text (box-drawing, wrapped lines) is pushed verbatim and dedups', () => {
  const env = makeEnv();
  const tail = '╭─ Terminal ─────╮\n│ Done. Ready for │\n│ next input.      │\n╰──────────────────╯\n> ';
  completion(env, 3, tail);
  completion(env, 3, tail); // identical re-push (e.g. duplicate Stop hook) - deduped
  assert.strictEqual(env.queued.length, 1);
  assert.match(env.queued[0].content, /Ready for/);
});

test('a screen tail that only differs by a spinner frame is treated as new (not falsely deduped)', () => {
  const env = makeEnv();
  completion(env, 3, 'Working... ⠋');
  completion(env, 3, 'Working... ⠙');
  assert.strictEqual(env.queued.length, 2);
});
