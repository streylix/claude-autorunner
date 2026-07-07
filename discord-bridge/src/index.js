'use strict';

// CCBOT Discord voice bridge — standalone persistent service.
//
// Lifecycle:
//   1. Log in, register slash commands, then IDLE (unlinked, not in voice).
//      The service stays up on its own (systemd --user) and survives the
//      auto-injector app restarting — it holds NO app creds at rest.
//   2. The user runs /link <key> (key minted by the manager, see
//      tools/make-link-key.js). The bot resolves the key against the local
//      vault, links to the current session, and joins the user's CURRENT voice
//      channel (music-bot style).
//   3. Speech in that channel, prefixed with the wake word, is transcribed and
//      forwarded to the manager (terminal 999). Manager audio (TTS, or the whole
//      system output) plays back into the channel.
//   4. On app restart the creds change → the user pastes a fresh /link key.
//
// It NEVER touches the Electron app or the manager PTY except through the
// documented loopback control API.

const { Client, GatewayIntentBits } = require('discord.js');
const { config, validate } = require('../config');
const log = require('./log');
const dave = require('./dave');
const LinkManager = require('./linkManager');
const VoiceReceiver = require('./voiceReceive');
const BridgeSession = require('./session');
const { WakeSpotter } = require('./wakeWord');
const commands = require('./commands');
const auth = require('./auth');
const { startBridgeStatusReporter } = require('./bridgeStatus');
const TextMirror = require('./textMirror');
const ImageOutbox = require('./imageOutbox');
const mediaInbox = require('./mediaInbox');

// The privileged Message Content intent must be enabled in the Discord developer
// portal. Probe it with a throwaway login so the REAL client never crash-loops if
// it isn't enabled. Resolves true only if a login with that intent succeeds.
async function probeMessageContent(token) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val, probe) => { if (done) return; done = true; try { probe.destroy(); } catch (_) {} resolve(val); };
    let probe;
    try {
      probe = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent] });
    } catch (_) { resolve(false); return; }
    probe.once('ready', () => finish(true, probe));
    probe.once('clientReady', () => finish(true, probe));
    probe.on('error', () => finish(false, probe));
    probe.login(token).catch(() => finish(false, probe));
    setTimeout(() => finish(false, probe), 8000);
  });
}

