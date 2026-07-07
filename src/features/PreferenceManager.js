/**
 * PreferenceManager - Centralized preference and settings management
 * Consolidates 85+ preference-related functions from renderer.js
 */
class PreferenceManager {
    constructor(eventBus, appStateStore) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;

        // Operational state (NOT a user preference) - persisted separately.
        this.messageQueue = [];

        // Default preferences. Every key here is READ somewhere — dead keys
        // that were written as defaults but never consumed were removed.
        this.preferences = {
            theme: 'dark',
            leftSidebarWidth: 300,
            rightSidebarWidth: 400,
            voiceEnabled: false,
            microphoneDeviceId: 'default',
            wakeWordEnabled: false,
            wakeWordPhrase: 'hey claude',
            wakeSilenceMs: 3000,
            wakeMaxCommandMs: 60000,
            wakeMatchThreshold: 0.75,
            injectionDelayMs: 400,
            wakeActivationSound: 'screenshot.wav',
            wakeStopSound: 'hud4.wav',
            notificationsMuted: false,
            soundEffectsEnabled: false,
            completionSound: 'completion.mp3',
            injectionSound: 'injection.mp3',
            promptedSound: 'prompted.mp3',
            promptedSoundKeywordsOnly: false,
            keepScreenAwake: false,
            currentCwd: null,
            timerPreset1: 120,
            timerPreset2: 180,
            timerPreset3: 300,
            microwaveModeEnabled: false,
            messageHistory: [],
            timerTargetDateTime: null,
            usageLimitWaiting: false,
            injectionPausedState: false,
            lastStableCompletionByTerminal: {},
            savedViewState: 'action-log'
        };

        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // Listen for preference change requests
        this.eventBus.on('preference:update', async ({ key, value }) => {
            await this.updatePreference(key, value);
        });
        
        // Listen for preference get requests
        this.eventBus.on('preference:get', ({ key, callback }) => {
            const value = this.getPreference(key);
            if (callback) callback(value);
        });
        
