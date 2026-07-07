'use strict';

// Mirrors voice activity into a Discord TEXT channel so the bridge has a visible
// "voice" in the server:
//   • "🎙️ Heard:"   — what the bot transcribed you saying (then forwarded).
//   • "💬 Replied:"  — what the manager said back (its TTS notification text).
//
// Channel resolution (first that works), cached per guild:
//   1. config.textChannelId        (DISCORD_TEXT_CHANNEL_ID)
//   2. an existing text channel named config.textChannelName ("claude-voice")
//   3. create that channel         (needs the bot to have Manage Channels)
// If none works, the mirror disables itself with a clear log and voice keeps
// running. All posts are fire-and-forget — a chat failure never disrupts voice.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { ChannelType, PermissionsBitField, AttachmentBuilder } = require('discord.js');
const { config } = require('../config');
const log = require('./log');

const MAX_LEN = 1900; // Discord hard limit is 2000; leave headroom for the label.

class TextMirror {
  constructor() {
    this.channel = null;
    this._resolving = null;
  }

  enabled() {
    return !!config.textMirrorEnabled;
  }

  // Resolve (and cache) the mirror channel for a guild. Safe to call on every
  // join; returns the channel or null. Never throws.
  async resolve(guild) {
    if (!this.enabled() || !guild) return null;
    if (this.channel && this.channel.guildId === guild.id) return this.channel;
    if (this._resolving) return this._resolving;
    this._resolving = this._doResolve(guild).finally(() => { this._resolving = null; });
    return this._resolving;
  }

  async _doResolve(guild) {
    // 1) Explicit channel id.
    if (config.textChannelId) {
      try {
        const ch = await guild.channels.fetch(config.textChannelId);
        if (ch && ch.isTextBased()) { this.channel = ch; log.info(`text mirror → #${ch.name} (from DISCORD_TEXT_CHANNEL_ID).`); return ch; }
        log.warn(`DISCORD_TEXT_CHANNEL_ID ${config.textChannelId} is not a text channel — falling back.`);
      } catch (err) {
        log.warn(`couldn't fetch DISCORD_TEXT_CHANNEL_ID ${config.textChannelId}: ${err.message} — falling back.`);
      }
    }

    // 2) Existing channel by name (populate the cache first if needed — e.g. when
    // resolving at login before we've joined any voice channel).
    const name = config.textChannelName;
    try {
      if (!guild.channels.cache.size) { await guild.channels.fetch().catch(() => {}); }
      const existing = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === name);
      if (existing) { this.channel = existing; log.info(`text mirror → #${existing.name} (existing).`); return existing; }
    } catch (_) { /* cache miss is fine */ }