async function main() {
  const problems = validate();
  if (problems.length) {
    log.error('Cannot start — configuration incomplete:');
    problems.forEach((p) => log.error('  - ' + p));
    process.exit(1);
  }
  dave.report();

  const linkManager = new LinkManager();
  const wakeSpotter = new WakeSpotter(config.wake().phrase); // kept in sync with the app per-utterance
  const receiver = new VoiceReceiver({ linkManager, wakeSpotter });
  const textMirror = new TextMirror();
  const session = new BridgeSession({ receiver, textMirror });
  // Watch the local outbox for manager-dropped images → post them to the channel.
  const imageOutbox = new ImageOutbox({ textMirror });
  imageOutbox.start();
  // Heartbeat the bridge's in-voice state to the backend so the desktop app can
  // mute its local-mic wake word while the bot is in a call (no double trigger).
  startBridgeStatusReporter({ linkManager, session });
  // Wake-acknowledgment sounds played into the channel (see voiceReceive).
  receiver.onWakeAck = () => session.playWakeAck();
  receiver.onCommandAck = () => session.playCommandAck();
  // Mirror each heard utterance into the text channel ("Heard:").
  receiver.onHeard = (text) => textMirror.postHeard(text);
  // Echo gate: the receiver asks the session whether the bot is currently
  // playing audio (TTS/SFX) so it can ignore self-voice/echo.
  receiver.isBotSpeaking = () => session.isBotSpeaking();

  // Plain image/video drops need the privileged Message Content intent. Probe for
  // it first so the real client never fails to start if it isn't enabled in the
  // portal; /prompt with an attachment works either way.
  let useMessageContent = false;
  if (config.enableMessageContent) {
    useMessageContent = await probeMessageContent(config.discordToken);
    if (useMessageContent) log.success('Message Content intent available — plain image/video drops enabled.');
    else log.warn('Message Content intent NOT enabled in the Discord portal — plain image/video drops are OFF (/prompt still works). Enable it in the portal, then restart.');
  }
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages, // receive messageCreate (non-privileged)
  ];
  if (useMessageContent) intents.push(GatewayIntentBits.MessageContent);
  const client = new Client({ intents });

  // Track each speaker's mute state so the receiver can treat MUTE as the off
  // switch for always-listen (criterion 2). selfMute = the user muted their mic;
  // serverMute = an admin muted them. Either stops capture.
  client.on('voiceStateUpdate', (oldState, newState) => {
    try {
      if (newState.guild?.id !== config.guildId) return;
      if (newState.id === client.user?.id) return; // ignore the bot itself
      receiver.setMute(newState.id, !!(newState.selfMute || newState.serverMute));
    } catch (err) {
      log.warn('voiceStateUpdate handler error:', err.message);
    }
  });

  // AUTO-FORWARD: any plain TEXT and/or image/video the user posts in the
  // text-mirror channel is forwarded to the manager automatically (no /prompt
  // needed), exactly like a voice memo. Media is saved locally and its path is
  // appended.
  //
  // FEEDBACK-LOOP GUARD: never forward the bot's OWN messages — its Heard/Replied
  // mirrors, image posts, and manager-text posts (Feature B). Filter on author ==
  // the bot's own id AND ignore any bot/webhook author.
  client.on('messageCreate', async (message) => {
    try {
      if (message.author?.id === client.user?.id) return; // our own message → never loop back
      if (message.author?.bot || message.webhookId) return; // other bots / webhooks
      if (message.guildId !== config.guildId) return;
      // AUTHORIZATION: only allow-listed users' messages are auto-forwarded to
      // the manager. Unauthorized posts are ignored silently (no channel spam);
      // they can run any slash command to see how to allow themselves.
      if (!auth.isAuthorized(message.author?.id)) return;
      const ch = textMirror.channel;
      const inMirror = (ch && message.channelId === ch.id) ||
        (config.textChannelId && message.channelId === config.textChannelId);
      if (!inMirror) return;

      const media = message.attachments ? [...message.attachments.values()].filter(mediaInbox.isMedia) : [];
      const text = (message.content || '').trim();
      if (!media.length && !text) return; // nothing forwardable (e.g. a non-media file only)

      // Auto-forward only when linked; unlinked → skip silently (no channel spam).
      if (!linkManager.isLinked()) return;

      let saved = [];
      let skipped = [];
      if (media.length) { const r = await mediaInbox.saveAttachments(media); saved = r.saved; skipped = r.skipped; }

      if (!text && !saved.length) { // media present but all failed to download, and no text
        message.react('⚠️').catch(() => {});
        if (skipped.length) message.reply(`⚠️ Couldn't take that: ${skipped.map((s) => s.reason).join(', ')}`).catch(() => {});
        return;
      }
      // Frame by source: attachment(s) → 'file' (with saved path[s]); plain text → 'typed'.
      const res = await linkManager.forward(text, { source: saved.length ? 'file' : 'typed', paths: saved });
      message.react(res && res.ok ? '✅' : '❌').catch(() => {});
    } catch (err) {
      log.warn('messageCreate handler error:', err.message);
    }
  });

  let ready = false;
  const onReady = async () => {
    if (ready) return;
    ready = true;
    log.success(`logged in as ${client.user.tag}.`);
    receiver.botUserId = client.user.id; // exclude the bot's own stream from capture
    try {
      await commands.register(client, config.guildId);
      log.success(`slash commands registered in guild ${config.guildId}.`);
    } catch (err) {
      log.error('failed to register slash commands (is the bot invited with applications.commands scope?):', err.message);
    }
    // Loudly flag the deny-by-default security posture if no allow-list is set.
    if (!auth.isConfigured()) {
      log.warn('SECURITY: DISCORD_ALLOWED_USER_IDS is unset → ALL commands are DENIED by default.');
      log.warn('  Run any slash command in Discord to see your user ID, add it to .env as');
      log.warn('  DISCORD_ALLOWED_USER_IDS=<your id>, then restart the bridge.');
    } else {
      log.success(`authorization active — ${auth.allowList().length} allowed user id(s).`);
    }
    // Resolve the text-mirror channel NOW (at login), so text/image posting, the
    // mirror, and inbound message forwarding all work whenever the bot is LINKED —
    // no voice channel required. (Only live audio capture needs a voice channel.)
    try {
      const guild = client.guilds.cache.get(config.guildId) || await client.guilds.fetch(config.guildId);
      if (guild) await textMirror.resolve(guild);
    } catch (e) { log.warn('text mirror resolve at login failed:', e.message); }
    log.info('IDLE and ready. In Discord: run /link <key> to connect (text + images work right away; join a voice channel too for voice).');
  };
  client.once('clientReady', onReady);
  client.once('ready', onReady);

  client.on('interactionCreate', (interaction) => {
    log.info(`interaction received: type=${interaction.type} command=${interaction.commandName || '-'} from ${interaction.user?.tag || '?'}`);
    commands.handle(interaction, { linkManager, session }).catch((err) => {
      log.error('command handler error:', err.stack || err.message);
      if (interaction.isRepliable && interaction.isRepliable()) {
        const msg = '❌ Something went wrong handling that command.';
        (interaction.deferred || interaction.replied
          ? interaction.editReply(msg)
          : interaction.reply({ content: msg, ephemeral: true })).catch(() => {});
      }
    });
  });

  client.on('error', (err) => log.error('discord client error:', err.message));

  const shutdown = async () => {
    log.info('shutting down bridge…');
    try { await session.leave(); } catch (_) {}
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.login(config.discordToken);
}

main().catch((err) => {
  log.error('fatal:', err.stack || err.message);
  process.exit(1);
});