        // Listen for bulk save requests
        this.eventBus.on('preference:save-all', async () => {
            await this.saveAllPreferences();
        });
    }
    
    // ======= CORE PREFERENCE OPERATIONS =======
    async updatePreference(key, value) {
        const oldValue = this.preferences[key];
        this.preferences[key] = value;

        // Save to database
        await this.savePreference(key, value);

        // Emit change event
        this.eventBus.emit('preference:changed', { key, value, oldValue });
        
        // Log the change
        this.eventBus.emit('log:action', {
            message: `Preference updated: ${key} = ${JSON.stringify(value)}`,
            type: 'info'
        });
    }
    
    getPreference(key) {
        return this.preferences[key];
    }
    
    getAllPreferences() {
        return { ...this.preferences };
    }
    
    // ======= DATABASE OPERATIONS =======
    async loadAllPreferences() {
        try {
            // Check for and migrate legacy localStorage data
            await this.checkAndMigrateLocalStorageData();
            
            // Load all settings from database
            const dbSettings = await ipcRenderer.invoke('db-get-all-settings');
            
            // Parse and merge with defaults
            Object.keys(dbSettings).forEach(key => {
                try {
                    const value = JSON.parse(dbSettings[key]);
                    if (value !== undefined && value !== null) {
                        this.preferences[key] = value;
                    }
                } catch (error) {
                    // If parsing fails, use the raw value
                    this.preferences[key] = dbSettings[key];
                }
            });
            
            // Load complex preferences
            // NOTE: messageHistory is owned solely by MessageQueueManager
            // (loaded via its loadMessageHistory(), persisted on each injection).
            // PreferenceManager must not load/save it or it clobbers MQM's data.
            await this.loadMessageQueue();
            await this.loadTimerState();
            
            // Apply loaded preferences
            await this.applyLoadedPreferences();
            
            this.eventBus.emit('log:action', {
                message: 'Preferences loaded successfully',
                type: 'success'
            });
            
        } catch (error) {
            console.error('Failed to load preferences:', error);
            this.eventBus.emit('log:action', {
                message: `Failed to load preferences: ${error.message}`,
                type: 'error'
            });
        }
    }
    
    async saveAllPreferences() {
        try {
            // Save each preference to database
            for (const [key, value] of Object.entries(this.preferences)) {
                // Skip complex objects that are saved separately
                if (key === 'messageQueue' || key === 'messageHistory') continue;
                
                await this.savePreference(key, value);
            }
            
            // Save complex preferences
            // (messageHistory intentionally omitted — owned by MessageQueueManager)
            await this.saveMessageQueue();
            
            this.eventBus.emit('log:action', {
                message: 'Preferences saved successfully',
                type: 'success'
            });
            
        } catch (error) {
            console.error('Failed to save preferences:', error);
            this.eventBus.emit('log:action', {
                message: `Failed to save preferences: ${error.message}`,
                type: 'error'
            });
        }
    }
    
    async savePreference(key, value) {
        try {
            const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
            await ipcRenderer.invoke('db-set-setting', key, stringValue);
        } catch (error) {
            console.error(`Failed to save preference ${key}:`, error);
        }
    }
    
    // ======= MIGRATION =======
    async checkAndMigrateLocalStorageData() {
        try {
            // Check if database is empty
            const dbSettings = await ipcRenderer.invoke('db-get-all-settings');
            const dbIsEmpty = Object.keys(dbSettings).length === 0;
            
            // If database has data, skip migration
            if (!dbIsEmpty) {
                return;
            }
            
            // Check for localStorage data
            const localStorageKeys = Object.keys(localStorage);
            if (localStorageKeys.length === 0) {
                return;
            }
            
            this.eventBus.emit('log:action', {
                message: 'Migrating preferences from localStorage to database...',
                type: 'info'
            });
            
            // Migrate each localStorage item
            for (const key of localStorageKeys) {
                try {
                    const value = localStorage.getItem(key);
                    if (value !== null && value !== undefined) {
                        await ipcRenderer.invoke('db-set-setting', key, value);
                    }
                } catch (error) {
                    console.error(`Failed to migrate ${key}:`, error);
                }
            }
            
            // Clear localStorage after successful migration
            localStorage.clear();
            
            this.eventBus.emit('log:action', {
                message: 'Successfully migrated preferences to database',
                type: 'success'
            });
            
        } catch (error) {
            console.error('Migration failed:', error);
            this.eventBus.emit('log:action', {
                message: `Migration failed: ${error.message}`,
                type: 'error'
            });
        }
    }
    
    // ======= COMPLEX PREFERENCE HANDLERS =======
    async loadMessageQueue() {
        try {
            const savedQueue = await ipcRenderer.invoke('db-get-setting', 'messageQueue');
            if (savedQueue) {
                this.messageQueue = JSON.parse(savedQueue);
                this.eventBus.emit('messageQueue:loaded', this.messageQueue);
            }
        } catch (error) {
            console.error('Failed to load message queue:', error);
        }
    }
    
    async saveMessageQueue() {
        try {
            if (this.messageQueue && this.messageQueue.length > 0) {
                await ipcRenderer.invoke('db-set-setting', 'messageQueue',
                    JSON.stringify(this.messageQueue));
            }
        } catch (error) {
            console.error('Failed to save message queue:', error);
        }
    }
    
    // messageHistory load/save removed — MessageQueueManager is the sole owner
    // of the 'messageHistory' store key (see MQM.loadMessageHistory /
    // persistMessageHistory). The old duplicate path here capped at 100 vs MQM's
    // bound and, on settings import, wrote a stale in-memory copy that wiped
    // messages injected during the session.

    async loadTimerState() {
        try {
            const timerState = await ipcRenderer.invoke('db-get-app-state', 'timerTargetDateTime');
            if (timerState) {
                this.preferences.timerTargetDateTime = new Date(timerState);
                this.eventBus.emit('timer:state-loaded', this.preferences.timerTargetDateTime);
            }
        } catch (error) {
            console.error('Failed to load timer state:', error);
        }
    }
    
    // ======= SIDEBAR PREFERENCES =======
    updateSidebarWidth(side, width) {
        if (side === 'left') {
            this.preferences.leftSidebarWidth = width;
        } else if (side === 'right') {
            this.preferences.rightSidebarWidth = width;
        }
        
        // Save asynchronously without blocking
        this.savePreference(`${side}SidebarWidth`, width);
    }
    
    // ======= DIRECTORY PREFERENCES =======
    async updateRecentDirectories(directory) {
        if (!this.preferences.recentDirectories) {
            this.preferences.recentDirectories = [];
        }
        
        // Remove if already exists
        const index = this.preferences.recentDirectories.indexOf(directory);
        if (index > -1) {
            this.preferences.recentDirectories.splice(index, 1);
        }
        
        // Add to beginning
        this.preferences.recentDirectories.unshift(directory);
        
        // Limit to 10 recent directories
        this.preferences.recentDirectories = this.preferences.recentDirectories.slice(0, 10);
        
        await this.savePreference('recentDirectories', this.preferences.recentDirectories);
    }
    
    // ======= TIMER PRESETS =======
    saveTimerPresets(preset1, preset2, preset3) {
        this.preferences.timerPreset1 = preset1;
        this.preferences.timerPreset2 = preset2;
        this.preferences.timerPreset3 = preset3;
        
        this.savePreference('timerPreset1', preset1);
        this.savePreference('timerPreset2', preset2);
        this.savePreference('timerPreset3', preset3);
    }
    
    // ======= APPLY LOADED PREFERENCES =======
    async applyLoadedPreferences() {
        // Apply theme
        if (this.preferences.theme) {
            document.documentElement.setAttribute('data-theme', this.preferences.theme);
        }
        
        // Apply sidebar widths
        this.eventBus.emit('sidebar:resize', {
            left: this.preferences.leftSidebarWidth,
            right: this.preferences.rightSidebarWidth
        });
        
        // Apply sound settings
        this.eventBus.emit('sound:toggle', this.preferences.soundEffectsEnabled);

        // Apply other UI preferences
        this.eventBus.emit('preferences:applied', this.preferences);
    }

    // ======= PUBLIC API =======
    async initialize() {
        await this.loadAllPreferences();
    }
    
}

module.exports = PreferenceManager;