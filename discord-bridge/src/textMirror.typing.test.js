'use strict';

// Typing indicator lifecycle: startTyping() pings channel.sendTyping()
// immediately and every ~7s (Discord expires the indicator after ~10s);
// stopTyping() — called by postText/postImage/postVideo/postReplied — clears
// the refresh interval and the 90s safety cap. Idempotent both ways; a
// sendTyping failure never throws into delivery.
// Run: node --test src/textMirror.typing.test.js

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '1';

const { test, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

const TextMirror = require('./textMirror');
const { config } = require('../config');

function mirrorWithFakeChannel() {
  const mirror = new TextMirror();
  const channel = {
    guildId: '1',
    name: 'claude-voice',
    typingCalls: 0,
    sent: [],
    sendTyping() { this.typingCalls += 1; return Promise.resolve(); },
    send(payload) { this.sent.push(payload); return Promise.resolve(); },
  };
  mirror.channel = channel;
  return { mirror, channel };
}

beforeEach(() => { config.textMirrorEnabled = true; });

test('startTyping pings immediately and refreshes every ~7s', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { mirror, channel } = mirrorWithFakeChannel();
  mirror.startTyping();
  await Promise.resolve(); // let the fire-and-forget ping settle
  assert.strictEqual(channel.typingCalls, 1, 'immediate ping');
  mock.timers.tick(7000); await Promise.resolve();
  mock.timers.tick(7000); await Promise.resolve();
  assert.strictEqual(channel.typingCalls, 3, 'refreshed twice by 14s');
  mirror.stopTyping();
  mock.timers.reset();
});

test('stopTyping halts refreshes and is idempotent', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { mirror, channel } = mirrorWithFakeChannel();
  mirror.startTyping();
  await Promise.resolve();
  mirror.stopTyping();
  mirror.stopTyping(); // second call must be a no-op, not a crash
  mock.timers.tick(30000); await Promise.resolve();
  assert.strictEqual(channel.typingCalls, 1, 'no pings after stop');
  mock.timers.reset();
});

test('auto-stops at the 90s cap', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { mirror, channel } = mirrorWithFakeChannel();
  mirror.startTyping();
  await Promise.resolve();
  mock.timers.tick(90000); await Promise.resolve();
  const atCap = channel.typingCalls;
  assert.ok(atCap >= 12, `refreshed while active (got ${atCap})`);
  mock.timers.tick(30000); await Promise.resolve();
  assert.strictEqual(channel.typingCalls, atCap, 'no pings after the cap');
  mock.timers.reset();
});

test('a fresh startTyping restarts the clock (idempotent start)', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { mirror, channel } = mirrorWithFakeChannel();
  mirror.startTyping();
  await Promise.resolve();
  mock.timers.tick(85000); await Promise.resolve(); // near the cap
  mirror.startTyping();                             // new submit → new 90s window
  await Promise.resolve();
  const before = channel.typingCalls;
  mock.timers.tick(10000); await Promise.resolve(); // past the ORIGINAL cap
  assert.ok(channel.typingCalls > before, 'still typing after original cap');
  mirror.stopTyping();
  mock.timers.reset();
});

test('postText/postReplied stop the indicator; delivery unaffected', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { mirror, channel } = mirrorWithFakeChannel();
  mirror.startTyping();
  await Promise.resolve();
  const ok = await mirror.postText('manager reply');
  assert.strictEqual(ok, true, 'postText still delivers');
  assert.strictEqual(channel.sent.length, 1);
  const afterPost = channel.typingCalls;
  mock.timers.tick(30000); await Promise.resolve();
  assert.strictEqual(channel.typingCalls, afterPost, 'typing stopped by postText');

  mirror.startTyping();
  await Promise.resolve();
  mirror.postReplied('spoken reply');
  const afterReplied = channel.typingCalls;
  mock.timers.tick(30000); await Promise.resolve();
  assert.strictEqual(channel.typingCalls, afterReplied, 'typing stopped by postReplied');
  mock.timers.reset();
});

test('no channel / disabled mirror → startTyping is a safe no-op', () => {
  const mirror = new TextMirror(); // no channel resolved
  assert.doesNotThrow(() => { mirror.startTyping(); mirror.stopTyping(); });
  const { mirror: m2 } = mirrorWithFakeChannel();
  config.textMirrorEnabled = false;
  assert.doesNotThrow(() => m2.startTyping());
  assert.strictEqual(m2._typingInterval, null, 'disabled mirror never arms timers');
});

test('sendTyping failures are swallowed (never disrupt delivery)', async () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { mirror, channel } = mirrorWithFakeChannel();
  channel.sendTyping = () => Promise.reject(new Error('boom'));
  assert.doesNotThrow(() => mirror.startTyping());
  await Promise.resolve(); await Promise.resolve();
  mirror.stopTyping();
  mock.timers.reset();
});
