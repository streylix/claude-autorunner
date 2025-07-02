/**
 * Terminal GUI - Refactored Renderer Process
 * Main coordination class that delegates to extracted modules
 */

const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');

class TerminalGUI {
    constructor() {
        // Core state
        this.terminals = new Map(); // Map of terminal ID to terminal data
        this.activeTerminalId = 1;
        this.terminalColors = ['#007acc', '#28ca42', '#ff5f57', '#ffbe2e', '#af52de', '#5ac8fa'];
        this.terminalStatuses = new Map(); // Map of terminal ID to status
        
        // Legacy compatibility
        this.terminal = null;
        this.fitAddon = null;
        this.currentDirectory = null;
        
        // Message system (delegated to modules)
        this._messageQueue = []; // Legacy array for compatibility
        this.messageQueue = null; // Will be MessageQueue instance
        this.messageIdCounter = 1;
        this.messageSequenceCounter = 0;
        
        // Injection system state (delegated to modules)
        this.currentlyInjectingMessages = new Set();
        this.currentlyInjectingTerminals = new Set();
        this.currentlyInjectingMessageId = null;
        this._isInjecting = false;
        this._injectionCount = 0;
        this.injectionBlocked = false;
        this.injectionInProgress = false;
        this.injectionPaused = false;
        this.pausedMessageContent = null;
        this.pausedMessageIndex = 0;
        this.currentTypeInterval = null;
        
        // Auto-continue and blocking state
        this.autoContinueEnabled = false;
        this.autoContinueActive = false;
        this.autoContinueRetryCount = 0;
        this.keywordBlockingActive = false;
        this.trustPromptActive = false;
        
        // Terminal state tracking
        this.lastTerminalOutput = '';
        this.currentTerminalStatus = { isRunning: false, isPrompting: false, lastUpdate: Date.now() };
        this.terminalIdleStartTime = null;
        
        // UI state
        this.isDragging = false;
        this.editingMessageId = null;
        this.originalEditContent = null;
        this.statusUpdateTimeout = null;
        
        // Sound and completion
        this.soundEffects = [];
        
        // Preferences with defaults
        this.preferences = {
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
            timerHours: 0,
            timerMinutes: 0,
            timerSeconds: 0,
            messageQueue: [],
            currentDirectory: null,
            completionSoundEnabled: false,
            completionSoundFile: 'completion_beep.wav',
            messageHistory: [],
            keepScreenAwake: true,
            showSystemNotifications: true,
            minimizeToTray: true,
            startMinimized: false
        };
        
        // Module instances
        this.terminalManager = null;
        this.terminalStatus = null;
        this.terminalThemes = null;
        this.messageQueue = null;
        this.settingsManager = null;
        this.timerManager = null;
        this.injectionEngine = null;
        this.actionLog = null;
        this.uiManager = null;
        this.voiceInterface = null;
    }

    // Initialize all modules and the GUI
    async initialize() {
        try {
            console.log('Initializing Terminal GUI...');
            
            // Initialize modules in dependency order
            this.initializeModules();
            
            // Load preferences first
            await this.loadAllPreferences();
            
            // Initialize terminal system
            await this.initializeTerminalSystem();
            
            // Setup event listeners
            this.setupEventListeners();
            
            // Initialize UI state
            this.initializeUI();
            
            // Load saved data
            await this.loadSavedData();
            
            // Start background processes
            this.startBackgroundProcesses();
            
            // Final UI updates
            this.updateAllUI();
            
            console.log('Terminal GUI initialization complete');
            this.logAction('Terminal GUI initialized successfully', 'success');
            
        } catch (error) {
            console.error('Failed to initialize Terminal GUI:', error);
            this.logAction(`Initialization failed: ${error.message}`, 'error');
        }
    }

