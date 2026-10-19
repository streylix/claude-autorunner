'use strict';

// Shared helpers for the manager→bridge OUTBOX protocol, used by BOTH sides —
// the watcher (src/imageOutbox.js) and the CLI tools (tools/post-*.js) — so the
// two can never disagree about what a channel name normalises to or where a
// result lands.
//
// Descriptors may now carry a "channel" field. It names a text channel to post
// into instead of the default mirror channel, so a draft can live in its own
// channel and be iterated on there. The bridge resolves-or-creates it by name
// and caches it, so repeat posts reuse the same channel.

const fs = require('fs');
const path = require('path');

const RESULT_SUFFIX = '.result.json';
const MAX_CHANNEL_NAME = 100; // Discord's own cap on channel names.

// Discord rewrites channel names it doesn't like (spaces → dashes, uppercase →
// lowercase). If we asked for "RMA Drafts" and Discord stored "rma-drafts", the
// next lookup by the original string would miss and we'd create a duplicate —
// so normalise to exactly what Discord will store, on both sides.
// Returns '' when nothing usable is left (the caller then falls back).
function sanitizeChannelName(name) {
  return String(name == null ? '' : name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, '') // drop punctuation, emoji, slashes, dots…
    .replace(/[\s_]+/g, '-')        // spaces and underscores become dashes
    .replace(/-{2,}/g, '-')         // collapse runs of dashes
    .replace(/^-+|-+$/g, '')        // no leading/trailing dash
    .slice(0, MAX_CHANNEL_NAME)
    .replace(/-+$/, '');            // the slice may have left a trailing dash
}

// Plain-text file types we're willing to upload as an attachment. Anything else
// is refused loudly rather than posted as an unreadable blob.
const TEXT_FILE_EXTS = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log',
  '.json', '.csv', '.tsv', '.xml', '.yml', '.yaml', '.toml', '.ini', '.conf',
  '.diff', '.patch', '.sql', '.html', '.css', '.js', '.py', '.sh',
]);
function isTextFileName(p) {
  return TEXT_FILE_EXTS.has(path.extname(String(p || '')).toLowerCase());
}

// A descriptor foo.json has its outcome written next to it as foo.result.json.
function resultPathFor(descriptorPath) {
  return String(descriptorPath).replace(/\.json$/, '') + RESULT_SUFFIX;
}
function isResultFile(name) {
  return String(name).endsWith(RESULT_SUFFIX);
}

// Bridge side: record what actually happened, atomically, for the CLI to read.
function writeResult(descriptorPath, result) {
  const out = resultPathFor(descriptorPath);
  const tmp = `${out}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(result), { mode: 0o600 });
    fs.renameSync(tmp, out);
  } catch (_) { try { fs.unlinkSync(tmp); } catch (__) {} }
}

// CLI side: wait for the bridge to say what it did, so a post can never fail
// silently. Returns the parsed result, or null if the bridge didn't answer in
// time — in which case the descriptor is still queued and will go out when the
// bridge comes back.
function waitForResult(descriptorPath, timeoutMs = 12000, pollMs = 250) {
  const out = resultPathFor(descriptorPath);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  return new Promise((resolve) => {
    const poll = () => {
      let raw = null;
      try { raw = fs.readFileSync(out, 'utf8'); } catch (_) { /* not yet */ }
      if (raw != null) {
        try { fs.unlinkSync(out); } catch (_) {}
        try { return resolve(JSON.parse(raw)); } catch (_) { return resolve(null); }
      }
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(poll, pollMs);
    };
    poll();
  });
}

module.exports = {
  sanitizeChannelName,
  isTextFileName,
  resultPathFor,
  isResultFile,
  writeResult,
  waitForResult,
  RESULT_SUFFIX,
  MAX_CHANNEL_NAME,
  TEXT_FILE_EXTS,
};
