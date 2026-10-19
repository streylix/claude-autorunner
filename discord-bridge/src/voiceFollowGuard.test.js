'use strict';

// T521: the bridge must leave when the authorized user leaves its voice
// channel, and must not be fooled by anyone else leaving (c2). The existing
// "auto-follow" join decision is covered too (c4) — extracted here, unchanged,
// so both are pure and unit-testable without a live Discord connection.

const { test } = require('node:test');
const assert = require('node:assert');

const { userLeftTrackedChannel, shouldAutoFollow } = require('./voiceFollowGuard');

test('c2: the authorized user leaving the bridge\'s channel → true', () => {
  const left = userLeftTrackedChannel({
    trackedChannelId: 'C1',
    userId: 'u-boss',
    oldChannelId: 'C1',
    newChannelId: null, // left voice entirely
    isAuthorized: () => true,
  });
  assert.equal(left, true);
});

test('c2: the authorized user moving to a different channel → also leave (no longer in ours)', () => {
  const left = userLeftTrackedChannel({
    trackedChannelId: 'C1',
    userId: 'u-boss',
    oldChannelId: 'C1',
    newChannelId: 'C2',
    isAuthorized: () => true,
  });
  assert.equal(left, true);
});

test('c2: someone else leaving the channel → false (not the authorized user)', () => {
  const left = userLeftTrackedChannel({
    trackedChannelId: 'C1',
    userId: 'u-other',
    oldChannelId: 'C1',
    newChannelId: null,
    isAuthorized: (id) => id === 'u-boss',
  });
  assert.equal(left, false);
});

test('c2: the authorized user leaving a DIFFERENT channel than the one we\'re in → false', () => {
  const left = userLeftTrackedChannel({
    trackedChannelId: 'C1',
    userId: 'u-boss',
    oldChannelId: 'C9', // was never in our tracked channel
    newChannelId: null,
    isAuthorized: () => true,
  });
  assert.equal(left, false);
});

test('c2: no tracked channel (bridge not in a call) → false, nothing to leave', () => {
  const left = userLeftTrackedChannel({
    trackedChannelId: null,
    userId: 'u-boss',
    oldChannelId: 'C1',
    newChannelId: null,
    isAuthorized: () => true,
  });
  assert.equal(left, false);
});

test('c2: the authorized user staying in the same channel (mute toggle etc.) → false', () => {
  const left = userLeftTrackedChannel({
    trackedChannelId: 'C1',
    userId: 'u-boss',
    oldChannelId: 'C1',
    newChannelId: 'C1',
    isAuthorized: () => true,
  });
  assert.equal(left, false);
});

test('c4: authorized user joining while linked and idle → auto-follow', () => {
  const should = shouldAutoFollow({
    newChannelId: 'C1',
    oldChannelId: null,
    isAuthorized: true,
    isLinked: true,
    sessionActive: false,
  });
  assert.equal(should, true);
});

test('c4: not authorized → never auto-follow', () => {
  const should = shouldAutoFollow({
    newChannelId: 'C1',
    oldChannelId: null,
    isAuthorized: false,
    isLinked: true,
    sessionActive: false,
  });
  assert.equal(should, false);
});

test('c4: already active (in a call) → no duplicate follow', () => {
  const should = shouldAutoFollow({
    newChannelId: 'C1',
    oldChannelId: null,
    isAuthorized: true,
    isLinked: true,
    sessionActive: true,
  });
  assert.equal(should, false);
});

test('c4: not linked → no follow', () => {
  const should = shouldAutoFollow({
    newChannelId: 'C1',
    oldChannelId: null,
    isAuthorized: true,
    isLinked: false,
    sessionActive: false,
  });
  assert.equal(should, false);
});

test('c4: no new channel (a leave, not a join) → no follow', () => {
  const should = shouldAutoFollow({
    newChannelId: null,
    oldChannelId: 'C1',
    isAuthorized: true,
    isLinked: true,
    sessionActive: false,
  });
  assert.equal(should, false);
});
