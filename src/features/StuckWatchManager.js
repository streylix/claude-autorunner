'use strict';

// Notify the manager (terminal 999) when a worker terminal is STUCK — needing
// attention but never firing a completion, so nothing else would wake the
// manager: (i) prompted too long (menu or not — PromptWatchManager only covers
// on-screen menus), (ii) running but producing no PTY output (silent hang),
// (iii) a queued message held by the injection gate. The reliability
// counterpart to the completion push, at ~one short line per incident.
//
// A periodic sweep (not event-driven): "stuck" is the ABSENCE of events, so it
// can only be seen by a clock. State is fed from the same bus events the app
// already emits (terminal:status:changed, terminal:data) — no new plumbing.
// Reuses the manager's dispatch() (queues to 999), PromptWatchManager-style.
// De-dupes per stuck-episode: one note while a terminal stays stuck the same
// way; a cleared condition resets the episode, a NEW condition re-notifies.

const MANAGER_TERMINAL_ID = 999;
// Tunable thresholds (ms). SWEEP is how often the clock looks; the *_STUCK_MS
// values are how long a condition must persist before the manager hears of it.
const SWEEP_INTERVAL_MS = 30 * 1000;
const PROMPTED_STUCK_MS = 5 * 60 * 1000;  // prompted with no answer
const SILENT_RUNNING_MS = 4 * 60 * 1000;  // running with no PTY output
const BLOCKED_QUEUE_MS = 5 * 60 * 1000;   // queued message held by the gate

class StuckWatchManager {
  constructor(eventBus, appStateStore, gui, opts = {}) {
    this.eventBus = eventBus;
    this.appStateStore = appStateStore;
    this.gui = gui;
    this.sweepIntervalMs = opts.sweepIntervalMs != null ? opts.sweepIntervalMs : SWEEP_INTERVAL_MS;
    this.promptedStuckMs = opts.promptedStuckMs != null ? opts.promptedStuckMs : PROMPTED_STUCK_MS;
    this.silentRunningMs = opts.silentRunningMs != null ? opts.silentRunningMs : SILENT_RUNNING_MS;
    this.blockedQueueMs = opts.blockedQueueMs != null ? opts.blockedQueueMs : BLOCKED_QUEUE_MS;
    // Injectable clock so thresholds are testable without real time.
    this._now = opts.now || (() => Date.now());
    this.sweepTimer = null;
    // terminalId -> { status, at } — when the terminal entered its current status.
    this._statusSince = new Map();
    // terminalId -> ts of the last raw PTY output seen.
    this._lastOutputAt = new Map();
    // terminalId -> { at, reason } — when the gate first blocked a queued
    // message for this terminal (cleared when it becomes injectable / unqueued).
    this._blockedSince = new Map();
    // terminalId -> condition-set key already notified for the CURRENT episode.
    this._notified = new Map();
    this.eventBus.on('terminal:status:changed', (e) => this.onStatusChanged(e));
    this.eventBus.on('terminal:data', (e) => this.onTerminalData(e));
  }

  onStatusChanged(e) {
    if (!e || e.terminalId == null) return;
    this._statusSince.set(e.terminalId, { status: e.status, at: this._now() });
  }

  onTerminalData(e) {
    if (!e || e.terminalId == null) return;
    this._lastOutputAt.set(e.terminalId, this._now());
  }

  isEnabled() {
    const v = this.appStateStore.getState('managerStuckWatchEnabled');
    return !(v === false || v === 'false'); // default on
  }

  start() {
    this.stop();
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
  }

  stop() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** One pass over every terminal; dispatches at most one note per terminal. */
  sweep() {
    if (!this.isEnabled()) return;
    const mgr = this.gui.managerInstance;
    if (!mgr || !mgr.running) return; // nobody to notify

    this._updateBlockedClocks();

    const now = this._now();
    this.gui.terminalStateManager.getAllTerminals().forEach((data, id) => {
      if (id === MANAGER_TERMINAL_ID) return;
      // Muted terminal: the user is driving it themselves, so "prompted 5m" is
      // them thinking, not a terminal that needs rescuing. Drop the episode
      // state too, so unmuting starts clean rather than firing a note about a
      // condition that has been true the whole time it was silenced.
      if (data && data.muted) {
        this._notified.delete(id);
        return;
      }
      const facts = this._stuckFacts(id, now);
      if (!facts.length) {
        this._notified.delete(id); // healthy -> episode over
        return;
      }
      // Episode key = WHICH conditions are stuck (not for how long) — the same
      // set stays quiet across sweeps; a new condition joining re-notifies.
      const key = facts.map((f) => f.kind).sort().join('+');
      if (this._notified.get(id) === key) return;
      this._notified.set(id, key);

      const title = (data && data.title) || `Terminal ${id}`;
      const note = `T${id} ("${title}") appears stuck: ${facts.map((f) => f.text).join(', ')}`;
      mgr.dispatch(note);
      this.eventBus.emit('log:action', {
        message: `Manager notified: terminal ${id} appears stuck (${key})`,
        type: 'warning',
      });
    });
  }

  /** The stuck conditions currently true for a terminal, as {kind, text}. */
  _stuckFacts(id, now) {
    const facts = [];
    const since = this._statusSince.get(id);

    if (since && since.status === 'prompted' && now - since.at >= this.promptedStuckMs) {
      facts.push({ kind: 'prompted', text: `prompted ${mins(now - since.at)}` });
    }

    if (since && since.status === 'running') {
      // Silence measured from the last PTY output, or from entering running if
      // no output was ever seen (a hang can predate the first byte).
      const lastOut = this._lastOutputAt.get(id);
      const silentFrom = lastOut != null ? Math.max(lastOut, since.at) : since.at;
      if (now - silentFrom >= this.silentRunningMs) {
        facts.push({ kind: 'silent', text: `running ${mins(now - silentFrom)} with no output` });
      }
    }

    const blocked = this._blockedSince.get(id);
    if (blocked && now - blocked.at >= this.blockedQueueMs) {
      facts.push({ kind: 'blocked', text: `queued message blocked ${mins(now - blocked.at)} (${blocked.reason})` });
    }

    return facts;
  }

  // Track how long each terminal has had a queued message the gate refuses.
  // The clock starts at the first blocked sighting and clears the moment the
  // terminal is injectable again (or has nothing queued).
  _updateBlockedClocks() {
    const mq = this.gui.messageQueueManager;
    if (!mq) return;
    const blockedNow = new Map(); // terminalId -> reason
    for (const m of mq.messageQueue || []) {
      if (m.terminalId === MANAGER_TERMINAL_ID) continue;
      if (blockedNow.has(m.terminalId)) continue; // one clock per terminal
      const gate = mq.canInjectToTerminal(m.terminalId, m.type);
      if (gate && gate.allowed === false) {
        blockedNow.set(m.terminalId, gate.reason || 'injection gated');
      }
    }
    const now = this._now();
    for (const [id, reason] of blockedNow) {
      const prev = this._blockedSince.get(id);
      if (!prev) this._blockedSince.set(id, { at: now, reason });
      else prev.reason = reason; // keep the freshest reason, original clock
    }
    for (const id of [...this._blockedSince.keys()]) {
      if (!blockedNow.has(id)) this._blockedSince.delete(id);
    }
  }
}

/** Compact whole-minute duration for the one-line note, e.g. "6m". */
function mins(ms) {
  return `${Math.floor(ms / 60000)}m`;
}

StuckWatchManager.TERMINAL_ID = MANAGER_TERMINAL_ID;

module.exports = StuckWatchManager;
