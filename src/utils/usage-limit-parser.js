/**
 * usage-limit-parser - Pure helpers for detecting Claude usage-limit messages
 * and turning the stated reset time into a concrete future Date.
 *
 * Kept dependency-free and side-effect-free so it can be unit tested under
 * plain `node` (no Electron / DOM) and reused by both the Notification-hook
 * path and the terminal:data fallback path in UsageLimitManager.
 *
 * Claude's message wording (observed across versions):
 *   "Claude usage limit reached. Your limit will reset at 3pm"
 *   "Claude usage limit reached. Your limit will reset at 11:30pm"
 *   "5-hour limit reached ∙ resets at 2:30 pm"
 *   "...your limit will reset at 15:00"          (24-hour clock)
 *   "...usage limit reached. Resets in 2 hours"  (relative)
 *   "...usage limit reached. Try again at 9am tomorrow"
 */

// Phrase gate: only treat a string as a limit message when an explicit limit
// phrase is present. Broader than just "usage limit" so newer wordings
// ("5-hour limit reached", "rate limit") are caught, while still avoiding
// unrelated text that merely says "resets at ...".
const USAGE_LIMIT_PHRASE = /(usage limit|rate limit|limit reached|\d+\s*-?\s*hour limit)/i;

// Anchors that introduce the reset time across wordings. Each time pattern
// below is required to follow one of these, so the anchors can't match alone.
const ANCHOR = '(?:reset[s]?|try again|available again|back online|again)';

// 12-hour absolute: "reset at 3pm", "resets 11:30 pm", "try again at 9 AM".
const RESET_12H = new RegExp(ANCHOR + '(?:\\s+at)?\\s+(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)', 'i');
// 24-hour absolute: "reset at 15:00", "resets 23:30" (negative lookahead skips
// 12-hour times, which the matcher above already handled).
const RESET_24H = new RegExp(ANCHOR + '(?:\\s+at)?\\s+(\\d{1,2}):(\\d{2})(?!\\s*(?:am|pm))', 'i');
// Relative: "resets in 2 hours", "try again in 90 minutes", "in 1h 30m".
const RESET_RELATIVE = new RegExp(ANCHOR + '\\s+in\\s+(?:(\\d+)\\s*h(?:ours?|rs?)?)?\\s*(?:(\\d+)\\s*m(?:in(?:utes?)?)?)?', 'i');

// Kept for backwards compatibility with existing importers/tests.
const RESET_CLAUSE = RESET_12H;

/**
 * Build the next future Date for a 12-hour clock time ("3pm", "11:30pm").
 * If the stated time has already passed today, the reset is tomorrow.
 *
 * @param {number} hour12  1..12 hour as stated
 * @param {number} minute  0..59 (0 when not stated)
 * @param {string} ampm    'am' | 'pm' (case-insensitive)
 * @param {Date}   [now]   reference "now" (injectable for tests)
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

    return absoluteToDate(hour24, minute, now);
}

/**
 * Build the next future Date for a 24-hour clock time ("15:00", "23:30").
 * @param {number} hour24  0..23
 * @param {number} minute  0..59
 * @param {Date}   [now]
 * @returns {Date|null}
 */
function resetTime24ToDate(hour24, minute, now = new Date()) {
    hour24 = parseInt(hour24, 10);
    minute = parseInt(minute, 10) || 0;
    if (!Number.isInteger(hour24) || hour24 < 0 || hour24 > 23) return null;
    if (minute < 0 || minute > 59) return null;
    return absoluteToDate(hour24, minute, now);
}

/** Shared cross-midnight builder for an absolute hour24:minute. */
function absoluteToDate(hour24, minute, now) {
    const reset = new Date(
        now.getFullYear(), now.getMonth(), now.getDate(),
        hour24, minute, 0, 0
    );
    if (reset <= now) reset.setDate(reset.getDate() + 1); // already passed -> tomorrow
    return reset;
}

/**
 * Build a Date relative to now ("in 2 hours", "in 90 minutes", "in 1h 30m").
 * @param {number} hours
 * @param {number} minutes
 * @param {Date}   [now]
 * @returns {Date|null} null when no duration was actually stated
 */
function relativeToDate(hours, minutes, now = new Date()) {
    const h = parseInt(hours, 10) || 0;
    const m = parseInt(minutes, 10) || 0;
    if (h === 0 && m === 0) return null;
    return new Date(now.getTime() + (h * 60 + m) * 60000);
}

/**
 * Detect a Claude usage-limit message in an arbitrary string (a structured
 * Notification message, or raw terminal output as a fallback) and return the
 * concrete reset Date.
 *
 * @param {string} text   candidate message text
 * @param {Date}   [now]  reference "now" (injectable for tests)
 * @returns {{ resetTime: Date, raw: string } | null}
 */
function parseUsageLimitMessage(text, now = new Date()) {
    if (typeof text !== 'string') return null;
    if (!USAGE_LIMIT_PHRASE.test(text)) return null;

    let m, resetTime;
    if ((m = text.match(RESET_12H))) {
        resetTime = resetTimeToDate(m[1], m[2], m[3], now);
    } else if ((m = text.match(RESET_24H))) {
        resetTime = resetTime24ToDate(m[1], m[2], now);
    } else if ((m = text.match(RESET_RELATIVE)) && (m[1] || m[2])) {
        resetTime = relativeToDate(m[1], m[2], now);
    }

    if (!resetTime) return null;
    return { resetTime, raw: m[0] };
}

module.exports = {
    parseUsageLimitMessage,
    resetTimeToDate,
    resetTime24ToDate,
    relativeToDate,
    RESET_CLAUSE,
    RESET_12H,
    RESET_24H,
    RESET_RELATIVE,
    USAGE_LIMIT_PHRASE
};
