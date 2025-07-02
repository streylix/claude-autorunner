/**
 * Terminal Status Module
 * Handles terminal status detection, monitoring, and display
 */

class TerminalStatus {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        this.terminals = terminalGUI.terminals;
        this.terminalStatuses = terminalGUI.terminalStatuses;
        this.statusScanInterval = null;
        this.terminalStabilityTimers = new Map();
    }

    updateTerminalStatusIndicator() {
        // Update status for all terminals
        this.terminals.forEach((terminalData, terminalId) => {
            // Check if this terminal is currently injecting
            const isInjectingToThisTerminal = Array.from(this.gui.currentlyInjectingMessages).some(messageId => {
                const message = this.gui.messageQueue.find(m => m.id === messageId);
                return message && (message.terminalId != null ? message.terminalId : this.gui.activeTerminalId) === terminalId;
            });
            
            if (isInjectingToThisTerminal) {
                this.setTerminalStatusDisplay('injecting', terminalId);
            } else {
                // Use per-terminal status for priority order
                const terminalStatus = this.terminalStatuses.get(terminalId);
                
                // Check per-terminal waiting status first (highest priority)
                if (terminalData.isWaiting || (terminalStatus && terminalStatus.isWaiting)) {
                    this.setTerminalStatusDisplay('waiting', terminalId);
                } else if (terminalStatus && terminalStatus.isRunning) {
                    this.setTerminalStatusDisplay('running', terminalId);
                } else if (terminalStatus && terminalStatus.isPrompting) {
                    this.setTerminalStatusDisplay('prompted', terminalId);
                } else {
                    this.setTerminalStatusDisplay('', terminalId);
                }
            }
        });
    }

    setTerminalStatusDisplay(status, terminalId = null) {
        // If terminalId is provided, update specific terminal status
        if (terminalId) {
            const terminalData = this.terminals.get(terminalId);
            if (terminalData) {
                const previousStatus = terminalData.status;
                terminalData.status = status || '...';
                
                const statusElement = document.querySelector(`[data-terminal-status="${terminalId}"]`);
                if (statusElement) {
                    // Clear all classes
                    statusElement.className = 'terminal-status';
                    
                    // Set new status
                    switch(status) {
                        case 'running':
                            statusElement.className = 'terminal-status visible running';
                            statusElement.textContent = 'Running';
                            break;
                        case 'prompted':
                            statusElement.className = 'terminal-status visible prompted';
                            statusElement.textContent = 'Prompted';
                            break;
                        case 'injecting':
                            statusElement.className = 'terminal-status visible injecting';
                            statusElement.textContent = 'Injecting';
                            break;
                        case 'waiting':
                            statusElement.className = 'terminal-status visible waiting';
                            statusElement.textContent = 'Waiting';
                            break;
                        default:
                            statusElement.className = 'terminal-status';
                            statusElement.textContent = '...';
                    }
                }
                
                // Check for completion sound trigger for this terminal
                this.checkCompletionSoundTrigger(previousStatus, terminalData.status);
            }
        } else {
            // Legacy support - update active terminal
            this.setTerminalStatusDisplay(status, this.gui.activeTerminalId);
        }
    }

    checkCompletionSoundTrigger(previousStatus, currentStatus) {
        // Trigger completion sound when transitioning from 'running' to idle ('...')
        if (previousStatus === 'running' && (currentStatus === '...' || currentStatus === '')) {
            // Start idle timer for completion sound
            if (!this.gui.terminalIdleStartTime) {
                this.gui.terminalIdleStartTime = Date.now();
                
                // Set timeout to play sound after 2 seconds of idle time
                setTimeout(() => {
                    if (this.gui.terminalIdleStartTime && 
                        Date.now() - this.gui.terminalIdleStartTime >= 2000) {
                        this.gui.playCompletionSound();
                        this.gui.terminalIdleStartTime = null;
                    }
                }, 2000);
            }
        } else if (currentStatus === 'running') {
            // Reset idle timer if terminal becomes running again
            this.gui.terminalIdleStartTime = null;
        }
    }

    scanTerminalStatus() {
        // Return current cached status (updated every 10ms)
        return {
            isRunning: this.gui.currentTerminalStatus.isRunning,
            isPrompting: this.gui.currentTerminalStatus.isPrompting,
            lastUpdate: this.gui.currentTerminalStatus.lastUpdate
        };
    }

    scanAndUpdateTerminalStatus() {
        // Scan all terminals every 10ms for status changes
        this.terminals.forEach((terminalData, terminalId) => {
            const recentOutput = terminalData.lastOutput.slice(-1000) || '';
            const result = this.scanSingleTerminalStatus(terminalId, terminalData);
            
            // Update the terminal status map
            this.terminalStatuses.set(terminalId, {
                isRunning: result.isRunning,
                isPrompting: result.isPrompting,
                isWaiting: terminalData.isWaiting || false,
                lastUpdate: Date.now()
            });
        });
        
        // Update terminal status display
        this.updateTerminalStatusIndicator();
    }

    scanSingleTerminalStatus(terminalId, terminalData) {
        const recentOutput = terminalData.lastOutput.slice(-1000) || '';
        
        // Better detection patterns for running state
        const isRunning = recentOutput.includes('esc to interrupt') || 
                         recentOutput.includes('(esc to interrupt)') ||
                         recentOutput.includes('ESC to interrupt') ||
                         recentOutput.includes('offline)');

        // Check for ╭ character to trigger auto-continue analysis
        const hasCornerChar = recentOutput.includes('╭');
        const isPrompting = recentOutput.includes('No, and tell Claude what to do differently');

        // Auto-continue prompt detection for this specific terminal
        // Check for either the ╭ character or the traditional prompt
        if ((hasCornerChar || isPrompting) && this.gui.autoContinueEnabled) {
            this.gui.detectAutoContinuePrompt(recentOutput, terminalId);
        }

        // Enhanced directory detection
        const directoryMatches = recentOutput.match(/(?:^|\n)([^|\n]*?)([~/][^\s]*)\s*(?:\$|%|#|>)/);
        if (directoryMatches && directoryMatches[2]) {
            const detectedDirectory = directoryMatches[2].trim();
            if (detectedDirectory && detectedDirectory !== terminalData.directory) {
                terminalData.directory = detectedDirectory;
                this.gui.logAction(`Terminal ${terminalId} directory changed to: ${detectedDirectory}`, 'info');
                
                // Update current directory preference if this is the active terminal
                if (terminalId === this.gui.activeTerminalId) {
                    this.gui.preferences.currentDirectory = detectedDirectory;
                    this.gui.savePreferences();
                    this.gui.updateStatusDisplay();
                }
            }
        }

        return {
            isRunning,
            isPrompting,
            directory: terminalData.directory
        };
    }

    startTerminalStatusScanning() {
        if (this.statusScanInterval) return;
        
        this.statusScanInterval = setInterval(() => {
            this.scanAndUpdateTerminalStatus();
        }, 10);
    }

    stopTerminalStatusScanning() {
        if (this.statusScanInterval) {
            clearInterval(this.statusScanInterval);
            this.statusScanInterval = null;
        }
    }

    isTerminalStableAndReady(terminalId) {
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return false;

        // Check if terminal is currently injecting
        const isInjectingToThisTerminal = Array.from(this.gui.currentlyInjectingMessages).some(messageId => {
            const message = this.gui.messageQueue.find(m => m.id === messageId);
            return message && (message.terminalId != null ? message.terminalId : this.gui.activeTerminalId) === terminalId;
        });

        if (isInjectingToThisTerminal) return false;

        // Now we can check all terminals, not just the active one
        // Get the specific terminal's status
        const terminalStatus = this.terminalStatuses.get(terminalId);
        if (!terminalStatus) {
            // Terminal status not yet initialized
            return false;
        }
        
        // Check if terminal is ready for injection
        const isTerminalReady = !terminalStatus.isRunning && 
                               !terminalStatus.isPrompting && 
                               !terminalStatus.isWaiting &&
                               !terminalData.isWaiting &&
                               !this.gui.isInjecting &&
                               !this.gui.injectionPaused &&
                               !this.gui.injectionBlocked;

        if (!isTerminalReady) {
            // Terminal not ready - reset stability timer
            this.terminalStabilityTimers.delete(terminalId);
            return false;
        }

        // Terminal appears ready - check stability over time
        const now = Date.now();
        const requiredStability = 1000; // 1 second of stability required
        
        if (!this.terminalStabilityTimers.has(terminalId)) {
            // Start stability timer
            this.terminalStabilityTimers.set(terminalId, now);
            return false;
        }
        
        const stabilityStart = this.terminalStabilityTimers.get(terminalId);
        const stabilityDuration = now - stabilityStart;
        
        if (stabilityDuration >= requiredStability) {
            // Terminal has been stable long enough
            return true;
        }
        
        return false;
    }

    // Reset stability timers (called when injection starts)
    resetTerminalStabilityTimers() {
        this.terminalStabilityTimers.clear();
    }

    // Get status summary for all terminals
    getAllTerminalStatuses() {
        const statuses = {};
        this.terminals.forEach((terminalData, terminalId) => {
            const terminalStatus = this.terminalStatuses.get(terminalId);
            statuses[terminalId] = {
                name: terminalData.name,
                isRunning: terminalStatus?.isRunning || false,
                isPrompting: terminalStatus?.isPrompting || false,
                isWaiting: terminalData.isWaiting || false,
                directory: terminalData.directory,
                status: terminalData.status
            };
        });
        return statuses;
    }

    // Check if any terminal is ready for injection
    hasReadyTerminal() {
        for (const terminalId of this.terminals.keys()) {
            if (this.isTerminalStableAndReady(terminalId)) {
                return true;
            }
        }
        return false;
    }

    // Get the best terminal for injection (prioritize active terminal if ready)
    getBestTerminalForInjection() {
        // First check if active terminal is ready
        if (this.gui.activeTerminalId && this.isTerminalStableAndReady(this.gui.activeTerminalId)) {
            return this.gui.activeTerminalId;
        }

        // Otherwise find any ready terminal
        for (const terminalId of this.terminals.keys()) {
            if (this.isTerminalStableAndReady(terminalId)) {
                return terminalId;
            }
        }

        return null;
    }
}

// Export for use in main TerminalGUI class
window.TerminalStatus = TerminalStatus;