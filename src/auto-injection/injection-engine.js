/**
 * Injection Engine Module
 * Handles automated message injection, safety checks, and terminal assignment
 */

class InjectionEngine {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        
        // Injection state
        this.isInjecting = false;
        this.injectionInProgress = false;
        this.injectionPaused = false;
        this.injectionBlocked = false;
        this.injectionCount = 0;
        
        // Current injection tracking
        this.currentlyInjectingMessages = new Set();
        this.currentlyInjectingTerminals = new Set();
        this.currentlyInjectingMessageId = null;
        
        // Paused state
        this.pausedMessageContent = null;
        this.pausedMessageIndex = 0;
        this.currentTypeInterval = null;
        
        // Auto-continue functionality
        this.autoContinueEnabled = false;
        this.autoContinueActive = false;
        this.autoContinueRetryCount = 0;
        
        // Keyword blocking
        this.keywordBlockingActive = false;
        this.trustPromptActive = false;
        
        // Safety checking
        this.safetyCheckCount = 0;
        this.safetyCheckInterval = null;
    }

    // Initialize from preferences
    initializeFromPreferences(preferences) {
        this.autoContinueEnabled = preferences.autoContinueEnabled || false;
    }

    // Main injection validation and state management
    validateInjectionState(caller) {
        if (!this.gui.terminals || this.gui.terminals.size === 0) {
            console.warn(`${caller}: No terminals available`);
            return false;
        }
        
        if (this.isInjecting) {
            console.warn(`${caller}: Already injecting`);
            return false;
        }
        
        if (this.injectionBlocked) {
            console.warn(`${caller}: Injection blocked`);
            return false;
        }
        
        return true;
    }

    // Process a single message for injection
    async processMessage(message) {
        if (!message) {
            console.warn('No message provided for processing');
            return false;
        }

        // Validate injection state
        if (!this.validateInjectionState('processMessage')) {
            return false;
        }

        // Determine target terminal
        const terminalId = message.terminalId != null ? message.terminalId : this.gui.activeTerminalId;
        
        if (!this.gui.terminals.has(terminalId)) {
            this.gui.logAction(`Terminal ${terminalId} not found for message injection`, 'error');
            return false;
        }

        // Check if terminal is ready
        if (!this.gui.terminalStatus.isTerminalStableAndReady(terminalId)) {
            this.gui.logAction(`Terminal ${terminalId} not ready for injection`, 'warning');
            return false;
        }

        // Mark terminal as busy
        this.currentlyInjectingTerminals.add(terminalId);
        this.currentlyInjectingMessages.add(message.id);
        this.currentlyInjectingMessageId = message.id;
        this.isInjecting = true;

        try {
            // Remove message from queue
            const messageIndex = this.gui.messageQueue.findIndex(m => m.id === message.id);
            if (messageIndex !== -1) {
                this.gui.messageQueue.splice(messageIndex, 1);
                this.gui.messageQueue.saveMessageQueue();
            }

            // Update UI
            this.gui.updateTerminalStatusIndicator();
            this.gui.updateMessageList();

            // Log injection start
            const terminalData = this.gui.terminals.get(terminalId);
            const terminalName = terminalData ? terminalData.name : `Terminal ${terminalId}`;
            this.gui.logAction(`Injecting message to ${terminalName}: "${message.content}"`, 'success');

            // Switch to target terminal if needed
            if (terminalId !== this.gui.activeTerminalId) {
                this.gui.terminalManager.switchToTerminal(terminalId);
            }

            // Type the message
            const success = await this.typeMessageToTerminal(message.processedContent, terminalId);
            
            if (success) {
                // Send Enter key
                await this.sendEnterKey(terminalId);
                
                // Update injection count and save to history
                this.injectionCount++;
                this.gui.messageQueue.saveToMessageHistory(message);
                this.gui.updateStatusDisplay();
                
                this.gui.logAction(`Message injected successfully: "${message.content}"`, 'success');
                
                // Post-injection delay
                await this.waitForDelay(this.getRandomDelay(500, 800));
                
                return true;
            } else {
                this.gui.logAction(`Failed to inject message: "${message.content}"`, 'error');
                return false;
            }
        } catch (error) {
            console.error('Error processing message:', error);
            this.gui.logAction(`Error injecting message: ${error.message}`, 'error');
            return false;
        } finally {
            // Clean up injection state
            this.currentlyInjectingTerminals.delete(terminalId);
            this.currentlyInjectingMessages.delete(message.id);
            this.currentlyInjectingMessageId = null;
            this.isInjecting = false;
            
            // Update UI
            this.gui.updateTerminalStatusIndicator();
            this.gui.updateMessageList();
        }
    }

    // Type message to specific terminal
    async typeMessageToTerminal(content, terminalId) {
        return new Promise((resolve) => {
            if (!content || content.length === 0) {
                resolve(false);
                return;
            }

            let index = 0;
            const typeChar = () => {
                if (index >= content.length) {
                    resolve(true);
                    return;
                }

                const char = content[index];
                
                // Send character to terminal
                const { ipcRenderer } = require('electron');
                ipcRenderer.send('terminal-input', { 
                    terminalId: terminalId, 
                    data: char 
                });

                index++;
                
                // Random delay between characters for realistic typing
                const delay = this.getRandomDelay(30, 80);
                this.currentTypeInterval = setTimeout(typeChar, delay);
            };

            typeChar();
        });
    }

    // Send Enter key to terminal
    async sendEnterKey(terminalId) {
        const delay = this.getRandomDelay(150, 300);
        await this.waitForDelay(delay);
        
        const { ipcRenderer } = require('electron');
        ipcRenderer.send('terminal-input', { 
            terminalId: terminalId, 
            data: '\r' 
        });
    }

    // Safety checks before injection
    async performSafetyChecks(callback) {
        this.safetyCheckCount = 0;
        
        const runSafetyCheck = () => {
            this.safetyCheckCount++;
            
            // Check if terminal is ready
            const hasReadyTerminal = this.gui.terminalStatus.hasReadyTerminal();
            
            if (hasReadyTerminal) {
                // Terminal is ready, proceed with injection
                if (this.safetyCheckInterval) {
                    clearInterval(this.safetyCheckInterval);
                    this.safetyCheckInterval = null;
                }
                
                this.gui.logAction(`Safety checks passed after ${this.safetyCheckCount} attempts`, 'success');
                callback();
                return;
            }
            
            // Check if we've exceeded retry limit
            if (this.safetyCheckCount >= 30) { // 30 seconds timeout
                if (this.safetyCheckInterval) {
                    clearInterval(this.safetyCheckInterval);
                    this.safetyCheckInterval = null;
                }
                
                this.gui.logAction('Safety checks failed: Terminal not ready after 30 seconds', 'error');
                return;
            }
            
            // Log progress every 5 attempts
            if (this.safetyCheckCount % 5 === 0) {
                this.gui.logAction(`Waiting for terminal to be ready... (${this.safetyCheckCount}/30)`, 'info');
            }
        };
        
        // Start safety check interval
        this.safetyCheckInterval = setInterval(runSafetyCheck, 1000);
        runSafetyCheck(); // Run immediately
    }

    // Manual injection functions
    performManualInjection() {
        if (this.gui.messageQueue.length === 0) {
            this.gui.logAction('No messages in queue to inject', 'warning');
            return false;
        }
        
        // Get active terminal or best available terminal
        const terminalId = this.gui.terminalStatus.getBestTerminalForInjection();
        if (!terminalId) {
            this.gui.logAction('No ready terminal available for injection', 'error');
            return false;
        }
        
        // Get next message
        const message = this.gui.messageQueue.getNextMessage();
        if (!message) {
            this.gui.logAction('No message available for injection', 'error');
            return false;
        }
        
        // Perform safety checks
        this.performSafetyChecks(() => {
            this.processMessage(message);
        });
        
        return true;
    }

    manualInjectNextMessage() {
        return this.performManualInjection();
    }

    // Injection control
    pauseInjectionExecution() {
        if (this.currentTypeInterval) {
            clearTimeout(this.currentTypeInterval);
            this.currentTypeInterval = null;
        }
        
        this.injectionPaused = true;
        this.gui.logAction('Injection execution paused', 'info');
        
        return true;
    }

    resumeInjectionExecution() {
        this.injectionPaused = false;
        this.gui.logAction('Injection execution resumed', 'info');
        
        // Resume typing if we were in the middle of typing
        if (this.pausedMessageContent && this.pausedMessageIndex > 0) {
            this.continueTypingFromPause();
        }
        
        return true;
    }

    continueTypingFromPause() {
        if (!this.pausedMessageContent || this.pausedMessageIndex >= this.pausedMessageContent.length) {
            return;
        }
        
        const remainingContent = this.pausedMessageContent.substring(this.pausedMessageIndex);
        const terminalId = this.gui.activeTerminalId;
        
        this.typeMessageToTerminal(remainingContent, terminalId);
    }

    cancelSequentialInjection() {
        // Stop timer if active
        if (this.gui.timerManager && this.gui.timerManager.isTimerActive()) {
            this.gui.timerManager.stopTimer();
        }
        
        // Clear injection intervals
        if (this.currentTypeInterval) {
            clearTimeout(this.currentTypeInterval);
            this.currentTypeInterval = null;
        }
        
        // Reset injection state
        this.isInjecting = false;
        this.injectionInProgress = false;
        this.injectionPaused = false;
        this.injectionBlocked = false;
        
        // Clear tracking sets
        this.currentlyInjectingMessages.clear();
        this.currentlyInjectingTerminals.clear();
        this.currentlyInjectingMessageId = null;
        
        // Reset paused state
        this.pausedMessageContent = null;
        this.pausedMessageIndex = 0;
        
        // Update UI
        this.gui.updateTerminalStatusIndicator();
        this.gui.updateMessageList();
        this.gui.updateStatusDisplay();
        
        this.gui.logAction('Sequential injection cancelled', 'warning');
        
        return true;
    }

    forceResetInjectionState() {
        this.cancelSequentialInjection();
        
        // Additional cleanup
        if (this.safetyCheckInterval) {
            clearInterval(this.safetyCheckInterval);
            this.safetyCheckInterval = null;
        }
        
        this.safetyCheckCount = 0;
        this.autoContinueActive = false;
        this.autoContinueRetryCount = 0;
        this.keywordBlockingActive = false;
        this.trustPromptActive = false;
        
        this.gui.logAction('Injection state force reset', 'warning');
        
        return true;
    }

    // Auto-continue functionality
    detectAutoContinuePrompt(terminalOutput, terminalId = null) {
        if (!this.autoContinueEnabled || this.autoContinueActive) {
            return false;
        }
        
        const sourceTerminalId = terminalId || this.gui.activeTerminalId;
        
        // Look for the ╭ character in the terminal output
        const cornerCharIndex = terminalOutput.indexOf('╭');
        if (cornerCharIndex === -1) {
            return false;
        }
        
        // Extract text from the ╭ character to the end
        const textFromCorner = terminalOutput.substring(cornerCharIndex);
        
        // Check if this text contains any keywords from settings
        if (this.gui.settingsManager) {
            const keywordResult = this.gui.settingsManager.checkForKeywordBlocking(textFromCorner);
            if (keywordResult) {
                // Keyword found - don't auto-continue, let keyword blocking handle it
                this.gui.logAction(`Auto-continue skipped for terminal ${sourceTerminalId}: keyword "${keywordResult.keyword}" detected`, 'info');
                return false;
            }
        }
        
        // Also check for the traditional Claude auto-continue prompt
        const autoContinuePattern = /No, and tell Claude what to do differently/i;
        
        if (autoContinuePattern.test(textFromCorner)) {
            this.autoContinueActive = true;
            this.performAutoContinue(sourceTerminalId);
            return true;
        }
        
        return false;
    }

    async performAutoContinue(terminalId) {
        if (!this.autoContinueEnabled) return;
        
        try {
            this.gui.logAction(`Auto-continue triggered for terminal ${terminalId}`, 'info');
            
            // Wait a moment for the prompt to stabilize
            await this.waitForDelay(1000);
            
            // Send "y" for yes to continue
            const { ipcRenderer } = require('electron');
            ipcRenderer.send('terminal-input', { 
                terminalId: terminalId, 
                data: 'y' 
            });
            
            // Send Enter
            await this.waitForDelay(200);
            ipcRenderer.send('terminal-input', { 
                terminalId: terminalId, 
                data: '\r' 
            });
            
            this.gui.logAction('Auto-continue response sent', 'success');
            
            // Reset auto-continue state after a delay
            setTimeout(() => {
                this.autoContinueActive = false;
            }, 5000);
            
        } catch (error) {
            console.error('Error in auto-continue:', error);
            this.gui.logAction(`Auto-continue failed: ${error.message}`, 'error');
            this.autoContinueActive = false;
        }
    }

    // Usage limit detection functionality
    checkForUsageLimitMessages(terminalOutput, terminalId = null) {
        const sourceTerminalId = terminalId || this.gui.activeTerminalId;
        
        // Common patterns for Claude usage limit messages
        const usageLimitPatterns = [
            /usage limit.*reached/i,
            /rate limit.*exceeded/i,
            /too many requests/i,
            /limit.*exceeded/i,
            /quota.*reached/i,
            /wait.*before.*continue/i
        ];
        
        const hasUsageLimit = usageLimitPatterns.some(pattern => pattern.test(terminalOutput));
        
        if (hasUsageLimit && this.gui.timerManager) {
            this.gui.timerManager.markTerminalWithUsageLimit(sourceTerminalId);
            
            const terminalData = this.gui.terminals.get(sourceTerminalId);
            const terminalName = terminalData ? terminalData.name : `Terminal ${sourceTerminalId}`;
            this.gui.logAction(`Usage limit detected on ${terminalName} - terminal marked for continue message`, 'warning');
            return true;
        }
        
        return false;
    }

    // Keyword blocking functionality
    checkTerminalForKeywords(terminalOutput, terminalId = null) {
        if (!this.gui.settingsManager) return null;
        
        const sourceTerminalId = terminalId || this.gui.activeTerminalId;
        
        // Check for usage limit messages first
        this.checkForUsageLimitMessages(terminalOutput, sourceTerminalId);
        
        const blockingResult = this.gui.settingsManager.checkForKeywordBlocking(terminalOutput);
        if (blockingResult) {
            this.handleKeywordBlocking(blockingResult, sourceTerminalId);
            return blockingResult;
        }
        
        return null;
    }

    handleKeywordBlocking(blockingResult, terminalId) {
        this.keywordBlockingActive = true;
        this.injectionBlocked = true;
        
        const terminalData = this.gui.terminals.get(terminalId);
        const terminalName = terminalData ? terminalData.name : `Terminal ${terminalId}`;
        
        this.gui.logAction(`Keyword blocking activated on ${terminalName}: "${blockingResult.keyword}" → "${blockingResult.response}"`, 'warning');
        
        // Auto-inject the response to the specific terminal that triggered the keyword
        setTimeout(() => {
            const { ipcRenderer } = require('electron');
            ipcRenderer.send('terminal-input', { 
                terminalId: terminalId, 
                data: blockingResult.response 
            });
            
            // Send Enter
            setTimeout(() => {
                ipcRenderer.send('terminal-input', { 
                    terminalId: terminalId, 
                    data: '\r' 
                });
                
                // Reset blocking after a delay
                setTimeout(() => {
                    this.keywordBlockingActive = false;
                    this.injectionBlocked = false;
                    this.gui.logAction(`Keyword blocking cleared for ${terminalName}`, 'info');
                }, 2000);
            }, 200);
        }, 500);
    }

    // Utility functions
    getRandomDelay(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    waitForDelay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // State getters
    getInjectionState() {
        return {
            isInjecting: this.isInjecting,
            injectionInProgress: this.injectionInProgress,
            injectionPaused: this.injectionPaused,
            injectionBlocked: this.injectionBlocked,
            injectionCount: this.injectionCount,
            currentlyInjectingMessages: Array.from(this.currentlyInjectingMessages),
            currentlyInjectingTerminals: Array.from(this.currentlyInjectingTerminals),
            autoContinueActive: this.autoContinueActive,
            keywordBlockingActive: this.keywordBlockingActive
        };
    }

    // Event handlers for injection completion
    onAutoInjectionComplete() {
        this.gui.logAction('Auto-injection sequence completed', 'success');
        
        // Show completion notification if enabled
        if (this.gui.preferences.showSystemNotifications) {
            const { ipcRenderer } = require('electron');
            ipcRenderer.invoke('show-notification', 
                'Injection Complete', 
                `${this.injectionCount} messages injected successfully`
            );
        }
        
        // Play completion sound if enabled
        if (this.gui.preferences.completionSoundEnabled) {
            this.gui.playCompletionSound();
        }
    }

    // Cleanup
    destroy() {
        this.cancelSequentialInjection();
        
        if (this.safetyCheckInterval) {
            clearInterval(this.safetyCheckInterval);
            this.safetyCheckInterval = null;
        }
    }
}

// Export for use in main TerminalGUI class
window.InjectionEngine = InjectionEngine;