'use strict';

// Unit tests for prompt-detector.js — recognizing a genuine Claude Code
// interactive prompt/menu from a terminal screen dump (vs ordinary output or a
// long "thinking" turn). Pure node. Run: node --test src/features/prompt-detector.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { detectPrompt } = require('./prompt-detector');

test('detects a boxed permission prompt with cursor + options', () => {
  const screen = [
    '╭──────────────────────────────────────────────╮',
    '│ Bash command                                   │',
    '│   rm -rf build                                 │',
    '│                                                │',
    '│ Do you want to proceed?                        │',
    '│ ❯ 1. Yes                                       │',
    "│   2. Yes, and don't ask again this session     │",
    '│   3. No, and tell Claude what to do (esc)      │',
    '╰──────────────────────────────────────────────╯',
  ].join('\n');
  const r = detectPrompt(screen);
  assert.ok(r, 'should detect a prompt');
  assert.strictEqual(r.question, 'Do you want to proceed?');
  assert.strictEqual(r.options.length, 3);
  assert.strictEqual(r.options[0].num, 1);
  assert.strictEqual(r.options[0].text, 'Yes');
  assert.strictEqual(r.options[2].num, 3);
  assert.match(r.options[1].text, /don't ask again/);
});

test('detects an unboxed edit-confirmation prompt', () => {
  const screen = [
    'I will update renderer.js to add the helper.',
    '',
    'Do you want to make this edit to renderer.js?',
    '❯ 1. Yes',
    '  2. Yes, allow all edits this session (shift+tab)',
    '  3. No, and tell Claude what to do differently (esc)',
  ].join('\n');
  const r = detectPrompt(screen);
  assert.ok(r);
  assert.strictEqual(r.question, 'Do you want to make this edit to renderer.js?');
  assert.strictEqual(r.options.length, 3);
  assert.strictEqual(r.options[0].text, 'Yes');
});

test('detects an interactive select menu (AskUserQuestion style)', () => {
  const screen = [
    'Which approach should I take?',
    '❯ 1. Rewrite the module',
    '  2. Patch in place',
    '  3. Leave it as-is',
    '',
  ].join('\n');
  const r = detectPrompt(screen);
  assert.ok(r);
  assert.strictEqual(r.options.length, 3);
  assert.strictEqual(r.question, 'Which approach should I take?');
});

test('ignores ordinary numbered prose with no selection cursor', () => {
  const screen = [
    "Here's the plan:",
    '1. First we read the file',
    '2. Then we edit it',
    '3. Then we run tests',
    'Let me start now.',
  ].join('\n');
  assert.strictEqual(detectPrompt(screen), null);
});

test('ignores a long thinking turn (spinner, no menu)', () => {
  const screen = [
    '✻ Thinking… (esc to interrupt)',
    '  Considering the architecture and tradeoffs',
    '',
    '  ⎿ Running tests',
  ].join('\n');
  assert.strictEqual(detectPrompt(screen), null);
});

test('ignores a single numbered option (not a menu)', () => {
  const screen = ['Note:', '❯ 1. Only one option here'].join('\n');
  assert.strictEqual(detectPrompt(screen), null);
});

test('handles empty / null input', () => {
  assert.strictEqual(detectPrompt(''), null);
  assert.strictEqual(detectPrompt(null), null);
  assert.strictEqual(detectPrompt(undefined), null);
});

test('falls back to a placeholder question when none is above the options', () => {
  const screen = ['❯ 1. Yes', '  2. No'].join('\n');
  const r = detectPrompt(screen);
  assert.ok(r);
  assert.strictEqual(r.question, '(awaiting input)');
  assert.strictEqual(r.options.length, 2);
});
