'use strict';

// Detects a silently-DEAF voice receiver and auto-recovers it.
//
// The bug: the Discord VoiceConnection stays in "Ready" but stops delivering
// audio (no speaking events, no packets) — often after a mute/unmute cycle or a
// network blip. Nothing errors, so it never self-recovers and the user has to
// manually /resume. This monitor watches a robust signal — "connection Ready AND
// at least one non-bot, UNMUTED member present AND no audio for a while" — and
// recovers automatically. Genuine silence (everyone quiet or muted) is NOT a
// fault, so it won't thrash an idle-but-occupied call.
//
// Recovery ladder (lightest first), with cooldown + a hard cap:
//   1. re-subscribe   — clear stale subscriptions so fresh ones form.
//   2. leave + rejoin — re-establish the whole UDP/WS (the reliable cure).
// Counters reset only when audio actually returns, so the cap survives a rejoin.
//
// Everything is dependency-injected (getState / resubscribe / rejoin / now), so
// the decision logic is unit-testable without a live Discord connection.

const log = require('./log');

class ReceiverHealthMonitor {
  constructor({ getState, resubscribe, rejoin, now, opts = {} }) {
    this._getState = getState;       // () => { ready, eligible, audioAgeMs, everReceived }
    this._resubscribe = resubscribe; // () => void|Promise  (light fix)
    this._rejoin = rejoin;           // () => Promise<bool>  (heavy fix)
    this.now = now || (() => Date.now());
    this.o = {
      intervalMs: opts.intervalMs || 10000,
      stallMs: opts.stallMs || 45000,
      coldStallMs: opts.coldStallMs || 120000,
      cooldownMs: opts.cooldownMs || 15000,
      maxRejoins: opts.maxRejoins || 3,
    };
    this.timer = null;
    this._reset();
  }

  _reset() {
    this.episode = false;     // a recovery episode is in progress
    this.lightTried = false;  // light re-subscribe already attempted this episode
    this.rejoins = 0;         // consecutive rejoin attempts without restored audio
    this.gaveUp = false;
    this.lastActionAt = 0;
    this.inFlight = false;
  }

  start() {
    if (this.timer) return;          // idempotent — counters survive across joins
    this._reset();
    this.timer = setInterval(() => {
      this.tick().catch((e) => log.warn('receiver health tick error:', e.message));
    }, this.o.intervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info(`receiver health monitor armed (every ${Math.round(this.o.intervalMs / 1000)}s; stall ${Math.round(this.o.stallMs / 1000)}s).`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // One health evaluation. Returns the action taken ('resubscribe'|'rejoin'|null)
  // — handy for tests.
  async tick() {
    if (this.inFlight) return null;
    const s = this._getState();

    // Not in a fault-eligible state: no connection / not Ready / nobody who
    // could be talking (everyone muted, absent, or only the bot). NOT a fault.
    if (!s || !s.ready || s.eligible <= 0) { this._reset(); return null; }

    // High confidence once audio has flowed before (we KNOW it can hear); be
    // more patient if we've never received anything (could be a quiet call).
    const threshold = s.everReceived ? this.o.stallMs : this.o.coldStallMs;
    if (s.audioAgeMs < threshold) {
      if (this.episode) log.success('✅ reception restored — audio is flowing again. Recovery state reset.');
      this._reset();
      return null;
    }

    // STALLED. Back off between actions so we don't thrash.
    const now = this.now();
    if (now - this.lastActionAt < this.o.cooldownMs) return null;
    const ageS = Math.round(s.audioAgeMs / 1000);

    if (!this.lightTried) {
      this.episode = true;
      this.lightTried = true;
      this.lastActionAt = now;
      log.warn(`⚠️  receiver stalled ${ageS}s (Ready, ${s.eligible} unmuted member(s) present) — re-subscribing…`);
      await this._run(this._resubscribe);
      return 'resubscribe';
    }

    if (this.rejoins >= this.o.maxRejoins) {
      if (!this.gaveUp) {
        this.gaveUp = true;
        log.error(`🛑 receiver still deaf after ${this.rejoins} rejoin attempts — giving up to avoid a loop. Use /stop then /resume.`);
      }
      return null;
    }

    this.rejoins += 1;
    this.lastActionAt = now;
    log.warn(`⚠️  receiver still deaf ${ageS}s after re-subscribe — leaving + rejoining (attempt ${this.rejoins}/${this.o.maxRejoins})…`);
    await this._run(this._rejoin);
    return 'rejoin';
  }

  async _run(fn) {
    this.inFlight = true;
    try { await fn(); }
    catch (e) { log.warn('recovery action failed:', e.message); }
    finally { this.inFlight = false; }
  }
}

module.exports = ReceiverHealthMonitor;
