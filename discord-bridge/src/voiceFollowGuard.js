'use strict';

// Pure decisions for voiceStateUpdate — kept here (not inline in index.js) so
// they're unit-testable without a live Discord connection.

// T521 (c2): the bridge leaves when the AUTHORIZED user leaves the channel
// it's bridging — whether they left voice entirely or moved elsewhere, either
// way they're no longer in our channel. Someone else leaving, or the
// authorized user leaving a DIFFERENT channel than ours, changes nothing.
function userLeftTrackedChannel({ trackedChannelId, userId, oldChannelId, newChannelId, isAuthorized }) {
  if (!trackedChannelId) return false; // not in a call — nothing to leave
  if (oldChannelId !== trackedChannelId) return false; // wasn't in our channel
  if (newChannelId === trackedChannelId) return false; // still here
  return !!isAuthorized(userId);
}

// AUTO-FOLLOW (c4): join the authorized user's channel when they join one
// while linked and idle. Unchanged from the pre-T521 inline logic in
// index.js — extracted verbatim so it's covered by the same test file as the
// new leave guard.
function shouldAutoFollow({ newChannelId, oldChannelId, isAuthorized, isLinked, sessionActive }) {
  if (!newChannelId || oldChannelId === newChannelId) return false; // joins/moves only
  if (!isAuthorized) return false;
  if (!isLinked || sessionActive) return false;
  return true;
}

module.exports = { userLeftTrackedChannel, shouldAutoFollow };
