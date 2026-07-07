'use strict';

// OUTPUT path: manager voice -> Discord.
//
// Polls GET /api/tts/notifications/?after=<lastId>&limit=50 (no auth). Each new
// row carries an audio_url to a real WAV. We fetch the WAV and hand the buffer
// to the audio player, which streams it into the voice channel.
//
// On startup we SEED lastId from the newest existing notification so history is
// not replayed. Each played clip is optionally marked played on the backend.
//
// Double-audio note: the in-app player ALSO plays each clip. To avoid hearing it
// twice, mute in-app TTS playback while using the Discord bridge (see SETUP.md).

const { config } = require('../config');
const log = require('./log');

class TtsPoller {
  constructor({ onClip, onNotification, watchOnly = false } = {}) {
    this.onClip = onClip;                 // async (wavBuffer, notification) => void
    this.onNotification = onNotification; // (notification) => void — fired for every new row
    this.watchOnly = watchOnly;           // true: don't download/play, just watch (system-audio mode)
    this.lastId = 0;
    this.timer = null;
    this.polling = false;
    this.stopped = false;
  }

  // Seed lastId from the newest notification so we don't replay history.
  async seed() {
    try {
      const res = await fetch(`${config.backendUrl}/api/tts/notifications/?limit=1`);
      const data = await res.json();
      const rows = data.notifications || [];
      this.lastId = rows.length ? Number(rows[0].id) : 0;
      log.info(`TTS poller seeded at notification id ${this.lastId} (history skipped).`);
    } catch (err) {
      log.warn('TTS seed failed, starting from 0:', err.message);
      this.lastId = 0;
    }
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      if (this.stopped) return;
      this.poll().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, config.ttsPollIntervalMs);
      });
    };
    tick();
    log.info(`TTS poller running (every ${config.ttsPollIntervalMs}ms).`);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const url = `${config.backendUrl}/api/tts/notifications/?after=${this.lastId}&limit=50`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const rows = (data.notifications || [])
        .map((r) => ({ ...r, id: Number(r.id) }))
        .filter((r) => r.id > this.lastId)
        .sort((a, b) => a.id - b.id); // oldest first so playback is in order

      for (const row of rows) {
        await this.handle(row);
        this.lastId = Math.max(this.lastId, row.id);
      }
    } catch (err) {
      log.warn('TTS poll error:', err.message);
    } finally {
      this.polling = false;
    }
  }

  async handle(row) {
    // Always notify watchers (e.g. to open the auto-reply window) — both modes.
    try { if (this.onNotification) this.onNotification(row); } catch (_) {}
    // Watch-only (system-audio mode): the monitor already relays the audio into
    // the channel, so don't download/play it here.
    if (this.watchOnly) return;
    if (!row.audio_url) return;
    try {
      const res = await fetch(`${config.backendUrl}${row.audio_url}`);
      if (!res.ok) {
        log.warn(`TTS audio fetch failed for id ${row.id} (HTTP ${res.status}).`);
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      log.info(`manager TTS #${row.id} (${buf.length} bytes): "${String(row.text || '').slice(0, 80)}"`);
      await this.onClip(buf, row);
      if (config.markPlayed) this.markPlayed(row.id);
    } catch (err) {
      log.warn(`TTS handle error for id ${row.id}:`, err.message);
    }
  }

  markPlayed(id) {
    fetch(`${config.backendUrl}/api/tts/notifications/${id}/played/`, { method: 'POST' })
      .catch(() => { /* best-effort */ });
  }
}

module.exports = TtsPoller;
