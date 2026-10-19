'use strict';

// Discord REPLY context → a one-line quoted snippet appended to a forwarded memo.
//
// When the user replies to a specific message, the bare text they typed is often
// meaningless on its own ("just the diagram", "no, the other one"). Discord knows
// what they pointed at; the manager did not, and was left guessing from whatever
// happened to be in its context. This turns that pointer into a short quote the
// manager can read inline.
//
// Two halves, kept apart so neither needs the other to be testable:
//   • fromMessage(refMsg) — a discord.js Message → a PLAIN {author, text, describe}
//   • format(replyTo)     — that plain object → the single-line suffix string
// controlApi/frameMemo only ever sees the plain object, so it stays free of
// discord.js. A null/absent replyTo formats to '' — a non-reply message is framed
// byte-for-byte as it was before this existed.

const SNIPPET_MAX = 200;

// Collapse to ONE line (the whole memo is single-line — Claude's TUI treats an
// embedded newline as submit) and cut to ~200 chars, preferring a word boundary
// so the quote doesn't end mid-word.
function snippet(text, max = SNIPPET_MAX) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const kept = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return kept.replace(/[\s.,;:!?-]+$/, '') + '…';
}

// Who wrote the message being replied to. Works for the bot's own posts (the
// username is the bot's) and for the user's (server nickname wins, then the
// Discord display name, then the handle).
function authorName(msg) {
  return msg?.member?.displayName ||
    msg?.author?.globalName ||
    msg?.author?.username ||
    'someone';
}

// A referenced message can be pure media — an image drop, a video, a link embed —
// with no content at all. Describe it in words instead of quoting nothing.
function describeNonText(msg) {
  const atts = msg?.attachments ? [...msg.attachments.values()] : [];
  if (atts.length) {
    const kinds = new Set(atts.map(kindOf));
    const kind = kinds.size === 1 ? [...kinds][0] : 'attachment';
    const n = atts.length;
    if (n === 1) return kind === 'image' ? 'an image' : kind === 'audio' ? 'an audio clip' : `a ${kind}`;
    return `${n} ${kind === 'image' ? 'images' : kind === 'audio' ? 'audio clips' : kind + 's'}`;
  }
  if (msg?.embeds?.length) return msg.embeds.length === 1 ? 'an embed' : `${msg.embeds.length} embeds`;
  if (msg?.stickers?.size) return 'a sticker';
  if (msg?.poll) return 'a poll';
  return 'a message with no text';
}

// contentType is authoritative when Discord sends it; fall back to the filename
// extension (attachments proxied from some clients arrive with it unset).
function kindOf(att) {
  const ct = String(att?.contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct) return 'file';
  const ext = String(att?.name || '').toLowerCase().split('.').pop();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'opus'].includes(ext)) return 'audio';
  return 'file';
}

// discord.js Message → the plain shape frameMemo appends. null when there is
// nothing worth saying (no referenced message — e.g. it was deleted).
function fromMessage(refMsg) {
  if (!refMsg) return null;
  const text = snippet(refMsg.content);
  return text
    ? { author: authorName(refMsg), text }
    : { author: authorName(refMsg), describe: describeNonText(refMsg) };
}

// The suffix appended to the memo line. Quoted when there is text; UNQUOTED prose
// when there isn't, so an image reply reads "replying to Ethan: an image" rather
// than an empty pair of quotes.
function format(replyTo) {
  if (!replyTo) return '';
  const who = String(replyTo.author || 'someone').replace(/\s+/g, ' ').trim() || 'someone';
  if (replyTo.text) return ` ↩ replying to ${who}: "${snippet(replyTo.text)}"`;
  if (replyTo.describe) return ` ↩ replying to ${who}: ${replyTo.describe}`;
  return '';
}

module.exports = { fromMessage, format, snippet, describeNonText, authorName, SNIPPET_MAX };
