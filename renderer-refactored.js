/**
 * Main Renderer Process - Refactored and Modularized
 * This file now coordinates between specialized modules instead of handling everything
 */

const { ipcRenderer } = require('electron');

// Import modular components
const PlatformUtils = require('./src/utils/platform-utils');
const DomUtils = require('./src/utils/dom-utils');
const ValidationUtils = require('./src/utils/validation');
const IPCHandler = require('./src/core/ipc-handler');
const InjectionManager = require('./src/messaging/injection-manager');

// Import new modular components
const TimerController = require('./src/timer/timer-controller');
const TerminalManager = require('./src/terminal/terminal-manager');
const MessageQueue = require('./src/messaging/message-queue');
const ModalManager = require('./src/ui/modal-manager');

class TerminalGUI {
    constructor() {
        // Initialize utility classes
        this.platformUtils = new PlatformUtils();
        this.validationUtils = new ValidationUtils();
        this.ipcHandler = new IPCHandler();
        
        // Platform detection for keyboard shortcuts (keep for backward compatibility)
        this.isMac = this.platformUtils.isMac;
        this.keySymbols = this.platformUtils.keySymbols;
        
        // Application session ID for statistics
        this.sessionId = this.validationUtils.generateSessionId('app');
        
        // Core state management
        this.injectionCount = 0;
        this.keywordCount = 0;
        this.promptCount = 0;
        this.messageSequenceCounter = 0;
        
        // Terminal-specific tracking for auto-continue, keyword detection, and timer targeting
        this.usageLimitTerminals = new Set();
        this.continueTargetTerminals = new Set();
        this.keywordResponseTerminals = new Map();
        this.processedUsageLimitMessages = new Set();
        this.processedPrompts = new Set();
        this.currentlyInjectingMessages = new Set();
        this.currentlyInjectingTerminals = new Set();
        
        // Application state
        this.lastTerminalOutput = '';
        this.autoscrollEnabled = true;
        this.autoscrollDelay = 3000;
        this.autoscrollTimeout = null;
        this.userInteracting = false;
        this.actionLog = [];
        this.injectionBlocked = false;
        this.autoContinueActive = false;
        this.autoContinueRetryCount = 0;
        this.keywordBlockingActive = false;
        this.trustPromptActive = false;
        this.terminalStatus = '';
        this.currentResetTime = null;
        this.statusUpdateTimeout = null;
        this.isDragging = false;
        
        // Injection state
        this.isInjecting = false;
        this.injectionInProgress = false;
        this.injectionPaused = false;
        this.pausedMessageContent = null;
        this.pausedMessageIndex = 0;
        this.currentTypeInterval = null;
        this.currentlyInjectingMessageId = null;
        this.schedulingInProgress = false;
        
        // Usage limit handling
        this.usageLimitModalShowing = false;
        this.usageLimitWaiting = false;
        this.usageLimitCooldownUntil = null;
        this.usageLimitSyncInterval = null;
        this.usageLimitResetTime = null;
        this.autoSyncEnabled = true;
        this.pendingUsageLimitReset = null;
        this.safetyCheckCount = 0;
        this.safetyCheckInterval = null;
        
        // Voice recording state
        this.isRecording = false;
        this.mediaRecorder = null;
        this.audioChunks = [];
        
        // Terminal status scanning system
        this.terminalScanInterval = null;
        this.currentTerminalStatus = {
            isRunning: false,
            isPrompting: false,
            lastUpdate: Date.now()
        };
        
        // Todo generation cooldown
        this.todoGenerationCooldown = 3 * 60 * 1000; // 3 minutes
        
        // Terminal idle tracking for completion sound
        this.terminalIdleTimer = null;
        this.terminalIdleStartTime = null;
        
        // Background service state
        this.powerSaveBlockerActive = false;
        this.backgroundServiceActive = false;
        
        // Auto-continue and plan mode
        this.autoContinueEnabled = false;
        this.planModeEnabled = false;
        this.planModeCommand = 'npx claude-flow@alpha sparc mode --type "dev" --task-description "{message}" --claude';
        
        // Default preferences structure
        this.preferences = this.getDefaultPreferences();
        
        // Initialize modular components
        this.timerController = new TimerController(this);
        this.terminalManager = new TerminalManager(this);
        this.messageQueue = new MessageQueue(this);
        this.modalManager = new ModalManager(this);
        this.injectionManager = new InjectionManager(this);
        
        // Add global console error protection
        this.setupConsoleErrorProtection();
        
        // Initialize the application asynchronously
        this.initialize();
    }

