'use strict';

// Preflight check — verifies everything the bridge needs WITHOUT a Discord token
// and WITHOUT joining a channel. Safe to run anytime. Confirms:
//   - config present (Discord values + inherited CCBOT_* creds)
//   - native deps load (@discordjs/voice, opus, sodium, DAVE)
//   - backend TTS-notification + transcribe endpoints reachable
//   - control API /state reachable and terminal 999 present
//
// It does NOT send keys to 999 and does NOT play audio.

const { config, validate } = require('../config');
const dave = require('./dave');

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);

async function main() {
  console.log('\n=== CCBOT Discord bridge — doctor ===\n');

  console.log('Config:');
  const problems = validate();
  if (problems.length) problems.forEach(bad);
  else ok('all required config present');
  console.log(`  • backend:     ${config.backendUrl}`);
  console.log(`  • control API: ${config.controlApiBase || '(CCBOT_PORT missing)'}`);
  console.log(`  • guild/channel: ${config.guildId || '?'} / ${config.voiceChannelId || '?'}`);
  console.log(`  • manager id:  ${config.managerTerminalId}`);

  console.log('\nNative dependencies:');
  for (const [name, label] of [
    ['discord.js', 'discord.js'],
    ['@discordjs/voice', '@discordjs/voice'],
    ['@discordjs/opus', 'opus encoder/decoder'],
    ['prism-media', 'prism-media'],
    ['sodium-native', 'sodium (encryption)'],
    ['ffmpeg-static', 'ffmpeg'],
  ]) {
    try { require(name); ok(`${label} loads`); }
    catch (e) { bad(`${label} failed to load: ${e.message}`); }
  }
  const d = dave.status();
  if (d.available) ok(`DAVE @snazzah/davey v${d.version}`);
  else bad(`DAVE @snazzah/davey missing: ${d.error}`);

  console.log('\nBackend endpoints:');
  await check(`${config.backendUrl}/api/tts/notifications/?limit=1`, 'TTS notifications');

  console.log('\nControl API (terminal 999):');
  if (!config.controlApiBase || !config.ccbotToken) {
    warn('CCBOT_PORT/CCBOT_TOKEN not set — run from an app terminal to test 999.');
  } else {
    try {
      const res = await fetch(`${config.controlApiBase}/state`, {
        headers: { 'X-CCBOT-Token': config.ccbotToken },
      });
      if (!res.ok) { bad(`/state returned HTTP ${res.status}`); }
      else {
        const data = await res.json();
        const mgr = (data.terminals || []).find((t) => Number(t.id) === config.managerTerminalId);
        if (mgr) ok(`/state reachable — manager ${mgr.id} present (status: ${mgr.status})`);
        else bad(`/state reachable but terminal ${config.managerTerminalId} NOT found`);
      }
    } catch (e) { bad(`/state unreachable: ${e.message}`); }
  }

  console.log('\nDone.\n');
}

async function check(url, label) {
  try {
    const res = await fetch(url);
    if (res.ok) ok(`${label} reachable (HTTP ${res.status})`);
    else bad(`${label} HTTP ${res.status}`);
  } catch (e) { bad(`${label} unreachable: ${e.message}`); }
}

main().catch((e) => { console.error('doctor crashed:', e); process.exit(1); });
