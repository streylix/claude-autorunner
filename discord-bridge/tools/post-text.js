#!/usr/bin/env node
'use strict';

// Manager-facing trigger: post a plain TEXT message into a Discord text channel
// AS THE BOT — NOT read aloud by TTS. Use it to share links / clickable text the
// user can see (TTS can't convey a URL).
//
//   node tools/post-text.js <message words...>
//   node tools/post-text.js --channel rma-drafts "draft v2: …"
//
// Without --channel it goes to the default text-mirror channel, exactly as
// before. With --channel it goes to that channel, which the bridge creates on
// first use and reuses afterwards — so a draft can be iterated on in its own
// channel instead of scrolling away in the main mirror.
//
// --channel also takes a channel or THREAD id (T792): the post goes into that
// thread, never creating anything; an id that isn't found falls back loudly.
//
//   node tools/post-text.js --new-thread "Weekend plans" "first message"
//   node tools/post-text.js --channel general --new-thread plans "…"
//
// --new-thread (T796) creates a public thread with that name in the --channel
// parent (default #claude-voice), or reuses an ACTIVE thread of that name there,
// posts into it, and prints its id. It never falls back to another channel.
//
// Writes a { text } descriptor into the bridge's outbox (the same local runtime
// dir + watcher that post-image uses). The running bridge posts it within ~1s and
// then reports back, which this waits for and prints. It is the bot's own
// message, so Feature A's self-ignore never loops it back.

const { parseFlags, resolveChannel, resolveThreadName, queue, report } = require('./postCommon');

const flags = parseFlags(process.argv.slice(2));
const text = flags.rest.join(' ').trim();
if (!text) {
  console.error('Usage: node tools/post-text.js [--channel <name|id>] [--new-thread <name>] [--no-wait] <message...>');
  process.exit(1);
}
const channel = resolveChannel(flags.channel);
const newThread = resolveThreadName(flags.newThread);

const file = queue('txt', { text, channel: channel || undefined, newThread: newThread || undefined, wantResult: flags.wait });
const preview = `"${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`;
console.log(`📤 Text post (not TTS'd): ${preview}`);
report(file, flags, `(${text.length} chars)`);
