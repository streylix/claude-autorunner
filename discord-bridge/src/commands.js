'use strict';

// Slash commands — the user-facing control surface. Registered per-guild on
// startup (instant, no global propagation delay) and require the bot to be
// invited with the `applications.commands` scope.
//
//   /link <key>  START SESSION: resolve the pasted key, link to the current
//                manager session, and JOIN the voice channel the invoking user
//                is in (music-bot style; falls back to DISCORD_VOICE_CHANNEL_ID).
//   /resume      Re-link + rejoin using the LAST key you linked with — no paste
//                needed (handy on mobile). Errors if you've never linked or the
//                stored session is no longer valid.
//   /leave       Leave voice and unlink.
//   /status      Show link + voice + audio-mode + wake-word state.

const { SlashCommandBuilder } = require('discord.js');
const { config } = require('../config');
const resumeStore = require('./resumeStore');
const mediaInbox = require('./mediaInbox');
const auth = require('./auth');

const definitions = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Connect the bot to the current manager session and join your voice channel')
    .addStringOption((o) =>
      o.setName('key').setDescription('The /link key the manager generated').setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Reconnect using your last link — no key paste needed')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Leave the call and stop listening (stays linked — /resume to rejoin)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('leave')
    .setDescription('Leave the voice channel and unlink from the session')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the bridge link / voice / audio status')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('prompt')
    .setDescription('Send a typed message (and optional image/video) to the manager')
    .addStringOption((o) =>
      o.setName('text').setDescription('Your message to the manager').setRequired(false))
    .addAttachmentOption((o) =>
      o.setName('media').setDescription('An image or video to send along').setRequired(false))
    .toJSON(),
];

// Shared: after a successful link, join the invoking user's CURRENT voice
// channel and report. Returns nothing — it edits the (deferred) reply itself.
async function joinCurrentChannel(interaction, session, linked) {
  const channelId = interaction.member?.voice?.channelId || config.voiceChannelId;
  if (!channelId) {
    await interaction.editReply(
      `${linked.message}\n⚠️ But you're not in a voice channel and no default is set. ` +
      'Join a voice channel and try again, or set DISCORD_VOICE_CHANNEL_ID.');
    return false;
  }
  try {
    await session.join(interaction.guild, channelId);
  } catch (err) {
    await interaction.editReply(`${linked.message}\n❌ Couldn't join voice: ${err.message}`);
    return false;
  }
  const w = config.wake();
  await interaction.editReply(
    `${linked.message}\n🔊 Joined <#${channelId}>. ` +
    (w.enabled ? `Say **"${w.phrase}"** then your request.` : 'Wake word disabled — all speech is forwarded.'));
  return true;
}

async function register(client, guildId) {
  const guild = await client.guilds.fetch(guildId);
  await guild.commands.set(definitions);
  return guild;
}

