'use strict';

// Rotatable, LOCAL-ONLY session linking.
//
// Problem: the bot must reach the manager's control API (127.0.0.1:<port> with
// X-CCBOT-Token), but those creds change every app session AND the raw control
// token must never travel through Discord (a pasted key passes through Discord's
// servers).
//
// Design — "link vault" (a local credential broker on tmpfs):
//   - The MANAGER (which holds the live CCBOT_PORT/CCBOT_TOKEN in its env) runs
//     tools/make-link-key.js. That mints a random LINK-TOKEN, writes the real
//     creds + link-token into a 0600 vault file under $XDG_RUNTIME_DIR (local,
//     loopback, wiped on reboot), and prints a paste-able Discord command.
//   - The pasted KEY carries ONLY { port, linkToken } — NOT the control token.
//     So a key leaked via Discord is (a) useless without local machine access
//     and (b) revocable.
//   - The BOT, on /link, decodes the key and RESOLVES it against the vault: if
//     the link-token matches and hasn't expired, it reads the real control token
//     from the vault (local file read — never over the network) and holds it in
//     memory.
//   - ROTATION: the manager re-runs the tool → a fresh link-token overwrites the
//     vault → any previously pasted key no longer resolves. The underlying app
//     token is unchanged. Re-paste the new key to re-link.

const fs = require('fs');
const path = require('path');
const os = require('os');

const KEY_VERSION = 1;

function defaultVaultPath() {
  const base = process.env.XDG_RUNTIME_DIR || `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}`;
  return path.join(base, 'ccbot-bridge', 'vault.json');
}

function vaultPath() {
  return process.env.CCBOT_LINK_VAULT || defaultVaultPath();
}

// base64url helpers (Buffer supports 'base64url' on Node >=15).
function b64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function b64urlDecode(str) {
  return JSON.parse(Buffer.from(String(str).trim(), 'base64url').toString('utf8'));
}

// The pasted Discord key encodes only the local port + the link-token.
function encodeKey({ port, linkToken }) {
  return b64urlEncode({ v: KEY_VERSION, port, lt: linkToken });
}
function decodeKey(key) {
  const o = b64urlDecode(key);
  if (!o || o.v !== KEY_VERSION || !o.port || !o.lt) throw new Error('unrecognized or malformed link key');
  return { port: Number(o.port), linkToken: String(o.lt) };
}

// MANAGER side: write/overwrite the vault (rotation = overwrite).
function writeVault({ port, token, managerId, linkToken, ttlSec }) {
  const p = vaultPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const now = Date.now();
  const record = {
    v: KEY_VERSION,
    port: Number(port),
    token: String(token),
    managerId: Number(managerId) || 999,
    linkToken: String(linkToken),
    issuedAt: now,
    // No time-based expiry by default: a key stays valid until the app/bridge
    // restarts (control port rotates) or the user regenerates (new linkToken
    // overwrites this vault). Only an explicit positive ttlSec sets a real expiry.
    expiresAt: Number(ttlSec) > 0 ? now + Number(ttlSec) * 1000 : null,
  };
  // Write 0600 atomically (write temp + rename), so the secret is never group/world readable.
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (_) {}
  return record;
}

// BOT side: resolve a pasted key against the vault → live control creds.
// Throws with a user-friendly message on any mismatch / expiry / missing vault.
function resolveKey(key) {
  const { port, linkToken } = decodeKey(key);
  const p = vaultPath();
  let record;
  try {
    record = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    throw new Error('no active link on this machine — ask the manager to generate a fresh key.');
  }
  if (record.linkToken !== linkToken) {
    throw new Error('this key was superseded or is invalid (a newer key was issued). Ask the manager for the current key.');
  }
  if (record.port !== port) {
    throw new Error('key/port mismatch — generate a fresh key.');
  }
  // expiresAt is null when the key has no time limit (the default now). Only
  // enforce expiry if an explicit expiresAt was set.
  if (record.expiresAt && Date.now() > record.expiresAt) {
    throw new Error('this key has expired — ask the manager to generate a fresh one.');
  }
  return {
    host: '127.0.0.1',
    port: record.port,
    token: record.token,
    managerId: record.managerId || 999,
    expiresAt: record.expiresAt,
  };
}

// BOT side: resolve the vault's current record directly (no pasted key).
// Local-trust shortcut for same-box auto-link flows: anything that can read
// the 0600 vault already holds the creds, so no link-token proof is needed.
function resolveLatest() {
  const p = vaultPath();
  let record;
  try {
    record = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    throw new Error('no active link vault on this machine — ask the manager to generate a key.');
  }
  if (record.expiresAt && Date.now() > record.expiresAt) {
    throw new Error('the current link key has expired — ask the manager to generate a fresh one.');
  }
  return {
    host: '127.0.0.1',
    port: record.port,
    token: record.token,
    managerId: record.managerId || 999,
    expiresAt: record.expiresAt,
  };
}

// Generate a fresh random link-token (URL-safe).
function mintLinkToken() {
  return require('crypto').randomBytes(18).toString('base64url');
}

module.exports = {
  KEY_VERSION, vaultPath, encodeKey, decodeKey, writeVault, resolveKey, resolveLatest, mintLinkToken,
};
