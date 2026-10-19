'use strict';

// Tests for transcript-reader's recent-message parsing (P3 transcript endpoint).
// Builds a fixture JSONL matching the real Claude Code transcript schema.
// Run: node --test src/main/transcript-reader.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Transcript reads are contained to ~/.claude/projects in production; allow the
// temp-dir fixtures used here (production never sets this env var).
process.env.CCBOT_TRANSCRIPT_ROOTS = os.tmpdir();
const { readRecentMessages, buildTranscriptResponse } = require('./transcript-reader');

function writeFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbot-tx-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const ts = (s) => `2026-06-08T23:0${s}:00.000Z`;
const FIXTURE = [
  { type: 'user', isSidechain: false, timestamp: ts(1), message: { role: 'user', content: 'Build the thing' } },
  { type: 'assistant', isSidechain: false, timestamp: ts(2), message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }, // thinking-only -> skip
  { type: 'assistant', isSidechain: false, timestamp: ts(3), message: { role: 'assistant', content: [{ type: 'text', text: 'Sure, starting now.' }] } },
  { type: 'assistant', isSidechain: false, timestamp: ts(4), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }, { type: 'tool_use', name: 'Edit', input: {} }] } }, // tool-only -> marker
  { type: 'user', isSidechain: false, timestamp: ts(5), message: { role: 'user', content: [{ type: 'tool_result', content: 'exit 0' }] } }, // tool output -> skip
  { type: 'system', timestamp: ts(6), content: 'system note' }, // non-message -> skip
  { type: 'user', isSidechain: true, timestamp: ts(7), message: { role: 'user', content: 'subagent chatter' } }, // sidechain -> skip
  { type: 'user', isSidechain: false, timestamp: ts(8), message: { role: 'user', content: 'Looks good, ship it' } },
];

test('parses only conversational turns, in chronological order', () => {
  const file = writeFixture(FIXTURE);
  const msgs = readRecentMessages(file, { limit: 50 });
  assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant', 'assistant', 'user']);
  assert.strictEqual(msgs[0].text, 'Build the thing');
  assert.strictEqual(msgs[1].text, 'Sure, starting now.');
  assert.match(msgs[2].text, /\[tool_use: Bash, Edit\]/);
  assert.strictEqual(msgs[3].text, 'Looks good, ship it');
});

test('includes timestamps', () => {
  const file = writeFixture(FIXTURE);
  const msgs = readRecentMessages(file, { limit: 50 });
  assert.strictEqual(msgs[0].ts, ts(1));
  assert.strictEqual(msgs[3].ts, ts(8));
});

test('limit returns the LAST n conversational messages', () => {
  const file = writeFixture(FIXTURE);
  const msgs = readRecentMessages(file, { limit: 2 });
  assert.strictEqual(msgs.length, 2);
  assert.deepStrictEqual(msgs.map((m) => m.text), ['[tool_use: Bash, Edit]', 'Looks good, ship it']);
});

test('handles string and array text content; truncates long text', () => {
  const long = 'x'.repeat(5000);
  const file = writeFixture([
    { type: 'assistant', isSidechain: false, timestamp: ts(1), message: { role: 'assistant', content: [{ type: 'text', text: long }] } },
  ]);
  const msgs = readRecentMessages(file, { limit: 10, maxTextLength: 100 });
  assert.strictEqual(msgs.length, 1);
  assert.ok(msgs[0].text.length < 200);
  assert.match(msgs[0].text, /truncated/);
});

test('returns null for an unreadable transcript', () => {
  assert.strictEqual(readRecentMessages('/no/such/file.jsonl', {}), null);
  assert.strictEqual(readRecentMessages(null, {}), null);
});

test('skips malformed JSON lines without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbot-tx-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, '{bad json\n' + JSON.stringify({ type: 'user', isSidechain: false, timestamp: ts(1), message: { role: 'user', content: 'hi' } }) + '\n');
  const msgs = readRecentMessages(file, { limit: 10 });
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].text, 'hi');
});

// ---- path containment (arbitrary-file-read fix) ----

test('isTrustedTranscriptPath contains reads to .jsonl under a trusted root', () => {
  const { isTrustedTranscriptPath } = require('./transcript-reader');
  // A real .jsonl under the (test-)trusted tmp root is accepted.
  const ok = writeFixture(FIXTURE);
  assert.strictEqual(isTrustedTranscriptPath(ok), true);
  // A real file that is not .jsonl is rejected even under a trusted root.
  const notJsonl = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccbot-tx-')), 'secret.txt');
  fs.writeFileSync(notJsonl, 'nope');
  assert.strictEqual(isTrustedTranscriptPath(notJsonl), false);
  // A path outside any trusted root is rejected.
  assert.strictEqual(isTrustedTranscriptPath('/etc/hostname'), false);
  assert.strictEqual(isTrustedTranscriptPath(null), false);
});

test('readLastAssistantText refuses an out-of-root path (arbitrary file read)', () => {
  const { readLastAssistantText } = require('./transcript-reader');
  // Simulate the /hook-event attack: point at a sensitive file outside roots.
  assert.strictEqual(readLastAssistantText('/etc/hostname'), null);
});

// ---- buildTranscriptResponse (resolves path from the /state snapshot) ----

test('buildTranscriptResponse returns messages for a terminal with a transcript', () => {
  const file = writeFixture(FIXTURE);
  const snapshot = { terminals: [{ id: 3, sessionId: 'sess-abc', transcriptPath: file, title: 'Worker' }] };
  const r = buildTranscriptResponse({ terminalId: 3, limit: 2 }, snapshot);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.terminalId, 3);
  assert.strictEqual(r.sessionId, 'sess-abc');
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.messages.length, 2);
});

test('buildTranscriptResponse fails cleanly when the terminal has no transcript yet', () => {
  const snapshot = { terminals: [{ id: 3, sessionId: null, transcriptPath: null, title: 'Fresh' }] };
  const r = buildTranscriptResponse({ terminalId: 3 }, snapshot);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no transcript/i);
});

test('buildTranscriptResponse fails cleanly for an unknown terminal or missing snapshot', () => {
  assert.strictEqual(buildTranscriptResponse({ terminalId: 9 }, { terminals: [] }).ok, false);
  assert.strictEqual(buildTranscriptResponse({ terminalId: 9 }, null).ok, false);
});
