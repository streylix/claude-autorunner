#!/usr/bin/env node
'use strict';

// RUN THIS IN AN APP TERMINAL (ideally the MANAGER, terminal 999) — anywhere the
// live CCBOT_PORT / CCBOT_TOKEN are in the environment.
//
// It mints a fresh, rotatable LINK-TOKEN, writes the real control creds into the
// local 0600 vault (loopback/tmpfs, never leaves the box), and prints a
// paste-able Discord command. Paste that into your private server:  /link <key>
//
// To ROTATE (e.g. if a key leaks): just run this again. The new link-token
// overwrites the vault, so the previous key stops working immediately. The
// underlying app token does NOT change.
//
// Usage:
//   node tools/make-link-key.js [--ttl <seconds>] [--prefix /link]
//   CCBOT_PORT / CCBOT_TOKEN are read from the environment.

const { writeVault, encodeKey, mintLinkToken, vaultPath } = require('../src/linkVault');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const port = parseInt(process.env.CCBOT_PORT, 10);
const token = process.env.CCBOT_TOKEN || '';
const managerId = parseInt(process.env.MANAGER_TERMINAL_ID || '999', 10);
const ttlSec = parseInt(arg('--ttl', '0'), 10); // 0 = no time expiry (default); pass --ttl <sec> to opt in
const prefix = arg('--prefix', '/link');

if (!Number.isInteger(port) || !token) {
  console.error('\n❌ CCBOT_PORT / CCBOT_TOKEN not found in this environment.');
  console.error('   Run this in an auto-injector app terminal (e.g. the manager, terminal 999),');
  console.error('   where those control-API credentials are present.  (Check: env | grep CCBOT)\n');
  process.exit(1);
}

const linkToken = mintLinkToken();
const record = writeVault({ port, token, managerId, linkToken, ttlSec });
const key = encodeKey({ port, linkToken });

const validFor = record.expiresAt
  ? `~${Math.round(ttlSec / 60)} min (until ${new Date(record.expiresAt).toLocaleTimeString()})`
  : 'until the app/bridge restarts or you regenerate (no time limit)';
console.log('\n🔗 CCBOT Discord link key minted (rotatable, local-only).');
console.log(`   • control port : ${port}   manager id: ${managerId}`);
console.log(`   • vault        : ${vaultPath()} (0600)`);
console.log(`   • valid for    : ${validFor}`);
console.log('   • the control TOKEN is NOT in this key — only the port + a revocable link-token.\n');
console.log('Paste this into your Discord server to connect the bot to THIS session:\n');
console.log(`    ${prefix} ${key}\n`);
console.log('(Re-run this command anytime to rotate — the previous key stops working.)\n');
