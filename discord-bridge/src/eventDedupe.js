'use strict';

// Duplicate-delivery guard, keyed by Discord snowflake id.
//
// WHY: a Discord gateway event can reach the handler more than once —
//   • two bridge processes on one bot token (Discord fans every event out to
//     EVERY live session; see singleInstance.js, which stops that at the source),
//   • a gateway RESUME, which replays dispatches the session may have already
//     processed.
// Handling one message twice meant two attachment downloads and two forwards to
// the manager, i.e. the manager acted on everything twice.
//
// Small, bounded, and fail-open: a missing id is never treated as a duplicate,
// because dropping a real message is far worse than handling a rare repeat.

const DEFAULT_MAX = 500;      // ids remembered (a Map preserves insertion order)
const DEFAULT_TTL_MS = 600000; // 10 minutes — well past any resume replay window

class EventDedupe {
  constructor({ max = DEFAULT_MAX, ttlMs = DEFAULT_TTL_MS, clock = Date.now } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.clock = clock;
    this._seen = new Map(); // id → first-seen timestamp
  }

  get size() { return this._seen.size; }

  // True if this id was already handled (→ caller must drop it). Records the id
  // as handled on the first call, so the check and the claim are one step.
  seen(id) {
    if (id === undefined || id === null || id === '') return false; // fail open
    const key = String(id);
    const now = this.clock();
    const at = this._seen.get(key);
    if (at !== undefined) {
      if (now - at <= this.ttlMs) return true;
      this._seen.delete(key); // expired → treat as new
    }
    this._seen.set(key, now);
    while (this._seen.size > this.max) {
      this._seen.delete(this._seen.keys().next().value); // evict oldest
    }
    return false;
  }
}

module.exports = EventDedupe;
