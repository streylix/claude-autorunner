'use strict';

// Drive a terminal's running/idle status from ACTUAL SCREEN CHANGE instead of
// Claude Code's Stop/UserPromptSubmit hooks, which toggle unreliably (missed
// stops leave a terminal pinned 'running'; missed prompt-submits leave a busy
// terminal looking idle and invite an injection into a live turn).
//
// The signal is the PTY output stream the app already emits per chunk
// (terminal:data — one event per screen change). This module does NOTHING but
// stamp a timestamp on that hot path; all judgement happens on ONE coarse 1s
// interval, StuckWatchManager-style. No polling of screen contents, no hashing.
//
// The state machine, per terminal:
//   episode  — a contiguous run of output; a gap >= QUIET_DEBOUNCE_MS ends it
//   running  — an episode that has stayed active >= RUNNING_THRESHOLD_MS
//   stopped  — a running episode going quiet: status back to idle, and ONE
//              report pushed to the manager (999) with the tail of the screen
//
// Episodes that end before the 10s threshold are silent by design — quick
// turns are noise, so nothing is written and nothing is reported. This module
// is the SOLE authority for running <-> idle; 'prompted' stays hook-driven
// (Notification is the one reliable hook) and is never overridden here.

const MANAGER_TERMINAL_ID = 999;

// ---- Tunables ----
// How long output must keep arriving before a terminal is called 'running'.
const RUNNING_THRESHOLD_MS = 10000;
// Silence that ends an episode. Also the "is it still active" window.
// 5s, not 2.5s: a quiet gap mid-turn read as "stopped" costs a spurious
// manager report plus running->idle->running flapping, which is worse than
// hearing about a real stop ~2.5s later.
const QUIET_DEBOUNCE_MS = 5000;
// The single coarse clock. Everything above is evaluated here, nowhere else.
const EVAL_INTERVAL_MS = 1000;
// Report size: last N non-empty lines of the visible screen, hard-capped by chars.
const REPORT_MAX_LINES = 15;
const REPORT_MAX_CHARS = 800;

// Statuses owned by other, more authoritative sources. A terminal sitting in
// one of these is left completely alone — no promotion to running, no clearing.
const PROTECTED_STATUSES = new Set(['prompted', 'error', 'injecting']);

// Box-drawing + block-element glyphs: TUI chrome that carries no information
// once the frame is flattened to text (U+2500-257F box drawing, U+2580-259F blocks).
const BOX_CHARS_RE = /[─-╿▀-▟]+/g;
// Any 3+ run of '-' (ASCII rules/separators). Two or fewer could be real text.
const DASH_RUN_RE = /-{3,}/g;

class LongExecutionWatchManager {
  constructor(eventBus, appStateStore, gui, opts = {}) {
    this.eventBus = eventBus;
    this.appStateStore = appStateStore;
    this.gui = gui;
    this.runningThresholdMs = opts.runningThresholdMs != null ? opts.runningThresholdMs : RUNNING_THRESHOLD_MS;
    this.quietDebounceMs = opts.quietDebounceMs != null ? opts.quietDebounceMs : QUIET_DEBOUNCE_MS;
    this.evalIntervalMs = opts.evalIntervalMs != null ? opts.evalIntervalMs : EVAL_INTERVAL_MS;
    this.reportMaxLines = opts.reportMaxLines != null ? opts.reportMaxLines : REPORT_MAX_LINES;
    this.reportMaxChars = opts.reportMaxChars != null ? opts.reportMaxChars : REPORT_MAX_CHARS;
    // Injectable clock so the whole state machine is testable without real time.
    this._now = opts.now || (() => Date.now());
    this.evalTimer = null;
    // terminalId -> { activeSince, lastDataAt, owned }
    //   activeSince — when the current episode's output started
    //   lastDataAt  — last PTY chunk seen (the only thing the hot path writes)
    //   owned       — WE set this terminal to 'running'; only then may we clear it
    this._episodes = new Map();

    this.eventBus.on('terminal:data', (e) => this.onTerminalData(e));
    this.eventBus.on('terminal:status:changed', (e) => this.onStatusChanged(e));
    // StuckWatchManager leaks per-terminal state for closed terminals; prune here.
    this.eventBus.on('terminal:closed', (e) => this.onTerminalClosed(e));
  }

  // ---- Hot path: one Map write per PTY chunk, nothing else. ----
  onTerminalData(e) {
    if (!e || e.terminalId == null) return;
    if (e.terminalId === MANAGER_TERMINAL_ID) return; // never watch the manager
    const now = this._now();
    const ep = this._episodes.get(e.terminalId);
    if (!ep || now - ep.lastDataAt >= this.quietDebounceMs) {
      // First chunk, or the previous episode already went quiet -> fresh episode.
      this._episodes.set(e.terminalId, { activeSince: now, lastDataAt: now, owned: false });
      return;
    }
    ep.lastDataAt = now;
  }

