/**
 * TerminalStateManager - Centralized state management for all terminals
 * Replaces 117 scattered terminal access points in renderer.js
 * Single source of truth for terminal state with validation and observers
 */
class TerminalStateManager {
    constructor() {
        this.terminals = new Map();
        this.activeTerminalId = null;
        this.terminalIdCounter = 1;
        this.observers = new Set();
        this.pendingData = new Map();
        this.sessionMap = new Map();
        
        // Terminal status tracking
        this.readyTerminals = new Set();
        this.busyTerminals = new Set();
        this.errorTerminals = new Set();
    }

    /**
     * Create a new terminal with initial state
     * @param {Object} config - Terminal configuration
     * @returns {Object} Terminal data object
     */
    createTerminal(config = {}) {
        const id = config.id ?? this.terminalIdCounter++;
        
        const terminalData = {
            id,
            terminal: config.terminal || null,
            isReady: false,
            isBusy: false,
            lastOutput: '',
            lastInput: '',
            directory: config.directory || null,
            sessionId: config.sessionId || null,
            chunkId: config.chunkId || null,
            color: config.color || null,
            title: config.title || `Terminal ${id}`,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            metrics: {
                messageCount: 0,
                tokenCount: 0,
                errorCount: 0
            }
        };
        
        this.terminals.set(id, terminalData);
        
        if (config.sessionId) {
            this.sessionMap.set(config.sessionId, id);
        }
        
        this.notifyObservers('terminal-created', { id, data: terminalData });
        return terminalData;
    }

    /**
     * Get terminal by ID - replaces this.terminals.get(terminalId)
     * @param {number} id - Terminal ID
     * @returns {Object|null} Terminal data or null
     */
    getTerminal(id) {
        return this.terminals.get(id) || null;
    }

    /**
     * Get terminal by session ID
     * @param {string} sessionId - Session ID
     * @returns {Object|null} Terminal data or null
     */
    getTerminalBySession(sessionId) {
        const terminalId = this.sessionMap.get(sessionId);
        return terminalId ? this.getTerminal(terminalId) : null;
    }

    /**
     * Update terminal state with validation
     * @param {number} id - Terminal ID
     * @param {Object} updates - Properties to update
     * @returns {boolean} Success status
     */
    updateTerminal(id, updates) {
        const terminal = this.terminals.get(id);
        if (!terminal) {
            console.error(`Terminal ${id} not found`);
            return false;
        }
        
        const previousState = { ...terminal };
        const updatedTerminal = {
            ...terminal,
            ...updates,
            updatedAt: Date.now()
        };
        
        // Validate state transitions
        if (!this.validateStateTransition(previousState, updatedTerminal)) {
            console.error(`Invalid state transition for terminal ${id}`);
            return false;
        }
        
        this.terminals.set(id, updatedTerminal);
        
        // Update status sets
        this.updateStatusSets(id, updatedTerminal);
        
        this.notifyObservers('terminal-updated', {
            id,
            previous: previousState,
            current: updatedTerminal,
            changes: updates
        });
        
        return true;
    }

    /**
     * Set active terminal
     * @param {number} id - Terminal ID to activate
     * @returns {boolean} Success status
     */
    setActiveTerminal(id) {
        if (!this.terminals.has(id)) {
            console.error(`Cannot activate non-existent terminal ${id}`);
            return false;
        }
        
        const previousActive = this.activeTerminalId;
        this.activeTerminalId = id;
        
        this.notifyObservers('active-terminal-changed', {
            previous: previousActive,
            current: id
        });
        
        return true;
    }

    /**
     * Get active terminal
     * @returns {Object|null} Active terminal data or null
     */
    getActiveTerminal() {
        return this.activeTerminalId ? this.getTerminal(this.activeTerminalId) : null;
    }

