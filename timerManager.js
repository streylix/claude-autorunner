/**
 * Timer Manager Module
 * 
 * Handles timer functionality including countdown, usage limit sync, and UI updates
 * Extracted from TerminalGUI for better modularity
 */

class TimerManager {
    constructor(logAction, settingsManager) {
        this.logAction = logAction || console.log;
        this.settingsManager = settingsManager;
        
        this.timer = {
            hours: 0,
            minutes: 0,
            seconds: 0,
            isRunning: false,
            isPaused: false,
            intervalId: null,
            originalValues: { hours: 0, minutes: 0, seconds: 0 },
            hasNaturallyCompleted: false
        };
        
        this.usageLimitSync = {
            isEnabled: false,
            resetTime: null,
            syncIntervalId: null,
            autoDisableAfter: 5 * 60 * 60 * 1000 // 5 hours in milliseconds
        };
        
        this.isInitialized = false;
    }

    /**
     * Initialize timer manager
     */
    async initialize() {
        if (this.isInitialized) return;

        try {
            await this.loadTimerSettings();
            this.setupTimerEventListeners();
            this.updateTimerUI();
            await this.loadUsageLimitResetTime();
            this.isInitialized = true;
            this.logAction('Timer manager initialized', 'info');
        } catch (error) {
            this.logAction(`Failed to initialize timer: ${error.message}`, 'error');
        }
    }

    /**
     * Load timer settings from preferences
     */
    async loadTimerSettings() {
        if (this.settingsManager) {
            const prefs = this.settingsManager.preferences;
            this.timer.hours = prefs.timerHours || 0;
            this.timer.minutes = prefs.timerMinutes || 0;
            this.timer.seconds = prefs.timerSeconds || 0;
            this.timer.originalValues = {
                hours: this.timer.hours,
                minutes: this.timer.minutes,
                seconds: this.timer.seconds
            };
        }
    }

    /**
     * Save timer settings to preferences
     */
    async saveTimerSettings() {
        if (this.settingsManager) {
            await this.settingsManager.saveSetting('timerHours', this.timer.hours);
            await this.settingsManager.saveSetting('timerMinutes', this.timer.minutes);
            await this.settingsManager.saveSetting('timerSeconds', this.timer.seconds);
        }
    }

    /**
     * Setup event listeners for timer interface
     */
    setupTimerEventListeners() {
        // Timer control buttons
        const playPauseBtn = document.getElementById('timer-play-pause');
        if (playPauseBtn) {
            playPauseBtn.addEventListener('click', () => this.toggleTimer());
        }

        const stopResetBtn = document.getElementById('timer-stop-reset');
        if (stopResetBtn) {
            stopResetBtn.addEventListener('click', () => this.stopTimer());
        }

        const editTimerBtn = document.getElementById('edit-timer');
        if (editTimerBtn) {
            editTimerBtn.addEventListener('click', (e) => this.openTimerEditDropdown(e));
        }

        // Timer edit dropdown
        this.setupTimerEditEventListeners();
    }

