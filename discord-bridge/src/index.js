'use strict';

// CCBOT Discord voice bridge — entry point.
//
// Wiring:
//   manager TTS  -> TtsPoller -> VoicePlayer -> voice channel   (OUTPUT)
//   voice channel -> VoiceReceiver -> Whisper -> terminal 999   (INPUT)
//
// This is a standalone process. It NEVER touches the Electron app or the manager
// PTY except through the documented control API (POST /terminal/keys). Restarting
// or killing this process has no effect on the running app.

const {
  Client,
  GatewayIntentBits,
} = require('discord.js');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');

const { config, validate } = require('../config');
const log = require('./log');
const dave = require('./dave');
const TtsPoller = require('./ttsPoller');
const VoicePlayer = require('./audioPlayer');
const VoiceReceiver = require('./voiceReceive');

async function main() {
  const problems = validate();
  if (problems.length) {
    log.error('Cannot start — configuration incomplete:');
    problems.forEach((p) => log.error('  - ' + p));
    log.error('Fill in discord-bridge/.env (see .env.example and SETUP.md), then retry.');
    process.exit(1);
  }

  dave.report(); // log DAVE availability up front

  const player = new VoicePlayer();
  const receiver = new VoiceReceiver();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.once('clientReady', () => onReady(client, player, receiver));
  // discord.js v14 emits 'ready'; newer builds renamed to 'clientReady'.
  client.once('ready', () => onReady(client, player, receiver));

  client.on('error', (err) => log.error('discord client error:', err.message));

  // Graceful shutdown — leave the channel cleanly.
  const shutdown = () => {
    log.info('shutting down bridge…');
    try {
      const conn = getVoiceConnection(config.guildId);
      if (conn) conn.destroy();
    } catch (_) { /* ignore */ }
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.login(config.discordToken);
}

let started = false;
async function onReady(client, player, receiver) {
  if (started) return; // guard against both ready/clientReady firing
  started = true;
  log.success(`logged in as ${client.user.tag}.`);

  let guild;
  try {
    guild = await client.guilds.fetch(config.guildId);
  } catch (err) {
    log.error(`cannot fetch guild ${config.guildId}: ${err.message}`);
    return;
  }

  const connection = joinVoiceChannel({
    channelId: config.voiceChannelId,
    guildId: config.guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false, // must hear to receive
    selfMute: false,
  });

  connection.on('error', (err) => log.error('voice connection error:', err.message));
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    log.warn('voice disconnected — attempting to recover…');
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch (_) {
      log.error('could not recover voice connection — destroying.');
      connection.destroy();
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  } catch (err) {
    log.error('voice connection never became Ready (DAVE/negotiation?):', err.message);
    connection.destroy();
    return;
  }

  log.success(`joined voice channel ${config.voiceChannelId}.`);

  player.attach(connection);
  receiver.attach(connection);

  const poller = new TtsPoller({
    onClip: async (wavBuffer, row) => player.enqueue(wavBuffer, `#${row.id}`),
  });
  await poller.seed();
  poller.start();

  log.success('bridge live: manager TTS -> channel, your speech -> terminal 999.');
}

main().catch((err) => {
  log.error('fatal:', err.stack || err.message);
  process.exit(1);
});
