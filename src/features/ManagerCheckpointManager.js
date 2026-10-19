'use strict';

// Inactivity-triggered CHECKPOINT-then-CLEAR for the manager instance (999).
//
// When the whole fleet has been idle long enough that nobody is plausibly still
// working — no real user input anywhere, no output from any worker terminal —
// the manager is asked to write its session up into its notes, and only once it
// has finished writing is its context cleared. The point is to start the next
// session with a clean context WITHOUT losing what the last one learned.
//
// Deliberately NOT a timer that fires "/clear" on its own: clearing a manager
// mid-thought loses the session, so the clear is gated on two observations —
// (1) the fleet really was idle for the full threshold, and (2) the manager
// really did go active-then-quiet after being asked to jot, i.e. it actually
// wrote the notes. Anything the user does at any point cancels the whole thing.
//
// What counts as activity (and so resets the inactivity clock):
//   - genuine USER input: typing into any terminal, sending from the message
//     box, a voice memo — all emitted as `user:activity` by the renderer
//   - OUTPUT from any NON-manager terminal (a worker is doing something)
// What pointedly does NOT count: the manager's own output. Its housekeeping
// (including the notes it writes for this very flow) must not hold the clock
// open, or the fleet could never be judged idle.
//
// Quiet-detection for 999 reuses LongExecutionWatchManager's debounce constant
// so "gone quiet" means the same thing here as everywhere else. It tracks 999's
// output locally rather than reaching into that watcher, which never registers
// the manager at all — this flow is the one place 999's activity is observed,
// and even here its status is never written and no completion is reported.

const LongExecutionWatchManager = require('./LongExecutionWatchManager');

const MANAGER_TERMINAL_ID = 999;

// ---- Tunables ----
// Fleet-wide silence before the checkpoint fires. Ethan's ask was "an hour or
// two"; 90 min is long enough that a coffee break can't trigger it.
const INACTIVITY_THRESHOLD_MS = 90 * 60 * 1000;
// What the manager is asked to do before its context goes away.
const CHECKPOINT_PROMPT = 'Jot down everything you did this session in the notes.';
const CLEAR_COMMAND = '/clear';
// "The manager finished writing" — same definition of quiet as the change watcher.
const MANAGER_QUIET_MS = LongExecutionWatchManager.QUIET_DEBOUNCE_MS;
// How long 999 must have been continuously active before its quiet counts as
// "the notes are written". Injecting the prompt echoes it into 999's PTY, which
// is itself output — without this floor, an echo followed by a slow start would
// read as active-then-quiet and clear the manager BEFORE it wrote anything. Same
// bar the change watcher uses to call an execution real, for the same reason.
// The trade is deliberate: a suspiciously fast "write" times out without
// clearing, because a missed clear is harmless and a premature one loses the
// session.
const MIN_MANAGER_WRITE_MS = LongExecutionWatchManager.RUNNING_THRESHOLD_MS;
// The coarse clock. A 90-minute threshold does not need a fast one.
const EVAL_INTERVAL_MS = 30 * 1000;
// If the manager never answers the jot prompt (queue gated, session wedged),
// give up rather than leaving a "/clear" primed to fire hours later.
const CHECKPOINT_TIMEOUT_MS = 10 * 60 * 1000;
// If the queued /clear never injects, stop waiting on it.
const CLEAR_TIMEOUT_MS = 5 * 60 * 1000;

// idle       — armed, watching the inactivity clock
// checkpointing — jot prompt sent; waiting for 999 to write and go quiet
// clearing   — /clear queued; waiting for it to actually inject
// disarmed   — cycle finished (or gave up); re-arms only on NEW activity
const STATE = {
  IDLE: 'idle',
  CHECKPOINTING: 'checkpointing',
  CLEARING: 'clearing',
  DISARMED: 'disarmed',
};

