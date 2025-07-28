/**
 * Microwave Mode Initialization Helper
 * Ensures microwave mode is properly initialized and handles fallbacks
 */

function initializeMicrowaveMode() {
    try {
        // Check if MicrowaveMode class is available
        if (typeof MicrowaveMode !== 'undefined') {
            this.microwaveMode = new MicrowaveMode(this);
            console.log('🍽️ Microwave mode initialized successfully');
            this.logAction('Microwave mode initialized', 'info');
        } else {
            console.warn('⚠️ MicrowaveMode class not found - using fallback mode');
            this.initializeFallbackMicrowaveMode();
        }
        
        // Apply microwave mode settings to UI
        this.applyMicrowaveModeToUI();
        
    } catch (error) {
        console.error('❌ Error initializing microwave mode, using fallback:', error);
        this.logAction(`Microwave mode initialization error: ${error.message}`, 'error');
        this.initializeFallbackMicrowaveMode();
    }
}

function initializeFallbackMicrowaveMode() {
    // Simple fallback microwave mode implementation
    this.microwaveMode = {
        isActive: false,
        repeatCount: 0,
        repeatTimer: null,
        
        onTaskCompleted: () => {
            if (this.preferences.microwaveModeEnabled) {
                console.log('🍽️ Fallback microwave mode: Task completed');
                this.startSimpleMicrowaveBeeping();
            }
        },
        
        stopMicrowaveBeeping: (reason = 'manual') => {
            if (this.microwaveMode.repeatTimer) {
                clearInterval(this.microwaveMode.repeatTimer);
                this.microwaveMode.repeatTimer = null;
                this.microwaveMode.isActive = false;
                console.log(`🍽️ Fallback microwave beeping stopped: ${reason}`);
            }
        },
        
        onNewTaskStarted: () => {
            this.microwaveMode.stopMicrowaveBeeping('new_task_started');
        }
    };
    
    // Simple beeping implementation
    this.startSimpleMicrowaveBeeping = () => {
        if (this.microwaveMode.isActive) {
            return; // Already active
        }
        
        this.microwaveMode.isActive = true;
        this.microwaveMode.repeatCount = 0;
        
        // Initial beep after 2 seconds
        setTimeout(() => {
            if (this.microwaveMode.isActive) {
                this.playCompletionSound();
                this.microwaveMode.repeatCount++;
            }
        }, 2000);
        
        // Repeat every minute for 5 minutes
        this.microwaveMode.repeatTimer = setInterval(() => {
            if (this.microwaveMode.repeatCount >= 5) {
                this.microwaveMode.stopMicrowaveBeeping('max_repeats_reached');
                return;
            }
            
            this.playCompletionSound();
            this.microwaveMode.repeatCount++;
            console.log(`🍽️ Fallback microwave beep ${this.microwaveMode.repeatCount}/5`);
        }, 60000); // 60 seconds
    };
    
    console.log('🍽️ Fallback microwave mode initialized');
}

function applyMicrowaveModeToUI() {
    // Apply microwave mode preference to checkbox
    const microwaveModeCheckbox = document.getElementById('microwave-mode-enabled');
    if (microwaveModeCheckbox) {
        microwaveModeCheckbox.checked = this.preferences.microwaveModeEnabled;
    }
    
    // Set default sound values if not already set
    const completionSoundSelect = document.getElementById('completion-sound-select');
    const injectionSoundSelect = document.getElementById('injection-sound-select');
    const promptedSoundSelect = document.getElementById('prompted-sound-select');
    
    if (completionSoundSelect && !this.preferences.completionSoundFile) {
        this.preferences.completionSoundFile = 'click.wav';
        completionSoundSelect.value = 'click.wav';
    }
    
    if (injectionSoundSelect && !this.preferences.injectionSoundFile) {
        this.preferences.injectionSoundFile = 'click.wav';
        injectionSoundSelect.value = 'click.wav';
    }
    
    if (promptedSoundSelect && !this.preferences.promptedSoundFile) {
        this.preferences.promptedSoundFile = 'none';
        promptedSoundSelect.value = 'none';
    }
    
    // Ensure sound effects are enabled by default for microwave mode
    const soundEffectsCheckbox = document.getElementById('sound-effects-enabled');
    if (soundEffectsCheckbox && this.preferences.microwaveModeEnabled) {
        soundEffectsCheckbox.checked = true;
        this.preferences.completionSoundEnabled = true;
    }
}

// Export functions for TerminalGUI class
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initializeMicrowaveMode,
        initializeFallbackMicrowaveMode,
        applyMicrowaveModeToUI
    };
} else {
    // Attach to TerminalGUI prototype for browser usage
    if (typeof TerminalGUI !== 'undefined') {
        TerminalGUI.prototype.initializeMicrowaveMode = initializeMicrowaveMode;
        TerminalGUI.prototype.initializeFallbackMicrowaveMode = initializeFallbackMicrowaveMode;
        TerminalGUI.prototype.applyMicrowaveModeToUI = applyMicrowaveModeToUI;
    }
}