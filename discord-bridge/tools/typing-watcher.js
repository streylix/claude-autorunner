#!/usr/bin/env node
'use strict';

// STANDALONE typing-indicator watcher — runs as its OWN process, fully
// independent of the running bridge (which must never be restarted).
//
// Mirrors the manager terminal's (999) RUNNING state into Discord's typing
// indicator: while 999 is actively running a turn/tool, the bot appears to be
// "typing…" in the text-mirror channel; when 999 goes idle/prompted it stops.
//
//   node tools/typing-watcher.js            # run the watcher loop
//   node tools/typing-watcher.js --once     # fire ONE typing pulse and exit (test)
//
// How it works (all stateless HTTP — nothing touches the bridge's gateway):
//   1. Control creds come from the link vault (src/linkVault.resolveLatest),
//      re-read every poll so an app restart (port rotation) heals itself.
//   2. Polls GET /state (~2s) and reads terminal <managerId>'s status.
//   3. status === 'running' → POST /channels/{id}/typing (Discord REST) with
//      the bot token from .env. Refreshed every ~8s (Discord expires ~10s).
//   4. Any other status → stop firing; the indicator expires on its own
//      (Discord has no cancel endpoint, so it may linger ≤10s after idle).
//
// Channel resolution mirrors textMirror.js: DISCORD_TEXT_CHANNEL_ID if set,
// else the guild text channel named config.textChannelName ('claude-voice').

const { config } = require('../config');
const { resolveLatest } = require('../src/linkVault');

const POLL_MS = parseInt(process.env.TYPING_POLL_MS, 10) || 2000;
const REFRESH_MS = parseInt(process.env.TYPING_REFRESH_MS, 10) || 8000;
const DISCORD_API = 'https://discord.com/api/v10';

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Discord REST ──

async function discordGet(pathname) {
  const res = await fetch(`${DISCORD_API}${pathname}`, {
    headers: { Authorization: `Bot ${config.discordToken}` },
  });
  if (!res.ok) throw new Error(`GET ${pathname} → HTTP ${res.status}`);
  return res.json();
}

let channelId = config.textChannelId || null;
let channelName = null;

// One-time (cached) resolution of the text-mirror channel, same order as
// textMirror.js: explicit id → guild text channel by name.
async function resolveChannel() {
  if (channelId) return channelId;
  const channels = await discordGet(`/guilds/${config.guildId}/channels`);
  const want = String(config.textChannelName || 'claude-voice').toLowerCase();
  const ch = channels.find((c) => c.type === 0 && String(c.name).toLowerCase() === want);
  if (!ch) throw new Error(`no text channel named #${want} found in guild ${config.guildId}`);
  channelId = ch.id;
  channelName = ch.name;
  log(`typing target resolved → #${ch.name} (${ch.id})`);
  return channelId;
}

// Fire one typing pulse. Returns true on success. Honors 429 retry_after.
async function sendTyping() {
  const id = await resolveChannel();
  const res = await fetch(`${DISCORD_API}/channels/${id}/typing`, {
    method: 'POST',
    headers: { Authorization: `Bot ${config.discordToken}` },
  });
  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    const wait = Math.ceil((data.retry_after || 1) * 1000);
    log(`rate limited on typing — backing off ${wait}ms`);
    await sleep(wait);
    return false;
  }
  if (res.status === 404) { channelId = config.textChannelId || null; throw new Error('channel gone (404) — will re-resolve'); }
  if (!res.ok) throw new Error(`typing POST → HTTP ${res.status}`);
  return true;
}

// ── Control API (read-only) ──

// Re-resolve vault creds every call: tiny tmpfs read, and it means an app
// restart (new port/token) is picked up without touching this process.
async function managerStatus() {
  const target = resolveLatest();
  const res = await fetch(`http://127.0.0.1:${target.port}/state`, {
    headers: { 'X-CCBOT-Token': target.token },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`/state → HTTP ${res.status}`);
  const data = await res.json();
  const mgr = (data.terminals || []).find((t) => Number(t.id) === (target.managerId || 999));
  return mgr ? mgr.status : null;
}

// ── Main loop ──

async function main() {
  if (!config.discordToken) { console.error('DISCORD_BOT_TOKEN missing (.env)'); process.exit(1); }
  if (!config.guildId && !channelId) { console.error('DISCORD_GUILD_ID missing (.env)'); process.exit(1); }

  if (process.argv.includes('--once')) {
    await sendTyping();
    log(`✅ test pulse sent — bot shows as typing in #${channelName || channelId} for ~10s.`);
    return;
  }

  log(`typing watcher up — poll ${POLL_MS}ms, refresh ${REFRESH_MS}ms, manager terminal 999.`);
  let lastTyping = 0;      // when we last pulsed
  let wasRunning = false;  // for transition logs
  let lastErr = '';        // dedupe error spam

  for (;;) {
    try {
      const status = await managerStatus();
      const running = status === 'running';
      if (running !== wasRunning) {
        log(running ? '▶ manager RUNNING — typing on' : `⏹ manager ${status || 'gone'} — typing off (expires ≤10s)`);
        wasRunning = running;
      }
      if (running && Date.now() - lastTyping >= REFRESH_MS) {
        if (await sendTyping()) lastTyping = Date.now();
      }
      lastErr = '';
    } catch (err) {
      if (err.message !== lastErr) { log(`⚠ ${err.message}`); lastErr = err.message; }
    }
    await sleep(POLL_MS);
  }
}

main().catch((err) => { console.error('fatal:', err); process.exit(1); });
