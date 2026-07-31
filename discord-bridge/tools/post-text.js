#!/usr/bin/env node
'use strict';

// Manager-facing trigger: post a plain TEXT message into the Discord text-mirror
// channel AS THE BOT — NOT read aloud by TTS. Use it to share links / clickable
// text the user can see (TTS can't convey a URL).
//
//   node tools/post-text.js <message words...>
//   node tools/post-text.js "Here's the PR: https://github.com/…/pull/42"
//
// Writes a { text } descriptor into the bridge's outbox (the same local runtime
// dir + watcher that post-image uses). The running bridge posts it within ~1s.
// It is the bot's own message, so Feature A's self-ignore never loops it back.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');

const text = process.argv.slice(2).join(' ').trim();
if (!text) {
  console.error('Usage: node tools/post-text.js <message...>');
  process.exit(1);
}

const dir = config.imageOutboxDir; // shared outbox (images + text)
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `txt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
const tmp = `${file}.tmp`;
fs.writeFileSync(tmp, JSON.stringify({ text }), { mode: 0o600 });
fs.renameSync(tmp, file); // atomic — the bridge never reads a half-written descriptor

console.log(`✅ Queued text post for Discord (not TTS'd): "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`);
console.log(`   descriptor: ${file}`);
console.log('   The running bridge posts it as the bot within ~1s (as soon as it is online — no voice channel needed).');
