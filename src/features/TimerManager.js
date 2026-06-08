/**
 * TimerManager - Centralized timer management system
 * Extracted from renderer.js to reduce God Object anti-pattern
 * Manages countdown timers, UI updates, and timer state
 * 
 * Expected reduction: 25 functions from renderer.js → 15 focused functions
 */

class TimerManager {
    constructor(eventBus, appStateStore, backendAPIClient) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        this.backendAPIClient = backendAPIClient;
        
        // Timer state
        this.timerInterval = null;
        this.timerStartTime = null;
        this.timerPausedTime = null;
        
        // Timer configuration
        this.timerHours = 0;
        this.timerMinutes = 5;
        this.timerSeconds = 0;
        this.timerTotalSeconds = 300; // Default 5 minutes
        
        // Original values for reset
        this.originalTimerValues = {
            hours: 0,
            minutes: 5,
            seconds: 0
        };
        
        // Timer state flags
        this.timerRunning = false;
        this.timerPaused = false;
        this.timerExpired = false;
        
        // UI update configuration
        this.updateInterval = 100; // Update every 100ms for smooth display
        this.glowingInterval = null;
        
        // Microwave mode
        this.microwaveMode = false;
        
        this.setupEventSubscriptions();
        this.loadTimerState();
    }
    
    /**
     * Toggle timer between running and paused states
     * Extracted from renderer.js line 3637
     */
    toggleTimer() {
        if (this.timerRunning) {
            this.pauseTimer();
        } else {
            this.startTimer();
        }
    }
    
    /**
     * Toggle timer or injection based on context
     * Extracted from renderer.js line 3644
     */
    toggleTimerOrInjection() {
        const hasQueuedMessages = this.appStateStore.getState('messages.queue').length > 0;
        const activeTerminalId = this.appStateStore.getState('terminals.activeId');
        
        if (hasQueuedMessages && activeTerminalId) {
            // Trigger message injection
            this.eventBus.emit('message:inject:request', { 
                terminalId: activeTerminalId 
            });
        } else {
            this.toggleTimer();
        }
    }
    
    /**
     * Start the timer
     * Extracted from renderer.js line 3661
     */
    async startTimer() {
        if (this.timerRunning && !this.timerPaused) {
            console.log('[TimerManager] Timer already running');
            return;
        }
        
        console.log('[TimerManager] Starting timer');
        
        if (this.timerPaused) {
            // Resume from paused state
            const pausedDuration = Date.now() - this.timerPausedTime;
            this.timerStartTime += pausedDuration;
            this.timerPaused = false;
        } else {
            // Start fresh
            this.timerStartTime = Date.now();
            this.timerTotalSeconds = this.calculateTotalSeconds();
        }
        
        this.timerRunning = true;
        this.timerExpired = false;
        
        // Clear any existing interval
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
        }
        
        // Start countdown interval
        this.timerInterval = setInterval(async () => {
            try {
                await this.decrementTimer();
            } catch (error) {
                console.error('[TimerManager] Error in decrementTimer:', error);
                this.stopTimer();
            }
        }, this.updateInterval);
        
        // Update UI
        this.updateTimerUI();
        
        // Emit start event
        this.eventBus.emit('timer:started', {
            totalSeconds: this.timerTotalSeconds,
            timestamp: Date.now()
        });
        
        // Backend sync
        if (this.backendAPIClient) {
            this.backendAPIClient.startTimer(this.timerMinutes);
        }
    }
    
    /**
     * Pause the timer
     * Extracted from renderer.js line 3696
     */
    pauseTimer() {
        if (!this.timerRunning || this.timerPaused) {
            console.log('[TimerManager] Timer not running or already paused');
            return;
        }
        
        console.log('[TimerManager] Pausing timer');
        
        this.timerPaused = true;
        this.timerPausedTime = Date.now();
        
        // Clear interval
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        
        // Update UI
        this.updateTimerUI();
        
        // Emit pause event
        this.eventBus.emit('timer:paused', {
            remainingSeconds: this.calculateRemainingSeconds(),
            timestamp: Date.now()
        });
        
        // Backend sync
        if (this.backendAPIClient) {
            this.backendAPIClient.pauseTimer();
        }
    }
    
    /**
     * Stop the timer
     * Extracted from renderer.js line 3713
     */
    stopTimer() {
        console.log('[TimerManager] Stopping timer');
        
        // Clear intervals
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        
        if (this.glowingInterval) {
            clearInterval(this.glowingInterval);
            this.glowingInterval = null;
        }
        
        // Reset state
        this.timerRunning = false;
        this.timerPaused = false;
        this.timerExpired = false;
        this.timerStartTime = null;
        this.timerPausedTime = null;
        
        // Reset to original values
        this.resetToOriginalValues();
        
        // Clear storage
        this.clearTimerStorage();
        
        // Update UI
        this.updateTimerUI();
        this.updateTimerDisplay();
        
        // Emit stop event
        this.eventBus.emit('timer:stopped', {
            timestamp: Date.now()
        });
        
        // Backend sync
        if (this.backendAPIClient) {
            this.backendAPIClient.stopTimer();
        }
    }
    
    /**
     * Decrement timer and handle expiration
     * Extracted from renderer.js line 3749
     */
    async decrementTimer() {
        if (!this.timerRunning || this.timerPaused) {
            return;
        }
        
        const elapsedMs = Date.now() - this.timerStartTime;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        const remainingSeconds = Math.max(0, this.timerTotalSeconds - elapsedSeconds);
        
        // Update time values
        this.timerHours = Math.floor(remainingSeconds / 3600);
        this.timerMinutes = Math.floor((remainingSeconds % 3600) / 60);
        this.timerSeconds = remainingSeconds % 60;
        
        // Update display
        this.updateTimerDisplay();
        
        // Check for expiration
        if (remainingSeconds === 0 && !this.timerExpired) {
            this.timerExpired = true;
            await this.handleTimerExpired();
        }
        
        // Handle warning threshold
        const warningThreshold = this.appStateStore.getState('timers.settings.warningSeconds') || 60;
        if (remainingSeconds === warningThreshold) {
            this.eventBus.emit('timer:warning', {
                remainingSeconds,
                timestamp: Date.now()
            });
        }
    }
    
    /**
     * Update timer display in UI
     * Extracted from renderer.js line 3837
     */
    updateTimerDisplay() {
        const formattedTime = this.formatTime(this.timerHours, this.timerMinutes, this.timerSeconds);

        // Update the timer display element (kebab-case id per index.html)
        const timerDisplay = document.getElementById('timer-display');
        if (timerDisplay) {
            timerDisplay.textContent = formattedTime;

            // Update display state classes
            if (this.timerExpired) {
                timerDisplay.classList.add('expired');
                timerDisplay.classList.remove('running', 'paused');
            } else if (this.timerRunning && !this.timerPaused) {
                timerDisplay.classList.add('running');
                timerDisplay.classList.remove('expired', 'paused');
            } else if (this.timerPaused) {
                timerDisplay.classList.add('paused');
                timerDisplay.classList.remove('running', 'expired');
            } else {
                timerDisplay.classList.remove('running', 'paused', 'expired');
            }
        }
        
        // Update glowing effect
        this.updateGlowingEffect();
        
        // Emit display update event
        this.eventBus.emit('timer:display:updated', {
            time: formattedTime,
            hours: this.timerHours,
            minutes: this.timerMinutes,
            seconds: this.timerSeconds
        });
    }
    
    /**
     * Update timer UI state
     * Extracted from renderer.js line 3882
     */
    updateTimerUI() {
        const timerDisplay = document.getElementById('timer-display');
        const playPauseButton = document.getElementById('timer-play-pause-btn');

        if (playPauseButton) {
            // lucide replaces the <i> with an <svg> on first render, so we
            // can't re-set the <i>'s attribute - replace the icon content
            // wholesale and re-run createIcons. This is why pausing didn't
            // visually update the button before.
            const iconName = (this.timerRunning && !this.timerPaused) ? 'pause' : 'play';
            playPauseButton.innerHTML = `<i data-lucide="${iconName}"></i>`;
            if (window.lucide) {
                window.lucide.createIcons({ nameAttr: 'data-lucide', root: playPauseButton });
            }
        }

        // Update timer display appearance
        if (timerDisplay) {
            if (this.timerRunning) {
                timerDisplay.classList.add('active');
            } else {
                timerDisplay.classList.remove('active');
            }
        }
    }
    
    /**
     * Set timer values
     * Extracted from renderer.js line 4212
     */
    setTimer(hours, minutes, seconds, silent = false) {
        // Validate inputs
        hours = Math.max(0, Math.min(23, parseInt(hours) || 0));
        minutes = Math.max(0, Math.min(59, parseInt(minutes) || 0));
        seconds = Math.max(0, Math.min(59, parseInt(seconds) || 0));
        
        // Update values
        this.timerHours = hours;
        this.timerMinutes = minutes;
        this.timerSeconds = seconds;
        
        // Store original values
        this.originalTimerValues = { hours, minutes, seconds };
        
        // Calculate total seconds
        this.timerTotalSeconds = this.calculateTotalSeconds();
        
        // Update display
        this.updateTimerDisplay();
        
        // Save to storage
        this.saveTimerState();
        
        if (!silent) {
            console.log('[TimerManager] Timer set to:', { hours, minutes, seconds });
            
            // Emit timer set event
            this.eventBus.emit('timer:set', {
                hours,
                minutes,
                seconds,
                totalSeconds: this.timerTotalSeconds
            });
        }
    }
    
    /**
     * Start a countdown for an exact number of seconds (used by usage-limit sync).
     * Sets the H:M:S fields from totalSeconds, then starts a fresh countdown.
     * Does NOT overwrite originalTimerValues so a later stop() restores the
     * user's previously configured duration.
     * @param {number} totalSeconds
     */
    startCountdown(totalSeconds) {
        totalSeconds = Math.max(0, Math.floor(totalSeconds) || 0);

        this.timerHours = Math.floor(totalSeconds / 3600);
        this.timerMinutes = Math.floor((totalSeconds % 3600) / 60);
        this.timerSeconds = totalSeconds % 60;
        this.timerTotalSeconds = totalSeconds;

        // Force a fresh start even if a timer was already running.
        this.timerPaused = false;
        this.timerRunning = false;
        this.startTimer();
    }

    /**
     * Whether the timer is actively counting down (running and not paused).
     * @returns {boolean}
     */
    isRunning() {
        return this.timerRunning && !this.timerPaused;
    }

    /**
     * Remaining seconds on the current countdown (0 when stopped/expired).
     * @returns {number}
     */
    getRemainingSeconds() {
        return this.calculateRemainingSeconds();
    }

    /**
     * Reset timer to original values
     */
    resetTimer() {
        this.setTimer(
            this.originalTimerValues.hours,
            this.originalTimerValues.minutes,
            this.originalTimerValues.seconds
        );
        
        this.eventBus.emit('timer:reset', {
            timestamp: Date.now()
        });
    }
    
    /**
     * Handle timer expiration
     */
    async handleTimerExpired() {
        console.log('[TimerManager] Timer expired!');
        
        // Play sound if enabled
        const soundEnabled = this.appStateStore.getState('settings.sound.enabled');
        if (soundEnabled) {
            this.eventBus.emit('sound:play', { type: 'timer-expired' });
        }
        
        // Start glowing effect
        this.startGlowingEffect();
        
        // Emit expiration event
        this.eventBus.emit('timer:expired', {
            timestamp: Date.now()
        });
        
        // Check for auto-restart
        const autoRestart = this.appStateStore.getState('timers.settings.autoRestart');
        if (autoRestart) {
            setTimeout(() => {
                this.resetTimer();
                this.startTimer();
            }, 3000);
        }
    }
    
    /**
     * Update glowing effect for expired timer
     * Extracted from renderer.js line 3853
     */
    updateGlowingEffect() {
        const timerDisplay = document.getElementById('timer-display');
        if (!timerDisplay) return;

        if (this.timerExpired) {
            timerDisplay.classList.add('glowing');
        } else {
            timerDisplay.classList.remove('glowing');
        }
    }
    
    /**
     * Start glowing animation
     */
    startGlowingEffect() {
        if (this.glowingInterval) return;
        
        let glowState = true;
        this.glowingInterval = setInterval(() => {
            const timerDisplay = document.getElementById('timer-display');
            if (timerDisplay) {
                if (glowState) {
                    timerDisplay.classList.add('glow-pulse');
                } else {
                    timerDisplay.classList.remove('glow-pulse');
                }
                glowState = !glowState;
            }
        }, 500);
    }
    
    // ============= Helper Methods =============
    
    /**
     * Calculate total seconds from hours, minutes, seconds
     */
    calculateTotalSeconds() {
        return (this.timerHours * 3600) + (this.timerMinutes * 60) + this.timerSeconds;
    }
    
    /**
     * Calculate remaining seconds
     */
    calculateRemainingSeconds() {
        if (!this.timerStartTime) return this.timerTotalSeconds;
        
        const elapsedMs = Date.now() - this.timerStartTime;
        const elapsedSeconds = Math.floor(elapsedMs / 1000);
        return Math.max(0, this.timerTotalSeconds - elapsedSeconds);
    }
    
    /**
     * Format time for display
     */
    formatTime(hours, minutes, seconds) {
        const h = String(hours).padStart(2, '0');
        const m = String(minutes).padStart(2, '0');
        const s = String(seconds).padStart(2, '0');
        // Always HH:MM:SS so the display matches the inline-edit format
        // (editing parses HH:MM:SS; a bare MM:SS would break the next edit).
        return `${h}:${m}:${s}`;
    }
    
    /**
     * Reset to original values
     */
    resetToOriginalValues() {
        this.timerHours = this.originalTimerValues.hours;
        this.timerMinutes = this.originalTimerValues.minutes;
        this.timerSeconds = this.originalTimerValues.seconds;
        this.timerTotalSeconds = this.calculateTotalSeconds();
    }
    
    /**
     * Save timer state to storage
     */
    saveTimerState() {
        const state = {
            hours: this.timerHours,
            minutes: this.timerMinutes,
            seconds: this.timerSeconds,
            running: this.timerRunning,
            paused: this.timerPaused,
            startTime: this.timerStartTime,
            pausedTime: this.timerPausedTime,
            originalValues: this.originalTimerValues
        };
        
        localStorage.setItem('timerState', JSON.stringify(state));
        
        // Also update app state store
        this.appStateStore.setState('timers.global', state);
    }
    
    /**
     * Load timer state from storage
     */
    loadTimerState() {
        const saved = localStorage.getItem('timerState');
        if (!saved) return;
        
        try {
            const state = JSON.parse(saved);
            
            this.timerHours = state.hours || 0;
            this.timerMinutes = state.minutes || 5;
            this.timerSeconds = state.seconds || 0;
            this.originalTimerValues = state.originalValues || {
                hours: this.timerHours,
                minutes: this.timerMinutes,
                seconds: this.timerSeconds
            };
            
            // Don't restore running state - timer should be stopped on load
            this.timerRunning = false;
            this.timerPaused = false;
            
            this.updateTimerDisplay();
        } catch (error) {
            console.error('[TimerManager] Error loading timer state:', error);
        }
    }
    
    /**
     * Clear timer storage
     * Extracted from renderer.js line 2575
     */
    clearTimerStorage() {
        localStorage.removeItem('timerState');
        this.appStateStore.setState('timers.global', null);
    }
    
    /**
     * Setup event subscriptions
     */
    setupEventSubscriptions() {
        // Timer control events
        this.eventBus.on('timer:toggle', () => this.toggleTimer());
        this.eventBus.on('timer:start', () => this.startTimer());
        this.eventBus.on('timer:pause', () => this.pauseTimer());
        this.eventBus.on('timer:stop', () => this.stopTimer());
        this.eventBus.on('timer:reset', () => this.resetTimer());
        
        // Timer set event
        this.eventBus.on('timer:set:request', ({ hours, minutes, seconds }) => {
            this.setTimer(hours, minutes, seconds);
        });
        
        // Timer toggle or injection
        this.eventBus.on('timer:toggle:or:inject', () => {
            this.toggleTimerOrInjection();
        });
        
        // Microwave mode
        this.eventBus.on('timer:microwave:toggle', () => {
            this.microwaveMode = !this.microwaveMode;
            this.eventBus.emit('timer:microwave:changed', { enabled: this.microwaveMode });
        });
    }
    
    /**
     * Get current timer state
     */
    getState() {
        return {
            hours: this.timerHours,
            minutes: this.timerMinutes,
            seconds: this.timerSeconds,
            totalSeconds: this.timerTotalSeconds,
            running: this.timerRunning,
            paused: this.timerPaused,
            expired: this.timerExpired,
            remainingSeconds: this.calculateRemainingSeconds()
        };
    }
    
    /**
     * Destroy timer manager and cleanup
     */
    destroy() {
        this.stopTimer();
        
        if (this.glowingInterval) {
            clearInterval(this.glowingInterval);
        }
        
        // Remove all event subscriptions
        this.eventBus.off('timer:*');
    }
}

module.exports = TimerManager;