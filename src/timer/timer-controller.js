/**
 * Timer Controller Module
 * Handles all timer-related functionality including UI, state management, and persistence
 */

class TimerController {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        
        // Timer state
        this.timerActive = false;
        this.timerHours = 0;
        this.timerMinutes = 0;
        this.timerSeconds = 0;
        this.timerInterval = null;
        this.timerExpired = false;
        
        // Timer control flags
        this.injectionPausedByTimer = false;
        this.usageLimitTimerOriginalValues = null;
        this.autoSyncEnabled = true;
        
        // UI state
        this.originalTimerValues = { hours: 0, minutes: 0, seconds: 0 };
        
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Timer control buttons
        document.getElementById('timer-play-pause-btn')?.addEventListener('click', () => {
            this.toggleTimerOrInjection();
        });

        document.getElementById('timer-stop-btn')?.addEventListener('click', () => {
            const stopBtn = document.getElementById('timer-stop-btn');
            if (stopBtn.classList.contains('timer-refresh')) {
                this.resetTimer();
            } else if (stopBtn.classList.contains('timer-cancel-injection')) {
                this.gui.stopInjection();
            } else {
                this.stopTimer();
            }
        });

        document.getElementById('timer-edit-btn')?.addEventListener('click', (e) => {
            this.openTimerEditDropdown(e);
        });

