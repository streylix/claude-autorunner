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
//   { "file": "/abs/path/to/draft.md", "caption": "…" }                    → plain-text file, as an ATTACHMENT
// Any descriptor may also carry:
//   "channel": "rma-drafts"  → post into that channel (created on first use)
//                              instead of the default mirror channel.
//   "newThread": "plans"  → T796: create (or reuse an active one by name) a
//                              public thread in that channel and post into it;
//                              the result carries threadId/threadName/created.
//   "wantResult": true       → write <descriptor>.result.json saying what
//                              actually happened, which the post-* CLI reads and
//                              prints, so a post can never fail silently.
// On each tick the bridge posts it (if it's in a channel), then deletes the
// descriptor. Descriptors are left to retry while the bot isn't in a channel, and
// expired (TTL) ones are swept.

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const log = require('./log');
const pathGuard = require('./pathGuard');
const { isResultFile, writeResult } = require('./outbox');

// A descriptor being posted is renamed to this suffix — an atomic "mine" claim.
const CLAIM_SUFFIX = '.posting';

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

  // Orphaned result files — the CLI gave up waiting, or died before reading one
  // — would otherwise pile up in the outbox forever.
  _sweepResults() {
    let names;
    try { names = fs.readdirSync(config.imageOutboxDir); } catch (_) { return; }
    for (const n of names) {
      if (!isResultFile(n)) continue;
      const full = path.join(config.imageOutboxDir, n);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > config.imageDescriptorTtlMs) this._rm(full);
      } catch (_) {}
    }
  }

  // Route one descriptor to the right poster, in the right channel, and report
  // back what happened. desc.channel names a channel to use instead of the
  // default mirror; channelFor() creates it on first use, caches it, and falls
  // back to the default (with a reason) rather than dropping the post.
  async _deliver(desc, f) {
    this.textMirror.lastPostError = null; // don't report a stale reason
    // T796: desc.newThread → create (or reuse by name) a thread in the parent
    // named by desc.channel. No fallback: if the thread can't be had, the post
    // is refused rather than landing somewhere he didn't ask for.
    if (desc.newThread != null) {
      const kind = desc.image ? 'image' : desc.video ? 'video' : desc.file ? 'file' : 'text';
      const t = await this.textMirror.threadFor(desc.channel, desc.newThread);
      if (!t.ok) {
        log.warn(`image outbox: ${t.reason}`);
        return { kind, ok: false, channel: null, requested: desc.channel || null, fallback: false, reason: t.reason };
      }
      const thread = { threadId: t.channel.id, threadName: t.channel.name, parent: t.parent, created: !!t.created };
      const r = await this._post(desc, f, { channel: t.channel }, {
        channel: t.channel.name, requested: desc.channel || null, fallback: false, reason: null,
      });
      return Object.assign(r, thread);
    }
    const target = await this.textMirror.channelFor(desc.channel);
    return this._post(desc, f, { channel: target.channel }, {
      channel: target.name,
      requested: target.requested,
      fallback: !!target.fallback,
      reason: target.reason || null,
    });
  }

  // Post one descriptor to opts.channel; `base` is the routing half of the result.
  async _post(desc, f, opts, base) {
    const refuse = (kind, reason) => {
      log.warn(`image outbox: ${reason}`);
      return Object.assign({ kind }, base, { ok: false, reason });
    };
    const done = (kind, ok) => Object.assign({ kind }, base, {
      ok: !!ok,
      reason: ok ? base.reason
        : (this.textMirror.lastPostError || base.reason || 'the bridge could not post it — see the bridge log'),
    });

    if (desc.image) {
      // Containment: only post files inside an allowed root (defeats
      // arbitrary-path exfiltration via a spoofed descriptor).
      const safe = pathGuard.safeMediaPath(desc.image);
      if (!safe) return refuse('image', `refused image path outside allowed roots or not a file: ${desc.image}`);
      return done('image', await this.textMirror.postImage(safe, desc.caption, opts));
    }
    if (desc.video) {
      const safe = pathGuard.safeMediaPath(desc.video);
      if (!safe) return refuse('video', `refused video path outside allowed roots or not a file: ${desc.video}`);
      return done('video', await this.textMirror.postVideo(safe, desc.caption, desc.maxBytes, opts));
    }
    if (desc.file) {
      const safe = pathGuard.safeMediaPath(desc.file);
      if (!safe) return refuse('file', `refused file path outside allowed roots or not a file: ${desc.file}`);
      return done('file', await this.textMirror.postFile(safe, desc.caption, opts));
    }
    if (typeof desc.text === 'string' && desc.text.trim()) {
      return done('text', await this.textMirror.postText(desc.text, opts));
    }
    return refuse('unknown', `descriptor ${f} has no image, video, file, or text — discarding.`);
  }

  async _tick() {
    if (this.busy) return;
    this._sweepResults();
    let all;
    try {
      all = fs.readdirSync(config.imageOutboxDir);
    } catch (_) { return; } // dir missing → nothing to do
    // Sweep abandoned claims (a bridge that died mid-post) back out of the way.
    for (const f of all.filter((x) => x.endsWith(CLAIM_SUFFIX))) {
      const full = path.join(config.imageOutboxDir, f);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > config.imageDescriptorTtlMs) {
          log.warn(`image outbox: sweeping abandoned claim ${f}.`);
          this._rm(full);
        }
      } catch (_) {}
    }
    const files = all.filter((f) => f.endsWith('.json') && !isResultFile(f));
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

        // CLAIM IT FIRST. rename() is atomic, so if two watchers ever see the
        // same descriptor (a second bridge slipping past the single-instance
        // lock), exactly one wins the rename and posts it — the other moves on
        // instead of posting the manager's message to Discord twice.
        const claimed = full + CLAIM_SUFFIX;
        try { fs.renameSync(full, claimed); }
        catch (_) { continue; } // someone else got there first (or it vanished)

        try {
          const result = await this._deliver(desc, f);
          // Tell the CLI what actually happened (which channel, whether it had
          // to fall back, why it failed) — a post must never vanish quietly.
          if (desc.wantResult) writeResult(full, result);
        } catch (err) {
          // Post blew up — hand the descriptor back so the next tick retries it
          // (unchanged from the pre-claim behaviour), then re-raise nothing.
          log.warn(`image outbox: posting ${f} failed (${err.message}) — will retry.`);
          try { fs.renameSync(claimed, full); } catch (_) {}
          continue;
        }
        // Consume the claim whether the post succeeded or hard-failed (bad
        // path / too big) so it can't loop. (The no-channel case `continue`d above.)
        this._rm(claimed);
      }
    } finally {
      this.busy = false;
    }
  }
}

module.exports = ImageOutbox;
