'use strict';

// Sends transcribed speech to the manager terminal (999) via the Electron
// control API. Uses POST /terminal/keys, which — unlike /queue/add — has NO 999
// block, so the manager receives the text directly as if typed at its prompt.
//
// The text is framed with the voice-memo marker the manager's CLAUDE.md watches
// for, so it acknowledges out loud. Multi-line memos are wrapped in bracketed
// paste (ESC[200~ ... ESC[201~) so the embedded newline doesn't submit the
// prompt early in Claude's TUI; the trailing "enter" key submits.

const { config } = require('../config');
const log = require('./log');

const BRACKET_START = '[200~';
const BRACKET_END = '[201~';

// Build the framed memo text the manager sees.
function frameMemo(transcript) {
  const clean = String(transcript || '').trim();
  return `${config.voiceMemoMarker}\n"${clean}"`;
}

// Build the keys array for /terminal/keys. When bracketed paste is enabled the
// whole framed block pastes atomically, then a single Enter submits.
function buildKeys(framed) {
  if (config.useBracketedPaste) {
    return [BRACKET_START, framed, BRACKET_END, 'enter'];
  }
  return [framed, 'enter'];
}

// Send a transcript to the manager. Returns { ok, ... } from the control API.
async function sendVoiceMemoToManager(transcript) {
  if (!config.controlApiBase) {
    return { ok: false, error: 'control API base not configured (CCBOT_PORT missing)' };
  }
  const clean = String(transcript || '').trim();
  if (!clean) return { ok: false, error: 'empty transcript' };

  const framed = frameMemo(clean);
  const keys = buildKeys(framed);

  try {
    const res = await fetch(`${config.controlApiBase}/terminal/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CCBOT-Token': config.ccbotToken,
      },
      body: JSON.stringify({ terminalId: config.managerTerminalId, keys }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      log.error(`control API rejected memo (HTTP ${res.status}):`, JSON.stringify(data));
      return { ok: false, status: res.status, ...data };
    }
    log.success(`memo delivered to terminal ${config.managerTerminalId}: "${clean.slice(0, 80)}"`);
    return { ok: true, ...data };
  } catch (err) {
    log.error('control API request failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendVoiceMemoToManager, frameMemo, buildKeys };