    // Initialize all module instances
    initializeModules() {
        // Terminal system
        this.terminalThemes = new TerminalThemes(this);
        this.terminalManager = new TerminalManager(this);
        this.terminalStatus = new TerminalStatus(this);
        
        // Message system
        this.messageQueue = new MessageQueue(this);
        
        // Settings and storage
        this.settingsManager = new SettingsManager(this);
        
        // Auto-injection system
        this.timerManager = new TimerManager(this);
        this.injectionEngine = new InjectionEngine(this);
        
        // UI system
        this.actionLog = new ActionLog(this);
        this.uiManager = new UIManager(this);
        
        // Feature modules
        this.voiceInterface = new VoiceInterface(this);
        
        console.log('All modules initialized');
    }

    // Load preferences from storage
    async loadAllPreferences() {
        await this.settingsManager.loadAllPreferences();
        this.preferences = this.settingsManager.preferences;
        console.log('Preferences loaded');
    }

    // Save preferences to storage
    async savePreferences() {
        await this.settingsManager.saveAllPreferences();
    }

    // Initialize terminal system
    async initializeTerminalSystem() {
        // Create initial terminal
        const success = await this.terminalManager.createTerminal(1);
        if (!success) {
            throw new Error('Failed to create initial terminal');
        }
        
        // Restore saved terminal state if available
        await this.terminalManager.restoreTerminalState();
        
        // Start terminal status monitoring
        this.terminalStatus.startTerminalStatusScanning();
        
        console.log('Terminal system initialized');
    }

    // Setup all event listeners
    setupEventListeners() {
        this.setupTerminalEventListeners();
        this.setupMessageEventListeners();
        this.setupTimerEventListeners();
        this.setupUIEventListeners();
        this.setupVoiceEventListeners();
        this.setupKeyboardShortcuts();
        
        console.log('Event listeners setup complete');
    }

    // Setup terminal-related event listeners
    setupTerminalEventListeners() {
        // Terminal IPC events
        ipcRenderer.on('terminal-data', (event, { terminalId, data }) => {
            this.handleTerminalOutput(terminalId, data);
        });

        ipcRenderer.on('terminal-exit', (event, { terminalId, code, signal }) => {
            console.log(`Terminal ${terminalId} exited with code: ${code}, signal: ${signal}`);
            this.logAction(`Terminal ${terminalId} exited (code: ${code})`, 'warning');
        });

        // Terminal selector dropdown
        const terminalSelectorBtn = document.getElementById('terminal-selector-btn');
        if (terminalSelectorBtn) {
            terminalSelectorBtn.addEventListener('click', () => {
                this.terminalManager.toggleTerminalSelectorDropdown();
            });
        }

        // Add terminal button
        const addTerminalBtn = document.getElementById('add-terminal-btn');
        if (addTerminalBtn) {
            addTerminalBtn.addEventListener('click', () => {
                this.terminalManager.addNewTerminal();
            });
        }
    }

