/**
 * Sidebar Controller Module
 * 
 * Manages sidebar state, navigation, and terminal state monitoring for automatic todo generation
 * Extracted from TerminalGUI for better modularity
 */

class SidebarController {
    constructor(actionLogManager, todoManager, logAction) {
        this.actionLogManager = actionLogManager;
        this.todoManager = todoManager;
        this.logAction = logAction || console.log;
        
        this.terminalStateMonitoring = {
            interval: null,
            stabilityTimers: new Map(),
            lastStates: new Map(),
            isMonitoring: false
        };
        
        this.stabilitySettings = {
            requiredStabilityTime: 3 * 60 * 1000, // 3 minutes in milliseconds
            checkInterval: 10000 // Check every 10 seconds
        };
    }

    /**
     * Initialize sidebar controller
     */
    async initialize() {
        this.setupSidebarNavigation();
        this.startTerminalStateMonitoring();
        this.logAction('Sidebar controller initialized', 'info');
    }

    /**
     * Setup sidebar navigation between action log and todos
     */
    setupSidebarNavigation() {
        const actionLogBtn = document.getElementById('action-log-btn');
        const todosBtn = document.getElementById('todos-btn');

        if (actionLogBtn) {
            actionLogBtn.addEventListener('click', () => {
                this.switchToActionLog();
            });
        }

        if (todosBtn) {
            todosBtn.addEventListener('click', () => {
                this.switchToTodos();
            });
        }

        // Set initial active state
        this.updateNavigationState();
    }

    /**
     * Switch to action log view
     */
    async switchToActionLog() {
        await this.todoManager.switchSidebarView('action-log');
        this.updateNavigationState();
        this.actionLogManager.updateActionLogDisplay();
    }

    /**
     * Switch to todos view
     */
    async switchToTodos() {
        await this.todoManager.switchSidebarView('todos');
        this.updateNavigationState();
        await this.todoManager.refreshTodos();
    }

    /**
     * Update navigation button states
     */
    updateNavigationState() {
        const actionLogBtn = document.getElementById('action-log-btn');
        const todosBtn = document.getElementById('todos-btn');
        
        if (actionLogBtn && todosBtn) {
            const currentView = this.todoManager.currentView;
            
            actionLogBtn.classList.toggle('active', currentView === 'action-log');
            todosBtn.classList.toggle('active', currentView === 'todos');
        }
    }

    /**
     * Start monitoring terminal states for automatic todo generation
     */
    startTerminalStateMonitoring() {
        if (this.terminalStateMonitoring.isMonitoring) return;

        this.terminalStateMonitoring.interval = setInterval(() => {
            this.checkTerminalStatesForCompletion();
        }, this.stabilitySettings.checkInterval);

        this.terminalStateMonitoring.isMonitoring = true;
        this.logAction('Terminal state monitoring started for auto-todo generation', 'info');
    }

    /**
     * Stop terminal state monitoring
     */
    stopTerminalStateMonitoring() {
        if (this.terminalStateMonitoring.interval) {
            clearInterval(this.terminalStateMonitoring.interval);
            this.terminalStateMonitoring.interval = null;
        }

        // Clear all stability timers
        this.terminalStateMonitoring.stabilityTimers.forEach(timer => {
            clearTimeout(timer);
        });
        this.terminalStateMonitoring.stabilityTimers.clear();

        this.terminalStateMonitoring.isMonitoring = false;
        this.logAction('Terminal state monitoring stopped', 'info');
    }

    /**
     * Check all terminal states for completion and stability
     */
    checkTerminalStatesForCompletion() {
        const terminals = this.getAvailableTerminals();
        
        terminals.forEach(terminal => {
            const terminalId = terminal.id;
            const currentStatus = this.getTerminalStatus(terminalId);
            const lastStatus = this.terminalStateMonitoring.lastStates.get(terminalId);
            
            // Check if terminal transitioned from running/prompting to ready
            const justCompleted = lastStatus && 
                (lastStatus.isRunning || lastStatus.isPrompting) && 
                !currentStatus.isRunning && 
                !currentStatus.isPrompting;

            if (justCompleted) {
                this.logAction(`Terminal ${terminal.number} completed operation - starting stability timer`, 'info');
                this.handleTerminalStateChangeForTodos(terminalId, 'active', 'ready');
            }

            // Update last known state
            this.terminalStateMonitoring.lastStates.set(terminalId, {
                isRunning: currentStatus.isRunning,
                isPrompting: currentStatus.isPrompting,
                lastUpdate: Date.now()
            });
        });
    }

