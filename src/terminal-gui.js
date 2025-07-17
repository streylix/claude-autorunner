/**
 * Refactored TerminalGUI Class
 * Main application class that orchestrates all components
 */

const PlatformUtils = require('./utils/platform-utils');
const DomUtils = require('./utils/dom-utils');
const ValidationUtils = require('./utils/validation');
const IPCHandler = require('./core/ipc-handler');
const TerminalManager = require('./core/terminal-manager');
const MessageQueueManager = require('./features/message-queue/queue-manager');
const InjectionManager = require('./messaging/injection-manager');

class TerminalGUI {
    constructor() {
        // Initialize utilities
        this.platformUtils = new PlatformUtils();
        this.validationUtils = new ValidationUtils();
        this.ipcHandler = new IPCHandler();
        
        // Platform detection from utility
        this.isMac = this.platformUtils.isMac;
        this.keySymbols = this.platformUtils.keySymbols;
        
        // Application session ID for statistics
        this.sessionId = this.validationUtils.generateSessionId('app');
        
        // State tracking
        this.injectionCount = 0;
        this.keywordCount = 0;
        this.promptCount = 0;
        this.lastAssignedTerminalId = 0;
        this.previousTerminalStatuses = new Map();
        
        // Auto-continue and detection state
        this.usageLimitTerminals = new Set();
        this.continueTargetTerminals = new Set();
        this.keywordResponseTerminals = new Map();
        this.currentDirectory = null;
        this.recentDirectories = [];
        this.maxRecentDirectories = 5;
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
        
        // Initialize preferences with defaults
        this.preferences = {
            autoscrollEnabled: true,
            autoscrollDelay: 3000,
            autoContinueEnabled: false,
            planModeEnabled: false,
            planModeCommand: 'npx claude-flow@alpha hive-mind spawn "{message}" --agents 5 --strategy development --claude',
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
            automaticTodoGeneration: false
        };
        
        // Usage limit and sync state
        this.usageLimitSyncInterval = null;
        this.usageLimitResetTime = null;
        this.autoSyncEnabled = true;
        this.pendingUsageLimitReset = null;
        this.safetyCheckCount = 0;
        this.safetyCheckInterval = null;
        
        // Timer system
        this.timerActive = false;
        this.timerHours = 0;
        this.timerMinutes = 0;
        this.timerSeconds = 0;
        this.timerInterval = null;
        this.timerExpired = false;
        this.injectionInProgress = false;
        this.injectionPaused = false;
        this.injectionPausedByTimer = false;
        this.pausedMessageContent = null;
        this.pausedMessageIndex = 0;
        this.currentTypeInterval = null;
        this.usageLimitModalShowing = false;
        this.usageLimitWaiting = false;
        this.usageLimitCooldownUntil = null;
        this.usageLimitTimerOriginalValues = null;
        
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
        
        // 3-minute delay mechanism for todo generation
        this.terminalStabilityTracking = new Map();
        this.todoGenerationCooldown = 3 * 60 * 1000; // 3 minutes in milliseconds
        
        // Terminal idle tracking for completion sound
        this.terminalIdleTimer = null;
        this.terminalIdleStartTime = null;
        
        // Message history tracking
        this.messageHistory = [];
        
        // Background service state
        this.powerSaveBlockerActive = false;
        this.backgroundServiceActive = false;
        
        // Initialize core managers
        this.terminalManager = new TerminalManager(this.ipcHandler, this.preferences);
        this.messageQueueManager = new MessageQueueManager(this.ipcHandler, this);
        
        // Initialize injection manager (keeping existing interface for now)
        this.injectionManager = new InjectionManager(this);
        
        // Legacy properties for backward compatibility
        this.terminals = this.terminalManager.terminals;
        this.activeTerminalId = this.terminalManager.activeTerminalId;
        this.terminalIdCounter = this.terminalManager.terminalIdCounter;
        this.terminalColors = this.terminalManager.terminalColors;
        this.terminalSessionMap = this.terminalManager.terminalSessionMap;
        this.terminalStatuses = this.terminalManager.terminalStatuses;
        this.terminal = this.terminalManager.terminal;
        this.fitAddon = this.terminalManager.fitAddon;
        this.messageQueue = this.messageQueueManager.messageQueue;
        
        // Add global console error protection to prevent EIO crashes
        this.setupConsoleErrorProtection();
        
        // Initialize the application asynchronously
        this.initialize();
    }

    // ========================================
    // Platform Utilities (delegated)
    // ========================================

    formatKeyboardShortcut(shortcut) {
        return this.platformUtils.formatKeyboardShortcut(shortcut);
    }

