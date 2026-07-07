'use strict';

// INBOUND media (user → manager): downloads image/video attachments the user
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

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.tiff'];
const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.gifv'];

function kindOf(att) {
  const ct = (att.contentType || '').toLowerCase();
  const ext = (path.extname(att.name || '') || '').toLowerCase();
  if (ct.startsWith('image/') || IMAGE_EXT.includes(ext)) return 'image';
  if (ct.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video';
  return null;
}

// Is this attachment an image or video we accept?
function isMedia(att) { return kindOf(att) !== null; }

async function _saveOne(att, destDir) {
  const kind = kindOf(att);
  if (!kind) return { ok: false, name: att.name, reason: 'not an image/video' };
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
  let ext = (path.extname(rawName) || '').toLowerCase();
  if (!ext) ext = '.' + ((att.contentType || `${kind}/bin`).split('/')[1] || 'bin');
  const stem = rawName.replace(/\.[^.]*$/, '') || kind;
  const file = path.join(destDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${stem}${ext}`);
  fs.writeFileSync(file, buf);
  log.info(`saved inbound ${kind} → ${file} (${(buf.length / 1e6).toFixed(2)}MB)`);
  return { ok: true, kind, path: file, name: att.name };
}

// Save a list/collection of attachments. Returns { saved: [paths], skipped: [{name,reason}] }.
async function saveAttachments(attachments, destDir = config.mediaInboxDir, max = config.inboundMaxMedia) {
  const all = Array.from(attachments && attachments.values ? attachments.values() : (attachments || []));
  const media = all.filter(isMedia).slice(0, max);
  const saved = [];
  const skipped = [];
  for (const att of media) {
    const r = await _saveOne(att, destDir);
    if (r.ok) saved.push(r.path); else skipped.push({ name: r.name, reason: r.reason });
  }
  // Note any media beyond the per-message cap.
  const overflow = all.filter(isMedia).length - media.length;
  if (overflow > 0) skipped.push({ name: `+${overflow} more`, reason: `over the ${max}-file cap` });
  return { saved, skipped };
}

module.exports = { saveAttachments, isMedia, kindOf };
