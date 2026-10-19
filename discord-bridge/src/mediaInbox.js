'use strict';

// INBOUND media (user → manager): downloads image/video/audio attachments the user
// sends (via /prompt or a plain message drop) to a known local dir, so the
// manager — running on the same machine — can open them by path.
//
// The saved path(s) are attached to the forwarded message (linkManager.forward
// → controlApi.frameMemo with source 'file'), so the manager can open by path.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const log = require('./log');

// WHAT WE ACCEPT — one table, so adding a type is one line here. It used to be
// four conditions inside kindOf(), which is how .html stayed unsupported
// without anyone noticing.
const ACCEPTED = [
  { kind: 'image', exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.tiff'], contentTypes: ['image/'] },
  { kind: 'video', exts: ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.gifv'], contentTypes: ['video/'] },
  { kind: 'audio', exts: ['.ogg', '.oga', '.m4a', '.mp3', '.wav', '.opus', '.aac', '.flac'], contentTypes: ['audio/'] },
  // The manager reads these off disk by path; .html earns its place because a
  // saved page is how a list of links gets handed over.
  { kind: 'text', exts: ['.txt', '.md', '.markdown', '.html', '.htm'], contentTypes: ['text/plain', 'text/markdown', 'text/html'] },
];

function kindOf(att) {
  const ct = (att.contentType || '').toLowerCase();
  const ext = (path.extname(att.name || '') || '').toLowerCase();
  for (const type of ACCEPTED) {
    if (type.contentTypes.some((prefix) => ct.startsWith(prefix))) return type.kind;
    if (ext && type.exts.includes(ext)) return type.kind;
  }
  return null;
}

// Is this attachment an image, video, audio, or text document we accept?
function isMedia(att) { return kindOf(att) !== null; }

// Why an attachment was not accepted, in words for the person who sent it.
function rejectionReason(att) {
  const ext = (path.extname(att.name || '') || '').toLowerCase();
  const ct = (att.contentType || '').split(';')[0].trim().toLowerCase();
  const what = ext || ct || 'unknown type';
  const docs = ACCEPTED.find((t) => t.kind === 'text').exts.join(', ');
  return `unsupported file type ${what} — I can take images, video, audio, or text documents (${docs})`;
}

// The sentence the sender sees when something they sent was not taken. One
// wording for every inbound path, so a rejection is never reported in one place
// and silent in another.
function skippedNotice(skipped) {
  if (!skipped || !skipped.length) return '';
  return `⚠️ Couldn't take ${skipped.map((s) => `${s.name} — ${s.reason}`).join(', ')}`;
}

async function _saveOne(att, destDir) {
  const kind = kindOf(att);
  if (!kind) return { ok: false, name: att.name, reason: 'not an image/video/audio/text file' };
  if (att.size && att.size > config.inboundMediaMaxBytes) {
    return { ok: false, name: att.name, reason: `too large to download (${(att.size / 1e6).toFixed(1)}MB > ${(config.inboundMediaMaxBytes / 1e6).toFixed(0)}MB)` };
  }
  let res;
  try { res = await fetch(att.url); } catch (e) { return { ok: false, name: att.name, reason: `download failed: ${e.message}` }; }
  if (!res.ok) return { ok: false, name: att.name, reason: `download HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > config.inboundMediaMaxBytes) return { ok: false, name: att.name, reason: 'too large to download' };

  fs.mkdirSync(destDir, { recursive: true });
  const rawName = (att.name || `${kind}`).replace(/[^\w.\-]/g, '_').slice(0, 60);
  // Prefer the ORIGINAL name's extension (the 60-char slice can chop it off);
  // only fall back to contentType, and never trust either blindly — a valid
  // ext is dot + alphanumerics, nothing else ("; charset=utf-8" is not an ext).
  let ext = (path.extname(att.name || '') || path.extname(rawName) || '').toLowerCase();
  if (!/^\.[a-z0-9]+$/.test(ext)) {
    const sub = ((att.contentType || '').split(/[;\s]/)[0].split('/')[1] || '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
    ext = sub ? `.${sub}` : (kind === 'text' ? '.txt' : '.bin');
  }
  const stem = rawName.replace(/\.[^.]*$/, '') || kind;
  const file = path.join(destDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${stem}${ext}`);
  fs.writeFileSync(file, buf);
  log.info(`saved inbound ${kind} → ${file} (${(buf.length / 1e6).toFixed(2)}MB)`);
  return { ok: true, kind, path: file, name: att.name };
}

// Save a list/collection of attachments. Returns { saved: [paths], skipped: [{name,reason}] }.
async function saveAttachments(attachments, destDir = config.mediaInboxDir, max = config.inboundMaxMedia) {
  const all = Array.from(attachments && attachments.values ? attachments.values() : (attachments || []));
  const saved = [];
  const skipped = [];
  // NOTHING IS DISCARDED WITHOUT A WORD: an unrecognised file used to be dropped
  // by `all.filter(isMedia)` before _saveOne could report it.
  const accepted = [];
  for (const att of all) {
    if (isMedia(att)) accepted.push(att);
    else {
      const reason = rejectionReason(att);
      skipped.push({ name: att.name || '(unnamed file)', reason });
      log.warn(`rejected inbound attachment ${att.name || '(unnamed)'} — ${reason}`);
    }
  }
  for (const att of accepted.slice(0, max)) {
    const r = await _saveOne(att, destDir);
    if (r.ok) saved.push(r.path); else skipped.push({ name: r.name, reason: r.reason });
  }
  // Note any media beyond the per-message cap.
  const overflow = accepted.length - Math.min(accepted.length, max);
  if (overflow > 0) skipped.push({ name: `+${overflow} more`, reason: `over the ${max}-file cap` });
  return { saved, skipped };
}

module.exports = { saveAttachments, isMedia, kindOf, rejectionReason, skippedNotice, ACCEPTED };
