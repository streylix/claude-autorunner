'use strict';

// Notify the manager (terminal 999) when a worker terminal opens a genuine
// interactive prompt (permission dialog / select menu) and is blocked awaiting
// input — the counterpart to the existing turn-completion push.
//
// The trigger is NOT the raw `prompted` status (which also fires for long
// "thinking" turns that trip Claude's idle notification). Instead, on a
// prompted transition we read the terminal's on-screen buffer and only notify
// when it actually shows an interactive menu (see prompt-detector). That same
// screen check is the shell guard: a bare shell cannot render a Claude menu.
//
// Reuses the manager's existing dispatch() (queues to 999) via the gui, so it
// touches neither ManagerInstance nor main. De-dupes per prompt.

const { detectPrompt } = require('./prompt-detector');

const MANAGER_TERMINAL_ID = 999;
const DEFAULT_SCREEN_DELAY_MS = 350; // let the menu paint after the notification hook
// Cooldown before the SAME prompt may notify again. A prompt that flickers
// (prompted -> idle -> prompted) or redraws would otherwise re-fire each cycle;
// this window collapses that into one notification without delaying a genuinely
// new/different prompt (which carries a different key and is never debounced).
const DEFAULT_DEBOUNCE_MS = 8000;

class PromptWatchManager {
  constructor(eventBus, appStateStore, gui, opts = {}) {
    this.eventBus = eventBus;
    this.appStateStore = appStateStore;
    this.gui = gui;
    this.screenDelayMs = opts.screenDelayMs != null ? opts.screenDelayMs : DEFAULT_SCREEN_DELAY_MS;
    this.minNotifyIntervalMs = opts.minNotifyIntervalMs != null ? opts.minNotifyIntervalMs : DEFAULT_DEBOUNCE_MS;
    // Injectable so tests run synchronously; defaults to a real deferred timer.
    this._schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
    // Injectable clock so the debounce is testable without real time.
    this._now = opts.now || (() => Date.now());
    // terminalId -> { key, at } of the last dispatched prompt. Deliberately NOT
    // cleared when the terminal leaves prompted, so a flicker back into the same
    // prompt within the debounce window is suppressed.
    this._lastNotify = new Map();
    this.eventBus.on('terminal:status:changed', (e) => this.onStatusChanged(e));
  }

  onStatusChanged(e) {
    if (!e || e.terminalId == null) return;
    if (e.status !== 'prompted') return;           // only act on entering a prompt
    if (e.source !== 'claude-hook') return;        // only ground-truth hook prompts
    if (e.terminalId === MANAGER_TERMINAL_ID) return; // never the manager itself
    // Defer briefly so the menu has painted before we read the screen.
    this._schedule(() => this.checkAndNotify(e.terminalId, e.detail), this.screenDelayMs);
  }

  isEnabled() {
    const v = this.appStateStore.getState('managerPromptWatchEnabled');
    return !(v === false || v === 'false'); // default on
  }

  checkAndNotify(terminalId, detail) {
    if (!this.isEnabled()) return;
    if (terminalId === MANAGER_TERMINAL_ID) return;
    const mgr = this.gui.managerInstance;
    if (!mgr || !mgr.running) return; // nobody to notify

    const dump = this.gui.readTerminalScreen(terminalId);
    if (!dump || !dump.ok || !dump.screen) return;

    const prompt = detectPrompt(dump.screen);
    if (!prompt) return; // not a real menu/prompt -> suppress (no spam)

    const key = `${terminalId}|${prompt.question}|${prompt.options.map((o) => o.text).join('|')}`;
    const prev = this._lastNotify.get(terminalId);
    const now = this._now();
    // Debounce: suppress a repeat of the SAME prompt within the cooldown window
    // (handles flicker/redraws). A different prompt has a different key and is
    // notified immediately; the same prompt may re-notify once the window passes.
    if (prev && prev.key === key && (now - prev.at) < this.minNotifyIntervalMs) return;
    this._lastNotify.set(terminalId, { key, at: now });

    const term = this.gui.terminalStateManager.getTerminal(terminalId);
    const title = (term && term.title) || `Terminal ${terminalId}`;
    mgr.dispatch(this.buildNote(terminalId, title, prompt, detail));

    this.eventBus.emit('log:action', {
      message: `Manager notified: terminal ${terminalId} awaiting input`,
      type: 'info',
    });
  }

  buildNote(terminalId, title, prompt, detail) {
    const opts = prompt.options.map((o) => `  ${o.num}. ${o.text}`).join('\n');
    const notif = detail && detail.message ? `\nNotification: ${detail.message}` : '';
    return (
      `Terminal ${terminalId} ("${title}") is AWAITING INPUT — it has an interactive ` +
      `prompt open and is blocked until answered.${notif}\n\n` +
      `Question: ${prompt.question}\n` +
      `Options:\n${opts}\n\n` +
      `To unblock it, send the chosen answer to terminal ${terminalId} via the control ` +
      `API (queue the option number, or the appropriate keystrokes). Don't leave it blocked.`
    );
  }
}

PromptWatchManager.TERMINAL_ID = MANAGER_TERMINAL_ID;

module.exports = PromptWatchManager;