    // 3) Create it (needs Manage Channels).
    try {
      const me = guild.members.me;
      if (me && !me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        log.warn(`text mirror disabled: no #${name} channel and the bot lacks Manage Channels. ` +
          `Create a channel and set DISCORD_TEXT_CHANNEL_ID, or grant Manage Channels.`);
        this.channel = null;
        return null;
      }
      const created = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        topic: 'Claude voice bridge — transcripts of what was heard and the manager\'s replies.',
        reason: 'CCBOT Discord voice bridge text mirror',
      });
      this.channel = created;
      log.success(`text mirror → created #${created.name}.`);
      return created;
    } catch (err) {
      log.warn(`text mirror: couldn't create #${name}: ${err.message}. Voice still works; set DISCORD_TEXT_CHANNEL_ID to fix.`);
      this.channel = null;
      return null;
    }
  }

  _post(label, text) {
    if (!this.enabled() || !this.channel) return;
    const body = String(text || '').replace(/\s+/g, ' ').trim();
    if (!body) return;
    const content = `${label} ${body}`.slice(0, MAX_LEN);
    Promise.resolve()
      .then(() => this.channel.send({ content }))
      .catch((err) => log.warn('text mirror post failed:', err.message));
  }

  postHeard(text) { this._post('🎙️ **Heard:**', text); }
  postReplied(text) { this._post('💬 **Replied:**', text); }

  // Post an arbitrary TEXT message straight into the channel AS THE BOT — NOT
  // read aloud by TTS (it's a plain Discord post, never touches the notification/
  // TTS path). Lets the manager share links/text the user can see and click.
  // Chunks over Discord's 2000-char limit. Awaitable; returns true on success.
  async postText(text) {
    if (!this.enabled() || !this.channel) { log.warn('manager text post skipped — no text channel.'); return false; }
    const body = String(text || '').trim();
    if (!body) return false;
    try {
      for (let i = 0; i < body.length; i += 2000) {
        await this.channel.send({ content: body.slice(i, i + 2000) });
      }
      log.success(`📝 posted manager text to #${this.channel.name} (${body.length} chars, not TTS'd).`);
      return true;
    } catch (err) {
      log.warn('manager text post failed:', err.message);
      return false;
    }
  }

  // Post an image FILE as a Discord attachment, with an optional caption. Honors
  // Discord's size limit: oversized images are downscaled (ffmpeg → JPEG); if
  // still too big, it errors gracefully (logged) rather than failing the send.
  // Returns true on a successful post. Awaitable (unlike the fire-and-forget text).
  async postImage(imagePath, caption) {
    if (!this.enabled() || !this.channel) { log.warn('image post skipped — no text channel resolved.'); return false; }
    if (!imagePath || !fs.existsSync(imagePath)) { log.warn(`image post skipped — file not found: ${imagePath}`); return false; }

    let toSend = imagePath;
    let tmp = null;
    try {
      const size = fs.statSync(imagePath).size;
      if (size > config.imageMaxBytes) {
        log.info(`image ${(size / 1e6).toFixed(1)}MB exceeds ${(config.imageMaxBytes / 1e6).toFixed(0)}MB — downscaling…`);
        tmp = await this._downscale(imagePath);
        if (!tmp) { log.warn('image downscale failed — not posting oversized image.'); return false; }
        const newSize = fs.statSync(tmp).size;
        if (newSize > config.imageMaxBytes) {
          log.warn(`image still ${(newSize / 1e6).toFixed(1)}MB after downscale — not posting.`);
          return false;
        }
        toSend = tmp;
        log.info(`downscaled to ${(newSize / 1e6).toFixed(1)}MB.`);
      }
      const name = path.basename(toSend).replace(/[^\w.\-]/g, '_');
      const att = new AttachmentBuilder(toSend, { name });
      const content = caption ? String(caption).replace(/\s+/g, ' ').trim().slice(0, MAX_LEN) : undefined;
      await this.channel.send({ content, files: [att] });
      log.success(`🖼️  posted image to #${this.channel.name}: ${path.basename(imagePath)}${caption ? ` ("${String(caption).slice(0, 60)}")` : ''}.`);
      return true;
    } catch (err) {
      log.warn('image post failed:', err.message);
      return false;
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
    }
  }

  // Post a VIDEO FILE as a Discord attachment, with an optional caption. Honors
  // the upload cap: oversized clips are re-encoded to H.264 mp4 + AAC, iteratively
  // clamping bitrate / downscaling until they fit. If the source is already under
  // the cap it is sent as-is (no re-encode). Errors gracefully (logged) rather than
  // failing the send. Returns true on a successful post. Awaitable.
  async postVideo(videoPath, caption, maxBytesOverride) {
    if (!this.enabled() || !this.channel) { log.warn('video post skipped — no text channel resolved.'); return false; }
    if (!videoPath || !fs.existsSync(videoPath)) { log.warn(`video post skipped — file not found: ${videoPath}`); return false; }

    const cap = Number(maxBytesOverride) > 0 ? Number(maxBytesOverride) : config.videoMaxBytes;
    let toSend = videoPath;
    let tmp = null;
    try {
      const size = fs.statSync(videoPath).size;
      if (size > cap) {
        log.info(`video ${(size / 1e6).toFixed(1)}MB exceeds ${(cap / 1e6).toFixed(0)}MB cap — re-encoding (H.264/AAC)…`);
        tmp = await this._compressVideoToFit(videoPath, cap);
        if (!tmp) { log.warn('video compression failed — not posting oversized video.'); return false; }
        const newSize = fs.statSync(tmp).size;
        if (newSize > cap) {
          log.warn(`video still ${(newSize / 1e6).toFixed(1)}MB after compression (cap ${(cap / 1e6).toFixed(0)}MB) — not posting.`);
          return false;
        }
        toSend = tmp;
        log.info(`compressed to ${(newSize / 1e6).toFixed(1)}MB.`);
      }
      // Give the attachment an .mp4 name when we re-encoded, else keep the original.
      let name = path.basename(toSend).replace(/[^\w.\-]/g, '_');
      if (tmp) name = path.basename(videoPath, path.extname(videoPath)).replace(/[^\w.\-]/g, '_') + '.mp4';
      const att = new AttachmentBuilder(toSend, { name });
      const content = caption ? String(caption).replace(/\s+/g, ' ').trim().slice(0, MAX_LEN) : undefined;
      await this.channel.send({ content, files: [att] });
      log.success(`🎥 posted video to #${this.channel.name}: ${path.basename(videoPath)}${caption ? ` ("${String(caption).slice(0, 60)}")` : ''}.`);
      return true;
    } catch (err) {
      log.warn('video post failed:', err.message);
      return false;
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
    }
  }

  // Resolve the ffmpeg binary: prefer the system build (config.ffmpegPath — has
  // libx264 + aac on this box), fall back to the bundled ffmpeg-static.
  _ffmpeg() {
    try { if (config.ffmpegPath && fs.existsSync(config.ffmpegPath)) return config.ffmpegPath; } catch (_) {}
    return ffmpegPath;
  }

  // Probe a video's duration in seconds. Uses ffprobe when present; otherwise
  // parses "Duration: HH:MM:SS.ss" from ffmpeg's own stderr. Returns 0 if unknown.
  _probeDurationSec(videoPath) {
    return new Promise((resolve) => {
      const done = (v) => resolve(Number.isFinite(v) && v > 0 ? v : 0);
      const tryFfmpeg = () => {
        let stderr = '';
        let p;
        try { p = spawn(this._ffmpeg(), ['-hide_banner', '-i', videoPath], { stdio: ['ignore', 'ignore', 'pipe'] }); }
        catch (_) { return done(0); }
        p.stderr.on('data', (d) => { stderr += d.toString(); });
        p.on('error', () => done(0));
        p.on('close', () => {
          const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
          done(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0);
        });
      };
      let p;
      try {
        p = spawn(config.ffprobePath,
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath],
          { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (_) { return tryFfmpeg(); }
      let out = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.on('error', () => tryFfmpeg());
      p.on('close', (code) => {
        const v = parseFloat(out.trim());
        if (code === 0 && Number.isFinite(v) && v > 0) return done(v);
        tryFfmpeg();
      });
    });
  }

  // Re-encode a video to fit under `cap` bytes. Targets a total bitrate derived
  // from the clip's duration, then iterates: if a pass overshoots, it drops the
  // bitrate (by the observed overshoot ratio) and downscales, clamping until it
  // fits or the floor is hit. Returns the temp mp4 path, or null on failure.
  async _compressVideoToFit(videoPath, cap) {
    const durationSec = await this._probeDurationSec(videoPath);
    const out = path.join(os.tmpdir(), `ccbot-vid-${process.pid}-${Date.now()}.mp4`);

    // Without a known duration we can't target a bitrate → fall back to a CRF ladder.
    if (!durationSec) {
      for (const crf of [28, 32, 36, 40]) {
        const ok = await this._encodeVideo(videoPath, out, { crf, maxWidth: config.videoMaxWidth });
        if (ok && fs.existsSync(out)) {
          if (fs.statSync(out).size <= cap) return out;
        }
      }
      return (fs.existsSync(out) && fs.statSync(out).size <= cap) ? out : (this._rmOut(out), null);
    }

    let safety = 0.90;                 // aim a little under the cap for container overhead
    let width = config.videoMaxWidth;  // downscale ceiling; lowered if bitrate floors out
    const MAX_ATTEMPTS = 5;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const totalK = Math.floor((cap * 8 * safety) / durationSec / 1000); // kbit/s budget
      let audioK = Math.min(config.videoAudioBitrateK, Math.max(32, Math.floor(totalK * 0.2)));
      let videoK = totalK - audioK;

      // Bitrate floored out → shed audio budget, then resolution, before giving up.
      if (videoK < 100) {
        audioK = Math.min(audioK, 48);
        videoK = totalK - audioK;
      }
      if (videoK < 80) {
        if (width > 640) { width = Math.max(640, Math.floor(width / 2)); }
        else if (videoK < 40) { log.warn(`video: bitrate floored (${videoK}kbps @ ${width}px) — clip too long for ${(cap / 1e6).toFixed(0)}MB.`); break; }
      }

      log.info(`video encode attempt ${attempt}: ~${videoK}k video + ${audioK}k audio @ ≤${width}px (dur ${durationSec.toFixed(0)}s).`);
      const ok = await this._encodeVideo(videoPath, out, { videoBitrateK: videoK, audioBitrateK: audioK, maxWidth: width });
      if (!ok || !fs.existsSync(out)) { this._rmOut(out); if (attempt === MAX_ATTEMPTS) return null; continue; }

      const sz = fs.statSync(out).size;
      if (sz <= cap) return out;

      // Overshot → scale the safety factor down by the observed ratio and retry.
      log.info(`video encode attempt ${attempt} => ${(sz / 1e6).toFixed(1)}MB (over ${(cap / 1e6).toFixed(0)}MB) — tightening.`);
      safety = safety * (cap / sz) * 0.95;
      if (attempt % 2 === 0 && width > 640) width = Math.max(640, Math.floor(width * 0.75));
    }
    return (fs.existsSync(out) && fs.statSync(out).size <= cap) ? out : (this._rmOut(out), null);
  }

  _rmOut(p) { try { fs.unlinkSync(p); } catch (_) {} }

  // Run one ffmpeg encode pass (H.264 mp4 + AAC, yuv420p, +faststart). Pass either
  // {videoBitrateK, audioBitrateK} for bitrate targeting or {crf} for a CRF pass.
  // Resolves true on exit code 0.
  _encodeVideo(inPath, outPath, { videoBitrateK, audioBitrateK, crf, maxWidth }) {
    return new Promise((resolve) => {
      const vf = `scale='min(${maxWidth || config.videoMaxWidth},iw)':-2`;
      const args = ['-y', '-i', inPath, '-vf', vf,
        '-c:v', 'libx264', '-preset', config.videoEncodePreset, '-pix_fmt', 'yuv420p'];
      if (crf != null) {
        args.push('-crf', String(crf));
      } else {
        args.push('-b:v', `${videoBitrateK}k`, '-maxrate', `${Math.floor(videoBitrateK * 1.2)}k`,
          '-bufsize', `${videoBitrateK * 2}k`);
      }
      args.push('-c:a', 'aac', '-b:a', `${audioBitrateK || config.videoAudioBitrateK}k`,
        '-movflags', '+faststart', outPath);

      let stderr = '';
      let p;
      try { p = spawn(this._ffmpeg(), args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch (_) { resolve(false); return; }
      p.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
      p.on('error', () => resolve(false));
      p.on('close', (code) => {
        if (code !== 0) log.warn(`ffmpeg exit ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`);
        resolve(code === 0);
      });
    });
  }

  // Downscale/recompress an image to fit the size limit (max width + JPEG).
  // Returns the temp file path, or null on failure.
  _downscale(imagePath) {
    return new Promise((resolve) => {
      const out = path.join(os.tmpdir(), `ccbot-img-${process.pid}-${Date.now()}.jpg`);
      const args = ['-y', '-i', imagePath, '-vf', `scale='min(${config.imageMaxWidth},iw)':-2`, '-q:v', '4', out];
      let p;
      try { p = spawn(ffmpegPath, args, { stdio: 'ignore' }); }
      catch (_) { resolve(null); return; }
      p.on('error', () => resolve(null));
      p.on('close', (code) => resolve(code === 0 && fs.existsSync(out) ? out : null));
    });
  }

  reset() { this.channel = null; }
}

module.exports = TextMirror;
