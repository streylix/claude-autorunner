'use strict';

// DAVE (Discord's mandatory end-to-end-encrypted voice protocol, required since
// March 2026) integration check.
//
// @discordjs/voice (>=0.18) auto-detects an installed DAVE implementation; the
// known package is `@snazzah/davey`. There is no manual wiring step — if the
// package resolves at require-time, @discordjs/voice negotiates E2EE voice. If
// it's missing, voice connections to Discord will fail to reach Ready.
//
// This module just verifies the package is present and reports its version, so
// startup logs make a DAVE problem obvious instead of a mysterious timeout.

const log = require('./log');

function status() {
  try {
    const davey = require('@snazzah/davey');
    let version = 'unknown';
    try { version = require('@snazzah/davey/package.json').version; } catch (_) { /* ok */ }
    return { available: true, version, davey };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

function report() {
  const s = status();
  if (s.available) {
    log.success(`DAVE E2EE support present (@snazzah/davey v${s.version}).`);
  } else {
    log.warn('DAVE E2EE package (@snazzah/davey) NOT found — voice will likely fail to connect.');
    log.warn('Run `npm install` in discord-bridge/ to pull it in.');
  }
  return s;
}

module.exports = { status, report };
