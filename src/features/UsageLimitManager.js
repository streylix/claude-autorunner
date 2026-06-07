/**
 * UsageLimitManager - Handles all usage limit detection, modal management, and timer synchronization
 * Consolidates 44 functions from renderer.js into a focused module
 */
const { BoundedSet } = require('../utils/bounded-collections');

class UsageLimitManager {
    constructor(eventBus, appStateStore) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        
        // Consolidated state management
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
        
        this.setupEventListeners();
    }
    
    // Initialize with external managers
    setManagers(injectionManager, timerManager) {
        this.injectionManager = injectionManager;
        this.timerManager = timerManager;
    }
    
    setupEventListeners() {
        // Listen for terminal data to detect usage limits
        this.eventBus.on('terminal:data', async (data) => {
            // Canonical terminal:data payload is { terminalId, data }
            if (data.data && data.terminalId) {
                await this.detectUsageLimit(data.data, data.terminalId);
            }
        });
        
        // Listen for timer expiry
        this.eventBus.on('timer:expired', () => {
            if (this.state.waiting) {
                this.handleUsageLimitTimerExpiry();
            }
        });
        
        // Listen for manual timer changes
        this.eventBus.on('timer:manual-change', () => {
            this.stopSync();
        });
    }
    
    // ======= DETECTION SYSTEM =======
    async detectUsageLimit(data, terminalId) {
        // Check for usage limit message
        const match = data.match(/Claude usage limit reached\. Your limit will reset at (\d{1,2})(am|pm)/i);
        if (!match) return;
        
        const [, resetHour, ampm] = match;
        const resetTimeString = `${resetHour}${ampm}`;
        
        // Check if we've already processed this
        if (await this.isDuplicateDetection(resetTimeString)) {
            return;
        }
        
        // Check if we're in cooldown period
        if (this.isInCooldownPeriod()) {
            return;
        }
        
        // Track this terminal
        this.state.terminals.add(terminalId);
        
        // Process the usage limit detection
        await this.checkAndShowModal(resetTimeString, resetHour, ampm);
    }
    
    async isDuplicateDetection(resetTimeString) {
        // Create unique identifier for this message
        const sessionId = await ipcRenderer.invoke('db-get-setting', 'sessionId') || 'default';
        const fullMessage = `${sessionId}_${resetTimeString}_${Date.now()}`;
        
        // Check if we've seen this exact message recently
        if (this.state.processedMessages.has(fullMessage)) {
            return true;
        }
        
        // Check database for recent detection
        const lastResetTime = await ipcRenderer.invoke('db-get-app-state', 'usageLimitModalLastResetTime');
        const lastTimestamp = await ipcRenderer.invoke('db-get-app-state', 'usageLimitModalLastResetTimestamp');
        
        if (lastResetTime === resetTimeString && lastTimestamp) {
            const timeSinceLastModal = Date.now() - lastTimestamp;
            if (timeSinceLastModal < 600000) { // 10 minutes
                return true;
            }
        }
        
        // Add to processed messages
        this.state.processedMessages.add(fullMessage);
        return false;
    }
    
    isInCooldownPeriod() {
        if (!this.state.cooldownUntil) return false;
        return Date.now() < this.state.cooldownUntil;
    }
    
    async checkAndShowModal(resetTimeString, resetHour, ampm) {
        try {
            // Set 2-minute cooldown
            this.state.cooldownUntil = Date.now() + 120000;
            
            // Check if modal is already showing
            if (this.state.modalShowing) {
                this.eventBus.emit('log:action', {
                    message: 'Usage limit modal already showing, skipping duplicate',
                    type: 'info'
                });
                return;
            }
            
            // Store pending reset info
            this.state.pendingReset = { resetHour, ampm, resetTimeString };
            
            // Save first detection time if not set
            const firstDetected = await ipcRenderer.invoke('db-get-setting', 'usageLimitFirstDetected');
            if (!firstDetected) {
                await ipcRenderer.invoke('db-save-setting', 'usageLimitFirstDetected', new Date().toISOString());
            }
            
            // Show the modal
            await this.showModal(resetHour, ampm);
            
            // Save to database
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitModalLastResetTime', resetTimeString);
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitModalLastResetTimestamp', Date.now());
            
        } catch (error) {
            console.error('Error in checkAndShowModal:', error);
            this.eventBus.emit('log:action', {
                message: `Error showing usage limit modal: ${error.message}`,
                type: 'error'
            });
        }
    }
    
    // ======= MODAL SYSTEM =======
    async showModal(resetHour, ampm, exactResetTime = null) {
        this.eventBus.emit('log:action', {
            message: `Showing usage limit modal for ${resetHour}${ampm}`,
            type: 'info'
        });
        
        // Set modal showing flag
        this.state.modalShowing = true;
        
        // Pause injection
        if (this.injectionManager) {
            this.injectionManager.pauseInjection('usage-limit');
        }
        
        // Calculate reset time
        const resetTime = exactResetTime || this.calculateResetTime(resetHour, ampm);
        
        // Set the reset time for syncing
        await this.setResetTime(resetTime);
        
        // Display the modal
        this.displayModal(resetTime);
    }
    
    calculateResetTime(resetHour, ampm) {
        if (!resetHour || !ampm) return null;
        
        const now = new Date();
        let hour = parseInt(resetHour);
        
        // Convert to 24-hour format
        if (ampm.toLowerCase() === 'pm' && hour !== 12) {
            hour += 12;
        } else if (ampm.toLowerCase() === 'am' && hour === 12) {
            hour = 0;
        }
        
        // Create reset time for today
        const resetTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0);
        
        // If reset time has passed today, set for tomorrow
        if (resetTime <= now) {
            resetTime.setDate(resetTime.getDate() + 1);
        }
        
        return resetTime;
    }
    
    displayModal(resetTime) {
        const modal = document.getElementById('usage-limit-modal');
        if (!modal) return;
        
        modal.classList.add('active');
        
        // Setup countdown
        const resetTimeSpan = modal.querySelector('.reset-time');
        const progressBar = modal.querySelector('.usage-limit-progress-bar');
        const countdownText = modal.querySelector('.countdown-text');
        
        // Update countdown every second
        const countdownInterval = setInterval(() => {
            const now = new Date();
            const diff = resetTime - now;
            
            if (diff <= 0) {
                clearInterval(countdownInterval);
                this.handleUsageLimitChoice(true);
                return;
            }
            
            const hours = Math.floor(diff / 3600000);
            const minutes = Math.floor((diff % 3600000) / 60000);
            const seconds = Math.floor((diff % 60000) / 1000);
            
            if (resetTimeSpan) {
                resetTimeSpan.textContent = `${hours}h ${minutes}m`;
            }
            
            if (countdownText) {
                countdownText.textContent = `${seconds}`;
            }
            
            // Update progress bar
            const totalTime = 30;
            const elapsed = 30 - seconds;
            const progress = (elapsed / totalTime) * 100;
            
            if (progressBar) {
                progressBar.style.width = `${progress}%`;
            }
        }, 1000);
        
        // Setup button handlers
        const yesBtn = modal.querySelector('.usage-limit-yes');
        const noBtn = modal.querySelector('.usage-limit-no');
        
        if (yesBtn) {
            yesBtn.onclick = () => this.handleUsageLimitChoice(true);
        }
        
        if (noBtn) {
            noBtn.onclick = () => this.handleUsageLimitChoice(false);
        }
        
        // Store interval for cleanup
        modal.dataset.countdownInterval = countdownInterval;
    }
    
    async handleUsageLimitChoice(queue) {
        this.eventBus.emit('log:action', {
            message: `User chose to ${queue ? 'queue' : 'not queue'} messages`,
            type: 'info'
        });
        
        const modal = document.getElementById('usage-limit-modal');
        if (!modal) return;
        
        // Clear countdown interval
        const interval = modal.dataset.countdownInterval;
        if (interval) {
            clearInterval(interval);
        }
        
        // Hide modal
        modal.classList.remove('active');
        this.state.modalShowing = false;
        
        if (queue) {
            // User wants to queue messages
            this.state.waiting = true;
            
            // Store original timer values if timer is running
            if (this.timerManager && this.timerManager.isRunning()) {
                this.state.timerOriginalValues = {
                    targetDateTime: this.timerManager.getTargetDateTime(),
                    duration: this.timerManager.getDuration()
                };
            }
            
            // Set timer to usage limit reset time
            if (this.state.resetTime) {
                const diff = this.state.resetTime - new Date();
                if (diff > 0) {
                    this.timerManager.start(Math.floor(diff / 1000));
                    this.startSync();
                }
            }
            
            // Update injection state
            if (this.injectionManager) {
                this.injectionManager.setUsageLimitWaiting(true);
            }
            
            // Save state
            await this.appStateStore.set('usageLimitWaiting', true);
            
        } else {
            // User doesn't want to queue
            this.state.waiting = false;
            
            // Resume injection
            if (this.injectionManager) {
                this.injectionManager.resumeInjection('usage-limit');
            }
            
            // Clear tracking
            await this.clearTracking();
        }
        
        // Clear pending reset
        this.state.pendingReset = null;
    }
    
    // ======= TIMER SYNC SYSTEM =======
    startSync() {
        if (!this.state.resetTime || !this.state.autoSyncEnabled) {
            return;
        }
        
        this.stopSync();
        
        // Start interval to update every minute
        this.state.syncInterval = setInterval(() => {
            this.updateSyncedTimer();
        }, 60000);
        
        // Update immediately
        this.updateSyncedTimer();
        
        this.eventBus.emit('log:action', {
            message: 'Auto-sync to usage limit enabled',
            type: 'info'
        });
    }
    
    stopSync() {
        if (this.state.syncInterval) {
            clearInterval(this.state.syncInterval);
            this.state.syncInterval = null;
        }
        
        this.state.autoSyncEnabled = false;
    }
    
    async updateSyncedTimer() {
        if (!this.state.resetTime || !this.state.autoSyncEnabled) {
            return;
        }
        
        const now = new Date();
        const diff = this.state.resetTime - now;
        
        // If reset time has passed, clear everything
        if (diff <= 0) {
            this.stopSync();
            await this.handleUsageLimitTimerExpiry();
            return;
        }
        
        // Update timer to match remaining time
        if (this.timerManager && this.state.waiting) {
            const seconds = Math.floor(diff / 1000);
            
            // Only update if timer isn't already at correct value
            const currentTarget = this.timerManager.getTargetDateTime();
            const targetDiff = Math.abs(currentTarget - this.state.resetTime);
            
            if (targetDiff > 60000) { // More than 1 minute difference
                this.timerManager.start(seconds);
                this.eventBus.emit('log:action', {
                    message: `Synced timer to usage limit: ${Math.floor(seconds / 60)} minutes remaining`,
                    type: 'info'
                });
            }
        }
    }
    
    async setResetTime(resetTime) {
        try {
            this.state.resetTime = resetTime;
            
            // Save to database
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitResetTime', resetTime.toISOString());
            
            // Start syncing if auto-sync is enabled
            if (this.state.autoSyncEnabled && this.state.waiting) {
                this.startSync();
            }
        } catch (error) {
            console.error('Failed to save usage limit reset time:', error);
        }
    }
    
    async loadResetTime() {
        try {
            const savedTime = await ipcRenderer.invoke('db-get-app-state', 'usageLimitResetTime');
            if (savedTime) {
                const resetTime = new Date(savedTime);
                
                // Check if reset time is still in the future
                if (resetTime > new Date()) {
                    this.state.resetTime = resetTime;
                    
                    // Start sync if waiting
                    if (this.state.waiting && this.state.autoSyncEnabled) {
                        this.startSync();
                    }
                } else {
                    // Reset time has passed, clear it
                    await ipcRenderer.invoke('db-set-app-state', 'usageLimitResetTime', '');
                }
            }
        } catch (error) {
            console.error('Failed to load usage limit reset time:', error);
        }
    }
    
    // ======= STATE MANAGEMENT =======
    async handleUsageLimitTimerExpiry() {
        this.eventBus.emit('log:action', {
            message: 'Usage limit timer expired - resuming normal operation',
            type: 'info'
        });
        
        // Clear waiting state
        this.state.waiting = false;
        await this.appStateStore.set('usageLimitWaiting', false);
        
        // Resume injection
        if (this.injectionManager) {
            this.injectionManager.resumeInjection('usage-limit-expired');
            this.injectionManager.setUsageLimitWaiting(false);
        }
        
        // Restore original timer if saved
        if (this.state.timerOriginalValues && this.timerManager) {
            const { targetDateTime, duration } = this.state.timerOriginalValues;
            if (targetDateTime) {
                const remaining = targetDateTime - new Date();
                if (remaining > 0) {
                    this.timerManager.start(Math.floor(remaining / 1000));
                }
            }
            this.state.timerOriginalValues = null;
        }
        
        // Clear tracking
        await this.clearTracking();
        
        // Emit event
        this.eventBus.emit('usageLimit:reset');
    }
    
    async clearTracking() {
        try {
            // Clear database tracking
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitModalLastResetTime', null);
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitModalLastResetTimestamp', null);
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitResetTime', '');
            await ipcRenderer.invoke('db-save-setting', 'lastUsageLimitMessage', null);
            
            // Clear local state
            this.state.terminals.clear();
            this.state.processedMessages.clear();
            this.state.cooldownUntil = null;
            this.state.pendingReset = null;
            
            // Stop sync
            this.stopSync();
            
        } catch (error) {
            console.error('Error clearing usage limit tracking:', error);
        }
    }
    
    async getStatus() {
        const firstDetected = await ipcRenderer.invoke('db-get-setting', 'usageLimitFirstDetected');
        
        if (!firstDetected) {
            return {
                message: 'No usage limit auto-disable timer active',
                firstDetected: null
            };
        }
        
        const detectedTime = new Date(firstDetected);
        const now = new Date();
        const hoursSince = (now - detectedTime) / 3600000;
        const hoursRemaining = Math.max(0, 24 - hoursSince);
        
        return {
            message: `Usage limit auto-disable timer: ${hoursRemaining.toFixed(1)} hours remaining`,
            firstDetected: detectedTime.toLocaleString()
        };
    }
    
    async resetTimer() {
        await ipcRenderer.invoke('db-save-setting', 'usageLimitFirstDetected', null);
        this.eventBus.emit('log:action', {
            message: 'Usage limit auto-disable timer has been reset',
            type: 'info'
        });
        return true;
    }
    
    // ======= PUBLIC API =======
    isWaiting() {
        return this.state.waiting;
    }
    
    isModalShowing() {
        return this.state.modalShowing;
    }
    
    getResetTime() {
        return this.state.resetTime;
    }
    
    getTerminals() {
        return Array.from(this.state.terminals);
    }
    
    async initialize() {
        // Load saved state
        const savedWaiting = await this.appStateStore.get('usageLimitWaiting');
        if (savedWaiting) {
            this.state.waiting = true;
        }
        
        // Load reset time
        await this.loadResetTime();
    }
    
    // Debug mode support
    async showDebugModal(resetTimeString, exactResetTime) {
        this.eventBus.emit('log:action', {
            message: `DEBUG: Showing usage limit modal for ${resetTimeString}`,
            type: 'info'
        });
        await this.showModal(null, null, exactResetTime);
    }
}

module.exports = UsageLimitManager;