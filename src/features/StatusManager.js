/**
 * StatusManager.js - Centralized terminal status management
 * Consolidates 25+ status functions from renderer.js into cohesive system
 * 
 * Status Types:
 * - '...' (default/idle)
 * - 'running' (process executing)
 * - 'prompted' (Claude prompt active)
 * - 'injecting' (message being injected)
 */

const { BoundedMap } = require('../utils/bounded-collections');

class StatusManager {
    constructor(eventBus, appStateStore) {
        this.eventBus = eventBus;
        this.stateStore = appStateStore;
        
        // Core status tracking
        this.terminalStatuses = new BoundedMap(50); // terminalId -> status state
        this.statusTransitionTimers = new BoundedMap(50); // Prevent memory leaks
        this.statusDisplayElements = new BoundedMap(50); // Cache DOM elements
        this.previousTerminalStatuses = new BoundedMap(50);
        
        // Global status cache
        this.currentTerminalStatus = {
            isRunning: false,
            isPrompting: false
        };
        
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Status is driven by Claude Code hooks (the canonical
        // terminal:status:changed event), NOT by scraping terminal output —
        // output parsing is deprecated and caused cross-terminal status bleed.
        // Each event carries its own terminalId, so we paint exactly one
        // terminal's header and never touch the others.
        this.eventBus.on('terminal:status:changed', (data) => {
            this.applyCanonicalStatus(data.terminalId, data.status, data.previousStatus);
        });

        // Listen for injection events (MessageQueueManager emits the
        // message:-prefixed names; the unprefixed variants were never emitted)
        this.eventBus.on('message:injection-started', (data) => {
            this.updateTerminalStatus(data.terminalId, 'injecting');
        });

        this.eventBus.on('message:injection-completed', (data) => {
            this.scanSingleTerminalStatus(data.terminalId);
        });
        
        // Listen for usage limit events
        this.eventBus.on('usageLimit:detected', () => {
            this.setAllTerminalStatuses('');
        });
        
        // Listen for terminal removal (the close path emits terminal:closed)
        this.eventBus.on('terminal:closed', (data) => {
            this.cleanupTerminalStatusTracking(data.terminalId);
        });
    }

    // Look up a terminal's data from the canonical instances Map
    getTerminalData(terminalId) {
        const instances = this.stateStore.getState('terminals.instances');
        if (instances && typeof instances.get === 'function') {
            return instances.get(terminalId) || null;
        }
        return null;
    }

    // Get the canonical instances Map of terminals
    getTerminalsMap() {
        const instances = this.stateStore.getState('terminals.instances');
        return (instances && typeof instances.forEach === 'function') ? instances : new Map();
    }

    // Find a queued message by id from the canonical message queue
    findQueuedMessage(messageId) {
        const queue = this.stateStore.getState('messages.queue') || [];
        return Array.isArray(queue) ? queue.find(m => m && m.id === messageId) || null : null;
    }

    // Initialize status tracking for a new terminal
    initializeTerminalStatus(terminalId) {
        this.terminalStatuses.set(terminalId, {
            isRunning: false,
            isPrompting: false,
            lastUpdate: Date.now(),
            status: '...'
        });
        
        // Initialize display
        this.setTerminalStatusDisplay('', terminalId);
    }

    // Main status update method
    updateTerminalStatus(terminalId, status) {
        const previousStatus = this.terminalStatuses.get(terminalId);
        
        const newStatus = {
            current: status,
            previous: previousStatus?.current || '',
            timestamp: Date.now(),
            isRunning: status === 'running',
            isPrompting: status === 'prompted',
            isInjecting: status === 'injecting',
            lastUpdate: Date.now(),
            status: status || '...'
        };
        
        this.terminalStatuses.set(terminalId, newStatus);
        this.updateStatusDisplay(terminalId, status, previousStatus?.current);

        // Emit canonical status change event
        this.eventBus.emit('terminal:status:changed', {
            terminalId,
            status,
            previousStatus: previousStatus?.current || null,
            source: 'StatusManager'
        });

        // Update global status if this is the active terminal
        const activeTerminalId = this.stateStore.getState('terminals.activeId');
        if (terminalId === activeTerminalId) {
            this.currentTerminalStatus.isRunning = newStatus.isRunning;
            this.currentTerminalStatus.isPrompting = newStatus.isPrompting;
        }
    }

    // Scan and update status for a single terminal
    scanSingleTerminalStatus(terminalId, terminalData = null) {
        if (!terminalData) {
            terminalData = this.getTerminalData(terminalId);
        }
        
        if (!terminalData || !terminalData.terminal) {
            return { isRunning: false, isPrompting: false };
        }
        
        // Get recent terminal output from multiple sources for better accuracy
        const recentOutput = terminalData.lastOutput || '';
        const buffer = terminalData.buffer || [];
        const bufferText = buffer.slice(-50).join('\n'); // Last 50 lines from buffer
        const combinedOutput = recentOutput + '\n' + bufferText;
        
        // Enhanced detection patterns
        const runningPatterns = [
            /\.{3,}$/,                     // Three or more dots at end
            /\[.*?\]/,                     // Progress indicators
            /Loading/i,                    // Loading messages
            /Processing/i,                 // Processing messages
            /Downloading/i,                // Downloading messages
            /Installing/i,                 // Installing messages
            /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/,    // Spinner characters
            /█|▓|▒|░/,                     // Progress bar characters
            /\d+%/,                        // Percentage indicators
            /\[\d+\/\d+\]/,               // Progress counters
            /npm|yarn|pnpm|pip|cargo/,     // Package managers
            /webpack|vite|parcel/,         // Build tools
            /git clone|git pull|git push/, // Git operations
            /docker|kubectl/,              // Container operations
            /python|node|ruby|java/        // Running interpreters
        ];
        
        const promptPatterns = [
            /Human:/,                      // Claude prompt
            /Assistant:/,                  // Claude response marker
            /Would you like|Do you want|Should I/i, // Decision prompts
            /\(y\/n\)|yes\/no/i,          // Yes/no prompts
            /Press any key|Press enter/i,  // Key press prompts
            /Continue\?|Proceed\?/i,       // Continuation prompts
            /Enter password|Enter username/i, // Auth prompts
            /Please select|Choose an option/i, // Selection prompts
            /\[Y\/n\]|\[y\/N\]/,          // Common prompt formats
            /> $/,                         // Shell prompt at end
            /\$ $/,                        // Shell prompt at end
            /# $/                          // Root prompt at end
        ];
        
        // Check for running process
        const isRunning = runningPatterns.some(pattern => pattern.test(combinedOutput));
        
        // Check for prompting state
        const isPrompting = promptPatterns.some(pattern => pattern.test(combinedOutput));
        
        // Get current status for this terminal
        const currentStatus = this.terminalStatuses.get(terminalId) || {
            isRunning: false,
            isPrompting: false,
            lastUpdate: Date.now(),
            status: '...'
        };
        
        // Update the terminal's status
        this.terminalStatuses.set(terminalId, {
            isRunning: isRunning,
            isPrompting: isPrompting,
            lastUpdate: Date.now(),
            status: isRunning ? 'running' : (isPrompting ? 'prompted' : '...')
        });
        
        return { isRunning, isPrompting };
    }

    // Update all terminal status indicators
    updateTerminalStatusIndicator() {
        const terminals = this.getTerminalsMap();
        const usageLimitWaiting = this.stateStore.getState('usageLimit.waiting');
        const currentlyInjectingMessages = this.stateStore.getState('messages.currentlyInjecting') || new Set();
        
        terminals.forEach((terminalData, terminalId) => {
            // When waiting for usage limit reset, always show default "..." status
            if (usageLimitWaiting) {
                this.setTerminalStatusDisplay('', terminalId);
                return;
            }
            
            // Check if this specific terminal is currently injecting
            const isInjectingToThisTerminal = Array.from(currentlyInjectingMessages).some(messageId => {
                const message = this.findQueuedMessage(messageId);
                return message && message.terminalId === terminalId;
            });
            
            if (isInjectingToThisTerminal) {
                this.setTerminalStatusDisplay('injecting', terminalId);
            } else {
                // Use per-terminal status instead of just active terminal
                const terminalStatus = this.terminalStatuses.get(terminalId);
                
                if (terminalStatus && terminalStatus.isRunning) {
                    this.setTerminalStatusDisplay('running', terminalId);
                } else if (terminalStatus && terminalStatus.isPrompting) {
                    this.setTerminalStatusDisplay('prompted', terminalId);
                } else {
                    this.setTerminalStatusDisplay('', terminalId);
                }
            }
        });
    }

    // Set terminal status display with proper transitions
    setTerminalStatusDisplay(status, terminalId = null) {
        // If terminalId is provided, update specific terminal status
        if (terminalId) {
            const terminalData = this.getTerminalData(terminalId);
            if (terminalData) {
                const newStatus = status || '...';
                const previousStatus = terminalData.status || '...';
                
                // Handle special transition: 'running' -> '...'
                if (previousStatus === 'running' && newStatus === '...') {
                    // Initialize status transition timers if not exists
                    if (!this.statusTransitionTimers) {
                        this.statusTransitionTimers = new BoundedMap(50);
                    }
                    
                    // Cancel any existing timer for this terminal
                    if (this.statusTransitionTimers.has(terminalId)) {
                        clearTimeout(this.statusTransitionTimers.get(terminalId));
                        this.statusTransitionTimers.delete(terminalId);
                    }
                    
                    // Set a delay timer for this transition
                    const timerId = setTimeout(() => {
                        const currentTerminalData = this.getTerminalData(terminalId);
                        if (currentTerminalData && currentTerminalData.status === 'running') {
                            // Now update the status and DOM
                            currentTerminalData.status = '...';
                            this.updateTerminalStatusDOM(terminalId, '...', 'running');
                        }
                        this.statusTransitionTimers.delete(terminalId);
                    }, 2000);
                    
                    this.statusTransitionTimers.set(terminalId, timerId);
                    return; // Don't update status or DOM immediately for this transition
                }
                
                // For all other transitions, update status and DOM immediately
                terminalData.status = newStatus;
                this.updateTerminalStatusDOM(terminalId, newStatus, previousStatus);
            }
        } else {
            // Legacy support - update active terminal
            const activeTerminalId = this.stateStore.getState('terminals.activeId');
            this.setTerminalStatusDisplay(status, activeTerminalId);
        }
    }

    /**
     * Apply a canonical status (from the hook-driven terminal:status:changed
     * event) to a SINGLE terminal. Status state is stored per-id and the DOM
     * write is scoped to that terminal's header span, so terminals — including
     * the manager (999) — never share status. Canonical status values:
     * 'running' | 'prompted' | 'injecting' | '...' | 'idle' | 'error' | ''.
     */
    applyCanonicalStatus(terminalId, status, previousStatus) {
        if (terminalId === null || terminalId === undefined) return;

        this.terminalStatuses.set(terminalId, {
            isRunning: status === 'running',
            isPrompting: status === 'prompted',
            isInjecting: status === 'injecting',
            lastUpdate: Date.now(),
            status: status || '...'
        });

        // Paint ONLY this terminal's header — keyed strictly by terminalId.
        this.updateTerminalStatusDOM(terminalId, status, previousStatus);

        // The global cache (used by the sidebar status panel) tracks the
        // ACTIVE terminal only; it must not be overwritten by background tabs.
        const activeTerminalId = this.stateStore.getState('terminals.activeId');
        if (terminalId === activeTerminalId) {
            this.currentTerminalStatus.isRunning = status === 'running';
            this.currentTerminalStatus.isPrompting = status === 'prompted';
        }
    }

    // Direct DOM update without complex transition logic. Scoped to one
    // terminal via the [data-terminal-status="<id>"] selector.
    updateTerminalStatusDOM(terminalId, newStatus, previousStatus) {
        const statusElement = document.querySelector(`[data-terminal-status="${terminalId}"]`);
        if (!statusElement) return;

        const LABELS = { running: 'Running', prompted: 'Prompted', injecting: 'Injecting' };
        // Anything that isn't an active state ('...', 'idle', 'error', '') is idle.
        const label = LABELS[newStatus] || '...';
        const modifier = LABELS[newStatus] ? newStatus : 'idle';

        statusElement.textContent = label;
        statusElement.className = `terminal-status visible ${modifier}`;

        // Add transition classes for animation
        if (previousStatus !== newStatus) {
            statusElement.classList.add('status-transition');
            setTimeout(() => {
                statusElement.classList.remove('status-transition');
            }, 300);
        }
    }

    // Get terminal display status for external integrations
    getTerminalDisplayStatus(terminalId) {
        // Get the current terminal display status for pricing manager integration
        const terminalData = this.getTerminalData(terminalId);
        if (!terminalData) return '...';
        
        // Get the actual displayed status from DOM first (most accurate)
        const statusElement = document.querySelector(`[data-terminal-status="${terminalId}"]`);
        if (statusElement && statusElement.textContent) {
            return statusElement.textContent;
        }
        
        // Fallback to stored status
        return terminalData.status || '...';
    }

    // Event-driven status update from terminal output
    updateTerminalStatusFromOutput(terminalId, outputContent) {
        const terminalData = this.getTerminalData(terminalId);
        if (!terminalData) return;
        
        // Store previous status for comparison
        const previousStatus = this.terminalStatuses.get(terminalId);
        if (previousStatus) {
            this.previousTerminalStatuses.set(terminalId, { ...previousStatus });
        }
        
        // Perform the status scan for this terminal
        this.scanSingleTerminalStatus(terminalId, terminalData);
        
        // Update global status if this is the active terminal
        const activeTerminalId = this.stateStore.getState('terminals.activeId');
        if (terminalId === activeTerminalId && this.terminalStatuses.has(terminalId)) {
            const activeStatus = this.terminalStatuses.get(terminalId);
            this.currentTerminalStatus.isRunning = activeStatus.isRunning;
            this.currentTerminalStatus.isPrompting = activeStatus.isPrompting;
        }
        
        // Update the visual status indicator
        this.updateTerminalStatusIndicator();
    }

    // Cleanup function for terminal status tracking
    cleanupTerminalStatusTracking(terminalId) {
        // Clear status transition timer for this terminal
        if (this.statusTransitionTimers && this.statusTransitionTimers.has(terminalId)) {
            clearTimeout(this.statusTransitionTimers.get(terminalId));
            this.statusTransitionTimers.delete(terminalId);
        }
        
        // Remove from previous status tracking
        if (this.previousTerminalStatuses) {
            this.previousTerminalStatuses.delete(terminalId);
        }
        
        // Remove from current status tracking
        if (this.terminalStatuses) {
            this.terminalStatuses.delete(terminalId);
        }
        
        // Clear cached DOM element
        if (this.statusDisplayElements) {
            this.statusDisplayElements.delete(terminalId);
        }
    }

    // Set all terminal statuses at once (for usage limit scenarios)
    setAllTerminalStatuses(status) {
        const terminals = this.getTerminalsMap();
        terminals.forEach((terminalData, terminalId) => {
            this.setTerminalStatusDisplay(status, terminalId);
        });
    }

    // Get global terminal status (backward compatibility)
    scanTerminalStatus() {
        // Return current cached status (updated every time any terminal updates)
        return {
            isRunning: this.currentTerminalStatus.isRunning,
            isPrompting: this.currentTerminalStatus.isPrompting
        };
    }

    // Update status display (backward compatibility)
    updateStatusDisplay() {
        this.updateTerminalStatusIndicator();
    }

    // Handle terminal state changes
    handleTerminalStateChange(terminalId, state) {
        if (state === 'active') {
            // Update global status when terminal becomes active
            const status = this.terminalStatuses.get(terminalId);
            if (status) {
                this.currentTerminalStatus.isRunning = status.isRunning;
                this.currentTerminalStatus.isPrompting = status.isPrompting;
            }
        }
    }

    // Get all terminal statuses for reporting
    getAllTerminalStatuses() {
        const statuses = {};
        this.terminalStatuses.forEach((status, terminalId) => {
            statuses[terminalId] = {
                isRunning: status.isRunning,
                isPrompting: status.isPrompting,
                status: status.status,
                lastUpdate: status.lastUpdate
            };
        });
        return statuses;
    }

    // Cleanup all resources
    cleanup() {
        // Clear all timers
        if (this.statusTransitionTimers) {
            for (const [terminalId, timeoutId] of this.statusTransitionTimers) {
                clearTimeout(timeoutId);
            }
            this.statusTransitionTimers.clear();
        }
        
        // Clear all maps
        this.terminalStatuses.clear();
        this.previousTerminalStatuses.clear();
        this.statusDisplayElements.clear();
    }
}

module.exports = StatusManager;