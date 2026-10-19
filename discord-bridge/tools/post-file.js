#!/usr/bin/env node
'use strict';

// Manager-facing trigger: post a local PLAIN-TEXT FILE (.md, .txt, .json, .csv,
// .log …) into a Discord text channel as a real ATTACHMENT — a single file the
// user can download, edit and hand back, rather than a long draft chopped across
// several chat messages.
//
//   node tools/post-file.js <path> [caption words...]
//   node tools/post-file.js --channel rma-drafts /tmp/wd-rma-letter.md "draft v2"
//
// Pairs with --channel: a draft then lives as a file in its own channel and is
// re-posted there as it iterates. Over the size cap the bridge REFUSES the file
// and says so — it never posts a truncated one.
// --channel also takes a channel or THREAD id (T792) to post inside a thread.
//
// Same outbox mechanism as post-text/post-image: an atomic { file, caption }
// descriptor the running bridge picks up within ~1s, posts, and reports back on.

const fs = require('fs');
const path = require('path');
const { parseFlags, resolveChannel, resolveThreadName, queue, report } = require('./postCommon');
const { isTextFileName, TEXT_FILE_EXTS } = require('../src/outbox');
const pathGuard = require('../src/pathGuard');
const { config } = require('../config');

const flags = parseFlags(process.argv.slice(2));
const [fileArg, ...rest] = flags.rest;
if (!fileArg) {
  console.error('Usage: node tools/post-file.js [--channel <name|id>] [--new-thread <name>] [--no-wait] <path> [caption...]');
  console.error(`Text file types: ${[...TEXT_FILE_EXTS].join(' ')}`);
  process.exit(1);
}
const target = path.resolve(fileArg);
const caption = rest.join(' ').trim() || undefined;

let st;
try { st = fs.statSync(target); } catch (_) { st = null; }
if (!st || !st.isFile()) {
  console.error(`❌ File not found: ${target}`);
  process.exit(1);
}
if (!isTextFileName(target)) {
  console.error(`❌ ${path.basename(target)} is not a plain-text file type. ` +
    `Accepted: ${[...TEXT_FILE_EXTS].join(' ')}`);
  console.error('   (Use post-image.js for images and post-video.js for video.)');
  process.exit(1);
}
if (st.size === 0) {
  console.error(`❌ ${path.basename(target)} is empty — nothing to post.`);
  process.exit(1);
}
// Fail here rather than after a pointless round trip. The bridge checks again.
if (st.size > config.textFileMaxBytes) {
  console.error(`❌ ${path.basename(target)} is ${(st.size / 1e6).toFixed(2)}MB, over the ` +
    `${(config.textFileMaxBytes / 1e6).toFixed(0)}MB cap. Not posting a truncated file — split it or raise TEXT_FILE_MAX_BYTES.`);
  process.exit(1);
}
// The bridge only uploads from a contained set of roots (pathGuard), so catch a
// path it will refuse HERE, where the message is useful, instead of in its log.
if (!pathGuard.safeMediaPath(target)) {
  console.error(`❌ The bridge may not upload from ${target}.`);
  console.error(`   Allowed roots: ${pathGuard.allowedRoots().join(', ')}`);
  console.error('   Put the draft in one of those (/tmp works) or set CCBOT_MEDIA_ROOTS.');
  process.exit(1);
}
const channel = resolveChannel(flags.channel);
const newThread = resolveThreadName(flags.newThread);

const file = queue('file', { file: target, caption, channel: channel || undefined, newThread: newThread || undefined, wantResult: flags.wait });
console.log(`📤 File post: ${target}${caption ? `  (caption: "${caption}")` : ''}`);
report(file, flags, `(${path.basename(target)}, ${st.size} bytes)`);
