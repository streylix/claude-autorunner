/**
 * Settings Manager Module
 * Handles settings and preferences management for the renderer process
 */

class SettingsManager {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        this.defaultPreferences = {
            autoscrollEnabled: true,
            autoscrollDelay: 3000,
            autoContinueEnabled: false,
            defaultDuration: 5,
            defaultUnit: 'seconds',
            theme: 'dark',
            keywordRules: [
                {
                    id: "claude_credit_example",
                    keyword: "[Claude Code]",
                    response: "do not credit yourself"
                }
            ],
            // Timer persistence
            timerHours: 0,
            timerMinutes: 0,
            timerSeconds: 0,
            // Message queue persistence
            messageQueue: [],
            // Directory persistence
            currentDirectory: null,
            // Sound effects preferences
            completionSoundEnabled: false,
            completionSoundFile: 'completion_beep.wav',
            // Message history
            messageHistory: [],
            // Background service preferences
            keepScreenAwake: true,
            showSystemNotifications: true,
            minimizeToTray: true,
            startMinimized: false
        };

        // Apply default preferences
        this.preferences = { ...this.defaultPreferences };
    }

    // Load all preferences from storage
    async loadAllPreferences() {
        try {
            const { ipcRenderer } = require('electron');
            const allSettings = await ipcRenderer.invoke('db-get-all-settings');
            
            if (allSettings && Object.keys(allSettings).length > 0) {
                // Merge saved settings with defaults
                this.preferences = { ...this.defaultPreferences, ...allSettings };
                console.log('Preferences loaded from database');
            } else {
                // Use defaults if no saved settings
                this.preferences = { ...this.defaultPreferences };
                console.log('Using default preferences');
            }
            
            // Apply theme
            this.applyTheme(this.preferences.theme);
            
            // Update UI elements with loaded preferences  
            setTimeout(() => {
                this.updateUIFromPreferences();
            }, 100); // Delay to ensure DOM is ready
            
            console.log('Preferences loaded successfully');
            return true;
        } catch (error) {
            console.error('Failed to load preferences:', error);
            // Use defaults on error
            this.preferences = { ...this.defaultPreferences };
            this.applyTheme(this.preferences.theme);
            
            if (this.gui && this.gui.logAction) {
                this.gui.logAction('Failed to load preferences from database, using defaults', 'warning');
            }
            return false;
        }
    }

    // Save all preferences to storage
    async saveAllPreferences() {
        try {
            const { ipcRenderer } = require('electron');
            
            // Save each preference individually for better granular control
            for (const [key, value] of Object.entries(this.preferences)) {
                await ipcRenderer.invoke('db-set-setting', key, value);
            }
            
            return true;
        } catch (error) {
            console.error('Failed to save preferences:', error);
            this.gui.logAction('Failed to save preferences to database', 'error');
            return false;
        }
    }

    // Get a specific preference
    getPreference(key) {
        return this.preferences[key];
    }

    // Set a specific preference and optionally save
    async setPreference(key, value, save = true) {
        this.preferences[key] = value;
        
        if (save) {
            try {
                const { ipcRenderer } = require('electron');
                await ipcRenderer.invoke('db-set-setting', key, value);
                return true;
            } catch (error) {
                console.error(`Failed to save preference ${key}:`, error);
                return false;
            }
        }
        return true;
    }

    // Update multiple preferences at once
    async updatePreferences(updates, save = true) {
        Object.assign(this.preferences, updates);
        
        if (save) {
            return await this.saveAllPreferences();
        }
        return true;
    }

    // Apply theme to the UI
    applyTheme(theme) {
        const body = document.body;
        
        // Remove existing theme classes
        body.classList.remove('theme-light', 'theme-dark');
        
        // Apply new theme
        if (theme === 'light') {
            body.classList.add('theme-light');
        } else {
            body.classList.add('theme-dark');
        }
        
        this.preferences.theme = theme;
    }

    // Update UI elements based on current preferences
    updateUIFromPreferences() {
        // Auto-scroll settings
        const autoscrollCheckbox = document.getElementById('autoscroll-enabled');
        if (autoscrollCheckbox) {
            autoscrollCheckbox.checked = this.preferences.autoscrollEnabled;
        }

        const autoscrollDelayInput = document.getElementById('autoscroll-delay');
        if (autoscrollDelayInput) {
            autoscrollDelayInput.value = this.preferences.autoscrollDelay;
        }

        // Auto-continue settings
        const autoContinueCheckbox = document.getElementById('auto-continue-enabled');
        if (autoContinueCheckbox) {
            autoContinueCheckbox.checked = this.preferences.autoContinueEnabled;
        }

        // Theme settings
        const themeSelect = document.getElementById('theme-select');
        if (themeSelect) {
            themeSelect.value = this.preferences.theme;
        }

        // Timer settings
        if (this.gui.timerHours !== undefined) {
            this.gui.timerHours = this.preferences.timerHours || 0;
            this.gui.timerMinutes = this.preferences.timerMinutes || 0;
            this.gui.timerSeconds = this.preferences.timerSeconds || 0;
        }

        // Completion sound settings
        const completionSoundCheckbox = document.getElementById('completion-sound-enabled');
        if (completionSoundCheckbox) {
            completionSoundCheckbox.checked = this.preferences.completionSoundEnabled;
        }

        // Background service settings
        const keepScreenAwakeCheckbox = document.getElementById('keep-screen-awake');
        if (keepScreenAwakeCheckbox) {
            keepScreenAwakeCheckbox.checked = this.preferences.keepScreenAwake;
        }

        const showNotificationsCheckbox = document.getElementById('show-notifications');
        if (showNotificationsCheckbox) {
            showNotificationsCheckbox.checked = this.preferences.showSystemNotifications;
        }

        // Update keyword rules display
        this.updateKeywordRulesDisplay();

        // Update timer display
        if (this.gui.updateTimerDisplay) {
            this.gui.updateTimerDisplay();
        }
    }

    // Keyword rules management
    addKeywordRule(keyword, response) {
        if (!keyword || !response) {
            this.gui.logAction('Invalid keyword rule - keyword and response are required', 'error');
            return false;
        }

        const newRule = {
            id: `rule_${Date.now()}`,
            keyword: keyword.trim(),
            response: response.trim()
        };

        this.preferences.keywordRules.push(newRule);
        this.updateKeywordRulesDisplay();
        this.saveAllPreferences();
        
        this.gui.logAction(`Added keyword rule: "${keyword}" → "${response}"`, 'info');
        return true;
    }

    removeKeywordRule(ruleId) {
        const index = this.preferences.keywordRules.findIndex(rule => rule.id === ruleId);
        if (index !== -1) {
            const removedRule = this.preferences.keywordRules.splice(index, 1)[0];
            this.updateKeywordRulesDisplay();
            this.saveAllPreferences();
            
            this.gui.logAction(`Removed keyword rule: "${removedRule.keyword}"`, 'info');
            return true;
        }
        return false;
    }

    updateKeywordRulesDisplay() {
        const rulesContainer = document.getElementById('keyword-rules-list');
        if (!rulesContainer) return;

        rulesContainer.innerHTML = '';

        this.preferences.keywordRules.forEach(rule => {
            const ruleElement = document.createElement('div');
            ruleElement.className = 'keyword-rule-item';
            ruleElement.innerHTML = `
                <div class="keyword-rule-content">
                    <div class="keyword-rule-keyword">"${this.gui.escapeHtml(rule.keyword)}"</div>
                    <div class="keyword-rule-arrow">→</div>
                    <div class="keyword-rule-response">"${this.gui.escapeHtml(rule.response)}"</div>
                </div>
                <button class="icon-btn delete-rule-btn" onclick="window.terminalGUI.settingsManager.removeKeywordRule('${rule.id}')" title="Delete rule">
                    <i data-lucide="trash-2"></i>
                </button>
            `;
            rulesContainer.appendChild(ruleElement);
        });

        // Refresh Lucide icons
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    // Check if a keyword should be blocked
    checkForKeywordBlocking(terminalOutput) {
        if (!terminalOutput || !this.preferences.keywordRules) return null;

        for (const rule of this.preferences.keywordRules) {
            if (terminalOutput.includes(rule.keyword)) {
                return {
                    keyword: rule.keyword,
                    response: rule.response,
                    rule: rule
                };
            }
        }
        return null;
    }

    // Settings modal management
    openSettingsModal() {
        const modal = document.getElementById('settings-modal');
        if (modal) {
            // Update UI to reflect current settings
            this.updateUIFromPreferences();
            this.gui.showModal('settings-modal');
        }
    }

    closeSettingsModal() {
        // Save any pending changes
        this.saveSettingsFromUI();
        this.gui.closeModal('settings-modal');
    }

    // Save settings from UI form elements
    saveSettingsFromUI() {
        const updates = {};

        // Auto-scroll settings
        const autoscrollCheckbox = document.getElementById('autoscroll-enabled');
        if (autoscrollCheckbox) {
            updates.autoscrollEnabled = autoscrollCheckbox.checked;
        }

        const autoscrollDelayInput = document.getElementById('autoscroll-delay');
        if (autoscrollDelayInput) {
            updates.autoscrollDelay = parseInt(autoscrollDelayInput.value) || 3000;
        }

        // Auto-continue settings
        const autoContinueCheckbox = document.getElementById('auto-continue-enabled');
        if (autoContinueCheckbox) {
            updates.autoContinueEnabled = autoContinueCheckbox.checked;
        }

        // Theme settings
        const themeSelect = document.getElementById('theme-select');
        if (themeSelect) {
            updates.theme = themeSelect.value;
            this.applyTheme(themeSelect.value);
        }

        // Completion sound settings
        const completionSoundCheckbox = document.getElementById('completion-sound-enabled');
        if (completionSoundCheckbox) {
            updates.completionSoundEnabled = completionSoundCheckbox.checked;
        }

        // Background service settings
        const keepScreenAwakeCheckbox = document.getElementById('keep-screen-awake');
        if (keepScreenAwakeCheckbox) {
            updates.keepScreenAwake = keepScreenAwakeCheckbox.checked;
        }

        const showNotificationsCheckbox = document.getElementById('show-notifications');
        if (showNotificationsCheckbox) {
            updates.showSystemNotifications = showNotificationsCheckbox.checked;
        }

        // Update preferences and save
        this.updatePreferences(updates, true);
    }

    // Reset to defaults
    async resetToDefaults() {
        this.preferences = { ...this.defaultPreferences };
        await this.saveAllPreferences();
        this.updateUIFromPreferences();
        this.gui.logAction('Settings reset to defaults', 'info');
    }

    // Export settings
    exportSettings() {
        const settingsData = {
            preferences: this.preferences,
            exportedAt: new Date().toISOString(),
            version: '1.0'
        };

        const dataStr = JSON.stringify(settingsData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(dataBlob);
        link.download = `terminal-gui-settings-${new Date().toISOString().split('T')[0]}.json`;
        link.click();

        this.gui.logAction('Settings exported successfully', 'info');
    }

    // Import settings
    async importSettings(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            
            if (data.preferences && typeof data.preferences === 'object') {
                this.preferences = { ...this.defaultPreferences, ...data.preferences };
                await this.saveAllPreferences();
                this.updateUIFromPreferences();
                this.gui.logAction('Settings imported successfully', 'success');
                return true;
            } else {
                throw new Error('Invalid settings file format');
            }
        } catch (error) {
            console.error('Failed to import settings:', error);
            this.gui.logAction('Failed to import settings: ' + error.message, 'error');
            return false;
        }
    }
}

// Export for use in main TerminalGUI class
window.SettingsManager = SettingsManager;