    // Setup message-related event listeners
    setupMessageEventListeners() {
        // Message input
        const messageInput = document.getElementById('message-input');
        if (messageInput) {
            messageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.messageQueue.addMessageToQueue();
                }
            });

            messageInput.addEventListener('input', () => {
                this.uiManager.autoResizeMessageInput(messageInput);
            });
        }

        // Add message button
        const addMessageBtn = document.getElementById('add-message-btn');
        if (addMessageBtn) {
            addMessageBtn.addEventListener('click', () => {
                this.messageQueue.addMessageToQueue();
            });
        }

        // Clear queue button
        const clearQueueBtn = document.getElementById('clear-queue-btn');
        if (clearQueueBtn) {
            clearQueueBtn.addEventListener('click', () => {
                this.messageQueue.clearQueue();
            });
        }

        // Inject messages button
        const injectBtn = document.getElementById('inject-messages-btn');
        if (injectBtn) {
            injectBtn.addEventListener('click', () => {
                this.injectionEngine.performManualInjection();
            });
        }

        // Message history button
        const historyBtn = document.getElementById('message-history-btn');
        if (historyBtn) {
            historyBtn.addEventListener('click', () => {
                this.openMessageHistoryModal();
            });
        }
    }

    // Setup timer-related event listeners
    setupTimerEventListeners() {
        // Timer play/pause button
        const playPauseBtn = document.getElementById('timer-play-pause-btn');
        if (playPauseBtn) {
            playPauseBtn.addEventListener('click', () => {
                this.timerManager.toggleTimerOrInjection();
            });
        }

        // Timer stop button
        const stopBtn = document.getElementById('timer-stop-btn');
        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                if (this.injectionEngine.getInjectionState().isInjecting) {
                    this.injectionEngine.cancelSequentialInjection();
                } else if (this.timerManager.isTimerActive()) {
                    this.timerManager.stopTimer();
                } else {
                    this.timerManager.resetTimer();
                }
            });
        }

        // Timer edit button
        const editBtn = document.getElementById('timer-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                this.timerManager.openTimerEditDropdown();
            });
        }
    }

    // Setup UI-related event listeners
    setupUIEventListeners() {
        // Settings button
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                this.settingsManager.openSettingsModal();
            });
        }

        // Window resize
        window.addEventListener('resize', () => {
            this.terminalManager.resizeAllTerminals();
        });

        // Initialize action log event listeners
        this.actionLog.setupEventListeners();
    }

    // Setup voice-related event listeners
    setupVoiceEventListeners() {
        const voiceBtn = document.getElementById('voice-record-btn');
        if (voiceBtn) {
            voiceBtn.addEventListener('click', () => {
                this.voiceInterface.toggleVoiceRecording();
            });
        }
    }

    // Setup keyboard shortcuts
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Global shortcuts
            if (e.ctrlKey || e.metaKey) {
                switch (e.key) {
                    case 'Enter':
                        e.preventDefault();
                        this.injectionEngine.performManualInjection();
                        break;
                    case ' ':
                        e.preventDefault();
                        this.timerManager.toggleTimer();
                        break;
                    case ',':
                        e.preventDefault();
                        this.settingsManager.openSettingsModal();
                        break;
                }
            }

            // Escape key - close modals/dropdowns
            if (e.key === 'Escape') {
                this.uiManager.hideAllDropdowns();
                this.uiManager.closeModal();
            }
        });
    }

    // Initialize UI state
    initializeUI() {
        // Initialize Lucide icons
        this.initializeLucideIcons();
        
        // Initialize modules that need UI setup
        this.actionLog.initialize();
        this.uiManager.initialize();
        this.voiceInterface.initialize();
        
        // Initialize from preferences
        this.timerManager.initializeFromPreferences(this.preferences);
        this.injectionEngine.initializeFromPreferences(this.preferences);
        
        // Apply theme
        this.settingsManager.applyTheme(this.preferences.theme);
        
        console.log('UI initialized');
    }

    // Load saved data
    async loadSavedData() {
        // Load message queue
        await this.messageQueue.loadMessageQueue();
        
        // Load sound effects
        await this.loadSoundEffects();
        
        console.log('Saved data loaded');
    }

    // Start background processes
    startBackgroundProcesses() {
        // Start usage limit sync if enabled
        if (this.timerManager.autoSyncEnabled) {
            this.timerManager.startUsageLimitSync();
        }
        
        console.log('Background processes started');
    }

    // Update all UI elements
    updateAllUI() {
        this.uiManager.updateStatusDisplay();
        this.uiManager.updateButtonStates();
        this.terminalStatus.updateTerminalStatusIndicator();
        this.messageQueue.updateMessageList();
        this.timerManager.updateTimerDisplay();
        this.uiManager.updateSoundSettingsVisibility();
    }

    // Handle terminal output
    handleTerminalOutput(terminalId, data) {
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return;

        // Store output for status scanning
        terminalData.lastOutput = (terminalData.lastOutput + data).slice(-2000);
        
        // Legacy compatibility
        if (terminalId === this.activeTerminalId) {
            this.lastTerminalOutput = terminalData.lastOutput;
        }

        // Check for keyword blocking
        this.injectionEngine.checkTerminalForKeywords(data, terminalId);
    }

    // Message history modal
    openMessageHistoryModal() {
        this.uiManager.showModal('message-history-modal');
        this.updateHistoryModal();
    }

    updateHistoryModal() {
        const historyContainer = document.getElementById('message-history-list');
        if (!historyContainer) return;

        historyContainer.innerHTML = '';
        
        const history = this.preferences.messageHistory || [];
        
        if (history.length === 0) {
            historyContainer.innerHTML = '<div class="history-empty">No message history</div>';
            return;
        }

        history.forEach(entry => {
            const historyItem = document.createElement('div');
            historyItem.className = 'history-item';
            
            const terminalData = this.terminals.get(entry.terminalId);
            const terminalName = terminalData ? terminalData.name : `Terminal ${entry.terminalId}`;
            
            historyItem.innerHTML = `
                <div class="history-header">
                    <span class="history-terminal">${terminalName}</span>
                    <span class="history-time">${new Date(entry.injectedAt).toLocaleString()}</span>
                </div>
                <div class="history-content">${this.escapeHtml(entry.content)}</div>
            `;
            
            historyContainer.appendChild(historyItem);
        });
    }

    // Sound effects
    async loadSoundEffects() {
        try {
            const { ipcRenderer } = require('electron');
            const response = await ipcRenderer.invoke('get-sound-effects');
            
            if (response.success) {
                this.soundEffects = response.soundEffects;
                this.updateSoundEffectOptions();
            }
        } catch (error) {
            console.warn('Failed to load sound effects:', error);
        }
    }

    updateSoundEffectOptions() {
        const select = document.getElementById('completion-sound-file');
        if (select && this.soundEffects.length > 0) {
            select.innerHTML = '';
            
            this.soundEffects.forEach(sound => {
                const option = document.createElement('option');
                option.value = sound.name;
                option.textContent = sound.displayName;
                select.appendChild(option);
            });
            
            select.value = this.preferences.completionSoundFile;
        }
    }

    playCompletionSound() {
        if (!this.preferences.completionSoundEnabled) return;
        
        try {
            const soundFile = this.soundEffects.find(s => s.name === this.preferences.completionSoundFile);
            if (soundFile) {
                const audio = new Audio(soundFile.path);
                audio.volume = 0.3;
                audio.play().catch(error => {
                    console.warn('Failed to play completion sound:', error);
                });
            }
        } catch (error) {
            console.warn('Error playing completion sound:', error);
        }
    }

    // Initialize Lucide icons
    initializeLucideIcons() {
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }

    // Legacy compatibility methods - delegate to modules
    
    // Timer methods (delegate to TimerManager)
    get timerActive() { return this.timerManager ? this.timerManager.isTimerActive() : false; }
    get timerHours() { return this.timerManager ? this.timerManager.timerHours : 0; }
    get timerMinutes() { return this.timerManager ? this.timerManager.timerMinutes : 0; }
    get timerSeconds() { return this.timerManager ? this.timerManager.timerSeconds : 0; }
    
    toggleTimer() { return this.timerManager ? this.timerManager.toggleTimer() : false; }
    startTimer() { return this.timerManager ? this.timerManager.startTimer() : false; }
    stopTimer() { return this.timerManager ? this.timerManager.stopTimer() : false; }
    updateTimerDisplay() { if (this.timerManager) this.timerManager.updateTimerDisplay(); }
    updateTimerUI() { if (this.timerManager) this.timerManager.updateTimerUI(); }

    // Injection methods (delegate to InjectionEngine)
    get isInjecting() { return this.injectionEngine ? this.injectionEngine.getInjectionState().isInjecting : false; }
    get injectionCount() { return this.injectionEngine ? this.injectionEngine.getInjectionState().injectionCount : 0; }
    
    performSafetyChecks(callback) { if (this.injectionEngine) this.injectionEngine.performSafetyChecks(callback); }
    processMessage(message) { return this.injectionEngine ? this.injectionEngine.processMessage(message) : false; }
    cancelSequentialInjection() { return this.injectionEngine ? this.injectionEngine.cancelSequentialInjection() : false; }
    validateInjectionState(caller) { return this.injectionEngine ? this.injectionEngine.validateInjectionState(caller) : false; }
    detectAutoContinuePrompt(output, terminalId) { return this.injectionEngine ? this.injectionEngine.detectAutoContinuePrompt(output, terminalId) : false; }
    typeMessage(content, callback) { 
        if (this.injectionEngine) {
            this.injectionEngine.typeMessageToTerminal(content, this.activeTerminalId).then(() => {
                if (callback) callback();
            });
        }
    }
    getRandomDelay(min, max) { return this.injectionEngine ? this.injectionEngine.getRandomDelay(min, max) : Math.floor(Math.random() * (max - min + 1)) + min; }
    scheduleNextInjection() { if (this.messageQueue) this.messageQueue.scheduleNextInjection(); }

    // Terminal methods (delegate to TerminalManager/TerminalStatus)
    createTerminal(id) { return this.terminalManager ? this.terminalManager.createTerminal(id) : false; }
    switchToTerminal(id) { return this.terminalManager ? this.terminalManager.switchToTerminal(id) : false; }
    updateTerminalStatusIndicator() { if (this.terminalStatus) this.terminalStatus.updateTerminalStatusIndicator(); }
    isTerminalStableAndReady(id) { return this.terminalStatus ? this.terminalStatus.isTerminalStableAndReady(id) : false; }
    getTerminalTheme() { 
        return this.terminalThemes ? this.terminalThemes.getTerminalTheme() : {
            background: '#1e1e1e',
            foreground: '#ffffff',
            cursor: '#ffffff',
            cursorAccent: '#1e1e1e',
            selection: '#3d3d3d'
        };
    }

    // UI methods (delegate to UIManager)
    updateStatusDisplay() { if (this.uiManager) this.uiManager.updateStatusDisplay(); }
    showModal(modalId) { return this.uiManager ? this.uiManager.showModal(modalId) : false; }
    closeModal(modalId) { if (this.uiManager) this.uiManager.closeModal(modalId); }
    updateTrayBadge() { if (this.uiManager) this.uiManager.updateTrayBadge(); }
    autoResizeMessageInput(input) { if (this.uiManager) this.uiManager.autoResizeMessageInput(input); }

    // Action log methods (delegate to ActionLog)
    logAction(message, type) { if (this.actionLog) this.actionLog.logAction(message, type); }

    // Settings methods (delegate to SettingsManager)
    openSettingsModal() { if (this.settingsManager) this.settingsManager.openSettingsModal(); }

    // Voice methods (delegate to VoiceInterface)
    toggleVoiceRecording() { return this.voiceInterface ? this.voiceInterface.toggleVoiceRecording() : false; }

    // Utility methods
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatTimestamp(timestamp) {
        return new Date(timestamp).toLocaleTimeString();
    }

    // Cleanup
    destroy() {
        // Stop all background processes
        if (this.terminalStatus) this.terminalStatus.stopTerminalStatusScanning();
        if (this.timerManager) this.timerManager.destroy();
        if (this.injectionEngine) this.injectionEngine.destroy();
        if (this.voiceInterface) this.voiceInterface.destroy();
        if (this.uiManager) this.uiManager.destroy();
        
        console.log('Terminal GUI destroyed');
    }
}

// Initialize the GUI when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM loaded, initializing Terminal GUI...');
    
    window.terminalGUI = new TerminalGUI();
    await window.terminalGUI.initialize();
    
    console.log('Terminal GUI ready');
});

// Handle app shutdown
window.addEventListener('beforeunload', () => {
    if (window.terminalGUI) {
        window.terminalGUI.destroy();
    }
});

// Export for global access
window.TerminalGUI = TerminalGUI;