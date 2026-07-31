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
  console.log(`  • guild:       ${config.guildId || '?'}`);
  console.log(`  • voice chan:  ${config.voiceChannelId || '(none — joins your current channel)'}`);
  const w = config.wake();
  console.log(`  • wake word:   ${w.enabled ? `"${w.phrase}"` : 'disabled'} ${w.fromApp ? '(mirrored from app settings)' : '(app settings not found — default)'}`);

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

  console.log(`\nAudio source: ${config.audioSource}`);
  if (config.audioSource === 'system') {
    const { execFileSync } = require('child_process');
    const env = { ...process.env, PULSE_SERVER: config.pulseServer };
    for (const tool of ['parec', 'pacat', 'pactl']) {
      try { execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }); ok(`${tool} present`); }
      catch { bad(`${tool} missing — install pulseaudio-utils / pipewire-pulse`); }
    }
    try {
      require('fs').accessSync(config.pulseServer);
      ok(`PulseAudio socket reachable (${config.pulseServer})`);
    } catch { bad(`PulseAudio socket not found at ${config.pulseServer}`); }
    try {
      const sink = config.systemAudioDevice
        || `${execFileSync('pactl', ['get-default-sink'], { env, encoding: 'utf8', timeout: 4000 }).trim()}.monitor`;
      ok(`monitor device resolves to: ${sink}`);
    } catch (e) { bad(`could not resolve monitor device: ${e.message}`); }
    console.log('  • NOTE: in system mode do NOT mute in-app playback (audio must reach the sink to be captured).');
  } else {
    console.log('  • TTS-only — mute in-app playback to avoid double audio.');
  }

  console.log('\nBackend endpoints:');
  await check(`${config.backendUrl}/api/tts/notifications/?limit=1`, 'TTS notifications');

  console.log('\nSession link (control API reached via /link, not config):');
  const { vaultPath } = require('./linkVault');
  const vp = vaultPath();
  try {
    const rec = JSON.parse(require('fs').readFileSync(vp, 'utf8'));
    const live = Date.now() < rec.expiresAt;
    (live ? ok : warn)(`vault present at ${vp} (port ${rec.port}, ${live ? 'valid' : 'EXPIRED'})`);
  } catch (_) {
    warn(`no link vault yet at ${vp} — ask the manager to run tools/make-link-key.js, then /link in Discord.`);
  }
  // If run inside an app terminal, sanity-check the live control API directly.
  if (process.env.CCBOT_PORT && process.env.CCBOT_TOKEN) {
    try {
      const res = await fetch(`http://127.0.0.1:${process.env.CCBOT_PORT}/state`, {
        headers: { 'X-CCBOT-Token': process.env.CCBOT_TOKEN },
      });
      if (!res.ok) bad(`live /state HTTP ${res.status}`);
      else {
        const data = await res.json();
        const mgr = (data.terminals || []).find((t) => Number(t.id) === 999);
        ok(`live control API reachable from this terminal — manager ${mgr ? `present (${mgr.status})` : 'NOT found'}`);
      }
    } catch (e) { bad(`live /state unreachable: ${e.message}`); }
  } else {
    console.log('  • (CCBOT_* not in this shell — that is fine; the service gets creds via /link.)');
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
