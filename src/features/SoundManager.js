/**
 * SoundManager - Handles all sound effects and audio playback
 * Consolidates sound functionality from renderer.js
 */
class SoundManager {
    constructor(eventBus, appStateStore) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        
        // Sound preferences
        this.soundEnabled = false;
        this.completionSound = 'completion.mp3';
        this.injectionSound = 'injection.mp3';
        this.promptedSound = 'prompted.mp3';
        this.promptedSoundKeywordsOnly = false;
        
        // Available sound files cache
        this.availableSounds = [];

        // Audio instances cache to prevent multiple loads
        this.audioCache = new Map();

        // Per-terminal sound overrides, keyed by terminalId.
        // Shape: { completion?, injection?, prompted?, muted? }
        this.terminalSoundOverrides = {};

        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // Listen for sound preference changes
        this.eventBus.on('sound:toggle', (enabled) => {
            this.setSoundEnabled(enabled);
        });
        
        // Listen for sound effect selections
        this.eventBus.on('sound:set-completion', (filename) => {
            this.setCompletionSound(filename);
        });
        
        this.eventBus.on('sound:set-injection', (filename) => {
            this.setInjectionSound(filename);
        });
        
        this.eventBus.on('sound:set-prompted', (filename) => {
            this.setPromptedSound(filename);
        });
        
        // Listen for sound triggers
        this.eventBus.on('sound:play-completion', () => {
            this.playCompletionSound();
        });
        
        this.eventBus.on('sound:play-injection', () => {
            this.playInjectionSound();
        });
        
        this.eventBus.on('sound:play-prompted', (keywordDetected) => {
            this.playPromptedSound(keywordDetected);
        });
        
        // Listen for canonical status changes to trigger sounds
        this.eventBus.on('terminal:status:changed', (data) => {
            this.checkStatusChangeSounds(data.previousStatus, data.status, data.terminalId);
        });

        // Per-terminal sound override events
        this.eventBus.on('sound:set-terminal-override', (data) => {
            this.setTerminalSoundOverride(data.terminalId, data.type, data.filename);
        });

