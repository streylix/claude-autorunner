'use strict';

// Pure policy for the injection gate (R3) — decides whether a queued message may
// be injected into a terminal right now. Separated from MessageQueueManager so
// the policy can be reasoned about and unit-tested in isolation; the manager
// gathers the live state and calls this.
//
// Precedence (first match wins):
//   0. no target terminal (the ONLY hard block for urgent)
//   1. usage-limit wait   2. timer countdown   3. injection paused
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

module.exports = { evaluateInjectionGate };
