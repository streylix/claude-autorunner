'use strict';

// Renderer-side widget for the Settings → "Discord Voice Bridge" group.
// Fetches the CURRENT, bridge-acceptable /link key from the main process
// (which mints/reconstructs it from the live control port + the bridge's link
// vault — see main.js 'discord:get-link-key'), shows the ready-to-paste
// "/link <key>" command, and offers one-click Copy + Regenerate.
//
// nodeIntegration is on in this app, so we can use ipcRenderer + clipboard
// directly. Everything degrades gracefully: if the control API isn't up yet, we
// show a clear status and the user can reopen Settings to retry.

const { ipcRenderer } = require('electron');

class DiscordLinkKeyManager {
  constructor() {
    this.input = null;
    this.copyBtn = null;
    this.regenBtn = null;
    this.status = null;
    this._wired = false;
    this._busy = false;
  }

  init() {
    this.input = document.getElementById('discord-link-key');
    this.copyBtn = document.getElementById('discord-link-copy-btn');
    this.regenBtn = document.getElementById('discord-link-regen-btn');
    this.status = document.getElementById('discord-link-status');
    if (!this.input || this._wired) return;
    this._wired = true;

    if (this.copyBtn) this.copyBtn.addEventListener('click', () => this.copy());
    if (this.regenBtn) this.regenBtn.addEventListener('click', () => this.refresh(true));
  }

  // Fetch the key from main and render it. `regenerate` mints a fresh one.
  async refresh(regenerate = false) {
    this.init();
    if (!this.input || this._busy) return;
    this._busy = true;
    if (regenerate && this.regenBtn) this.regenBtn.disabled = true;
    this._setStatus(regenerate ? 'Regenerating…' : 'Loading the current link key…');
    try {
      const res = await ipcRenderer.invoke('discord:get-link-key', { regenerate });
      if (!res || !res.ok) {
        this.input.value = 'Unavailable';
        this._setStatus(`⚠️ ${res && res.error ? res.error : 'Could not get a link key.'}`);
        return;
      }
      this.input.value = res.key; // the BARE key only (paste after /link, or use /resume)
      const expires = res.expiresAt ? new Date(res.expiresAt).toLocaleTimeString() : null;
      this._setStatus(
        `${res.regenerated ? 'New key minted. ' : 'Current key. '}` +
        `Linked to control port ${res.port} · ` +
        (expires ? `valid until ${expires}.` : 'valid until the bridge restarts or you Regenerate.'));
    } catch (err) {
      this.input.value = 'Unavailable';
      this._setStatus(`⚠️ ${err.message}`);
    } finally {
      this._busy = false;
      if (this.regenBtn) this.regenBtn.disabled = false;
    }
  }

  async copy() {
    if (!this.input || !this.input.value || this.input.value === 'Loading…' || this.input.value === 'Unavailable') return;
    try {
      await navigator.clipboard.writeText(this.input.value);
    } catch (_) {
      // Fallback for environments where the async clipboard API is blocked.
      try { this.input.select(); document.execCommand('copy'); } catch (_) {}
    }
    this._flashCopied();
  }

  _flashCopied() {
    if (!this.copyBtn) return;
    const orig = this.copyBtn.textContent;
    this.copyBtn.textContent = '✓ Copied!';
    this.copyBtn.classList.add('copied');
    setTimeout(() => {
      this.copyBtn.textContent = orig;
      this.copyBtn.classList.remove('copied');
    }, 1500);
  }

  _setStatus(text) {
    if (this.status) this.status.textContent = text;
  }
}

module.exports = DiscordLinkKeyManager;
