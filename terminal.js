/**
 * Core Terminal Module
 * 
 * Centralized terminal data processing functions extracted from TerminalGUI
 * Provides clean interfaces for terminal data reading, status detection, and output processing
 */

class TerminalProcessor {
    constructor() {
        this.usageLimitCooldownUntil = null;
        this.usageLimitTerminals = new Set();
        this.keywordResponseTerminals = new Map();
        this.terminalStatuses = new Map();
        this.pendingUsageLimitReset = null;
    }

    /**
     * Core function for reading terminal data from end with specified parameters
     * @param {string} targetStr - The target string to search for
     * @param {string} startChar - Starting character marker
     * @param {string} endChar - Ending character marker  
     * @param {number} range - Maximum characters to search
     * @returns {string|null} - Extracted data or null if not found
     */
    terminalDataReader(targetStr, startChar, endChar, range = 2000) {
        if (!targetStr || typeof targetStr !== 'string') return null;
        
        // Limit search to specified range from end
        const searchArea = targetStr.slice(-range);
        
        // Find start and end markers
        const startIndex = searchArea.lastIndexOf(startChar);
        if (startIndex === -1) return null;
        
        let endIndex;
        if (endChar) {
            endIndex = searchArea.indexOf(endChar, startIndex + startChar.length);
            if (endIndex === -1) endIndex = searchArea.length;
        } else {
            endIndex = searchArea.length;
        }
        
        return searchArea.substring(startIndex + startChar.length, endIndex);
    }

    /**
     * Extract recent terminal output lines with character limit
     * @param {Object} terminal - Terminal instance with buffer
     * @param {number} maxChars - Maximum characters to extract
     * @returns {string} - Recent terminal output
     */
    extractLastLines(terminal, maxChars = 2000) {
        if (!terminal || !terminal.buffer || !terminal.buffer.active) {
            return '';
        }
        
        try {
            const buffer = terminal.buffer.active;
            const endLine = buffer.baseY + buffer.cursorY;
            const startLine = Math.max(0, endLine - 20);
            
            let output = '';
            for (let i = startLine; i <= endLine; i++) {
                const line = buffer.getLine(i);
                if (line) {
                    output += line.translateToString(true) + '\n';
                }
            }
            
            // Limit to maxChars
            return output.slice(-maxChars);
        } catch (error) {
            console.warn('Error extracting terminal lines:', error);
            return '';
        }
    }

    /**
     * Detect AI usage limit messages in terminal data
     * @param {string} data - Terminal output data
     * @param {string} terminalId - Terminal identifier
     * @param {Object} context - Context object with necessary methods and state
     * @returns {Object} - Detection result with resetTime info
     */
    async detectUsageLimit(data, terminalId, context) {
        const reachedMatch = data.match(/Claude usage limit reached\. Your limit will reset at (\d{1,2})(am|pm)/i);
        if (!reachedMatch) return { detected: false };

        // Check if usage limit detection should be auto-disabled (5 hours after first detection)
        const usageLimitFirstDetected = await context.getSetting('usageLimitFirstDetected');
        const now = Date.now();
        const fiveHoursInMs = 5 * 60 * 60 * 1000; // 5 hours in milliseconds
        
        if (usageLimitFirstDetected) {
            const firstDetectedTime = parseInt(usageLimitFirstDetected);
            const timeSinceFirstDetection = now - firstDetectedTime;
            
            if (timeSinceFirstDetection >= fiveHoursInMs) {
                const hoursElapsed = Math.round(timeSinceFirstDetection / (60 * 60 * 1000) * 10) / 10;
                context.logAction(`Usage limit detection auto-disabled (${hoursElapsed}h elapsed since first detection)`, 'info');
                await context.saveSetting('usageLimitFirstDetected', null);
                return { detected: false, autoDisabled: true };
            }
        } else {
            // First time detecting usage limit - store timestamp
            await context.saveSetting('usageLimitFirstDetected', now.toString());
            context.logAction('Usage limit first detected - auto-disable timer set for 5 hours', 'info');
        }
        
        // Check if we're in cooldown period
        if (this.usageLimitCooldownUntil && Date.now() < this.usageLimitCooldownUntil) {
            const remainingCooldown = Math.round((this.usageLimitCooldownUntil - Date.now()) / 1000 / 60);
            context.logAction(`Usage limit detected but ignored due to cooldown (${remainingCooldown} minutes remaining)`, 'info');
            return { detected: false, inCooldown: true };
        }

        const resetHour = parseInt(reachedMatch[1]);
        const ampm = reachedMatch[2].toLowerCase();
        
        // Track terminal and prepare reset info
        this.usageLimitTerminals.add(terminalId);
        this.pendingUsageLimitReset = { resetHour, ampm };
        
        context.logAction(`Usage limit detected in Terminal ${terminalId} - tracking for continue targeting`, 'info');
        
        return {
            detected: true,
            resetHour,
            ampm,
            resetTimeString: `${resetHour}${ampm}`,
            terminalId
        };
    }

