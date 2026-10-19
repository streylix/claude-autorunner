'use strict';

// T523: a long Heard:/Replied: echo used to be sliced to 1,900 chars with no
// marker, so a ten-minute voice message lost its tail silently. Every character
// must now arrive, in order, in messages of at most 2,000 characters, with the
// label on the first message only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { config } = require('../config');
const TextMirror = require('./textMirror');

const LABEL = '🎙️ **Heard:**';
const settle = () => new Promise((r) => setTimeout(r, 30));

function mirror() {
  const sent = [];
  const tm = new TextMirror();
  tm.channel = { id: 'c', name: 'claude-voice', send: async (p) => { sent.push(p); return { id: 'm' }; } };
  config.textMirrorEnabled = true;
  return { tm, sent };
}

// Distinct, position-dependent text so a dropped, repeated or reordered chunk shows.
function body(n) {
  let s = '';
  for (let i = 0; s.length < n; i++) s += `w${i} `;
  return s.slice(0, n).trim().padEnd(n, 'x');
}

test('a 5,000-char postHeard arrives whole, in order, label on the first only', async () => {
  const { tm, sent } = mirror();
  const text = body(5000);
  tm.postHeard(text);
  await settle();

  assert.ok(sent.length > 1, `must be split, got ${sent.length} message(s)`);
  for (const m of sent) assert.ok(m.content.length <= 2000, `message of ${m.content.length} chars`);
  assert.ok(sent[0].content.startsWith(`${LABEL} `), 'label on the first');
  for (const m of sent.slice(1)) assert.ok(!m.content.includes('Heard:'), 'label on the first only');
  const rebuilt = sent[0].content.slice(LABEL.length + 1) + sent.slice(1).map((m) => m.content).join('');
  assert.equal(rebuilt, text, 'every character, in order');
});

test('postReplied splits the same way', async () => {
  const { tm, sent } = mirror();
  const text = body(4100);
  tm.postReplied(text);
  await settle();
  const label = '💬 **Replied:**';
  assert.ok(sent.every((m) => m.content.length <= 2000));
  assert.equal(sent[0].content.slice(label.length + 1) + sent.slice(1).map((m) => m.content).join(''), text);
});

test('a 100-char body still posts exactly once', async () => {
  const { tm, sent } = mirror();
  const text = body(100);
  tm.postHeard(text);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, `${LABEL} ${text}`);
});

test('a body that exactly fills one message is not split', async () => {
  const { tm, sent } = mirror();
  const text = body(2000 - LABEL.length - 1);
  tm.postHeard(text);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content.length, 2000);
});

test('back-to-back posts do not interleave their chunks', async () => {
  const { tm, sent } = mirror();
  tm.postHeard(body(4500));
  tm.postReplied('short');
  await settle();
  assert.match(sent[sent.length - 1].content, /Replied/, 'the later post lands last');
});

test('a long file caption is split, not cut: tail follows as extra messages', async () => {
  const { tm, sent } = mirror();
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-')), 'draft.md');
  fs.writeFileSync(f, '# hi');
  const caption = body(4500);
  assert.equal(await tm.postFile(f, caption), true);
  assert.ok(sent[0].files && sent[0].files.length === 1, 'file rides on the first message');
  assert.ok(sent.every((m) => (m.content || '').length <= 2000));
  assert.equal(sent.map((m) => m.content).join(''), caption, 'whole caption delivered');
  assert.ok(sent.slice(1).every((m) => !m.files), 'file attached once');
});

test('a short caption is still one message', async () => {
  const { tm, sent } = mirror();
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-')), 'draft.md');
  fs.writeFileSync(f, '# hi');
  assert.equal(await tm.postFile(f, 'hello'), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'hello');
});
