/**
 * Timer Management Module
 * Handles countdown timers, scheduling, and usage limit synchronization
 */

class TimerManager {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        
        // Core timer state
        this.timerActive = false;
        this.timerHours = 0;
        this.timerMinutes = 0;
        this.timerSeconds = 0;
        this.timerInterval = null;
        this.timerExpired = false;
        
        // Usage limit sync
        this.usageLimitSyncInterval = null;
        this.usageLimitResetTime = null;
        this.autoSyncEnabled = true; // Auto-sync until user manually changes timer
        
        // Timer UI state
        this.usageLimitModalShowing = false;
        this.usageLimitWaiting = false;
        
        // Timer dropdown state
        this.timerDropdownOpen = false;
        
        // Multi-terminal usage limit tracking
        this.terminalsWithUsageLimit = new Set(); // Track which terminals received usage limit notifications
        this.terminalsAwaitingContinue = new Set(); // Track which terminals need continue messages
    }

    // Initialize timer from preferences
    initializeFromPreferences(preferences) {
        this.timerHours = preferences.timerHours || 0;
        this.timerMinutes = preferences.timerMinutes || 0;
        this.timerSeconds = preferences.timerSeconds || 0;
        
        // Load usage limit reset time
        this.loadUsageLimitResetTime();
        
        // Start auto-sync if enabled
        if (this.autoSyncEnabled) {
            this.startUsageLimitSync();
        }
        
        this.updateTimerDisplay();
        this.updateTimerUI();
    }

    // Timer control functions
    toggleTimer() {
        if (this.timerActive) {
            this.pauseTimer();
        } else {
            this.startTimer();
        }
    }

    toggleTimerOrInjection() {
        if (this.gui.isInjecting) {
            this.gui.cancelSequentialInjection();
        } else {
            this.toggleTimer();
        }
    }

    async startTimer() {
        if (this.timerActive) {
            console.warn('Timer already active');
            return false;
        }

        // Validate timer has time set
        if (this.timerHours === 0 && this.timerMinutes === 0 && this.timerSeconds === 0) {
            this.gui.logAction('Cannot start timer: No time set', 'warning');
            return false;
        }

        this.timerActive = true;
        this.timerExpired = false;
        
        // Disable auto-sync when user manually starts timer
        this.disableAutoSync();
        
        // Start the countdown
        this.timerInterval = setInterval(() => {
            this.decrementTimer();
        }, 1000);
        
        this.updateTimerUI();
        this.gui.updateStatusDisplay();
        
        this.gui.logAction(`Timer started: ${this.formatTimer()}`, 'info');
        
        // Start power save blocker if enabled
        if (this.gui.preferences.keepScreenAwake) {
            const { ipcRenderer } = require('electron');
            ipcRenderer.invoke('start-power-save-blocker');
        }
        
        return true;
    }

    pauseTimer() {
        if (!this.timerActive) {
            console.warn('Timer not active');
            return false;
        }

        this.timerActive = false;
        
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        
        this.updateTimerUI();
        this.gui.updateStatusDisplay();
        
        this.gui.logAction(`Timer paused at: ${this.formatTimer()}`, 'info');
        return true;
    }

    stopTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        
        this.timerActive = false;
        this.timerExpired = false;
        
        // Reset to 00:00:00
        this.timerHours = 0;
        this.timerMinutes = 0;
        this.timerSeconds = 0;
        
        this.updateTimerDisplay();
        this.updateTimerUI();
        this.gui.updateStatusDisplay();
        
        this.gui.logAction('Timer stopped and reset', 'info');
        
        // Stop power save blocker
        const { ipcRenderer } = require('electron');
        ipcRenderer.invoke('stop-power-save-blocker');
        
        return true;
    }

    resetTimer() {
        this.stopTimer();
        
        // Reset to saved preference values
        this.timerHours = this.gui.preferences.timerHours || 0;
        this.timerMinutes = this.gui.preferences.timerMinutes || 0;
        this.timerSeconds = this.gui.preferences.timerSeconds || 0;
        
        this.updateTimerDisplay();
        this.updateTimerUI();
        
        this.gui.logAction(`Timer reset to: ${this.formatTimer()}`, 'info');
    }

    // Core timer logic
    async decrementTimer() {
        if (!this.timerActive) return;

        // Decrement seconds
        if (this.timerSeconds > 0) {
            this.timerSeconds--;
        } else if (this.timerMinutes > 0) {
            this.timerMinutes--;
            this.timerSeconds = 59;
        } else if (this.timerHours > 0) {
            this.timerHours--;
            this.timerMinutes = 59;
            this.timerSeconds = 59;
        } else {
            // Timer expired
            await this.handleTimerExpiration();
            return;
        }

        this.updateTimerDisplay();
    }

    async handleTimerExpiration() {
        this.timerActive = false;
        this.timerExpired = true;
        
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        
        this.updateTimerUI();
        this.gui.updateStatusDisplay();
        
        this.gui.logAction('Timer expired - starting injection', 'success');
        
        // Show notification if enabled
        if (this.gui.preferences.showSystemNotifications) {
            const { ipcRenderer } = require('electron');
            ipcRenderer.invoke('show-notification', 'Timer Expired', 'Starting message injection');
        }
        
        // Handle multi-terminal continue messages
        if (this.hasTerminalsAwaitingContinue()) {
            this.injectContinueMessagesToTargetedTerminals();
        } else {
            // Standard injection - start injection normally
            if (this.gui.messageQueue && this.gui.messageQueue.length > 0) {
                this.gui.scheduleNextInjection();
            } else {
                this.gui.logAction('Timer expired but no messages in queue', 'warning');
            }
        }
    }
    
    injectContinueMessagesToTargetedTerminals() {
        const terminalsToTarget = this.getTerminalsAwaitingContinue();
        
        if (terminalsToTarget.length === 0) {
            this.gui.logAction('No terminals awaiting continue messages', 'warning');
            return;
        }
        
        this.gui.logAction(`Injecting continue messages to ${terminalsToTarget.length} terminal(s)`, 'info');
        
        // Create continue messages for each terminal that needs them
        terminalsToTarget.forEach(terminalId => {
            const terminalData = this.gui.terminals.get(terminalId);
            if (terminalData) {
                const terminalName = terminalData.name;
                
                // Create a "continue" message targeted to this specific terminal
                const continueMessage = {
                    id: this.gui.messageQueue.generateMessageId(),
                    content: 'continue',
                    processedContent: 'continue',
                    executeAt: Date.now(),
                    createdAt: Date.now(),
                    timestamp: Date.now(),
                    terminalId: terminalId,
                    sequence: ++this.gui.messageQueue.messageSequenceCounter,
                    isAutoContinue: true // Mark as auto-generated continue message
                };
                
                // Add to message queue
                this.gui.messageQueue.messageQueue.push(continueMessage);
                
                this.gui.logAction(`Added continue message for ${terminalName}`, 'success');
            }
        });
        
        // Clear the awaiting continue terminals set
        this.terminalsAwaitingContinue.clear();
        
        // Update UI and save queue
        this.gui.messageQueue.saveMessageQueue();
        this.gui.messageQueue.updateMessageList();
        this.gui.updateStatusDisplay();
        this.gui.updateTrayBadge();
        
        // Start injection process
        this.gui.scheduleNextInjection();
    }

    // Timer setting and validation
    setTimer(hours, minutes, seconds) {
        // Validate inputs
        hours = Math.max(0, Math.min(23, parseInt(hours) || 0));
        minutes = Math.max(0, Math.min(59, parseInt(minutes) || 0));
        seconds = Math.max(0, Math.min(59, parseInt(seconds) || 0));
        
        this.timerHours = hours;
        this.timerMinutes = minutes;
        this.timerSeconds = seconds;
        
        // Save to preferences
        this.gui.preferences.timerHours = hours;
        this.gui.preferences.timerMinutes = minutes;
        this.gui.preferences.timerSeconds = seconds;
        this.gui.savePreferences();
        
        // Disable auto-sync when user manually sets timer
        this.disableAutoSync();
        
        this.updateTimerDisplay();
        this.updateTimerUI();
        
        this.gui.logAction(`Timer set to: ${this.formatTimer()}`, 'info');
    }

    // Timer display functions
    updateTimerDisplay() {
        const timerDisplay = document.getElementById('timer-display');
        if (timerDisplay) {
            timerDisplay.textContent = this.formatTimer();
        }
    }

    updateTimerUI() {
        const playPauseBtn = document.getElementById('timer-play-pause-btn');
        const stopBtn = document.getElementById('timer-stop-btn');
        
        if (playPauseBtn) {
            const icon = playPauseBtn.querySelector('i');
            if (icon) {
                if (this.timerActive) {
                    icon.setAttribute('data-lucide', 'pause');
                    playPauseBtn.title = 'Pause timer';
                } else {
                    icon.setAttribute('data-lucide', 'play');
                    playPauseBtn.title = 'Start timer';
                }
            }
        }
        
        if (stopBtn) {
            const icon = stopBtn.querySelector('i');
            if (icon) {
                if (this.gui.isInjecting) {
                    icon.setAttribute('data-lucide', 'x');
                    stopBtn.title = 'Cancel injection';
                } else if (this.timerActive || this.timerExpired) {
                    icon.setAttribute('data-lucide', 'square');
                    stopBtn.title = 'Stop timer';
                } else {
                    icon.setAttribute('data-lucide', 'rotate-ccw');
                    stopBtn.title = 'Reset timer';
                }
            }
        }
        
        // Refresh Lucide icons
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    formatTimer() {
        const pad = (num) => num.toString().padStart(2, '0');
        return `${pad(this.timerHours)}:${pad(this.timerMinutes)}:${pad(this.timerSeconds)}`;
    }

    // Timer editing UI
    openTimerEditDropdown() {
        const dropdown = document.querySelector('.timer-edit-dropdown');
        if (dropdown) {
            // Update input values
            const hoursInput = dropdown.querySelector('#timer-hours-input');
            const minutesInput = dropdown.querySelector('#timer-minutes-input');
            const secondsInput = dropdown.querySelector('#timer-seconds-input');
            
            if (hoursInput) hoursInput.value = this.timerHours.toString().padStart(2, '0');
            if (minutesInput) minutesInput.value = this.timerMinutes.toString().padStart(2, '0');
            if (secondsInput) secondsInput.value = this.timerSeconds.toString().padStart(2, '0');
            
            dropdown.style.display = 'block';
            this.timerDropdownOpen = true;
            
            // Focus first input
            if (hoursInput) hoursInput.focus();
        }
    }

    closeTimerDropdown() {
        const dropdown = document.querySelector('.timer-edit-dropdown');
        if (dropdown) {
            dropdown.style.display = 'none';
            this.timerDropdownOpen = false;
        }
    }

    saveTimerFromDropdown() {
        const dropdown = document.querySelector('.timer-edit-dropdown');
        if (!dropdown) return;
        
        const hoursInput = dropdown.querySelector('#timer-hours-input');
        const minutesInput = dropdown.querySelector('#timer-minutes-input');
        const secondsInput = dropdown.querySelector('#timer-seconds-input');
        
        const hours = parseInt(hoursInput?.value) || 0;
        const minutes = parseInt(minutesInput?.value) || 0;
        const seconds = parseInt(secondsInput?.value) || 0;
        
        this.setTimer(hours, minutes, seconds);
        this.closeTimerDropdown();
    }

    // Multi-terminal usage limit management
    markTerminalWithUsageLimit(terminalId) {
        this.terminalsWithUsageLimit.add(terminalId);
        this.terminalsAwaitingContinue.add(terminalId);
        
        const terminalData = this.gui.terminals.get(terminalId);
        const terminalName = terminalData ? terminalData.name : `Terminal ${terminalId}`;
        this.gui.logAction(`Terminal ${terminalName} marked with usage limit - will receive continue message when timer expires`, 'info');
        
        console.log(`Terminal ${terminalId} marked with usage limit`);
    }
    
    clearTerminalUsageLimit(terminalId) {
        this.terminalsWithUsageLimit.delete(terminalId);
        this.terminalsAwaitingContinue.delete(terminalId);
        
        const terminalData = this.gui.terminals.get(terminalId);
        const terminalName = terminalData ? terminalData.name : `Terminal ${terminalId}`;
        this.gui.logAction(`Terminal ${terminalName} usage limit cleared`, 'info');
        
        console.log(`Terminal ${terminalId} usage limit cleared`);
    }
    
    getTerminalsAwaitingContinue() {
        return Array.from(this.terminalsAwaitingContinue);
    }
    
    hasTerminalsAwaitingContinue() {
        return this.terminalsAwaitingContinue.size > 0;
    }

    // Usage limit synchronization
    startUsageLimitSync() {
        if (this.usageLimitSyncInterval) return;
        
        this.usageLimitSyncInterval = setInterval(() => {
            this.updateSyncedTimer();
        }, 5000); // Check every 5 seconds
        
        console.log('Usage limit sync started');
    }

    stopUsageLimitSync() {
        if (this.usageLimitSyncInterval) {
            clearInterval(this.usageLimitSyncInterval);
            this.usageLimitSyncInterval = null;
            console.log('Usage limit sync stopped');
        }
    }

    updateSyncedTimer() {
        if (!this.autoSyncEnabled || this.timerActive) return;
        
        // This would integrate with Claude usage limit detection
        // For now, we'll check if we have a saved reset time
        if (this.usageLimitResetTime) {
            const now = Date.now();
            const resetTime = new Date(this.usageLimitResetTime).getTime();
            
            if (resetTime > now) {
                const diffMs = resetTime - now;
                const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
                const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                const diffSeconds = Math.floor((diffMs % (1000 * 60)) / 1000);
                
                // Only update if significantly different to avoid constant updates
                if (Math.abs(this.timerHours - diffHours) > 0 || 
                    Math.abs(this.timerMinutes - diffMinutes) > 1) {
                    
                    this.timerHours = diffHours;
                    this.timerMinutes = diffMinutes;
                    this.timerSeconds = diffSeconds;
                    
                    this.updateTimerDisplay();
                    this.gui.logAction(`Timer auto-synced to usage limit: ${this.formatTimer()}`, 'info');
                }
            }
        }
    }

    disableAutoSync() {
        this.autoSyncEnabled = false;
        this.stopUsageLimitSync();
        console.log('Auto-sync disabled due to manual timer change');
    }

    setTimerToUsageLimitReset(resetTimeString) {
        try {
            const resetTime = new Date(resetTimeString);
            const now = new Date();
            
            if (resetTime > now) {
                const diffMs = resetTime.getTime() - now.getTime();
                const hours = Math.floor(diffMs / (1000 * 60 * 60));
                const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
                
                this.setTimer(hours, minutes, seconds);
                this.usageLimitResetTime = resetTimeString;
                
                // Save reset time to preferences
                this.gui.preferences.usageLimitResetTime = resetTimeString;
                this.gui.savePreferences();
                
                this.gui.logAction(`Timer set to usage limit reset: ${this.formatTimer()}`, 'success');
                return true;
            }
        } catch (error) {
            console.error('Error setting timer to usage limit reset:', error);
        }
        return false;
    }

    loadUsageLimitResetTime() {
        const savedResetTime = this.gui.preferences.usageLimitResetTime;
        if (savedResetTime) {
            this.usageLimitResetTime = savedResetTime;
            
            // Check if reset time is still in the future
            const resetTime = new Date(savedResetTime);
            const now = new Date();
            
            if (resetTime <= now) {
                // Reset time has passed, clear it
                this.usageLimitResetTime = null;
                delete this.gui.preferences.usageLimitResetTime;
                this.gui.savePreferences();
            }
        }
    }

    // Usage limit modal handling
    showUsageLimitModal() {
        if (this.usageLimitModalShowing) return;
        
        this.usageLimitModalShowing = true;
        this.gui.showModal('usage-limit-modal');
    }

    handleUsageLimitChoice(choice) {
        this.usageLimitModalShowing = false;
        this.gui.closeModal('usage-limit-modal');
        
        if (choice === 'wait') {
            this.usageLimitWaiting = true;
            this.gui.logAction('Waiting for usage limit reset...', 'info');
        } else if (choice === 'continue') {
            this.usageLimitWaiting = false;
            this.gui.logAction('Continuing despite usage limit', 'warning');
        }
    }

    // Timer state getters
    isTimerActive() {
        return this.timerActive;
    }

    isTimerExpired() {
        return this.timerExpired;
    }

    hasTimeSet() {
        return this.timerHours > 0 || this.timerMinutes > 0 || this.timerSeconds > 0;
    }

    getTimerState() {
        return {
            active: this.timerActive,
            expired: this.timerExpired,
            hours: this.timerHours,
            minutes: this.timerMinutes,
            seconds: this.timerSeconds,
            formatted: this.formatTimer(),
            hasTime: this.hasTimeSet()
        };
    }

    // Cleanup
    destroy() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        
        this.stopUsageLimitSync();
        this.timerActive = false;
    }
}

// Export for use in main TerminalGUI class
window.TimerManager = TimerManager;