    isCommandKey(e) {
        return this.platformUtils.isCommandKey(e);
    }

    isTypingInInputField(e) {
        return this.platformUtils.isTypingInInputField(e);
    }

    updatePlatformSpecificShortcuts() {
        this.platformUtils.updatePlatformSpecificShortcuts();
    }

    // ========================================
    // DOM Utilities (delegated)
    // ========================================

    safeAddEventListener(elementId, event, handler) {
        return DomUtils.safeAddEventListener(elementId, event, handler);
    }

    // ========================================
    // Console Error Protection
    // ========================================

    setupConsoleErrorProtection() {
        // Wrap console methods to prevent EIO crashes
        const originalConsole = {
            log: console.log,
            warn: console.warn,
            error: console.error
        };
        
        this.originalConsole = originalConsole;
        this.lastConsoleOutput = {};
        
        const safeConsole = (method, originalMethod) => {
            return (...args) => {
                try {
                    originalMethod.apply(console, args);
                } catch (error) {
                    // Silently ignore console errors to prevent EIO crashes
                }
            };
        };

        // Apply safe console wrappers
        console.log = safeConsole('log', originalConsole.log);
        console.warn = safeConsole('warn', originalConsole.warn);
        console.error = safeConsole('error', originalConsole.error);

        // Add throttled console for high-frequency logs
        const throttleMs = 1000;
        const throttledConsole = (method, originalMethod) => {
            return (...args) => {
                const now = Date.now();
                if (!this.lastConsoleOutput[method] || now - this.lastConsoleOutput[method] > throttleMs) {
                    this.lastConsoleOutput[method] = now;
                    try {
                        originalMethod.apply(console, args);
                    } catch (error) {
                        // Silently ignore
                    }
                }
            };
        };

        // Apply throttled console for specific cases
        console.log = throttledConsole('log', originalConsole.log);
        console.warn = throttledConsole('warn', originalConsole.warn);
        console.error = throttledConsole('error', originalConsole.error);
    }

    directLog(message, level = 'log') {
        try {
            if (this.originalConsole && this.originalConsole[level]) {
                this.originalConsole[level]('[DEBUG]', message);
            }
        } catch (error) {
            // Silently ignore
        }
        
        // Fallback to regular console
        try {
            console.log('[DEBUG]', message);
        } catch (error) {
            // Silently ignore
        }
    }

    // ========================================
    // Initialization
    // ========================================

    async initialize() {
        try {
            this.directLog('Initializing TerminalGUI...');
            
            // Load preferences first
            await this.loadAllPreferences();
            
            // Check for backend availability
            if (typeof BackendAPIClient !== 'undefined') {
                try {
                    this.backendAPIClient = new BackendAPIClient();
                    const isBackendAvailable = await this.backendAPIClient.isBackendAvailable();
                    if (isBackendAvailable) {
                        console.log('Backend is available - enabling enhanced persistence');
                        
                        // Enable backend features
                        this.backendAvailable = true;
                        
                        // Start polling for message updates instead of WebSocket (for now)
                        this.startMessageQueuePolling();
                    } else {
                        console.warn('Backend is not available - using local-only mode');
                        this.backendAvailable = false;
                    }
                } catch (error) {
                    console.warn('Failed to initialize backend connection:', error);
                    this.backendAvailable = false;
                }
            }
            
            // Initialize UI components
            this.initializeLucideIcons();
            this.updatePlatformSpecificShortcuts();
            
            // Initialize managers
            this.injectionManager.initialize();
            
            // Initialize application state
            this.initializeTerminal();
            this.setupEventListeners();
            this.applyTheme(this.preferences.theme);
            
            // Handle timer recovery
            if (this.timerExpired) {
                this.injectionManager.onTimerExpired();
            }
            
            if (this.timerExpired || this.usageLimitWaiting) {
                this.injectionManager.updateVisualState();
            }
            
            this.directLog('TerminalGUI initialization complete');
        } catch (error) {
            this.directLog('Error during app initialization: ' + error.message);
            console.error('Initialization error:', error);
        }
    }

