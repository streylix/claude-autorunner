'use strict';

// T521 (c2): when the authorized user leaves, the bridge must disconnect
// within 5s. voiceFollowGuard.test.js proves the DECISION is correct; this
// proves the real BridgeSession.leave() teardown it drives actually
// completes fast (well under the 5s budget), using the same object shapes
// index.js wires up (poller/capture/player/receiver with stop()/detach()).

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test-token';
process.env.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || 'g1';

const BridgeSession = require('./session');
const { userLeftTrackedChannel } = require('./voiceFollowGuard');

function makeConnectedSession() {
  const session = new BridgeSession({ receiver: { detach() {}, attach() {}, getHealth: () => ({}) }, textMirror: null });
  session.connection = { state: { status: 'ready' }, destroy() {} };
  session.channelId = 'C1';
  session.guildId = 'g1';
  session.poller = { stop() {} };
  session.capture = { stop() {} };
  session.player = { stop() {}, enqueue() {} };
  return session;
}

test('c2: the authorized user leaving our channel triggers leave(), done well within 5s', async () => {
  const session = makeConnectedSession();
  const decision = userLeftTrackedChannel({
    trackedChannelId: session.channelId,
    userId: 'u-boss',
    oldChannelId: 'C1',
    newChannelId: null,
    isAuthorized: () => true,
  });
  assert.equal(decision, true, 'the guard must say to leave');

  const t0 = Date.now();
  await session.leave();
  const elapsedMs = Date.now() - t0;

  assert.ok(elapsedMs < 5000, `leave() took ${elapsedMs}ms — must be under 5000ms`);
  assert.equal(session.connection, null, 'connection must be torn down');
  assert.equal(session.canPlayAudio(), false, 'no audio path can be open after leaving');
});

test('c2 control: someone else leaving the same channel never calls leave()', () => {
  const session = makeConnectedSession();
  let leaveCalled = false;
  session.leave = async () => { leaveCalled = true; };
  const decision = userLeftTrackedChannel({
    trackedChannelId: session.channelId,
    userId: 'u-other',
    oldChannelId: 'C1',
    newChannelId: null,
    isAuthorized: (id) => id === 'u-boss',
  });
  if (decision) session.leave();
  assert.equal(decision, false);
  assert.equal(leaveCalled, false);
});