    /**
     * Set the status string for a terminal and derive busy/ready flags.
     * @param {number} id - Terminal ID
     * @param {string} status - One of 'running' | 'prompted' | 'idle' | 'error'
     * @returns {string|null} The previous status string, or null if terminal missing
     */
    setTerminalStatus(id, status) {
        const terminal = this.terminals.get(id);
        if (!terminal) {
            console.error(`Cannot set status for non-existent terminal ${id}`);
            return null;
        }

        const previousStatus = terminal.status || null;

        // Derive busy/ready flags from the canonical status
        const isBusy = status === 'running';
        const isReady = status !== 'running' && !!terminal.terminal;

        const updatedTerminal = {
            ...terminal,
            status,
            isBusy,
            isReady,
            updatedAt: Date.now()
        };

        this.terminals.set(id, updatedTerminal);

        // Keep status tracking sets in sync
        this.updateStatusSets(id, updatedTerminal);
        if (status === 'error') {
            this.errorTerminals.add(id);
        } else {
            this.errorTerminals.delete(id);
        }

        this.notifyObservers('terminal-status-changed', {
            id,
            status,
            previousStatus
        });

        return previousStatus;
    }

    /**
     * Mark terminal as ready
     * @param {number} id - Terminal ID
     * @returns {boolean} Success status
     */
    markTerminalReady(id) {
        return this.updateTerminal(id, {
            isReady: true,
            isBusy: false,
            readyAt: Date.now()
        });
    }

    /**
     * Mark terminal as busy
     * @param {number} id - Terminal ID
     * @returns {boolean} Success status
     */
    markTerminalBusy(id) {
        return this.updateTerminal(id, {
            isBusy: true,
            busyAt: Date.now()
        });
    }

    /**
     * Append output to terminal
     * @param {number} id - Terminal ID
     * @param {string} content - Content to append
     * @returns {boolean} Success status
     */
    appendOutput(id, content) {
        const terminal = this.getTerminal(id);
        if (!terminal) return false;
        
        return this.updateTerminal(id, {
            lastOutput: terminal.lastOutput + content
        });
    }

    /**
     * Set terminal directory
     * @param {number} id - Terminal ID
     * @param {string} directory - Current working directory
     * @returns {boolean} Success status
     */
    setTerminalDirectory(id, directory) {
        return this.updateTerminal(id, { directory });
    }

    /**
     * Update terminal metrics
     * @param {number} id - Terminal ID
     * @param {Object} metrics - Metrics to update
     * @returns {boolean} Success status
     */
    updateMetrics(id, metrics) {
        const terminal = this.getTerminal(id);
        if (!terminal) return false;
        
        return this.updateTerminal(id, {
            metrics: {
                ...terminal.metrics,
                ...metrics
            }
        });
    }

    /**
     * Get all terminals
     * @returns {Map} All terminals
     */
    getAllTerminals() {
        return new Map(this.terminals);
    }

    /**
     * Get terminals by status
     * @param {string} status - Status to filter by (ready, busy, error)
     * @returns {Array} Array of terminal data objects
     */
    getTerminalsByStatus(status) {
        const statusSet = {
            ready: this.readyTerminals,
            busy: this.busyTerminals,
            error: this.errorTerminals
        }[status];
        
        if (!statusSet) return [];
        
        return Array.from(statusSet).map(id => this.getTerminal(id)).filter(Boolean);
    }

    /**
     * Remove terminal
     * @param {number} id - Terminal ID to remove
     * @returns {boolean} Success status
     */
    removeTerminal(id) {
        const terminal = this.terminals.get(id);
        if (!terminal) return false;
        
        // Clean up session mapping
        if (terminal.sessionId) {
            this.sessionMap.delete(terminal.sessionId);
        }
        
        // Clean up status sets
        this.readyTerminals.delete(id);
        this.busyTerminals.delete(id);
        this.errorTerminals.delete(id);
        
        // Remove from terminals map
        this.terminals.delete(id);
        
        // Update active terminal if needed
        if (this.activeTerminalId === id) {
            const remainingIds = Array.from(this.terminals.keys());
            this.activeTerminalId = remainingIds.length > 0 ? remainingIds[0] : null;
        }
        
        this.notifyObservers('terminal-removed', { id, data: terminal });
        return true;
    }