    initializeLucideIcons() {
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
            
            setTimeout(() => {
                lucide.createIcons();
            }, 100);
        }
    }

    // ========================================
    // Terminal Management (delegated)
    // ========================================

    initializeTerminal() {
        // Delegate to terminal manager
        return this.terminalManager.initializeTerminal();
    }

    createTerminal(id) {
        return this.terminalManager.createTerminal(id);
    }

    createAdditionalTerminalFromData(termData) {
        return this.terminalManager.createAdditionalTerminalFromData(termData);
    }

    resizeAllTerminals() {
        return this.terminalManager.resizeAllTerminals();
    }

    getTerminalTheme() {
        return this.terminalManager.getTerminalTheme();
    }

    getDarkTerminalTheme() {
        return this.terminalManager.getDarkTerminalTheme();
    }

    getLightTerminalTheme() {
        return this.terminalManager.getLightTerminalTheme();
    }

    applyTheme(theme) {
        this.preferences.theme = theme;
        
        // Apply theme to document
        if (theme === 'system') {
            document.documentElement.setAttribute('data-theme', 'system');
        } else {
            document.documentElement.setAttribute('data-theme', theme);
        }
        
        // Apply theme to terminals
        this.terminalManager.applyTheme(theme);
    }

    // ========================================
    // Message Queue Management (delegated)
    // ========================================

    async addMessageToQueue() {
        const input = document.getElementById('message-input');
        const content = input.value.trim();
        
        if (content) {
            const message = await this.messageQueueManager.addMessage(
                content, 
                this.activeTerminalId,
                { planModeEnabled: this.preferences.planModeEnabled }
            );
            
            if (message) {
                input.value = '';
                this.autoResizeMessageInput(input);
                this.updateMessageList();
                this.updateStatusDisplay();
                this.updateTrayBadge();
                
                const terminalData = this.terminals.get(message.terminalId);
                const terminalName = terminalData ? terminalData.name : `Terminal ${message.terminalId}`;
                this.logAction(`Added message to queue for ${terminalName}: "${content}"`, 'info');
            }
        }
    }

    updateMessage(messageId, newContent) {
        const success = this.messageQueueManager.updateMessage(messageId, newContent);
        if (success) {
            this.updateMessageList();
            this.updateStatusDisplay();
        }
        return success;
    }

    deleteMessage(messageId) {
        const success = this.messageQueueManager.deleteMessage(messageId);
        if (success) {
            this.updateMessageList();
            this.updateStatusDisplay();
            this.updateTrayBadge();
        }
        return success;
    }

    clearQueue() {
        const count = this.messageQueueManager.clearQueue();
        if (count > 0) {
            this.updateMessageList();
            this.updateStatusDisplay();
            this.updateTrayBadge();
        }
        return count;
    }

    // ========================================
    // Event Handling for Module Integration
    // ========================================

    emit(eventName, data) {
        // Handle events from modules
        switch (eventName) {
            case 'messageAdded':
            case 'messageUpdated':
            case 'messageDeleted':
            case 'queueCleared':
            case 'queueUpdated':
                this.updateMessageList();
                this.updateStatusDisplay();
                this.updateTrayBadge();
                break;
                
            case 'specialCommand':
                this.handleSpecialCommand(data);
                break;
                
            default:
                console.log(`Unhandled event: ${eventName}`, data);
        }
    }

    handleSpecialCommand(data) {
        // Handle special commands from message queue manager
        switch (data.type) {
            case 'usage-limit-status':
                // Implementation would go here
                this.logAction('Usage limit status requested', 'info');
                break;
                
            case 'usage-limit-reset':
                // Implementation would go here
                this.logAction('Usage limit reset requested', 'info');
                break;
                
            case 'help':
                // Implementation would go here
                this.logAction('Help requested', 'info');
                break;
        }
    }

    // ========================================
    // Placeholder Methods (to be implemented)
    // ========================================

    setupEventListeners() {
        // This will be implemented as we extract more components
        this.directLog('setupEventListeners - to be implemented');
    }

    updateMessageList() {
        this.directLog('updateMessageList - to be implemented');
    }

    updateStatusDisplay() {
        this.directLog('updateStatusDisplay - to be implemented');
    }

    updateTrayBadge() {
        this.directLog('updateTrayBadge - to be implemented');
    }

    autoResizeMessageInput(input) {
        this.directLog('autoResizeMessageInput - to be implemented');
    }

    logAction(message, level = 'info') {
        this.directLog(`[${level.toUpperCase()}] ${message}`);
    }

    async loadAllPreferences() {
        this.directLog('loadAllPreferences - to be implemented');
    }

    startMessageQueuePolling() {
        this.directLog('startMessageQueuePolling - to be implemented');
    }

    // ========================================
    // Cleanup
    // ========================================

    cleanup() {
        if (this.terminalManager) {
            this.terminalManager.cleanup();
        }
        
        if (this.messageQueueManager) {
            this.messageQueueManager.cleanup();
        }
        
        if (this.ipcHandler) {
            this.ipcHandler.cleanup();
        }
    }
}

// Initialize when DOM is ready
if (typeof window !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        window.terminalGUI = new TerminalGUI();
    });
}

module.exports = TerminalGUI;