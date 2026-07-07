'use strict';

// Watches a local "outbox" directory for descriptors dropped by the manager and
// posts each into the Discord text channel — either an IMAGE attachment or a
// plain TEXT message (the latter is NOT read aloud by TTS).
//
// Why a local file drop: the bridge and the manager already share a local runtime
// dir for linking (vault.json under $XDG_RUNTIME_DIR/ccbot-bridge/), so this reuses
// that exact manager↔bridge channel — no backend change, no new network port,
// deployable by restarting only the bridge.
//
// Descriptor format (one JSON file, written atomically tmp+rename):
//   { "image": "/abs/path/to/shot.png", "caption": "optional caption" }   → image
//   { "video": "/abs/path/to/clip.mp4", "caption": "…", "maxBytes": N }    → video (re-encoded to fit)
//   { "text": "check this link https://…" }                               → text post
// On each tick the bridge posts it (if it's in a channel), then deletes the
// descriptor. Descriptors are left to retry while the bot isn't in a channel, and
// expired (TTL) ones are swept.

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const log = require('./log');
const pathGuard = require('./pathGuard');

class ImageOutbox {
  constructor({ textMirror }) {
    this.textMirror = textMirror;
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    try { fs.mkdirSync(config.imageOutboxDir, { recursive: true }); } catch (_) {}
    this.timer = setInterval(() => {
      this._tick().catch((e) => log.warn('image outbox tick error:', e.message));
    }, config.imagePollIntervalMs);
    if (this.timer.unref) this.timer.unref();
    log.info(`image outbox watching ${config.imageOutboxDir} (every ${config.imagePollIntervalMs}ms).`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _rm(p) { try { fs.unlinkSync(p); } catch (_) {} }

  async _tick() {
    if (this.busy) return;
    let files;
    try {
      files = fs.readdirSync(config.imageOutboxDir).filter((f) => f.endsWith('.json'));
    } catch (_) { return; } // dir missing → nothing to do
    if (!files.length) return;
    files.sort(); // oldest-named first (timestamps in the names)

    this.busy = true;
    try {
      for (const f of files) {
        const full = path.join(config.imageOutboxDir, f);

        // Sweep stale descriptors regardless of channel state.
        let ageMs = 0;
        try { ageMs = Date.now() - fs.statSync(full).mtimeMs; } catch (_) {}
        if (ageMs > config.imageDescriptorTtlMs) {
          log.warn(`image descriptor ${f} expired (${Math.round(ageMs / 1000)}s) — discarding.`);
          this._rm(full);
          continue;
        }

        let desc;
        try { desc = JSON.parse(fs.readFileSync(full, 'utf8')); }
        catch (e) { log.warn(`bad image descriptor ${f} (${e.message}) — discarding.`); this._rm(full); continue; }

        // Not in a channel yet → leave it queued for when the bot joins.
        if (!this.textMirror || !this.textMirror.channel) continue;

        if (desc.image) {
          // Containment: only post files inside an allowed root (defeats
          // arbitrary-path exfiltration via a spoofed descriptor).
          const safe = pathGuard.safeMediaPath(desc.image);
          if (!safe) log.warn(`image outbox: refused image path outside allowed roots or not a file: ${desc.image}`);
          else await this.textMirror.postImage(safe, desc.caption);
        } else if (desc.video) {
          const safe = pathGuard.safeMediaPath(desc.video);
          if (!safe) log.warn(`image outbox: refused video path outside allowed roots or not a file: ${desc.video}`);
          else await this.textMirror.postVideo(safe, desc.caption, desc.maxBytes);
        } else if (typeof desc.text === 'string' && desc.text.trim()) {
          await this.textMirror.postText(desc.text);
        } else {
          log.warn(`image outbox: descriptor ${f} has neither image, video, nor text — discarding.`);
        }
        // Consume the descriptor whether the post succeeded or hard-failed (bad
        // path / too big) so it can't loop. (The no-channel case `continue`d above.)
        this._rm(full);
      }
    } finally {
      this.busy = false;
    }
  }
}

module.exports = ImageOutbox;