class ManagerCheckpointManager {
  constructor(eventBus, appStateStore, gui, opts = {}) {
    this.eventBus = eventBus;
    this.appStateStore = appStateStore;
    this.gui = gui;
    this.inactivityThresholdMs = opts.inactivityThresholdMs != null ? opts.inactivityThresholdMs : INACTIVITY_THRESHOLD_MS;
    this.managerQuietMs = opts.managerQuietMs != null ? opts.managerQuietMs : MANAGER_QUIET_MS;
    this.minManagerWriteMs = opts.minManagerWriteMs != null ? opts.minManagerWriteMs : MIN_MANAGER_WRITE_MS;
    this.evalIntervalMs = opts.evalIntervalMs != null ? opts.evalIntervalMs : EVAL_INTERVAL_MS;
    this.checkpointTimeoutMs = opts.checkpointTimeoutMs != null ? opts.checkpointTimeoutMs : CHECKPOINT_TIMEOUT_MS;
    this.clearTimeoutMs = opts.clearTimeoutMs != null ? opts.clearTimeoutMs : CLEAR_TIMEOUT_MS;
    this._now = opts.now || (() => Date.now());

    this.evalTimer = null;
    this.state = STATE.IDLE;
    this._lastActivityAt = this._now();
    this._managerLastDataAt = 0;    // last output from 999
    this._managerActiveSince = 0;   // start of 999's current output episode
    this._managerWroteSomething = false; // 999 produced output AFTER the jot prompt
    this._cycleStartedAt = 0;       // when the current checkpoint/clear step began

    this.eventBus.on('user:activity', (e) => this.onUserActivity(e));
    this.eventBus.on('terminal:data', (e) => this.onTerminalData(e));
    this.eventBus.on('message:injected', (e) => this.onMessageInjected(e));
  }

  /**
   * Genuine user input anywhere. Mid-cycle this is a hard abort: the user is
   * back, so the manager's context must survive even if the notes are already
   * written and the /clear is sitting in the queue.
   */
  onUserActivity() {
    this._lastActivityAt = this._now();
    if (this.state === STATE.CHECKPOINTING || this.state === STATE.CLEARING) {
      this._abort('user is back');
      return;
    }
    if (this.state === STATE.DISARMED) this._rearm();
  }

  onTerminalData(e) {
    if (!e || e.terminalId == null) return;
    const now = this._now();
    if (e.terminalId === MANAGER_TERMINAL_ID) {
      // The manager's own output NEVER counts as fleet activity — it is only
      // the signal that it is (still) writing its notes. Episodes are tracked
      // exactly as the change watcher tracks a worker's: a gap >= the quiet
      // debounce starts a new one.
      if (!this._managerActiveSince || now - this._managerLastDataAt >= this.managerQuietMs) {
        this._managerActiveSince = now;
      }
      this._managerLastDataAt = now;
      if (this.state === STATE.CHECKPOINTING && now >= this._cycleStartedAt) {
        this._managerWroteSomething = true;
      }
      return;
    }
    // A worker produced output: the fleet is not idle.
    this._lastActivityAt = now;
    if (this.state === STATE.DISARMED) this._rearm();
  }

  /** The queued /clear actually landed — the cycle is complete. */
  onMessageInjected(e) {
    if (!e || e.terminalId !== MANAGER_TERMINAL_ID) return;
    if (this.state === STATE.CLEARING && e.content === CLEAR_COMMAND) {
      this.state = STATE.DISARMED;
    }
  }

  isEnabled() {
    const v = this.appStateStore.getState('managerInactivityCheckpointEnabled');
    return !(v === false || v === 'false'); // default on
  }

  start() {
    this.stop();
    this._lastActivityAt = this._now(); // don't count time before we were armed
    this.evalTimer = setInterval(() => this.evaluate(), this.evalIntervalMs);
  }

  stop() {
    if (this.evalTimer) {
      clearInterval(this.evalTimer);
      this.evalTimer = null;
    }
  }

