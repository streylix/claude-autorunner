'use strict';

// Sends transcribed speech to the manager terminal (999) via the Electron
// control API. Uses POST /terminal/keys, which — unlike /queue/add — has NO 999
// block, so the manager receives the text directly as if typed at its prompt.
//
// The TARGET (host/port/token) is no longer static config: it comes from the
// active link (see linkManager.js / linkVault.js), so the bot follows whatever
// session the user linked it to. host is always 127.0.0.1 (loopback, same box).
//
// The text is framed with the voice-memo marker the manager's CLAUDE.md watches
// for. Memos are collapsed to a SINGLE line (see frameMemo) — Claude's TUI
// treats an embedded newline as submit — and the trailing "enter" key submits.

const { config } = require('../config');
const { interruptStopWords } = require('./appSettings');
const log = require('./log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// After an ESC interrupt, give the manager's TUI a beat to abort the turn and
// return to its prompt before the new message is typed in.
const INTERRUPT_SETTLE_MS = 250;

/** First word of a message, lowercased with surrounding punctuation trimmed —
 *  Whisper renders "No, stop." so the raw first token is usually "No,". */
function firstToken(text) {
  const t = String(text || '').trim().split(/\s+/)[0] || '';
  return t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
}

// SINGLE-LINE framing, branched by SOURCE so the manager can tell how the input
// arrived (spoken / typed / a file). Everything stays on ONE line — Claude's TUI
// treats an embedded newline as submit — so whitespace is collapsed to spaces.
//   source 'voice' → voice-memo wrapper (spoken/auto-transcribed)
//   source 'typed' → typed-message wrapper (verbatim text)
//   source 'file'  → file wrapper (the local path(s), + any caption)
function frameMemo(text, source = 'voice', paths = []) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  let out;
  if (source === 'file') {
    const list = (paths || []).join(' | ');
    const n = (paths || []).length;
    const lead = `${config.fileMemoMarker} ${n === 1 ? 'a file' : `${n} files`} (Discord): ${list}`;
    out = clean ? `${lead} — message: "${clean}"` : lead;
  } else if (source === 'typed') {
    out = `${config.typedMemoMarker} "${clean}"`;
  } else {
    out = `${config.voiceMemoMarker} "${clean}"`;
  }
  return out.replace(/[\r\n]+$/g, '');
}

function baseUrl(target) {
  return `http://${target.host || '127.0.0.1'}:${target.port}`;
}

// One POST to /terminal/keys.
async function sendKeys(target, keys) {
  const res = await fetch(`${baseUrl(target)}/terminal/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CCBOT-Token': target.token },
    body: JSON.stringify({ terminalId: target.managerId || 999, keys }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

// Pending app-queue snapshot (GET /queue): [{ id, terminalId, content, type }].
async function getQueue(target) {
  const res = await fetch(`${baseUrl(target)}/queue`, {
    headers: { 'X-CCBOT-Token': target.token },
  });
  if (!res.ok) throw new Error(`GET /queue returned HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.queue) ? data.queue : [];
}