    getDefaultPreferences() {
        return {
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
            promptRules: [],
            timerHours: 0,
            timerMinutes: 0,
            timerSeconds: 0,
            messageQueue: [],
            currentDirectory: null,
            recentDirectories: [],
            completionSoundEnabled: false,
            completionSoundFile: 'beep.wav',
            injectionSoundFile: 'click.wav',
            promptedSoundFile: 'gmod.wav',
            promptedSoundKeywordsOnly: false,
            messageHistory: [],
            usageLimitWaiting: false,
            keepScreenAwake: true,
            showSystemNotifications: true,
            minimizeToTray: true,
            startMinimized: false,
            automaticTodoGeneration: false,
            planModeEnabled: false,
            planModeCommand: this.planModeCommand
        };
    }

    setupConsoleErrorProtection() {
        const originalConsole = {
            log: console.log,
            warn: console.warn,
            error: console.error,
            info: console.info
        };

        this.originalConsole = originalConsole;
        this.lastConsoleOutput = {};

        // Throttle console output to prevent EIO crashes
        ['log', 'warn', 'error', 'info'].forEach(method => {
            console[method] = (...args) => {
                try {
                    const now = Date.now();
                    const throttleMs = 100; // 100ms throttle
                    
                    if (!this.lastConsoleOutput[method] || now - this.lastConsoleOutput[method] > throttleMs) {
                        this.lastConsoleOutput[method] = now;
                        if (originalConsole[method]) {
                            originalConsole[method](...args);
                        }
                    }
                } catch (error) {
                    // Fallback for console errors
                    try {
                        if (originalConsole.error) {
                            originalConsole.error('Console error protection triggered:', error);
                        }
                    } catch (fallbackError) {
                        // Ultimate fallback - do nothing to prevent cascading errors
                    }
                }
            };
        });
    }

    directLog(message, level = 'log') {
        try {
            if (this.originalConsole && this.originalConsole[level]) {
                this.originalConsole[level](message);
            }
        } catch (error) {
            // Silently fail to prevent cascading errors
        }
    }

