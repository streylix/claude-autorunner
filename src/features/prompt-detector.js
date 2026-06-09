'use strict';

// Recognize a genuine Claude Code interactive prompt/menu from a terminal screen
// dump. Returns { question, options:[{num,text}] } when the screen shows an
// interactive selection (permission dialog, edit confirmation, or select menu),
// else null.
//
// The signature is high-precision on purpose: a real selector renders the `❯`
// selection cursor next to one of several numbered options. Ordinary assistant
// prose (a numbered list) has no cursor, and a long "thinking" turn shows a
// spinner but no menu — both return null, so the manager is never spammed.
//
// Pure and dependency-free, so it is unit-testable without a terminal.

// Box-drawing characters used by the TUI chrome; stripped before matching.
const BORDER = /[│┃|╭╮╰╯─━┌┐└┘├┤┬┴┼]/g;
// A numbered option line, optionally preceded by a selection cursor. The cursor
// glyph varies across Claude builds (❯ is standard; ›/»/▶/▸/➤ seen as variants).
const OPTION_RE = /^(❯|›|»|▶|▸|➤|>)\s*(\d+)\.\s+(.+)$|^(\d+)\.\s+(.+)$/;
const MAX_QUESTION_LOOKBACK = 8;

function clean(line) {
  return String(line).replace(BORDER, ' ').replace(/\s+/g, ' ').trim();
}

function detectPrompt(screenText) {
  if (!screenText || typeof screenText !== 'string') return null;

  const lines = screenText.split('\n').map(clean);
  const options = [];
  let cursorSeen = false;
  let firstOptIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPTION_RE);
    if (!m) continue;
    const hasCursor = m[1] !== undefined; // first alternative captured the cursor
    if (hasCursor) cursorSeen = true;
    const num = Number(hasCursor ? m[2] : m[4]);
    const text = (hasCursor ? m[3] : m[5]).trim();
    options.push({ num, text });
    if (firstOptIdx === -1) firstOptIdx = i;
  }

  // A genuine menu has the selection cursor and at least two choices. This
  // rejects ordinary numbered prose (no cursor) and stray single options.
  if (!cursorSeen || options.length < 2) return null;

  // The question is the nearest non-empty line above the first option.
  let question = '';
  for (let i = firstOptIdx - 1; i >= 0 && i >= firstOptIdx - MAX_QUESTION_LOOKBACK; i--) {
    if (lines[i]) { question = lines[i]; break; }
  }

  return { question: question || '(awaiting input)', options };
}

module.exports = { detectPrompt };