// Drop ONE pending queued message (POST /queue/update {remove:true}).
async function removeQueuedMessage(target, messageId) {
  const res = await fetch(`${baseUrl(target)}/queue/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CCBOT-Token': target.token },
    body: JSON.stringify({ messageId, remove: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`HTTP ${res.status} ${JSON.stringify(data)}`);
  }
}

// Jump-the-line prep for a stop-word interrupt: drop every message still
// pending for the manager in the app's queue. Must run BEFORE the ESC — the
// instant the ESC idles the manager, the app auto-injects whatever is queued
// for it, so any stale entry left behind would be processed AHEAD of the
// interrupting message. A message the app is already mid-injecting can't be
// removed (the app refuses) — that one has already left the queue race anyway.
// Returns how many were removed.
async function purgeManagerQueue(target, mgrId) {
  const stale = (await getQueue(target)).filter((m) => Number(m.terminalId) === Number(mgrId));
  let removed = 0;
  for (const m of stale) {
    try {
      await removeQueuedMessage(target, m.id);
      removed++;
    } catch (err) {
      log.warn(`stop-word purge: could not remove queued message ${m.id}: ${err.message}`);
    }
  }
  return removed;
}

// Read-only health check used to validate a link before accepting it.
async function checkState(target) {
  const res = await fetch(`${baseUrl(target)}/state`, {
    headers: { 'X-CCBOT-Token': target.token },
  });
  if (!res.ok) throw new Error(`control API /state returned HTTP ${res.status}`);
  const data = await res.json();
  const mgr = (data.terminals || []).find((t) => Number(t.id) === (target.managerId || 999));
  return { reachable: true, managerPresent: !!mgr, managerStatus: mgr ? mgr.status : null };
}

// Deliver a message to the manager terminal. opts.source ∈ 'voice'|'typed'|'file'
// picks the framing; opts.paths carries saved file paths for the 'file' source.
async function sendVoiceMemo(target, text, opts = {}) {
  if (!target || !target.port || !target.token) {
    return { ok: false, error: 'not linked to a session' };
  }
  const source = opts.source || 'voice';
  const paths = opts.paths || [];
  const clean = String(text || '').trim();
  // Text is required except for a pure file drop (which has paths but maybe no caption).
  if (!clean && !(source === 'file' && paths.length)) return { ok: false, error: 'empty message' };

  const framed = frameMemo(clean, source, paths);
  const mgrId = target.managerId || 999;

  // STOP-WORD INTERRUPT (voice only): a spoken message that BEGINS with a
  // configured stop word means "cut off whatever you're doing and take THIS —
  // NOW, ahead of anything else queued". Ordering is load-bearing:
  //   1. PURGE the manager's pending app-queue messages (purgeManagerQueue) —
  //      once the ESC idles the manager, the app auto-injects whatever is
  //      queued for it, and those stale messages would beat this one.
  //   2. ESC — aborts the manager's in-flight turn.
  //   3. Settle, then type + submit below. /terminal/keys is direct input
  //      (the manager-safe path; /queue/add refuses 999), so with the queue
  //      emptied this message is the very next thing the manager processes.
  // The WHOLE message is injected — the stop word is not stripped, so the
  // manager also sees the user's phrasing. The word list mirrors the app's
  // interruptStopWords setting LIVE (appSettings.js). Every interrupt step is
  // non-fatal: the message must still be delivered.
  if (source === 'voice') {
    const token = firstToken(clean);
    if (token && interruptStopWords().includes(token)) {
      try {
        const removed = await purgeManagerQueue(target, mgrId);
        if (removed) {
          log.warn(`stop-word "${token}" → dropped ${removed} stale queued message(s) for terminal ${mgrId}`);
        }
      } catch (err) {
        log.error('stop-word queue purge failed (continuing with ESC + inject):', err.message);
      }
      try {
        await sendKeys(target, ['esc']);
        log.warn(`stop-word "${token}" → ESC sent to terminal ${mgrId}; injecting the interrupting message next`);
        await sleep(INTERRUPT_SETTLE_MS);
      } catch (err) {
        log.error('stop-word ESC failed (message still injected):', err.message);
      }
    }
  }

  try {
    // Mirror the app's MessageQueueManager.typeMessageToTerminal: write the TEXT
    // first, then send the Enter (carriage return) as a SEPARATE keystroke after
    // a short delay, so the TUI has flushed the pasted text before the submit
    // lands. Sending [text, enter] in one shot leaves the message unsubmitted.
    await sendKeys(target, [framed]);
    await sleep(config.submitDelayMs);
    await sendKeys(target, ['enter']); // 'enter' -> '\r' (PTY carriage return)
    log.success(`${source} message submitted to terminal ${mgrId}: "${framed.slice(0, 90)}"`);
    return { ok: true };
  } catch (err) {
    log.error('control API memo failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { frameMemo, firstToken, checkState, sendVoiceMemo };
