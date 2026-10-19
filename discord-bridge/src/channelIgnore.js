'use strict';

// T792: the per-channel off switch for the manager reading his messages.
//
// /manager-ignore in a channel or thread stops it being forwarded (and logged);
// /manager-listen turns it back on; /manager-channels lists the state. Stored in
// a small JSON file next to the bridge (config.channelIgnorePath) so it survives
// a restart.
//
// A thread follows its parent channel unless it has its own entry, so ignoring
// #general also ignores its threads, and /manager-listen inside one of those
// threads re-enables just that thread (stored as state "listening").
//
// The main channel (#claude-voice) is protected: isProtected(id) refuses it.

const fs = require('fs');
const path = require('path');
const log = require('./log');

class ChannelIgnore {
  constructor({ file, isProtected } = {}) {
    this.file = file;
    this.isProtected = typeof isProtected === 'function' ? isProtected : () => false;
    this.channels = {};
    this._load();
  }

  _load() {
    if (!this.file) return;
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (_) { return; } // no file yet
    try {
      const data = JSON.parse(raw);
      if (data && typeof data.channels === 'object' && data.channels) this.channels = data.channels;
    } catch (err) {
      log.warn(`channel ignore list ${this.file} is unreadable (${err.message}) — starting with nothing ignored.`);
    }
  }

  _save() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, channels: this.channels }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // A channel's own entry wins; a thread without one follows its parent.
  isIgnored(id, parentId) {
    const own = this.channels[String(id)];
    if (own) return own.state === 'ignored';
    if (parentId) {
      const parent = this.channels[String(parentId)];
      if (parent) return parent.state === 'ignored';
    }
    return false;
  }

  ignore(id, name) {
    const key = String(id);
    if (this.isProtected(key)) {
      return { ok: false, changed: false, reason: `#${name || key} is the main channel and can't be ignored.` };
    }
    const cur = this.channels[key];
    if (cur && cur.state === 'ignored') return { ok: true, changed: false };
    this.channels[key] = { state: 'ignored', name: name || null, at: new Date().toISOString() };
    this._save();
    return { ok: true, changed: true };
  }

  // parentId: set for a thread, so listening inside a thread of an ignored
  // channel stores an override instead of being a no-op.
  listen(id, name, { parentId } = {}) {
    const key = String(id);
    const cur = this.channels[key];
    const parentIgnored = parentId && this.channels[String(parentId)] &&
      this.channels[String(parentId)].state === 'ignored';
    if (parentIgnored) {
      if (cur && cur.state === 'listening') return { ok: true, changed: false };
      this.channels[key] = { state: 'listening', name: name || null, parentId: String(parentId), at: new Date().toISOString() };
      this._save();
      return { ok: true, changed: true };
    }
    if (!cur) return { ok: true, changed: false };
    delete this.channels[key];
    this._save();
    return { ok: true, changed: true };
  }

  list() {
    return Object.entries(this.channels).map(([id, v]) => ({ id, state: v.state, name: v.name || null, at: v.at || null }));
  }
}

module.exports = ChannelIgnore;