  /**
   * Ownership tracking. Any status write from a source other than this watcher
   * (hook 'prompted', error, an IPC push) takes the terminal away from us: we
   * only ever transition OUT of a 'running' we set ourselves.
   */
  onStatusChanged(e) {
    if (!e || e.terminalId == null) return;
    if (e.source === 'change-watch') return; // our own write
    const ep = this._episodes.get(e.terminalId);
    if (ep) ep.owned = false;
  }

  onTerminalClosed(e) {
    if (!e || e.terminalId == null) return;
    this._episodes.delete(e.terminalId);
  }

  isEnabled() {
    const v = this.appStateStore.getState('managerLongExecutionWatchEnabled');
    return !(v === false || v === 'false'); // default on
  }

  start() {
    this.stop();
    this.evalTimer = setInterval(() => this.evaluate(), this.evalIntervalMs);
  }

  stop() {
    if (this.evalTimer) {
      clearInterval(this.evalTimer);
      this.evalTimer = null;
    }
  }

  /** The single coarse pass: promote long episodes, close finished ones. */
  evaluate() {
    if (!this.isEnabled()) return;
    const now = this._now();

    for (const [id, ep] of [...this._episodes]) {
      if (id === MANAGER_TERMINAL_ID) { this._episodes.delete(id); continue; }
      const terminal = this.gui.terminalStateManager.getTerminal(id);
      if (!terminal) { this._episodes.delete(id); continue; } // gone
      const status = terminal.status || null;
      const quiet = now - ep.lastDataAt >= this.quietDebounceMs;

      if (!quiet) {
        // Still producing output. Promote once the episode is long enough.
        if (ep.owned || status === 'running') continue;      // already running
        if (PROTECTED_STATUSES.has(status)) continue;        // someone else's
        if (now - ep.activeSince >= this.runningThresholdMs) {
          this._setStatus(id, 'running');
          ep.owned = true;
        }
        continue;
      }

      // Episode over. Only a run WE promoted is worth a status change + report;
      // anything shorter than the threshold ends silently (anti-spam).
      if (ep.owned && status === 'running') {
        this._setStatus(id, '...'); // the app's idle/stale convention
        this._reportStopped(id, terminal, Math.round((ep.lastDataAt - ep.activeSince) / 1000));
      }
      this._episodes.delete(id); // exactly one report per episode
    }
  }

  _setStatus(id, status) {
    const previousStatus = this.gui.terminalStateManager.setTerminalStatus(id, status);
    if (previousStatus === null || previousStatus === status) return;
    this.eventBus.emit('terminal:status:changed', {
      terminalId: id, status, previousStatus, source: 'change-watch'
    });
  }

  /** One line + a cleaned screen tail, queued for the manager (999). */
  _reportStopped(id, terminal, seconds) {
    const mgr = this.gui.managerInstance;
    if (!mgr || !mgr.running) return; // nobody to notify
    const title = (terminal && terminal.title) || `Terminal ${id}`;
    const dir = terminal && terminal.directory ? ` in ${terminal.directory}` : '';

    let raw = '';
    try {
      const res = this.gui.readTerminalScreen(id);
      raw = (res && res.ok && res.screen) || '';
    } catch (_) { /* screen read is best-effort */ }
    const cleaned = cleanSnippet(raw, this.reportMaxLines, this.reportMaxChars) || '(no visible output)';

    mgr.dispatch(
      `Terminal ${id} ("${title}")${dir} — execution stopped after ${seconds}s. Last output:\n\n${cleaned}`
    );
    this.eventBus.emit('log:action', {
      message: `Manager notified: terminal ${id} execution stopped after ${seconds}s`,
      type: 'info',
    });
  }
}

/**
 * Flatten a TUI screen dump to the last few lines of real text: box-drawing
 * chrome and long dash rules stripped, blank lines collapsed away, then capped
 * by line count and characters (chars win, keeping the newest text).
 */
function cleanSnippet(text, maxLines = REPORT_MAX_LINES, maxChars = REPORT_MAX_CHARS) {
  if (!text) return '';
  const lines = String(text)
    .split('\n')
    .map((line) => line.replace(BOX_CHARS_RE, '').replace(DASH_RUN_RE, '').trimEnd())
    .filter((line) => line.trim() !== ''); // collapses blank runs to nothing
  let out = lines.slice(-maxLines).join('\n').trim();
  if (out.length > maxChars) out = out.slice(out.length - maxChars).trim();
  return out;
}

LongExecutionWatchManager.TERMINAL_ID = MANAGER_TERMINAL_ID;
LongExecutionWatchManager.cleanSnippet = cleanSnippet;
LongExecutionWatchManager.RUNNING_THRESHOLD_MS = RUNNING_THRESHOLD_MS;
LongExecutionWatchManager.QUIET_DEBOUNCE_MS = QUIET_DEBOUNCE_MS;
LongExecutionWatchManager.EVAL_INTERVAL_MS = EVAL_INTERVAL_MS;
LongExecutionWatchManager.REPORT_MAX_LINES = REPORT_MAX_LINES;

module.exports = LongExecutionWatchManager;
