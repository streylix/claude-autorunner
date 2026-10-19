'use strict';

// T792: which of his messages reach the manager, and how the source is named.
//
// Before this, only #claude-voice was read. Now any text channel or thread of
// the guild is, unless he switched it off (/manager-ignore, see channelIgnore.js).
//
// The ORIGIN is null for the main channel, so a #claude-voice message is framed
// byte-for-byte as it always was. Anywhere else it names the channel — and for
// a thread, the thread's name and id plus its parent channel — so the manager
// knows where he wrote and can answer there with `--channel <id>`.
//
// Pure: takes plain channel-like objects (id, name, isTextBased(), isThread(),
// parentId, parent), so it is testable without a Discord connection.

const NAME_MAX = 80;

function isThread(channel) {
  return !!(channel && typeof channel.isThread === 'function' && channel.isThread());
}

// Decide one inbound message. Returns { forward, reason, origin }.
//   mirrorChannelId — the resolved #claude-voice id (textMirror.channel.id)
//   textChannelId   — DISCORD_TEXT_CHANNEL_ID, which also counts as the main channel
//   ignore          — a ChannelIgnore (isIgnored(id, parentId))
function routeInbound({ channel, mirrorChannelId, textChannelId, ignore }) {
  if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
    return { forward: false, reason: 'not-text', origin: null };
  }
  const id = String(channel.id);
  const main = (mirrorChannelId && id === String(mirrorChannelId)) ||
    (textChannelId && id === String(textChannelId));
  if (main) return { forward: true, reason: 'main', origin: null };

  const thread = isThread(channel);
  const parentId = thread && channel.parentId ? String(channel.parentId) : null;
  if (ignore && ignore.isIgnored(id, parentId)) return { forward: false, reason: 'ignored', origin: null };

  if (thread) {
    const parent = channel.parent || null;
    return {
      forward: true,
      reason: 'thread',
      origin: {
        channelId: parentId,
        channelName: parent && parent.name ? parent.name : null,
        threadId: id,
        threadName: channel.name || null,
      },
    };
  }
  return { forward: true, reason: 'channel', origin: { channelId: id, channelName: channel.name || null } };
}

// A name as one safe line: the memo is a single line (an embedded newline is a
// submit in Claude's TUI) and the thread name sits inside double quotes.
function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, NAME_MAX);
}

// The text that goes inside "(Discord…)" in the wrapper. '' for no origin.
//   channel: " #general; reply there with --channel 200"
//   thread:  " thread \"plans\" (id 300) in #general; reply there with --channel 300"
function originTag(origin) {
  if (!origin) return '';
  const chan = origin.channelName ? `#${cleanName(origin.channelName)}` : `channel ${origin.channelId}`;
  if (origin.threadId) {
    return ` thread "${cleanName(origin.threadName) || origin.threadId}" (id ${origin.threadId}) in ${chan};` +
      ` reply there with --channel ${origin.threadId}`;
  }
  return ` ${chan}; reply there with --channel ${origin.channelId}`;
}

// Conversation-log meta fields for an origin. null for the main channel, so
// those rows keep exactly the meta they had before.
function originMeta(origin) {
  if (!origin) return null;
  const out = { channel: origin.channelName || null, channelId: origin.channelId || null };
  if (origin.threadId) { out.thread = origin.threadName || null; out.threadId = origin.threadId; }
  return out;
}

module.exports = { routeInbound, originTag, originMeta, isThread };