        document.getElementById('timer-display')?.addEventListener('click', (e) => {
            this.openTimerEditDropdown(e);
        });
    }

    toggleTimer() {
        if (this.timerActive) {
            this.pauseTimer();
        } else {
            this.startTimer();
        }
    }

    toggleTimerOrInjection() {
        // If injection is active, pause/resume injection
        if (this.gui.injectionInProgress) {
            if (this.gui.injectionPaused) {
                this.gui.resumeInjection();
            } else {
                this.gui.pauseInjection();
            }
        } else {
            // Otherwise, toggle timer
            this.toggleTimer();
        }
    }

    startTimer() {
        if (this.timerHours === 0 && this.timerMinutes === 0 && this.timerSeconds === 0) {
            this.gui.logAction('Cannot start timer - time not set', 'warning');
            return;
        }

        // Clear any existing interval
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }

        this.timerActive = true;
        this.timerExpired = false;
        this.updateTimerUI();
        this.saveTimerPreferences();

        // Auto-enable background service when timer starts
        if (!this.gui.backgroundServiceActive) {
            this.gui.enableBackgroundService();
            this.gui.logAction('Background service auto-enabled with timer', 'info');
        }

        // Start the countdown
        this.timerInterval = setInterval(async () => {
            try {
                await this.decrementTimer();
            } catch (error) {
                // Throttle error logs to prevent spam
                if (!this.lastTimerError || Date.now() - this.lastTimerError > 5000) {
                    this.lastTimerError = Date.now();
                    console.error('Timer error:', error);
                    this.gui.logAction(`Timer error: ${error.message}`, 'error');
                }
            }
        }, 1000);

        this.gui.logAction(`Timer started: ${this.getTimerDisplayString()}`, 'info');
    }

    pauseTimer() {
        this.timerActive = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }

        // If injection is in progress, pause it and mark as timer-triggered
        if (this.gui.injectionInProgress && !this.gui.injectionPaused) {
            this.gui.pauseInjection();
            this.injectionPausedByTimer = true; // Track that timer pause triggered this
        }

        this.updateTimerUI();
        this.gui.logAction('Timer paused', 'info');
    }

    stopTimer() {
        this.timerActive = false;
        this.timerExpired = false;
        
        this.injectionPausedByTimer = false; // Clear timer pause flag
        
        this.usageLimitTimerOriginalValues = null; // Clear stored timer values

        this.timerHours = 0;
        this.timerMinutes = 0;
        this.timerSeconds = 0;

        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }

        // Save timer preferences
        this.gui.preferences.timerHours = 0;
        this.gui.preferences.timerMinutes = 0;
        this.gui.preferences.timerSeconds = 0;
        this.gui.preferences.timerTargetDateTime = null;
        this.gui.saveAllPreferences();

        // Stop injection if active
        if (this.gui.injectionInProgress) {
            this.gui.stopInjection();
        }

        // Notify injection manager
        this.gui.injectionManager?.onTimerStopped();

        // Disable background service when timer stops (if auto-enabled)
        if (this.gui.backgroundServiceActive && this.gui.preferences.keepScreenAwake) {
            this.gui.disableBackgroundService();
            this.gui.logAction('Background service auto-disabled with timer', 'info');
        }

        this.updateTimerUI();
        this.gui.logAction('Timer stopped and reset', 'info');
    }

    async decrementTimer() {
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
            // Timer expired - handle usage limit vs normal timer
            if (this.usageLimitTimerOriginalValues) {
                // This is a usage limit timer - restart countdown
                this.gui.logAction('Usage limit timer reached 00:00:00 - restarting countdown', 'info');
                
                // Reset to original values and continue
                this.timerHours = this.usageLimitTimerOriginalValues.hours;
                this.timerMinutes = this.usageLimitTimerOriginalValues.minutes;
                this.timerSeconds = this.usageLimitTimerOriginalValues.seconds;
                
                // Update UI and save preferences
                this.updateTimerUI();
                this.saveTimerPreferences();
                return; // Don't trigger normal timer expiration
            }

            // Normal timer expiration
            this.timerExpired = true;
            this.timerActive = false;
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }

            // Clear timer preferences
            this.gui.preferences.timerTargetDateTime = null;
            this.gui.preferences.timerHours = 0;
            this.gui.preferences.timerMinutes = 0;
            this.gui.preferences.timerSeconds = 0;
            this.gui.saveAllPreferences();

            // Notify injection manager
            this.gui.injectionManager?.onTimerExpired();

            // Clear usage limit timer state if set
            try {
                await this.gui.ipcRenderer?.invoke('db-save-setting', 'usageLimitTimerOriginalValues', null);
                
                // Also clear the tracking state
                await this.gui.ipcRenderer?.invoke('db-set-app-state', 'usageLimitTimerLastResetTime', null);
                await this.gui.ipcRenderer?.invoke('db-set-app-state', 'usageLimitTimerLastResetTimestamp', null);
                
                this.usageLimitTimerOriginalValues = null;
                
                this.gui.logAction('Usage limit timer state cleared on normal timer expiration', 'info');
            } catch (error) {
                if (this.gui.ipcRenderer) {
                    console.error('Error clearing usage limit timer state:', error);
                }
            }

            // Log expiration and update UI
            this.gui.logAction(`Timer expired after ${this.getTimerDisplayString()}`, 'success');
            
            // Update display to show 00:00:00
            this.updateTimerDisplay();
            
            // Show notification
            this.gui.showSystemNotification('Timer Expired', `Injection timer has expired. ${this.gui.messageQueue.length} messages queued.`);
            
            this.gui.logAction(`Timer expired - ready to inject ${this.gui.messageQueue.length} messages`, 'success');
        }

        this.updateTimerDisplay();
        this.saveTimerPreferences();
    }

    updateTimerDisplay() {
        const display = document.getElementById('timer-display');
        if (!display) return;

        // Always show current timer values, even if expired
        const hours = String(this.timerHours).padStart(2, '0');
        const minutes = String(this.timerMinutes).padStart(2, '0');
        const seconds = String(this.timerSeconds).padStart(2, '0');
        display.textContent = `${hours}:${minutes}:${seconds}`;
    }

    updateTimerUI() {
        const playPauseBtn = document.getElementById('timer-play-pause-btn');
        const stopBtn = document.getElementById('timer-stop-btn');
        const editBtn = document.getElementById('timer-edit-btn');
        
        const waitingStatus = document.getElementById('timer-waiting-status');
        const display = document.getElementById('timer-display');

        if (!playPauseBtn || !stopBtn || !editBtn || !display) return;

        // Clear all status classes first
        display.className = 'timer-display';
        
        // Update the display
        this.updateTimerDisplay();

        // Handle timer expired state
        if (this.timerExpired) {
            display.classList.add('timer-expired');
            editBtn.disabled = true;
            playPauseBtn.innerHTML = '<i data-lucide="play"></i>';
            playPauseBtn.disabled = true;
            return;
        } else {
            display.className = 'timer-display';
            if (this.timerActive) {
                display.classList.add('timer-active');
            }
            editBtn.disabled = false;
            playPauseBtn.disabled = false;
        }

        // Handle injection in progress state
        if (this.gui.injectionInProgress) {
            if (this.gui.injectionPaused) {
                playPauseBtn.innerHTML = '<i data-lucide="play"></i>';
                playPauseBtn.title = 'Resume injection';
            } else {
                playPauseBtn.innerHTML = '<i data-lucide="pause"></i>';
                playPauseBtn.title = 'Pause injection';
            }
        } else {
            // Normal timer controls
            if (this.timerActive) {
                playPauseBtn.innerHTML = '<i data-lucide="pause"></i>';
                playPauseBtn.title = 'Pause timer';
            } else {
                playPauseBtn.innerHTML = '<i data-lucide="play"></i>';
                playPauseBtn.title = 'Start timer';
            }
        }

        // Stop button logic
        const timerIsSet = this.timerHours > 0 || this.timerMinutes > 0 || this.timerSeconds > 0;
        const timerAtZero = this.timerHours === 0 && this.timerMinutes === 0 && this.timerSeconds === 0;

        if (this.gui.injectionInProgress) {
            // Show cancel injection button
            stopBtn.innerHTML = '<i data-lucide="square"></i>';
            stopBtn.title = 'Stop injection';
            stopBtn.className = 'timer-btn timer-cancel-injection';
        } else if (this.timerActive || timerIsSet) {
            // Show stop button
            stopBtn.innerHTML = '<i data-lucide="square"></i>';
            stopBtn.title = 'Stop timer';
            stopBtn.className = 'timer-btn timer-stop';
        } else if (timerAtZero && this.gui.preferences.timerHours > 0 || 
                   this.gui.preferences.timerMinutes > 0 || 
                   this.gui.preferences.timerSeconds > 0) {
            // Show refresh/reset button
            stopBtn.innerHTML = '<i data-lucide="refresh-cw"></i>';
            stopBtn.title = 'Reset timer to last saved value';
            stopBtn.className = 'timer-btn timer-refresh';
        } else {
            stopBtn.innerHTML = '<i data-lucide="square"></i>';
            stopBtn.title = 'Stop timer';
            stopBtn.className = 'timer-btn timer-stop';
        }

        // Update waiting status display
        if (!this.timerExpired) {
            if (waitingStatus) {
                if (this.gui.usageLimitWaiting) {
                    waitingStatus.textContent = 'Waiting for usage limit reset...';
                    waitingStatus.style.display = 'block';
                } else {
                    waitingStatus.style.display = 'none';
                }
            }
        }
    }

    openTimerEditDropdown(event) {
        event.preventDefault();
        this.closeAllTimerDropdowns();

        // Store original values for cancel functionality
        this.originalTimerValues = {
            hours: this.timerHours,
            minutes: this.timerMinutes,
            seconds: this.timerSeconds
        };

        // Create dropdown
        const dropdown = document.createElement('div');
        dropdown.className = 'timer-edit-dropdown';
        dropdown.innerHTML = `
            <div class="timer-edit-content">
                <div class="timer-edit-header">Set Timer</div>
                <div class="timer-edit-time">
                    <div class="timer-segment timer-edit-hours" data-segment="hours">
                        <label>Hours</label>
                        <input type="text" class="timer-segment-input" data-segment="hours" 
                               value="${String(this.timerHours).padStart(2, '0')}" maxlength="2">
                    </div>
                    <div class="timer-segment-separator">:</div>
                    <div class="timer-segment timer-edit-minutes" data-segment="minutes">
                        <label>Minutes</label>
                        <input type="text" class="timer-segment-input" data-segment="minutes" 
                               value="${String(this.timerMinutes).padStart(2, '0')}" maxlength="2">
                    </div>
                    <div class="timer-segment-separator">:</div>
                    <div class="timer-segment timer-edit-seconds" data-segment="seconds">
                        <label>Seconds</label>
                        <input type="text" class="timer-segment-input" data-segment="seconds" 
                               value="${String(this.timerSeconds).padStart(2, '0')}" maxlength="2">
                    </div>
                </div>
                <div class="timer-edit-actions">
                    <button id="save-timer" class="timer-action-btn timer-save-btn">Save</button>
                    <button id="cancel-timer" class="timer-action-btn timer-cancel-btn">Cancel</button>
                </div>
            </div>
        `;

        // Position dropdown
        const timerDisplay = document.getElementById('timer-display');
        const rect = timerDisplay.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = `${rect.bottom + 5}px`;
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.zIndex = '10000';

        document.body.appendChild(dropdown);
        this.setupTimerSegmentInteractions(dropdown);

        // Add event listeners
        dropdown.querySelector('#save-timer').addEventListener('click', () => {
            this.closeAllTimerDropdowns();
        });

        dropdown.querySelector('#cancel-timer').addEventListener('click', () => {
            // Restore original values
            this.setTimer(this.originalTimerValues.hours, this.originalTimerValues.minutes, this.originalTimerValues.seconds);
            this.closeAllTimerDropdowns();
        });

        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', (event) => {
                if (!event.target.closest('.timer-edit-dropdown') && !event.target.closest('#timer-edit-btn')) {
                    this.closeAllTimerDropdowns();
                }
            }, { once: true });
        }, 100);
    }

    setupTimerSegmentInteractions(dropdown) {
        const segments = dropdown.querySelectorAll('.timer-segment');
        let isAnySegmentDragging = false;

        const autoSave = () => {
            const hoursInput = dropdown.querySelector('.timer-segment-input[data-segment="hours"]');
            const minutesInput = dropdown.querySelector('.timer-segment-input[data-segment="minutes"]');
            const secondsInput = dropdown.querySelector('.timer-segment-input[data-segment="seconds"]');

            const hours = parseInt(hoursInput.value) || 0;
            const minutes = parseInt(minutesInput.value) || 0;
            const seconds = parseInt(secondsInput.value) || 0;

            this.setTimer(hours, minutes, seconds, true); // Silent mode to prevent log spam
        };

        segments.forEach(segment => {
            const input = segment.querySelector('.timer-segment-input');
            const segmentType = segment.dataset.segment;
            
            let startY, startValue, isDragging = false, clickTimeout;

            // Mouse down - start drag or prepare for click
            segment.addEventListener('mousedown', (e) => {
                e.preventDefault();
                startY = e.clientY;
                startValue = parseInt(input.value) || 0;
                isDragging = false;
                
                // Set a timeout to detect if this is a click vs drag
                clickTimeout = setTimeout(() => {
                    // This is a click, not a drag - select the input
                    input.focus();
                    input.select();
                    clickTimeout = null;
                }, 150);
                
                const handleMouseMove = (e) => {
                    if (clickTimeout) {
                        clearTimeout(clickTimeout);
                        clickTimeout = null;
                    }
                    
                    if (!isDragging) {
                        isDragging = true;
                        isAnySegmentDragging = true;
                        segment.classList.add('dragging');
                    }
                    
                    const deltaY = startY - e.clientY;
                    const sensitivity = 5; // pixels per increment
                    const change = Math.floor(deltaY / sensitivity);
                    
                    let newValue = startValue + change;
                    
                    // Apply limits based on segment type
                    if (segmentType === 'hours') {
                        newValue = Math.max(0, Math.min(23, newValue));
                    } else {
                        newValue = Math.max(0, Math.min(59, newValue));
                    }
                    
                    input.value = String(newValue).padStart(2, '0');
                    autoSave(); // Auto-save on drag change
                };
                
                const handleMouseUp = () => {
                    if (clickTimeout) {
                        clearTimeout(clickTimeout);
                        clickTimeout = null;
                        // This was a quick click, focus the input
                        input.focus();
                        input.select();
                    }
                    
                    segment.classList.remove('dragging');
                    isDragging = false;
                    
                    // Reset dragging state with a small delay to prevent dropdown closing
                    setTimeout(() => {
                        isAnySegmentDragging = false;
                    }, 100);
                    
                    document.removeEventListener('mousemove', handleMouseMove);
                    document.removeEventListener('mouseup', handleMouseUp);
                };
                
                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
            });
            
            // Handle direct input
            input.addEventListener('input', (e) => {
                let value = e.target.value.replace(/[^0-9]/g, '');
                if (value.length > 2) value = value.slice(0, 2);
                
                let numValue = parseInt(value) || 0;
                if (segmentType === 'hours') {
                    numValue = Math.min(23, numValue);
                } else {
                    numValue = Math.min(59, numValue);
                }
                
                e.target.value = value;
            });
            
            // Format on blur and auto-save
            input.addEventListener('blur', (e) => {
                const value = parseInt(e.target.value) || 0;
                e.target.value = String(value).padStart(2, '0');
                autoSave(); // Auto-save on blur
            });
            
            // Handle keyboard shortcuts
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    autoSave(); // Auto-save on enter
                    dropdown.querySelector('#save-timer').click();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    dropdown.querySelector('#cancel-timer').click();
                }
            });
        });
    }

    closeAllTimerDropdowns() {
        const dropdowns = document.querySelectorAll('.timer-edit-dropdown');
        dropdowns.forEach(dropdown => dropdown.remove());
    }

    setTimer(hours, minutes, seconds, silent = false) {
        // Validate and set timer values
        this.timerHours = Math.max(0, Math.min(23, hours));
        this.timerMinutes = Math.max(0, Math.min(59, minutes));
        this.timerSeconds = Math.max(0, Math.min(59, seconds));
        this.timerExpired = false;

        // Calculate target datetime
        const totalSeconds = (this.timerHours * 3600) + (this.timerMinutes * 60) + this.timerSeconds;
        const targetDateTime = new Date(Date.now() + totalSeconds * 1000);

        // Save to preferences
        this.saveTimerPreferences(targetDateTime);

        // Notify injection manager that timer has been reset/updated
        this.gui.injectionManager?.onTimerStopped();

        this.updateTimerUI();

        if (!silent) {
            this.gui.logAction(`Timer set to ${this.getTimerDisplayString()} (expires at ${targetDateTime.toLocaleString()})`, 'info');
        }

        // Handle auto-sync disable when user manually changes timer
        if (!silent && this.autoSyncEnabled && this.gui.usageLimitSyncInterval) {
            this.autoSyncEnabled = false;
            clearInterval(this.gui.usageLimitSyncInterval);
            this.gui.usageLimitSyncInterval = null;
            this.gui.logAction('Auto-sync disabled - user manually changed timer', 'info');
        }

        return true;
    }

    saveTimerPreferences(targetDateTime = null) {
        if (!targetDateTime) {
            const totalSeconds = (this.timerHours * 3600) + (this.timerMinutes * 60) + this.timerSeconds;
            targetDateTime = new Date(Date.now() + totalSeconds * 1000);
        }

        this.gui.preferences.timerHours = this.timerHours;
        this.gui.preferences.timerMinutes = this.timerMinutes;
        this.gui.preferences.timerSeconds = this.timerSeconds;
        this.gui.preferences.timerTargetDateTime = targetDateTime.toISOString();
        this.gui.saveAllPreferences();
    }

    resetTimer() {
        // Check if saved target datetime is still valid
        const savedTargetDateTime = this.gui.preferences.timerTargetDateTime;
        
        if (savedTargetDateTime) {
            try {
                const targetDate = new Date(savedTargetDateTime);
                const now = new Date();
                
                if (targetDate <= now) {
                    // Target time has passed, don't restore timer and mark as expired
                    this.gui.logAction(`Timer target time (${targetDate.toLocaleString()}) has already passed - not restoring timer`, 'info');
                    
                    // Clear the saved target time and reset preferences
                    this.gui.preferences.timerTargetDateTime = null;
                    this.gui.preferences.timerHours = 0;
                    this.gui.preferences.timerMinutes = 0;
                    this.gui.preferences.timerSeconds = 0;
                    this.gui.saveAllPreferences();
                    
                    // Set timer to expired state
                    this.timerActive = false;
                    this.timerExpired = true; // Mark as expired since target time passed
                    
                    this.timerHours = 0;
                    this.timerMinutes = 0;
                    this.timerSeconds = 0;
                    
                    if (this.timerInterval) {
                        clearInterval(this.timerInterval);
                        this.timerInterval = null;
                    }
                    
                    // Trigger injection manager for expired timer
                    this.gui.injectionManager?.onTimerExpired();
                    
                    this.updateTimerUI();
                    return;
                }
            } catch (error) {
                console.error('Error parsing saved target datetime:', error);
            }
        }
        
        // Reset to saved values
        const savedHours = this.gui.preferences.timerHours || 0;
        const savedMinutes = this.gui.preferences.timerMinutes || 0;
        const savedSeconds = this.gui.preferences.timerSeconds || 0;

        this.timerActive = false;
        this.timerExpired = false;
        
        this.timerHours = savedHours;
        this.timerMinutes = savedMinutes;
        this.timerSeconds = savedSeconds;

        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }

        this.updateTimerUI();
        this.gui.logAction(`Timer reset to saved value: ${this.getTimerDisplayString()}`, 'info');
    }

    async setTimerToUsageLimitReset(resetHour, ampm, exactResetTime = null) {
        try {
            // Create a standardized reset time string for comparison
            const resetTimeString = `${resetHour}${ampm}`;
            const lastTimerResetTime = await this.gui.ipcRenderer?.invoke('db-get-app-state', 'usageLimitTimerLastResetTime');
            const lastTimerResetTimestamp = await this.gui.ipcRenderer?.invoke('db-get-app-state', 'usageLimitTimerLastResetTimestamp');
            
            const now = new Date();
            
            if (lastTimerResetTime === resetTimeString && lastTimerResetTimestamp && now.getTime() < lastTimerResetTimestamp) {
                this.gui.logAction(`Ignoring duplicate usage limit timer for ${resetTimeString} - timer already set for this reset time`, 'info');
                return false;
            }

            let resetTime;
            if (exactResetTime) {
                resetTime = new Date(exactResetTime);
            } else {
                resetTime = new Date();
                let hour24 = resetHour;
                if (ampm === 'pm' && resetHour !== 12) {
                    hour24 += 12;
                } else if (ampm === 'am' && resetHour === 12) {
                    hour24 = 0;
                }
                
                resetTime.setHours(hour24, 0, 0, 0);
                
                if (resetTime <= now) {
                    resetTime.setDate(resetTime.getDate() + 1);
                }
            }

            const diffMs = resetTime.getTime() - now.getTime();
            const hours = Math.floor(diffMs / (1000 * 60 * 60));
            const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

            if (hours <= 0 && minutes <= 1) {
                this.gui.logAction(`Usage limit timer would be ${hours}h ${minutes}m - ignoring as it likely refers to previous usage limit that has been lifted`, 'info');
                return false;
            }

            // Check if usage limit timer is longer than 5 hours - don't auto-set timer
            if (hours > 5) {
                this.gui.logAction(`Usage limit timer would be ${hours}h ${minutes}m - ignoring as it exceeds 5-hour threshold`, 'info');
                return false;
            }

            // Store current timer values if not already stored
            if (!this.usageLimitTimerOriginalValues) {
                this.usageLimitTimerOriginalValues = {
                    hours: this.timerHours,
                    minutes: this.timerMinutes,
                    seconds: this.timerSeconds
                };
            }

            // Stop current timer if running
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
                this.timerActive = false;
            }

            // Set new timer values
            this.timerHours = hours;
            this.timerMinutes = minutes;
            this.timerSeconds = seconds;
            this.timerExpired = false;

            // Start the timer
            this.startTimer();

            // Save tracking state
            await this.gui.ipcRenderer?.invoke('db-set-app-state', 'usageLimitTimerLastResetTime', resetTimeString);
            await this.gui.ipcRenderer?.invoke('db-set-app-state', 'usageLimitTimerLastResetTimestamp', resetTime.getTime());

            this.gui.logAction(`Usage limit detected - timer set to reset at ${resetHour}${ampm} (${hours}h ${minutes}m ${seconds}s)`, 'warning');
        } catch (error) {
            console.error('Error checking/setting usage limit timer state:', error);
            // Fallback: proceed with timer update but log the error
            this.gui.logAction(`Error tracking timer state, proceeding with timer update for ${resetHour}${ampm}`, 'error');
        }
    }

    getTimerDisplayString() {
        const hours = String(this.timerHours).padStart(2, '0');
        const minutes = String(this.timerMinutes).padStart(2, '0');
        const seconds = String(this.timerSeconds).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    }

    // Restore timer from preferences
    loadTimerFromPreferences() {
        if (this.gui.preferences.timerTargetDateTime) {
            const targetDate = new Date(this.gui.preferences.timerTargetDateTime);
            const now = new Date();
            
            if (targetDate <= now) {
                // Timer has expired
                this.gui.logAction(`Timer target time (${targetDate.toLocaleString()}) has already passed on startup`, 'info');
                this.timerHours = 0;
                this.timerMinutes = 0;
                this.timerSeconds = 0;
                this.timerExpired = true;
                
                // Clear expired timer from preferences
                this.gui.preferences.timerTargetDateTime = null;
                this.gui.preferences.timerHours = 0;
                this.gui.preferences.timerMinutes = 0;
                this.gui.preferences.timerSeconds = 0;
                this.gui.saveAllPreferences();
            } else {
                // Timer is still valid, restore countdown
                this.timerHours = this.gui.preferences.timerHours || 0;
                this.timerMinutes = this.gui.preferences.timerMinutes || 0;
                this.timerSeconds = this.gui.preferences.timerSeconds || 0;
                this.timerExpired = false;
            }
        } else {
            // No target time set, just restore values
            this.timerHours = this.gui.preferences.timerHours || 0;
            this.timerMinutes = this.gui.preferences.timerMinutes || 0;
            this.timerSeconds = this.gui.preferences.timerSeconds || 0;
            this.timerExpired = false;
        }
    }
}

module.exports = TimerController;