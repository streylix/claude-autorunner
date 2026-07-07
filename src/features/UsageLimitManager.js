/**
 * UsageLimitManager - Detects Claude usage limits and drives the countdown timer
 * to the stated reset time, so the message queue stays paused until the limit
 * lifts.
 *
 * DETECTION (R1): Primary source is the Claude Code *Notification* hook, whose
 * stdin JSON carries a human-readable `message` field (confirmed in the hooks
 * docs via `jq -r '.message'`). The renderer forwards that as the canonical
 * `usageLimit:detected` event. There is NO dedicated usage-limit hook and the
 * `StopFailure` hook (matcher `rate_limit`) has no documented reset-time field,
 * so the structured Notification message is the most reliable signal available.
 * A minimal regex on `terminal:data` is retained as a documented fallback for
 * Claude builds where the limit text only reaches raw terminal output.
 *
 * TIMER (R2): On detection the parsed reset time is pushed into TimerManager via
 * startCountdown(secondsUntilReset); a 1-minute sync interval keeps it accurate.
 *
 * GATE (R3): While waiting, MessageQueueManager.usageLimitWaiting is held true so
 * the injection gate blocks all injection until the timer reaches 0.
 */
const { BoundedSet } = require('../utils/bounded-collections');
const { parseUsageLimitMessage } = require('../utils/usage-limit-parser');

class UsageLimitManager {
    constructor(eventBus, appStateStore) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;

        this.state = {
            modalShowing: false,
            waiting: false,
            cooldownUntil: null,
            timerOriginalValues: null,
            terminals: new Set(),
            processedMessages: new BoundedSet(1000),
            pendingReset: null,
            syncInterval: null,
            resetTime: null,
            autoSyncEnabled: true
        };

        // References set during initialization
        this.injectionManager = null;
        this.timerManager = null;
        this.messageQueueManager = null;