        this.eventBus.on('sound:clear-terminal-override', (data) => {
            this.clearTerminalSoundOverrides(data.terminalId);
        });
    }
    
    // ======= SOUND PREFERENCES =======
    setSoundEnabled(enabled) {
        this.soundEnabled = enabled;
        this.appStateStore.setState('settings.sound.enabled', enabled);

        this.eventBus.emit('log:action', {
            message: `Sound effects ${enabled ? 'enabled' : 'disabled'}`,
            type: 'info'
        });
    }

    setCompletionSound(filename) {
        this.completionSound = filename;
        this.appStateStore.setState('settings.sound.completion', filename);
    }

    setInjectionSound(filename) {
        this.injectionSound = filename;
        this.appStateStore.setState('settings.sound.injection', filename);
    }

    setPromptedSound(filename) {
        this.promptedSound = filename;
        this.appStateStore.setState('settings.sound.prompted', filename);
    }

    setPromptedKeywordsOnly(enabled) {
        this.promptedSoundKeywordsOnly = enabled;
        this.appStateStore.setState('settings.sound.promptedKeywordsOnly', enabled);
    }

    // ======= PER-TERMINAL SOUND OVERRIDES =======
    /**
     * Set a per-terminal override for a given sound type.
     * @param {string|number} terminalId
     * @param {'completion'|'injection'|'prompted'|'muted'} type
     * @param {string|boolean} filename - filename for sound types, boolean for 'muted'
     */
    setTerminalSoundOverride(terminalId, type, filename) {
        if (terminalId === null || terminalId === undefined) return;
        if (!this.terminalSoundOverrides[terminalId]) {
            this.terminalSoundOverrides[terminalId] = {};
        }
        this.terminalSoundOverrides[terminalId][type] = filename;
        this.persistTerminalSoundOverrides();
    }

    /**
     * Clear all per-terminal overrides for a terminal.
     */
    clearTerminalSoundOverrides(terminalId) {
        if (this.terminalSoundOverrides[terminalId]) {
            delete this.terminalSoundOverrides[terminalId];
            this.persistTerminalSoundOverrides();
        }
    }

    /**
     * Resolve the effective sound for a terminal/type: override falls back to global default.
     * @returns {string} filename (may be 'none')
     */
    getEffectiveSound(terminalId, type) {
        const override = this.terminalSoundOverrides[terminalId];
        if (override && override[type] !== undefined && override[type] !== null) {
            return override[type];
        }
        switch (type) {
            case 'completion': return this.completionSound;
            case 'injection': return this.injectionSound;
            case 'prompted': return this.promptedSound;
            default: return null;
        }
    }

    /**
     * Whether a terminal is muted via override.
     */
    isTerminalMuted(terminalId) {
        const override = this.terminalSoundOverrides[terminalId];
        return !!(override && override.muted);
    }

    persistTerminalSoundOverrides() {
        if (this.appStateStore && typeof this.appStateStore.setState === 'function') {
            this.appStateStore.setState('terminalSoundOverrides', this.terminalSoundOverrides);
        }
    }
    
    // ======= SOUND PLAYBACK =======
    async playSound(filename) {
        if (!filename || !this.soundEnabled) {
            return;
        }
        
        try {
            // Check cache first
            let audio = this.audioCache.get(filename);
            
            if (!audio) {
                // Create new audio instance and cache it
                audio = new Audio(`./assets/soundeffects/${filename}`);
                this.audioCache.set(filename, audio);
            }
            
            // Clone the audio to allow overlapping sounds
            const audioClone = audio.cloneNode();
            audioClone.volume = 0.5; // Default volume
            
            await audioClone.play();
            
        } catch (error) {
            console.error(`Failed to play sound ${filename}:`, error);
            // Don't show error to user - sound effects failing shouldn't interrupt workflow
        }
    }
    
    playCompletionSound(terminalId = null) {
        if (terminalId !== null && this.isTerminalMuted(terminalId)) return;
        const sound = terminalId !== null
            ? this.getEffectiveSound(terminalId, 'completion')
            : this.completionSound;
        if (sound && sound !== 'none') {
            this.playSound(sound);
        }
    }

    playInjectionSound(terminalId = null) {
        if (terminalId !== null && this.isTerminalMuted(terminalId)) return;
        const sound = terminalId !== null
            ? this.getEffectiveSound(terminalId, 'injection')
            : this.injectionSound;
        if (sound && sound !== 'none') {
            this.playSound(sound);
        }
    }

    playPromptedSound(keywordDetected = false, terminalId = null) {
        if (terminalId !== null && this.isTerminalMuted(terminalId)) return;
        // Only play if not restricted to keywords, or if keyword was detected
        if (!this.promptedSoundKeywordsOnly || keywordDetected) {
            const sound = terminalId !== null
                ? this.getEffectiveSound(terminalId, 'prompted')
                : this.promptedSound;
            if (sound && sound !== 'none') {
                this.playSound(sound);
            }
        }
    }
    
    // ======= STATUS CHANGE DETECTION =======
    checkStatusChangeSounds(previousStatus, currentStatus, terminalId) {
        if (!this.soundEnabled) return;
        if (terminalId !== null && terminalId !== undefined && this.isTerminalMuted(terminalId)) return;

        // Check for completion sound trigger
        if (this.shouldPlayCompletionSound(previousStatus, currentStatus)) {
            this.playCompletionSound(terminalId);
            this.eventBus.emit('log:action', {
                message: `🔔 Completion sound triggered for Terminal ${terminalId}`,
                type: 'info'
            });
        }

        // Check for prompted sound trigger
        if (this.shouldPlayPromptedSound(previousStatus, currentStatus)) {
            // Check if keywords are involved
            const keywordDetected = this.checkForKeywords(terminalId);
            this.playPromptedSound(keywordDetected, terminalId);
            
            if (!this.promptedSoundKeywordsOnly || keywordDetected) {
                this.eventBus.emit('log:action', {
                    message: `🔔 Prompted sound triggered for Terminal ${terminalId}`,
                    type: 'info'
                });
            }
        }
    }
    
    shouldPlayCompletionSound(previousStatus, currentStatus) {
        // Play sound when transitioning from running to prompted/stale
        // ('...' is the app's stale/idle state convention)
        const wasRunning = previousStatus === 'running' || previousStatus === 'completing';
        const isCompleted = currentStatus === 'prompted' || currentStatus === '...' || currentStatus === 'idle';

        return wasRunning && isCompleted;
    }
    
    shouldPlayPromptedSound(previousStatus, currentStatus) {
        // Play sound when becoming prompted
        return currentStatus === 'prompted' && previousStatus !== 'prompted';
    }
    
    checkForKeywords(terminalId) {
        // Emit event to check for keywords in terminal
        let keywordDetected = false;
        
        this.eventBus.emit('sound:check-keywords', {
            terminalId,
            callback: (detected) => {
                keywordDetected = detected;
            }
        });
        
        return keywordDetected;
    }
    
    // ======= SOUND FILE MANAGEMENT =======
    async loadAvailableSounds() {
        try {
            // Request available sound files from backend
            const { ipcRenderer } = require('electron');
            const response = await ipcRenderer.invoke('get-sound-files');

            if (response && response.files) {
                this.availableSounds = response.files;
                this.eventBus.emit('sound:files-loaded', this.availableSounds);
            }
        } catch (error) {
            console.error('Failed to load sound files:', error);
            // Use default list as fallback
            this.availableSounds = [
                'none',
                'completion.mp3',
                'injection.mp3',
                'prompted.mp3',
                'bell.mp3',
                'chime.mp3',
                'notification.mp3'
            ];
        }
    }
    
    getAvailableSounds() {
        return this.availableSounds;
    }
    
    // ======= TEST FUNCTIONS =======
    testCompletionSound() {
        const previousEnabled = this.soundEnabled;
        this.soundEnabled = true; // Temporarily enable for testing
        
        this.playCompletionSound();
        
        this.eventBus.emit('log:action', {
            message: '🔊 Testing completion sound',
            type: 'info'
        });
        
        // Restore previous state after a delay
        setTimeout(() => {
            this.soundEnabled = previousEnabled;
        }, 1000);
    }
    
    testInjectionSound() {
        const previousEnabled = this.soundEnabled;
        this.soundEnabled = true; // Temporarily enable for testing
        
        this.playInjectionSound();
        
        this.eventBus.emit('log:action', {
            message: '🔊 Testing injection sound',
            type: 'info'
        });
        
        // Restore previous state after a delay
        setTimeout(() => {
            this.soundEnabled = previousEnabled;
        }, 1000);
    }
    
    testPromptedSound() {
        const previousEnabled = this.soundEnabled;
        this.soundEnabled = true; // Temporarily enable for testing
        
        this.playPromptedSound(true); // Force play regardless of keyword setting
        
        this.eventBus.emit('log:action', {
            message: '🔊 Testing prompted sound',
            type: 'info'
        });
        
        // Restore previous state after a delay
        setTimeout(() => {
            this.soundEnabled = previousEnabled;
        }, 1000);
    }
    
    // ======= UI UPDATE HELPERS =======
    updateSoundSettingsVisibility() {
        // Emit event to update UI based on sound enabled state
        this.eventBus.emit('sound:update-ui', {
            enabled: this.soundEnabled,
            completionSound: this.completionSound,
            injectionSound: this.injectionSound,
            promptedSound: this.promptedSound,
            promptedKeywordsOnly: this.promptedSoundKeywordsOnly
        });
    }
    
    // ======= PUBLIC API =======
    isSoundEnabled() {
        return this.soundEnabled;
    }
    
    getCompletionSound() {
        return this.completionSound;
    }
    
    getInjectionSound() {
        return this.injectionSound;
    }
    
    getPromptedSound() {
        return this.promptedSound;
    }
    
    async initialize() {
        // Load preferences from the unified app state store
        this.soundEnabled = this.appStateStore.getState('settings.sound.enabled') || false;
        this.completionSound = this.appStateStore.getState('settings.sound.completion') || 'completion.mp3';
        this.injectionSound = this.appStateStore.getState('settings.sound.injection') || 'injection.mp3';
        this.promptedSound = this.appStateStore.getState('settings.sound.prompted') || 'prompted.mp3';
        this.promptedSoundKeywordsOnly = this.appStateStore.getState('settings.sound.promptedKeywordsOnly') || false;

        // Load per-terminal sound overrides
        this.terminalSoundOverrides = this.appStateStore.getState('terminalSoundOverrides') || {};

        // Load available sound files
        await this.loadAvailableSounds();

        // Update UI
        this.updateSoundSettingsVisibility();
    }
    
    // Cleanup method
    destroy() {
        // Clear audio cache
        this.audioCache.clear();
    }
}

module.exports = SoundManager;