/**
 * Settings Manager Module
 * 
 * Centralized settings and preferences management
 * Handles persistence, theme management, and settings synchronization
 */

class SettingsManager {
    constructor(logAction) {
        this.logAction = logAction || console.log;
        this.preferences = this.getDefaultPreferences();
        this.settingsModal = null;
        this.isInitialized = false;
    }

    /**
     * Get default preferences structure
     * @returns {Object} - Default preferences object
     */
    getDefaultPreferences() {
        return {
            autoContinueEnabled: false,
            theme: 'dark',
            keywordRules: [],
            planRules: [],
            timerHours: 0,
            timerMinutes: 0,
            timerSeconds: 0,
            messageQueue: [],
            currentDirectory: null,
            completionSoundEnabled: false,
            completionSoundFile: 'beep.wav',
            injectionSoundFile: 'click.wav',
            promptedSoundFile: 'gmod.wav',
            promptedSoundKeywordsOnly: false,
            messageHistory: [],
            keepScreenAwake: true,
            showSystemNotifications: true,
            minimizeToTray: true,
            startMinimized: false,
            automaticTodoGeneration: false,
        };
    }

    /**
     * Initialize settings manager
     */
    async initialize() {
        if (this.isInitialized) return;

        try {
            await this.checkAndMigrateLocalStorageData();
            await this.loadAllPreferences();
            this.setupSettingsEventListeners();
            this.applyLoadedSettings();
            this.isInitialized = true;
            this.logAction('Settings manager initialized successfully', 'info');
        } catch (error) {
            this.logAction(`Failed to initialize settings: ${error.message}`, 'error');
        }
    }

    /**
     * Load all preferences from database
     */
    async loadAllPreferences() {
        try {
            const { ipcRenderer } = require('electron');
            const allSettings = await ipcRenderer.invoke('db-get-all-settings');
            
            // Merge with defaults to ensure all properties exist
            this.preferences = { ...this.getDefaultPreferences(), ...allSettings };
            
            this.logAction('Preferences loaded from database', 'info');
        } catch (error) {
            this.logAction(`Failed to load preferences: ${error.message}`, 'error');
            this.preferences = this.getDefaultPreferences();
        }
    }

    /**
     * Save all preferences to database
     */
    async saveAllPreferences() {
        try {
            const { ipcRenderer } = require('electron');
            await ipcRenderer.invoke('db-save-all-settings', this.preferences);
            this.logAction('All preferences saved to database', 'info');
        } catch (error) {
            this.logAction(`Failed to save preferences: ${error.message}`, 'error');
        }
    }

    /**
     * Save individual setting
     * @param {string} key - Setting key
     * @param {any} value - Setting value
     */
    async saveSetting(key, value) {
        try {
            const { ipcRenderer } = require('electron');
            this.preferences[key] = value;
            await ipcRenderer.invoke('db-save-setting', key, value);
            this.logAction(`Setting saved: ${key}`, 'info');
        } catch (error) {
            this.logAction(`Failed to save setting ${key}: ${error.message}`, 'error');
        }
    }

    /**
     * Get individual setting
     * @param {string} key - Setting key
     * @param {any} defaultValue - Default value if not found
     * @returns {any} - Setting value
     */
    async getSetting(key, defaultValue = null) {
        try {
            const { ipcRenderer } = require('electron');
            const value = await ipcRenderer.invoke('db-get-setting', key);
            return value !== null ? value : defaultValue;
        } catch (error) {
            this.logAction(`Failed to get setting ${key}: ${error.message}`, 'error');
            return defaultValue;
        }
    }

    /**
     * Check and migrate data from localStorage to database
     */
    async checkAndMigrateLocalStorageData() {
        try {
            const { ipcRenderer } = require('electron');
            
            // Check if migration is needed
            const migrationNeeded = await ipcRenderer.invoke('db-check-migration-needed');
            if (!migrationNeeded) return;

            // Migrate localStorage data if it exists
            const localStorageData = {};
            const defaultPrefs = this.getDefaultPreferences();
            
            Object.keys(defaultPrefs).forEach(key => {
                const stored = localStorage.getItem(key);
                if (stored !== null) {
                    try {
                        localStorageData[key] = JSON.parse(stored);
                    } catch {
                        localStorageData[key] = stored;
                    }
                }
            });

            if (Object.keys(localStorageData).length > 0) {
                await ipcRenderer.invoke('db-migrate-from-localStorage', localStorageData);
                this.logAction(`Migrated ${Object.keys(localStorageData).length} settings from localStorage`, 'info');
                
                // Clear localStorage after successful migration
                Object.keys(localStorageData).forEach(key => {
                    localStorage.removeItem(key);
                });
            }
        } catch (error) {
            this.logAction(`Migration failed: ${error.message}`, 'error');
        }
    }

