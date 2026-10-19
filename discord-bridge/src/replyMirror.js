'use strict';

// T521 (c3): the written "Replied:" copy of each manager (999) TTS reply must
// keep posting even while the bridge isn't in a voice call (e.g. right after
// leaving because the authorized user left — see voiceFollowGuard.js). Wired
// in index.js to a standalone, always-on TtsPoller (watchOnly: true, so it
// never fetches or plays audio) that runs for the life of the process,
// independent of BridgeSession's connection state.

function makeReplyMirrorNotifier(textMirror) {
  return (row) => {
    if (String(row.terminal_id) !== '999') return;
    if (row.text) textMirror.postReplied(row.text);
  };
}

module.exports = { makeReplyMirrorNotifier };
