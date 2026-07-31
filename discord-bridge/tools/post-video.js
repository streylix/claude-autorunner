#!/usr/bin/env node
'use strict';

// Manager-facing trigger: queue a local VIDEO (e.g. a screen recording of an app
// we're testing) to be posted into the Discord text-mirror channel by the running
// bridge.
//
//   node tools/post-video.js <video-path> [caption words...]
//   node tools/post-video.js <video-path> --max-mb=25 [caption words...]
//
// Writes a small { video, caption } descriptor into the bridge's outbox (the same
// shared runtime dir + watcher that post-image / post-text use). The running bridge
// re-encodes the video with ffmpeg to fit under Discord's upload cap (H.264 mp4 +
// AAC, iteratively clamping bitrate / downscaling) and posts it as an attachment.
// If the source is already under the cap it is sent as-is. No backend, no network.
//
// The cap defaults to config.videoMaxBytes (8 MB, Discord free-tier safe). Boosted
// servers allow more — override per post with --max-mb=N (or the CCBOT_VIDEO_MAX_BYTES
// env for the whole bridge).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');

const argv = process.argv.slice(2);

// Pull an optional --max-mb=N / --max-mb N out of the args; the rest is path + caption.
let maxBytes;
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  let m = /^--max-mb=(.+)$/.exec(a);
  if (m) { maxBytes = mb(m[1]); continue; }
  if (a === '--max-mb') { maxBytes = mb(argv[++i]); continue; }
  rest.push(a);
}
function mb(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) { console.error(`❌ Invalid --max-mb value: ${v}`); process.exit(1); }
  return Math.round(n * 1024 * 1024);
}

const videoArg = rest.shift();
if (!videoArg) {
  console.error('Usage: node tools/post-video.js <video-path> [--max-mb=N] [caption...]');
  process.exit(1);
}

const video = path.resolve(videoArg);
const caption = rest.join(' ').trim() || undefined;
if (!fs.existsSync(video)) {
  console.error(`❌ Video not found: ${video}`);
  process.exit(1);
}

const dir = config.imageOutboxDir; // shared outbox (images + text + video)
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `vid-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
const tmp = `${file}.tmp`;
// Atomic write so the bridge never reads a half-written descriptor.
const desc = { video, caption };
if (maxBytes) desc.maxBytes = maxBytes;
fs.writeFileSync(tmp, JSON.stringify(desc), { mode: 0o600 });
fs.renameSync(tmp, file);

const capMb = ((maxBytes || config.videoMaxBytes) / 1024 / 1024).toFixed(0);
console.log(`✅ Queued video for Discord: ${video}${caption ? `  (caption: "${caption}")` : ''}`);
console.log(`   descriptor: ${file}  (cap: ${capMb} MB)`);
console.log('   The running bridge re-encodes it under the cap and posts it to the text-mirror channel');
console.log('   within a few seconds (as soon as it is online — no voice channel needed).');
