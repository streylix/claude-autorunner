'use strict';

// Shared plumbing for tools/post-text.js, post-image.js, post-video.js and
// post-file.js: the `--channel` flag, dropping the descriptor in the outbox, and
// reporting back what the bridge actually did with it.
//
// The reporting is the point. These tools used to print "queued" and exit, so a
// post that never landed — a channel the bot couldn't create, a file it refused
// — looked exactly like a post that worked. Now the bridge writes a result file
// next to the descriptor and the CLI waits for it and prints the outcome.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const { sanitizeChannelName, waitForResult } = require('../src/outbox');

const DEFAULT_TIMEOUT_MS = 15000;

// Parse the LEADING flags only, so message text that starts with a dash is still
// message text. `--` ends flag parsing explicitly.
function parseFlags(argv) {
  const out = { channel: null, wait: true, timeoutMs: DEFAULT_TIMEOUT_MS, rest: [] };
  const args = argv.slice();
  while (args.length) {
    const a = args[0];
    if (a === '--') { args.shift(); break; }
    let m;
    if ((m = /^(?:--channel|-c)=(.*)$/.exec(a))) { out.channel = m[1]; args.shift(); continue; }
    if (a === '--channel' || a === '-c') { args.shift(); out.channel = args.shift() || ''; continue; }
    if (a === '--no-wait') { out.wait = false; args.shift(); continue; }
    if ((m = /^--timeout=(.*)$/.exec(a))) { out.timeoutMs = Math.max(0, parseFloat(m[1]) * 1000) || 0; args.shift(); continue; }
    if (a === '--timeout') { args.shift(); out.timeoutMs = Math.max(0, parseFloat(args.shift()) * 1000) || 0; continue; }
    break;
  }
  out.rest = args;
  return out;
}

// Refuse a channel name up front rather than letting it silently become
// something else once Discord is done with it.
function resolveChannel(requested) {
  if (requested == null) return null;
  const clean = sanitizeChannelName(requested);
  if (!clean) {
    console.error(`❌ "${requested}" has no usable characters for a Discord channel name ` +
      `(lowercase letters, digits and dashes).`);
    process.exit(1);
  }
  if (clean !== String(requested).trim()) {
    console.log(`ℹ️  Channel name normalised for Discord: "${requested}" → "${clean}".`);
  }
  return clean;
}

// Write the descriptor atomically (tmp + rename) so the bridge never reads a
// half-written one. Returns its path.
function queue(prefix, descriptor) {
  const dir = config.imageOutboxDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(descriptor), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

// Wait for the bridge's verdict and say what happened. Exits non-zero only when
// the bridge tells us it did NOT post.
async function report(descriptorFile, flags, summary) {
  console.log(`   descriptor: ${descriptorFile}`);
  if (!flags.wait) {
    console.log(`✅ Queued${summary ? ` ${summary}` : ''}. The running bridge posts it within ~1s.`);
    return;
  }
  const result = await waitForResult(descriptorFile, flags.timeoutMs);
  if (!result) {
    console.log(`⏳ Queued${summary ? ` ${summary}` : ''}, but the bridge didn't confirm within ` +
      `${Math.round(flags.timeoutMs / 1000)}s.`);
    console.log('   It stays queued and goes out when the bridge is back ' +
      '(check: systemctl --user status ccbot-discord-bridge).');
    return;
  }
  if (!result.ok) {
    console.error(`❌ NOT posted: ${result.reason || 'the bridge refused it — see the bridge log'}`);
    process.exitCode = 1;
    return;
  }
  if (result.fallback) {
    console.log(`⚠️  Could not use #${result.requested}: ${result.reason || 'unknown reason'}.`);
    console.log(`⚠️  Posted to the DEFAULT channel #${result.channel} instead — not where you asked.`);
    return;
  }
  console.log(`✅ Posted to #${result.channel}${summary ? ` ${summary}` : ''}.`);
}

module.exports = { parseFlags, resolveChannel, queue, report, DEFAULT_TIMEOUT_MS };