    async initialize() {
        this.directLog('Initializing TerminalGUI...');
        
        try {
            // Load preferences first
            await this.loadAllPreferences();
            
            // Initialize backend API client if available
            if (typeof BackendAPIClient !== 'undefined') {
                this.backendAPIClient = new BackendAPIClient();
                
                const isBackendAvailable = await this.backendAPIClient.checkConnection();
                if (isBackendAvailable) {
                    this.directLog('Backend API client initialized successfully');
                } else {
                    this.directLog('Backend API unavailable, running in standalone mode');
                    this.backendAPIClient = null;
                }
            }
            
            // Initialize components
            this.initializeLucideIcons();
            this.updatePlatformSpecificShortcuts();
            this.terminalManager.initializeTerminal();
            this.setupEventListeners();
            this.applyTheme(this.preferences.theme);
            
            // Initialize timer UI after loading preferences
            this.timerController.updateTimerUI();
            
            // If timer was expired on startup, trigger injection manager
            if (this.timerController.timerExpired) {
                this.injectionManager.onTimerExpired();
            }

            // Load timer from preferences
            this.timerController.loadTimerFromPreferences();
            
            // Check for expired timer or usage limit waiting on startup
            if (this.timerController.timerExpired || this.usageLimitWaiting) {
                this.injectionManager.checkAndStartInjection();
            }
            
            // Load message queue from preferences
            this.messageQueue.loadQueueFromPreferences();
            
            this.directLog('TerminalGUI initialized successfully');
            
        } catch (error) {
            this.directLog('Error during TerminalGUI initialization:', error);
            console.error('Initialization error:', error);
        }
        
        // Auto-fit terminals when window visibility changes
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                return;
            }
            setTimeout(() => this.terminalManager.resizeAllTerminals(), 100);
        });
    }

    initializeLucideIcons() {
        // Initialize Lucide icons if available
        if (typeof lucide !== 'undefined') {
            try {
                lucide.createIcons();
                this.directLog('Lucide icons initialized');
            } catch (error) {
                this.directLog('Error initializing Lucide icons:', error);
            }
        }
    }

    formatKeyboardShortcut(shortcut) {
        return this.platformUtils.formatKeyboardShortcut(shortcut);
    }

    isCommandKey(e) {
        return this.platformUtils.isCommandKey(e);
    }

    isTypingInInputField(e) {
        return e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    }

    updatePlatformSpecificShortcuts() {
        // Update UI elements to show platform-specific shortcuts
        const shortcutElements = document.querySelectorAll('[data-shortcut]');
        shortcutElements.forEach(element => {
            const shortcut = element.getAttribute('data-shortcut');
            element.textContent = this.formatKeyboardShortcut(shortcut);
        });
    }

    setupEventListeners() {
        // Terminal IPC event handlers
        this.setupTerminalIPCHandlers();
        
        // Keyboard shortcuts
        this.setupKeyboardShortcuts();
        
        // UI event handlers
        this.setupUIEventHandlers();
        
        // Drag and drop
        this.setupDragAndDrop();
        
        // Window management
        this.setupWindowEventHandlers();
    }

    setupTerminalIPCHandlers() {
        // Terminal data handler
        ipcRenderer.on('terminal-data', (event, { terminalId, data }) => {
            const terminalData = this.terminalManager.getTerminal(terminalId);
            if (terminalData && !terminalData.isClosing) {
                terminalData.terminal.write(data);
                terminalData.lastOutput = data;
                terminalData.lastActivity = Date.now();
                
                // Update legacy reference for active terminal
                if (terminalId === this.terminalManager.activeTerminalId) {
                    this.lastTerminalOutput = data;
                }
                
                // Process terminal output for various features
                this.processTerminalOutput(terminalId, data);
            }
        });

        // Terminal exit handler
        ipcRenderer.on('terminal-exit', (event, { terminalId, exitCode }) => {
            this.logAction(`Terminal ${terminalId} exited with code ${exitCode}`, 'info');
            this.terminalManager.closeTerminal(terminalId);
        });

        // Terminal ready handler
        ipcRenderer.on('terminal-ready', (event, { terminalId }) => {
            this.logAction(`Terminal ${terminalId} is ready`, 'info');
            const terminalData = this.terminalManager.getTerminal(terminalId);
            if (terminalData) {
                terminalData.status = 'ready';
            }
        });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Skip if typing in input field (unless specifically allowed)
            if (this.isTypingInInputField(e)) {
                return;
            }

            // Check for modal interference
            if (this.modalManager.hasActiveModals()) {
                return; // Let modals handle their own shortcuts
            }

            const isCmd = this.isCommandKey(e);
            
            // Timer shortcuts
            if (isCmd && e.key === 'p') {
                e.preventDefault();
                this.timerController.toggleTimer();
                this.logAction('Timer toggled via keyboard shortcut', 'info');
            }
            
            if (isCmd && e.shiftKey && e.key === 'S') {
                e.preventDefault();
                this.timerController.stopTimer();
                this.logAction('Timer stopped via keyboard shortcut', 'info');
            }
            
            // Terminal shortcuts
            if (isCmd && e.key === 't') {
                e.preventDefault();
                this.terminalManager.addTerminal();
            }
            
            // Message shortcuts
            if (isCmd && e.key === 'Enter') {
                e.preventDefault();
                this.messageQueue.handleMessageUpdate();
            }
            
            // Settings shortcut
            if (isCmd && e.key === ',') {
                e.preventDefault();
                this.modalManager.showSettingsModal();
            }

            // Timer edit shortcut
            if (isCmd && e.key === 'b') {
                e.preventDefault();
                this.focusTimerEdit();
                this.logAction('Timer edit focused via keyboard shortcut', 'info');
            }
        });
    }

    setupUIEventHandlers() {
        // Message input handler
        const messageInput = document.getElementById('message-input');
        if (messageInput) {
            messageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.messageQueue.handleMessageUpdate();
                }
                if (e.key === 'Escape') {
                    this.messageQueue.cancelEdit();
                }
            });

            messageInput.addEventListener('input', () => {
                this.autoResizeMessageInput(messageInput);
            });
        }

        // Auto-continue button
        const autoContinueBtn = document.getElementById('auto-continue-btn');
        if (autoContinueBtn) {
            autoContinueBtn.addEventListener('click', () => {
                this.toggleAutoContinue();
            });
        }

        // Plan mode button
        const planModeBtn = document.getElementById('plan-mode-btn');
        if (planModeBtn) {
            planModeBtn.addEventListener('click', () => {
                this.togglePlanMode();
            });
        }

        // Voice recording button
        const voiceBtn = document.getElementById('voice-btn');
        if (voiceBtn) {
            voiceBtn.addEventListener('click', () => {
                this.toggleVoiceRecording();
            });
        }

        // Clear queue button
        const clearQueueBtn = document.getElementById('clear-queue-header-btn');
        if (clearQueueBtn) {
            clearQueueBtn.addEventListener('click', () => {
                this.messageQueue.clearQueue();
            });
        }

        // Add message button
        const addMessageBtn = document.getElementById('send-btn');
        if (addMessageBtn) {
            addMessageBtn.addEventListener('click', () => {
                this.messageQueue.handleMessageUpdate();
            });
        }
    }

    setupDragAndDrop() {
        let dragCounter = 0;
        
        const dropOverlay = document.getElementById('drop-overlay');
        
        document.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            if (dragCounter === 1) {
                this.highlight(dropOverlay);
            }
        });
        
        document.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter === 0) {
                this.unhighlight(dropOverlay);
            }
        });
        
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
        });
        
        document.addEventListener('drop', (e) => {
            e.preventDefault();
            dragCounter = 0;
            this.unhighlight(dropOverlay);
            this.handleFileDrop(e);
        });
    }

    setupWindowEventHandlers() {
        // Theme change detection
        if (this.preferences.theme === 'system') {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            mediaQuery.addEventListener('change', () => {
                this.terminalManager.updateTerminalThemes();
            });
        }
    }

    // Core functionality methods that coordinate between modules

    processTerminalOutput(terminalId, data) {
        // Delegate to injection manager and other processors
        if (this.injectionManager) {
            this.injectionManager.processTerminalOutput(terminalId, data);
        }
        
        // Update terminal status
        this.terminalManager.updateTerminalStatus(terminalId, 'active');
        
        // Handle directory changes, usage limits, etc.
        this.handleTerminalOutputAnalysis(terminalId, data);
    }

    handleTerminalOutputAnalysis(terminalId, data) {
        // Directory change detection
        const directoryMatch = data.match(/(?:^|\n)([^>\n]*?)[\$#%>]\s*$/);
        if (directoryMatch) {
            const potentialDir = directoryMatch[1].trim();
            if (potentialDir && potentialDir !== this.terminalManager.currentDirectory) {
                this.terminalManager.setCurrentDirectory(potentialDir);
            }
        }

        // Usage limit detection
        this.detectUsageLimit(data);
        
        // Auto-continue detection
        this.detectAutoContinuePrompts(data);
        
        // Keyword detection
        this.detectKeywords(terminalId, data);
    }

    detectUsageLimit(data) {
        // Usage limit detection logic
        const usageLimitPattern = /usage limit.*?reset.*?(\d{1,2})(am|pm)/i;
        const match = data.match(usageLimitPattern);
        
        if (match) {
            const resetHour = parseInt(match[1]);
            const ampm = match[2].toLowerCase();
            
            this.modalManager.showUsageLimitModal(resetHour, ampm);
        }
    }

    detectAutoContinuePrompts(data) {
        // Auto-continue prompt detection
        if (this.autoContinueEnabled) {
            const continuePattern = /(continue|proceed|press.*enter)/i;
            if (continuePattern.test(data)) {
                this.handleAutoContinuePrompt(data);
            }
        }
    }

    detectKeywords(terminalId, data) {
        // Keyword detection and response
        if (this.preferences.keywordRules) {
            this.preferences.keywordRules.forEach(rule => {
                if (data.includes(rule.keyword)) {
                    this.handleKeywordDetected(terminalId, rule);
                }
            });
        }
    }

    handleAutoContinuePrompt(data) {
        // Implement auto-continue logic
        this.logAction('Auto-continue prompt detected', 'info');
        // Add continue message to queue
        this.messageQueue.addMessage('continue');
    }

    handleKeywordDetected(terminalId, rule) {
        this.logAction(`Keyword detected: "${rule.keyword}" -> "${rule.response}"`, 'info');
        this.messageQueue.addMessage(rule.response, terminalId);
    }

    // UI utility methods

    autoResizeMessageInput(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }

    highlight(dropOverlay) {
        if (dropOverlay) {
            dropOverlay.style.display = 'flex';
        }
    }

    unhighlight(dropOverlay) {
        if (dropOverlay) {
            dropOverlay.style.display = 'none';
        }
    }

    handleFileDrop(e) {
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            const imageFiles = files.filter(file => file.type.startsWith('image/'));
            if (imageFiles.length > 0) {
                this.messageQueue.addImagePreviews(imageFiles);
                this.messageQueue.setAttachedFiles(files);
            }
        }
    }

    focusTimerEdit() {
        const editBtn = document.getElementById('timer-edit-btn');
        if (editBtn) {
            const syntheticEvent = { preventDefault: () => {} };
            this.timerController.openTimerEditDropdown(syntheticEvent);
        }
    }

    // Feature toggle methods

    toggleAutoContinue() {
        this.autoContinueEnabled = !this.autoContinueEnabled;
        this.preferences.autoContinueEnabled = this.autoContinueEnabled;
        this.saveAllPreferences();
        this.updateAutoContinueButtonState();
        this.logAction(`Auto-continue ${this.autoContinueEnabled ? 'enabled' : 'disabled'}`, 'info');
    }

    togglePlanMode() {
        this.planModeEnabled = !this.planModeEnabled;
        this.preferences.planModeEnabled = this.planModeEnabled;
        this.saveAllPreferences();
        this.updatePlanModeButtonState();
        this.logAction(`Plan mode ${this.planModeEnabled ? 'enabled' : 'disabled'}`, 'info');
    }

    updateAutoContinueButtonState() {
        const btn = document.getElementById('auto-continue-btn');
        if (btn) {
            btn.classList.toggle('active', this.autoContinueEnabled);
            btn.title = this.autoContinueEnabled ? 'Disable auto-continue' : 'Enable auto-continue';
        }
    }

    updatePlanModeButtonState() {
        const btn = document.getElementById('plan-mode-btn');
        if (btn) {
            btn.classList.toggle('active', this.planModeEnabled);
            btn.title = this.planModeEnabled ? 'Disable plan mode' : 'Enable plan mode';
        }
    }

    toggleVoiceRecording() {
        // Voice recording toggle logic
        if (this.isRecording) {
            this.stopVoiceRecording();
        } else {
            this.startVoiceRecording();
        }
    }

    startVoiceRecording() {
        // Implement voice recording start
        this.isRecording = true;
        this.updateVoiceButtonState();
        this.logAction('Voice recording started', 'info');
    }

    stopVoiceRecording() {
        // Implement voice recording stop
        this.isRecording = false;
        this.updateVoiceButtonState();
        this.logAction('Voice recording stopped', 'info');
    }

    updateVoiceButtonState() {
        const btn = document.getElementById('voice-btn');
        if (btn) {
            btn.classList.toggle('active', this.isRecording);
            btn.title = this.isRecording ? 'Stop recording' : 'Start voice recording';
        }
    }

    // Logging and action tracking

    logAction(message, level = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = {
            timestamp: Date.now(),
            message: message,
            level: level,
            formattedTime: timestamp
        };
        
        this.actionLog.push(logEntry);
        
        // Keep only last 1000 entries
        if (this.actionLog.length > 1000) {
            this.actionLog = this.actionLog.slice(-1000);
        }
        
        // Update action log display if visible
        this.updateActionLogDisplay();
        
        // Console output with level
        const levelColors = {
            'info': '\x1b[36m',
            'success': '\x1b[32m',
            'warning': '\x1b[33m',
            'error': '\x1b[31m',
            'debug': '\x1b[35m'
        };
        
        const color = levelColors[level] || '\x1b[0m';
        this.directLog(`${color}[${timestamp}] ${message}\x1b[0m`);
    }

    updateActionLogDisplay() {
        const actionLogContainer = document.getElementById('action-log-content');
        if (actionLogContainer && actionLogContainer.style.display !== 'none') {
            // Update action log display
            const logHtml = this.actionLog.slice(-50).map(entry => 
                `<div class="log-entry log-${entry.level}">
                    <span class="log-time">[${entry.formattedTime}]</span>
                    <span class="log-message">${entry.message}</span>
                </div>`
            ).join('');
            actionLogContainer.innerHTML = logHtml;
            actionLogContainer.scrollTop = actionLogContainer.scrollHeight;
        }
    }

    // Preferences management

    async loadAllPreferences() {
        try {
            if (this.ipcRenderer) {
                const savedPrefs = await this.ipcRenderer.invoke('db-get-setting', 'preferences');
                if (savedPrefs) {
                    this.preferences = { ...this.getDefaultPreferences(), ...savedPrefs };
                }
                
                // Load additional state
                this.usageLimitWaiting = await this.ipcRenderer.invoke('db-get-setting', 'usageLimitWaiting') || false;
                this.actionLog = await this.ipcRenderer.invoke('db-get-setting', 'actionLog') || [];
                
                // Load terminal data
                this.savedTerminalData = await this.ipcRenderer.invoke('db-get-setting', 'terminalStates');
            }
        } catch (error) {
            this.directLog('Error loading preferences:', error);
        }
    }

    saveAllPreferences() {
        try {
            // Save main preferences
            this.preferences.messageQueue = this.messageQueue?.messageQueue || [];
            this.preferences.currentDirectory = this.terminalManager?.currentDirectory;
            this.preferences.recentDirectories = this.terminalManager?.recentDirectories || [];
            
            if (this.ipcRenderer) {
                this.ipcRenderer.invoke('db-save-setting', 'preferences', this.preferences);
                this.ipcRenderer.invoke('db-save-setting', 'usageLimitWaiting', this.usageLimitWaiting);
                this.ipcRenderer.invoke('db-save-setting', 'actionLog', this.actionLog.slice(-1000));
            }
        } catch (error) {
            this.directLog('Error saving preferences:', error);
        }
    }

    // Background service management

    enableBackgroundService() {
        if (!this.backgroundServiceActive) {
            this.backgroundServiceActive = true;
            if (this.preferences.keepScreenAwake) {
                this.ipcRenderer?.invoke('enable-power-save-blocker');
                this.powerSaveBlockerActive = true;
            }
            this.logAction('Background service enabled', 'info');
        }
    }

    disableBackgroundService() {
        if (this.backgroundServiceActive) {
            this.backgroundServiceActive = false;
            if (this.powerSaveBlockerActive) {
                this.ipcRenderer?.invoke('disable-power-save-blocker');
                this.powerSaveBlockerActive = false;
            }
            this.logAction('Background service disabled', 'info');
        }
    }

    // System notifications

    showSystemNotification(title, body) {
        if (this.preferences.showSystemNotifications) {
            try {
                if ('Notification' in window && Notification.permission === 'granted') {
                    new Notification(title, { body });
                } else if (this.ipcRenderer) {
                    this.ipcRenderer.invoke('show-notification', { title, body });
                }
            } catch (error) {
                this.directLog('Error showing notification:', error);
            }
        }
    }

    // Theme management

    applyTheme(theme) {
        this.preferences.theme = theme;
        this.saveAllPreferences();
        
        // Apply to terminals
        this.terminalManager?.applyTheme(theme);
        
        // Apply to document
        document.documentElement.setAttribute('data-theme', theme);
        
        this.logAction(`Theme changed to ${theme}`, 'info');
    }

    // Legacy compatibility getters/setters for modules that depend on these

    get terminal() {
        return this.terminalManager?.terminal;
    }

    get fitAddon() {
        return this.terminalManager?.fitAddon;
    }

    get terminals() {
        return this.terminalManager?.terminals;
    }

    get activeTerminalId() {
        return this.terminalManager?.activeTerminalId;
    }

    get currentDirectory() {
        return this.terminalManager?.currentDirectory;
    }

    get messageQueue() {
        return this.messageQueue?.messageQueue || [];
    }

    get timerActive() {
        return this.timerController?.timerActive || false;
    }

    get timerExpired() {
        return this.timerController?.timerExpired || false;
    }
}

// Initialize the application
const gui = new TerminalGUI();

// Export for global access (needed for some UI event handlers)
window.gui = gui;