    /**
     * Clear all terminal output
     * @param {number} id - Terminal ID
     * @returns {boolean} Success status
     */
    clearTerminalOutput(id) {
        return this.updateTerminal(id, {
            lastOutput: '',
            lastInput: ''
        });
    }

    /**
     * Store pending data for terminal
     * @param {number} id - Terminal ID
     * @param {any} data - Data to store
     */
    setPendingData(id, data) {
        this.pendingData.set(id, data);
        this.notifyObservers('pending-data-set', { id, data });
    }

    /**
     * Get and clear pending data for terminal
     * @param {number} id - Terminal ID
     * @returns {any} Pending data or null
     */
    getPendingData(id) {
        const data = this.pendingData.get(id);
        if (data) {
            this.pendingData.delete(id);
        }
        return data || null;
    }

    /**
     * Add observer for state changes
     * @param {Function} callback - Observer callback
     */
    addObserver(callback) {
        this.observers.add(callback);
    }

    /**
     * Remove observer
     * @param {Function} callback - Observer callback to remove
     */
    removeObserver(callback) {
        this.observers.delete(callback);
    }

    /**
     * Notify all observers of state change
     * @param {string} event - Event type
     * @param {Object} data - Event data
     */
    notifyObservers(event, data) {
        this.observers.forEach(callback => {
            try {
                callback(event, data);
            } catch (error) {
                console.error('Observer error:', error);
            }
        });
    }

    /**
     * Validate state transition
     * @private
     * @param {Object} previous - Previous state
     * @param {Object} current - Current state
     * @returns {boolean} Valid transition
     */
    validateStateTransition(previous, current) {
        // Cannot be ready and busy simultaneously
        if (current.isReady && current.isBusy) {
            return false;
        }
        
        // Terminal must exist to be ready
        if (current.isReady && !current.terminal) {
            return false;
        }
        
        return true;
    }

    /**
     * Update status tracking sets
     * @private
     * @param {number} id - Terminal ID
     * @param {Object} terminal - Terminal data
     */
    updateStatusSets(id, terminal) {
        // Update ready set
        if (terminal.isReady && !terminal.isBusy) {
            this.readyTerminals.add(id);
        } else {
            this.readyTerminals.delete(id);
        }
        
        // Update busy set
        if (terminal.isBusy) {
            this.busyTerminals.add(id);
        } else {
            this.busyTerminals.delete(id);
        }
        
        // Error terminals would be updated based on error conditions
    }

    /**
     * Get state summary for debugging
     * @returns {Object} State summary
     */
    getStateSummary() {
        return {
            totalTerminals: this.terminals.size,
            activeTerminal: this.activeTerminalId,
            readyCount: this.readyTerminals.size,
            busyCount: this.busyTerminals.size,
            errorCount: this.errorTerminals.size,
            pendingDataCount: this.pendingData.size,
            observerCount: this.observers.size
        };
    }

    /**
     * Export state for persistence
     * @returns {Object} Serializable state
     */
    exportState() {
        return {
            terminals: Array.from(this.terminals.entries()).map(([id, data]) => ({
                id,
                ...data,
                terminal: null // Don't serialize terminal instance
            })),
            activeTerminalId: this.activeTerminalId,
            terminalIdCounter: this.terminalIdCounter
        };
    }

    /**
     * Import state from persistence
     * @param {Object} state - State to import
     */
    importState(state) {
        if (!state) return;
        
        // Clear current state
        this.terminals.clear();
        this.sessionMap.clear();
        this.readyTerminals.clear();
        this.busyTerminals.clear();
        this.errorTerminals.clear();
        
        // Import terminals
        if (state.terminals) {
            state.terminals.forEach(terminalData => {
                const { id, ...data } = terminalData;
                this.terminals.set(id, data);
                
                if (data.sessionId) {
                    this.sessionMap.set(data.sessionId, id);
                }
                
                this.updateStatusSets(id, data);
            });
        }
        
        // Import other state
        this.activeTerminalId = state.activeTerminalId || null;
        this.terminalIdCounter = state.terminalIdCounter || 1;
        
        this.notifyObservers('state-imported', state);
    }
}

// Export for use in renderer.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TerminalStateManager;
}