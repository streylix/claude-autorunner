'use strict';

// Path containment for files the manager asks the bridge to post to Discord.
//
// A descriptor dropped in the outbox names an absolute path that the bridge
// reads and uploads. Without a check, a mis-directed manager (or any same-uid
// process able to write the outbox) could exfiltrate arbitrary files
// (~/.ssh/id_rsa, /etc/passwd) to Discord. We confine posted paths to a set of
// allowed roots and defeat symlink escapes with realpath.
//
// Default roots: the shared manager<->bridge runtime dir (where the outbox/inbox
// live) and the OS temp dir (where generated screenshots / ffmpeg re-encodes
// land). Extend with CCBOT_MEDIA_ROOTS (comma-separated) if the manager writes
// media elsewhere.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { config } = require('../config');

function allowedRoots() {
  const roots = [];
  try { roots.push(path.dirname(path.resolve(config.imageOutboxDir))); } catch (_) {}
  try { roots.push(path.resolve(config.mediaInboxDir)); } catch (_) {}
  roots.push(os.tmpdir());
  String(process.env.CCBOT_MEDIA_ROOTS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .forEach((r) => { try { roots.push(path.resolve(r)); } catch (_) {} });
  return [...new Set(roots)];
}

// Resolve the real path (following symlinks) and confirm it is a regular file
// inside an allowed root. Returns the safe absolute path, or null to refuse.
function safeMediaPath(p) {
  if (!p || typeof p !== 'string') return null;
  let real;
  try { real = fs.realpathSync(path.resolve(p)); } catch (_) { return null; }
  let st;
  try { st = fs.statSync(real); } catch (_) { return null; }
  if (!st.isFile()) return null;
  const roots = allowedRoots();
  const ok = roots.some((root) => real === root || real.startsWith(root + path.sep));
  return ok ? real : null;
}

module.exports = { safeMediaPath, allowedRoots };
