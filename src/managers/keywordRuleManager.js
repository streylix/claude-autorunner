/**
 * Keyword Rule Manager Module
 * 
 * Handles keyword blocking rules for auto-continue functionality
 * Provides rule management, keyword detection, and UI control
 */

class KeywordRuleManager {
    constructor(logAction, settingsManager) {
        this.logAction = logAction || console.log;
        this.settingsManager = settingsManager;
        this.keywordRules = [];
        this.isInitialized = false;
    }

    /**
     * Initialize keyword rule manager
     */
    async initialize() {
        if (this.isInitialized) return;

        try {
            await this.loadKeywordRules();
            this.setupKeywordEventListeners();
            this.updateKeywordRulesDisplay();
            this.isInitialized = true;
            this.logAction('Keyword rule manager initialized', 'info');
        } catch (error) {
            this.logAction(`Failed to initialize keyword rules: ${error.message}`, 'error');
        }
    }

    /**
     * Load keyword rules from settings
     */
    async loadKeywordRules() {
        if (this.settingsManager) {
            this.keywordRules = this.settingsManager.preferences.keywordRules || [];
        } else {
            // Fallback to direct database access
            try {
                const { ipcRenderer } = require('electron');
                this.keywordRules = await ipcRenderer.invoke('db-get-setting', 'keywordRules') || [];
            } catch (error) {
                this.logAction(`Failed to load keyword rules: ${error.message}`, 'error');
                this.keywordRules = [];
            }
        }
    }

    /**
     * Save keyword rules to settings
     */
    async saveKeywordRules() {
        try {
            if (this.settingsManager) {
                await this.settingsManager.saveSetting('keywordRules', this.keywordRules);
            } else {
                // Fallback to direct database access
                const { ipcRenderer } = require('electron');
                await ipcRenderer.invoke('db-save-setting', 'keywordRules', this.keywordRules);
            }
            this.logAction('Keyword rules saved', 'info');
        } catch (error) {
            this.logAction(`Failed to save keyword rules: ${error.message}`, 'error');
        }
    }