        this.setupEventListeners();
    }

    /**
     * Wire external managers. MUST be called by the renderer after construction.
     * @param {Object} timerManager        - TimerManager instance
     * @param {Object} messageQueueManager - MessageQueueManager instance (owns the injection gate flag)
     */
    setManagers(timerManager, messageQueueManager) {
        this.timerManager = timerManager;
        this.messageQueueManager = messageQueueManager;
    }

    setupEventListeners() {
        // FALLBACK detection path: raw terminal output.
        this.eventBus.on('terminal:data', (data) => {
            if (data && data.data && data.terminalId != null) {
                this.detectUsageLimit(data.data, data.terminalId);
            }
        });

        // PRIMARY detection path: structured Notification-hook message, emitted
        // canonically by the renderer's claude-hook-event handler.
        this.eventBus.on('usageLimit:detected', (data) => {
            if (data && data.resetTime) {
                this.onUsageLimitDetected(data.resetTime, data.terminalId);
            }
        });

        // Timer reached 0 - lift the gate.
        this.eventBus.on('timer:expired', () => {
            if (this.state.waiting) {
                this.handleUsageLimitTimerExpiry();
            }
        });

        // User manually changed the timer - stop auto-sync so we don't fight them.
        this.eventBus.on('timer:manual-change', () => {
            this.stopSync();
        });

        // Slash-command + debug hooks routed from MessageQueueManager.
        this.eventBus.on('usageLimit:status:request', async () => {
            const status = await this.getStatus();
            this.eventBus.emit('log:action', { message: status.message, type: 'info' });
        });
        this.eventBus.on('usageLimit:reset:request', () => this.resetTimer());
        this.eventBus.on('usageLimit:debug:trigger', (data) => {
            const resetTime = data && data.debugResetTime
                ? new Date(data.debugResetTime)
                : new Date(Date.now() + 30000);
            this.onUsageLimitDetected(resetTime, null, { debug: true });
        });
    }

    // ======= DETECTION (R1) =======

    /**
     * Fallback detector: parse the usage-limit message out of raw terminal text.
     * @param {string} data       terminal output chunk
     * @param {number} terminalId
     */
    detectUsageLimit(data, terminalId) {
        const parsed = parseUsageLimitMessage(data);
        if (!parsed) return;

        if (this.isDuplicateDetection(parsed.resetTime)) return;
        if (this.isInCooldownPeriod()) return;

        this.state.terminals.add(terminalId);
        this.onUsageLimitDetected(parsed.resetTime, terminalId);
    }

    /**
     * Central handler once a reset time is known (from hook or terminal data).
     * @param {Date}    resetTime  future Date when the limit lifts
     * @param {number}  [terminalId]
     * @param {Object}  [opts]
     */
    async onUsageLimitDetected(resetTime, terminalId, opts = {}) {
        if (!(resetTime instanceof Date) || isNaN(resetTime.getTime())) return;

        if (!opts.debug) {
            if (this.isDuplicateDetection(resetTime)) return;
            if (this.isInCooldownPeriod()) return;
        }

        // 2-minute cooldown so repeated identical messages don't re-trigger.
        this.state.cooldownUntil = Date.now() + 120000;

        if (terminalId != null) this.state.terminals.add(terminalId);

        this.eventBus.emit('log:action', {
            message: `Usage limit detected - reset at ${resetTime.toLocaleTimeString()}`,
            type: 'warning'
        });

        await this.beginWaiting(resetTime);
    }

    isDuplicateDetection(resetTime) {
        const key = resetTime.toISOString().slice(0, 16); // minute precision
        if (this.state.processedMessages.has(key)) return true;
        this.state.processedMessages.add(key);
        return false;
    }

    isInCooldownPeriod() {
        if (!this.state.cooldownUntil) return false;
        return Date.now() < this.state.cooldownUntil;
    }

    // ======= TIMER (R2) =======

    /**
     * Enter the waiting state: hold the injection gate and drive the timer to
     * the reset time. No modal/user choice required - the gate is automatic so
     * the queue can never inject during a limit.
     */
    async beginWaiting(resetTime) {
        this.state.resetTime = resetTime;
        this.state.waiting = true;

        // Persist for restore-after-restart.
        this.appStateStore.setState('usageLimit.waiting', true);
        this.appStateStore.setState('usageLimit.resetTime', resetTime.toISOString());

        // Hold the injection gate (R3 enforcement point).
        if (this.messageQueueManager) {
            this.messageQueueManager.usageLimitWaiting = true;
        }

        // Remember the user's previous timer config so we can restore on expiry.
        if (this.timerManager && this.timerManager.isRunning()) {
            this.state.timerOriginalValues = {
                remainingSeconds: this.timerManager.getRemainingSeconds()
            };
        }

        // Drive the countdown to the reset time.
        this.syncTimerToReset();
        this.startSync();

        this.eventBus.emit('usageLimit:waiting', { resetTime });

        // Optional modal (best-effort UI; the gate does not depend on it).
        this.displayModal(resetTime);
    }

    startSync() {
        if (!this.state.resetTime || !this.state.autoSyncEnabled) return;
        this.stopSync();
        this.state.syncInterval = setInterval(() => this.syncTimerToReset(), 60000);
    }

    stopSync() {
        if (this.state.syncInterval) {
            clearInterval(this.state.syncInterval);
            this.state.syncInterval = null;
        }
    }

    /**
     * Push remaining-time-until-reset into the timer. Called immediately and on
     * a 1-minute interval to correct drift.
     */
    syncTimerToReset() {
        if (!this.state.resetTime || !this.timerManager) return;

        const diffMs = this.state.resetTime - new Date();
        if (diffMs <= 0) {
            this.stopSync();
            this.handleUsageLimitTimerExpiry();
            return;
        }

        const seconds = Math.floor(diffMs / 1000);
        const currentRemaining = this.timerManager.getRemainingSeconds();

        // Only restart the countdown if it has drifted by >2s to avoid jitter.
        if (!this.timerManager.isRunning() || Math.abs(currentRemaining - seconds) > 2) {
            this.timerManager.startCountdown(seconds);
        }
    }

    // ======= EXPIRY / CLEANUP =======

    async handleUsageLimitTimerExpiry() {
        this.eventBus.emit('log:action', {
            message: 'Usage limit timer expired - injection gate released',
            type: 'info'
        });

        this.state.waiting = false;
        this.stopSync();

        // Release the injection gate (R3).
        if (this.messageQueueManager) {
            this.messageQueueManager.usageLimitWaiting = false;
        }

        // Release the TIMER half of the gate too. The countdown was commandeered
        // for the cooldown, and TimerManager leaves timerRunning=true after a
        // countdown expires (the interval is only cleared on error/explicit
        // stop). So canInjectToTerminal would keep returning "timer still
        // counting down" and the queue would stay frozen even though the limit
        // has lifted. Stop it here so isRunning() is false before the re-drain.
        if (this.timerManager && typeof this.timerManager.stopTimer === 'function') {
            this.timerManager.stopTimer();
        }

        this.appStateStore.setState('usageLimit.waiting', false);
        this.appStateStore.setState('usageLimit.resetTime', null);

        await this.clearTracking();
        this.eventBus.emit('usageLimit:reset');
    }

    async clearTracking() {
        this.state.terminals.clear();
        this.state.processedMessages.clear();
        this.state.cooldownUntil = null;
        this.state.pendingReset = null;
        this.state.resetTime = null;
        this.state.timerOriginalValues = null;
        this.stopSync();
    }

    // ======= MODAL (best-effort UI) =======

    displayModal(resetTime) {
        const modal = document.getElementById('usage-limit-modal');
        if (!modal) return;

        this.state.modalShowing = true;
        modal.classList.add('show');

        const resetTimeSpan = document.getElementById('reset-time');
        if (resetTimeSpan) {
            resetTimeSpan.textContent = resetTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        }

        const yesBtn = document.getElementById('usage-limit-yes');
        const noBtn = document.getElementById('usage-limit-no');
        if (yesBtn) yesBtn.onclick = () => this.dismissModal();
        if (noBtn) noBtn.onclick = () => this.dismissModal();
    }

    dismissModal() {
        const modal = document.getElementById('usage-limit-modal');
        if (modal) modal.classList.remove('show');
        this.state.modalShowing = false;
    }

    // ======= PERSISTENCE / RESTORE =======

    async loadResetTime() {
        try {
            const saved = this.appStateStore.getState('usageLimit.resetTime');
            if (!saved) return;
            const resetTime = new Date(saved);
            if (resetTime > new Date()) {
                await this.beginWaiting(resetTime);
            } else {
                this.appStateStore.setState('usageLimit.resetTime', null);
                this.appStateStore.setState('usageLimit.waiting', false);
            }
        } catch (error) {
            console.error('Failed to load usage limit reset time:', error);
        }
    }

    async initialize() {
        await this.loadResetTime();
    }

    // ======= STATUS / DEBUG =======

    async getStatus() {
        if (!this.state.waiting || !this.state.resetTime) {
            return { message: 'No usage limit active', resetTime: null };
        }
        const minutes = Math.max(0, Math.floor((this.state.resetTime - new Date()) / 60000));
        return {
            message: `Usage limit active - resets in ${minutes} minute(s) at ${this.state.resetTime.toLocaleTimeString()}`,
            resetTime: this.state.resetTime
        };
    }

    resetTimer() {
        this.handleUsageLimitTimerExpiry();
        this.eventBus.emit('log:action', { message: 'Usage limit manually cleared', type: 'info' });
        return true;
    }

    // ======= PUBLIC API =======
    isWaiting() { return this.state.waiting; }
    isModalShowing() { return this.state.modalShowing; }
    getResetTime() { return this.state.resetTime; }
    getTerminals() { return Array.from(this.state.terminals); }
}

module.exports = UsageLimitManager;
