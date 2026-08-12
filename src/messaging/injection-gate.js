'use strict';

// Pure policy for the injection gate (R3) — decides whether a queued message may
// be injected into a terminal right now. Separated from MessageQueueManager so
// the policy can be reasoned about and unit-tested in isolation; the manager
// gathers the live state and calls this.
//
// Precedence (first match wins):
//   0. no target terminal (the ONLY hard block for urgent)
//   1. usage-limit wait   1b. destination is the manager (999) — bypasses the rest
//   2. timer countdown    3. injection paused
//   4. bare-shell guard (P4)
//   5. terminal status gate (prompted only)
//
// URGENT bypasses every gate except #0 — "urgent must send regardless of any
// condition." This is intentional: a terminal SSH'd into a remote machine running
// Claude is detected locally as runtime:'shell' (no local claude process), so the
// bare-shell guard would otherwise eat urgent messages bound for that remote
// session. The trade-off — an urgent prompt could land in a genuine bare bash — is
// accepted because urgent is an explicit human/manager override.
//
// For NORMAL messages every gate stays intact. The bare-shell guard (4) refuses to
// inject into a terminal with no live Claude session — otherwise the prompt would
// run as shell commands. It only triggers on a definitive 'shell'; 'claude'/
// 'unknown'/undefined fail open so injection is never broken when the runtime is
// undetermined.
//
// The MANAGER terminal (999) bypasses the SOFT gates at ANY message type — status
// ('prompted'), timer countdown, injection paused, and the bare-shell guard.
// Rationale: inbound traffic to the manager is not queued work competing for a
// worker's attention — it is the reporting channel (terminal completions, stuck
// watches, voice memos, Discord relays). Holding those behind the soft gates
// strands them: the manager sits at 'prompted' between turns as a matter of
// course, so a plain completion push would wait indefinitely in the queue for a
// state the manager may never leave on its own. The manager's own judgment is the
// brake on what it acts on, not the gate's.
//
// Three things still hold a manager message, deliberately:
//   * no target terminal (#0);
//   * the USAGE LIMIT (#1, checked ahead of the bypass) — during a wait the
//     manager cannot act on a report anyway, so holding until reset is cleaner
//     than buffering turns it will read late. Note this is where manager traffic
//     parts ways with urgent, which does override the usage limit;
//   * the deliberate "manager input disabled" switch, enforced by the caller
//     (MessageQueueManager.canInjectToTerminal) BEFORE this policy runs, so a user
//     who has switched the manager off still gets silence.
const MANAGER_TERMINAL_ID = 999;

function evaluateInjectionGate({
  usageLimitWaiting,
  timerRunning,
  injectionPaused,
  terminalId,
  status,
  runtime,
  messageType = 'normal',
}) {
  if (terminalId == null) {
    return { allowed: false, reason: 'no target terminal' };
  }
  // Urgent sends regardless of any other condition (a target terminal exists).
  if (messageType === 'urgent') {
    return { allowed: true, reason: 'ok' };
  }
  if (usageLimitWaiting) {
    return { allowed: false, reason: 'usage limit active - waiting for reset' };
  }
  // Manager-bound traffic clears the remaining SOFT gates immediately. Placed
  // deliberately AFTER the usage-limit check (unlike urgent, which overrides it):
  // the manager can't act during a wait, so reports hold until reset. The
  // manager-input-disabled switch is applied by the caller ahead of this.
  if (terminalId === MANAGER_TERMINAL_ID) {
    return { allowed: true, reason: 'ok' };
  }
  if (timerRunning) {
    return { allowed: false, reason: 'timer still counting down' };
  }
  if (injectionPaused) {
    return { allowed: false, reason: 'injection paused' };
  }
  if (runtime === 'shell') {
    return { allowed: false, reason: `terminal ${terminalId} is a bare shell (no Claude session)` };
  }
  // 'normal' deliberately does NOT gate on the 'running' state — that state is
  // finnicky and gets stuck, which froze the whole queue. Normal's condition is:
  // destination isn't 'prompted' AND no countdown is active (the timerRunning
  // check above; isRunning() is false when stopped, paused, or expired at 0).
  // (Urgent already returned above, so only normal reaches here.)
  if (status === 'prompted') {
    return { allowed: false, reason: `terminal ${terminalId} is ${status}` };
  }
  return { allowed: true, reason: 'ok' };
}

module.exports = { evaluateInjectionGate, MANAGER_TERMINAL_ID };
