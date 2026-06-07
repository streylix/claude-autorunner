/**
 * usage-limit-parser - Pure helpers for detecting Claude usage-limit messages
 * and turning the stated reset time into a concrete future Date.
 *
 * Kept dependency-free and side-effect-free so it can be unit tested under
 * plain `node` (no Electron / DOM) and reused by both the Notification-hook
 * path and the terminal:data fallback path in UsageLimitManager.
 *
 * Claude's message wording (observed):
 *   "Claude usage limit reached. Your limit will reset at 3pm"
 *   "Claude usage limit reached. Your limit will reset at 11:30pm"
 *   "...resets 3pm"  /  "...resets at 11:30 pm"
 */

// Matches the reset clause: "reset at 3pm", "resets at 11:30pm", "reset 3 pm",
// "resets 11:30 pm". Hours 1-12, optional :MM, optional space before am/pm.
const RESET_CLAUSE = /reset[s]?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

// A broader gate so we only treat a string as a usage-limit message when the
// "usage limit" phrasing is present (avoids matching unrelated "resets at" text).
const USAGE_LIMIT_PHRASE = /usage limit/i;

/**
 * Parse a stated reset time ("3pm", "11:30pm") into the next future Date.
 * Handles the cross-midnight case: if the stated time has already passed today,
 * the reset is assumed to be tomorrow.
 *
 * @param {number} hour12   - 1..12 hour as stated
 * @param {number} minute   - 0..59 minutes (0 when not stated)
 * @param {string} ampm     - 'am' | 'pm' (case-insensitive)
 * @param {Date}   [now]    - reference "now" (injectable for tests)
 * @returns {Date|null} future reset Date, or null on invalid input
 */
function resetTimeToDate(hour12, minute, ampm, now = new Date()) {
    hour12 = parseInt(hour12, 10);
    minute = parseInt(minute, 10) || 0;
    if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
    if (minute < 0 || minute > 59) return null;
    if (!ampm) return null;

    let hour24 = hour12 % 12;            // 12 -> 0
    if (ampm.toLowerCase() === 'pm') hour24 += 12; // 12pm -> 12, 1pm -> 13

    const reset = new Date(
        now.getFullYear(), now.getMonth(), now.getDate(),
        hour24, minute, 0, 0
    );

    // Cross-midnight: if the time already passed today, it's tomorrow.
    if (reset <= now) {
        reset.setDate(reset.getDate() + 1);
    }

    return reset;
}

/**
 * Detect a Claude usage-limit message in an arbitrary string (a structured
 * Notification message, or raw terminal output as a fallback).
 *
 * @param {string} text   - candidate message text
 * @param {Date}   [now]  - reference "now" (injectable for tests)
 * @returns {{ resetTime: Date, raw: string } | null}
 */
function parseUsageLimitMessage(text, now = new Date()) {
    if (typeof text !== 'string') return null;
    if (!USAGE_LIMIT_PHRASE.test(text)) return null;

    const m = text.match(RESET_CLAUSE);
    if (!m) return null;

    const [, hour, min, ampm] = m;
    const resetTime = resetTimeToDate(hour, min, ampm, now);
    if (!resetTime) return null;

    return { resetTime, raw: m[0] };
}

module.exports = { parseUsageLimitMessage, resetTimeToDate, RESET_CLAUSE, USAGE_LIMIT_PHRASE };