    /**
     * Setup event listeners for settings interface
     */
    setupSettingsEventListeners() {
        // Settings modal controls
        this.setupModalEventListeners();
        
        // Theme selector
        this.setupThemeEventListeners();
        
        // Sound settings
        this.setupSoundEventListeners();
        
        // Background service settings
        this.setupBackgroundServiceEventListeners();
        
        // Todo generation settings
        this.setupTodoGenerationEventListeners();
    }

    /**
     * Setup modal event listeners
     */
    setupModalEventListeners() {
        const settingsBtn = document.getElementById('settings-btn');
        const closeModalBtn = document.querySelector('.close-modal');
        const settingsModal = document.getElementById('settings-modal');

        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => this.openSettingsModal());
        }

        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', () => this.closeSettingsModal());
        }

        if (settingsModal) {
            settingsModal.addEventListener('click', (e) => {
                if (e.target === settingsModal) {
                    this.closeSettingsModal();
                }
            });
        }
    }

    /**
     * Setup theme event listeners
     */
    setupThemeEventListeners() {
        const themeSelect = document.getElementById('theme-select');
        if (themeSelect) {
            themeSelect.addEventListener('change', async (e) => {
                const theme = e.target.value;
                await this.saveSetting('theme', theme);
                this.applyTheme(theme);
                this.logAction(`Theme changed to: ${theme}`, 'info');
            });
        }
    }

    /**
     * Setup sound event listeners
     */
    setupSoundEventListeners() {
        // Completion sound toggle
        const completionSoundEnabled = document.getElementById('completion-sound-enabled');
        if (completionSoundEnabled) {
            completionSoundEnabled.addEventListener('change', async (e) => {
                await this.saveSetting('completionSoundEnabled', e.target.checked);
                this.updateSoundSettingsVisibility();
            });
        }

        // Sound file selectors
        const soundFiles = ['completionSoundFile', 'injectionSoundFile', 'promptedSoundFile'];
        soundFiles.forEach(soundType => {
            const selector = document.getElementById(soundType.replace('File', ''));
            if (selector) {
                selector.addEventListener('change', async (e) => {
                    await this.saveSetting(soundType, e.target.value);
                });
            }
        });

        // Prompted sound keywords only
        const promptedKeywordsOnly = document.getElementById('prompted-sound-keywords-only');
        if (promptedKeywordsOnly) {
            promptedKeywordsOnly.addEventListener('change', async (e) => {
                await this.saveSetting('promptedSoundKeywordsOnly', e.target.checked);
            });
        }

        // Test sound buttons
        const testButtons = [
            { id: 'test-completion-sound', method: () => this.testCompletionSound() },
            { id: 'test-injection-sound', method: () => this.testInjectionSound() },
            { id: 'test-prompted-sound', method: () => this.testPromptedSound() }
        ];

        testButtons.forEach(button => {
            const element = document.getElementById(button.id);
            if (element) {
                element.addEventListener('click', button.method);
            }
        });
    }

    /**
     * Setup background service event listeners
     */
    setupBackgroundServiceEventListeners() {
        const backgroundSettings = [
            'keep-screen-awake',
            'show-system-notifications',
            'minimize-to-tray',
            'start-minimized'
        ];

        backgroundSettings.forEach(settingId => {
            const element = document.getElementById(settingId);
            if (element) {
                element.addEventListener('change', async (e) => {
                    const settingKey = settingId.replace(/-/g, '');
                    await this.saveSetting(settingKey, e.target.checked);
                });
            }
        });
    }

    /**
     * Setup todo generation event listeners
     */
    setupTodoGenerationEventListeners() {
        const todoGeneration = document.getElementById('automatic-todo-generation');
        if (todoGeneration) {
            todoGeneration.addEventListener('change', async (e) => {
                await this.saveSetting('automaticTodoGeneration', e.target.checked);
                this.logAction(`Automatic todo generation: ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
            });
        }
    }


    /**
     * Apply loaded settings to UI and system
     */
    applyLoadedSettings() {
        // Apply theme
        this.applyTheme(this.preferences.theme);
        
        // Update UI elements with loaded values
        this.updateUIFromPreferences();
        
        // Apply sound settings
        this.updateSoundSettingsVisibility();
    }

    /**
     * Update UI elements from preferences
     */
    updateUIFromPreferences() {
        const mappings = [
            { id: 'theme-select', key: 'theme' },
            { id: 'completion-sound-enabled', key: 'completionSoundEnabled' },
            { id: 'completion-sound', key: 'completionSoundFile' },
            { id: 'injection-sound', key: 'injectionSoundFile' },
            { id: 'prompted-sound', key: 'promptedSoundFile' },
            { id: 'prompted-sound-keywords-only', key: 'promptedSoundKeywordsOnly' },
            { id: 'keep-screen-awake', key: 'keepScreenAwake' },
            { id: 'show-system-notifications', key: 'showSystemNotifications' },
            { id: 'minimize-to-tray', key: 'minimizeToTray' },
            { id: 'start-minimized', key: 'startMinimized' },
            { id: 'automatic-todo-generation', key: 'automaticTodoGeneration' }
        ];

        mappings.forEach(mapping => {
            const element = document.getElementById(mapping.id);
            if (element && this.preferences[mapping.key] !== undefined) {
                if (element.type === 'checkbox') {
                    element.checked = this.preferences[mapping.key];
                } else {
                    element.value = this.preferences[mapping.key];
                }
            }
        });
    }

    /**
     * Apply theme to UI and terminal
     * @param {string} theme - Theme name ('dark' or 'light')
     */
    applyTheme(theme) {
        document.body.className = theme === 'light' ? 'light-theme' : '';
        
        // Apply terminal theme if terminal processor is available
        if (this.terminalProcessor) {
            this.terminalProcessor.applyThemeToAllTerminals(theme);
        }
    }

    /**
     * Get terminal theme configuration
     * @param {string} theme - Theme name
     * @returns {Object} - Terminal theme configuration
     */
    getTerminalTheme(theme = this.preferences.theme) {
        return theme === 'light' ? this.getLightTerminalTheme() : this.getDarkTerminalTheme();
    }

    /**
     * Get dark terminal theme
     * @returns {Object} - Dark theme configuration
     */
    getDarkTerminalTheme() {
        return {
            background: '#1a1a1a',
            foreground: '#ffffff',
            cursor: '#ffffff',
            cursorAccent: '#000000',
            selection: '#ffffff40',
            black: '#000000',
            red: '#ff5555',
            green: '#50fa7b',
            yellow: '#f1fa8c',
            blue: '#bd93f9',
            magenta: '#ff79c6',
            cyan: '#8be9fd',
            white: '#bfbfbf',
            brightBlack: '#4d4d4d',
            brightRed: '#ff6e67',
            brightGreen: '#5af78e',
            brightYellow: '#f4f99d',
            brightBlue: '#caa9fa',
            brightMagenta: '#ff92d0',
            brightCyan: '#9aedfe',
            brightWhite: '#e6e6e6'
        };
    }

    /**
     * Get light terminal theme
     * @returns {Object} - Light theme configuration
     */
    getLightTerminalTheme() {
        return {
            background: '#ffffff',
            foreground: '#000000',
            cursor: '#000000',
            cursorAccent: '#ffffff',
            selection: '#00000040',
            black: '#000000',
            red: '#da3633',
            green: '#007427',
            yellow: '#b08500',
            blue: '#0451a5',
            magenta: '#bc05bc',
            cyan: '#0598bc',
            white: '#595959',
            brightBlack: '#303030',
            brightRed: '#cd3131',
            brightGreen: '#00bc00',
            brightYellow: '#949800',
            brightBlue: '#0451a5',
            brightMagenta: '#bc05bc',
            brightCyan: '#0598bc',
            brightWhite: '#000000'
        };
    }

    /**
     * Open settings modal
     */
    openSettingsModal() {
        const modal = document.getElementById('settings-modal');
        if (modal) {
            modal.style.display = 'block';
            this.populateSoundEffects();
            this.logAction('Settings modal opened', 'info');
        }
    }

    /**
     * Close settings modal
     */
    closeSettingsModal() {
        const modal = document.getElementById('settings-modal');
        if (modal) {
            modal.style.display = 'none';
            this.logAction('Settings modal closed', 'info');
        }
    }

    /**
     * Populate sound effects dropdown
     */
    populateSoundEffects() {
        const soundFiles = [
            'beep.wav', 'click.wav', 'gmod.wav', 'ding.wav', 
            'chime.wav', 'bell.wav', 'notification.wav'
        ];

        const dropdowns = ['completion-sound', 'injection-sound', 'prompted-sound'];
        
        dropdowns.forEach(dropdownId => {
            const dropdown = document.getElementById(dropdownId);
            if (dropdown) {
                dropdown.innerHTML = '';
                soundFiles.forEach(file => {
                    const option = document.createElement('option');
                    option.value = file;
                    option.textContent = file.replace('.wav', '').toUpperCase();
                    dropdown.appendChild(option);
                });
            }
        });
    }

    /**
     * Update sound settings visibility
     */
    updateSoundSettingsVisibility() {
        const soundOptions = document.getElementById('sound-options');
        if (soundOptions) {
            soundOptions.style.display = this.preferences.completionSoundEnabled ? 'block' : 'none';
        }
    }

    /**
     * Test completion sound
     */
    testCompletionSound() {
        this.playSound(this.preferences.completionSoundFile, 'completion');
    }

    /**
     * Test injection sound
     */
    testInjectionSound() {
        this.playSound(this.preferences.injectionSoundFile, 'injection');
    }

    /**
     * Test prompted sound
     */
    testPromptedSound() {
        this.playSound(this.preferences.promptedSoundFile, 'prompted');
    }

    /**
     * Play sound file
     * @param {string} soundFile - Sound file name
     * @param {string} type - Sound type for logging
     */
    playSound(soundFile, type) {
        try {
            const audio = new Audio(`./sounds/${soundFile}`);
            audio.play().catch(error => {
                this.logAction(`Failed to play ${type} sound: ${error.message}`, 'error');
            });
        } catch (error) {
            this.logAction(`Error playing ${type} sound: ${error.message}`, 'error');
        }
    }

    /**
     * Save terminal state
     * @param {Object} terminalData - Terminal state data
     */
    async saveTerminalState(terminalData) {
        try {
            const { ipcRenderer } = require('electron');
            await ipcRenderer.invoke('db-save-terminal-state', terminalData);
        } catch (error) {
            this.logAction(`Failed to save terminal state: ${error.message}`, 'error');
        }
    }

    /**
     * Load terminal state
     * @returns {Object} - Terminal state data
     */
    async loadTerminalState() {
        try {
            const { ipcRenderer } = require('electron');
            return await ipcRenderer.invoke('db-load-terminal-state');
        } catch (error) {
            this.logAction(`Failed to load terminal state: ${error.message}`, 'error');
            return null;
        }
    }

    /**
     * Set terminal processor dependency
     * @param {Object} terminalProcessor - Terminal processor instance
     */
    setTerminalProcessor(terminalProcessor) {
        this.terminalProcessor = terminalProcessor;
    }

    /**
     * Get current preferences
     * @returns {Object} - Current preferences object
     */
    getPreferences() {
        return { ...this.preferences };
    }

    /**
     * Update preferences
     * @param {Object} updates - Preference updates
     */
    async updatePreferences(updates) {
        Object.assign(this.preferences, updates);
        await this.saveAllPreferences();
    }

    /**
     * Reset preferences to defaults
     */
    async resetToDefaults() {
        const confirmed = confirm('Are you sure you want to reset all settings to defaults? This cannot be undone.');
        if (!confirmed) return false;

        this.preferences = this.getDefaultPreferences();
        await this.saveAllPreferences();
        this.updateUIFromPreferences();
        this.applyLoadedSettings();
        this.logAction('Settings reset to defaults', 'info');
        return true;
    }

    /**
     * Export settings as JSON
     * @returns {string} - JSON string of settings
     */
    exportSettings() {
        return JSON.stringify(this.preferences, null, 2);
    }

    /**
     * Import settings from JSON
     * @param {string} jsonData - JSON string of settings
     * @returns {boolean} - Success status
     */
    async importSettings(jsonData) {
        try {
            const importedSettings = JSON.parse(jsonData);
            const defaultPrefs = this.getDefaultPreferences();
            
            // Validate imported settings
            const validSettings = {};
            Object.keys(defaultPrefs).forEach(key => {
                if (importedSettings.hasOwnProperty(key)) {
                    validSettings[key] = importedSettings[key];
                }
            });

            this.preferences = { ...defaultPrefs, ...validSettings };
            await this.saveAllPreferences();
            this.updateUIFromPreferences();
            this.applyLoadedSettings();
            this.logAction('Settings imported successfully', 'success');
            return true;
        } catch (error) {
            this.logAction(`Failed to import settings: ${error.message}`, 'error');
            return false;
        }
    }

    /**
     * Destroy and cleanup
     */
    destroy() {
        this.closeSettingsModal();
        this.isInitialized = false;
        this.logAction('Settings manager destroyed', 'info');
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SettingsManager;
} else if (typeof window !== 'undefined') {
    window.SettingsManager = SettingsManager;
}