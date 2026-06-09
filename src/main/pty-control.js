'use strict';

// PTY-level control for the loopback control API: raw keystrokes and Claude
// lifecycle (start / resume / restart). Lives in main (where the PTYs and the
// /proc runtime signal are), so it writes to the PTY directly with no renderer
// round-trip and uses P1's runtime as a safety guard.
//
// The guard is the point: injecting "claude" (or a multi-line prompt) as text
// only makes sense at a bare shell. Starting Claude is refused unless the
// terminal's runtime is 'shell', which prevents the multi-line-into-bash leak.
//
// Dependency-injected (ptyFor, runtimeFor, sleep) so it is unit-testable
// without Electron or node-pty.

// Named control keys -> the bytes a PTY expects. Lowercased keys for
// case-insensitive lookup. Anything not here is sent as literal text.
const KEY_TOKENS = {
  enter: '\r', return: '\r', cr: '\r',
  esc: '\x1b', escape: '\x1b',
  tab: '\t', 'shift+tab': '\x1b[Z',
  'ctrl+c': '\x03', 'ctrl+d': '\x04', 'ctrl+z': '\x1a',
  'ctrl+l': '\x0c', 'ctrl+u': '\x15', 'ctrl+a': '\x01', 'ctrl+e': '\x05', 'ctrl+r': '\x12',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  space: ' ', backspace: '\x7f', delete: '\x1b[3~',
  pageup: '\x1b[5~', pagedown: '\x1b[6~', home: '\x1b[H', end: '\x1b[F',
};

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const RESTART_DELAY_MS = 800; // let the shell return after interrupting Claude

// Translate keys (string or array) into a byte string. Known tokens become
// control bytes; unknown tokens pass through literally; the result is joined.
function translateKeys(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  return list
    .map((k) => {
      if (typeof k !== 'string') return '';
      const hit = KEY_TOKENS[k.toLowerCase()];
      return hit !== undefined ? hit : k;
    })
    .join('');
}

// Strip CR/LF and other control characters so a value can't smuggle an extra
// command past the trailing \r.
function sanitizeArgs(s) {
  return String(s).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
}

function writeToPty(pty, data) {
  pty.write(data);
  return data;
}

function sendKeys(terminalId, keys, deps) {
  const pty = deps.ptyFor(terminalId);
  if (!pty) return { ok: false, error: 'terminal not found' };
  const data = translateKeys(keys);
  writeToPty(pty, data);
  return { ok: true, terminalId, wrote: data.length };
}

// Build the `claude ...\r` command line for start/resume.
function claudeCommand(action, payload) {
  if (action === 'resume') {
    if (payload.sessionId != null && payload.sessionId !== '') {
      if (!SESSION_ID_RE.test(String(payload.sessionId))) return null; // unsafe
      return `claude --resume ${payload.sessionId}`;
    }
    return 'claude --continue';
  }
  // start
  const args = payload.args ? sanitizeArgs(payload.args) : '';
  return args ? `claude ${args}` : 'claude';
}

// Launch Claude in a terminal that is currently a bare shell. Refuses if Claude
// is already running or the runtime is unknown (don't blast text into an
// indeterminate state).
function launchClaude(terminalId, command, deps) {
  const pty = deps.ptyFor(terminalId);
  if (!pty) return { ok: false, error: 'terminal not found' };
  const runtime = deps.runtimeFor(terminalId);
  if (runtime === 'claude') return { ok: false, error: 'claude already running', runtime };
  if (runtime !== 'shell') return { ok: false, error: `refusing to start: terminal runtime is "${runtime}"`, runtime };
  writeToPty(pty, `${command}\r`);
  return { ok: true, terminalId, command, runtime };
}

async function restartClaude(terminalId, deps) {
  const pty = deps.ptyFor(terminalId);
  if (!pty) return { ok: false, error: 'terminal not found' };
  const runtime = deps.runtimeFor(terminalId);
  if (runtime !== 'claude') {
    // Nothing to interrupt — just (re)start from the shell.
    return launchClaude(terminalId, 'claude', deps);
  }
  // Interrupt the running Claude (Ctrl-C twice exits the TUI), wait for the
  // shell to return, then relaunch.
  writeToPty(pty, '\x03\x03');
  await deps.sleep(RESTART_DELAY_MS);
  const after = deps.runtimeFor(terminalId);
  if (after === 'shell') {
    writeToPty(pty, 'claude\r');
    return { ok: true, terminalId, action: 'restart', command: 'claude' };
  }
  return { ok: false, error: `could not confirm Claude exited (runtime "${after}")`, runtime: after };
}

// Entry point used by main's onControl router.
async function handlePtyControl(action, payload = {}, deps) {
  const terminalId = parseInt(payload.terminalId, 10);
  if (!Number.isInteger(terminalId)) return { ok: false, error: 'invalid terminalId' };

  if (action === 'terminal-keys') {
    return sendKeys(terminalId, payload.keys, deps);
  }

  if (action === 'terminal-claude') {
    const sub = payload.action;
    if (sub === 'restart') return restartClaude(terminalId, deps);
    if (sub === 'start' || sub === 'resume') {
      const command = claudeCommand(sub, payload);
      if (command == null) return { ok: false, error: 'invalid or unsafe sessionId' };
      return launchClaude(terminalId, command, deps);
    }
    return { ok: false, error: `unknown claude action "${sub}" (use start|resume|restart)` };
  }

  return { ok: false, error: `unknown control action "${action}"` };
}

module.exports = { KEY_TOKENS, translateKeys, sendKeys, handlePtyControl };
