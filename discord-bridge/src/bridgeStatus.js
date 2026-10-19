'use strict';

// Report the bridge's "active" state (linked to a manager session AND currently
// in a voice channel) to the Django backend, so the desktop app can mute its
// local-mic wake word while the bot is in a call — preventing a double trigger
// when the user is in the same room as the host mic.
//
// Fire-and-forget like log.js: errors are swallowed so this can never disrupt
// voice. A periodic heartbeat keeps the backend's state fresh; the backend
// expires it if we stop reporting (crash/quit), so the app fails safe (local
// wake word comes back) rather than staying muted forever.

const { config } = require('../config');

const ENDPOINT = '/api/voice/bridge-status/';
const DEFAULT_INTERVAL_MS = 2500; // < the backend's 8s TTL, so it never goes stale while alive

async function post(active) {
  try {
    await fetch(`${config.backendUrl}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !!active }),
    });
  } catch (_) { /* status reporting must never throw */ }
}

// active = linked AND in a voice channel.
function computeActive(linkManager, session) {
  let linked = true;
  try { if (typeof linkManager.isLinked === 'function') linked = linkManager.isLinked(); } catch (_) {}
  let inVoice = false;
  try { inVoice = !!session.isActive(); } catch (_) {}
  return linked && inVoice;
}

// Start heartbeating the current active state. Returns { report, stop }:
//   report() — POST immediately (use right after join/leave for a snappy update)
//   stop()   — clear the heartbeat
function startBridgeStatusReporter({ linkManager, session, intervalMs = DEFAULT_INTERVAL_MS }) {
  const tick = () => post(computeActive(linkManager, session));
  tick(); // report initial (inactive) state right away
  const timer = setInterval(tick, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    report: tick,
    stop: () => clearInterval(timer),
  };
}

module.exports = { startBridgeStatusReporter, computeActive, _post: post };
