'use strict';

// Pure policy for the injection gate (R3) — decides whether a queued message may
// be injected into a terminal right now. Separated from MessageQueueManager so
// the policy can be reasoned about and unit-tested in isolation; the manager
// gathers the live state and calls this.
//
// Precedence (first match wins):
//   1. usage-limit wait   2. timer countdown   3. injection paused
//   4. no target terminal 5. bare-shell guard (P4)
//   6. terminal status gate (prompted only; urgent bypasses)
//
// The bare-shell guard (5) refuses to inject into a terminal with no live Claude
// session — otherwise the prompt would run as shell commands. It deliberately
// sits ABOVE the status gate so urgent cannot bypass it: a prompt must
// never hit bash. It only triggers on a definitive 'shell'; 'claude'/'unknown'/
// undefined fail open so injection is never broken when the runtime is undetermined.
function evaluateInjectionGate({
  usageLimitWaiting,
  timerRunning,
  injectionPaused,
  terminalId,
  status,
  runtime,
  messageType = 'normal',
}) {
  if (usageLimitWaiting) {
    return { allowed: false, reason: 'usage limit active - waiting for reset' };
  }
  if (timerRunning) {
    return { allowed: false, reason: 'timer still counting down' };
  }
  if (injectionPaused) {
    return { allowed: false, reason: 'injection paused' };
  }
  if (terminalId == null) {
    return { allowed: false, reason: 'no target terminal' };
  }
  if (runtime === 'shell') {
    return { allowed: false, reason: `terminal ${terminalId} is a bare shell (no Claude session)` };
  }
  // 'normal' deliberately does NOT gate on the 'running' state — that state is
  // finnicky and gets stuck, which froze the whole queue. Normal's condition is:
  // destination isn't 'prompted' AND no countdown is active (the timerRunning
  // check above; isRunning() is false when stopped, paused, or expired at 0).
  // 'urgent' bypasses the status gate entirely.
  if (messageType !== 'urgent' && status === 'prompted') {
    return { allowed: false, reason: `terminal ${terminalId} is ${status}` };
  }
  return { allowed: true, reason: 'ok' };
}

module.exports = { evaluateInjectionGate };