    /**
     * Handle terminal state change for todo generation with stability check
     * @param {string} terminalId - Terminal identifier
     * @param {string} oldStatus - Previous status
     * @param {string} newStatus - New status
     */
    handleTerminalStateChangeForTodos(terminalId, oldStatus, newStatus) {
        // Only trigger on transition to 'ready' state from active states
        if (newStatus !== 'ready' || (oldStatus !== 'running' && oldStatus !== 'prompting' && oldStatus !== 'active')) {
            return;
        }

        const terminalNumber = this.getTerminalNumber(terminalId);
        
        // Clear any existing stability timer for this terminal
        const existingTimer = this.terminalStateMonitoring.stabilityTimers.get(terminalId);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.logAction(`Restarting stability timer for Terminal ${terminalNumber}`, 'info');
        }

        // Set new stability timer
        const stabilityTimer = setTimeout(() => {
            this.checkTerminalStabilityForGeneration(terminalId);
        }, this.stabilitySettings.requiredStabilityTime);

        this.terminalStateMonitoring.stabilityTimers.set(terminalId, stabilityTimer);
        
        const stabilityMinutes = this.stabilitySettings.requiredStabilityTime / (60 * 1000);
        this.logAction(`Terminal ${terminalNumber} became ready - will check for todo generation in ${stabilityMinutes} minutes if stable`, 'info');
    }

    /**
     * Check if terminal has been stable and generate todos if appropriate
     * @param {string} terminalId - Terminal identifier
     */
    async checkTerminalStabilityForGeneration(terminalId) {
        try {
            const currentStatus = this.getTerminalStatus(terminalId);
            const terminalNumber = this.getTerminalNumber(terminalId);
            
            // Verify terminal is still in ready state (stable)
            if (currentStatus.isRunning || currentStatus.isPrompting) {
                this.logAction(`Terminal ${terminalNumber} became active again - canceling auto-todo generation`, 'info');
                return;
            }

            // Check if terminal has meaningful output for todo generation
            const terminalOutput = this.getCleanTerminalOutput(terminalId);
            if (!terminalOutput || terminalOutput.trim().length < 100) {
                this.logAction(`Terminal ${terminalNumber} has insufficient output for todo generation`, 'info');
                return;
            }

            // Generate todos for this stable terminal
            this.logAction(`Terminal ${terminalNumber} stable for ${this.stabilitySettings.requiredStabilityTime / (60 * 1000)} minutes - generating todos`, 'info');
            
            await this.generateTodosViaBackend(terminalId, terminalOutput);
            
            // Clean up the stability timer
            this.terminalStateMonitoring.stabilityTimers.delete(terminalId);
            
        } catch (error) {
            this.logAction(`Failed to generate todos for stable Terminal ${this.getTerminalNumber(terminalId)}: ${error.message}`, 'error');
        }
    }

    /**
     * Generate todos via backend for stable terminal
     * @param {string} terminalId - Terminal identifier
     * @param {string} terminalOutput - Terminal output to analyze
     */
    async generateTodosViaBackend(terminalId, terminalOutput) {
        try {
            // Use the todo manager to handle the actual generation
            await this.todoManager.createBackendSession(terminalId);
            await this.todoManager.generateTodosViaBackendWithMode(terminalId, terminalOutput, 'incremental');
            
            const terminalNumber = this.getTerminalNumber(terminalId);
            this.logAction(`Auto-generated todos for stable Terminal ${terminalNumber}`, 'success');
            
            // Refresh todos if user is currently viewing todo list
            if (this.todoManager.currentView === 'todos') {
                await this.todoManager.refreshTodos();
            }
            
        } catch (error) {
            this.logAction(`Backend todo generation failed for Terminal ${this.getTerminalNumber(terminalId)}: ${error.message}`, 'error');
            throw error;
        }
    }

    /**
     * Update stability settings
     * @param {Object} settings - New stability settings
     */
    updateStabilitySettings(settings) {
        if (settings.requiredStabilityTime) {
            this.stabilitySettings.requiredStabilityTime = settings.requiredStabilityTime;
        }
        
        if (settings.checkInterval) {
            this.stabilitySettings.checkInterval = settings.checkInterval;
            
            // Restart monitoring with new interval
            if (this.terminalStateMonitoring.isMonitoring) {
                this.stopTerminalStateMonitoring();
                this.startTerminalStateMonitoring();
            }
        }
        
        this.logAction(`Updated stability settings: ${JSON.stringify(this.stabilitySettings)}`, 'info');
    }

    /**
     * Get current sidebar view
     * @returns {string} - Current view ('action-log' or 'todos')
     */
    getCurrentView() {
        return this.todoManager.currentView;
    }

    /**
     * Clear terminal state data for closed terminal
     * @param {string} terminalId - Terminal identifier
     */
    clearTerminalStateData(terminalId) {
        // Clear stability timer if exists
        const timer = this.terminalStateMonitoring.stabilityTimers.get(terminalId);
        if (timer) {
            clearTimeout(timer);
            this.terminalStateMonitoring.stabilityTimers.delete(terminalId);
        }

        // Clear last state
        this.terminalStateMonitoring.lastStates.delete(terminalId);
        
        const terminalNumber = this.getTerminalNumber(terminalId);
        this.logAction(`Cleared state data for Terminal ${terminalNumber}`, 'info');
    }

    /**
     * Get monitoring status and statistics
     * @returns {Object} - Monitoring status information
     */
    getMonitoringStatus() {
        return {
            isMonitoring: this.terminalStateMonitoring.isMonitoring,
            activeTimers: this.terminalStateMonitoring.stabilityTimers.size,
            trackedTerminals: this.terminalStateMonitoring.lastStates.size,
            stabilitySettings: { ...this.stabilitySettings }
        };
    }

    /**
     * Helper methods that depend on external context
     * These would need to be injected or implemented based on available data
     */
    
    getAvailableTerminals() {
        // Implementation depends on terminal context
        // Should return array of terminal objects with id and number
        return [];
    }

    getTerminalStatus(terminalId) {
        // Implementation depends on terminal processor
        // Should return status object with isRunning and isPrompting
        return { isRunning: false, isPrompting: false };
    }

    getTerminalNumber(terminalId) {
        // Implementation depends on terminal mapping
        // Should return display number for terminal
        return terminalId;
    }

    getCleanTerminalOutput(terminalId) {
        // Implementation depends on terminal data access
        // Should return clean terminal output for analysis
        return '';
    }

    /**
     * Set external dependencies (dependency injection)
     * @param {Object} dependencies - External dependencies
     */
    setDependencies(dependencies) {
        if (dependencies.getAvailableTerminals) {
            this.getAvailableTerminals = dependencies.getAvailableTerminals;
        }
        
        if (dependencies.getTerminalStatus) {
            this.getTerminalStatus = dependencies.getTerminalStatus;
        }
        
        if (dependencies.getTerminalNumber) {
            this.getTerminalNumber = dependencies.getTerminalNumber;
        }
        
        if (dependencies.getCleanTerminalOutput) {
            this.getCleanTerminalOutput = dependencies.getCleanTerminalOutput;
        }
    }

    /**
     * Destroy and cleanup
     */
    destroy() {
        this.stopTerminalStateMonitoring();
        this.terminalStateMonitoring.lastStates.clear();
        this.logAction('Sidebar controller destroyed', 'info');
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SidebarController;
} else if (typeof window !== 'undefined') {
    window.SidebarController = SidebarController;
}