// ctx = { linkManager, session }
async function handle(interaction, ctx) {
  if (!interaction.isChatInputCommand()) return;

  // AUTHORIZATION gate: only allow-listed Discord users may drive the manager.
  // Applies to every command (incl. /link and /prompt). Deny-by-default when
  // no allow-list is configured (see auth.js) — the reply tells the user their
  // ID so they can allow themselves.
  if (!auth.isAuthorized(interaction.user.id)) {
    const payload = { content: auth.denyMessage(interaction.user.id), ephemeral: true };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.reply(payload);
    } catch (_) { /* interaction may have expired */ }
    return;
  }

  const { linkManager, session } = ctx;

  if (interaction.commandName === 'link') {
    await interaction.deferReply({ ephemeral: true });
    const key = interaction.options.getString('key', true);

    const linked = await linkManager.link(key);
    if (!linked.ok) {
      await interaction.editReply(`❌ ${linked.message}`);
      return;
    }

    // Remember this user's session so they can /resume without re-pasting.
    const s = linkManager.status();
    resumeStore.remember(interaction.user.id, key, {
      tag: interaction.user.tag, port: s.port, managerId: s.managerId,
    });

    // Music-bot behaviour: join the channel the invoking user is in.
    await joinCurrentChannel(interaction, session, linked);
    return;
  }

  if (interaction.commandName === 'resume') {
    await interaction.deferReply({ ephemeral: true });

    const stored = resumeStore.recall(interaction.user.id);
    if (!stored) {
      await interaction.editReply(
        "❌ No saved session for you yet. Run **/link <key>** once with a fresh key — " +
        'after that, **/resume** reconnects without pasting.');
      return;
    }

    // Re-resolve the stored key against the live vault + control API. This fails
    // cleanly if the key was rotated, expired, or the manager session is gone.
    const linked = await linkManager.link(stored.key);
    if (!linked.ok) {
      await interaction.editReply(
        `❌ Your saved session is no longer valid (${linked.message})\n` +
        'Run **/link <key>** with a fresh key from the manager.');
      return;
    }

    // Refresh the stored entry (keeps it current) and rejoin the user's channel.
    const s = linkManager.status();
    resumeStore.remember(interaction.user.id, stored.key, {
      tag: interaction.user.tag, port: s.port, managerId: s.managerId,
    });
    await joinCurrentChannel(interaction, session, { message: `🔁 Resumed — ${linked.message}` });
    return;
  }

  if (interaction.commandName === 'prompt') {
    if (!linkManager.isLinked()) {
      await interaction.reply({ content: '❌ Not linked — run **/link** or **/resume** first.', ephemeral: true });
      return;
    }
    const text = (interaction.options.getString('text') || '').trim();
    const media = interaction.options.getAttachment('media');
    if (!text && !media) {
      await interaction.reply({ content: '❌ Give me some text and/or attach an image/video.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    let saved = [];
    let skipped = [];
    if (media) {
      const r = await mediaInbox.saveAttachments([media]);
      saved = r.saved; skipped = r.skipped;
    }
    if (!text && !saved.length) {
      await interaction.editReply(`❌ Couldn't process that${skipped[0] ? ` — ${skipped[0].reason}` : ''}.`);
      return;
    }
    // Frame by source: a file attachment → 'file' (with the saved path[s]); plain
    // text → 'typed' (verbatim, not "spoken/transcribed").
    const res = await linkManager.forward(text, { source: saved.length ? 'file' : 'typed', paths: saved });
    if (res && res.ok) {
      const bits = [];
      if (text) bits.push('text');
      if (saved.length) bits.push(`${saved.length} file(s)`);
      await interaction.editReply(`✅ Sent to the manager (${bits.join(' + ')}).${skipped.length ? ` ⚠️ skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}` : ''}`);
    } else {
      await interaction.editReply(`❌ Failed to send: ${(res && res.error) || 'unknown error'}`);
    }
    return;
  }

  if (interaction.commandName === 'stop') {
    // Manual escape hatch: force-leave the call (even if the connection is
    // wedged/deaf) and stop listening, but stay LINKED so /resume rejoins.
    await interaction.deferReply({ ephemeral: true });
    try {
      await session.leave();
      await interaction.editReply('🛑 Left the call and stopped listening. Type **/resume** to rejoin.');
    } catch (err) {
      await interaction.editReply(`🛑 Forced a leave (with an error: ${err.message}). Type **/resume** to rejoin.`);
    }
    return;
  }

  if (interaction.commandName === 'leave') {
    await session.leave();
    linkManager.unlink();
    await interaction.reply({ content: '👋 Left the voice channel and unlinked.', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'status') {
    const s = linkManager.status();
    const w = config.wake();
    const lines = [
      `**Link:** ${s.linked ? `✅ manager ${s.managerId} on 127.0.0.1:${s.port}` : '❌ not linked (paste a /link key)'}`,
      `**Voice:** ${session.isActive() ? `✅ in <#${session.channelId}>` : '❌ not in a channel'}`,
      `**Audio out:** ${config.audioSource === 'system' ? 'system (everything: TTS + SFX + alarm)' : 'TTS only'}`,
      `**Listening:** ${config.alwaysListenInCall ? '🟢 always-on in-call (no wake word — mute your mic to stop)' : `wake word ${w.enabled ? `"${w.phrase}"` : 'disabled'}`}`,
      `**Text mirror:** ${config.textMirrorEnabled ? `on → #${config.textChannelName}${config.textChannelId ? ' (by id)' : ''}` : 'off'}`,
    ];
    if (s.linked) lines.push(`**Key:** ${s.expiresAt ? `expires ${new Date(s.expiresAt).toLocaleTimeString()}` : 'valid until restart or Regenerate (no time limit)'}`);
    const saved = resumeStore.recall(interaction.user.id);
    lines.push(`**Resume:** ${saved ? '✅ saved — run /resume to reconnect without a key' : '❌ none yet — /link once to enable /resume'}`);
    await interaction.reply({ content: lines.join('\n'), ephemeral: true });
    return;
  }
}

module.exports = { definitions, register, handle };
