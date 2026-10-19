'use strict';

// T521 (c3): the written "Replied:" text copy must keep posting even while
// the bridge is not in a voice call — this notifier is wired to an always-on
// TtsPoller in index.js (watchOnly: true, so it never fetches/plays audio),
// completely independent of BridgeSession's connection state.

const { test } = require('node:test');
const assert = require('node:assert');

const { makeReplyMirrorNotifier } = require('./replyMirror');

function fakeMirror() {
  const posted = [];
  return { posted, postReplied: (text) => posted.push(text) };
}

test('c3: a terminal-999 row with text → posted as the written copy', () => {
  const mirror = fakeMirror();
  const notify = makeReplyMirrorNotifier(mirror);
  notify({ terminal_id: '999', text: 'hello there' });
  assert.deepEqual(mirror.posted, ['hello there']);
});

test('c3: terminal_id may arrive as a number — still matches 999', () => {
  const mirror = fakeMirror();
  const notify = makeReplyMirrorNotifier(mirror);
  notify({ terminal_id: 999, text: 'numeric id' });
  assert.deepEqual(mirror.posted, ['numeric id']);
});

test('a row for a different terminal is never mirrored', () => {
  const mirror = fakeMirror();
  const notify = makeReplyMirrorNotifier(mirror);
  notify({ terminal_id: '7', text: 'not the manager' });
  assert.deepEqual(mirror.posted, []);
});

test('a row with no text produces no post', () => {
  const mirror = fakeMirror();
  const notify = makeReplyMirrorNotifier(mirror);
  notify({ terminal_id: '999', text: '' });
  notify({ terminal_id: '999' });
  assert.deepEqual(mirror.posted, []);
});
