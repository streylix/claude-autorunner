#!/usr/bin/env node
'use strict';

// Manager-facing trigger: queue a local image to be posted into a Discord text
// channel by the running bridge.
//
//   node tools/post-image.js <image-path> [caption words...]
//   node tools/post-image.js --channel rma-drafts /tmp/shot.png "the label"
//
// Without --channel it goes to the default text-mirror channel, exactly as
// before. With --channel it goes to that channel, created on first use.
//
// Writes a small descriptor into the bridge's outbox (a local runtime dir shared
// with the bridge, same place as the link vault). The running bridge watches that
// dir, posts the image as an attachment, and reports back. No backend, no network.

const fs = require('fs');
const path = require('path');
const { parseFlags, resolveChannel, queue, report } = require('./postCommon');

const flags = parseFlags(process.argv.slice(2));
const [imageArg, ...rest] = flags.rest;
if (!imageArg) {
  console.error('Usage: node tools/post-image.js [--channel <name>] [--no-wait] <image-path> [caption...]');
  process.exit(1);
}
const image = path.resolve(imageArg);
const caption = rest.join(' ').trim() || undefined;
if (!fs.existsSync(image)) {
  console.error(`❌ Image not found: ${image}`);
  process.exit(1);
}
const channel = resolveChannel(flags.channel);

const file = queue('img', { image, caption, channel: channel || undefined, wantResult: flags.wait });
console.log(`📤 Image post: ${image}${caption ? `  (caption: "${caption}")` : ''}`);
report(file, flags, `(${path.basename(image)})`);