  evaluate() {
    if (!this.isEnabled()) return;
    const mgr = this.gui.managerInstance;
    if (!mgr || !mgr.running) {
      // No manager to checkpoint. Drop any half-finished cycle so a restart
      // begins from a clean, armed state rather than mid-flow.
      if (this.state !== STATE.IDLE) this.state = STATE.IDLE;
      return;
    }
    const now = this._now();

    switch (this.state) {
      case STATE.IDLE:
        if (now - this._lastActivityAt >= this.inactivityThresholdMs) this._startCheckpoint(now);
        break;

      case STATE.CHECKPOINTING:
        if (this._managerWroteSomething) {
          if (now - this._managerLastDataAt >= this.managerQuietMs) {
            // Quiet. Only a LONG enough episode means notes were actually
            // written — a short one is the injected prompt's own echo, so
            // discard it and keep waiting for the real turn.
            if (this._managerLastDataAt - this._managerActiveSince >= this.minManagerWriteMs) {
              this._startClear(now);
            } else {
              this._managerWroteSomething = false;
            }
          }
        }
        if (this.state === STATE.CHECKPOINTING && !this._managerWroteSomething
            && now - this._cycleStartedAt >= this.checkpointTimeoutMs) {
          this._disarm('manager never answered the checkpoint prompt');
        }
        break;

      case STATE.CLEARING:
        if (now - this._cycleStartedAt >= this.clearTimeoutMs) {
          this._disarm('queued /clear never injected');
        }
        break;

      default: // DISARMED — waits for new activity, nothing to do on the clock
        break;
    }
  }

  _startCheckpoint(now) {
    const mgr = this.gui.managerInstance;
    if (!mgr.dispatch(CHECKPOINT_PROMPT)) return; // refused (remote/stopped) — stay armed
    this.state = STATE.CHECKPOINTING;
    this._cycleStartedAt = now;
    this._managerWroteSomething = false;
    this._log(`Fleet idle ${Math.round(this.inactivityThresholdMs / 60000)}m — asked the manager to checkpoint its session to notes`, 'info');
  }

  _startClear(now) {
    const mgr = this.gui.managerInstance;
    if (!mgr.dispatch(CLEAR_COMMAND)) { this._disarm('clear dispatch refused'); return; }
    this.state = STATE.CLEARING;
    this._cycleStartedAt = now;
    this._log('Manager finished its checkpoint notes — clearing its context', 'info');
  }

  /** User came back mid-cycle: pull anything we queued and re-arm. */
  _abort(reason) {
    const pulled = this._dropQueued([CHECKPOINT_PROMPT, CLEAR_COMMAND]);
    this.state = STATE.IDLE;
    this._managerWroteSomething = false;
    this._log(
      `Manager checkpoint aborted (${reason})${pulled ? ` — ${pulled} queued message(s) pulled` : ''}`,
      'warning'
    );
  }

  _disarm(reason) {
    this._dropQueued([CHECKPOINT_PROMPT, CLEAR_COMMAND]);
    this.state = STATE.DISARMED;
    this._managerWroteSomething = false;
    this._log(`Manager checkpoint cycle ended: ${reason}`, 'warning');
  }

  _rearm() {
    this.state = STATE.IDLE;
    this._managerWroteSomething = false;
  }

  /**
   * Remove still-queued messages this flow put in front of the manager. Only
   * ever matches 999 + our own exact constant strings, so a user's message is
   * never in scope.
   * @returns {number} how many were pulled
   */
  _dropQueued(contents) {
    const mq = this.gui.messageQueueManager;
    if (!mq || !Array.isArray(mq.messageQueue)) return 0;
    const doomed = mq.messageQueue.filter(
      (m) => m.terminalId === MANAGER_TERMINAL_ID && contents.includes(m.content)
    );
    doomed.forEach((m) => {
      try { mq.deleteMessage(m.id); } catch (_) { /* best-effort */ }
    });
    return doomed.length;
  }

  _log(message, type) {
    try { this.eventBus.emit('log:action', { message, type }); } catch (_) { /* ignore */ }
  }
}

ManagerCheckpointManager.TERMINAL_ID = MANAGER_TERMINAL_ID;
ManagerCheckpointManager.STATE = STATE;
ManagerCheckpointManager.INACTIVITY_THRESHOLD_MS = INACTIVITY_THRESHOLD_MS;
ManagerCheckpointManager.CHECKPOINT_PROMPT = CHECKPOINT_PROMPT;
ManagerCheckpointManager.CLEAR_COMMAND = CLEAR_COMMAND;
ManagerCheckpointManager.MANAGER_QUIET_MS = MANAGER_QUIET_MS;
ManagerCheckpointManager.MIN_MANAGER_WRITE_MS = MIN_MANAGER_WRITE_MS;
ManagerCheckpointManager.EVAL_INTERVAL_MS = EVAL_INTERVAL_MS;

module.exports = ManagerCheckpointManager;
