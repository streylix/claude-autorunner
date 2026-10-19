'use strict';

// Holds the bot's ACTIVE link (control-API creds) in memory only — never on
// disk. Resolves a pasted key against the local vault (linkVault.js), validates
// it against the live control API, and exposes the target to the rest of the bot.
//
// On app restart the old creds die; the user re-runs the manager tool and pastes
// the new key, which lands here and replaces the target.

const { resolveKey, resolveLatest } = require('./linkVault');
const conversationLog = require('./conversationLog');
const { originMeta } = require('./channelRouting');
const { checkState, sendVoiceMemo, sendRawLine, getScreen, getFullState, queueMemo } = require('./controlApi');
const log = require('./log');

class LinkManager {
  constructor() {
    this.target = null;     // { host, port, token, managerId, expiresAt }
    this.linkedAt = null;
    // Optional Codex stand-in (standIn.js), wired by index.js. While it is
    // active, effectiveTarget() swaps the delivery terminal from the manager
    // (999) to the stand-in's terminal — every inbound message follows.
    this.standIn = null;
  }

  // The link, with managerId replaced by the stand-in's terminal when one is
  // active. The real manager id stays in this.target (sendRaw uses it).
  effectiveTarget() {
    if (!this.target) return null;
    const standInId = this.standIn && typeof this.standIn.activeTerminalId === 'function'
      ? this.standIn.activeTerminalId() : null;
    return standInId ? { ...this.target, managerId: standInId } : this.target;
  }

  // After a link is (re-)established, re-validate any stored stand-in against
  // the live app so a dead record never swallows messages.
  async _restoreStandIn() {
    if (!this.standIn || typeof this.standIn.restore !== 'function') return;
    try {
      const r = await this.standIn.restore(this.target);
      if (r.kept) log.info(`stand-in: active — Discord messages route to terminal ${this.standIn.activeTerminalId()} (${r.reason}).`);
      else if (r.reason !== 'none') log.warn(`stand-in: dropped stored stand-in — ${r.reason}. Messages route to the manager.`);
    } catch (err) {
      log.warn('stand-in restore failed:', err.message);
    }
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
      await this._restoreStandIn();
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
      await this._restoreStandIn();
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
    const eff = this.effectiveTarget();
    return {
      linked: true,
      port: this.target.port,
      managerId: this.target.managerId,
      // Where inbound messages actually land right now (999, or the stand-in).
      deliveryTerminalId: eff.managerId || 999,
      standIn: this.standIn && typeof this.standIn.status === 'function' ? this.standIn.status() : null,
      linkedAt: this.linkedAt,
      expiresAt: this.target.expiresAt,
    };
  }

  // Forward a message to the linked manager. opts.source ∈ 'voice'|'typed'|'file'
  // (default 'voice'); opts.paths carries saved file paths for 'file'. No-op if
  // unlinked. Every inbound path (typed auto-forward, /prompt, voice memos)
  // funnels through here — onForwarded (optional, set by index.js) fires after
  // a successful submit so the mirror can show the typing indicator.
  async forward(text, opts = {}) {
    // Log FIRST, before any gate. An unlinked bot still drops the message on the
    // floor for the manager, but what the user said is exactly what we must not
    // lose — that's the whole point of the durable log. Fire-and-forget: not
    // awaited, and it can't throw, so delivery below is untouched either way.
    // source 'synthetic' (bridge self-tests, e.g. tools/t636-roundtrip.sh) is
    // flagged in the row's meta so no reader ever treats it as the user's words.
    const synthetic = opts.source === 'synthetic' || opts.synthetic === true;
    conversationLog.recordInbound({
      text,
      kind: conversationLog.kindForSource(opts.source, opts.paths),
      paths: opts.paths,
      // T792: where he wrote it, when that was not #claude-voice (null otherwise).
      meta: Object.assign({ source: opts.source || 'voice', linked: !!this.target }, originMeta(opts.origin), synthetic ? { synthetic: true } : null),
    });

    if (!this.target) {
      log.warn('message received but bot is not linked — ignoring. Paste a /link key to connect.');
      return { ok: false, error: 'not linked' };
    }
    // effectiveTarget(): the stand-in's terminal while /manager codex is active.
    const res = await sendVoiceMemo(this.effectiveTarget(), text, opts);
    if (res && res.ok && typeof this.onForwarded === 'function') {
      try { this.onForwarded(); } catch (_) { /* indicator must never break delivery */ }
    }
    return res;
  }

  // Type a raw, UNFRAMED line at the linked manager's prompt and submit it (for
  // Claude Code's own slash commands, e.g. /clear). Not a message from the user,
  // so it is not written to the conversation log. No-op if unlinked. Always the
  // REAL manager (this.target), never the stand-in: /clear is Claude Code's
  // command, and resetting 999's context is exactly what a stand-in period is for.
  async sendRaw(line) {
    if (!this.target) return { ok: false, error: 'not linked' };
    return sendRawLine(this.target, line);
  }

  // Read a terminal's live screen through the linked control API (read-only —
  // it types nothing). Same "route control calls through the link" shape as
  // forward(); throws with a human-readable reason the caller can show.
  async readScreen(terminalId, opts = {}) {
    if (!this.target) throw new Error('not linked to a session');
    return getScreen(this.target, terminalId, opts);
  }

  // Full /state terminal list through the linked control API — backs
  // /terminals and the /prompt terminal-id validation. Read-only; throws with
  // a human-readable reason the caller can show.
  async listTerminals() {
    if (!this.target) throw new Error('not linked to a session');
    return getFullState(this.target);
  }

  // Queue a message to a NON-manager terminal (see controlApi.queueMemo) —
  // the /prompt terminal-option counterpart to forward() (which is 999-only).
  // Same durable-log-first shape as forward(): the message is recorded even
  // if delivery then fails.
  async queueToTerminal(terminalId, text, opts = {}) {
    conversationLog.recordInbound({
      text,
      kind: conversationLog.kindForSource(opts.source, opts.paths),
      paths: opts.paths,
      meta: { source: opts.source || 'typed', linked: !!this.target, terminalId },
    });

    if (!this.target) {
      log.warn(`message received for terminal ${terminalId} but bot is not linked — ignoring.`);
      return { ok: false, error: 'not linked' };
    }
    return queueMemo(this.target, terminalId, text, opts);
  }
}

module.exports = LinkManager;