    /**
     * Detect if terminal is in a prompt state requiring user input
     * @param {string} terminalData - Terminal output data
     * @returns {Object} - Prompt detection result
     */
    detectPromptState(terminalData) {
        if (!terminalData || typeof terminalData !== 'string') {
            return { isPrompting: false };
        }

        // Enhanced prompt detection patterns
        const promptPatterns = [
            'No, and tell Claude what to do differently',
            'No, keep planning',
            /\b[yY]\/[nN]\b/,
            /\b[nN]\/[yY]\b/,
            /Do you want to proceed\?/i,
            /Continue\?/i,
            /\?\s*$/,
            'Do you trust the files in this folder?'
        ];

        for (const pattern of promptPatterns) {
            if (typeof pattern === 'string') {
                if (terminalData.includes(pattern)) {
                    return { 
                        isPrompting: true, 
                        promptType: pattern,
                        isClaudePrompt: pattern.includes('Claude') || pattern.includes('planning')
                    };
                }
            } else if (pattern instanceof RegExp) {
                if (pattern.test(terminalData)) {
                    return { 
                        isPrompting: true, 
                        promptType: pattern.toString(),
                        isClaudePrompt: false
                    };
                }
            }
        }

        return { isPrompting: false };
    }

    /**
     * Parse current terminal status from output data
     * @param {string} terminalData - Terminal output data
     * @returns {Object} - Parsed status information
     */
    parseTerminalStatus(terminalData) {
        if (!terminalData || typeof terminalData !== 'string') {
            return { 
                isRunning: false, 
                isPrompting: false, 
                status: 'ready',
                lastUpdate: Date.now()
            };
        }

        // Check for running state indicators
        const runningPatterns = [
            'esc to interrupt',
            '(esc to interrupt)',
            'ESC to interrupt',
            'offline)'
        ];

        const isRunning = runningPatterns.some(pattern => 
            terminalData.includes(pattern)
        );

        // Check for prompting state
        const promptResult = this.detectPromptState(terminalData);
        const isPrompting = promptResult.isPrompting;

        // Determine overall status
        let status = 'ready';
        if (isRunning) {
            status = 'running';
        } else if (isPrompting) {
            status = 'prompting';
        }

        return {
            isRunning,
            isPrompting,
            status,
            promptType: promptResult.promptType,
            isClaudePrompt: promptResult.isClaudePrompt,
            lastUpdate: Date.now()
        };
    }

    /**
     * Check terminal output for keyword blocking rules
     * @param {string} terminalOutput - Terminal output to check
     * @param {Array} keywordRules - Array of keyword rules
     * @returns {Object} - Keyword check result
     */
    checkTerminalForKeywords(terminalOutput, keywordRules) {
        // Validate inputs
        if (!keywordRules || keywordRules.length === 0) {
            return { blocked: false };
        }
        
        if (!terminalOutput || terminalOutput.trim() === '') {
            return { blocked: false };
        }
        
        // Find Claude prompt area marked by ╭ character
        const claudePromptStart = terminalOutput.lastIndexOf("╭");
        let searchArea;
        
        if (claudePromptStart === -1) {
            // Fallback: check last 1000 characters if no ╭ found
            searchArea = terminalOutput.slice(-1000);
            const hasClaudePrompt = searchArea.includes("No, and tell Claude what to do differently");
            if (!hasClaudePrompt) {
                return { blocked: false };
            }
        } else {
            // Extract current Claude prompt area (from ╭ to end)
            searchArea = terminalOutput.substring(claudePromptStart);
        }
        
        // Check each keyword rule against the search area
        for (const rule of keywordRules) {
            if (!rule.keyword || rule.keyword.trim() === '') continue;
            
            const keywordLower = rule.keyword.toLowerCase().trim();
            const searchAreaLower = searchArea.toLowerCase();
            
            if (searchAreaLower.includes(keywordLower)) {
                return {
                    blocked: true,
                    keyword: rule.keyword,
                    response: rule.response || null,
                    searchArea: claudePromptStart === -1 ? 'fallback' : 'prompt'
                };
            }
        }
        
        return { blocked: false };
    }

