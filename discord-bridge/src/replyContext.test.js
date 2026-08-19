'use strict';

// Discord reply context: a reply forwards a short quote of the message it points
// at, so the manager stops guessing what "that one" meant. Covers the bot's own
// messages, the user's own, media-only references with no text, truncation, and
// the load-bearing guarantee that a NON-reply is framed byte-for-byte as before.
// Run: node --test src/replyContext.test.js

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1';

const { test } = require('node:test');
const assert = require('node:assert');

const replyContext = require('./replyContext');
const { frameMemo } = require('./controlApi');
const { config } = require('../config');

// Minimal stand-in for a discord.js Message — only the fields we read.
function msg({ content = '', username = 'someone', displayName, globalName, attachments = [], embeds = [], stickers } = {}) {
  return {
    content,
    author: { username, globalName },
    member: displayName ? { displayName } : null,
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
    embeds,
    stickers,
  };
}

test('a reply to a BOT message quotes it', () => {
  const ref = msg({ content: 'Deployed the change and restarted the bridge.', username: 'claude-code-bot' });
  const out = frameMemo('did it log in?', 'typed', [], replyContext.fromMessage(ref));
  assert.match(out, /↩ replying to claude-code-bot: "Deployed the change and restarted the bridge\."$/);
  assert.ok(out.startsWith(`${config.typedMemoMarker} "did it log in?"`));
});

test("a reply to the USER's own message quotes it, preferring the server nickname", () => {
  const ref = msg({ content: 'here is the plan', username: 'streylix', globalName: 'Ethan', displayName: 'Ethan' });
  const out = frameMemo('scratch that', 'typed', [], replyContext.fromMessage(ref));
  assert.match(out, /↩ replying to Ethan: "here is the plan"$/);
});

test('display name falls back handle → globalName → nickname order', () => {
  assert.equal(replyContext.authorName(msg({ username: 'streylix' })), 'streylix');
  assert.equal(replyContext.authorName(msg({ username: 'streylix', globalName: 'Ethan' })), 'Ethan');
  assert.equal(replyContext.authorName(msg({ username: 'streylix', globalName: 'Ethan', displayName: 'Boss' })), 'Boss');
});

test('a reply to an IMAGE with no text says so instead of quoting nothing', () => {
  const ref = msg({ content: '', attachments: [{ contentType: 'image/png', name: 'diagram.png' }] });
  const out = frameMemo('just the diagram', 'typed', [], replyContext.fromMessage(ref));
  assert.match(out, /↩ replying to someone: an image$/);
  assert.doesNotMatch(out, /: ""/, 'must never emit an empty quote');
});

test('media-only references are described by kind and count', () => {
  const kind = (atts, embeds = []) => replyContext.describeNonText(msg({ attachments: atts, embeds }));
  assert.equal(kind([{ contentType: 'video/mp4', name: 'clip.mp4' }]), 'a video');
  assert.equal(kind([{ contentType: 'audio/mpeg', name: 'a.mp3' }]), 'an audio clip');
  assert.equal(kind([{ contentType: 'application/pdf', name: 'spec.pdf' }]), 'a file');
  assert.equal(kind([{ contentType: 'image/png', name: 'a.png' }, { contentType: 'image/png', name: 'b.png' }]), '2 images');
  assert.equal(kind([{ contentType: 'image/png', name: 'a.png' }, { contentType: 'video/mp4', name: 'b.mp4' }]), '2 attachments');
  assert.equal(kind([], [{ title: 'a link' }]), 'an embed');
  assert.equal(kind([], []), 'a message with no text');
});

test('attachment kind falls back to the file extension when contentType is unset', () => {
  const kind = (a) => replyContext.describeNonText(msg({ attachments: [a] }));
  assert.equal(kind({ name: 'shot.JPG' }), 'an image');
  assert.equal(kind({ name: 'clip.mov' }), 'a video');
  assert.equal(kind({ name: 'notes.txt' }), 'a file');
});

test('the snippet is truncated to ~200 chars with an ellipsis', () => {
  const long = 'word '.repeat(120).trim(); // 599 chars
  const out = replyContext.snippet(long);
  assert.ok(out.length <= replyContext.SNIPPET_MAX + 1, `got ${out.length} chars`);
  assert.ok(out.endsWith('…'), 'truncated snippets end in an ellipsis');
  assert.ok(long.startsWith(out.slice(0, -1)), 'the kept prefix is verbatim');
});

test('a snippet at or under the limit is untouched — no stray ellipsis', () => {
  const short = 'x'.repeat(replyContext.SNIPPET_MAX);
  assert.equal(replyContext.snippet(short), short);
  assert.equal(replyContext.snippet('hello'), 'hello');
});

test('the snippet is collapsed to a SINGLE line', () => {
  const out = frameMemo('and this', 'typed', [], replyContext.fromMessage(msg({ content: 'line one\nline two\r\n\tline three' })));
  assert.doesNotMatch(out, /[\r\n]/, 'an embedded newline would submit early in Claude\'s TUI');
  assert.match(out, /"line one line two line three"/);
});

test('a NON-reply is framed byte-for-byte as it was before', () => {
  for (const [text, source, paths] of [
    ['hello there', 'typed', []],
    ['spoken words', 'voice', []],
    ['a caption', 'file', ['/tmp/a.png']],
    ['', 'file', ['/tmp/a.png', '/tmp/b.png']],
  ]) {
    const before = frameMemo(text, source, paths);           // 3-arg, as every existing caller does
    assert.equal(frameMemo(text, source, paths, null), before);
    assert.equal(frameMemo(text, source, paths, undefined), before);
    assert.ok(!before.includes('↩'), 'no reply marker leaks into a non-reply');
  }
});

test('a deleted / unfetchable reference degrades to no reply context', () => {
  assert.equal(replyContext.fromMessage(null), null);
  assert.equal(replyContext.format(null), '');
  assert.equal(frameMemo('orphaned reply', 'typed', [], replyContext.fromMessage(null)),
    frameMemo('orphaned reply', 'typed', []));
});

test('a file drop that is also a reply carries both', () => {
  const ref = msg({ content: 'can you crop this?', displayName: 'Ethan' });
  const out = frameMemo('here', 'file', ['/tmp/x.png'], replyContext.fromMessage(ref));
  assert.ok(out.includes('/tmp/x.png'));
  assert.match(out, /↩ replying to Ethan: "can you crop this\?"$/);
});
