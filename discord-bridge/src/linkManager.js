'use strict';

// Holds the bot's ACTIVE link (control-API creds) in memory only — never on
// disk. Resolves a pasted key against the local vault (linkVault.js), validates
// it against the live control API, and exposes the target to the rest of the bot.
//
// On app restart the old creds die; the user re-runs the manager tool and pastes
// the new key, which lands here and replaces the target.

const { resolveKey, resolveLatest } = require('./linkVault');
const { checkState, sendVoiceMemo } = require('./controlApi');
const log = require('./log');

class LinkManager {
  constructor() {
    this.target = null;     // { host, port, token, managerId, expiresAt }
    this.linkedAt = null;
  }

  isLinked() {
    return !!this.target;
  }

  // Resolve + validate a pasted key. Returns { ok, message, status? }.
  async link(key) {
    let target;
    try {
      target = resolveKey(key);
    } catch (err) {
      return { ok: false, message: err.message };
    }
    // Validate the creds actually reach a live manager before accepting.
    try {
      const state = await checkState(target);
      if (!state.managerPresent) {
        return { ok: false, message: `linked port reachable, but manager ${target.managerId} not found in /state.` };
      }
      this.target = target;
      this.linkedAt = Date.now();
      log.success(`linked to session — manager ${target.managerId} (status: ${state.managerStatus}) on 127.0.0.1:${target.port}.`);
      return { ok: true, message: `Linked ✅ — manager ${target.managerId} is reachable (status: ${state.managerStatus}).` };
    } catch (err) {
      return { ok: false, message: `key resolved but control API not reachable: ${err.message}` };
    }
  }

  // Auto-link from the local vault (no pasted key) — used when the bot follows
  // you into a voice channel. Validates against the live control API.
  async linkFromVault() {
    let target;
    try {
      target = resolveLatest();
    } catch (err) {
      return { ok: false, message: err.message };
    }
    try {
      const state = await checkState(target);
      if (!state.managerPresent) {
        return { ok: false, message: `manager ${target.managerId} not found in /state.` };
      }
      this.target = target;
      this.linkedAt = Date.now();
      log.success(`auto-linked from vault — manager ${target.managerId} (${state.managerStatus}) on 127.0.0.1:${target.port}.`);
      return { ok: true, message: `manager ${target.managerId} (${state.managerStatus})` };
    } catch (err) {
      return { ok: false, message: `control API not reachable: ${err.message}` };
    }
  }

  unlink() {
    const had = this.isLinked();
    this.target = null;
    this.linkedAt = null;
    if (had) log.info('unlinked from session.');
    return had;
  }

  status() {
    if (!this.target) return { linked: false };
    return {
      linked: true,
      port: this.target.port,
      managerId: this.target.managerId,
      linkedAt: this.linkedAt,
      expiresAt: this.target.expiresAt,
    };
  }

  // Forward a message to the linked manager. opts.source ∈ 'voice'|'typed'|'file'
  // (default 'voice'); opts.paths carries saved file paths for 'file'. No-op if
  // unlinked.
  async forward(text, opts = {}) {
    if (!this.target) {
      log.warn('message received but bot is not linked — ignoring. Paste a /link key to connect.');
      return { ok: false, error: 'not linked' };
    }
    return sendVoiceMemo(this.target, text, opts);
  }
}

module.exports = LinkManager;