    /**
     * Setup event listeners for keyword rule interface
     */
    setupKeywordEventListeners() {
        // Add keyword button
        const addKeywordBtn = document.getElementById('add-keyword-btn');
        if (addKeywordBtn) {
            addKeywordBtn.addEventListener('click', () => this.addKeywordRule());
        }

        // Keyword input Enter key
        const keywordInput = document.getElementById('keyword-input');
        if (keywordInput) {
            keywordInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.addKeywordRule();
                }
            });
        }

        // Response input Enter key  
        const responseInput = document.getElementById('response-input');
        if (responseInput) {
            responseInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.addKeywordRule();
                }
            });
        }
    }

    /**
     * Add new keyword rule
     */
    async addKeywordRule() {
        const keywordInput = document.getElementById('keyword-input');
        const responseInput = document.getElementById('response-input');
        
        if (!keywordInput) {
            this.logAction('Keyword input not found', 'error');
            return;
        }

        const keyword = keywordInput.value.trim();
        if (!keyword) {
            this.logAction('Please enter a keyword', 'warning');
            return;
        }

        // Check for duplicate keywords
        const existingRule = this.keywordRules.find(rule => 
            rule.keyword.toLowerCase() === keyword.toLowerCase()
        );
        
        if (existingRule) {
            this.logAction(`Keyword "${keyword}" already exists`, 'warning');
            return;
        }

        const response = responseInput ? responseInput.value.trim() : '';
        
        const rule = {
            id: Date.now() + Math.random(), // Unique ID
            keyword: keyword,
            response: response || null,
            created: new Date().toISOString(),
            timesTriggered: 0
        };

        this.keywordRules.push(rule);
        await this.saveKeywordRules();
        
        // Clear inputs
        keywordInput.value = '';
        if (responseInput) {
            responseInput.value = '';
        }

        this.updateKeywordRulesDisplay();
        this.logAction(`Added keyword rule: "${keyword}"${response ? ` with response: "${response}"` : ''}`, 'success');
    }

    /**
     * Remove keyword rule by ID
     * @param {string|number} ruleId - Rule ID to remove
     */
    async removeKeywordRule(ruleId) {
        const initialLength = this.keywordRules.length;
        this.keywordRules = this.keywordRules.filter(rule => rule.id !== ruleId);
        
        if (this.keywordRules.length < initialLength) {
            await this.saveKeywordRules();
            this.updateKeywordRulesDisplay();
            this.logAction('Keyword rule removed', 'info');
        } else {
            this.logAction('Keyword rule not found', 'warning');
        }
    }

    /**
     * Update keyword rule
     * @param {string|number} ruleId - Rule ID to update
     * @param {Object} updates - Updates to apply
     */
    async updateKeywordRule(ruleId, updates) {
        const rule = this.keywordRules.find(r => r.id === ruleId);
        if (!rule) {
            this.logAction('Keyword rule not found for update', 'warning');
            return;
        }

        Object.assign(rule, updates);
        await this.saveKeywordRules();
        this.updateKeywordRulesDisplay();
        this.logAction(`Updated keyword rule: "${rule.keyword}"`, 'info');
    }

    /**
     * Update the keyword rules display in UI
     */
    updateKeywordRulesDisplay() {
        const keywordList = document.getElementById('keyword-list');
        if (!keywordList) return;

        keywordList.innerHTML = '';

        if (this.keywordRules.length === 0) {
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'empty-state';
            emptyMessage.textContent = 'No keyword rules defined. Add keywords to block auto-continue on specific prompts.';
            keywordList.appendChild(emptyMessage);
            return;
        }

        this.keywordRules.forEach(rule => {
            const ruleElement = this.createKeywordRuleElement(rule);
            keywordList.appendChild(ruleElement);
        });

        this.logAction(`Displaying ${this.keywordRules.length} keyword rules`, 'info');
    }

    /**
     * Create keyword rule element for display
     * @param {Object} rule - Keyword rule object
     * @returns {HTMLElement} - DOM element for the rule
     */
    createKeywordRuleElement(rule) {
        const ruleDiv = document.createElement('div');
        ruleDiv.className = 'keyword-rule';
        ruleDiv.dataset.ruleId = rule.id;

        const keywordSpan = document.createElement('span');
        keywordSpan.className = 'keyword-text';
        keywordSpan.textContent = rule.keyword;

        const responseSpan = document.createElement('span');
        responseSpan.className = 'keyword-response';
        responseSpan.textContent = rule.response || '(Escape only)';

        const statsSpan = document.createElement('span');
        statsSpan.className = 'keyword-stats';
        statsSpan.textContent = `Triggered: ${rule.timesTriggered || 0} times`;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-keyword-btn';
        removeBtn.textContent = '×';
        removeBtn.title = 'Remove keyword rule';
        removeBtn.addEventListener('click', () => {
            this.removeKeywordRule(rule.id);
        });

        const editBtn = document.createElement('button');
        editBtn.className = 'edit-keyword-btn';
        editBtn.textContent = '✎';
        editBtn.title = 'Edit keyword rule';
        editBtn.addEventListener('click', () => {
            this.editKeywordRule(rule);
        });

        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'keyword-actions';
        actionsDiv.appendChild(editBtn);
        actionsDiv.appendChild(removeBtn);

        ruleDiv.appendChild(keywordSpan);
        ruleDiv.appendChild(responseSpan);
        ruleDiv.appendChild(statsSpan);
        ruleDiv.appendChild(actionsDiv);

        return ruleDiv;
    }

    /**
     * Edit keyword rule inline
     * @param {Object} rule - Rule to edit
     */
    editKeywordRule(rule) {
        const ruleElement = document.querySelector(`[data-rule-id="${rule.id}"]`);
        if (!ruleElement) return;

        // Create edit form
        const editForm = document.createElement('div');
        editForm.className = 'keyword-edit-form';

        const keywordInput = document.createElement('input');
        keywordInput.type = 'text';
        keywordInput.value = rule.keyword;
        keywordInput.placeholder = 'Keyword';

        const responseInput = document.createElement('input');
        responseInput.type = 'text';
        responseInput.value = rule.response || '';
        responseInput.placeholder = 'Custom response (optional)';

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', async () => {
            const newKeyword = keywordInput.value.trim();
            const newResponse = responseInput.value.trim();

            if (!newKeyword) {
                this.logAction('Keyword cannot be empty', 'warning');
                return;
            }

            await this.updateKeywordRule(rule.id, {
                keyword: newKeyword,
                response: newResponse || null
            });
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            this.updateKeywordRulesDisplay();
        });

        editForm.appendChild(keywordInput);
        editForm.appendChild(responseInput);
        editForm.appendChild(saveBtn);
        editForm.appendChild(cancelBtn);

        ruleElement.innerHTML = '';
        ruleElement.appendChild(editForm);
    }

    /**
     * Check terminal output for keyword matches
     * @param {string} terminalOutput - Terminal output to check
     * @returns {Object} - Keyword check result
     */
    checkTerminalForKeywords(terminalOutput) {
        // Validate inputs
        if (!this.keywordRules || this.keywordRules.length === 0) {
            return { blocked: false };
        }
        
        if (!terminalOutput || terminalOutput.trim() === '') {
            return { blocked: false };
        }
        
        // Clean terminal output of ANSI codes for better matching
        const cleanOutput = this.stripAnsiCodes(terminalOutput);
        
        // Find Claude prompt area marked by ╭ character
        const claudePromptStart = cleanOutput.lastIndexOf("╭");
        let searchArea;
        
        if (claudePromptStart === -1) {
            // Fallback: check last 1000 characters if no ╭ found
            searchArea = cleanOutput.slice(-1000);
            const hasClaudePrompt = searchArea.includes("No, and tell Claude what to do differently");
            if (!hasClaudePrompt) {
                return { blocked: false };
            }
        } else {
            // Extract current Claude prompt area (from ╭ to end)
            searchArea = cleanOutput.substring(claudePromptStart);
        }
        
        // Check each keyword rule against the search area
        for (const rule of this.keywordRules) {
            if (!rule.keyword || rule.keyword.trim() === '') continue;
            
            const keywordLower = rule.keyword.toLowerCase().trim();
            const searchAreaLower = searchArea.toLowerCase();
            
            if (searchAreaLower.includes(keywordLower)) {
                // Increment trigger count
                rule.timesTriggered = (rule.timesTriggered || 0) + 1;
                this.saveKeywordRules(); // Save updated stats
                
                this.logAction(`Keyword "${rule.keyword}" matched in Claude prompt area`, 'info');
                
                return {
                    blocked: true,
                    keyword: rule.keyword,
                    response: rule.response || null,
                    searchArea: claudePromptStart === -1 ? 'fallback' : 'prompt',
                    ruleId: rule.id
                };
            }
        }
        
        return { blocked: false };
    }

    /**
     * Check for keyword blocking across all terminals
     * @param {Function} getTerminalOutputs - Function to get all terminal outputs
     * @returns {Array} - Array of blocked terminals
     */
    checkForKeywordBlocking(getTerminalOutputs) {
        if (typeof getTerminalOutputs !== 'function') {
            return [];
        }

        const terminalOutputs = getTerminalOutputs();
        const blockedTerminals = [];

        Object.entries(terminalOutputs).forEach(([terminalId, output]) => {
            const result = this.checkTerminalForKeywords(output);
            if (result.blocked) {
                blockedTerminals.push({
                    terminalId,
                    keyword: result.keyword,
                    response: result.response,
                    ruleId: result.ruleId
                });
            }
        });

        return blockedTerminals;
    }

    /**
     * Strip ANSI escape codes from text
     * @param {string} text - Text with ANSI codes
     * @returns {string} - Clean text without ANSI codes
     */
    stripAnsiCodes(text) {
        // Remove ANSI escape sequences
        return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    }

    /**
     * Import keyword rules from JSON
     * @param {string} jsonData - JSON string of rules
     * @returns {boolean} - Success status
     */
    async importKeywordRules(jsonData) {
        try {
            const importedRules = JSON.parse(jsonData);
            if (!Array.isArray(importedRules)) {
                throw new Error('Invalid format: expected array of rules');
            }

            // Validate rule structure
            const validRules = importedRules.filter(rule => 
                rule && typeof rule.keyword === 'string' && rule.keyword.trim()
            ).map(rule => ({
                id: Date.now() + Math.random(),
                keyword: rule.keyword.trim(),
                response: rule.response || null,
                created: new Date().toISOString(),
                timesTriggered: rule.timesTriggered || 0
            }));

            this.keywordRules = validRules;
            await this.saveKeywordRules();
            this.updateKeywordRulesDisplay();
            
            this.logAction(`Imported ${validRules.length} keyword rules`, 'success');
            return true;
        } catch (error) {
            this.logAction(`Failed to import keyword rules: ${error.message}`, 'error');
            return false;
        }
    }

    /**
     * Export keyword rules as JSON
     * @returns {string} - JSON string of rules
     */
    exportKeywordRules() {
        return JSON.stringify(this.keywordRules, null, 2);
    }

    /**
     * Clear all keyword rules
     */
    async clearAllKeywordRules() {
        const confirmed = confirm(`Are you sure you want to clear all ${this.keywordRules.length} keyword rules? This cannot be undone.`);
        if (!confirmed) return false;

        this.keywordRules = [];
        await this.saveKeywordRules();
        this.updateKeywordRulesDisplay();
        this.logAction('All keyword rules cleared', 'info');
        return true;
    }

    /**
     * Get keyword rule statistics
     * @returns {Object} - Statistics about keyword rules
     */
    getKeywordStats() {
        const totalRules = this.keywordRules.length;
        const totalTriggers = this.keywordRules.reduce((sum, rule) => sum + (rule.timesTriggered || 0), 0);
        const rulesWithResponse = this.keywordRules.filter(rule => rule.response).length;
        const mostTriggered = this.keywordRules.reduce((max, rule) => 
            (rule.timesTriggered || 0) > (max.timesTriggered || 0) ? rule : max, 
            { timesTriggered: 0 }
        );

        return {
            totalRules,
            totalTriggers,
            rulesWithResponse,
            rulesEscapeOnly: totalRules - rulesWithResponse,
            mostTriggeredKeyword: mostTriggered.keyword || 'None',
            mostTriggeredCount: mostTriggered.timesTriggered || 0
        };
    }

    /**
     * Search keyword rules
     * @param {string} searchTerm - Term to search for
     * @returns {Array} - Filtered rules
     */
    searchKeywordRules(searchTerm) {
        if (!searchTerm || !searchTerm.trim()) {
            return this.keywordRules;
        }

        const term = searchTerm.toLowerCase().trim();
        return this.keywordRules.filter(rule => 
            rule.keyword.toLowerCase().includes(term) ||
            (rule.response && rule.response.toLowerCase().includes(term))
        );
    }

    /**
     * Get current keyword rules
     * @returns {Array} - Current keyword rules
     */
    getKeywordRules() {
        return [...this.keywordRules];
    }

    /**
     * Set keyword rules (for external updates)
     * @param {Array} rules - New keyword rules
     */
    async setKeywordRules(rules) {
        if (!Array.isArray(rules)) {
            this.logAction('Invalid keyword rules format', 'error');
            return false;
        }

        this.keywordRules = rules;
        await this.saveKeywordRules();
        this.updateKeywordRulesDisplay();
        return true;
    }

    /**
     * Destroy and cleanup
     */
    destroy() {
        this.keywordRules = [];
        this.isInitialized = false;
        this.logAction('Keyword rule manager destroyed', 'info');
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = KeywordRuleManager;
} else if (typeof window !== 'undefined') {
    window.KeywordRuleManager = KeywordRuleManager;
}