    /**
     * Update terminal output buffer with clearing detection
     * @param {string} currentOutput - Current output buffer
     * @param {string} newData - New data to append
     * @returns {string} - Updated output buffer
     */
    updateTerminalOutput(currentOutput, newData) {
        // Detect if terminal was cleared
        const clearPatterns = ['\x1b[2J', '\x1b[H\x1b[2J', '\x1b[3J'];
        const wasCleared = clearPatterns.some(pattern => newData.includes(pattern));
        
        if (wasCleared) {
            // Terminal was cleared, reset the output buffer
            return newData;
        }
        
        // Add new data to existing output
        let updatedOutput = currentOutput + newData;
        
        // Keep only recent output (last 5000 characters) for safety
        if (updatedOutput.length > 5000) {
            updatedOutput = updatedOutput.slice(-5000);
        }
        
        return updatedOutput;
    }

    /**
     * Scan individual terminal status with comprehensive detection
     * @param {string} terminalId - Terminal identifier
     * @param {Object} terminalData - Terminal data object
     * @returns {Object} - Status scan result
     */
    scanSingleTerminalStatus(terminalId, terminalData) {
        // Get recent terminal output from multiple sources
        let recentOutput = '';
        
        if (terminalData.terminal && terminalData.terminal.buffer) {
            recentOutput = this.extractLastLines(terminalData.terminal, 2000);
        } else {
            // Fallback to terminalData.lastOutput
            recentOutput = (terminalData.lastOutput || '').slice(-2000);
        }
        
        // Parse status from terminal output
        const statusInfo = this.parseTerminalStatus(recentOutput);
        
        // Get current cached status for comparison
        const currentStatus = this.terminalStatuses.get(terminalId) || {
            isRunning: false,
            isPrompting: false,
            lastUpdate: Date.now()
        };
        
        // Check if status changed
        const statusChanged = (
            currentStatus.isRunning !== statusInfo.isRunning || 
            currentStatus.isPrompting !== statusInfo.isPrompting
        );
        
        // Update cached status
        this.terminalStatuses.set(terminalId, statusInfo);
        
        return {
            terminalId,
            statusInfo,
            statusChanged,
            previousStatus: currentStatus,
            recentOutput
        };
    }

    /**
     * Get current cached status for a terminal
     * @param {string} terminalId - Terminal identifier
     * @returns {Object} - Current status or default
     */
    getCachedTerminalStatus(terminalId) {
        return this.terminalStatuses.get(terminalId) || {
            isRunning: false,
            isPrompting: false,
            status: 'ready',
            lastUpdate: Date.now()
        };
    }

    /**
     * Clear cached status for a terminal (when terminal is closed)
     * @param {string} terminalId - Terminal identifier
     */
    clearTerminalStatus(terminalId) {
        this.terminalStatuses.delete(terminalId);
        this.usageLimitTerminals.delete(terminalId);
        this.keywordResponseTerminals.delete(terminalId);
    }

    /**
     * Get all terminals with usage limits detected
     * @returns {Set} - Set of terminal IDs with usage limits
     */
    getUsageLimitTerminals() {
        return new Set(this.usageLimitTerminals);
    }

    /**
     * Reset usage limit cooldown
     */
    resetUsageLimitCooldown() {
        this.usageLimitCooldownUntil = null;
        this.usageLimitTerminals.clear();
    }

    /**
     * Set usage limit cooldown period
     * @param {number} minutes - Cooldown period in minutes
     */
    setUsageLimitCooldown(minutes) {
        this.usageLimitCooldownUntil = Date.now() + (minutes * 60 * 1000);
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TerminalProcessor;
} else if (typeof window !== 'undefined') {
    window.TerminalProcessor = TerminalProcessor;
}