    /**
     * Setup timer edit dropdown event listeners
     */
    setupTimerEditEventListeners() {
        const setTimerBtn = document.getElementById('set-timer-btn');
        if (setTimerBtn) {
            setTimerBtn.addEventListener('click', () => {
                const hours = parseInt(document.getElementById('timer-hours').value) || 0;
                const minutes = parseInt(document.getElementById('timer-minutes').value) || 0;
                const seconds = parseInt(document.getElementById('timer-seconds').value) || 0;
                this.setTimer(hours, minutes, seconds);
            });
        }

        const resetTimerBtn = document.getElementById('reset-timer-btn');
        if (resetTimerBtn) {
            resetTimerBtn.addEventListener('click', () => this.resetTimer());
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            const dropdown = document.getElementById('timer-edit-dropdown');
            const editBtn = document.getElementById('edit-timer');
            if (dropdown && !dropdown.contains(e.target) && e.target !== editBtn) {
                dropdown.style.display = 'none';
            }
        });
    }

    /**
     * Toggle timer between play and pause states
     */
    toggleTimer() {
        if (this.timer.isRunning) {
            this.pauseTimer();
        } else {
            this.startTimer();
        }
    }

    /**
     * Smart toggle between timer and injection control
     * Used when timer and injection controls are combined
     */
    toggleTimerOrInjection() {
        const hasTime = this.timer.hours > 0 || this.timer.minutes > 0 || this.timer.seconds > 0;
        
        if (hasTime) {
            this.toggleTimer();
        } else {
            // If no time set, this would control injection instead
            this.logAction('No timer set - would control injection instead', 'info');
            // This method would need to be connected to injection manager
            if (this.injectionManager) {
                this.injectionManager.toggleInjection();
            }
        }
    }

    /**
     * Start the timer countdown
     */
    startTimer() {
        if (this.timer.hours === 0 && this.timer.minutes === 0 && this.timer.seconds === 0) {
            this.logAction('Cannot start timer: no time set', 'warning');
            return;
        }

        if (this.timer.intervalId) {
            clearInterval(this.timer.intervalId);
        }

        this.timer.isRunning = true;
        this.timer.isPaused = false;
        this.timer.hasNaturallyCompleted = false; // Reset completion flag when starting timer
        
        this.timer.intervalId = setInterval(() => {
            this.decrementTimer();
        }, 1000);

        this.updateTimerUI();
        this.logAction(`Timer started: ${this.getTimerDisplayString()}`, 'info');
    }

    /**
     * Pause the timer and related injections
     */
    pauseTimer() {
        this.timer.isRunning = false;
        this.timer.isPaused = true;
        
        if (this.timer.intervalId) {
            clearInterval(this.timer.intervalId);
            this.timer.intervalId = null;
        }

        this.updateTimerUI();
        this.logAction('Timer paused', 'info');
        
        // Pause injections if injection manager is available
        if (this.injectionManager) {
            this.injectionManager.pauseInProgressInjection();
        }
    }

    /**
     * Stop and reset timer completely
     */
    stopTimer() {
        this.timer.isRunning = false;
        this.timer.isPaused = false;
        this.timer.hasNaturallyCompleted = false; // Reset completion flag when manually stopping
        
        if (this.timer.intervalId) {
            clearInterval(this.timer.intervalId);
            this.timer.intervalId = null;
        }

        // Reset to original values
        this.timer.hours = this.timer.originalValues.hours;
        this.timer.minutes = this.timer.originalValues.minutes;
        this.timer.seconds = this.timer.originalValues.seconds;

        // Clear usage limit tracking when user manually stops timer
        // This prevents the usage limit reset countdown from coming back
        this.clearUsageLimitTracking();

        this.updateTimerUI();
        this.logAction('Timer stopped and reset', 'info');
    }

    /**
     * Reset timer to saved values
     */
    resetTimer() {
        this.stopTimer();
        this.logAction('Timer reset to saved values', 'info');
    }

    /**
     * Decrement timer by one second
     */
    decrementTimer() {
        if (this.timer.seconds > 0) {
            this.timer.seconds--;
        } else if (this.timer.minutes > 0) {
            this.timer.minutes--;
            this.timer.seconds = 59;
        } else if (this.timer.hours > 0) {
            this.timer.hours--;
            this.timer.minutes = 59;
            this.timer.seconds = 59;
        } else {
            // Timer reached zero
            this.onTimerComplete();
            return;
        }

        this.updateTimerDisplay();
    }

    /**
     * Handle timer completion
     */
    onTimerComplete() {
        this.timer.isRunning = false;
        this.timer.isPaused = false;
        this.timer.hasNaturallyCompleted = true;
        
        if (this.timer.intervalId) {
            clearInterval(this.timer.intervalId);
            this.timer.intervalId = null;
        }

        // Immediately stop usage limit sync to prevent timer from restarting
        this.stopUsageLimitSync();

        this.updateTimerUI();
        this.logAction('Timer completed!', 'success');

        // Play completion sound if enabled
        if (this.settingsManager && this.settingsManager.preferences.completionSoundEnabled) {
            this.playCompletionSound();
        }

        // Show notification if enabled
        if (this.settingsManager && this.settingsManager.preferences.showSystemNotifications) {
            this.showTimerNotification();
        }

        // Auto-reset to original values
        setTimeout(() => {
            this.resetTimer();
        }, 2000);
    }

    /**
     * Set timer values
     * @param {number} hours - Hours to set
     * @param {number} minutes - Minutes to set  
     * @param {number} seconds - Seconds to set
     * @param {boolean} silent - Whether to log the action
     */
    async setTimer(hours, minutes, seconds, silent = false) {
        // Validate inputs
        hours = Math.max(0, Math.min(23, parseInt(hours) || 0));
        minutes = Math.max(0, Math.min(59, parseInt(minutes) || 0));
        seconds = Math.max(0, Math.min(59, parseInt(seconds) || 0));

        // Stop current timer if running
        if (this.timer.isRunning) {
            this.stopTimer();
        }

        this.timer.hours = hours;
        this.timer.minutes = minutes;
        this.timer.seconds = seconds;
        this.timer.hasNaturallyCompleted = false; // Reset completion flag when setting new timer
        
        // Update original values
        this.timer.originalValues = { hours, minutes, seconds };

        await this.saveTimerSettings();
        this.updateTimerUI();
        
        // Disable auto-sync when manually setting timer
        this.disableAutoSync(silent);

        if (!silent) {
            this.logAction(`Timer set to: ${this.getTimerDisplayString()}`, 'info');
        }

        // Close edit dropdown
        const dropdown = document.getElementById('timer-edit-dropdown');
        if (dropdown) {
            dropdown.style.display = 'none';
        }
    }

    /**
     * Update all timer UI elements
     */
    updateTimerUI() {
        this.updateTimerDisplay();
        this.updateTimerControls();
        this.updateTimerEditInputs();
    }

    /**
     * Update timer display text
     */
    updateTimerDisplay() {
        const timerDisplay = document.getElementById('timer-display');
        if (timerDisplay) {
            timerDisplay.textContent = this.getTimerDisplayString();
        }
    }

    /**
     * Update timer control buttons
     */
    updateTimerControls() {
        const playPauseBtn = document.getElementById('timer-play-pause');
        const stopResetBtn = document.getElementById('timer-stop-reset');

        if (playPauseBtn) {
            if (this.timer.isRunning) {
                playPauseBtn.innerHTML = '⏸️';
                playPauseBtn.title = 'Pause Timer';
            } else {
                playPauseBtn.innerHTML = '▶️';
                playPauseBtn.title = 'Start Timer';
            }
        }

        if (stopResetBtn) {
            stopResetBtn.innerHTML = '⏹️';
            stopResetBtn.title = 'Stop & Reset Timer';
        }
    }

    /**
     * Update timer edit input values
     */
    updateTimerEditInputs() {
        const hoursInput = document.getElementById('timer-hours');
        const minutesInput = document.getElementById('timer-minutes');
        const secondsInput = document.getElementById('timer-seconds');

        if (hoursInput) hoursInput.value = this.timer.hours;
        if (minutesInput) minutesInput.value = this.timer.minutes;
        if (secondsInput) secondsInput.value = this.timer.seconds;
    }

    /**
     * Get timer display string
     * @returns {string} - Formatted timer string (HH:MM:SS)
     */
    getTimerDisplayString() {
        const h = this.timer.hours.toString().padStart(2, '0');
        const m = this.timer.minutes.toString().padStart(2, '0');
        const s = this.timer.seconds.toString().padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    /**
     * Open timer edit dropdown
     * @param {Event} event - Click event
     */
    openTimerEditDropdown(event) {
        event.stopPropagation();
        const dropdown = document.getElementById('timer-edit-dropdown');
        if (dropdown) {
            dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
            this.updateTimerEditInputs();
        }
    }

    /**
     * Disable auto-sync when user manually sets timer
     * @param {boolean} silent - Whether to log the action
     */
    disableAutoSync(silent = false) {
        if (this.usageLimitSync.isEnabled) {
            this.stopUsageLimitSync();
            if (!silent) {
                this.logAction('Auto-sync disabled due to manual timer setting', 'info');
            }
        }
    }

    /**
     * Set usage limit reset time for auto-sync
     * @param {string} resetTime - Reset time in format "3am" or "11pm"
     */
    async setUsageLimitResetTime(resetTime) {
        try {
            const { ipcRenderer } = require('electron');
            await ipcRenderer.invoke('db-save-setting', 'usageLimitResetTime', resetTime);
            this.usageLimitSync.resetTime = resetTime;
            this.logAction(`Usage limit reset time set to: ${resetTime}`, 'info');
        } catch (error) {
            this.logAction(`Failed to save usage limit reset time: ${error.message}`, 'error');
        }
    }

    /**
     * Load usage limit reset time from database
     */
    async loadUsageLimitResetTime() {
        try {
            const { ipcRenderer } = require('electron');
            const resetTime = await ipcRenderer.invoke('db-get-setting', 'usageLimitResetTime');
            if (resetTime) {
                this.usageLimitSync.resetTime = resetTime;
                this.logAction(`Loaded usage limit reset time: ${resetTime}`, 'info');
            }
        } catch (error) {
            this.logAction(`Failed to load usage limit reset time: ${error.message}`, 'error');
        }
    }

    /**
     * Start usage limit synchronization
     */
    startUsageLimitSync() {
        if (!this.usageLimitSync.resetTime) {
            this.logAction('Cannot start usage limit sync: no reset time set', 'warning');
            return;
        }

        this.stopUsageLimitSync(); // Clear any existing sync

        this.usageLimitSync.isEnabled = true;
        this.usageLimitSync.syncIntervalId = setInterval(() => {
            this.syncTimerWithUsageLimit();
        }, 60000); // Check every minute

        this.syncTimerWithUsageLimit(); // Initial sync
        this.logAction(`Usage limit sync started for reset time: ${this.usageLimitSync.resetTime}`, 'info');
    }

    /**
     * Stop usage limit synchronization
     */
    stopUsageLimitSync() {
        this.usageLimitSync.isEnabled = false;
        
        if (this.usageLimitSync.syncIntervalId) {
            clearInterval(this.usageLimitSync.syncIntervalId);
            this.usageLimitSync.syncIntervalId = null;
        }

        this.logAction('Usage limit sync stopped', 'info');
    }

    /**
     * Sync timer with usage limit reset time
     */
    syncTimerWithUsageLimit() {
        if (!this.usageLimitSync.resetTime) return;

        // Don't sync if timer has naturally completed - let it stay at zero
        if (this.timer.hasNaturallyCompleted) {
            this.logAction('Timer has naturally completed - skipping usage limit sync', 'info');
            return;
        }

        try {
            const now = new Date();
            const resetTime = this.parseResetTime(this.usageLimitSync.resetTime);
            
            if (!resetTime) {
                this.logAction('Invalid reset time format', 'error');
                return;
            }

            // Calculate time until reset
            let resetDateTime = new Date();
            resetDateTime.setHours(resetTime.hour, resetTime.minute, 0, 0);

            // If reset time has passed today, set for tomorrow
            if (resetDateTime <= now) {
                resetDateTime.setDate(resetDateTime.getDate() + 1);
            }

            const timeDiff = resetDateTime - now;
            const hours = Math.floor(timeDiff / (1000 * 60 * 60));
            const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((timeDiff % (1000 * 60)) / 1000);

            // Update timer if not currently running or has different values
            if (!this.timer.isRunning || 
                this.timer.hours !== hours || 
                this.timer.minutes !== minutes || 
                Math.abs(this.timer.seconds - seconds) > 5) {
                
                this.setTimer(hours, minutes, seconds, true);
            }
        } catch (error) {
            this.logAction(`Usage limit sync error: ${error.message}`, 'error');
        }
    }

    /**
     * Parse reset time string (e.g., "3am", "11pm")
     * @param {string} resetTimeString - Reset time string
     * @returns {Object} - Parsed time object with hour and minute
     */
    parseResetTime(resetTimeString) {
        const match = resetTimeString.match(/^(\d{1,2})(am|pm)$/i);
        if (!match) return null;

        let hour = parseInt(match[1]);
        const ampm = match[2].toLowerCase();

        if (ampm === 'pm' && hour !== 12) {
            hour += 12;
        } else if (ampm === 'am' && hour === 12) {
            hour = 0;
        }

        return { hour, minute: 0 };
    }

    /**
     * Clear usage limit tracking data
     */
    async clearUsageLimitTracking() {
        try {
            const { ipcRenderer } = require('electron');
            await ipcRenderer.invoke('db-save-setting', 'usageLimitResetTime', null);
            this.usageLimitSync.resetTime = null;
            this.stopUsageLimitSync();
            this.logAction('Usage limit tracking cleared', 'info');
        } catch (error) {
            this.logAction(`Failed to clear usage limit tracking: ${error.message}`, 'error');
        }
    }

    /**
     * Play completion sound
     */
    playCompletionSound() {
        if (this.settingsManager) {
            const soundFile = this.settingsManager.preferences.completionSoundFile;
            this.playSound(soundFile, 'completion');
        }
    }

    /**
     * Play sound file
     * @param {string} soundFile - Sound file name
     * @param {string} type - Sound type for logging
     */
    playSound(soundFile, type) {
        try {
            const audio = new Audio(`./sounds/${soundFile}`);
            audio.play().catch(error => {
                this.logAction(`Failed to play ${type} sound: ${error.message}`, 'error');
            });
        } catch (error) {
            this.logAction(`Error playing ${type} sound: ${error.message}`, 'error');
        }
    }

    /**
     * Show timer completion notification
     */
    showTimerNotification() {
        try {
            new Notification('Timer Complete', {
                body: 'Your countdown timer has finished!',
                icon: './icon.png'
            });
        } catch (error) {
            this.logAction(`Failed to show notification: ${error.message}`, 'error');
        }
    }

    /**
     * Get timer status information
     * @returns {Object} - Timer status
     */
    getTimerStatus() {
        return {
            isRunning: this.timer.isRunning,
            isPaused: this.timer.isPaused,
            hours: this.timer.hours,
            minutes: this.timer.minutes,
            seconds: this.timer.seconds,
            totalSeconds: this.timer.hours * 3600 + this.timer.minutes * 60 + this.timer.seconds,
            displayString: this.getTimerDisplayString(),
            usageLimitSync: {
                isEnabled: this.usageLimitSync.isEnabled,
                resetTime: this.usageLimitSync.resetTime
            }
        };
    }

    /**
     * Set injection manager dependency
     * @param {Object} injectionManager - Injection manager instance
     */
    setInjectionManager(injectionManager) {
        this.injectionManager = injectionManager;
    }

    /**
     * Destroy and cleanup
     */
    destroy() {
        this.stopTimer();
        this.stopUsageLimitSync();
        this.isInitialized = false;
        this.logAction('Timer manager destroyed', 'info');
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TimerManager;
} else if (typeof window !== 'undefined') {
    window.TimerManager = TimerManager;
}