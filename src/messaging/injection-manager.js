/**
 * InjectionManager - Centralized management for message injection system
 * Handles timer states, terminal states, and injection scheduling
 */
class InjectionManager {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        
        // Injection states
        this.activeInjections = new Map(); // messageId -> terminalId
        this.busyTerminals = new Set(); // terminalIds currently injecting
        this.terminalStabilityTimers = new Map(); // terminalId -> timestamp
        
        // Timer states
        this.timerExpired = false;
        this.injectionSchedulingInProgress = false;
        this.usageLimitWaiting = false;
        
        // Visual state tracking
        this.lastVisualState = null;
        
        // Injection scheduling
        this.schedulingTimer = null;
        this.injectionCheckInterval = 100; // Check every 100ms for ready terminals
        
        // Plan mode delay tracking
        this.lastPlanModeCompletionTime = null;
        this.planModeDelay = 30000; // 30 seconds delay after plan mode
    }
    
    /**
     * Initialize the injection manager
     */
    initialize() {
        // Sync with GUI's restored state
        this.syncWithGUIState();
        // Set up periodic checks for injection opportunities
        this.startPeriodicChecks();
    }
    
    /**
     * Sync internal state with GUI's restored state
     */
    syncWithGUIState() {
        if (this.gui.usageLimitWaiting) {
            this.usageLimitWaiting = true;
            this.gui.logAction('InjectionManager: Synced usageLimitWaiting state from restored preferences', 'info');
        }
        if (this.gui.timerExpired) {
            this.timerExpired = true;
        }
    }
    
    /**
     * Clean up resources
     */
    destroy() {
        this.stopPeriodicChecks();
        this.activeInjections.clear();
        this.busyTerminals.clear();
        this.terminalStabilityTimers.clear();
    }
    
    /**
     * Start periodic checks for injection opportunities
     */
    startPeriodicChecks() {
        this.stopPeriodicChecks();
        
        this.schedulingTimer = setInterval(() => {
            if (this.timerExpired && !this.injectionSchedulingInProgress) {
                this.checkAndScheduleInjections();
            }
        }, this.injectionCheckInterval);
    }
    
    /**
     * Stop periodic checks
     */
    stopPeriodicChecks() {
        if (this.schedulingTimer) {
            clearInterval(this.schedulingTimer);
            this.schedulingTimer = null;
        }
    }
    
    /**
     * Called when timer expires
     */
    onTimerExpired() {
        this.timerExpired = true;
        this.checkAndScheduleInjections();
    }
    
    /**
     * Called when timer is stopped or reset
     */
    onTimerStopped() {
        this.timerExpired = false;
        this.lastPlanModeCompletionTime = null; // Clear plan mode delay when timer is stopped
        this.cancelAllInjections();
        this.updateVisualState();
    }
    
    /**
     * Called when usage limit is detected
     */
    onUsageLimitDetected() {
        this.usageLimitWaiting = true;
        this.updateVisualState();
    }
    
    /**
     * Called when usage limit waiting period ends
     */
    onUsageLimitReset() {
        this.usageLimitWaiting = false;
        if (this.timerExpired) {
            this.checkAndScheduleInjections();
        }
    }
    
    /**
     * Check and schedule injections for available terminals
     */
    async checkAndScheduleInjections() {
        // Prevent concurrent scheduling
        if (this.injectionSchedulingInProgress) {
            return;
        }
        
        // Don't schedule if injection is paused
        if (this.gui.injectionPaused) {
            this.updateVisualState();
            return;
        }
        
        // Don't schedule if waiting for usage limit
        if (this.usageLimitWaiting) {
            this.updateVisualState();
            return;
        }
        
        // Don't schedule if timer not expired
        if (!this.timerExpired) {
            return;
        }
        
        // Check for plan mode delay (30 seconds after last plan mode injection)
        if (this.lastPlanModeCompletionTime) {
            const timeSinceLastPlanMode = Date.now() - this.lastPlanModeCompletionTime;
            if (timeSinceLastPlanMode < this.planModeDelay) {
                const remainingDelay = this.planModeDelay - timeSinceLastPlanMode;
                this.gui.logAction(`Waiting ${Math.ceil(remainingDelay / 1000)} more seconds before next injection (plan mode delay)`, 'info');
                this.updateVisualState();
                return;
            }
        }
        
        this.injectionSchedulingInProgress = true;
        
        try {
            // Get available messages
            const messageQueue = this.gui.messageQueue || [];
            if (messageQueue.length === 0) {
                this.updateVisualState();
                return;
            }
            
            // Get available terminals
            const availableTerminals = this.getAvailableTerminals();
            
            if (availableTerminals.length === 0) {
                // All terminals busy - show waiting state
                this.updateVisualState();
                return;
            }
            
            // Group messages by terminal
            const messagesByTerminal = this.groupMessagesByTerminal(messageQueue);
            
            // Schedule injections for available terminals
            for (const terminalId of availableTerminals) {
                const messages = messagesByTerminal.get(terminalId) || messagesByTerminal.get(null);
                
                if (messages && messages.length > 0) {
                    const message = messages[0]; // Get earliest message
                    await this.scheduleInjection(message, terminalId);
                }
            }
            
            this.updateVisualState();
            
        } finally {
            this.injectionSchedulingInProgress = false;
        }
    }
    
    /**
     * Get list of available terminals ready for injection
     */
    getAvailableTerminals() {
        const available = [];
        
        for (const [terminalId, terminalData] of this.gui.terminals) {
            // Skip if terminal is busy
            if (this.busyTerminals.has(terminalId)) {
                continue;
            }
            
            // Check if terminal is stable and ready
            if (this.isTerminalStableAndReady(terminalId)) {
                available.push(terminalId);
            }
        }
        
        return available;
    }
    
    /**
     * Check if a terminal is stable and ready for injection
     */
    isTerminalStableAndReady(terminalId) {
        const terminalData = this.gui.terminals.get(terminalId);
        if (!terminalData) return false;
        
        // Check terminal status
        const terminalStatus = this.gui.terminalStatuses.get(terminalId);
        if (!terminalStatus) return false;
        
        // Terminal must not be running or prompting
        if (terminalStatus.isRunning || terminalStatus.isPrompting) {
            // Reset stability timer
            this.terminalStabilityTimers.delete(terminalId);
            return false;
        }
        
        // Check stability duration (5 seconds)
        const now = Date.now();
        const stableStartTime = this.terminalStabilityTimers.get(terminalId);
        
        if (!stableStartTime) {
            // Just became ready - start timing
            this.terminalStabilityTimers.set(terminalId, now);
            return false;
        }
        
        const stableDuration = now - stableStartTime;
        const requiredStableDuration = 5000; // 5 seconds
        
        return stableDuration >= requiredStableDuration;
    }
    
    /**
     * Group messages by their target terminal
     */
    groupMessagesByTerminal(messages) {
        const grouped = new Map();
        
        for (const message of messages) {
            const terminalId = message.terminalId || null;
            
            if (!grouped.has(terminalId)) {
                grouped.set(terminalId, []);
            }
            
            grouped.get(terminalId).push(message);
        }
        
        // Sort messages within each group by executeAt time and sequence
        for (const messages of grouped.values()) {
            messages.sort((a, b) => {
                if (a.executeAt !== b.executeAt) {
                    return a.executeAt - b.executeAt;
                }
                return (a.sequence || 0) - (b.sequence || 0);
            });
        }
        
        return grouped;
    }
    
    /**
     * Schedule injection for a specific message
     */
    async scheduleInjection(message, terminalId) {
        // Mark terminal as busy
        this.busyTerminals.add(terminalId);
        this.activeInjections.set(message.id, terminalId);
        
        // Clear stability timer
        this.terminalStabilityTimers.delete(terminalId);
        
        // Update visual state
        this.updateVisualState();
        
        // Delegate actual injection to GUI
        // The GUI will call onInjectionComplete when done
        this.gui.processMessage(message);
    }
    
    /**
     * Called when an injection completes
     */
    onInjectionComplete(messageId, wasPlanMode = false) {
        const terminalId = this.activeInjections.get(messageId);
        
        if (terminalId) {
            this.activeInjections.delete(messageId);
            this.busyTerminals.delete(terminalId);
        }
        
        // Track plan mode completion time for 30-second delay
        if (wasPlanMode) {
            this.lastPlanModeCompletionTime = Date.now();
            this.gui.logAction('Plan mode injection completed - starting 30-second delay before next injection', 'info');
        }
        
        // Check for more injections
        if (this.timerExpired) {
            setTimeout(() => {
                this.checkAndScheduleInjections();
            }, 100);
        }
        
        this.updateVisualState();
    }
    
    /**
     * Cancel all active injections
     */
    cancelAllInjections() {
        this.activeInjections.clear();
        this.busyTerminals.clear();
        this.terminalStabilityTimers.clear();
    }
    
    /**
     * Check if plan mode delay is currently active
     */
    isPlanModeDelayActive() {
        if (!this.lastPlanModeCompletionTime) return false;
        const timeSinceLastPlanMode = Date.now() - this.lastPlanModeCompletionTime;
        return timeSinceLastPlanMode < this.planModeDelay;
    }
    
    /**
     * Get remaining plan mode delay in seconds
     */
    getRemainingPlanModeDelay() {
        if (!this.isPlanModeDelayActive()) return 0;
        const timeSinceLastPlanMode = Date.now() - this.lastPlanModeCompletionTime;
        const remainingMs = this.planModeDelay - timeSinceLastPlanMode;
        return Math.ceil(remainingMs / 1000);
    }
    
    /**
     * Update visual state of timer based on current injection state
     */
    updateVisualState() {
        let newState = 'idle';
        
        if (!this.timerExpired) {
            // Timer is running or stopped
            newState = 'countdown';
        } else if (this.gui.injectionPaused) {
            // Injection is paused
            newState = 'paused';
        } else if (this.usageLimitWaiting) {
            // Waiting for usage limit reset
            newState = 'usage-limit-waiting';
        } else if (this.isPlanModeDelayActive()) {
            // Waiting for plan mode delay to complete
            newState = 'plan-mode-waiting';
        } else if (this.activeInjections.size > 0) {
            // Actively injecting
            newState = 'injecting';
        } else if (this.gui.messageQueue.length > 0 && this.getAvailableTerminals().length === 0) {
            // Have messages but all terminals are busy
            newState = 'waiting-for-terminals';
        } else {
            // Timer expired, no active injections
            newState = 'idle-expired';
        }
        
        // Only update if state changed
        if (newState !== this.lastVisualState) {
            this.lastVisualState = newState;
            this.applyVisualState(newState);
        }
    }
    
    /**
     * Apply visual state to UI elements
     */
    applyVisualState(state) {
        const display = document.getElementById('timer-display');
        const waitingStatus = document.getElementById('timer-waiting-status');
        const injectionStatus = document.getElementById('injection-status');
        const editBtn = document.getElementById('timer-edit-btn');
        
        if (!display) return;
        
        // Reset classes
        display.className = 'timer-display';
        
        switch (state) {
            case 'countdown':
                // Timer counting down - green, show "Waiting..."
                display.classList.add('active');
                if (waitingStatus) {
                    waitingStatus.style.display = 'inline';
                    waitingStatus.textContent = 'Waiting...';
                }
                if (injectionStatus) injectionStatus.style.display = 'none';
                if (editBtn) editBtn.style.display = 'none';
                break;
                
            case 'injecting':
                // Actively injecting - red, show "Injecting..."
                display.classList.add('expired');
                if (waitingStatus) waitingStatus.style.display = 'none';
                if (injectionStatus) injectionStatus.style.display = 'inline';
                if (editBtn) editBtn.style.display = 'none';
                break;
                
            case 'waiting-for-terminals':
                // All terminals busy - yellow/active, show "Waiting..."
                display.classList.add('active'); // Keep timer yellow/amber
                if (waitingStatus) {
                    waitingStatus.style.display = 'inline';
                    waitingStatus.textContent = 'Waiting...';
                }
                if (injectionStatus) injectionStatus.style.display = 'none';
                if (editBtn) editBtn.style.display = 'none';
                break;
                
            case 'usage-limit-waiting':
                // Waiting for usage limit - yellow/active, show "Waiting..."
                display.classList.add('active'); // Keep timer yellow/amber
                if (waitingStatus) {
                    waitingStatus.style.display = 'inline';
                    waitingStatus.textContent = 'Waiting...';
                }
                if (injectionStatus) injectionStatus.style.display = 'none';
                if (editBtn) editBtn.style.display = 'none';
                break;
                
            case 'plan-mode-waiting':
                // Waiting for plan mode delay - yellow/active, show waiting
                display.classList.add('active'); // Keep timer yellow/amber
                if (waitingStatus) {
                    waitingStatus.style.display = 'inline';
                    waitingStatus.textContent = 'Waiting...';
                }
                if (injectionStatus) injectionStatus.style.display = 'none';
                if (editBtn) editBtn.style.display = 'none';
                break;
                
            case 'paused':
                // Injection paused - grey, show "Paused"
                // No special class (grey)
                if (waitingStatus) {
                    waitingStatus.style.display = 'inline';
                    waitingStatus.textContent = 'Paused';
                }
                if (injectionStatus) injectionStatus.style.display = 'none';
                if (editBtn) editBtn.style.display = 'none';
                break;
                
            case 'idle-expired':
            case 'idle':
            default:
                // Timer at 00:00:00, not active - grey, show edit button
                // No special class (grey)
                if (waitingStatus) waitingStatus.style.display = 'none';
                if (injectionStatus) injectionStatus.style.display = 'none';
                if (editBtn) editBtn.style.display = 'flex';
                break;
        }
        
        // Log state change for debugging
        this.gui.logAction(`Timer visual state: ${state}`, 'info');
    }
    
    /**
     * Get current injection state info
     */
    getStateInfo() {
        return {
            timerExpired: this.timerExpired,
            activeInjections: this.activeInjections.size,
            busyTerminals: this.busyTerminals.size,
            availableTerminals: this.getAvailableTerminals().length,
            usageLimitWaiting: this.usageLimitWaiting,
            planModeDelayActive: this.isPlanModeDelayActive(),
            remainingPlanModeDelay: this.getRemainingPlanModeDelay(),
            visualState: this.lastVisualState
        };
    }
}

// Export for use in renderer.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = InjectionManager;
}