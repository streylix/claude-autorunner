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
const StandIn = require('./standIn');
const VoiceReceiver = require('./voiceReceive');
const BridgeSession = require('./session');
const { WakeSpotter } = require('./wakeWord');
const commands = require('./commands');
const auth = require('./auth');
const { startBridgeStatusReporter } = require('./bridgeStatus');
const TextMirror = require('./textMirror');
const ImageOutbox = require('./imageOutbox');
const singleInstance = require('./singleInstance');
const EventDedupe = require('./eventDedupe');
const TtsPoller = require('./ttsPoller');
const { userLeftTrackedChannel, shouldAutoFollow } = require('./voiceFollowGuard');
const { makeReplyMirrorNotifier } = require('./replyMirror');
const ChannelIgnore = require('./channelIgnore');
const { makeMessageHandler } = require('./inboundText');

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

  // ONE bridge per bot token. Discord fans every gateway event out to EVERY live
  // session, so a second process on this token would download every attachment
  // twice, forward every message to the manager twice, and post every outbox
  // descriptor twice. First one up owns the token; anyone else stops here.
  const lock = singleInstance.acquire(config.instanceLockPath);
  if (!lock.ok) {
    log.error(`Another bridge is already running on this bot token (pid ${lock.pid}) — refusing to start.`);
    log.error('  Two live bridges make Discord deliver every message to both, so the manager acts on');
    log.error(`  everything twice. Stop the other one first:  kill ${lock.pid}`);
    log.error('  (The supported instance is the systemd unit: systemctl --user restart ccbot-discord-bridge.service)');
    process.exit(1);
  }
  if (lock.degraded) log.warn(`single-instance lock unavailable (${lock.degraded}) — starting anyway.`);
  process.on('exit', () => lock.release());

  dave.report();

  const linkManager = new LinkManager();
  // T636: Codex stand-in for the manager (/manager codex | claude). Its state
  // is on disk, so a restart keeps routing to an active stand-in; LinkManager
  // re-validates it against /state every time a link is established.
  const standIn = new StandIn();
  linkManager.standIn = standIn;
  if (standIn.activeTerminalId()) log.info(`stand-in: stored record found — terminal ${standIn.activeTerminalId()} (validated on link).`);
  const wakeSpotter = new WakeSpotter(config.wake().phrase); // kept in sync with the app per-utterance
  const receiver = new VoiceReceiver({ linkManager, wakeSpotter });
  const textMirror = new TextMirror();
  // T792: per-channel off switch (/manager-ignore). #claude-voice is protected.
  const channelIgnore = new ChannelIgnore({
    file: config.channelIgnorePath,
    isProtected: (id) => String(id) === String(textMirror.channel && textMirror.channel.id) ||
      (!!config.textChannelId && String(id) === String(config.textChannelId)),
  });
  log.info(`channel ignore list: ${config.channelIgnorePath} (${channelIgnore.list().filter((r) => r.state === 'ignored').length} ignored).`);
  const session = new BridgeSession({ receiver, textMirror });
  // Watch the local outbox for manager-dropped images → post them to the channel.
  const imageOutbox = new ImageOutbox({ textMirror });
  imageOutbox.start();
  // T521 (c3): the written "Replied:" copy, decoupled from voice. Runs for the
  // life of the process — NOT tied to session.join()/leave() — so it keeps
  // posting even while the bridge has left on the authorized user leaving.
  // watchOnly: never fetches/plays the clip; BridgeSession's own poller (while
  // actually connected) still owns that, gated by session.canPlayAudio().
  const replyMirrorPoller = new TtsPoller({ watchOnly: true, onNotification: makeReplyMirrorNotifier(textMirror) });
  await replyMirrorPoller.seed();
  replyMirrorPoller.start();
  // Heartbeat the bridge's in-voice state to the backend so the desktop app can
  // mute its local-mic wake word while the bot is in a call (no double trigger).
  startBridgeStatusReporter({ linkManager, session });
  // Wake-acknowledgment sounds played into the channel (see voiceReceive).
  receiver.onWakeAck = () => session.playWakeAck();
  receiver.onCommandAck = () => session.playCommandAck();
  // Mirror each heard utterance into the text channel ("Heard:").
  receiver.onHeard = (text) => textMirror.postHeard(text);
  // "Claude is typing…" while the manager works: every inbound user message
  // (typed, /prompt, or voice memo) funnels through linkManager.forward — on a
  // successful submit to 999, light the typing indicator in the mirror channel.
  // It clears when a reply posts (postText/postImage/postVideo/postReplied) or
  // after the 90s cap in textMirror.
  linkManager.onForwarded = () => textMirror.startTyping();
  // Echo gate: the receiver asks the session whether the bot is currently
  // playing audio (TTS/SFX) so it can ignore self-voice/echo.
  receiver.isBotSpeaking = () => session.isBotSpeaking();
  // BARGE-IN: sustained real speech from the user during bot playback cuts the
  // bot's audio (tts: stop the clip; system: mute the forwarded live stream).
  receiver.onBargeIn = (meta) => session.interruptPlayback(meta);

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
  //
  // AUTO-FOLLOW: when an AUTHORIZED user joins (or moves into) a voice channel
  // while the bridge is linked but idle, join them automatically — so voice
  // recovers after a service restart without anyone typing /resume. Debounced so
  // overlapping voice events can't double-join; every step is best-effort.
  let followJoinInFlight = false;
  let leaveInFlight = false;
  client.on('voiceStateUpdate', (oldState, newState) => {
    try {
      if (newState.guild?.id !== config.guildId) return;
      if (newState.id === client.user?.id) return; // ignore the bot itself
      receiver.setMute(newState.id, !!(newState.selfMute || newState.serverMute));

      // T521 (c2): the authorized user left the channel we're bridging — leave
      // too (and stop sending any audio; see session.canPlayAudio()). Anyone
      // else leaving, or the authorized user leaving a channel that isn't
      // ours, changes nothing.
      if (!leaveInFlight && userLeftTrackedChannel({
        trackedChannelId: session.channelId,
        userId: newState.id,
        oldChannelId: oldState.channelId,
        newChannelId: newState.channelId,
        isAuthorized: auth.isAuthorized,
      })) {
        leaveInFlight = true;
        log.info(`authorized user left voice channel ${session.channelId} — leaving too.`);
        session.leave()
          .catch((e) => log.warn('leave-on-user-leave failed:', e.message))
          .finally(() => { leaveInFlight = false; });
        return;
      }

      if (process.env.DISABLE_VOICE_AUTOFOLLOW === '1') return; // voice auto-join disabled (was churning + starving text posts)
      if (followJoinInFlight) return;
      // AUTO-FOLLOW (c4): when the authorized user joins (or moves into) a
      // voice channel while the bridge is linked but idle, join them
      // automatically — so voice recovers (after a leave-on-leave, or a
      // service restart) with no manual step beyond the join itself.
      if (!shouldAutoFollow({
        newChannelId: newState.channelId,
        oldChannelId: oldState.channelId,
        isAuthorized: auth.isAuthorized(newState.id),
        isLinked: linkManager.isLinked(),
        sessionActive: session.isActive(),
      })) return;
      followJoinInFlight = true;
      log.info(`auto-follow: authorized user joined voice ${newState.channelId} — joining them (linked, idle).`);
      session.join(newState.guild, newState.channelId)
        .then(() => log.success('auto-follow: joined — bridge audio is live.'))
        .catch((e) => log.warn('auto-follow join failed (use /resume):', e.message))
        .finally(() => { followJoinInFlight = false; });
    } catch (err) {
      log.warn('voiceStateUpdate handler error:', err.message);
    }
  });

  // AUTO-FORWARD (src/inboundText.js): his text/attachments from #claude-voice
  // — and since T792 from any other text channel or thread, named by source —
  // reach the manager. Channels he switched off with /manager-ignore are
  // dropped there, before forwarding or logging.
  const seenEvents = new EventDedupe();
  client.on('messageCreate', makeMessageHandler({ client, textMirror, linkManager, channelIgnore, seenEvents }));

  // T792: be a member of every thread so its messages reach us — new ones as
  // they are created, existing active ones once at login (see onReady).
  const joinThread = (thread) => {
    if (!thread || thread.guildId !== config.guildId || thread.joined || !thread.joinable) return;
    if (channelIgnore.isIgnored(thread.id, thread.parentId)) return;
    thread.join()
      .then(() => log.info(`joined thread "${thread.name}" (${thread.id}) — reading it.`))
      .catch((e) => log.warn(`could not join thread ${thread.id}: ${e.message}`));
  };
  client.on('threadCreate', (thread) => joinThread(thread));

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
    log.info('voice leave-on-leave armed — the bridge disconnects (and sends no audio) when the authorized user leaves its channel.');
    // Resolve the text-mirror channel NOW (at login), so text/image posting, the
    // mirror, and inbound message forwarding all work whenever the bot is LINKED —
    // no voice channel required. (Only live audio capture needs a voice channel.)
    try {
      const guild = client.guilds.cache.get(config.guildId) || await client.guilds.fetch(config.guildId);
      if (guild) await textMirror.resolve(guild);
      // T792: join the already-active threads so their messages reach us.
      if (guild) {
        const active = await guild.channels.fetchActiveThreads().catch(() => null);
        if (active && active.threads) for (const t of active.threads.values()) joinThread(t);
      }
    } catch (e) { log.warn('text mirror resolve at login failed:', e.message); }
    // AUTO-RESUME: after a service restart, re-link the last saved session and —
    // if that user is sitting in a voice channel right now — rejoin it, so a
    // restart never strands the bridge IDLE mid-conversation. Every step is
    // best-effort: any failure just falls back to the manual /resume flow.
    try {
      const saved = require('./resumeStore').latest();
      if (saved) {
        const linked = await linkManager.link(saved.key);
        if (linked.ok) {
          log.success(`auto-resumed link for ${saved.tag || saved.userId} — ${linked.message}`);
          const guild = client.guilds.cache.get(config.guildId) || await client.guilds.fetch(config.guildId);
          const member = await guild.members.fetch(saved.userId).catch(() => null);
          const channelId = member?.voice?.channelId || config.voiceChannelId;
          if (channelId) {
            await session.join(guild, channelId);
            log.success(`auto-rejoined voice channel ${channelId} after restart.`);
          } else {
            log.info('auto-resume: linked, but the user is not in a voice channel — voice starts when they /resume or re-link.');
          }
        } else {
          log.info(`auto-resume skipped: saved key no longer valid (${linked.message}) — run /link with a fresh key.`);
        }
      }
    } catch (e) { log.warn('auto-resume failed (run /resume manually):', e.message); }
    log.info('IDLE and ready. In Discord: run /link <key> to connect (text + images work right away; join a voice channel too for voice).');
  };
  client.once('clientReady', onReady);
  client.once('ready', onReady);

  client.on('interactionCreate', (interaction) => {
    // Same guard as messageCreate: /prompt carries attachments, so a doubled
    // interaction would also save + forward twice.
    if (seenEvents.seen(interaction.id)) {
      log.warn(`duplicate interactionCreate for ${interaction.id} — dropped (already handled).`);
      return;
    }
    log.info(`interaction received: type=${interaction.type} command=${interaction.commandName || '-'} from ${interaction.user?.tag || '?'}`);
    commands.handle(interaction, { linkManager, session, standIn, textMirror, channelIgnore }).catch((err) => {
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
