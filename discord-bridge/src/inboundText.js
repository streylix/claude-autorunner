'use strict';

// AUTO-FORWARD: plain TEXT and/or attachments the user posts are forwarded to
// the manager automatically (no /prompt needed), exactly like a voice memo.
// Media is saved locally and its path is appended.
//
// T792: read from ANY text channel or thread of the guild, not only the mirror
// channel. channelRouting.routeInbound() decides per message: #claude-voice is
// framed exactly as before (no origin); anywhere else the memo names the
// channel (and the thread, with its id). Channels he switched off with
// /manager-ignore are dropped here, BEFORE linkManager.forward — which is
// where the conversation log is written — so they are neither forwarded nor
// logged.
//
// FEEDBACK-LOOP GUARD: never forward the bot's OWN messages — its Heard/Replied
// mirrors, image posts, and manager-text posts. Filter on author == the bot's
// own id AND ignore any bot/webhook author.
// DEFENCE IN DEPTH behind the single-instance lock: drop any gateway event we
// have already handled, keyed by its snowflake id. Covers a RESUME replaying
// dispatches, and any future path that could deliver an event twice.

const { config } = require('../config');
const log = require('./log');
const auth = require('./auth');
const mediaInbox = require('./mediaInbox');
const replyContext = require('./replyContext');
const EventDedupe = require('./eventDedupe');
const { routeInbound } = require('./channelRouting');

function makeMessageHandler({ client, textMirror, linkManager, channelIgnore, seenEvents }) {
  const seen = seenEvents || new EventDedupe();
  return async function onMessageCreate(message) {
    try {
      if (seen.seen(message.id)) {
        log.warn(`duplicate messageCreate for ${message.id} — dropped (already handled).`);
        return;
      }
      if (message.author?.id === client.user?.id) return; // our own message → never loop back
      if (message.author?.bot || message.webhookId) return; // other bots / webhooks
      if (message.guildId !== config.guildId) return;
      // AUTHORIZATION: only allow-listed users' messages are auto-forwarded to
      // the manager. Unauthorized posts are ignored silently (no channel spam);
      // they can run any slash command to see how to allow themselves.
      if (!auth.isAuthorized(message.author?.id)) return;
      const route = routeInbound({
        channel: message.channel,
        mirrorChannelId: textMirror.channel && textMirror.channel.id,
        textChannelId: config.textChannelId,
        ignore: channelIgnore,
      });
      if (!route.forward) return;

      // EVERY attachment goes to the inbox, accepted or not: pre-filtering with
      // isMedia here meant saveAttachments never saw an unsupported file, so it
      // could not report it, and the return below swallowed a captionless one.
      const attachments = message.attachments ? [...message.attachments.values()] : [];
      const text = (message.content || '').trim();
      if (!attachments.length && !text) return; // genuinely nothing to forward

      // Auto-forward only when linked; unlinked → skip silently (no channel spam).
      if (!linkManager.isLinked()) return;

      let saved = [];
      let skipped = [];
      if (attachments.length) { const r = await mediaInbox.saveAttachments(attachments); saved = r.saved; skipped = r.skipped; }

      if (!text && !saved.length) { // attachments present but none saved, and no text
        message.react('⚠️').catch(() => {});
        if (skipped.length) message.reply(mediaInbox.skippedNotice(skipped)).catch(() => {});
        return;
      }
      // A file was rejected but the message still carries text or another file:
      // say so anyway, naming the file.
      if (skipped.length) message.reply(mediaInbox.skippedNotice(skipped)).catch(() => {});
      // REPLY CONTEXT: if this message replies to another one, quote a snippet of
      // it so the manager knows what the user is pointing at. Discord usually
      // hydrates the referenced message inline (discord.js parks it in the channel
      // cache); when it doesn't, fetch it. A deleted or unfetchable reference just
      // yields null and the memo is framed exactly as a non-reply.
      let replyTo = null;
      const refId = message.reference?.messageId;
      if (refId) {
        const ref = message.channel?.messages?.cache?.get(refId) ||
          await message.fetchReference().catch(() => null);
        replyTo = replyContext.fromMessage(ref);
      }
      // Frame by source: attachment(s) → 'file' (with saved path[s]); plain text → 'typed'.
      // origin only when NOT the main channel, so #claude-voice opts are unchanged.
      const opts = { source: saved.length ? 'file' : 'typed', paths: saved, replyTo };
      if (route.origin) opts.origin = route.origin;
      const res = await linkManager.forward(text, opts);
      message.react(res && res.ok ? '✅' : '❌').catch(() => {});
    } catch (err) {
      log.warn('messageCreate handler error:', err.message);
    }
  };
}

module.exports = { makeMessageHandler };
