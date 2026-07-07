#!/usr/bin/env node
'use strict';

// Manager-facing trigger: queue a local image to be posted into the Discord
// text-mirror channel by the running bridge.
//
//   node tools/post-image.js <image-path> [caption words...]
//
// Writes a small descriptor into the bridge's outbox (a local runtime dir shared
// with the bridge, same place as the link vault). The running bridge watches that
// dir and posts the image as an attachment. No backend, no network.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');

const [, , imageArg, ...rest] = process.argv;
if (!imageArg) {
  console.error('Usage: node tools/post-image.js <image-path> [caption...]');
  process.exit(1);
}

const image = path.resolve(imageArg);
const caption = rest.join(' ').trim() || undefined;
if (!fs.existsSync(image)) {
  console.error(`❌ Image not found: ${image}`);
  process.exit(1);
}

const dir = config.imageOutboxDir;
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `img-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
const tmp = `${file}.tmp`;
// Atomic write so the bridge never reads a half-written descriptor.
fs.writeFileSync(tmp, JSON.stringify({ image, caption }), { mode: 0o600 });
fs.renameSync(tmp, file);

console.log(`✅ Queued image for Discord: ${image}${caption ? `  (caption: "${caption}")` : ''}`);
console.log(`   descriptor: ${file}`);
console.log('   The running bridge posts it to the text-mirror channel within ~1s (as soon as it is online — no voice channel needed).');
