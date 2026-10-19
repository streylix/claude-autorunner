'use strict';

// Regression test for the OUTBOUND half of the duplicate-message bug. Run:
//   node --test src/imageOutbox.claim.test.js
//
// When two bridges were live, both polled the same outbox directory and both
// posted the same descriptor before either deleted it — the manager's replies
// showed up twice in #claude-voice (13 identical consecutive posts in one
// 60-message window). Consuming a descriptor now starts with an atomic rename,
// so exactly one watcher can post it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'test-guild';

const { config } = require('../config');
const ImageOutbox = require('./imageOutbox');

function freshOutbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbot-outbox-'));
  config.imageOutboxDir = dir;
  return dir;
}

// channelFor() is how the watcher picks the target channel (the default one
// unless the descriptor named another), so every fake mirror must answer it.
function channelForDefault() {
  return async function (requested) {
    return { channel: this.channel, name: 'claude-voice', fallback: false,
             requested: requested || null, reason: null };
  };
}

function mirror(posts) {
  return {
    channel: { id: 'chan' },              // "in a channel" → eligible to post
    channelFor: channelForDefault(),
    postText: async (t) => { posts.push(t); },
  };
}

test('two watchers on one descriptor → exactly one post', async () => {
  const dir = freshOutbox();
  fs.writeFileSync(path.join(dir, '1-text.json'), JSON.stringify({ text: 'hello once' }));
  const posts = [];
  const a = new ImageOutbox({ textMirror: mirror(posts) });
  const b = new ImageOutbox({ textMirror: mirror(posts) });

  await Promise.all([a._tick(), b._tick()]);

  assert.deepEqual(posts, ['hello once']);
  assert.deepEqual(fs.readdirSync(dir), [], 'the descriptor is consumed exactly once');
});

test('a single watcher still posts and consumes normally', async () => {
  const dir = freshOutbox();
  fs.writeFileSync(path.join(dir, '1-text.json'), JSON.stringify({ text: 'solo' }));
  const posts = [];
  const a = new ImageOutbox({ textMirror: mirror(posts) });

  await a._tick();
  await a._tick(); // a second pass must find nothing left to post

  assert.deepEqual(posts, ['solo']);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a failed post hands the descriptor back for the next tick', async () => {
  const dir = freshOutbox();
  fs.writeFileSync(path.join(dir, '1-text.json'), JSON.stringify({ text: 'retry me' }));
  const posts = [];
  let fail = true;
  const flaky = {
    channel: { id: 'chan' },
    channelFor: channelForDefault(),
    postText: async (t) => {
      if (fail) { fail = false; throw new Error('discord 503'); }
      posts.push(t);
    },
  };
  const a = new ImageOutbox({ textMirror: flaky });

  await a._tick();
  assert.deepEqual(posts, [], 'first attempt failed');
  assert.deepEqual(fs.readdirSync(dir), ['1-text.json'], 'descriptor restored for retry');

  await a._tick();
  assert.deepEqual(posts, ['retry me']);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('descriptors are left queued (not claimed) while the bot has no channel', async () => {
  const dir = freshOutbox();
  fs.writeFileSync(path.join(dir, '1-text.json'), JSON.stringify({ text: 'later' }));
  const a = new ImageOutbox({ textMirror: { channel: null, channelFor: channelForDefault(), postText: async () => {} } });

  await a._tick();

  assert.deepEqual(fs.readdirSync(dir), ['1-text.json'], 'still queued for when the bot joins');
});
