const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const InjectionManager = require('./src/messaging/injection-manager');
// Import new modular components
const PlatformUtils = require('./src/utils/platform-utils');
const DomUtils = require('./src/utils/dom-utils');
const ValidationUtils = require('./src/utils/validation');
const IPCHandler = require('./src/core/ipc-handler');
class TerminalGUI {
    constructor() {
        // Initialize utility classes
        this.platformUtils = new PlatformUtils();
        this.validationUtils = new ValidationUtils();
        this.ipcHandler = new IPCHandler();
        // Platform detection for keyboard shortcuts (keep for backward compatibility)
        this.isMac = this.platformUtils.isMac;
        this.keySymbols = this.platformUtils.keySymbols;
        // Multi-terminal support
        this.terminals = new Map(); // Map of terminal ID to terminal data
        this.activeTerminalId = 1;
        this.terminalIdCounter = 1;
        this.terminalColors = ['#007acc', '#28ca42', '#ff5f57', '#ffbe2e', '#af52de', '#5ac8fa'];
        this.pendingTerminalData = new Map(); // Queue data for terminals not yet initialized
        this.terminalSessionMap = new Map(); // Map of terminal ID to backend session UUID
        // Application session ID for statistics
        this.sessionId = this.validationUtils.generateSessionId('app');
        // Legacy single terminal references (will be updated to use active terminal)
        this.terminal = null;
        this.fitAddon = null;
        this.messageQueue = [];
        this.injectionTimer = null;
        this.schedulingInProgress = false; // Prevent concurrent scheduling calls
        this.injectionCount = 0;
        this.keywordCount = 0;
        this.promptCount = 0;
        this.currentlyInjectingMessages = new Set(); // Track messages being injected per terminal
        this.currentlyInjectingTerminals = new Set(); // Track which terminals are currently injecting
        this.terminalStabilityTimers = new Map(); // Track per-terminal stability start times
        this.lastAssignedTerminalId = 0; // For round-robin terminal assignment
        this.previousTerminalStatuses = new Map(); // Track previous status for each terminal for sound triggering
        // Terminal-specific tracking for auto-continue, keyword detection, and timer targeting
        this.usageLimitTerminals = new Set(); // Track terminals that received usage limit messages
        this.continueTargetTerminals = new Set(); // Track terminals that should receive continue messages
        this.keywordResponseTerminals = new Map(); // Track terminals that need keyword responses
        this.processedUsageLimitMessages = new Set(); // Track processed usage limit messages to prevent duplicates
        this.processedPrompts = new Set(); // Track processed prompts to prevent duplicates
        this.currentDirectory = null; // Will be set when terminal starts or directory is detected
        this.recentDirectories = []; // Track recent directories for dropdown
        this.maxRecentDirectories = 5; // Maximum number of recent directories to keep
        this.isInjecting = false;
        this.messageIdCounter = 1;
        this.messageSequenceCounter = 0;
        this.autoContinueEnabled = false;
        this.planModeEnabled = false;
        this.planModeCommand = 'npx claude-flow@alpha hive-mind spawn "{message}" --agents 5 --strategy development --claude';
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
        this.isDragging = false; // Track drag state to prevent stuttering
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
            promptRules: [], // Store detected prompts
            // Add timer persistence
            timerHours: 0,
            timerMinutes: 0,
            timerSeconds: 0,
            // Add message queue persistence
            messageQueue: [],
            // Add directory persistence
            currentDirectory: null,
            recentDirectories: [],
            // Add sound effects preferences
            completionSoundEnabled: false,
            completionSoundFile: 'beep.wav',
            // Add sidebar width persistence
            leftSidebarWidth: 300,
            rightSidebarWidth: 400,
            injectionSoundFile: 'click.wav',
            promptedSoundFile: 'gmod.wav',
            promptedSoundKeywordsOnly: false,
            // Add message history
            messageHistory: [],
            // Add usage limit waiting state persistence
            usageLimitWaiting: false,
            // Background service preferences
            keepScreenAwake: true,
            showSystemNotifications: true,
            minimizeToTray: true,
            startMinimized: false,
            // Todo generation preferences
            automaticTodoGeneration: false
        };
        this.usageLimitSyncInterval = null;
        this.usageLimitResetTime = null;
        this.autoSyncEnabled = true; // Auto-sync until user manually changes timer
        this.pendingUsageLimitReset = null; // Store reset info until user makes choice
        this.safetyCheckCount = 0;
        this.safetyCheckInterval = null;
        // New timer system
        this.timerActive = false;
        this.timerHours = 0;
        this.timerMinutes = 0;
        this.timerSeconds = 0;
        this.timerInterval = null;
        this.timerExpired = false;
        this.injectionInProgress = false;
        this.injectionPaused = false;
        this.injectionPausedByTimer = false; // Track if injection was paused by timer
        this.pausedMessageContent = null;
        this.pausedMessageIndex = 0;
        this.currentTypeInterval = null;
        this.usageLimitModalShowing = false;
        this.usageLimitWaiting = false;
        this.usageLimitCooldownUntil = null; // Timestamp when usage limit detection cooldown ends
        this.usageLimitTimerOriginalValues = null; // Store original timer values when setting usage limit timer
        // Voice recording state
        this.isRecording = false;
        this.mediaRecorder = null;
        this.audioChunks = [];
        // Message editing state
        this.editingMessageId = null;
        this.originalEditContent = null;
        this.currentlyInjectingMessageId = null;
        // Terminal status scanning system
        this.terminalScanInterval = null;
        this.currentTerminalStatus = {
            isRunning: false,
            isPrompting: false,
            lastUpdate: Date.now()
        };
        this.terminalStatuses = new Map(); // Per-terminal status tracking
        // 3-minute delay mechanism for todo generation
        this.terminalStabilityTracking = new Map(); // Track stability for each terminal
        this.todoGenerationCooldown = 3 * 60 * 1000; // 3 minutes in milliseconds
        // Terminal idle tracking for completion sound
        this.terminalIdleTimer = null;
        this.terminalIdleStartTime = null;
        // Message history tracking
        this.messageHistory = [];
        // Background service state
        this.powerSaveBlockerActive = false;
        this.backgroundServiceActive = false;
        // Initialize injection manager
        this.injectionManager = new InjectionManager(this);
        // Add global console error protection to prevent EIO crashes
        this.setupConsoleErrorProtection();
        // Initialize the application asynchronously
        this.initialize();
    }
    // Utility method to safely add event listeners
    safeAddEventListener(elementId, event, handler) {
        return DomUtils.safeAddEventListener(elementId, event, handler);
    }
    // Helper method to update preference and save
    updatePref(key, value) { this.preferences[key] = value; this.saveAllPreferences(); }
    setupConsoleErrorProtection() {
        // Wrap console methods to prevent EIO crashes
        const originalConsole = {
            log: console.log,
            warn: console.warn,
            error: console.error
        };
        const safeConsole = (method, originalMethod) => {
            return (...args) => {
                try {
                    originalMethod.apply(console, args);
                } catch (error) {
                    // Silently ignore console errors to prevent EIO crashes
                    // The error is likely due to stream issues, not our code
                }
            };
        };
        // Replace console methods with safe versions
        console.log = safeConsole('log', originalConsole.log);
        console.warn = safeConsole('warn', originalConsole.warn);
        console.error = safeConsole('error', originalConsole.error);
        // Throttle console usage to prevent overwhelming
        this.lastConsoleOutput = {};
        const throttleMs = 100; // Limit console output to once per 100ms per type
        const throttledConsole = (method, originalMethod) => {
            return (...args) => {
                const now = Date.now();
                if (!this.lastConsoleOutput[method] || now - this.lastConsoleOutput[method] > throttleMs) {
                    this.lastConsoleOutput[method] = now;
                    try {
                        originalMethod.apply(console, args);
                    } catch (error) {
                        // Silently ignore console errors
                    }
                }
            };
        };
        // Apply throttling to reduce console spam
        console.log = throttledConsole('log', originalConsole.log);
        console.warn = throttledConsole('warn', originalConsole.warn);
        console.error = throttledConsole('error', originalConsole.error);
        // Store original console methods for direct logging that bypasses throttling
        this.originalConsole = originalConsole;
    }
    // Direct logging method that bypasses throttling for debugging
    directLog(message, level = 'log') {
        try {
            if (this.originalConsole && this.originalConsole[level]) {
                this.originalConsole[level]('[DEBUG]', message);
            }
        } catch (error) {
            // Fallback to regular console if direct logging fails
            console.log('[DEBUG]', message);
        }
    }
    async initialize() {
        try {
            // Load preferences FIRST so we have saved directory before starting terminal
            await this.loadAllPreferences();
            // Load terminal session mapping
            await this.loadTerminalSessionMapping();
            // Load terminal state BEFORE initializing terminals
            await this.loadTerminalState();
            // Initialize backend API client before terminal initialization
            if (typeof BackendAPIClient !== 'undefined') {
                this.backendAPIClient = new BackendAPIClient();
                // Test backend connectivity
                const isBackendAvailable = await this.backendAPIClient.isBackendAvailable();
                if (isBackendAvailable) {
                    console.log('Backend is available - enabling enhanced persistence');
                    // Force sync all backend sessions with frontend terminals
                    await this.forceSyncAllSessions();
                    // Load status from backend
                    await this.loadStatusFromBackend();
                    // Start polling for message updates instead of WebSocket (for now)
                    this.startMessageQueuePolling();
                } else {
                    console.warn('Backend is not available - using local-only mode');
                    this.backendAPIClient = null; // Disable backend calls
                }
            }
            this.initializeTerminal();
            // Restore terminal data after terminals are created
            this.restoreTerminalData();
            this.setupEventListeners();
            this.setupResizeHandlers();
            // Initialize injection manager after terminal setup
            this.injectionManager.initialize();
            this.initializeLucideIcons();
            this.updateStatusDisplay();
            this.setTerminalStatusDisplay(''); // Initialize with default status
            this.updateTimerUI(); // Initialize timer UI after loading preferences
            // If timer was expired on startup, trigger injection manager
            if (this.timerExpired) {
                this.injectionManager.onTimerExpired();
            }
            // Update visual state after all initialization is complete
            if (this.timerExpired || this.usageLimitWaiting) {
                this.injectionManager.updateVisualState();
            }
            // Setup background service functionality
            this.setupTrayEventListeners();
            this.updateTrayBadge();
            // Initialize todo system
            await this.initializeTodoSystem();
            // Clean up any orphaned terminal selector items from previous sessions
            this.cleanupOrphanedTerminalSelectorItems();
            // Log using direct console method to bypass throttling
            this.directLog('App initialization completed successfully');
        } catch (error) {
            this.directLog('Error during app initialization: ' + error.message);
        }
        this.startTerminalStatusScanning(); // Start the continuous terminal scanning
    }
    initializeLucideIcons() {
        // Initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
            // Force re-initialization after a short delay to ensure DOM is ready
            setTimeout(() => {
                lucide.createIcons();
                // Update platform-specific shortcuts after icons are ready
                this.updatePlatformSpecificShortcuts();
            }, 100);
        }
    }
    formatKeyboardShortcut(shortcut) {
        return this.platformUtils.formatKeyboardShortcut(shortcut);
    }
    // Helper function to detect the correct modifier key for the platform
    isCommandKey(e) {
        return this.platformUtils.isCommandKey(e);
    }
    // Helper function to check if user is typing in an input field
    isTypingInInputField(e) {
        return this.platformUtils.isTypingInInputField(e);
    }
    updatePlatformSpecificShortcuts() {
        this.platformUtils.updatePlatformSpecificShortcuts();
    }
    initializeTerminal() {
        // Check if we have saved terminal data to restore multiple terminals
        if (this.savedTerminalData && this.savedTerminalData.length > 0) {
            // Create terminals for all saved data
            for (const termData of this.savedTerminalData) {
                if (termData.id === 1) {
                    // First terminal already has HTML container, just create the terminal instance
                    this.createTerminal(termData.id);
                } else {
                    // For additional terminals, create both HTML container and terminal instance
                    this.createAdditionalTerminalFromData(termData);
                }
            }
        } else {
            // No saved data, initialize with default first terminal
            this.createTerminal(this.activeTerminalId);
        }
        // Set container terminal count based on restored/current state
        const terminalsContainer = document.getElementById('terminals-container');
        terminalsContainer.setAttribute('data-terminal-count', this.terminals.size.toString());
        // Update button visibility for initial state
        this.updateTerminalButtonVisibility();
        // Initialize terminal dropdown
        this.updateTerminalDropdowns();
        this.updateManualTerminalDropdown();
        // Handle window resize for all terminals
        window.addEventListener('resize', () => {
            this.resizeAllTerminals();
        });
        // Very frequent state saving to ensure terminal names persist during quick refreshes
        setInterval(() => {
            this.saveTerminalState();
        }, 2000); // Save every 2 seconds for quick refresh handling
        // Save state on focus/blur events to catch quick interactions
        window.addEventListener('blur', () => {
            this.saveTerminalState();
        });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.saveTerminalState();
            }
        });
    }
    createAdditionalTerminalFromData(termData) {
        const id = termData.id;
        const color = termData.color || this.terminalColors[(id - 1) % this.terminalColors.length];
        // Create new terminal wrapper HTML (similar to addNewTerminal but without limits check)
        const terminalWrapper = document.createElement('div');
        terminalWrapper.className = 'terminal-wrapper';
        terminalWrapper.setAttribute('data-terminal-id', id);
        // Build the complete HTML structure
        terminalWrapper.innerHTML = `
            <div class="terminal-header">
                <div class="terminal-title-wrapper">
                    <button class="icon-btn close-terminal-btn" title="Close terminal" data-terminal-id="${id}">
                        <i data-lucide="x"></i>
                    </button>
                    <span class="terminal-color-dot" style="background-color: ${color};"></span>
                    <span class="terminal-title editable" contenteditable="false">${termData.name || `Terminal ${id}`}</span>
                    <button class="icon-btn add-terminal-btn" title="Add new terminal" style="display: none;" data-test-id="add-terminal-btn">
                        <i data-lucide="plus"></i>
                    </button>
                </div>
                <span class="terminal-status" data-terminal-status="${id}"></span>
            </div>
            <div class="terminal-container" data-terminal-container="${id}"></div>
            <div class="terminal-search-overlay" data-terminal-search="${id}" style="display: none;">
                <div class="search-bar">
                    <div class="search-input-wrapper">
                        <i class="search-icon" data-lucide="search"></i>
                        <input type="text" class="search-input" placeholder="Search in terminal..." />
                    </div>
                    <div class="search-controls">
                        <button class="search-btn search-prev" title="Previous match">
                            <i data-lucide="chevron-up"></i>
                        </button>
                        <button class="search-btn search-next" title="Next match">
                            <i data-lucide="chevron-down"></i>
                        </button>
                        <span class="search-matches">0/0</span>
                        <button class="search-btn search-close" title="Close search">
                            <i data-lucide="x"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
        // Add to container using the new layout management
        this.addTerminalToLayout(terminalWrapper, this.terminals.size + 1);
        // Update layout
        const terminalsContainer = document.getElementById('terminals-container');
        terminalsContainer.setAttribute('data-terminal-count', this.terminals.size + 1);
        // Create terminal instance
        this.createTerminal(id);
        // Create backend session if available and not already mapped
        if (this.backendAPIClient && !this.terminalSessionMap.has(id)) {
            this.backendAPIClient.createTerminalSession(termData.name || `Terminal ${id}`, this.currentDirectory)
                .then(async session => {
                    // Store the mapping of frontend terminal ID to backend session UUID
                    this.terminalSessionMap.set(id, session.id);
                    await this.saveTerminalSessionMapping();
                    this.logAction(`Created backend session for Terminal ${id}`, 'info');
                })
                .catch(error => {
                    console.error('Failed to create backend terminal session:', error);
                    this.logAction(`Failed to create backend session for Terminal ${id}`, 'error');
                });
        }
        // Start terminal process
        ipcRenderer.send('terminal-start', { terminalId: id, directory: termData.directory || this.currentDirectory });
        // Update dropdowns
        this.updateTerminalDropdowns();
        this.updateManualTerminalDropdown();
        // Re-initialize Lucide icons for new elements
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
        // Update button visibility
        this.updateTerminalButtonVisibility();
        // Resize all terminals to fit new layout
        setTimeout(() => {
            this.resizeAllTerminals();
        }, 100);
        // Update terminal counter to track the highest ID
        this.terminalIdCounter = Math.max(this.terminalIdCounter, id);
    }
    createTerminal(id) {
        const color = this.terminalColors[(id - 1) % this.terminalColors.length];
        // Create terminal instance
        const terminal = new Terminal({
            theme: this.getTerminalTheme(),
            fontFamily: 'Menlo',
            fontSize: 13,
            lineHeight: 1,
            cursorBlink: true,
            cursorStyle: 'block',
            scrollback: 1000,
            tabStopWidth: 4
        });
        // Add addons
        const fitAddon = new FitAddon();
        const searchAddon = new SearchAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(searchAddon);
        terminal.loadAddon(new WebLinksAddon());
        // Store terminal data
        const terminalData = {
            id,
            terminal,
            fitAddon,
            searchAddon,
            color,
            name: `Terminal ${id}`,
            directory: this.preferences.currentDirectory || null,
            lastOutput: '',
            status: '',
            userInteracting: false,
            autoscrollTimeout: null,
            searchVisible: false
        };
        this.terminals.set(id, terminalData);
        // Initialize status tracking for this terminal
        this.terminalStatuses.set(id, {
            isRunning: false,
            isPrompting: false,
            lastUpdate: Date.now()
        });
        // Open terminal in container - with retry logic for DOM readiness
        const terminalContainer = document.querySelector(`[data-terminal-container="${id}"]`);
        if (terminalContainer) {
            try {
                terminal.open(terminalContainer);
                // Store the terminal container element for later access
                terminalData.element = terminalContainer;
            } catch (error) {
                console.error('Error opening terminal in container:', error);
                // Retry after a short delay
                setTimeout(() => {
                    try {
                        terminal.open(terminalContainer);
                        terminalData.element = terminalContainer;
                    } catch (retryError) {
                        console.error('Retry failed for terminal container:', retryError);
                        this.handleTerminalError(id, retryError);
                    }
                }, 100);
                return;
            }
        } else {
            console.error('Terminal container not found for ID:', id);
            // Retry finding the container after a short delay
            setTimeout(() => {
                const retryContainer = document.querySelector(`[data-terminal-container="${id}"]`);
                if (retryContainer) {
                    try {
                        terminal.open(retryContainer);
                        terminalData.element = retryContainer;
                        this.processPendingTerminalData(id);
                        this.setupTerminalEventHandlers(id, terminal, terminalData);
                        // Setup terminal process after successful retry
                        this.setupTerminalProcess(id, terminal, terminalData);
                    } catch (error) {
                        console.error('Error opening terminal in retry container:', error);
                        this.handleTerminalError(id, error);
                    }
                } else {
                    console.error('Terminal container still not found after retry for ID:', id);
                }
            }, 500);
            return;
        }
        
        // Fit terminal to container
        setTimeout(() => {
            fitAddon.fit();
            // Process any pending terminal data after terminal is ready
            this.processPendingTerminalData(id);
        }, 10);
        
        // Setup terminal event handlers
        this.setupTerminalEventHandlers(id, terminal, terminalData);
        
        // Setup terminal process
        this.setupTerminalProcess(id, terminal, terminalData);
        // Load messages for this terminal if it's not terminal 1 (terminal 1 is handled in initialization)
        if (id !== 1) {
            this.loadMessagesForTerminal(id, false).catch(error => {
                console.warn('Failed to load messages for terminal', id, ':', error);
            });
        }
        return terminalData;
    }
    resizeAllTerminals() {
        this.terminals.forEach((terminalData) => {
            terminalData.fitAddon.fit();
        });
    }
    getTerminalTheme() {
        const currentTheme = this.preferences.theme;
        // Check for system theme if 'system' is selected
        if (currentTheme === 'system') {
            const isSystemLight = window.matchMedia('(prefers-color-scheme: light)').matches;
            return isSystemLight ? this.getLightTerminalTheme() : this.getDarkTerminalTheme();
        }
        return currentTheme === 'light' ? this.getLightTerminalTheme() : this.getDarkTerminalTheme();
    }
    getDarkTerminalTheme() {
        return {
            background: '#1e1e1e',
            foreground: '#ffffff',
            cursor: '#ffffff',
            cursorAccent: '#000000',
            selection: '#3d3d3d',
            black: '#000000',
            red: '#ff5f57',
            green: '#28ca42',
            yellow: '#ffbe2e',
            blue: '#007acc',
            magenta: '#af52de',
            cyan: '#5ac8fa',
            white: '#ffffff',
            brightBlack: '#666666',
            brightRed: '#ff6e67',
            brightGreen: '#32d74b',
            brightYellow: '#ffcc02',
            brightBlue: '#007aff',
            brightMagenta: '#bf5af2',
            brightCyan: '#64d8ff',
            brightWhite: '#ffffff'
        };
    }
    getLightTerminalTheme() {
        return {
            background: '#e6e9ef',
            foreground: '#4c4f69',
            cursor: '#4c4f69',
            cursorAccent: '#e6e9ef',
            selection: '#dce0e8',
            black: '#5c5f77',
            red: '#d20f39',
            green: '#40a02b',
            yellow: '#df8e1d',
            blue: '#1e66f5',
            magenta: '#ea76cb',
            cyan: '#179299',
            white: '#4c4f69',
            brightBlack: '#6c6f85',
            brightRed: '#d20f39',
            brightGreen: '#40a02b',
            brightYellow: '#df8e1d',
            brightBlue: '#1e66f5',
            brightMagenta: '#ea76cb',
            brightCyan: '#179299',
            brightWhite: '#4c4f69'
        };
    }
    applyTheme(theme) {
        // Update preferences
        this.preferences.theme = theme;
        // Apply theme to document
        if (theme === 'system') {
            document.documentElement.setAttribute('data-theme', 'system');
        } else {
            document.documentElement.setAttribute('data-theme', theme);
        }
        // Update terminal theme
        if (this.terminal) {
            this.terminal.options.theme = this.getTerminalTheme();
        }
        // Save preferences
        this.saveAllPreferences();
        this.logAction('Theme changed to: ' + theme, 'info');
    }
    setupResizeHandlers() {
        // Left sidebar resize handle
        const leftHandle = document.getElementById('resize-handle-left');
        const leftSidebar = document.getElementById('action-log-sidebar');
        const rightHandle = document.getElementById('resize-handle-right');
        const rightSidebar = document.getElementById('right-sidebar');
        const mainContent = document.querySelector('.main-content');
        
        let isResizing = false;
        let currentHandle = null;
        let startX = 0;
        let startWidth = 0;
        
        // Helper function to get saved widths from preferences
        const getSavedWidths = () => {
            return {
                leftWidth: this.preferences.leftSidebarWidth || 300,
                rightWidth: this.preferences.rightSidebarWidth || 400
            };
        };
        
        // Apply saved widths on initialization
        const savedWidths = getSavedWidths();
        leftSidebar.style.width = `${savedWidths.leftWidth}px`;
        rightSidebar.style.width = `${savedWidths.rightWidth}px`;
        
        // Mouse down handler
        const handleMouseDown = (e, handle, sidebar, isLeft) => {
            isResizing = true;
            currentHandle = handle;
            startX = e.clientX;
            startWidth = parseInt(window.getComputedStyle(sidebar).width, 10);
            
            handle.classList.add('resizing');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            
            e.preventDefault();
        };
        
        // Mouse move handler
        const handleMouseMove = (e) => {
            if (!isResizing) return;
            
            const sidebar = currentHandle === leftHandle ? leftSidebar : rightSidebar;
            const isLeft = currentHandle === leftHandle;
            const diff = isLeft ? (e.clientX - startX) : (startX - e.clientX);
            const newWidth = Math.max(
                parseInt(window.getComputedStyle(sidebar).minWidth, 10),
                Math.min(
                    parseInt(window.getComputedStyle(sidebar).maxWidth, 10),
                    startWidth + diff
                )
            );
            
            sidebar.style.width = `${newWidth}px`;
            
            // Resize all terminals after sidebar resize
            this.resizeAllTerminals();
        };
        
        // Mouse up handler
        const handleMouseUp = () => {
            if (!isResizing) return;
            
            isResizing = false;
            currentHandle.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            currentHandle = null;
            
            // Save the new widths to preferences
            this.preferences.leftSidebarWidth = parseInt(leftSidebar.style.width, 10);
            this.preferences.rightSidebarWidth = parseInt(rightSidebar.style.width, 10);
            this.saveAllPreferences();
            
            // Final resize to ensure terminals fit properly
            setTimeout(() => this.resizeAllTerminals(), 100);
        };
        
        // Add event listeners
        leftHandle.addEventListener('mousedown', (e) => handleMouseDown(e, leftHandle, leftSidebar, true));
        rightHandle.addEventListener('mousedown', (e) => handleMouseDown(e, rightHandle, rightSidebar, false));
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        
        // Handle window resize
        window.addEventListener('resize', () => {
            // Ensure sidebars don't exceed viewport
            const viewportWidth = window.innerWidth;
            const minTerminalWidth = 400;
            const maxSidebarWidth = (viewportWidth - minTerminalWidth) / 2;
            
            if (parseInt(leftSidebar.style.width, 10) > maxSidebarWidth) {
                leftSidebar.style.width = `${maxSidebarWidth}px`;
            }
            if (parseInt(rightSidebar.style.width, 10) > maxSidebarWidth) {
                rightSidebar.style.width = `${maxSidebarWidth}px`;
            }
            
            this.resizeAllTerminals();
        });
    }
    
    setupEventListeners() {
        // IPC listeners for terminal data (updated for multi-terminal)
        ipcRenderer.on('terminal-data', async (event, data) => {
            const terminalId = data.terminalId != null ? data.terminalId : 1;
            const terminalData = this.terminals.get(terminalId);
            if (terminalData && terminalData.terminal) {
                try {
                    terminalData.terminal.write(data.content);
                } catch (error) {
                    console.error('Error writing to terminal:', error);
                    // Try to reinitialize terminal if write fails
                    this.handleTerminalError(terminalId, error);
                    return;
                }
            } else {
                console.warn('Terminal data not available for terminal ID:', terminalId);
                // Queue the data for later processing
                this.queueTerminalData(terminalId, data);
                return;
            }
            if (terminalData) {
                terminalData.lastOutput = data.content;
                // Run detection functions for ALL terminals, not just active one
                this.detectAutoContinuePrompt(data.content, terminalId);
                await this.detectUsageLimit(data.content, terminalId);
                this.detectCwdChange(data.content, terminalId);
                // Handle autoscrolling for this specific terminal
                this.handleTerminalOutput(terminalId);
                // Update active terminal references only for the active terminal
                if (terminalId === this.activeTerminalId) {
                    this.terminal = terminalData.terminal;
                    this.updateTerminalOutput(data.content);
                }
            }
        });
        ipcRenderer.on('terminal-exit', (event, data) => {
            const terminalId = data.terminalId != null ? data.terminalId : 1;
            const terminalData = this.terminals.get(terminalId);
            if (terminalData && !terminalData.isClosing) {
                terminalData.terminal.write('\r\n\x1b[31mTerminal process exited\x1b[0m\r\n');
                // Handle autoscrolling for terminal exit message
                this.handleTerminalOutput(terminalId);
            }
        });
        ipcRenderer.on('cwd-response', (event, data) => {
            const terminalId = data.terminalId != null ? data.terminalId : 1;
            const terminalData = this.terminals.get(terminalId);
            if (terminalData) {
                terminalData.directory = data.cwd;
                if (terminalId === this.activeTerminalId) {
                    this.currentDirectory = data.cwd;
                    this.updateStatusDisplay();
                    this.savePreferences();
                    this.logAction(`Set directory to: ${data.cwd}`, 'info');
                }
            }
        });
        // UI event listeners
        this.safeAddEventListener('send-btn', 'click', () => {
            this.addMessageToQueue();
        });
        // Voice transcription button
        this.safeAddEventListener('voice-btn', 'click', () => {
            this.toggleVoiceRecording();
        });
        // Handle Enter key in message input
        const messageInput = document.getElementById('message-input');
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.addMessageToQueue();
            }
        });
        // Enhanced global keyboard shortcuts system
        this.directLog('ATTACHING KEYBOARD EVENT LISTENER');
        // Test if ANY event listeners work
        document.addEventListener('click', () => {
            this.directLog('CLICK EVENT DETECTED - Event listeners are working');
        });
        document.addEventListener('keydown', async (e) => {
            // Debug all keyboard events for critical hotkeys
            if ((this.isCommandKey(e) && e.key === 'b') || (e.shiftKey && e.key === 'Tab')) {
                this.directLog('KEYDOWN EVENT: ' + JSON.stringify({
                    key: e.key,
                    code: e.code,
                    metaKey: e.metaKey,
                    ctrlKey: e.ctrlKey,
                    shiftKey: e.shiftKey,
                    altKey: e.altKey,
                    target: e.target.tagName,
                    isCommandKey: this.isCommandKey(e)
                }));
            }
            // Check if settings modal is open - if so, disable all global hotkeys except modal-specific ones
            const settingsModal = document.getElementById('settings-modal');
            const isSettingsModalOpen = settingsModal && settingsModal.classList.contains('show');
            if (isSettingsModalOpen) {
                // Only allow Escape and modal-specific hotkeys in settings
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.closeSettingsModal();
                    return;
                }
                // Allow Cmd+C for copying in settings modal
                if (this.isCommandKey(e) && e.key === 'c') {
                    // Let default copy behavior work
                    return;
                }
                // Allow Tab and Shift+Tab for navigation within settings
                if (e.key === 'Tab') {
                    // Let default tab navigation work
                    return;
                }
                // Define global hotkeys that should work even when settings modal is open
                const allowedGlobalHotkeys = [
                    { key: 't', cmd: true, shift: false }, // Cmd+T - Add terminal
                    { key: 'w', cmd: true, shift: true }, // Cmd+Shift+W - Close terminal
                    { key: 'i', cmd: true, shift: false }, // Cmd+I - Manual injection
                    { key: 'p', cmd: true, shift: false }, // Cmd+P - Play/pause timer
                    { key: 'k', cmd: true, shift: false }, // Cmd+K - Terminal selector
                ];
                // Check if current hotkey is in allowed global list
                const isAllowedGlobalHotkey = allowedGlobalHotkeys.some(hotkey => 
                    e.key === hotkey.key && 
                    this.isCommandKey(e) === hotkey.cmd && 
                    e.shiftKey === hotkey.shift
                );
                // Block all other global hotkeys when settings modal is open (except allowed ones)
                // Allow shift key for normal typing in input fields
                if ((this.isCommandKey(e) && !isAllowedGlobalHotkey) || (e.altKey && !this.isTypingInInputField(e))) {
                    e.preventDefault();
                    return;
                }
                // Block shift key only for non-input elements or when combined with other keys
                if (e.shiftKey && (!this.isTypingInInputField(e) || e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    return;
                }
                // Let normal typing continue
                return;
            }
            // Don't trigger shortcuts if user is typing in an input/textarea (except for some special cases)
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                // Define hotkeys that should work even when typing in input fields
                const allowedInputHotkeys = [
                    // Navigation hotkeys
                    { key: 'k', cmd: true, shift: false }, // Cmd+K - Terminal selector
                    { key: 'Tab', cmd: false, shift: true }, // Shift+Tab - Toggle auto-continue
                    { key: 'p', cmd: true, shift: false }, // Cmd+P - Play/pause timer
                    { key: 'i', cmd: true, shift: false }, // Cmd+I - Manual injection
                    { key: 's', cmd: true, shift: true }, // Cmd+Shift+S - Stop timer
                    { key: 'v', cmd: true, shift: true }, // Cmd+Shift+V - Voice transcription
                    { key: 'a', cmd: true, shift: true }, // Cmd+Shift+A - Auto-continue toggle
                    { key: 'f', cmd: true, shift: false }, // Cmd+F - Focus log search
                    { key: 'l', cmd: true, shift: true }, // Cmd+Shift+L - Clear log
                    { key: 'h', cmd: true, shift: true }, // Cmd+Shift+H - Message history
                    { key: '.', cmd: true, shift: true }, // Cmd+Shift+. - Clear queue
                    { key: 't', cmd: true, shift: false }, // Cmd+T - Add terminal
                    { key: 'w', cmd: true, shift: true }, // Cmd+Shift+W - Close terminal
                    { key: 's', cmd: true, shift: false }, // Cmd+S - Settings
                    { key: 'b', cmd: true, shift: false }, // Cmd+B - Edit timer
                ];
                // Check if current hotkey is in allowed list
                const isAllowedHotkey = allowedInputHotkeys.some(hotkey => 
                    e.key === hotkey.key && 
                    this.isCommandKey(e) === hotkey.cmd && 
                    e.shiftKey === hotkey.shift
                );
                // Always allow escape and specific message input hotkeys
                if (e.key === 'Escape') {
                    e.target.blur(); // Unfocus input on Escape
                    return;
                }
                // Allow Cmd+Enter in message input to send message
                if (e.target.id === 'message-input' && this.isCommandKey(e) && e.key === 'Enter') {
                    e.preventDefault();
                    this.addMessageToQueue();
                    return;
                }
                // If not an allowed hotkey, skip processing
                if (!isAllowedHotkey) {
                    return;
                }
                // Continue processing the allowed hotkey
            }
            // Handle hotkey combinations
            if (this.isCommandKey(e) && e.key === 'i') {
                // Manual injection
                e.preventDefault();
                try {
                    this.manualInjectNextMessage();
                    this.logAction('Manual injection triggered (Cmd+I)', 'info');
                } catch (error) {
                    this.logAction(`Keyboard shortcut injection error: ${error.message}`, 'error');
                }
            } else if (this.isCommandKey(e) && e.key === 'p') {
                // Play/pause timer
                e.preventDefault();
                this.toggleTimer();
                this.logAction('Timer toggled (Cmd+P)', 'info');
            } else if (this.isCommandKey(e) && e.shiftKey && e.key === 'S') {
                // Stop timer
                e.preventDefault();
                this.stopTimer();
                this.logAction('Timer stopped (Cmd+Shift+S)', 'info');
            } else if (this.isCommandKey(e) && e.shiftKey && e.key === '.') {
                // Clear queue with confirmation
                e.preventDefault();
                this.clearQueueWithConfirmation();
            } else if (this.isCommandKey(e) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
                // Clear log
                e.preventDefault();
                this.clearActionLog();
                this.logAction('Action log cleared (Cmd+Shift+L)', 'info');
            } else if (this.isCommandKey(e) && e.shiftKey && (e.key === 'U' || e.key === 'u')) {
                // Toggle plan mode
                e.preventDefault();
                this.togglePlanMode();
                this.logAction('Plan mode toggled (Cmd+Shift+U)', 'info');
            } else if (this.isCommandKey(e) && e.key === 't') {
                // Add new terminal
                e.preventDefault();
                this.addNewTerminal();
                this.logAction('New terminal added (Cmd+T)', 'info');
            } else if (this.isCommandKey(e) && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
                // Close current terminal
                e.preventDefault();
                if (this.terminals.size > 1) {
                    await this.closeTerminal(this.activeTerminalId);
                    this.logAction('Terminal closed (Cmd+Shift+W)', 'info');
                } else {
                    this.logAction('Cannot close last terminal - at least one terminal must remain open', 'warning');
                }
            } else if (e.shiftKey && e.key === 'Tab' && !this.isCommandKey(e)) {
                // Toggle auto-continue
                e.preventDefault();
                this.toggleAutoContinue();
                this.logAction('Auto-continue toggled (Shift+Tab)', 'info');
            } else if (this.isCommandKey(e) && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
                // Toggle voice transcription
                e.preventDefault();
                document.getElementById('voice-btn').click();
                this.logAction('Voice transcription toggled (Cmd+Shift+V)', 'info');
            } else if (this.isCommandKey(e) && e.key === '/') {
                // Focus message input
                e.preventDefault();
                document.getElementById('message-input').focus();
                this.logAction('Message input focused (Cmd+/)', 'info');
            } else if (this.isCommandKey(e) && e.key === 's') {
                // Open settings
                e.preventDefault();
                this.openSettingsModal();
                this.logAction('Settings opened (Cmd+S)', 'info');
            } else if (this.isCommandKey(e) && e.key === 'f') {
                // Check if a terminal is focused for terminal search, otherwise focus log search
                e.preventDefault();
                const focusedElement = document.activeElement;
                console.log('Cmd+F pressed, focused element:', focusedElement, 'class:', focusedElement?.className);
                // Check if the focused element is within a terminal or if it's a terminal element
                const isTerminalFocused = focusedElement && (
                    focusedElement.closest('.terminal-container') || 
                    focusedElement.closest('.xterm') ||
                    focusedElement.classList?.contains('xterm-helper-textarea') ||
                    focusedElement.classList?.contains('xterm-screen') ||
                    focusedElement.tagName === 'CANVAS' ||
                    focusedElement.closest('.terminal-wrapper')
                );
                console.log('Is terminal focused:', isTerminalFocused);
                if (isTerminalFocused) {
                    // Get the terminal ID from the focused terminal container
                    const terminalWrapper = focusedElement.closest('.terminal-wrapper');
                    const terminalId = terminalWrapper ? parseInt(terminalWrapper.getAttribute('data-terminal-id')) : this.activeTerminalId;
                    console.log('Toggling terminal search for terminal:', terminalId);
                    this.toggleTerminalSearch(terminalId);
                    this.logAction(`Terminal search toggled (Cmd+F) for Terminal ${terminalId}`, 'info');
                } else if (this.activeTerminalId && this.terminals.has(this.activeTerminalId)) {
                    // Fallback: if no terminal is specifically focused, toggle search for active terminal
                    console.log('No terminal focused, toggling search for active terminal:', this.activeTerminalId);
                    this.toggleTerminalSearch(this.activeTerminalId);
                    this.logAction(`Terminal search toggled (Cmd+F) for active Terminal ${this.activeTerminalId}`, 'info');
                } else {
                    console.log('Opening log search');
                    this.focusSearchInput();
                    this.logAction('Log search focused (Cmd+F)', 'info');
                }
            } else if (this.isCommandKey(e) && e.key === 'k') {
                // Focus terminal selector
                e.preventDefault();
                this.focusTerminalSelector();
                this.logAction('Terminal selector focused (Cmd+K)', 'info');
            } else if (this.isCommandKey(e) && (e.key === 'b' || e.key === 'B')) {
                // Edit timer
                this.directLog('CMD+B DETECTED! Calling focusTimerEdit()');
                e.preventDefault();
                this.focusTimerEdit();
                this.logAction('Timer edit focused (Cmd+B)', 'info');
            } else if (this.isCommandKey(e) && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
                // Open message history
                e.preventDefault();
                this.openMessageHistoryModal();
                this.logAction('Message history opened (Cmd+Shift+H)', 'info');
            } else if (this.isCommandKey(e) && e.key >= '1' && e.key <= '9') {
                // Switch to terminal by number (Cmd+1-9)
                e.preventDefault();
                const terminalNumber = parseInt(e.key);
                const terminalIds = Array.from(this.terminals.keys());
                if (terminalIds[terminalNumber - 1]) {
                    this.switchToTerminal(terminalIds[terminalNumber - 1]);
                    this.logAction(`Switched to terminal ${terminalNumber} (Cmd+${e.key})`, 'info');
                }
            } else if (e.key === 'Escape') {
                // Close any open modals/dropdowns
                e.preventDefault();
                this.closeAllModals();
            }
        });
        // Add auto-resize functionality to message input
        messageInput.addEventListener('input', () => {
            this.autoResizeMessageInput(messageInput);
        });
        // Add focus event to enable auto-resize
        messageInput.addEventListener('focus', () => {
            this.autoResizeMessageInput(messageInput);
        });
        // Add blur event to reset to default height when not focused
        messageInput.addEventListener('blur', () => {
            messageInput.style.height = '80px'; // Reset to minimum height
            messageInput.style.overflowY = 'hidden';
        });
        // Directory click handler
        document.getElementById('current-directory').addEventListener('click', () => {
            this.openDirectoryBrowser();
        });
        document.getElementById('clear-queue-header-btn').addEventListener('click', () => {
            this.clearQueue();
        });
        // Consolidated click event listener for terminal interactions
        document.addEventListener('click', (e) => {
            // Handle close terminal button
            const closeBtn = e.target.closest('.close-terminal-btn');
            if (closeBtn) {
                console.log('Close button clicked, element:', closeBtn);
                console.log('Close button dataset:', closeBtn.dataset);
                const terminalId = parseInt(closeBtn.dataset.terminalId);
                console.log('Parsed terminal ID:', terminalId, 'Terminals size:', this.terminals.size);
                if (terminalId && this.terminals.size > 1) {
                    this.logAction(`Closing terminal ${terminalId}`, 'info');
                    this.closeTerminal(terminalId);
                } else {
                    console.log('Cannot close terminal:', terminalId ? 'Only one terminal left' : 'Invalid terminal ID');
                }
                return;
            }
            // Handle add terminal button
            const addBtn = e.target.closest('.add-terminal-btn');
            if (addBtn) {
                console.log('Add terminal button clicked');
                e.stopPropagation();
                this.logAction('Creating new terminal...', 'info');
                this.addNewTerminal();
                return;
            }
            // Handle message options button
            const optionsBtn = e.target.closest('.message-options-btn');
            if (optionsBtn) {
                e.stopPropagation();
                const messageItem = optionsBtn.closest('.message-item');
                if (messageItem) {
                    this.showMessageTerminalDropdown(messageItem, optionsBtn);
                }
                return;
            }
            // Handle terminal title editing
            const terminalTitle = e.target.closest('.terminal-title.editable');
            if (terminalTitle) {
                this.startEditingTerminalTitle(terminalTitle);
                return;
            }
            // Handle terminal selector dropdown closing
            if (!e.target.closest('.terminal-selector')) {
                this.hideTerminalSelectorDropdown();
            }
        });
        // Terminal selector dropdown
        document.getElementById('terminal-selector-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleTerminalSelectorDropdown();
        });
        document.getElementById('inject-now-btn').addEventListener('click', (e) => {
            console.log('=== INJECT BUTTON CLICKED ===');
            console.log('Message queue length:', this.messageQueue.length);
            console.log('Message queue:', this.messageQueue);
            e.preventDefault();
            e.stopPropagation();
            // Add visual feedback
            const btn = e.target.closest('#inject-now-btn');
            if (btn) {
                btn.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    btn.style.transform = '';
                }, 100);
            }
            // Call manual injection with error handling
            try {
                this.manualInjectNextMessage();
            } catch (error) {
                this.logAction(`Manual injection button error: ${error.message}`, 'error');
                console.error('Manual injection error:', error);
            }
        });
        // Auto-continue button listener
        this.safeAddEventListener('auto-continue-btn', 'click', (e) => {
            this.autoContinueEnabled = !this.autoContinueEnabled;
            this.updatePref('autoContinueEnabled', this.autoContinueEnabled);
            this.updateAutoContinueButtonState();
            this.updatePlanModeButtonState();
            if (this.autoContinueEnabled) {
                this.logAction('Auto-continue enabled - will respond to prompts', 'info');
            } else {
                this.logAction('Auto-continue disabled', 'info');
            }
        });
        // Plan mode button listener
        this.safeAddEventListener('plan-mode-btn', 'click', (e) => {
            this.planModeEnabled = !this.planModeEnabled;
            this.updatePref('planModeEnabled', this.planModeEnabled);
            this.updatePlanModeButtonState();
            if (this.planModeEnabled) {
                this.logAction('Plan mode enabled - messages will be wrapped with claude-flow command', 'info');
            } else {
                this.logAction('Plan mode disabled', 'info');
            }
        });
        // Hotkey button listener
        document.getElementById('hotkey-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleHotkeyDropdown(e);
        });
        // Hotkey dropdown item listeners
        document.addEventListener('click', (e) => {
            const hotkeyItem = e.target.closest('.hotkey-item');
            if (hotkeyItem) {
                const command = hotkeyItem.getAttribute('data-command');
                this.insertHotkey(command);
                this.hideHotkeyDropdown();
            } else if (!e.target.closest('#hotkey-dropdown') && !e.target.closest('#hotkey-btn')) {
                this.hideHotkeyDropdown();
            }
        });
        // New timer system event listeners
        document.getElementById('timer-play-pause-btn').addEventListener('click', () => {
            this.toggleTimerOrInjection();
        });
        document.getElementById('timer-stop-btn').addEventListener('click', () => {
            const stopBtn = document.getElementById('timer-stop-btn');
            if (stopBtn.classList.contains('timer-refresh')) {
                this.resetTimer();
            } else if (stopBtn.classList.contains('timer-cancel-injection')) {
                this.cancelSequentialInjection();
            } else {
                this.stopTimer();
            }
        });
        document.getElementById('timer-edit-btn').addEventListener('click', (e) => {
            this.openTimerEditDropdown(e);
        });
        // Timer display click handler - allows clicking on the timer display itself
        document.getElementById('timer-display').addEventListener('click', (e) => {
            this.openTimerEditDropdown(e);
        });
        // Action log clear button
        document.getElementById('clear-log-btn').addEventListener('click', () => {
            this.clearActionLog();
        });
        // Search functionality for action log
        const logSearchInput = document.getElementById('log-search');
        const searchClearBtn = document.getElementById('search-clear-btn');
        logSearchInput.addEventListener('input', (e) => {
            this.logDisplaySettings.searchTerm = e.target.value.trim();
            this.logDisplaySettings.isSearching = this.logDisplaySettings.searchTerm.length > 0;
            this.logDisplaySettings.displayedCount = 50; // Reset display count when searching
            this.renderLogEntries();
        });
        logSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.clearLogSearch();
            }
        });
        searchClearBtn.addEventListener('click', () => {
            this.clearLogSearch();
        });
        // Settings modal listeners
        this.safeAddEventListener('settings-btn', 'click', () => {
            this.openSettingsModal();
        });
        this.safeAddEventListener('settings-close', 'click', () => {
            this.closeSettingsModal();
        });
        this.safeAddEventListener('settings-modal', 'click', (e) => {
            if (e.target.id === 'settings-modal') {
                this.closeSettingsModal();
            }
        });
        // Message history modal listeners
        document.getElementById('message-history-btn').addEventListener('click', () => {
            this.openMessageHistoryModal();
        });
        document.getElementById('message-history-close').addEventListener('click', () => {
            this.closeMessageHistoryModal();
        });
        document.getElementById('message-history-modal').addEventListener('click', (e) => {
            if (e.target.id === 'message-history-modal') {
                this.closeMessageHistoryModal();
            }
        });
        document.getElementById('clear-history-btn').addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all message history? This cannot be undone.')) {
                this.clearMessageHistory();
            }
        });
        // Prompts modal listeners
        document.getElementById('plan-count').addEventListener('click', () => {
            this.openPromptsModal();
        });
        document.getElementById('plans-close').addEventListener('click', () => {
            this.closePromptsModal();
        });
        document.getElementById('plans-modal').addEventListener('click', (e) => {
            if (e.target.id === 'plans-modal') {
                this.closePromptsModal();
            }
        });
        // Settings controls
        document.getElementById('autoscroll-enabled').addEventListener('change', (e) => {
            this.autoscrollEnabled = e.target.checked;
            this.updatePref('autoscrollEnabled', e.target.checked);
        });
        document.getElementById('autoscroll-delay').addEventListener('change', (e) => {
            this.autoscrollDelay = parseInt(e.target.value);
            this.updatePref('autoscrollDelay', parseInt(e.target.value));
        });
        // Theme selection control
        document.getElementById('theme-select').addEventListener('change', (e) => {
            this.applyTheme(e.target.value);
        });
        // Keyword blocking controls
        document.getElementById('add-keyword-btn').addEventListener('click', () => {
            this.addKeywordRule();
        });
        // Backup/Restore controls
        // New backup system event listeners
        document.getElementById('new-keyword').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.addKeywordRule();
            }
        });
        document.getElementById('new-response').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.addKeywordRule();
            }
        });
        // Sound effects controls
        this.safeAddEventListener('sound-effects-enabled', 'change', (e) => {
            this.updatePref('completionSoundEnabled', e.target.checked);
            this.updateSoundSettingsVisibility();
            this.logAction(`Sound effects ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
        });
        this.safeAddEventListener('completion-sound-select', 'change', (e) => {
            this.updatePref('completionSoundFile', e.target.value);
            this.logAction(`Completion sound changed to: ${e.target.value || 'None'}`, 'info');
        });
        this.safeAddEventListener('injection-sound-select', 'change', (e) => {
            this.preferences.injectionSoundFile = e.target.value;
            this.saveAllPreferences();
            this.logAction(`Injection sound changed to: ${e.target.value || 'None'}`, 'info');
        });
        this.safeAddEventListener('prompted-sound-select', 'change', (e) => {
            this.preferences.promptedSoundFile = e.target.value;
            this.saveAllPreferences();
            this.logAction(`Prompted sound changed to: ${e.target.value || 'None'}`, 'info');
        });
        this.safeAddEventListener('test-completion-sound-btn', 'click', () => {
            this.testCompletionSound();
        });
        this.safeAddEventListener('test-injection-sound-btn', 'click', () => {
            this.testInjectionSound();
        });
        this.safeAddEventListener('test-prompted-sound-btn', 'click', () => {
            this.testPromptedSound();
        });
        this.safeAddEventListener('prompted-sound-keywords-only', 'change', (e) => {
            this.preferences.promptedSoundKeywordsOnly = e.target.checked;
            this.saveAllPreferences();
            this.logAction(`Prompted sound keywords-only ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
        });
        // Background service settings listeners
        document.getElementById('keep-screen-awake').addEventListener('change', (e) => {
            this.preferences.keepScreenAwake = e.target.checked;
            this.saveAllPreferences();
            this.logAction(`Keep screen awake ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
        });
        document.getElementById('show-system-notifications').addEventListener('change', (e) => {
            this.preferences.showSystemNotifications = e.target.checked;
            this.saveAllPreferences();
            this.logAction(`System notifications ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
        });
        document.getElementById('minimize-to-tray').addEventListener('change', (e) => {
            this.preferences.minimizeToTray = e.target.checked;
            this.saveAllPreferences();
            this.logAction(`Minimize to tray ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
        });
        document.getElementById('start-minimized').addEventListener('change', (e) => {
            this.preferences.startMinimized = e.target.checked;
            this.saveAllPreferences();
            this.logAction(`Start minimized ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
        });
        // Todo generation setting
        document.getElementById('automatic-todo-generation').addEventListener('change', (e) => {
            this.preferences.automaticTodoGeneration = e.target.checked;
            this.saveAllPreferences();
            this.logAction(`Automatic todo generation ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
        });
        // Plan mode command setting
        document.getElementById('plan-mode-command').addEventListener('change', (e) => {
            this.planModeCommand = e.target.value;
            this.preferences.planModeCommand = e.target.value;
            this.saveAllPreferences();
            this.logAction('Plan mode command updated', 'info');
        });
        // System theme change listener
        window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
            if (this.preferences.theme === 'system') {
                this.applyTheme('system');
            }
        });
        // File drag and drop event listeners
        const dropZone = document.getElementById('drop-zone');
        const dropOverlay = document.getElementById('drop-overlay');
        const fileInput = document.getElementById('file-input');
        let dragCounter = 0; // Track drag enter/leave to prevent flickering
        // Prevent default drag behaviors on the drop zone
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, this.preventDefaults, false);
            document.body.addEventListener(eventName, this.preventDefaults, false);
        });
        // Handle drag enter/leave with counter to prevent flickering
        dropZone.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter++;
            if (dragCounter === 1) {
                this.highlight(dropOverlay);
            }
        }, false);
        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter--;
            if (dragCounter === 0) {
                this.unhighlight(dropOverlay);
            }
        }, false);
        // Handle dragover without changing visibility
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
        }, false);
        // Handle dropped files
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dragCounter = 0;
            this.unhighlight(dropOverlay);
            this.handleFileDrop(e);
        }, false);
        // Handle manual file selection through hidden input
        fileInput.addEventListener('change', (e) => this.handleFileSelection(e), false);
        // File import button click handler (if present)
        const fileImportBtn = document.getElementById('file-import-btn');
        if (fileImportBtn) {
            fileImportBtn.addEventListener('click', () => {
                fileInput.click();
            });
        }
    }
    highlight(dropOverlay) {
        this.isDragging = true;
        dropOverlay.style.display = 'flex';
    }
    unhighlight(dropOverlay) {
        this.isDragging = false;
        dropOverlay.style.display = 'none';
    }
    async handleFileDrop(e) {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) {
            this.logAction(`Processing ${files.length} dropped file(s)`, 'info');
            await this.processFiles(files);
        }
    }
    async handleFileSelection(e) {
        const files = e.target.files;
        if (files.length > 0) {
            this.logAction(`Processing ${files.length} selected file(s)`, 'info');
            await this.processFiles(files);
        }
    }
    async processFiles(files) {
        try {
            // Get current message input
            const messageInput = document.getElementById('message-input');
            const currentText = messageInput.value;
            // Separate images from other files
            const imageFiles = [];
            const otherFiles = [];
            Array.from(files).forEach(file => {
                const isImage = file.type && file.type.startsWith('image/');
                if (isImage) {
                    imageFiles.push(file);
                } else {
                    otherFiles.push(file);
                }
            });
            // Handle image files for preview
            if (imageFiles.length > 0) {
                await this.addImagePreviews(imageFiles);
            }
            // Store file paths for later use but don't add to input text for now
            const allFiles = [...imageFiles, ...otherFiles];
            if (!this.attachedFiles) {
                this.attachedFiles = [];
            }
            // Add new files to attached files list
            allFiles.forEach(file => {
                this.attachedFiles.push({
                    path: file.path || file.name,
                    file: file,
                    isImage: file.type && file.type.startsWith('image/')
                });
            });
            
            // Append image paths to input text box
            if (imageFiles.length > 0) {
                const imagePaths = imageFiles.map(file => `'${file.path || file.name}'`).join(' ');
                const currentValue = messageInput.value.trim();
                messageInput.value = currentValue ? `${currentValue} ${imagePaths}` : imagePaths;
            }
            
            // Focus on the input after appending paths
            messageInput.focus();
            const fileNames = Array.from(files).map(file => file.name);
            this.logAction(`Added ${files.length} file(s) to current message: ${fileNames.join(', ')}`, 'success');
        } catch (error) {
            console.error('Error processing files:', error);
            this.logAction(`Error processing files: ${error.message}`, 'error');
        }
    }
    async addImagePreviews(imageFiles) {
        const previewContainer = document.getElementById('image-preview-container');
        const previewList = document.getElementById('image-preview-list');
        if (!previewContainer || !previewList) return;
        // Initialize image previews array if not exists
        if (!this.imagePreviews) {
            this.imagePreviews = [];
        }
        for (const file of imageFiles) {
            const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const imageData = {
                id: imageId,
                file: file,
                path: file.path || file.name
            };
            this.imagePreviews.push(imageData);
            // Create preview element
            const previewItem = document.createElement('div');
            previewItem.className = 'image-preview-item';
            previewItem.dataset.imageId = imageId;
            // Create image element
            const img = document.createElement('img');
            img.src = URL.createObjectURL(file);
            img.alt = file.name;
            img.title = file.name;
            // Create remove button
            const removeBtn = document.createElement('div');
            removeBtn.className = 'image-preview-remove';
            removeBtn.innerHTML = '×';
            removeBtn.title = 'Remove image';
            // Add click handlers
            img.addEventListener('click', () => this.showImagePreview(imageData));
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeImagePreview(imageId);
            });
            previewItem.appendChild(img);
            previewItem.appendChild(removeBtn);
            previewList.appendChild(previewItem);
        }
        // Show preview container
        previewContainer.style.display = 'block';
    }
    removeImagePreview(imageId) {
        // Remove from array
        const index = this.imagePreviews.findIndex(img => img.id === imageId);
        if (index === -1) return;
        const imageData = this.imagePreviews[index];
        this.imagePreviews.splice(index, 1);
        // Remove from DOM
        const previewItem = document.querySelector(`[data-image-id="${imageId}"]`);
        if (previewItem) {
            // Clean up object URL
            const img = previewItem.querySelector('img');
            if (img && img.src.startsWith('blob:')) {
                URL.revokeObjectURL(img.src);
            }
            previewItem.remove();
        }
        // Remove from attached files array
        if (this.attachedFiles) {
            const attachedIndex = this.attachedFiles.findIndex(file => file.path === imageData.path);
            if (attachedIndex !== -1) {
                this.attachedFiles.splice(attachedIndex, 1);
            }
        }
        // Hide container if no more images
        if (this.imagePreviews.length === 0) {
            document.getElementById('image-preview-container').style.display = 'none';
        }
        this.logAction(`Removed image: ${imageData.file.name}`, 'info');
    }
    showImagePreview(imageData) {
        // Create modal for full image preview
        const modal = document.createElement('div');
        modal.className = 'image-preview-modal';
        const img = document.createElement('img');
        img.src = URL.createObjectURL(imageData.file);
        img.alt = imageData.file.name;
        img.title = `${imageData.file.name} - Click anywhere to close`;
        modal.appendChild(img);
        document.body.appendChild(modal);
        // Close on click anywhere in modal
        modal.addEventListener('click', (e) => {
            URL.revokeObjectURL(img.src);
            modal.remove();
            document.removeEventListener('keydown', handleEscape);
        });
        // Prevent image click from bubbling up to modal
        img.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        // Close on escape key
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                URL.revokeObjectURL(img.src);
                modal.remove();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);
        // Focus the modal for keyboard events
        modal.focus();
    }
    showAllImages(messageId, imagePreviewList, imagePreviews) {
        // Clear current image list
        imagePreviewList.innerHTML = '';
        
        // Show all images
        imagePreviews.forEach(imageData => {
            const previewItem = document.createElement('div');
            previewItem.className = 'message-image-preview-item';
            const img = document.createElement('img');
            img.src = URL.createObjectURL(imageData.file);
            img.alt = imageData.file.name;
            img.title = imageData.file.name;
            img.addEventListener('click', () => this.showImagePreview(imageData));
            previewItem.appendChild(img);
            imagePreviewList.appendChild(previewItem);
        });
        
        // Add "Show less" button to collapse back to 3 images
        const showLessBtn = document.createElement('div');
        showLessBtn.className = 'message-image-less-btn';
        showLessBtn.innerHTML = 'Show less';
        showLessBtn.title = 'Show fewer images';
        showLessBtn.addEventListener('click', () => {
            this.showLessImages(messageId, imagePreviewList, imagePreviews);
        });
        imagePreviewList.appendChild(showLessBtn);
    }
    showLessImages(messageId, imagePreviewList, imagePreviews) {
        // Clear current image list
        imagePreviewList.innerHTML = '';
        
        const MAX_VISIBLE_IMAGES = 3;
        const totalImages = imagePreviews.length;
        
        // Show only first 3 images
        for (let i = 0; i < Math.min(MAX_VISIBLE_IMAGES, totalImages); i++) {
            const imageData = imagePreviews[i];
            const previewItem = document.createElement('div');
            previewItem.className = 'message-image-preview-item';
            const img = document.createElement('img');
            img.src = URL.createObjectURL(imageData.file);
            img.alt = imageData.file.name;
            img.title = imageData.file.name;
            img.addEventListener('click', () => this.showImagePreview(imageData));
            previewItem.appendChild(img);
            imagePreviewList.appendChild(previewItem);
        }
        
        // Add "+N more" button if there are more than MAX_VISIBLE_IMAGES
        if (totalImages > MAX_VISIBLE_IMAGES) {
            const moreImagesBtn = document.createElement('div');
            moreImagesBtn.className = 'message-image-more-btn';
            moreImagesBtn.innerHTML = `+${totalImages - MAX_VISIBLE_IMAGES}`;
            moreImagesBtn.title = `Show ${totalImages - MAX_VISIBLE_IMAGES} more images`;
            moreImagesBtn.addEventListener('click', () => {
                this.showAllImages(messageId, imagePreviewList, imagePreviews);
            });
            imagePreviewList.appendChild(moreImagesBtn);
        }
    }
    clearImagePreviews() {
        const previewContainer = document.getElementById('image-preview-container');
        const previewList = document.getElementById('image-preview-list');
        if (!previewList) return;
        // Clean up object URLs
        previewList.querySelectorAll('img').forEach(img => {
            if (img.src.startsWith('blob:')) {
                URL.revokeObjectURL(img.src);
            }
        });
        // Clear DOM and array
        previewList.innerHTML = '';
        this.imagePreviews = [];
        // Hide container
        if (previewContainer) {
            previewContainer.style.display = 'none';
        }
    }
    generateMessageId() {
        return this.validationUtils.generateId();
    }
    validateMessageIds() {
        // Debug function to check for duplicate IDs
        const ids = this.messageQueue.map(m => m.id);
        const uniqueIds = new Set(ids);
        if (ids.length !== uniqueIds.size) {
            console.error('Duplicate message IDs detected:', ids);
            console.error('Message queue:', this.messageQueue);
        }
        return ids.length === uniqueIds.size;
    }
    async addMessageToQueue() {
        const input = document.getElementById('message-input');
        const content = input.value.trim();
        // Validate content is not empty or just whitespace
        if (this.isValidMessageContent(content)) {
            // Handle special usage limit commands
            if (content.startsWith('/usage-limit-status')) {
                const status = await this.getUsageLimitStatus();
                this.logAction(status.message, 'info');
                if (status.firstDetected) {
                    this.logAction(`First detected: ${status.firstDetected}`, 'info');
                }
                input.value = '';
                return;
            }
            if (content.startsWith('/usage-limit-reset')) {
                await this.resetUsageLimitTimer();
                input.value = '';
                return;
            }
            if (content.startsWith('/debug-usage-limit')) {
                this.logAction('DEBUG: Triggering usage limit detection with 30-second countdown', 'warning');
                const debugResetTime = new Date(Date.now() + 30000); // 30 seconds from now
                this.pendingUsageLimitReset = { 
                    resetHour: debugResetTime.getHours() % 12 || 12, 
                    ampm: debugResetTime.getHours() >= 12 ? 'pm' : 'am',
                    debugResetTime: debugResetTime.getTime()
                };
                this.checkAndShowUsageLimitModal(`${this.pendingUsageLimitReset.resetHour}${this.pendingUsageLimitReset.ampm}`, 
                    this.pendingUsageLimitReset.resetHour, this.pendingUsageLimitReset.ampm);
                input.value = '';
                return;
            }
            if (content.startsWith('/help') && (content === '/help' || content.includes('usage-limit'))) {
                this.logAction('Usage Limit Commands:', 'info');
                this.logAction('  /usage-limit-status - Check status and remaining time until auto-disable', 'info');
                this.logAction('  /usage-limit-reset - Reset the 5-hour auto-disable timer', 'info');
                this.logAction('  /debug-usage-limit - Debug: Trigger usage limit detection with 30-second countdown', 'warning');
                this.logAction('', 'info');
                this.logAction('Auto-disable: Usage limit detection automatically disables 5 hours after first detection', 'info');
                input.value = '';
                return;
            }
            // Prepare file paths for injection (only non-image files, since image paths are now in input text)
            let filePaths = '';
            if (this.attachedFiles && this.attachedFiles.length > 0) {
                const otherFiles = this.attachedFiles.filter(f => !f.isImage);
                if (otherFiles.length > 0) {
                    const pathStrings = otherFiles.map(f => `'${f.path}'`);
                    filePaths = pathStrings.join(' ') + (content ? ' ' : '');
                }
            }
            const now = Date.now();
            const message = {
                id: this.generateMessageId(),
                content: content, // Original user message text only
                processedContent: filePaths + content, // File paths + user message for injection
                executeAt: now,
                createdAt: now,
                timestamp: now, // For compatibility
                terminalId: this.activeTerminalId, // Use currently selected terminal
                sequence: ++this.messageSequenceCounter, // Add sequence counter for proper ordering
                imagePreviews: this.imagePreviews ? [...this.imagePreviews] : [], // Copy current image previews
                attachedFiles: this.attachedFiles ? [...this.attachedFiles] : [], // Copy attached files
                wrapWithPlan: this.planModeEnabled // Default to current plan mode state
            };
            this.messageQueue.push(message);
            this.updateTrayBadge();
            this.saveMessageQueue();
            this.updateMessageList();
            this.updateStatusDisplay();
            input.value = '';
            // Clear image previews and attached files after adding to queue
            this.clearImagePreviews();
            this.attachedFiles = [];
            // Reset input height after clearing
            this.autoResizeMessageInput(input);
            const terminalData = this.terminals.get(message.terminalId);
            const terminalName = terminalData ? terminalData.name : `Terminal ${message.terminalId}`;
            this.logAction(`Added message to queue for ${terminalName}: "${content}"`, 'info');
            // Save to backend if available
            if (this.backendAPIClient && this.terminalSessionMap.has(message.terminalId)) {
                try {
                    const backendSessionId = this.terminalSessionMap.get(message.terminalId);
                    const backendMessage = await this.backendAPIClient.addMessageToQueue(backendSessionId, content);
                    // Update the message with backend ID
                    const messageIndex = this.messageQueue.findIndex(m => m.id === message.id);
                    if (messageIndex !== -1 && backendMessage && backendMessage.id) {
                        this.messageQueue[messageIndex].backendId = backendMessage.id;
                        this.saveMessageQueue(); // Save the updated queue with backend ID
                    }
                    console.log(`Message saved to backend for session ${backendSessionId} with ID ${backendMessage.id}`);
                } catch (error) {
                    console.error('Failed to save message to backend:', error);
                    // Continue anyway - frontend queue still has the message
                }
            }
        }
    }
    async toggleVoiceRecording() {
        if (this.isRecording) {
            this.stopRecording();
        } else {
            await this.startRecording();
        }
    }
    async startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // Try to use WAV format if supported, otherwise use default
            let options = {};
            if (MediaRecorder.isTypeSupported('audio/wav')) {
                options = { mimeType: 'audio/wav' };
            } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')) {
                options = { mimeType: 'audio/webm;codecs=pcm' };
            } else if (MediaRecorder.isTypeSupported('audio/webm')) {
                options = { mimeType: 'audio/webm' };
            }
            this.mediaRecorder = new MediaRecorder(stream, options);
            this.audioChunks = [];
            console.log('MediaRecorder format:', this.mediaRecorder.mimeType);
            this.mediaRecorder.ondataavailable = (event) => {
                this.audioChunks.push(event.data);
            };
            this.mediaRecorder.onstop = () => {
                this.processRecording();
            };
            this.mediaRecorder.start();
            this.isRecording = true;
            // Set recording state directly 
            const voiceBtn = document.getElementById('voice-btn');
            voiceBtn.classList.remove('processing');
            voiceBtn.classList.add('recording');
            this.logAction('Voice recording started', 'info');
        } catch (error) {
            this.logAction(`Voice recording error: ${error.message}`, 'error');
        }
    }
    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
            this.isRecording = false;
            // Don't change button state here - processRecording will handle it
            this.logAction('Voice recording stopped', 'info');
        }
    }
    async processRecording() {
        try {
            const voiceBtn = document.getElementById('voice-btn');
            voiceBtn.classList.remove('recording');
            voiceBtn.classList.add('processing');
            const icon = voiceBtn.querySelector('i');
            if (icon) {
                icon.setAttribute('data-lucide', 'loader');
            }
            lucide.createIcons();
            const audioBlob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType });
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioBuffer = Buffer.from(arrayBuffer);
            // Send to main process for transcription
            const transcription = await ipcRenderer.invoke('transcribe-audio', audioBuffer);
            if (transcription && transcription.trim() && transcription.trim() !== 'No speech detected') {
                const messageInput = document.getElementById('message-input');
                const currentValue = messageInput.value;
                const newValue = currentValue ? `${currentValue} ${transcription}` : transcription;
                messageInput.value = newValue;
                this.autoResizeMessageInput(messageInput);
                this.logAction(`Voice transcribed: "${transcription}"`, 'success');
            } else {
                this.logAction('No speech detected in recording', 'warning');
            }
        } catch (error) {
            this.logAction(`Transcription error: ${error.message}`, 'error');
        } finally {
            // Clear processing state and return to normal
            const voiceBtn = document.getElementById('voice-btn');
            voiceBtn.classList.remove('processing', 'recording');
            const icon = voiceBtn.querySelector('i');
            if (icon) {
                icon.setAttribute('data-lucide', 'mic');
            }
            lucide.createIcons();
        }
    }
    updateAutoContinueButtonState() {
        const autoContinueBtn = document.getElementById('auto-continue-btn');
        if (autoContinueBtn) {
            if (this.autoContinueEnabled) {
                autoContinueBtn.classList.add('enabled');
            } else {
                autoContinueBtn.classList.remove('enabled');
            }
        }
    }
    updatePlanModeButtonState() {
        const planModeBtn = document.getElementById('plan-mode-btn');
        if (planModeBtn) {
            if (this.planModeEnabled) {
                planModeBtn.classList.add('enabled');
            } else {
                planModeBtn.classList.remove('enabled');
            }
        }
    }
    toggleAutoContinue() {
        this.autoContinueEnabled = !this.autoContinueEnabled;
        this.preferences.autoContinueEnabled = this.autoContinueEnabled;
        this.saveAllPreferences();
        this.updateAutoContinueButtonState();
        if (this.autoContinueEnabled) {
            this.logAction('Auto-continue enabled', 'success');
        } else {
            this.logAction('Auto-continue disabled', 'info');
        }
    }
    updateVoiceButtonState() {
        const voiceBtn = document.getElementById('voice-btn');
        const icon = voiceBtn.querySelector('i');
        voiceBtn.classList.remove('recording', 'processing');
        if (icon) {
            if (this.isRecording) {
                voiceBtn.classList.add('recording');
                icon.setAttribute('data-lucide', 'mic');
            } else {
                icon.setAttribute('data-lucide', 'mic');
            }
        }
        lucide.createIcons();
    }
    updateAutoContinueButtonState() {
        const autoContinueBtn = document.getElementById('auto-continue-btn');
        if (autoContinueBtn) {
            if (this.autoContinueEnabled) {
                autoContinueBtn.classList.add('enabled');
            } else {
                autoContinueBtn.classList.remove('enabled');
            }
        }
    }
    handleMessageUpdate() {
        const input = document.getElementById('message-input');
        const content = input.value.trim();
        if (content && this.editingMessageId) {
            this.updateMessage(this.editingMessageId, content);
            this.cancelEdit();
        } else if (!content && this.editingMessageId) {
            this.deleteMessage(this.editingMessageId);
            this.cancelEdit();
        }
    }
    clearQueue() {
        if (this.messageQueue.length > 0) {
            const count = this.messageQueue.length;
            this.messageQueue = [];
            this.updateTrayBadge();
            this.saveMessageQueue();
            this.updateMessageList();
            this.updateStatusDisplay();
            this.logAction(`Cleared message queue (${count} messages removed)`, 'warning');
        }
    }
    updateMessageList() {
        const messageList = document.getElementById('message-list');
        messageList.innerHTML = '';
        // Add drag and drop event listeners to the message list container for better event handling
        if (!messageList.hasAttribute('data-drag-listeners-added')) {
            messageList.addEventListener('dragover', (e) => {
                e.preventDefault();
                this.handleDragOver(e);
            });
            messageList.addEventListener('drop', (e) => {
                e.preventDefault();
                this.handleDrop(e);
            });
            messageList.setAttribute('data-drag-listeners-added', 'true');
        }
        this.messageQueue.forEach((message, index) => {
            const messageElement = document.createElement('div');
            messageElement.className = 'message-item';
            messageElement.draggable = true;
            messageElement.dataset.messageId = message.id;
            messageElement.dataset.index = index;
            console.log('Created message element:', messageElement.draggable, messageElement.dataset);
            if (message.id === this.currentlyInjectingMessageId) {
                messageElement.classList.add('injecting');
            }
            // Set terminal color for message border
            const terminalId = message.terminalId || 1;
            const terminalData = this.terminals.get(terminalId);
            if (terminalData) {
                messageElement.style.setProperty('--terminal-color', terminalData.color);
                messageElement.setAttribute('data-terminal-color', terminalData.color);
            }
            messageElement.addEventListener('dragstart', (e) => {
                this.handleDragStart(e);
            });
            messageElement.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                this.handleDragOver(e);
            });
            messageElement.addEventListener('drop', (e) => {
                e.preventDefault();
                this.handleDrop(e);
            });
            messageElement.addEventListener('dragend', (e) => {
                this.handleDragEnd(e);
            });
            const content = document.createElement('div');
            content.className = 'message-content';
            // Add image previews if present
            if (message.imagePreviews && message.imagePreviews.length > 0) {
                const imagePreviewContainer = document.createElement('div');
                imagePreviewContainer.className = 'message-image-previews';
                const imagePreviewList = document.createElement('div');
                imagePreviewList.className = 'message-image-preview-list';
                
                const MAX_VISIBLE_IMAGES = 3;
                const totalImages = message.imagePreviews.length;
                
                // Show only first 3 images initially
                for (let i = 0; i < Math.min(MAX_VISIBLE_IMAGES, totalImages); i++) {
                    const imageData = message.imagePreviews[i];
                    const previewItem = document.createElement('div');
                    previewItem.className = 'message-image-preview-item';
                    const img = document.createElement('img');
                    img.src = URL.createObjectURL(imageData.file);
                    img.alt = imageData.file.name;
                    img.title = imageData.file.name;
                    img.addEventListener('click', () => this.showImagePreview(imageData));
                    previewItem.appendChild(img);
                    imagePreviewList.appendChild(previewItem);
                }
                
                // Add "+N more" button if there are more than MAX_VISIBLE_IMAGES
                if (totalImages > MAX_VISIBLE_IMAGES) {
                    const moreImagesBtn = document.createElement('div');
                    moreImagesBtn.className = 'message-image-more-btn';
                    moreImagesBtn.innerHTML = `+${totalImages - MAX_VISIBLE_IMAGES}`;
                    moreImagesBtn.title = `Show ${totalImages - MAX_VISIBLE_IMAGES} more images`;
                    moreImagesBtn.addEventListener('click', () => {
                        this.showAllImages(message.id, imagePreviewList, message.imagePreviews);
                    });
                    imagePreviewList.appendChild(moreImagesBtn);
                }
                
                imagePreviewContainer.appendChild(imagePreviewList);
                content.appendChild(imagePreviewContainer);
            }
            const textContent = document.createElement('div');
            textContent.className = 'message-text-content';
            textContent.textContent = message.content;
            content.appendChild(textContent);
            const meta = document.createElement('div');
            meta.className = 'message-meta';
            // Use timestamp, createdAt, or current time as fallback
            const messageTime = message.timestamp || message.createdAt || Date.now();
            const timestamp = new Date(messageTime).toLocaleTimeString();
            const timeStamp = document.createElement('span');
            timeStamp.className = 'message-timestamp';
            timeStamp.textContent = `Added at ${timestamp}`;
            meta.appendChild(timeStamp);

            // Add plan mode indicator if enabled for this message
            const shouldWrapWithPlan = message.wrapWithPlan !== undefined ? message.wrapWithPlan : this.planModeEnabled;
            if (shouldWrapWithPlan) {
                const planModeIndicator = document.createElement('span');
                planModeIndicator.className = 'plan-mode-indicator';
                planModeIndicator.innerHTML = ' <i data-lucide="clipboard"></i>';
                meta.appendChild(planModeIndicator);
            }
            content.appendChild(meta);
            const actions = document.createElement('div');
            actions.className = 'message-actions';
            const editBtn = document.createElement('button');
            editBtn.className = 'message-edit-btn';
            editBtn.innerHTML = '<i data-lucide="edit-3"></i>';
            editBtn.title = 'Edit message';
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.editMessage(message.id);
            });
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'message-delete-btn';
            deleteBtn.innerHTML = '<i data-lucide="trash-2"></i>';
            deleteBtn.title = 'Delete message';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteMessage(message.id);
            });
            const optionsBtn = document.createElement('button');
            optionsBtn.className = 'message-options-btn';
            optionsBtn.innerHTML = '<i data-lucide="more-horizontal"></i>';
            optionsBtn.title = 'Message options';
            actions.appendChild(editBtn);
            actions.appendChild(deleteBtn);
            actions.appendChild(optionsBtn);
            messageElement.appendChild(content);
            messageElement.appendChild(actions);
            messageList.appendChild(messageElement);
        });
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }
    async deleteMessage(messageId) {
        const index = this.messageQueue.findIndex(m => m.id === messageId);
        if (index !== -1) {
            const deletedMessage = this.messageQueue[index];
            // Mark as cancelled in backend if it has a backend ID
            if (this.backendAPIClient && deletedMessage.backendId) {
                try {
                    // Use the same inject endpoint but we'll update the backend to handle cancellation
                    await this.markMessageAsCancelledInBackend(deletedMessage);
                } catch (error) {
                    this.logAction(`Failed to cancel message in backend: ${error.message}`, 'error');
                }
            }
            this.messageQueue.splice(index, 1);
            this.updateTrayBadge();
            this.saveMessageQueue();
            this.updateMessageList();
            this.updateStatusDisplay();
            this.logAction(`Deleted message: "${deletedMessage.content}"`, 'warning');
        }
    }
    async markMessageAsCancelledInBackend(message) {
        // Mark message as cancelled in backend if it has a backend ID
        if (!this.backendAPIClient || !message.backendId) {
            return;
        }
        try {
            // For now, we'll mark it as injected to remove it from pending queue
            // TODO: Add a proper cancel endpoint to the backend
            await this.backendAPIClient.injectMessage(message.backendId);
            this.logAction(`Marked deleted message ${message.backendId} as processed in backend`, 'info');
        } catch (error) {
            this.logAction(`Failed to mark deleted message as processed in backend: ${error.message}`, 'error');
        }
    }
    editMessage(messageId) {
        // Cancel any existing edit first
        this.cancelEdit();
        const message = this.messageQueue.find(m => m.id === messageId);
        if (!message) return;
        // Find the message element in the DOM
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!messageElement) return;
        const contentElement = messageElement.querySelector('.message-content');
        if (!contentElement) return;
        // Store original content for cancellation
        this.editingMessageId = messageId;
        this.originalEditContent = message.content; // Use data model, not DOM
        // Create textarea for editing
        const textarea = document.createElement('textarea');
        textarea.value = message.content; // Use data model, not DOM
        textarea.className = 'message-content editing';
        textarea.style.width = '100%';
        textarea.style.height = 'auto';
        // Replace content with textarea
        contentElement.style.display = 'none';
        contentElement.parentNode.insertBefore(textarea, contentElement);
        // Focus textarea at the end of text
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        // Auto-resize textarea to fit content
        this.autoResizeTextarea(textarea);
        // Add event listeners for saving/canceling
        textarea.addEventListener('keydown', (e) => this.handleInPlaceEditKeydown(e, messageId, textarea, contentElement));
        textarea.addEventListener('blur', () => this.saveInPlaceEdit(messageId, textarea, contentElement));
        textarea.addEventListener('input', () => this.autoResizeTextarea(textarea));
        this.logAction(`Editing message: "${message.content}"`, 'info');
    }
    handleInPlaceEditKeydown(e, messageId, textarea, contentElement) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.saveInPlaceEdit(messageId, textarea, contentElement);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.cancelInPlaceEdit(textarea, contentElement);
        }
    }
    saveInPlaceEdit(messageId, textarea, contentElement) {
        const newContent = textarea.value.trim();
        if (newContent && newContent !== this.originalEditContent) {
            // Update the message
            this.updateMessage(messageId, newContent);
        } else if (!newContent) {
            // Delete message if empty
            this.deleteMessage(messageId);
            return; // Don't restore UI since message is deleted
        }
        // Restore the original UI by regenerating the message list
        this.updateMessageList();
        this.editingMessageId = null;
        this.originalEditContent = null;
    }
    cancelInPlaceEdit(textarea, contentElement) {
        // Restore original content by regenerating the message list
        this.updateMessageList();
        this.editingMessageId = null;
        this.originalEditContent = null;
    }
    autoResizeTextarea(textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = Math.max(40, textarea.scrollHeight) + 'px';
    }
    autoResizeMessageInput(textarea) {
        // Use actual CSS min/max height values
        const minHeight = 80; // Matches CSS min-height
        const maxHeight = 300; // Matches CSS max-height
        // Reset height to auto to get accurate scrollHeight
        textarea.style.height = 'auto';
        // Calculate new height within bounds
        const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
        textarea.style.height = newHeight + 'px';
        // Add scrollbar if content exceeds max height
        if (textarea.scrollHeight > maxHeight) {
            textarea.style.overflowY = 'auto';
        } else {
            textarea.style.overflowY = 'hidden';
        }
    }
    updateMessage(messageId, newContent) {
        const index = this.messageQueue.findIndex(m => m.id === messageId);
        if (index !== -1) {
            const oldContent = this.messageQueue[index].content;
            this.messageQueue[index].content = newContent;
            this.messageQueue[index].processedContent = newContent;
            this.saveMessageQueue();
            this.updateMessageList();
            this.updateStatusDisplay();
            this.logAction(`Updated message: "${oldContent}" → "${newContent}"`, 'info');
        }
    }
    cancelEdit() {
        if (this.editingMessageId) {
            // Find any active in-place editing and cancel it
            const editingTextarea = document.querySelector('.message-content.editing');
            if (editingTextarea) {
                const contentElement = editingTextarea.nextElementSibling;
                if (contentElement && this.originalEditContent) {
                    this.cancelInPlaceEdit(editingTextarea, contentElement);
                }
            }
        }
        // Reset editing state
        this.editingMessageId = null;
        this.originalEditContent = null;
    }
    async saveMessageQueue() {
        const maxRetries = 3;
        let retries = 0;
        while (retries < maxRetries) {
            try {
                // Atomically save entire message queue to prevent data loss
                const success = await ipcRenderer.invoke('db-save-message-queue', this.messageQueue);
                if (success) {
                    return; // Success, exit function
                } else {
                    console.error(`Failed to save message queue - database operation failed (attempt ${retries + 1}/${maxRetries})`);
                }
            } catch (error) {
                console.error(`Failed to save message queue (attempt ${retries + 1}/${maxRetries}):`, error);
            }
            retries++;
            if (retries < maxRetries) {
                // Wait before retrying (exponential backoff)
                await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retries)));
            }
        }
        // All retries failed
        this.logAction(`Failed to save message queue after ${maxRetries} attempts`, 'error');
        console.error('All attempts to save message queue failed - data may be lost on app restart');
    }
    async saveToMessageHistory(message, terminalId = null, counter = null) {
        try {
            const targetTerminalId = terminalId || message.terminalId || this.activeTerminalId;
            const injectionCounter = counter || this.injectionCount;
            const historyItem = {
                content: message.content || message.processedContent,
                timestamp: Date.now(),
                terminalId: targetTerminalId,
                counter: injectionCounter
            };
            // Save to local database
            await ipcRenderer.invoke('db-save-message-history', historyItem);
            // Also save to backend if available
            if (this.backendAPIClient) {
                try {
                    const backendSessionId = this.terminalSessionMap.get(targetTerminalId);
                    if (backendSessionId) {
                        await this.backendAPIClient.addMessageToHistory(
                            backendSessionId,
                            historyItem.content,
                            'manual',
                            targetTerminalId,
                            injectionCounter
                        );
                    }
                } catch (backendError) {
                    console.warn('Failed to save message history to backend:', backendError);
                }
            }
            // Update local array for UI (add id for compatibility)
            const localHistoryItem = {
                id: Date.now() + Math.random(),
                content: historyItem.content,
                timestamp: new Date().toISOString(),
                injectedAt: new Date().toLocaleString(),
                terminalId: targetTerminalId,
                counter: injectionCounter
            };
            this.messageHistory.unshift(localHistoryItem);
            // Keep only last 100 messages in memory
            if (this.messageHistory.length > 100) {
                this.messageHistory = this.messageHistory.slice(0, 100);
            }
            this.updateMessageHistoryDisplay();
        } catch (error) {
            console.error('Failed to save message history:', error);
        }
    }
    updateMessageHistoryDisplay() {
        // Update the history modal if it's open
        if (document.getElementById('message-history-modal').style.display === 'block') {
            this.updateHistoryModal();
        }
    }
    async loadMessageHistory() {
        // Load from local preferences first
        this.messageHistory = this.preferences.messageHistory || [];
        // Also try to load from backend if available
        if (this.backendAPIClient) {
            try {
                const backendHistory = await this.backendAPIClient.getMessageHistory();
                if (backendHistory && backendHistory.length > 0) {
                    // Convert backend format to local format
                    const convertedHistory = backendHistory.map(item => ({
                        id: item.id,
                        content: item.message,
                        timestamp: item.timestamp,
                        injectedAt: new Date(item.timestamp).toLocaleString(),
                        terminalId: item.terminal_id,
                        counter: item.counter
                    }));
                    // Merge with local history, preferring backend data
                    this.messageHistory = convertedHistory.concat(this.messageHistory);
                    // Remove duplicates and keep only last 100
                    const uniqueHistory = [];
                    const seen = new Set();
                    for (const item of this.messageHistory) {
                        const key = `${item.content}-${item.terminalId}-${item.counter}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            uniqueHistory.push(item);
                        }
                    }
                    this.messageHistory = uniqueHistory.slice(0, 100);
                }
            } catch (backendError) {
                console.warn('Failed to load message history from backend:', backendError);
            }
        }
    }
    clearMessageHistory() {
        this.messageHistory = [];
        this.preferences.messageHistory = [];
        this.saveAllPreferences();
        this.updateHistoryModal();
    }
    // New timer system functions
    toggleTimer() {
        if (this.timerActive) {
            this.pauseTimer();
        } else {
            this.startTimer();
        }
    }
    toggleTimerOrInjection() {
        // Check if any injections are active (either legacy or new system)
        const hasActiveInjections = this.injectionInProgress || 
                                   this.currentlyInjectingMessages.size > 0 ||
                                   (this.timerExpired && this.messageQueue.length > 0);
        // If injection is in progress or timer expired with messages, handle injection pause/resume
        if (hasActiveInjections) {
            if (this.injectionPaused) {
                this.resumeInjectionExecution();
            } else {
                this.pauseInjectionExecution();
            }
        } else {
            // Otherwise, handle timer pause/resume
            this.toggleTimer();
        }
    }
    startTimer() {
        if (this.timerHours === 0 && this.timerMinutes === 0 && this.timerSeconds === 0) {
            this.logAction('Cannot start timer - time not set', 'warning');
            return;
        }
        // Clear any existing timer interval before starting a new one
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        this.timerActive = true;
        this.timerExpired = false;
        this.updateTimerUI();
        // Resume injections if they were paused by timer pause
        if (this.injectionPaused && this.injectionPausedByTimer) {
            this.injectionPausedByTimer = false;
            this.resumeInjectionExecution();
            this.logAction('Timer started - resuming paused injections', 'info');
        } else {
            this.logAction('Timer started', 'info');
        }
        this.timerInterval = setInterval(async () => {
            try {
                await this.decrementTimer();
            } catch (error) {
                // Throttle error logging to prevent console spam
                if (!this.lastTimerError || Date.now() - this.lastTimerError > 5000) {
                    this.lastTimerError = Date.now();
                    try {
                        console.error('Error in decrementTimer:', error);
                    } catch (consoleError) {
                        // Ignore console errors to prevent EIO crashes
                    }
                    this.logAction('Timer error: ' + error.message, 'error');
                }
            }
        }, 1000);
    }
    pauseTimer() {
        this.timerActive = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        // Also pause any active injections when timer is paused
        const hasActiveInjections = this.injectionInProgress || 
                                   this.currentlyInjectingMessages.size > 0 ||
                                   (this.timerExpired && this.messageQueue.length > 0);
        if (hasActiveInjections && !this.injectionPaused) {
            this.injectionPausedByTimer = true; // Track that timer pause triggered this
            this.pauseInjectionExecution();
            this.logAction('Timer paused - also pausing active injections', 'info');
        } else {
            this.logAction('Timer paused', 'info');
        }
        this.updateTimerUI();
    }
    stopTimer() {
        this.timerActive = false;
        this.timerExpired = false;
        this.injectionInProgress = false;
        this.injectionPausedByTimer = false; // Clear timer pause flag
        this.usageLimitWaiting = false;
        this.usageLimitTimerOriginalValues = null; // Clear stored timer values
        this.savePreferences(); // Save usage limit state
        this.timerHours = 0;
        this.timerMinutes = 0;
        this.timerSeconds = 0;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        // Cancel all active injections
        this.currentlyInjectingMessages.clear();
        this.currentlyInjectingTerminals.clear();
        // Clear any injection scheduling timers
        if (this.injectionTimer) {
            clearTimeout(this.injectionTimer);
            this.injectionTimer = null;
        }
        // Clear usage limit tracking when timer is stopped
        this.clearUsageLimitTracking();
        // Notify injection manager
        this.injectionManager.onTimerStopped();
        // Stop power save blocker when timer is stopped
        this.stopPowerSaveBlocker();
        // Update all terminal statuses
        this.terminals.forEach((terminalData, terminalId) => {
            this.setTerminalStatusDisplay('', terminalId);
        });
        this.updateTimerUI();
        this.logAction('Timer stopped and reset', 'info');
    }
    async decrementTimer() {
        if (this.timerSeconds > 0) {
            this.timerSeconds--;
        } else if (this.timerMinutes > 0) {
            this.timerMinutes--;
            this.timerSeconds = 59;
        } else if (this.timerHours > 0) {
            this.timerHours--;
            this.timerMinutes = 59;
            this.timerSeconds = 59;
        } else {
            // Timer reached 00:00:00
            const wasUsageLimitWaiting = this.usageLimitWaiting;
            
            // Clear usage limit state when timer expires naturally
            if (this.usageLimitWaiting) {
                this.logAction('Usage limit timer reached 00:00:00 - clearing usage limit state', 'info');
                this.usageLimitWaiting = false;
                this.usageLimitTimerOriginalValues = null;
                // Clear usage limit state from database
                if (typeof electronAPI !== 'undefined' && electronAPI.setUsageLimitWaiting) {
                    electronAPI.setUsageLimitWaiting(false);
                }
            }
            
            // Normal timer expiry
            this.timerExpired = true;
            this.timerActive = false;
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            
            // Always clear timer values when timer reaches 0 to prevent 23-hour loop
            this.preferences.timerTargetDateTime = null;
            this.preferences.timerHours = 0;
            this.preferences.timerMinutes = 0;
            this.preferences.timerSeconds = 0;
            this.saveAllPreferences();
            
            if (wasUsageLimitWaiting) {
                this.logAction('Usage limit timer expired - timer cleared to prevent repopulation loop', 'info');
            }
            
            // Notify injection manager
            this.injectionManager.onTimerExpired();
            // If we were waiting for usage limit reset (shouldn't happen with the new logic above)
            if (this.usageLimitWaiting) {
                this.logAction(`Timer expiration: clearing usageLimitWaiting. Current state - injectionInProgress: ${this.injectionInProgress}, queueLength: ${this.messageQueue.length}`, 'info');
                this.usageLimitWaiting = false;
                this.savePreferences(); // Save usage limit state
                this.injectionManager.onUsageLimitReset();
                this.logAction('Usage limit reset time reached - resuming auto injection', 'success');
                // Clear usage limit tracking since the reset time has been reached
                this.clearUsageLimitTracking();
                // Clear the saved reset time state to allow fresh detection cycles
                // This prevents re-processing old usage limit messages from terminal buffer
                try {
                    await ipcRenderer.invoke('db-set-app-state', 'usageLimitTimerLastResetTime', null);
                } catch (error) {
                    console.error('Error clearing usage limit timer state:', error);
                }
                // Set one-hour cooldown period to prevent reactivation
                this.usageLimitCooldownUntil = Date.now() + (60 * 60 * 1000); // 1 hour from now
                this.logAction('Usage limit detection disabled for 1 hour to prevent reactivation', 'info');
                // Comprehensively clear any stuck injection states when timer expires
                this.isInjecting = false;
                this.injectionInProgress = false;
                this.currentlyInjectingMessageId = null;
                this.safetyCheckCount = 0;
                // Explicitly update terminal status to clear any stuck "injecting" state
                this.updateTerminalStatusIndicator();
            }
            // Update timer UI but let injection manager handle visual states
            this.updateTimerDisplay();
            // Show notification for timer expiration
            this.showSystemNotification('Timer Expired', `Injection timer has expired. ${this.messageQueue.length} messages queued.`);
            this.logAction(`Timer expiration: injection manager will handle scheduling. queueLength: ${this.messageQueue.length}`, 'info');
            return;
        }
        // Only update display, not full UI on every tick for performance
        this.updateTimerDisplay();
    }
    updateTimerDisplay() {
        const display = document.getElementById('timer-display');
        // Show "Waiting..." when usage limit modal is active
        if (this.usageLimitModalShowing) {
            display.textContent = 'Waiting...';
            return;
        }
        const hours = String(this.timerHours).padStart(2, '0');
        const minutes = String(this.timerMinutes).padStart(2, '0');
        const seconds = String(this.timerSeconds).padStart(2, '0');
        display.textContent = `${hours}:${minutes}:${seconds}`;
    }
    updateTimerUI() {
        const playPauseBtn = document.getElementById('timer-play-pause-btn');
        const stopBtn = document.getElementById('timer-stop-btn');
        const editBtn = document.getElementById('timer-edit-btn');
        const injectionStatus = document.getElementById('injection-status');
        const waitingStatus = document.getElementById('timer-waiting-status');
        const display = document.getElementById('timer-display');
        if (!playPauseBtn || !stopBtn || !editBtn || !display) {
            console.warn('Timer UI elements not found');
            return;
        }
        // Update display
        this.updateTimerDisplay();
        // Update display classes
        // If timer is expired, let injection manager handle visual state
        if (this.timerExpired) {
            this.injectionManager.updateVisualState();
            // Don't update classes here - injection manager will do it
        } else {
            // Timer not expired - handle normally
            display.className = 'timer-display';
            if (this.timerActive) {
                display.classList.add('active');
            }
        }
        // Update play/pause button
        // Check if any injections are active (legacy or new system)
        const hasActiveInjectionsForButton = this.injectionInProgress || 
                                            this.currentlyInjectingMessages.size > 0 ||
                                            (this.timerExpired && this.messageQueue.length > 0) ||
                                            this.injectionPaused;
        if (hasActiveInjectionsForButton) {
            // During injection, show pause/resume for injection execution
            if (this.injectionPaused) {
                playPauseBtn.innerHTML = '<i data-lucide="play"></i>';
                playPauseBtn.classList.add('paused');
                playPauseBtn.classList.remove('active');
                playPauseBtn.title = 'Resume injection execution';
            } else {
                playPauseBtn.innerHTML = '<i data-lucide="pause"></i>';
                playPauseBtn.classList.add('active');
                playPauseBtn.classList.remove('paused');
                playPauseBtn.title = 'Pause injection execution';
            }
        } else if (this.timerActive) {
            playPauseBtn.innerHTML = '<i data-lucide="pause"></i>';
            playPauseBtn.classList.add('active');
            playPauseBtn.classList.remove('paused');
            playPauseBtn.title = 'Pause timer';
        } else {
            playPauseBtn.innerHTML = '<i data-lucide="play"></i>';
            playPauseBtn.classList.remove('active', 'paused');
            playPauseBtn.title = 'Start timer';
        }
        // Update stop/refresh button
        const timerIsSet = this.timerHours > 0 || this.timerMinutes > 0 || this.timerSeconds > 0;
        const timerAtZero = this.timerHours === 0 && this.timerMinutes === 0 && this.timerSeconds === 0;
        // Check if any injections are active (legacy or new system)
        const hasActiveInjections = this.injectionInProgress || 
                                   this.currentlyInjectingMessages.size > 0 ||
                                   (this.timerExpired && this.messageQueue.length > 0) ||
                                   this.injectionPaused;
        if (hasActiveInjections) {
            // Show cancel button during injection or when paused
            stopBtn.style.display = 'flex';
            stopBtn.innerHTML = '<i data-lucide="square"></i>';
            stopBtn.title = 'Cancel injection';
            stopBtn.className = 'timer-btn timer-cancel-injection';
        } else if (this.timerActive || (timerIsSet && !timerAtZero)) {
            // Show stop button when timer is active or set to non-zero value
            stopBtn.style.display = 'flex';
            stopBtn.innerHTML = '<i data-lucide="square"></i>';
            stopBtn.title = 'Stop timer';
            stopBtn.className = 'timer-btn timer-stop';
        } else if (timerAtZero && !this.timerActive && !hasActiveInjections) {
            // Show refresh button when timer is at 00:00:00 and not active/injecting
            stopBtn.style.display = 'flex';
            stopBtn.innerHTML = '<i data-lucide="refresh-cw"></i>';
            stopBtn.title = 'Reset timer to last saved value';
            stopBtn.className = 'timer-btn timer-refresh';
        } else {
            stopBtn.style.display = 'none';
        }
        // Update edit button / status display
        // If timer is expired, injection manager handles the status display
        if (!this.timerExpired) {
            // Timer not expired - handle normally
            if (this.injectionInProgress) {
                editBtn.style.display = 'none';
                if (waitingStatus) waitingStatus.style.display = 'none';
                if (injectionStatus) injectionStatus.style.display = 'inline';
            } else if (this.timerActive) {
                editBtn.style.display = 'none';
                if (waitingStatus) {
                    waitingStatus.style.display = 'inline';
                    waitingStatus.textContent = 'Waiting...';
                }
                if (injectionStatus) injectionStatus.style.display = 'none';
            } else {
                editBtn.style.display = 'flex';
                if (waitingStatus) waitingStatus.style.display = 'none';
                if (injectionStatus) injectionStatus.style.display = 'none';
            }
        } else {
            // Timer expired - make sure injection manager updates visual state
            this.injectionManager.updateVisualState();
        }
        // Reinitialize lucide icons to apply icon changes
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }
    openTimerEditDropdown(event) {
        // Close any existing dropdowns
        this.closeAllTimerDropdowns();
        const button = event.target.closest('button');
        // Store original values for potential revert
        this.originalTimerValues = {
            hours: this.timerHours,
            minutes: this.timerMinutes,
            seconds: this.timerSeconds
        };
        // Create dropdown
        const dropdown = document.createElement('div');
        dropdown.className = 'timer-edit-dropdown';
        dropdown.innerHTML = `
            <div class="timer-edit-content">
                <div class="timer-edit-header">Set Timer</div>
                <div class="timer-edit-form">
                    <div class="timer-segments-row">
                        <div class="timer-segment" data-segment="hours">
                            <input type="text" class="timer-segment-input" value="${String(this.timerHours).padStart(2, '0')}" maxlength="2" data-segment="hours" data-test-id="timer-hours-input">
                            <span class="timer-segment-label">HH</span>
                        </div>
                        <span class="timer-separator">:</span>
                        <div class="timer-segment" data-segment="minutes">
                            <input type="text" class="timer-segment-input" value="${String(this.timerMinutes).padStart(2, '0')}" maxlength="2" data-segment="minutes" data-test-id="timer-minutes-input">
                            <span class="timer-segment-label">MM</span>
                        </div>
                        <span class="timer-separator">:</span>
                        <div class="timer-segment" data-segment="seconds">
                            <input type="text" class="timer-segment-input" value="${String(this.timerSeconds).padStart(2, '0')}" maxlength="2" data-segment="seconds" data-test-id="timer-seconds-input">
                            <span class="timer-segment-label">SS</span>
                        </div>
                    </div>
                    <div class="timer-edit-actions">
                        <button class="timer-edit-btn-action timer-save-btn" id="save-timer" data-test-id="timer-save-btn">Done</button>
                        <button class="timer-edit-btn-action timer-cancel-btn" id="cancel-timer" data-test-id="timer-cancel-btn">Cancel</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(dropdown);
        // Position dropdown
        const rect = button.getBoundingClientRect();
        const dropdownRect = dropdown.getBoundingClientRect();
        let left = rect.left - dropdownRect.width;
        let top = rect.top - dropdownRect.height;
        if (left < 10) {
            left = 10;
        }
        if (top < 10) {
            top = rect.bottom + 10;
        }
        dropdown.style.left = left + 'px';
        dropdown.style.top = top + 'px';
        // Set up drag and click functionality for each segment with auto-save
        this.setupTimerSegmentInteractions(dropdown);
        // Done button (just closes dropdown since changes are auto-saved)
        dropdown.querySelector('#save-timer').addEventListener('click', () => {
            this.closeAllTimerDropdowns();
        });
        // Cancel button (reverts changes)
        dropdown.querySelector('#cancel-timer').addEventListener('click', () => {
            // Revert to original values
            this.setTimer(this.originalTimerValues.hours, this.originalTimerValues.minutes, this.originalTimerValues.seconds);
            this.closeAllTimerDropdowns();
        });
        // Close dropdown when clicking outside (auto-saves)
        const closeHandler = (event) => {
            // Don't close if we're currently dragging
            if (dropdown._isAnySegmentDragging && dropdown._isAnySegmentDragging()) return;
            if (!event.target.closest('.timer-edit-dropdown') && !event.target.closest('#timer-edit-btn')) {
                this.closeAllTimerDropdowns();
                document.removeEventListener('click', closeHandler);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', closeHandler);
        }, 100);
    }
    setupTimerSegmentInteractions(dropdown) {
        const segments = dropdown.querySelectorAll('.timer-segment');
        let isAnySegmentDragging = false;
        // Auto-save function
        const autoSave = () => {
            const hoursInput = dropdown.querySelector('.timer-segment-input[data-segment="hours"]');
            const minutesInput = dropdown.querySelector('.timer-segment-input[data-segment="minutes"]');
            const secondsInput = dropdown.querySelector('.timer-segment-input[data-segment="seconds"]');
            const hours = Math.max(0, Math.min(23, parseInt(hoursInput.value) || 0));
            const minutes = Math.max(0, Math.min(59, parseInt(minutesInput.value) || 0));
            const seconds = Math.max(0, Math.min(59, parseInt(secondsInput.value) || 0));
            this.setTimer(hours, minutes, seconds, true); // Silent mode to prevent log spam
        };
        segments.forEach(segment => {
            const input = segment.querySelector('.timer-segment-input');
            const segmentType = segment.dataset.segment;
            let isDragging = false;
            let startY = 0;
            let startValue = 0;
            let clickTimeout = null;
            // Mouse down - start drag or prepare for click
            segment.addEventListener('mousedown', (e) => {
                e.preventDefault();
                startY = e.clientY;
                startValue = parseInt(input.value) || 0;
                isDragging = false;
                // Set a timeout to detect if this is a click vs drag
                clickTimeout = setTimeout(() => {
                    // This is a click, not a drag - select the input
                    input.focus();
                    input.select();
                    clickTimeout = null;
                }, 150);
                const handleMouseMove = (e) => {
                    if (clickTimeout) {
                        clearTimeout(clickTimeout);
                        clickTimeout = null;
                    }
                    if (!isDragging) {
                        isDragging = true;
                        isAnySegmentDragging = true;
                        segment.classList.add('dragging');
                    }
                    const deltaY = startY - e.clientY;
                    const sensitivity = 5; // pixels per increment
                    const change = Math.floor(deltaY / sensitivity);
                    let newValue = startValue + change;
                    // Apply limits based on segment type
                    if (segmentType === 'hours') {
                        newValue = Math.max(0, Math.min(23, newValue));
                    } else {
                        newValue = Math.max(0, Math.min(59, newValue));
                    }
                    input.value = String(newValue).padStart(2, '0');
                    autoSave(); // Auto-save on drag change
                };
                const handleMouseUp = () => {
                    if (clickTimeout) {
                        clearTimeout(clickTimeout);
                        clickTimeout = null;
                        // This was a quick click, focus the input
                        input.focus();
                        input.select();
                    }
                    segment.classList.remove('dragging');
                    isDragging = false;
                    // Reset dragging state with a small delay to prevent dropdown closing
                    setTimeout(() => {
                        isAnySegmentDragging = false;
                    }, 100);
                    document.removeEventListener('mousemove', handleMouseMove);
                    document.removeEventListener('mouseup', handleMouseUp);
                };
                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
            });
            // Handle direct input
            input.addEventListener('input', (e) => {
                let value = e.target.value.replace(/[^0-9]/g, '');
                if (value.length > 2) value = value.slice(0, 2);
                let numValue = parseInt(value) || 0;
                if (segmentType === 'hours') {
                    numValue = Math.min(23, numValue);
                } else {
                    numValue = Math.min(59, numValue);
                }
                e.target.value = value;
            });
            // Format on blur and auto-save
            input.addEventListener('blur', (e) => {
                const value = parseInt(e.target.value) || 0;
                e.target.value = String(value).padStart(2, '0');
                autoSave(); // Auto-save on blur
            });
            // Handle keyboard shortcuts
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    autoSave(); // Auto-save on enter
                    dropdown.querySelector('#save-timer').click();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    dropdown.querySelector('#cancel-timer').click();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    let value = parseInt(input.value) || 0;
                    if (segmentType === 'hours') {
                        value = Math.min(23, value + 1);
                    } else {
                        value = Math.min(59, value + 1);
                    }
                    input.value = String(value).padStart(2, '0');
                    autoSave(); // Auto-save on arrow key change
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    let value = Math.max(0, (parseInt(input.value) || 0) - 1);
                    input.value = String(value).padStart(2, '0');
                    autoSave(); // Auto-save on arrow key change
                }
            });
        });
        // Store reference to dragging state for dropdown close handler
        dropdown._isAnySegmentDragging = () => isAnySegmentDragging;
    }
    closeAllTimerDropdowns() {
        const dropdowns = document.querySelectorAll('.timer-edit-dropdown');
        dropdowns.forEach(dropdown => dropdown.remove());
    }
    closeTimerDropdownOnOutsideClick(event) {
        if (!event.target.closest('.timer-edit-dropdown') && !event.target.closest('#timer-edit-btn')) {
            this.closeAllTimerDropdowns();
        }
    }
    setTimer(hours, minutes, seconds, silent = false) {
        // Disable auto-sync when user manually sets timer
        this.disableAutoSync(silent);
        this.timerHours = Math.max(0, Math.min(23, hours));
        this.timerMinutes = Math.max(0, Math.min(59, minutes));
        this.timerSeconds = Math.max(0, Math.min(59, seconds));
        this.timerExpired = false;
        // Calculate target datetime when timer should expire
        const totalSeconds = (this.timerHours * 3600) + (this.timerMinutes * 60) + this.timerSeconds;
        const targetDateTime = new Date(Date.now() + (totalSeconds * 1000));
        // Save timer values and target datetime to preferences for persistence
        this.preferences.timerHours = this.timerHours;
        this.preferences.timerMinutes = this.timerMinutes;
        this.preferences.timerSeconds = this.timerSeconds;
        this.preferences.timerTargetDateTime = targetDateTime.toISOString();
        this.saveAllPreferences();
        this.updateTimerUI();
        // Only log when not in silent mode
        if (!silent) {
            this.logAction(`Timer set to ${String(this.timerHours).padStart(2, '0')}:${String(this.timerMinutes).padStart(2, '0')}:${String(this.timerSeconds).padStart(2, '0')} (expires at ${targetDateTime.toLocaleString()})`, 'info');
        }
    }
    disableAutoSync(silent = false) {
        this.autoSyncEnabled = false;
        this.stopUsageLimitSync();
        // Only log when not in silent mode
        if (!silent) {
            this.logAction('Auto-sync disabled - user manually changed timer', 'info');
        }
    }
    // REMOVED: Legacy sequential injection system - replaced with parallel injection
    async startSequentialInjection() {
        if (this.messageQueue.length === 0) {
            this.logAction('Timer expired but no messages to inject', 'warning');
            return;
        }
        // Enhanced state recovery: detect and fix various stuck state combinations
        if (this.injectionInProgress && !this.isInjecting) {
            this.logAction('Detected stuck injection state (injectionInProgress without isInjecting) - recovering', 'warning');
            this.injectionInProgress = false;
            this.isInjecting = false;
            this.safetyCheckCount = 0;
        }
        // Additional recovery: if isInjecting is stuck true when starting new injection sequence
        if (this.isInjecting && this.timerExpired && !this.usageLimitWaiting) {
            this.logAction('Detected stuck isInjecting state - clearing for timer sequence', 'warning');
            this.isInjecting = false;
            this.currentlyInjectingMessageId = null;
            this.safetyCheckCount = 0;
        }
        // Additional recovery: if we're not in an injection state but timer expired, we should be injecting
        if (!this.injectionInProgress && this.timerExpired && !this.usageLimitWaiting) {
            this.logAction('Timer expired but injection not in progress - forcing start', 'warning');
        }
        // Validate state BEFORE making any changes
        this.validateInjectionState('startSequentialInjection-before');
        // Start power save blocker if enabled
        if (this.preferences.keepScreenAwake) {
            await this.startPowerSaveBlocker();
        }
        this.injectionInProgress = true;
        this.updateTimerUI();
        this.showSystemNotification('Injection Started', `Sequential injection of ${this.messageQueue.length} messages has begun.`);
        this.logAction(`Timer expired - starting sequential injection of ${this.messageQueue.length} messages (timerExpired=${this.timerExpired}, usageLimitWaiting=${this.usageLimitWaiting})`, 'success');
        // Validate state after setting injection progress
        this.validateInjectionState('startSequentialInjection-after');
        // Start with first message (no 30-second delay for first message)
        this.processNextQueuedMessage(true);
    }
    // State validation helper for debugging injection issues
    validateInjectionState(context) {
        const state = {
            injectionInProgress: this.injectionInProgress,
            isInjecting: this.isInjecting,
            timerExpired: this.timerExpired,
            usageLimitWaiting: this.usageLimitWaiting,
            queueLength: this.messageQueue.length,
            context: context
        };
        this.logAction(`State validation [${context}]: ${JSON.stringify(state)}`, 'info');
        // Check for problematic state combinations
        if (this.timerExpired && this.usageLimitWaiting) {
            this.logAction('WARNING: Both timerExpired and usageLimitWaiting are true - potential conflict', 'warning');
        }
        if (this.injectionInProgress && this.messageQueue.length === 0) {
            this.logAction('WARNING: Injection in progress but queue is empty', 'warning');
        }
        if (!this.injectionInProgress && this.isInjecting) {
            this.logAction('WARNING: isInjecting true but injectionInProgress false - inconsistent state', 'warning');
        }
    }
    processNextQueuedMessage(isFirstMessage = false) {
        this.validateInjectionState(`processNextQueuedMessage(isFirstMessage=${isFirstMessage})`);
        if (this.messageQueue.length === 0) {
            // Sequential injection is complete - reset all states
            this.injectionInProgress = false;
            // Only reset timerExpired if we're not waiting for usage limit reset
            // This prevents breaking waitForStableReadyState after timer expiration
            if (!this.usageLimitWaiting) {
                this.timerExpired = false; // Reset timer expired state when injection completes normally
            }
            this.safetyCheckCount = 0; // Reset safety check count
            this.updateTimerUI();
            this.logAction('Sequential injection completed - all messages processed', 'success');
            this.showSystemNotification('Injection Complete', 'All messages have been successfully injected.');
            // Stop power save blocker
            this.stopPowerSaveBlocker();
            // Play completion sound effect
            this.onAutoInjectionComplete();
            return;
        }
        // Reset safety check count for each new message
        this.safetyCheckCount = 0;
        if (isFirstMessage) {
            // No delay for first message - start safety checks immediately
            this.logAction('Starting safety checks for first message (no delay)', 'info');
            this.performSafetyChecks(() => {
                // Safety checks passed - inject the message
                this.injectMessageAndContinueQueue();
            });
                 } else {
             // Use injection manager for proper plan mode delay handling
             this.injectionManager.scheduleNextInjection();
             return; // Exit early since injection manager will handle the rest
         }
    }
    injectMessageAndContinueQueue() {
        console.log('=== injectMessageAndContinueQueue called ===');
        this.validateInjectionState('injectMessageAndContinueQueue');
        if (this.messageQueue.length === 0) {
            this.scheduleNextInjection();
            return;
        }
        const message = this.messageQueue.shift();
        this.saveMessageQueue(); // Save queue changes to backend database
        this.isInjecting = true;
        // Keep injectionInProgress true throughout the entire sequence
        this.currentlyInjectingMessageId = message.id; // Track which message is being injected
        this.updateTerminalStatusIndicator(); // Use new status system
        this.updateMessageList(); // Update UI to show injecting state
        // Mark message as injected in backend
        this.markMessageAsInjectedInBackend(message);
        this.logAction(`Sequential injection: "${message.content}"`, 'success');
        this.showSystemNotification('Message Injected', `Injecting: ${message.content.substring(0, 50)}${message.content.length > 50 ? '...' : ''}`);
        // Handle plan mode wrapping and Ctrl+C injection
        console.log('Sequential injection - message:', message);
        // Handle backward compatibility - if wrapWithPlan is undefined, use global plan mode
        const shouldWrapWithPlan = message.wrapWithPlan !== undefined ? message.wrapWithPlan : this.planModeEnabled;
        if (shouldWrapWithPlan) {
            this.injectMessageWithPlanMode(message, () => {
                this.injectionCount++;
                this.saveToMessageHistory(message, this.activeTerminalId, this.injectionCount);
                this.updateStatusDisplay();
                this.updateMessageList();
                // Send Enter key with random delay for human-like behavior
                const enterDelay = this.getRandomDelay(150, 300);
                setTimeout(() => {
                    ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: '\r' });
                    // Add post-injection delay to ensure command has time to start executing
                    const postInjectionDelay = this.getRandomDelay(500, 800);
                    setTimeout(() => {
                        this.isInjecting = false;
                        this.currentlyInjectingMessageId = null;
                        this.scheduleNextInjection();
                    }, postInjectionDelay);
                }, enterDelay);
            });
        } else {
            // Type the message normally
            this.typeMessage(message.processedContent, () => {
                this.injectionCount++;
                this.saveToMessageHistory(message, this.activeTerminalId, this.injectionCount); // Save to history after successful injection
                this.updateStatusDisplay();
                this.updateMessageList();
                // Send Enter key with random delay for human-like behavior
                const enterDelay = this.getRandomDelay(150, 300);
                setTimeout(() => {
                    ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: '\r' });
                    // Add post-injection delay to ensure command has time to start executing
                    // This prevents the next message from being injected too quickly
                    const postInjectionDelay = this.getRandomDelay(500, 800);
                    setTimeout(() => {
                        this.isInjecting = false;
                        // Don't reset injectionInProgress here - keep it true for the entire sequence
                        this.currentlyInjectingMessageId = null; // Clear injecting message tracking
                        this.updateTerminalStatusIndicator(); // Use new status system
                        this.updateMessageList(); // Update UI to clear injecting state
                        // Continue with next message after a short delay (only for timer-based injection)
                        // Move this inside the post-injection delay to ensure proper sequencing
                        if (this.timerExpired) {
                            const nextMessageDelay = this.getRandomDelay(800, 1200);
                            setTimeout(() => {
                                this.scheduleNextInjection();
                            }, nextMessageDelay);
                        } else {
                            // Manual injection complete - reset all states
                            this.injectionInProgress = false;
                            this.logAction('Manual injection complete - stopped after one message', 'info');
                        }
                    }, postInjectionDelay);
                }, enterDelay);
            });
        }
    }
    injectMessageWithPlanMode(message, callback) {
        // Step 1: Inject ^C^C
        this.typeMessage('^C^C', () => {
            setTimeout(() => {
                // Step 2: Inject ^C
                this.typeMessage('^C', () => {
                    setTimeout(() => {
                        // Step 3: Inject ^C (additional)
                        this.typeMessage('^C', () => {
                            // Step 4: Inject ANOTHER ^C
                            this.typeMessage('^C', () => {
                                setTimeout(() => {
                                    // Step 5: Inject the wrapped message
                                    // Escape the message content to prevent shell injection issues
                                    const escapedContent = message.content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\r/g, '');
                                    const wrappedMessage = this.planModeCommand.replace('{message}', escapedContent);
                                    this.typeMessage(wrappedMessage, callback);
                                }, this.getRandomDelay(100, 500));
                            });
                        });
                    }, this.getRandomDelay(100, 200));
                });
            }, this.getRandomDelay(100, 200));
        });
    }
    injectMessageWithPlanModeToTerminal(message, terminalId, callback) {
        // Step 1: Inject ^C^C to specific terminal
        this.typeMessageToTerminal('^C^C', terminalId, () => {
            setTimeout(() => {
                // Step 2: Inject ^C
                this.typeMessageToTerminal('^C', terminalId, () => {
                    setTimeout(() => {
                        // Step 3: Inject ^C (additional)
                        this.typeMessageToTerminal('^C', terminalId, () => {
                            setTimeout(() => {
                                // Step 4: Inject the wrapped message
                                // Escape the message content to prevent shell injection issues
                                const escapedContent = message.content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ').replace(/\r/g, '');
                                const wrappedMessage = this.planModeCommand.replace('{message}', escapedContent);
                                this.typeMessageToTerminal(wrappedMessage, terminalId, () => {
                                    setTimeout(() => {
                                        // Step 5: Press Enter to execute the command
                                        ipcRenderer.send('terminal-input', { terminalId: terminalId, data: '\r' });
                                        if (callback) callback();
                                    }, this.getRandomDelay(100, 200));
                                });
                            }, this.getRandomDelay(100, 200));
                        });
                    }, this.getRandomDelay(100, 200));
                });
            }, this.getRandomDelay(100, 200));
        });
    }
    cancelSequentialInjection() {
        // Stop all injection processes
        this.injectionInProgress = false;
        this.injectionPaused = false; // Clear pause state
        this.timerExpired = false;
        this.safetyCheckCount = 0;
        this.isInjecting = false;
        this.currentlyInjectingMessageId = null; // Clear injecting message tracking
        // Clear new injection system state
        this.currentlyInjectingMessages.clear();
        this.currentlyInjectingTerminals.clear();
        // Clear any injection scheduling timers
        if (this.injectionTimer) {
            clearTimeout(this.injectionTimer);
            this.injectionTimer = null;
        }
        // Clear any pending safety check timeouts
        if (this.safetyCheckInterval) {
            clearInterval(this.safetyCheckInterval);
            this.safetyCheckInterval = null;
        }
        // Clear any in-progress typing
        if (this.currentTypeInterval) {
            clearInterval(this.currentTypeInterval);
            this.currentTypeInterval = null;
        }
        // Notify injection manager
        this.injectionManager.onTimerStopped();
        // Stop power save blocker
        this.stopPowerSaveBlocker();
        // Update all terminal statuses
        this.terminals.forEach((terminalData, terminalId) => {
            this.setTerminalStatusDisplay('', terminalId);
        });
        // Update UI and status
        this.updateTimerUI();
        this.updateTerminalStatusIndicator(); // Use proper status update
        this.updateMessageList(); // Update UI to clear injecting state
        this.logAction(`Sequential injection cancelled - ${this.messageQueue.length} messages remaining in queue`, 'warning');
    }
    pauseInProgressInjection() {
        if (this.injectionInProgress) {
            // Pause all injection processes but keep the queue intact
            this.injectionInProgress = false;
            this.isInjecting = false;
            this.currentlyInjectingMessageId = null;
            // Clear any pending safety check timeouts
            if (this.safetyCheckInterval) {
                clearInterval(this.safetyCheckInterval);
                this.safetyCheckInterval = null;
            }
            // Clear any in-progress typing
            if (this.currentTypeInterval) {
                clearInterval(this.currentTypeInterval);
                this.currentTypeInterval = null;
            }
            // Update UI to show waiting state
            this.updateTimerUI();
            this.updateTerminalStatusIndicator();
            this.updateMessageList();
            this.logAction('Injection paused due to usage limit modal - waiting for user choice', 'info');
        }
    }
    // Add emergency reset function for stuck states
    forceResetInjectionState() {
        this.logAction('Force resetting injection state - clearing all flags', 'warning');
        // Clear all injection-related flags
        this.injectionInProgress = false;
        this.timerExpired = false;
        this.safetyCheckCount = 0;
        this.isInjecting = false;
        this.currentlyInjectingMessageId = null;
        this.timerActive = false;
        // Clear all intervals and timeouts
        if (this.safetyCheckInterval) {
            clearInterval(this.safetyCheckInterval);
            this.safetyCheckInterval = null;
        }
        if (this.currentTypeInterval) {
            clearInterval(this.currentTypeInterval);
            this.currentTypeInterval = null;
        }
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        // Update all UI elements
        this.updateTimerUI();
        this.updateTerminalStatusIndicator();
        this.updateMessageList();
        this.logAction('Injection state reset complete', 'success');
    }
    // Pause execution during injection (preserves current typing position)
    pauseInjectionExecution() {
        // Check if any injections are active
        const hasActiveInjections = this.injectionInProgress || 
                                   this.currentlyInjectingMessages.size > 0 ||
                                   (this.timerExpired && this.messageQueue.length > 0);
        if (!hasActiveInjections) {
            this.logAction('Cannot pause - no injection in progress', 'warning');
            return false;
        }
        this.injectionPaused = true;
        // Stop the injection manager's periodic checks
        this.injectionManager.stopPeriodicChecks();
        // Clear any scheduled injection timers
        if (this.injectionTimer) {
            clearTimeout(this.injectionTimer);
            this.injectionTimer = null;
        }
        this.logAction('Injection execution paused', 'info');
        this.updateTimerUI();
        return true;
    }
    // Resume execution from where it was paused
    resumeInjectionExecution() {
        const hasActiveInjections = this.injectionInProgress || 
                                   this.currentlyInjectingMessages.size > 0 ||
                                   (this.timerExpired && this.messageQueue.length > 0);
        if (!hasActiveInjections) {
            this.logAction('Cannot resume - no injection in progress', 'warning');
            return false;
        }
        if (!this.injectionPaused) {
            this.logAction('Injection is not paused', 'warning');
            return false;
        }
        this.injectionPaused = false;
        this.injectionPausedByTimer = false; // Clear timer-triggered flag on any resume
        // Restart the injection manager's periodic checks if timer expired
        if (this.timerExpired) {
            this.injectionManager.startPeriodicChecks();
        }
        this.logAction('Injection execution resumed', 'info');
        this.updateTimerUI();
        // If we were in the middle of typing a message, continue from where we left off
        if (this.pausedMessageContent && this.pausedMessageIndex >= 0) {
            this.continueTypingFromPause();
        } else if (this.timerExpired) {
            // If no paused message, trigger injection scheduling
            this.injectionManager.checkAndScheduleInjections();
        }
        return true;
    }
    // Continue typing a message from where it was paused
    continueTypingFromPause() {
        const message = this.pausedMessageContent;
        let index = this.pausedMessageIndex;
        // Clear pause state
        this.pausedMessageContent = null;
        this.pausedMessageIndex = 0;
        const typeInterval = setInterval(() => {
            // Check if injection was cancelled or paused again
            if (!this.injectionInProgress) {
                clearInterval(typeInterval);
                return;
            }
            if (this.injectionPaused) {
                clearInterval(typeInterval);
                // Store pause state again
                this.pausedMessageContent = message;
                this.pausedMessageIndex = index;
                this.currentTypeInterval = null;
                return;
            }
            if (index < message.length) {
                ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: message[index] });
                index++;
            } else {
                clearInterval(typeInterval);
                // Message completed, continue with normal flow
                const enterDelay = this.getRandomDelay(300, 800);
                setTimeout(() => {
                    ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: '\r' });
                    this.isInjecting = false;
                    this.currentlyInjectingMessageId = null;
                    // Continue with next message if timer expired
                    if (this.timerExpired) {
                        const nextMessageDelay = this.getRandomDelay(800, 1200);
                        setTimeout(() => {
                            this.scheduleNextInjection();
                        }, nextMessageDelay);
                    }
                }, enterDelay);
            }
        }, 50);
        this.currentTypeInterval = typeInterval;
    }
    // Old scheduling system removed - now using timer-based injection
    // Safety check functions for the new system
    performSafetyChecks(callback) {
        this.safetyCheckCount = 0;
        // Start the safety check cycle
        this.runSafetyCheck(callback);
    }
    runSafetyCheck(callback) {
        this.safetyCheckCount++;
        // Safety check 1: Not already injecting
        if (this.isInjecting) {
            this.logAction(`Safety check failed - already injecting (attempt ${this.safetyCheckCount})`, 'warning');
            this.retrySafetyCheck(callback);
            return;
        }
        // Safety check 2: Simple scan for blocking conditions
        const terminalStatus = this.scanTerminalStatus();
        if (terminalStatus.isRunning) {
            this.logAction(`Safety check failed - running process detected (attempt ${this.safetyCheckCount})`, 'warning');
            this.retrySafetyCheck(callback);
            return;
        }
        if (terminalStatus.isPrompting) {
            this.logAction(`Safety check failed - Claude prompt detected (attempt ${this.safetyCheckCount})`, 'warning');
            this.retrySafetyCheck(callback);
            return;
        }
        // All safety checks passed
        this.logAction(`Safety checks passed (attempt ${this.safetyCheckCount}) - proceeding with injection`, 'success');
        callback();
    }
    startTerminalStatusScanning() {
        // Start continuous scanning every 10ms
        this.terminalScanInterval = setInterval(() => {
            this.scanAndUpdateTerminalStatus();
        }, 10);
    }
    stopTerminalStatusScanning() {
        if (this.terminalScanInterval) {
            clearInterval(this.terminalScanInterval);
            this.terminalScanInterval = null;
        }
    }
    scanAndUpdateTerminalStatus() {
        // Scan all terminals, not just the active one
        this.terminals.forEach((terminalData, terminalId) => {
            this.scanSingleTerminalStatus(terminalId, terminalData);
        });
        // Update the global status for backward compatibility (active terminal only)
        if (this.activeTerminalId && this.terminalStatuses.has(this.activeTerminalId)) {
            const activeStatus = this.terminalStatuses.get(this.activeTerminalId);
            this.currentTerminalStatus.isRunning = activeStatus.isRunning;
            this.currentTerminalStatus.isPrompting = activeStatus.isPrompting;
            this.currentTerminalStatus.lastUpdate = activeStatus.lastUpdate;
        }
    }
    scanSingleTerminalStatus(terminalId, terminalData) {
        // Get recent terminal output from multiple sources for better accuracy
        let recentOutput = '';
        // Try to get output from terminal buffer if available
        if (terminalData.terminal && terminalData.terminal.buffer && terminalData.terminal.buffer.active) {
            try {
                // Get last 20 lines from terminal buffer
                const buffer = terminalData.terminal.buffer.active;
                const endLine = buffer.baseY + buffer.cursorY;
                const startLine = Math.max(0, endLine - 20);
                let bufferOutput = '';
                for (let i = startLine; i <= endLine; i++) {
                    const line = buffer.getLine(i);
                    if (line) {
                        bufferOutput += line.translateToString(true) + '\n';
                    }
                }
                recentOutput = bufferOutput;
            } catch (error) {
                // Fallback to terminalData.lastOutput if buffer reading fails
                recentOutput = terminalData.lastOutput.slice(-2000);
            }
        } else {
            // Fallback to terminal's lastOutput
            recentOutput = terminalData.lastOutput.slice(-2000);
        }
        // Better detection patterns for running state
        const isRunning = recentOutput.includes('esc to interrupt') || 
                         recentOutput.includes('(esc to interrupt)') ||
                         recentOutput.includes('ESC to interrupt') ||
                         recentOutput.includes('offline)');
        // Enhanced prompt detection to catch various prompt patterns
        const isPrompting = recentOutput.includes('No, and tell Claude what to do differently') ||
                           /\b[yY]\/[nN]\b/.test(recentOutput) ||
                           /\b[nN]\/[yY]\b/.test(recentOutput) ||
                           /Do you want to proceed\?/i.test(recentOutput) ||
                           /Continue\?/i.test(recentOutput) ||
                           /\?\s*$/.test(recentOutput.trim()) ||
                           recentOutput.includes('Do you trust the files in this folder?') ||
                           recentOutput.includes('No, keep planning');
        // Get current status for this terminal
        const currentStatus = this.terminalStatuses.get(terminalId) || {
            isRunning: false,
            isPrompting: false,
            lastUpdate: Date.now()
        };
        // Update status for this terminal
        const statusChanged = (currentStatus.isRunning !== isRunning || 
                             currentStatus.isPrompting !== isPrompting);
        if (statusChanged) {
            const newStatus = isRunning ? 'running' : (isPrompting ? 'prompting' : 'ready');
            const oldStatus = currentStatus.isRunning ? 'running' : 
                             (currentStatus.isPrompting ? 'prompting' : 'ready');
            // Debug logging for status changes
            this.logAction(`Terminal ${terminalId} status changed: ${oldStatus} → ${newStatus}`, 'info');
            // Handle terminal state changes for todo generation with 3-minute delay
            this.handleTerminalStateChangeForTodos(terminalId, oldStatus, newStatus);
        }
        // Update the terminal's status
        this.terminalStatuses.set(terminalId, {
            isRunning: isRunning,
            isPrompting: isPrompting,
            lastUpdate: Date.now()
        });
        // Update terminal status display
        this.updateTerminalStatusIndicator();
    }
    updateTerminalStatusIndicator() {
        // Update status for all terminals
        this.terminals.forEach((terminalData, terminalId) => {
            // When waiting for usage limit reset, always show default "..." status
            if (this.usageLimitWaiting) {
                this.setTerminalStatusDisplay('', terminalId);
                return;
            }
            // Check if this terminal is currently injecting
            const isInjectingToThisTerminal = Array.from(this.currentlyInjectingMessages).some(messageId => {
                const message = this.messageQueue.find(m => m.id === messageId);
                return message && (message.terminalId != null ? message.terminalId : this.activeTerminalId) === terminalId;
            });
            if (isInjectingToThisTerminal) {
                this.setTerminalStatusDisplay('injecting', terminalId);
            } else {
                // Use per-terminal status instead of just active terminal
                const terminalStatus = this.terminalStatuses.get(terminalId);
                if (terminalStatus && terminalStatus.isRunning) {
                    this.setTerminalStatusDisplay('running', terminalId);
                } else if (terminalStatus && terminalStatus.isPrompting) {
                    this.setTerminalStatusDisplay('', terminalId);
                } else {
                    this.setTerminalStatusDisplay('', terminalId);
                }
            }
        });
    }
    scanTerminalStatus() {
        // Return current cached status (updated every 10ms)
        return {
            isRunning: this.currentTerminalStatus.isRunning,
            isPrompting: this.currentTerminalStatus.isPrompting
        };
    }
    retrySafetyCheck(callback) {
        // Add timeout for safety checks to prevent infinite retries
        if (this.safetyCheckCount > 50) {
            this.logAction(`Safety check TIMEOUT after ${this.safetyCheckCount} attempts - forcing injection`, 'warning');
            callback();
            return;
        }
        // Use more conservative delays to ensure safety
        let retryDelay;
        if (this.safetyCheckCount <= 5) {
            retryDelay = 3000; // First 5 attempts: 3 second delay
        } else if (this.safetyCheckCount <= 15) {
            retryDelay = 5000; // Next 10 attempts: 5 second delay
        } else if (this.safetyCheckCount <= 30) {
            retryDelay = 10000; // Next 15 attempts: 10 second delay
        } else {
            retryDelay = 15000; // After 30 attempts: 15 second delay
        }
        // Log more frequently since delays are longer
        if (this.safetyCheckCount % 3 === 0) {
            this.logAction(`Still waiting for safe injection conditions (attempt ${this.safetyCheckCount}) - retrying in ${retryDelay/1000}s`, 'info');
        }
        // Continue retrying until conditions are safe
        setTimeout(() => {
            this.runSafetyCheck(callback);
        }, retryDelay);
    }
    injectMessages() {
        if (this.messageQueue.length === 0) {
            this.logAction('No messages in queue to inject', 'warning');
            return;
        }
        // Force inject the top message (bypass timer but keep safety checks)
        const topMessage = this.messageQueue[0];
        this.logAction(`Force injecting top message: "${topMessage.content}"`, 'info');
        // Start safety checks for immediate injection (no delay for manual injection)
        this.performSafetyChecks(() => {
            // All safety checks passed - inject the message immediately
            this.injectMessageAndContinueQueue();
        });
    }
    manualInjectNextMessage() {
        console.log('=== manualInjectNextMessage called ===');
        if (this.messageQueue.length === 0) {
            this.logAction('No messages in queue to inject', 'warning');
            return;
        }
        // Get the first message in the queue
        const message = this.messageQueue[0];
        this.logAction(`Manual injection started (bypassing safety checks): "${message.content.substring(0, 50)}..."`, 'info');
        // Force reset any existing injection state for manual injection
        if (this.isInjecting || this.injectionInProgress) {
            this.logAction('Force-resetting injection state for manual injection', 'warning');
            this.isInjecting = false;
            this.injectionInProgress = false;
            this.currentlyInjectingMessageId = null;
            // Clear any pending type intervals
            if (this.currentTypeInterval) {
                clearInterval(this.currentTypeInterval);
                this.currentTypeInterval = null;
            }
        }
        // Set injection state
        this.isInjecting = true;
        this.injectionInProgress = true;
        this.currentlyInjectingMessageId = message.id;
        this.updateMessageList(); // Update UI to show injecting state
        // Create a robust typing function that handles all cases
        const performManualInjection = () => {
            // Create a completion handler to avoid code duplication
            const completeInjection = (method = 'standard') => {
                // Remove the injected message from queue
                this.messageQueue.shift();
                this.saveMessageQueue();
                // Mark message as injected in backend
                this.markMessageAsInjectedInBackend(message);
                // Update counters and UI
                this.injectionCount++;
                this.saveToMessageHistory(message, this.activeTerminalId, this.injectionCount);
                // Reset injection state
                this.isInjecting = false;
                this.injectionInProgress = false;
                this.currentlyInjectingMessageId = null;
                this.updateMessageList();
                this.updateStatusDisplay();
                // Notify injection manager with plan mode flag
                const wasPlanMode = method === 'plan-mode';
                this.injectionManager.onInjectionComplete(message.id, wasPlanMode);
                this.logAction(`Manual injection complete via ${method}: "${message.content.substring(0, 50)}..."`, 'success');
            };
            // Set a timeout to ensure injection doesn't hang
            const injectionTimeout = setTimeout(() => {
                this.logAction('Manual injection timed out, forcing completion', 'warning');
                completeInjection('timeout');
            }, 30000); // 30 second timeout
            try {
                // Handle plan mode wrapping for manual injection
                console.log('Manual injection - message:', message);
                // Handle backward compatibility - if wrapWithPlan is undefined, use global plan mode
                const shouldWrapWithPlan = message.wrapWithPlan !== undefined ? message.wrapWithPlan : this.planModeEnabled;
                if (shouldWrapWithPlan) {
                    this.injectMessageWithPlanMode(message, () => {
                        clearTimeout(injectionTimeout);
                        completeInjection('plan-mode');
                    });
                } else {
                    // Use the existing typeMessage method which handles control sequences properly
                    this.typeMessage(message.content, () => {
                        clearTimeout(injectionTimeout);
                        // Send Enter after typing (unless it's a control sequence that doesn't need it)
                        const hasControlSequence = /(\^[A-Z]|\\x1b|\\r|\\t)/g.test(message.content);
                        if (!hasControlSequence) {
                            setTimeout(() => {
                                ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: '\r' });
                            }, 100);
                        }
                        completeInjection('typeMessage');
                    });
                }
            } catch (error) {
                clearTimeout(injectionTimeout);
                // Fallback: direct input if typeMessage fails
                this.logAction(`TypeMessage failed, using direct input: ${error.message}`, 'warning');
                try {
                    ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: message.content });
                    // Send Enter if not a control sequence
                    const hasControlSequence = /(\^[A-Z]|\\x1b|\\r|\\t)/g.test(message.content);
                    if (!hasControlSequence) {
                        setTimeout(() => {
                            ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: '\r' });
                        }, 100);
                    }
                    completeInjection('directInput');
                } catch (fallbackError) {
                    this.logAction(`Manual injection failed completely: ${fallbackError.message}`, 'error');
                    // Reset state even on failure
                    this.isInjecting = false;
                    this.injectionInProgress = false;
                    this.currentlyInjectingMessageId = null;
                    this.updateMessageList();
                }
            }
        };
        // Execute immediately without safety checks for manual injection
        performManualInjection();
    }
    processMessageBatch(messages) {
        console.log('=== processMessageBatch called ===', messages);
        if (messages.length === 0 || this.isInjecting) return;
        this.isInjecting = true;
        // Set injecting status for the terminal that will receive the first message
        const firstMessageTerminalId = messages[0].terminalId != null ? messages[0].terminalId : this.activeTerminalId;
        this.setTerminalStatusDisplay('injecting', firstMessageTerminalId);
        let index = 0;
        const processNext = () => {
            if (index < messages.length) {
                const message = messages[index];
                this.logAction(`Processing batch message: "${message.content}"`, 'info');
                // Handle plan mode wrapping for batch injection
                console.log('Batch injection - message:', message);
                // Handle backward compatibility - if wrapWithPlan is undefined, use global plan mode
                const shouldWrapWithPlan = message.wrapWithPlan !== undefined ? message.wrapWithPlan : this.planModeEnabled;
                if (shouldWrapWithPlan) {
                    this.injectMessageWithPlanMode(message, () => {
                        this.injectionCount++;
                        this.saveToMessageHistory(message, this.activeTerminalId, this.injectionCount);
                        this.updateStatusDisplay();
                        setTimeout(() => {
                            index++;
                            if (index < messages.length) {
                                setTimeout(processNext, 1000);
                            } else {
                                this.isInjecting = false;
                                this.setTerminalStatusDisplay('', firstMessageTerminalId);
                                this.logAction('Batch injection completed successfully', 'success');
                                this.scheduleNextInjection(); // Schedule any remaining messages
                            }
                        }, 200);
                    });
                } else {
                    this.typeMessage(message.processedContent, () => {
                        this.injectionCount++;
                        this.saveToMessageHistory(message, this.activeTerminalId, this.injectionCount); // Save to history after successful injection
                        this.updateStatusDisplay();
                        setTimeout(() => {
                            ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: '\r' });
                            index++;
                            if (index < messages.length) {
                                setTimeout(processNext, 1000);
                            } else {
                                this.isInjecting = false;
                                this.setTerminalStatusDisplay('', firstMessageTerminalId);
                                this.logAction('Batch injection completed successfully', 'success');
                                this.scheduleNextInjection(); // Schedule any remaining messages
                            }
                        }, 200);
                    });
                }
            }
        };
        processNext();
    }
    scheduleNextInjection() {
        // Only schedule injections if timer has expired
        if (!this.timerExpired) {
            return;
        }
        // Prevent concurrent scheduling calls
        if (this.schedulingInProgress) {
            return;
        }
        this.schedulingInProgress = true;
        // Clear any existing timer
        if (this.injectionTimer) {
            clearTimeout(this.injectionTimer);
            this.injectionTimer = null;
        }
        // Don't schedule if no messages
        if (this.messageQueue.length === 0) {
            this.schedulingInProgress = false;
            return;
        }
        // Let injection manager handle injection state
        // Remove: this.injectionInProgress = false;
        // Track which terminals are currently busy - use the dedicated Set
        const busyTerminals = new Set(this.currentlyInjectingTerminals);
        // Group available messages by terminal and find earliest for each terminal
        const messagesByTerminal = new Map();
        const now = Date.now();
        this.messageQueue.forEach(message => {
            const terminalId = message.terminalId != null ? message.terminalId : this.activeTerminalId;
            const terminalData = this.terminals.get(terminalId);
            // Skip if terminal doesn't exist or is busy
            if (!terminalData || busyTerminals.has(terminalId)) {
                return;
            }
            // Skip if terminal is not stable and ready for injection (5-second check)
            if (!this.isTerminalStableAndReady(terminalId)) {
                return;
            }
            // Only consider messages that are ready to execute
            if (message.executeAt <= now) {
                const existingMessage = messagesByTerminal.get(terminalId);
                if (!existingMessage || 
                    message.executeAt < existingMessage.executeAt ||
                    (message.executeAt === existingMessage.executeAt && 
                     (message.sequence || 0) < (existingMessage.sequence || 0))) {
                    messagesByTerminal.set(terminalId, message);
                }
            }
        });
        // Process all available messages simultaneously
        if (messagesByTerminal.size > 0) {
            messagesByTerminal.forEach(message => {
                this.processMessage(message);
            });
        }
        // Schedule next check for remaining messages
        const remainingMessages = this.messageQueue.filter(message => {
            const terminalId = message.terminalId != null ? message.terminalId : this.activeTerminalId;
            return !messagesByTerminal.has(terminalId);
        });
        if (remainingMessages.length > 0) {
            // Find the next earliest message (considering sequence for identical timestamps)
            const nextMessage = remainingMessages.reduce((earliest, current) => {
                if (current.executeAt < earliest.executeAt) return current;
                if (current.executeAt > earliest.executeAt) return earliest;
                // Same executeAt - use sequence counter
                return (current.sequence || 0) < (earliest.sequence || 0) ? current : earliest;
            });
            const delay = Math.max(100, nextMessage.executeAt - now); // Minimum 100ms delay
            this.injectionTimer = setTimeout(() => {
                this.schedulingInProgress = false; // Clear flag before recursive call
                this.scheduleNextInjection();
            }, delay);
        }
        // Clear the scheduling flag
        this.schedulingInProgress = false;
    }
    processMessage(message) {
        if (!message) return;
        const terminalId = message.terminalId != null ? message.terminalId : this.activeTerminalId;
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) {
            this.logAction(`Terminal ${terminalId} not found for message: "${message.content}"`, 'error');
            this.deleteMessage(message.id);
            this.scheduleNextInjection();
            return;
        }
        // Check if this terminal is already processing a message
        if (this.currentlyInjectingMessages.has(message.id)) {
            return;
        }
        // Add to currently injecting set
        this.currentlyInjectingMessages.add(message.id);
        this.currentlyInjectingTerminals.add(terminalId); // Track busy terminal
        this.setTerminalStatusDisplay('injecting', terminalId);
        // Set injection in progress for UI updates
        if (this.timerExpired) {
            this.injectionInProgress = true;
        }
        // Clear stability timer since terminal is now busy injecting
        this.terminalStabilityTimers.delete(terminalId);
        this.logAction(`Injecting to ${terminalData.name}: "${message.content}"`, 'info');
        // Switch to target terminal if it's the first injection or no active injections
        if (this.currentlyInjectingMessages.size === 1) {
            if (terminalId !== this.activeTerminalId) {
                this.switchToTerminal(terminalId);
            }
        }
        // Handle plan mode wrapping for timer injection
        // Handle backward compatibility - if wrapWithPlan is undefined, use global plan mode
        const shouldWrapWithPlan = message.wrapWithPlan !== undefined ? message.wrapWithPlan : this.planModeEnabled;
        if (shouldWrapWithPlan) {
            // Use plan mode injection with terminal-specific handling
            this.injectMessageWithPlanModeToTerminal(message, terminalId, () => {
                this.injectionCount++;
                this.saveToMessageHistory(message, terminalId, this.injectionCount);
                this.updateStatusDisplay();
                setTimeout(() => {
                    this.currentlyInjectingMessages.delete(message.id);
                    this.currentlyInjectingTerminals.delete(terminalId); // Remove from busy terminals
                    this.deleteMessage(message.id); // Move message deletion to after injection cleanup
                    this.setTerminalStatusDisplay('', terminalId);
                    // Notify injection manager that injection is complete with plan mode flag
                    this.injectionManager.onInjectionComplete(message.id, true); // true = was plan mode
                    // Clear injection in progress if no more messages being processed
                    if (this.currentlyInjectingMessages.size === 0) {
                        this.injectionInProgress = false;
                    }
                    // Schedule next injection
                    this.scheduleNextInjection();
                }, 200);
            });
        } else {
            this.typeMessageToTerminal(message.processedContent, terminalId, () => {
                this.injectionCount++;
                this.saveToMessageHistory(message, terminalId, this.injectionCount);
                this.updateStatusDisplay();
                setTimeout(() => {
                    ipcRenderer.send('terminal-input', { terminalId, data: '\r' });
                    this.currentlyInjectingMessages.delete(message.id);
                    this.currentlyInjectingTerminals.delete(terminalId); // Remove from busy terminals
                    this.deleteMessage(message.id); // Move message deletion to after injection cleanup
                    this.setTerminalStatusDisplay('', terminalId);
                    // Notify injection manager that injection is complete
                    this.injectionManager.onInjectionComplete(message.id, false); // false = not plan mode
                    // Clear injection in progress if no more messages being processed
                    if (this.currentlyInjectingMessages.size === 0) {
                        this.injectionInProgress = false;
                    }
                    // Schedule next injection
                    this.scheduleNextInjection();
                }, 200);
            });
        }
    }
    typeMessageToTerminal(message, terminalId, callback) {
        // Check if message contains escape sequences that should be sent directly
        const escapePatterns = [
            { pattern: /\^C/g, replacement: '\x03' },   // Ctrl+C (ETX - End of Text)
            { pattern: /\^Z/g, replacement: '\x1a' },   // Ctrl+Z (SUB - Substitute)  
            { pattern: /\^D/g, replacement: '\x04' },   // Ctrl+D (EOT - End of Transmission)
            { pattern: /\\x1b/g, replacement: '\x1b' }, // Escape
            { pattern: /\\r/g, replacement: '\r' },     // Return
            { pattern: /\\t/g, replacement: '\t' },     // Tab
        ];
        // Check if message contains any escape sequences
        let hasEscapeSequences = false;
        let processedMessage = message;
        for (const { pattern, replacement } of escapePatterns) {
            if (pattern.test(processedMessage)) {
                hasEscapeSequences = true;
                processedMessage = processedMessage.replace(pattern, replacement);
            }
        }
        // If message contains escape sequences, send directly without typing
        if (hasEscapeSequences) {
            this.logAction(`Sending control sequence to terminal ${terminalId}: ${message}`, 'success');
            // If message contains multiple control characters, send them with delays
            const controlChars = processedMessage.split('');
            let charIndex = 0;
            const sendNext = () => {
                if (charIndex < controlChars.length) {
                    ipcRenderer.send('terminal-input', { terminalId, data: controlChars[charIndex] });
                    charIndex++;
                    // Add 10ms delay between control characters
                    setTimeout(sendNext, 10);
                } else {
                    if (callback) callback();
                }
            };
            sendNext();
            return;
        }
        // Otherwise, type character by character as normal
        let index = 0;
        const typeInterval = setInterval(() => {
            // Check if injection was cancelled (but skip this check for keyword responses)
            const isKeywordResponse = this.keywordBlockingActive;
            if (!isKeywordResponse && (!this.currentlyInjectingMessages || this.currentlyInjectingMessages.size === 0)) {
                clearInterval(typeInterval);
                return;
            }
            if (index < message.length) {
                ipcRenderer.send('terminal-input', { terminalId, data: message[index] });
                index++;
            } else {
                clearInterval(typeInterval);
                if (callback) callback();
            }
        }, 50); // 50ms delay between characters
    }
    typeMessage(message, callback) {
        // Check if message contains escape sequences that should be sent directly
        const escapePatterns = [
            { pattern: /\^C/g, replacement: '\x03' },   // Ctrl+C (ETX - End of Text)
            { pattern: /\^Z/g, replacement: '\x1a' },   // Ctrl+Z (SUB - Substitute)  
            { pattern: /\^D/g, replacement: '\x04' },   // Ctrl+D (EOT - End of Transmission)
            { pattern: /\\x1b/g, replacement: '\x1b' }, // Escape
            { pattern: /\\r/g, replacement: '\r' },     // Return
            { pattern: /\\t/g, replacement: '\t' },     // Tab
        ];
        // Check if message contains any escape sequences
        let hasEscapeSequences = false;
        let processedMessage = message;
        for (const { pattern, replacement } of escapePatterns) {
            if (pattern.test(processedMessage)) {
                hasEscapeSequences = true;
                processedMessage = processedMessage.replace(pattern, replacement);
            }
        }
        // If message contains escape sequences, send directly without typing
        if (hasEscapeSequences) {
            this.logAction(`Sending control sequence: ${message}`, 'success');
            // If message contains multiple control characters, send them with delays
            const controlChars = processedMessage.split('');
            let charIndex = 0;
            const sendNext = () => {
                if (charIndex < controlChars.length) {
                    // Get terminal ID from the current message being injected
                    const currentMessage = this.messageQueue.find(m => m.id === this.currentlyInjectingMessageId);
                    const terminalId = currentMessage ? currentMessage.terminalId || 1 : this.activeTerminalId;
                    ipcRenderer.send('terminal-input', { terminalId, data: controlChars[charIndex] });
                    charIndex++;
                    // Add 10ms delay between control characters
                    setTimeout(sendNext, 10);
                } else {
                    if (callback) callback();
                }
            };
            sendNext();
            return;
        }
        // Otherwise, type character by character as normal
        let index = 0;
        const typeInterval = setInterval(() => {
            // Check if injection was cancelled
            if (!this.injectionInProgress) {
                clearInterval(typeInterval);
                return;
            }
            // Check if injection was paused
            if (this.injectionPaused) {
                clearInterval(typeInterval);
                // Store pause state
                this.pausedMessageContent = message;
                this.pausedMessageIndex = index;
                this.currentTypeInterval = null;
                return;
            }
            if (index < message.length) {
                // Use the active terminal for legacy typeMessage calls
                ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: message[index] });
                index++;
            } else {
                clearInterval(typeInterval);
                if (callback) callback();
            }
        }, 50); // 50ms between characters for realistic typing speed
        // Store reference for potential cancellation
        this.currentTypeInterval = typeInterval;
    }
    detectCwdChange(data, terminalId = this.activeTerminalId) {
        // Get the terminal data for the specific terminal
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return;
        
        // Strip ANSI escape codes from the data before processing
        // More comprehensive ANSI escape code removal
        const cleanData = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\[[0-9;]*m/g, '');
        
        // Regex pattern to detect 'cwd: /path/to/directory'
        // More flexible pattern that handles various whitespace and formatting
        const cwdRegex = /cwd:\s*([^\s\r\n\x1b]+)/i;
        const match = cleanData.match(cwdRegex);
        
        if (match && match[1]) {
            const newDirectory = match[1];
            terminalData.directory = newDirectory;
            
            // Update active terminal references if this is the active terminal
            if (terminalId === this.activeTerminalId) {
                this.currentDirectory = newDirectory;
                this.updateStatusDisplay();
                this.savePreferences();
                this.logAction(`Directory changed to: ${newDirectory}`, 'info');
            }
        }
    }
    detectAutoContinuePrompt(data, terminalId = this.activeTerminalId) {
        // Get the terminal data for the specific terminal
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return;
        // Use the terminal-specific output for detection
        const terminalOutput = terminalData.lastOutput || '';
        // Check for blocking conditions for message injection
        const hasEscToInterrupt = terminalOutput.includes("esc to interrupt") || 
                                 terminalOutput.includes("offline)");
        const hasClaudePrompt = terminalOutput.includes("No, and tell Claude what to do differently") ||
                                terminalOutput.includes("No, keep planning");
        // Handle keyword blocking specifically for Claude prompts (only if auto-continue is enabled)
        if (hasClaudePrompt && this.autoContinueEnabled) {
            const keywordBlockResult = this.checkTerminalForKeywords(terminalOutput);
            if (keywordBlockResult.blocked && !this.keywordBlockingActive) {
                this.keywordBlockingActive = true;
                this.keywordCount++;
                this.updateStatusDisplay();
                this.logAction(`Keyword "${keywordBlockResult.keyword}" detected in Terminal ${terminalId} Claude prompt - executing escape sequence`, 'warning');
                // Track this terminal for keyword response
                this.keywordResponseTerminals.set(terminalId, {
                    keyword: keywordBlockResult.keyword,
                    response: keywordBlockResult.response,
                    timestamp: Date.now()
                });
                // Send Esc key to interrupt on the specific terminal
                ipcRenderer.send('terminal-input', { terminalId, data: '\x1b' });
                // Wait and inject custom response if provided
                if (keywordBlockResult.response) {
                    const responseDelay = this.getRandomDelay(700, 1000);
                    this.logAction(`Will inject custom response to Terminal ${terminalId} in ${responseDelay}ms: "${keywordBlockResult.response}"`, 'info');
                    setTimeout(() => {
                        this.logAction(`Starting injection of custom response to Terminal ${terminalId}: "${keywordBlockResult.response}"`, 'info');
                        this.typeMessageToTerminal(keywordBlockResult.response, terminalId, () => {
                            this.logAction(`Custom response injection completed for Terminal ${terminalId}`, 'info');
                            const enterDelay = this.getRandomDelay(150, 350);
                            setTimeout(() => {
                                ipcRenderer.send('terminal-input', { terminalId, data: '\r' });
                                this.logAction(`Sent Enter key for Terminal ${terminalId}`, 'info');
                                // Reset keyword blocking flag and clear terminal tracking
                                const resetDelay = this.getRandomDelay(800, 1200);
                                setTimeout(() => {
                                    this.keywordBlockingActive = false;
                                    this.keywordResponseTerminals.delete(terminalId);
                                    this.logAction(`Keyword blocking reset for Terminal ${terminalId}`, 'info');
                                }, resetDelay);
                            }, enterDelay);
                        });
                    }, responseDelay);
                } else {
                    // Just Esc without response
                    const resetDelay = this.getRandomDelay(800, 1200);
                    setTimeout(() => {
                        this.keywordBlockingActive = false;
                        this.keywordResponseTerminals.delete(terminalId);
                    }, resetDelay);
                }
                return; // Exit early, don't process auto-continue
            }
        }
        // Reset keyword blocking flag if Claude prompt is no longer present for this terminal
        if (!hasClaudePrompt && this.keywordResponseTerminals.has(terminalId)) {
            this.keywordResponseTerminals.delete(terminalId);
        }
        // Check all terminals for keyword blocking (global check for injection blocking)
        const allTerminalsKeywordResult = this.checkForKeywordBlocking();
        // Check for plan detection in all terminals
        this.checkForPromptDetection();
        // Update injection blocking status based on all terminals
        const previouslyBlocked = this.injectionBlocked;
        this.injectionBlocked = hasEscToInterrupt || allTerminalsKeywordResult.blocked;
        // Log when blocking status changes
        if (previouslyBlocked && !this.injectionBlocked) {
            this.logAction('Message injection unblocked - conditions cleared', 'success');
            // Resume injection scheduling if we have queued messages
            if (this.messageQueue.length > 0) {
                this.scheduleNextInjection();
            }
        } else if (!previouslyBlocked && this.injectionBlocked) {
            let reason = hasEscToInterrupt ? `running process detected in Terminal ${terminalId}` : `keyword "${allTerminalsKeywordResult.keyword}" detected`;
            this.logAction(`Message injection blocked - ${reason}`, 'warning');
            // Cancel any pending injection
            if (this.injectionTimer) {
                clearTimeout(this.injectionTimer);
                this.injectionTimer = null;
            }
        }
        // Auto-continue logic (skip if keyword blocking just activated)
        if (!this.autoContinueEnabled || this.isInjecting || this.keywordBlockingActive) return;
        // Check for prompts that should trigger auto-continue (using terminal-specific output)
        const hasGeneralPrompt = /Do you want to proceed\?/i.test(terminalOutput);
        const hasTrustPrompt = terminalOutput.includes('Do you trust the files in this folder?');
        // Handle trust prompt - inject enter with random delay on specific terminal
        if (hasTrustPrompt && !this.trustPromptActive) {
            this.trustPromptActive = true;
            const delay = this.getRandomDelay(1000, 2000); // 1-2 seconds
            this.logAction(`Trust prompt detected in Terminal ${terminalId} - auto-injecting enter in ${delay}ms`, 'info');
            setTimeout(() => {
                ipcRenderer.send('terminal-input', { terminalId, data: '\r' });
                this.trustPromptActive = false;
            }, delay);
            return; // Exit early to avoid other auto-continue processing
        }
        // Auto-continue for Claude prompt or general prompts on specific terminal
        if (hasClaudePrompt || hasGeneralPrompt) {
            const promptType = hasClaudePrompt ? 'Claude prompt' : 'general prompt';
            // Track this terminal as needing continue messages
            if (hasClaudePrompt) {
                this.continueTargetTerminals.add(terminalId);
            }
            // If auto-continue is not already active for this terminal, start it
            if (!this.autoContinueActive) {
                console.log(`Auto-continue: ${promptType} detected in Terminal ${terminalId}! Starting persistent auto-continue.`);
                this.logAction(`Auto-continue detected ${promptType} in Terminal ${terminalId} - starting persistent checking`, 'info');
                this.autoContinueActive = true;
                this.autoContinueRetryCount = 0;
                this.performAutoContinue(promptType, terminalId);
            }
        } else if (this.autoContinueActive && this.continueTargetTerminals.has(terminalId)) {
            // If we were auto-continuing but no longer see prompts in this terminal, remove it from targets
            this.continueTargetTerminals.delete(terminalId);
            this.logAction(`Auto-continue completed for Terminal ${terminalId} - prompt cleared after ${this.autoContinueRetryCount + 1} attempts`, 'success');
            // If no more terminals need auto-continue, stop completely
            if (this.continueTargetTerminals.size === 0) {
                this.autoContinueActive = false;
                this.autoContinueRetryCount = 0;
            }
        }
    }
    performAutoContinue(promptType, terminalId = this.activeTerminalId) {
        if (!this.autoContinueActive || !this.autoContinueEnabled) return;
        this.autoContinueRetryCount++;
        this.logAction(`Auto-continue attempt #${this.autoContinueRetryCount} for ${promptType} in Terminal ${terminalId}`, 'info');
        // Send Enter key with small random delay for human-like behavior to specific terminal
        const enterDelay = this.getRandomDelay(50, 150);
        setTimeout(() => {
            ipcRenderer.send('terminal-input', { terminalId, data: '\r' });
        }, enterDelay);
        // Wait for terminal to process, then check if we need to continue
        const checkDelay = 1000 + this.getRandomDelay(0, 300); // 1-1.3 seconds
        setTimeout(() => {
            if (this.autoContinueActive) {
                // Get terminal-specific output for checking
                const terminalData = this.terminals.get(terminalId);
                if (!terminalData) return;
                const terminalOutput = terminalData.lastOutput || '';
                // Check if prompt text is still present in this terminal's output
                const hasClaudePrompt = terminalOutput.includes("No, and tell Claude what to do differently");
                const hasGeneralPrompt = /Do you want to proceed\?/i.test(terminalOutput);
                if (hasClaudePrompt || hasGeneralPrompt) {
                    // Prompt still there, continue if we haven't exceeded max attempts
                    if (this.autoContinueRetryCount < 10) {
                        this.logAction(`Prompt still present in Terminal ${terminalId}, retrying auto-continue`, 'warning');
                        this.performAutoContinue(promptType, terminalId);
                    } else {
                        this.logAction(`Auto-continue stopped for Terminal ${terminalId} - max attempts (10) reached`, 'error');
                        this.continueTargetTerminals.delete(terminalId);
                        if (this.continueTargetTerminals.size === 0) {
                            this.autoContinueActive = false;
                            this.autoContinueRetryCount = 0;
                        }
                    }
                } else {
                    // Prompt is gone, success!
                    this.logAction(`Auto-continue successful for Terminal ${terminalId} after ${this.autoContinueRetryCount} attempts`, 'success');
                    this.continueTargetTerminals.delete(terminalId);
                    // If no more terminals need auto-continue, stop completely
                    if (this.continueTargetTerminals.size === 0) {
                        this.autoContinueActive = false;
                        this.autoContinueRetryCount = 0;
                    }
                }
            }
        }, checkDelay);
    }
    performAutoContinue(promptType, terminalId = this.activeTerminalId) {
        if (!this.autoContinueActive || !this.autoContinueEnabled) return;
        this.autoContinueRetryCount++;
        this.logAction(`Auto-continue attempt #${this.autoContinueRetryCount} for ${promptType} in Terminal ${terminalId}`, 'info');
        // Get terminal output for keyword checking
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return;
        const terminalOutput = terminalData.lastOutput || '';
        // Check for keywords before hitting enter
        const keywordBlockResult = this.checkTerminalForKeywords(terminalOutput);
        if (keywordBlockResult.blocked) {
            this.keywordCount++;
            this.updateStatusDisplay();
            this.logAction(`Keyword "${keywordBlockResult.keyword}" detected in Terminal ${terminalId} during auto-continue - blocking and sending escape`, 'warning');
            // Send Esc key to interrupt instead of Enter
            const escDelay = this.getRandomDelay(50, 150);
            setTimeout(() => {
                ipcRenderer.send('terminal-input', { terminalId, data: '\x1b' });
                // Wait and inject custom response if provided
                if (keywordBlockResult.response) {
                    const responseDelay = this.getRandomDelay(700, 1000);
                    setTimeout(() => {
                        this.typeMessageToTerminal(keywordBlockResult.response, terminalId, () => {
                            const enterDelay = this.getRandomDelay(150, 350);
                            setTimeout(() => {
                                ipcRenderer.send('terminal-input', { terminalId, data: '\r' });
                            }, enterDelay);
                        });
                    }, responseDelay);
                }
                // Stop auto-continue for this terminal
                this.continueTargetTerminals.delete(terminalId);
                if (this.continueTargetTerminals.size === 0) {
                    this.autoContinueActive = false;
                    this.autoContinueRetryCount = 0;
                }
            }, escDelay);
            return; // Exit early, don't send Enter
        }
        // No keywords found, send Enter key with small random delay for human-like behavior to specific terminal
        const enterDelay = this.getRandomDelay(50, 150);
        setTimeout(() => {
            ipcRenderer.send('terminal-input', { terminalId, data: '\r' });
        }, enterDelay);
        // Wait for terminal to process, then check if we need to continue
        const checkDelay = 1000 + this.getRandomDelay(0, 300); // 1-1.3 seconds
        setTimeout(() => {
            if (this.autoContinueActive) {
                // Check terminal status instead of just text patterns
                const terminalStatus = this.terminalStatuses.get(terminalId);
                const isStillPrompted = terminalStatus && terminalStatus.isPrompting;
                if (isStillPrompted) {
                    // Terminal still in prompted state, continue if we haven't exceeded max attempts
                    if (this.autoContinueRetryCount < 10) {
                        this.logAction(`Terminal ${terminalId} still in prompted state, retrying auto-continue`, 'warning');
                        this.performAutoContinue(promptType, terminalId);
                    } else {
                        this.logAction(`Auto-continue stopped for Terminal ${terminalId} - max attempts (10) reached`, 'error');
                        this.continueTargetTerminals.delete(terminalId);
                        if (this.continueTargetTerminals.size === 0) {
                            this.autoContinueActive = false;
                            this.autoContinueRetryCount = 0;
                        }
                    }
                } else {
                    // Terminal no longer prompted, success!
                    this.logAction(`Auto-continue successful for Terminal ${terminalId} after ${this.autoContinueRetryCount} attempts`, 'success');
                    this.continueTargetTerminals.delete(terminalId);
                    // If no more terminals need auto-continue, stop completely
                    if (this.continueTargetTerminals.size === 0) {
                        this.autoContinueActive = false;
                        this.autoContinueRetryCount = 0;
                    }
                }
            }
        }, checkDelay);
    }
    // Helper function to generate random delays for more human-like behavior
    getRandomDelay(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }
    async detectUsageLimit(data, terminalId = this.activeTerminalId) {
        // Check for "Approaching usage limit" message and parse the reset time
        // const approachingMatch = data.match(/Approaching usage limit · resets at (\d{1,2})(am|pm)/i);
        // if (approachingMatch) {
        //     const resetHour = parseInt(approachingMatch[1]);
        //     const ampm = approachingMatch[2].toLowerCase();
        //     const resetTimeString = `${resetHour}${ampm}`;
        //     // Check if we've already shown modal for this specific reset time
        //     const lastShownResetTime = localStorage.getItem('usageLimitModalLastResetTime');
        //     if (lastShownResetTime !== resetTimeString) {
        //         this.showUsageLimitModal(resetHour, ampm);
        //         localStorage.setItem('usageLimitModalLastResetTime', resetTimeString);
        //     }
        // }
        // Also check for "Claude usage limit reached" message and parse the reset time
        const reachedMatch = data.match(/Claude usage limit reached\. Your limit will reset at (\d{1,2})(am|pm)/i);
        if (reachedMatch) {
            const fullUsageLimitMessage = reachedMatch[0]; // Full matched message
            // Check if this is the same message as the last one processed
            const lastUsageLimitMessage = await ipcRenderer.invoke('db-get-setting', 'lastUsageLimitMessage');
            if (lastUsageLimitMessage === fullUsageLimitMessage) {
                return; // Same message, don't trigger again
            }
            // Check if we're in the cooldown period after a previous reset
            if (this.usageLimitCooldownUntil && Date.now() < this.usageLimitCooldownUntil) {
                const remainingCooldown = Math.round((this.usageLimitCooldownUntil - Date.now()) / 1000 / 60);
                this.logAction(`Usage limit detected but ignored due to cooldown (${remainingCooldown} minutes remaining)`, 'info');
                return;
            }
            const resetHour = parseInt(reachedMatch[1]);
            const ampm = reachedMatch[2].toLowerCase();
            const resetTimeString = `${resetHour}${ampm}`;
            // Track this terminal as having received a usage limit message
            this.usageLimitTerminals.add(terminalId);
            this.logAction(`Usage limit detected in Terminal ${terminalId} - tracking for continue targeting`, 'info');
            // Store reset time info for potential timer setting after user choice
            this.pendingUsageLimitReset = { resetHour, ampm };
            // Pause injection until user makes a choice
            this.pauseInProgressInjection();
            this.usageLimitWaiting = true;
            this.savePreferences(); // Save usage limit state
            this.injectionManager.onUsageLimitDetected();
            // Check if we've already shown modal for this specific reset time
            this.checkAndShowUsageLimitModal(resetTimeString, resetHour, ampm);
        }
    }
    detectDirectoryFromOutput(data, terminalId = this.activeTerminalId) {
        try {
            const terminalData = this.terminals.get(terminalId);
            if (!terminalData) return;
            // Get the terminal buffer content for comprehensive analysis
            const buffer = terminalData.terminal.buffer.active;
            if (!buffer) return;
            // Get recent terminal content (last 10 lines should be sufficient for cwd detection)
            const endLine = buffer.baseY + buffer.cursorY;
            const startLine = Math.max(0, endLine - 10);
            let recentContent = '';
            for (let i = startLine; i <= endLine; i++) {
                const line = buffer.getLine(i);
                if (line) {
                    recentContent += line.translateToString(true) + '\n';
                }
            }
            // Look for content between ╭ and ╯ markers
            const boxPattern = /╭[^╯]*╯/g;
            const boxes = recentContent.match(boxPattern);
            if (boxes) {
                for (const box of boxes) {
                    // Look for cwd pattern within the box
                    const cwdPattern = /cwd:\s*([^\s\n]+)/i;
                    const match = box.match(cwdPattern);
                    if (match && match[1]) {
                        const detectedDirectory = match[1].trim();
                        // Validate that it looks like a valid directory path
                        if (detectedDirectory.startsWith('/') || detectedDirectory.startsWith('~') || 
                            (detectedDirectory.length > 2 && detectedDirectory[1] === ':')) {
                            // Update terminal directory if it's different
                            if (terminalData.directory !== detectedDirectory) {
                                const oldDirectory = terminalData.directory;
                                terminalData.directory = detectedDirectory;
                                // Update current directory for the active terminal
                                if (terminalId === this.activeTerminalId) {
                                    this.currentDirectory = detectedDirectory;
                                    this.updateRecentDirectories(detectedDirectory);
                                    // Update status display to show new directory
                                    this.updateStatusDisplay();
                                }
                                // Save terminal state to persist the directory change
                                this.saveTerminalState();
                                // Update backend session directory if available
                                if (this.backendAPIClient) {
                                    const backendSessionId = this.terminalSessionMap.get(terminalId);
                                    if (backendSessionId) {
                                        this.backendAPIClient.updateTerminalSession(backendSessionId, { 
                                            current_directory: detectedDirectory 
                                        }).catch(error => {
                                            console.warn('Failed to update backend session directory:', error);
                                        });
                                    }
                                }
                                this.logAction(`Terminal ${terminalId} directory changed: ${oldDirectory || 'unknown'} → ${detectedDirectory}`, 'info');
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('Error in detectDirectoryFromOutput:', error);
        }
    }
    async setTimerToUsageLimitReset(resetHour, ampm, exactResetTime = null) {
        const resetTimeString = `${resetHour}${ampm}`;
        try {
            // Check if we've already set timer for this reset time
            const lastTimerResetTime = await ipcRenderer.invoke('db-get-app-state', 'usageLimitTimerLastResetTime');
            const lastTimerResetTimestamp = await ipcRenderer.invoke('db-get-app-state', 'usageLimitTimerLastResetTimestamp');
            const now = new Date();
            // If we have the same reset time AND it hasn't passed yet, skip
            if (lastTimerResetTime === resetTimeString && lastTimerResetTimestamp && now.getTime() < lastTimerResetTimestamp) {
                this.logAction(`Timer already set for reset time ${resetTimeString}, skipping duplicate update`, 'info');
                return;
            }
            // Calculate time until reset
            let resetTime;
            if (exactResetTime) {
                // Use exact reset time for debug mode
                resetTime = new Date(exactResetTime);
            } else {
                // Normal flow: calculate from hour and ampm
                resetTime = new Date();
                // Convert to 24-hour format
                let hour24 = resetHour;
                if (ampm === 'pm' && resetHour !== 12) {
                    hour24 += 12;
                } else if (ampm === 'am' && resetHour === 12) {
                    hour24 = 0;
                }
                resetTime.setHours(hour24, 0, 0, 0);
                // If reset time is in the past, it's tomorrow
                if (resetTime <= now) {
                    resetTime.setDate(resetTime.getDate() + 1);
                }
            }
            const timeDiff = resetTime.getTime() - now.getTime();
            const totalSeconds = Math.max(1, Math.floor(timeDiff / 1000));
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            // Don't update timer for usage limits over 5 hours (likely previous limit still active)
            if (hours >= 5) {
                this.logAction(`Usage limit timer would be ${hours}h ${minutes}m - ignoring as it likely refers to previous usage limit that has been lifted`, 'info');
                return;
            }
            // Stop auto injection and set timer
            this.pauseInProgressInjection();
            this.usageLimitWaiting = true;
            this.savePreferences(); // Save usage limit state
            this.injectionManager.onUsageLimitDetected();
            // Clear any existing timer before setting new one
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
                this.timerActive = false;
            }
            // Store original timer values for reset after expiry
            this.usageLimitTimerOriginalValues = {
                hours: hours,
                minutes: minutes,
                seconds: seconds
            };
            // Set timer values
            this.timerHours = hours;
            this.timerMinutes = minutes;
            this.timerSeconds = seconds;
            this.timerExpired = false;
            // Always start the timer (since we cleared any existing one)
            this.startTimer();
            // Save this reset time and timestamp to prevent duplicate timer updates
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitTimerLastResetTime', resetTimeString);
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitTimerLastResetTimestamp', resetTime.getTime());
            this.logAction(`Usage limit detected - timer set to reset at ${resetHour}${ampm} (${hours}h ${minutes}m ${seconds}s)`, 'warning');
        } catch (error) {
            console.error('Error checking/setting usage limit timer state:', error);
            // Fallback to original behavior if database operations fail
            this.logAction(`Error tracking timer state, proceeding with timer update for ${resetHour}${ampm}`, 'error');
        }
    }
    async clearUsageLimitTracking() {
        try {
            // Clear all usage limit tracking from database
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitModalLastResetTime', null);
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitModalLastResetTimestamp', null);
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitTimerLastResetTime', null);
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitTimerLastResetTimestamp', null);
            // Clear session-based tracking to allow new modals after reset
            this.processedUsageLimitMessages.clear();
            // Clear cooldown period when manually clearing tracking
            this.usageLimitCooldownUntil = null;
            // Clear stored timer values
            this.usageLimitTimerOriginalValues = null;
            this.logAction('Cleared usage limit tracking data, session memory, and cooldown period', 'info');
        } catch (error) {
            console.error('Error clearing usage limit tracking:', error);
        }
    }
    async checkAndShowUsageLimitModal(resetTimeString, resetHour, ampm) {
        try {
            // Create a unique identifier for this specific usage limit message
            // Include both the reset time and current session to avoid cross-session duplicates
            const messageId = `${resetTimeString}_${Date.now().toString().slice(-6)}`;
            // Check if we've already processed this specific reset time in this session
            if (this.processedUsageLimitMessages.has(resetTimeString)) {
                this.logAction(`Usage limit message for ${resetTimeString} already processed in this session - ignoring`, 'info');
                return;
            }
            const lastShownResetTime = await ipcRenderer.invoke('db-get-app-state', 'usageLimitModalLastResetTime');
            const lastShownTimestamp = await ipcRenderer.invoke('db-get-app-state', 'usageLimitModalLastResetTimestamp');
            // Calculate the actual reset timestamp for this message
            const now = new Date();
            const resetTime = new Date();
            // Convert to 24-hour format
            let hour24 = resetHour;
            if (ampm === 'pm' && resetHour !== 12) {
                hour24 += 12;
            } else if (ampm === 'am' && resetHour === 12) {
                hour24 = 0;
            }
            resetTime.setHours(hour24, 0, 0, 0);
            // If reset time is in the past, it's tomorrow
            if (resetTime <= now) {
                resetTime.setDate(resetTime.getDate() + 1);
            }
            const resetTimestamp = resetTime.getTime();
            // Only show modal if this is a genuinely new reset time (different from last shown)
            // Remove the flawed logic about "previous time has passed"
            const isNewMessage = lastShownResetTime !== resetTimeString;
            if (isNewMessage) {
                this.logAction(`New usage limit detected for ${resetTimeString} - showing modal`, 'info');
                // Mark this reset time as processed in current session
                this.processedUsageLimitMessages.add(resetTimeString);
                this.showUsageLimitModal(resetHour, ampm);
                await ipcRenderer.invoke('db-set-app-state', 'usageLimitModalLastResetTime', resetTimeString);
                await ipcRenderer.invoke('db-set-app-state', 'usageLimitModalLastResetTimestamp', resetTimestamp);
                // Save the full message to prevent duplicate triggers
                await ipcRenderer.invoke('db-save-setting', 'lastUsageLimitMessage', fullUsageLimitMessage);
            } else {
                this.logAction(`Duplicate usage limit message for ${resetTimeString} ignored - modal already shown for this reset time`, 'info');
                // Still mark as processed to prevent future processing in this session
                this.processedUsageLimitMessages.add(resetTimeString);
            }
        } catch (error) {
            console.error('Error checking usage limit modal state:', error);
            // Fallback: show modal if we can't check the state, but only if not already processed
            if (!this.processedUsageLimitMessages.has(resetTimeString)) {
                this.processedUsageLimitMessages.add(resetTimeString);
                this.showUsageLimitModal(resetHour, ampm);
                // Save the full message to prevent duplicate triggers
                await ipcRenderer.invoke('db-save-setting', 'lastUsageLimitMessage', fullUsageLimitMessage);
            }
        }
    }
    async checkAndShowUsageLimitModalDebug(resetTimeString, exactResetTime) {
        // For debug mode, always show the modal with exact reset time (bypass duplicate check)
        this.logAction(`DEBUG: Showing usage limit modal for ${resetTimeString}`, 'info');
        this.showUsageLimitModal(null, null, exactResetTime);
    }
    async getUsageLimitStatus() {
        const usageLimitFirstDetected = await ipcRenderer.invoke('db-get-setting', 'usageLimitFirstDetected');
        if (!usageLimitFirstDetected) {
            return { 
                active: true,
                message: 'Usage limit detection is active (no detection recorded yet)'
            };
        }
        const firstDetectedTime = parseInt(usageLimitFirstDetected);
        const now = Date.now();
        const fiveHoursInMs = 5 * 60 * 60 * 1000;
        const timeSinceFirstDetection = now - firstDetectedTime;
        if (timeSinceFirstDetection >= fiveHoursInMs) {
            return {
                active: false,
                message: 'Usage limit detection is auto-disabled (5+ hours since first detection)'
            };
        }
        const remainingMs = fiveHoursInMs - timeSinceFirstDetection;
        const remainingHours = Math.floor(remainingMs / (60 * 60 * 1000));
        const remainingMinutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
        return {
            active: true,
            firstDetected: new Date(firstDetectedTime).toLocaleString(),
            remainingTime: `${remainingHours}h ${remainingMinutes}m`,
            message: `Usage limit detection active - auto-disables in ${remainingHours}h ${remainingMinutes}m`
        };
    }
    async resetUsageLimitTimer() {
        await ipcRenderer.invoke('db-save-setting', 'usageLimitFirstDetected', null);
        this.logAction('Usage limit auto-disable timer has been reset', 'info');
        return true;
    }
    showUsageLimitModal(resetHour, ampm, exactResetTime = null) {
        this.logAction(`DEBUG: showUsageLimitModal called with resetHour=${resetHour}, ampm=${ampm}, exactResetTime=${exactResetTime}`, 'info');
        // Set flag that modal is showing and pause injection
        this.usageLimitModalShowing = true;
        this.pauseInProgressInjection();
        const modal = document.getElementById('usage-limit-modal');
        const progressBar = modal.querySelector('.usage-limit-progress-bar');
        const resetTimeSpan = document.getElementById('reset-time');
        const countdownSpan = document.getElementById('usage-countdown');
        const yesBtn = document.getElementById('usage-limit-yes');
        const noBtn = document.getElementById('usage-limit-no');
        this.logAction(`DEBUG: Modal elements found: ${modal ? 'yes' : 'no'}, progressBar: ${progressBar ? 'yes' : 'no'}`, 'info');
        // Calculate time until the parsed reset time
        const now = new Date();
        let resetTime;
        let hour24 = null;
        if (exactResetTime) {
            // Use exact reset time for debug mode
            resetTime = new Date(exactResetTime);
            hour24 = resetTime.getHours();
        } else {
            // Normal flow: use hour with 0 minutes
            resetTime = new Date();
            // Convert 12-hour format to 24-hour format
            hour24 = resetHour;
            if (ampm === 'pm' && resetHour !== 12) {
                hour24 = resetHour + 12;
            } else if (ampm === 'am' && resetHour === 12) {
                hour24 = 0;
            }
            resetTime.setHours(hour24, 0, 0, 0);
            // If the reset time has already passed today, it must be tomorrow
            if (resetTime.getTime() <= now.getTime()) {
                resetTime.setDate(resetTime.getDate() + 1);
            }
        }
        const timeDiff = resetTime.getTime() - now.getTime();
        const hours = Math.floor(timeDiff / (1000 * 60 * 60));
        const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
        // Store the reset time info for auto-fill
        this.currentResetTime = { resetHour, ampm, hour24, resetTime };
        this.setUsageLimitResetTime(resetTime);
        // Update reset time text
        if (hours > 0) {
            resetTimeSpan.textContent = `${hours}h ${minutes}m`;
        } else {
            resetTimeSpan.textContent = `${minutes}m`;
        }
        // Show modal and start progress bar animation
        this.logAction(`DEBUG: About to show modal. Current classes: ${modal.className}`, 'info');
        modal.classList.add('show');
        this.logAction(`DEBUG: Modal show class added. New classes: ${modal.className}`, 'info');
        setTimeout(() => {
            progressBar.classList.add('active');
        }, 100);
        // Start countdown timer
        let countdown = 10;
        const countdownInterval = setInterval(() => {
            countdown--;
            countdownSpan.textContent = countdown;
            if (countdown <= 0) {
                clearInterval(countdownInterval);
                this.handleUsageLimitChoice(true);
            }
        }, 1000);
        // Handle button clicks
        const handleChoice = (choice) => {
            clearInterval(countdownInterval);
            this.handleUsageLimitChoice(choice);
        };
        if (yesBtn) {
            yesBtn.onclick = () => handleChoice(true);
        } else {
            this.logAction('ERROR: usage-limit-yes button not found', 'error');
        }
        if (noBtn) {
            noBtn.onclick = () => handleChoice(false);
        } else {
            this.logAction('ERROR: usage-limit-no button not found', 'error');
        }
        // Auto-close after 10 seconds
        setTimeout(() => {
            if (modal.classList.contains('show')) {
                handleChoice(true);
            }
        }, 10000);
    }
    async handleUsageLimitChoice(queue) {
        this.logAction(`DEBUG: handleUsageLimitChoice called with queue=${queue}`, 'info');
        const modal = document.getElementById('usage-limit-modal');
        const progressBar = modal.querySelector('.usage-limit-progress-bar');
        // Hide modal and clear flag
        modal.classList.remove('show');
        progressBar.classList.remove('active');
        this.usageLimitModalShowing = false;
        // Log the choice and handle based on user's decision
        if (queue) {
            this.logAction('Usage limit detected - Queue mode enabled until reset', 'info');
            // Only set timer if user chose "Yes" and we have pending reset info
            if (this.pendingUsageLimitReset) {
                if (this.pendingUsageLimitReset.debugResetTime) {
                    // Debug mode: use exact reset time
                    await this.setTimerToUsageLimitReset(this.pendingUsageLimitReset.resetHour, this.pendingUsageLimitReset.ampm, this.pendingUsageLimitReset.debugResetTime);
                } else {
                    // Normal mode: use hour and ampm
                    await this.setTimerToUsageLimitReset(this.pendingUsageLimitReset.resetHour, this.pendingUsageLimitReset.ampm);
                }
                this.pendingUsageLimitReset = null; // Clear pending info
            }
            // Auto-fill the Execute in form with calculated time until reset
            this.autoFillExecuteInForm();
        } else {
            this.logAction('Usage limit detected - Continuing normally', 'info');
            // User chose "No thanks" - clear pending reset info and resume normal operation
            this.pendingUsageLimitReset = null;
            this.usageLimitWaiting = false;
            this.usageLimitTimerOriginalValues = null; // Clear stored timer values
            this.savePreferences(); // Save usage limit state
            this.injectionManager.onUsageLimitReset(); // Reset injection manager state
            // Resume injection if there are messages queued
            if (this.messageQueue.length > 0) {
                this.scheduleNextInjection();
            }
        }
        // Resume injection if there are messages queued and timer was expired
        if (this.timerExpired && this.messageQueue.length > 0) {
            this.logAction('Resuming injection after usage limit modal closed', 'info');
            this.scheduleNextInjection();
        } else {
            // Update UI to reflect current state
            this.updateTimerUI();
        }
    }
    autoFillExecuteInForm() {
        // Use the stored reset time from the modal
        if (!this.currentResetTime) {
            this.logAction('No current reset time available for auto-fill', 'warning');
            return;
        }
        const now = new Date();
        const timeDiff = this.currentResetTime.resetTime.getTime() - now.getTime();
        const totalMinutes = Math.floor(timeDiff / (1000 * 60));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        // Fill the form based on the calculated time
        const durationInput = document.getElementById('duration-input');
        const unitSelect = document.getElementById('duration-unit');
        if (totalMinutes <= 0) {
            // Reset time has passed, set to 1 minute as fallback
            durationInput.value = 1;
            unitSelect.value = 'minutes';
            this.preferences.defaultDuration = 1;
            this.preferences.defaultUnit = 'minutes';
            this.logAction('Reset time has passed, auto-filled Execute in: 1 minute', 'warning');
        } else {
            // Use minutes for all cases to provide better accuracy
            const roundedMinutes = Math.max(1, totalMinutes); // Round total minutes, ensure at least 1 minute
            durationInput.value = roundedMinutes;
            unitSelect.value = 'minutes';
            this.preferences.defaultDuration = roundedMinutes;
            this.preferences.defaultUnit = 'minutes';
            this.logAction(`Auto-filled Execute in: ${roundedMinutes} minutes until ${this.currentResetTime.resetHour}${this.currentResetTime.ampm} reset`, 'info');
        }
        // Save preferences
        this.saveAllPreferences();
    }
    setTerminalStatusDisplay(status, terminalId = null) {
        // If terminalId is provided, update specific terminal status
        if (terminalId) {
            const terminalData = this.terminals.get(terminalId);
            if (terminalData) {
                const previousStatus = terminalData.status;
                terminalData.status = status || '...';
                const statusElement = document.querySelector(`[data-terminal-status="${terminalId}"]`);
                if (statusElement) {
                    // Clear all classes
                    statusElement.className = 'terminal-status';
                    // Set new status
                    switch(status) {
                        case 'running':
                            statusElement.className = 'terminal-status visible running';
                            statusElement.textContent = 'Running';
                            break;
                        case 'prompted':
                            statusElement.className = 'terminal-status visible prompted';
                            statusElement.textContent = 'Prompted';
                            break;
                        case 'injecting':
                            statusElement.className = 'terminal-status visible injecting';
                            statusElement.textContent = 'Injecting';
                            break;
                        default:
                            statusElement.className = 'terminal-status';
                            statusElement.textContent = '...';
                    }
                }
                // Check for completion sound trigger for this terminal
                this.checkCompletionSoundTrigger(previousStatus, terminalData.status, terminalId);
                // Check for injection and prompted sound triggers
                this.checkStatusChangeSounds(previousStatus, terminalData.status, terminalId);
            }
        } else {
            // Legacy support - update active terminal
            this.setTerminalStatusDisplay(status, this.activeTerminalId);
        }
    }
    checkCompletionSoundTrigger(previousStatus, currentStatus, terminalId) {
        // Trigger completion sound when transitioning from 'running' to idle ('...')
        if (previousStatus === 'running' && (currentStatus === '...' || currentStatus === '')) {
            // Play completion sound for this specific terminal completion
            // Remove queue empty check to allow sounds for each terminal individually
            setTimeout(() => {
                // Simple check: just make sure the terminal is still idle
                const terminalData = this.terminals.get(terminalId);
                const isStillIdle = terminalData && (terminalData.status === '...' || terminalData.status === '');
                if (isStillIdle) {
                    this.playCompletionSound();
                    this.logAction(`Terminal ${terminalId} completed - playing sound`, 'info');
                } else {
                    this.logAction(`Terminal ${terminalId} completion sound cancelled - status changed`, 'info');
                }
            }, 100);
        }
    }
    checkStatusChangeSounds(previousStatus, currentStatus, terminalId) {
        // Only play injection sound when status changes TO 'injecting'
        if (previousStatus !== 'injecting' && currentStatus === 'injecting') {
            this.playInjectionSound();
            this.logAction(`Terminal ${terminalId} injection started - playing injection sound`, 'info');
        }
        // Only play prompted sound when status changes TO 'prompted'
        if (previousStatus !== 'prompted' && currentStatus === 'prompted') {
            // Check if keywords-only mode is enabled
            if (this.preferences.promptedSoundKeywordsOnly) {
                // Only play sound if keywords are detected
                const terminalData = this.terminals.get(terminalId);
                if (terminalData && terminalData.lastOutput) {
                    const keywordResult = this.checkTerminalForKeywords(terminalData.lastOutput);
                    if (keywordResult.blocked) {
                        this.playPromptedSound();
                        this.logAction(`Terminal ${terminalId} prompted with keyword "${keywordResult.keyword}" - playing prompted sound`, 'info');
                    }
                }
            } else {
                // Play sound normally (default behavior)
                this.playPromptedSound();
                this.logAction(`Terminal ${terminalId} prompted - playing prompted sound`, 'info');
            }
        }
    }
    updateStatusDisplay() {
        const directoryElement = document.getElementById('current-directory');
        const tooltipElement = document.getElementById('directory-tooltip');
        const displayDirectory = this.currentDirectory || 'Loading...';
        directoryElement.childNodes[0].textContent = displayDirectory;
        tooltipElement.textContent = displayDirectory;
        document.getElementById('injection-count').textContent = this.injectionCount;
        document.getElementById('queue-count').textContent = this.messageQueue.length;
        document.getElementById('keyword-count').textContent = this.keywordCount;
        document.getElementById('plan-count').textContent = this.promptCount;
        // Update execution times in message list
        const executionTimeElements = document.querySelectorAll('.execution-time');
        executionTimeElements.forEach((element, index) => {
            if (this.messageQueue[index]) {
                element.textContent = this.getTimeUntilExecution(this.messageQueue[index].executeAt);
            }
        });
        // Save status values to backend if available
        this.saveStatusToBackend();
    }
    async saveStatusToBackend() {
        if (this.backendAPIClient && this.sessionId) {
            try {
                const statusData = {
                    current_directory: this.currentDirectory || '~',
                    injection_count: this.injectionCount,
                    keyword_count: this.keywordCount,
                    prompt_count: this.promptCount,
                    terminal_count: this.terminals.size,
                    active_terminal_id: this.activeTerminalId,
                    terminal_id_counter: this.terminalIdCounter
                };
                await this.backendAPIClient.updateApplicationStats(this.sessionId, statusData);
            } catch (error) {
                console.warn('Failed to save status to backend:', error);
                // Fallback: continue with local functionality
                // The application should still work even if backend is unavailable
            }
        }
    }
    async loadStatusFromBackend() {
        if (this.backendAPIClient && this.sessionId) {
            try {
                const backendStats = await this.backendAPIClient.getApplicationStats(this.sessionId);
                if (backendStats) {
                    // Restore counts and directory from backend
                    this.currentDirectory = backendStats.current_directory || this.currentDirectory;
                    this.injectionCount = backendStats.injection_count || this.injectionCount;
                    this.keywordCount = backendStats.keyword_count || this.keywordCount;
                    this.promptCount = backendStats.prompt_count || this.promptCount;
                    this.activeTerminalId = backendStats.active_terminal_id || this.activeTerminalId;
                    this.terminalIdCounter = backendStats.terminal_id_counter || this.terminalIdCounter;
                    // Update the display with loaded values
                    this.updateStatusDisplay();
                }
            } catch (error) {
                console.warn('Failed to load status from backend:', error);
            }
        }
    }
    async openDirectoryBrowser() {
        try {
            const result = await ipcRenderer.invoke('show-directory-dialog', this.currentDirectory);
            if (!result.canceled && result.filePaths.length > 0) {
                const selectedPath = result.filePaths[0];
                if (selectedPath !== this.currentDirectory) {
                    await this.changeDirectory(selectedPath);
                }
            }
        } catch (error) {
            console.error('Error opening directory dialog:', error);
            this.logAction('Directory dialog failed, using prompt fallback', 'warning');
            // Fallback to prompt-based directory selection
            this.openDirectoryPrompt();
        }
    }
    openDirectoryPrompt() {
        // Simple directory browser using prompt for now
        const newPath = prompt('Enter directory path:', this.currentDirectory);
        if (newPath === null || newPath.trim() === '') {
            return; // User cancelled or entered empty path
        }
        if (newPath.trim() !== this.currentDirectory) {
            this.changeDirectory(newPath.trim());
        }
    }
    async changeDirectory(newPath) {
        try {
            this.logAction(`Changing directory to: ${newPath}`, 'info');
            // Use the new IPC method to properly change the terminal's working directory
            const result = await ipcRenderer.invoke('change-terminal-directory', newPath);
            if (result.success) {
                // Update local state
                this.currentDirectory = newPath;
                this.updateRecentDirectories(newPath);
                // Save to preferences
                this.preferences.currentDirectory = newPath;
                this.saveAllPreferences();
                // Update UI
                this.updateStatusDisplay();
                this.logAction(`Successfully changed directory to: ${newPath}`, 'success');
            } else {
                this.logAction(`Failed to change directory: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('Error changing directory:', error);
            this.logAction(`Failed to change directory: ${error.message}`, 'error');
        }
    }
    handleTerminalOutput(terminalId = this.activeTerminalId) {
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return;
        // Always autoscroll when enabled and user is not interacting
        if (this.autoscrollEnabled && !terminalData.userInteracting) {
            this.scrollToBottom(terminalId);
        }
    }
    handleScroll(terminalId = this.activeTerminalId) {
        if (!this.autoscrollEnabled) return;
        const terminalWrapper = document.querySelector(`[data-terminal-id="${terminalId}"]`);
        if (!terminalWrapper) return;
        const viewport = terminalWrapper.querySelector('.xterm-viewport');
        if (!viewport) return;
        const isAtBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 10;
        // Use per-terminal timeout tracking
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return;
        if (!isAtBottom) {
            terminalData.userInteracting = true;
            if (terminalData.autoscrollTimeout) {
                clearTimeout(terminalData.autoscrollTimeout);
            }
            terminalData.autoscrollTimeout = setTimeout(() => {
                terminalData.userInteracting = false;
                // Always auto-resume scrolling when enabled
                if (this.autoscrollEnabled) {
                    this.scrollToBottom(terminalId);
                }
            }, this.autoscrollDelay);
        } else {
            terminalData.userInteracting = false;
            if (terminalData.autoscrollTimeout) {
                clearTimeout(terminalData.autoscrollTimeout);
                terminalData.autoscrollTimeout = null;
            }
        }
    }
    scrollToBottom(terminalId = this.activeTerminalId) {
        const terminalWrapper = document.querySelector(`[data-terminal-id="${terminalId}"]`);
        if (!terminalWrapper) return;
        const viewport = terminalWrapper.querySelector('.xterm-viewport');
        if (viewport) {
            viewport.scrollTo({
                top: viewport.scrollHeight,
                behavior: 'smooth'
            });
        }
    }
    async openSettingsModal() {
        const modal = document.getElementById('settings-modal');
        modal.classList.add('show');
    }
    closeSettingsModal() {
        const modal = document.getElementById('settings-modal');
        modal.classList.remove('show');
    }
    openMessageHistoryModal() {
        const modal = document.getElementById('message-history-modal');
        modal.classList.add('show');
        this.updateHistoryModal();
    }
    closeMessageHistoryModal() {
        const modal = document.getElementById('message-history-modal');
        modal.classList.remove('show');
    }
    openPromptsModal() {
        const modal = document.getElementById('plans-modal');
        modal.classList.add('show');
        this.updatePromptsModal();
    }
    closePromptsModal() {
        const modal = document.getElementById('plans-modal');
        modal.classList.remove('show');
    }
    updatePromptsModal() {
        const promptsList = document.getElementById('plans-list');
        if (this.preferences.promptRules.length === 0) {
            promptsList.innerHTML = `
                <div class="plans-empty">
                    <p>No prompts detected yet. Prompts will appear here when Claude provides options.</p>
                </div>
            `;
            return;
        }
        const promptsHTML = this.preferences.promptRules.map(prompt => `
            <div class="plan-item">
                <div class="plan-item-header">
                    <span class="plan-item-date">${new Date(prompt.timestamp).toLocaleString()}</span>
                    <span class="plan-item-terminal">Terminal ${prompt.terminalId}</span>
                </div>
                <div class="plan-item-content">
                    <pre>${prompt.content}</pre>
                </div>
            </div>
        `).join('');
        promptsList.innerHTML = promptsHTML;
    }
    // Terminal search functionality
    toggleTerminalSearch(terminalId) {
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return;
        const searchOverlay = document.querySelector(`[data-terminal-search="${terminalId}"]`);
        if (!searchOverlay) return;
        // Check if search is currently visible
        if (terminalData.searchVisible) {
            // Hide search if it's currently visible
            this.hideTerminalSearch(terminalId);
        } else {
            // Show search if it's currently hidden
            this.showTerminalSearch(terminalId);
        }
    }
    showTerminalSearch(terminalId) {
        console.log('showTerminalSearch called with terminalId:', terminalId);
        const terminalData = this.terminals.get(terminalId);
        console.log('Terminal data found:', !!terminalData);
        if (!terminalData) return;
        const searchOverlay = document.querySelector(`[data-terminal-search="${terminalId}"]`);
        console.log('Search overlay found:', !!searchOverlay);
        if (!searchOverlay) return;
        // Show the search overlay
        searchOverlay.style.display = 'block';
        terminalData.searchVisible = true;
        // Add search-active class to terminal wrapper
        const terminalWrapper = document.querySelector(`[data-terminal-id="${terminalId}"]`);
        if (terminalWrapper) {
            terminalWrapper.classList.add('search-active');
        }
        console.log('Search overlay shown');
        // Focus the search input
        const searchInput = searchOverlay.querySelector('.search-input');
        if (searchInput) {
            searchInput.focus();
            searchInput.select();
            console.log('Search input focused');
        }
        // Set up event listeners if not already done
        this.setupTerminalSearchListeners(terminalId);
        // Initialize Lucide icons in the search overlay
        if (typeof lucide !== 'undefined') {
            lucide.createIcons({
                nameAttr: 'data-lucide'
            });
        }
    }
    hideTerminalSearch(terminalId) {
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return;
        const searchOverlay = document.querySelector(`[data-terminal-search="${terminalId}"]`);
        if (!searchOverlay) return;
        // Hide the search overlay
        searchOverlay.style.display = 'none';
        terminalData.searchVisible = false;
        // Remove search-active class from terminal wrapper
        const terminalWrapper = document.querySelector(`[data-terminal-id="${terminalId}"]`);
        if (terminalWrapper) {
            terminalWrapper.classList.remove('search-active');
        }
        // Clear any search highlights
        terminalData.searchAddon.clearDecorations();
        // Focus back on terminal
        terminalData.terminal.focus();
    }
    setupTerminalSearchListeners(terminalId) {
        const searchOverlay = document.querySelector(`[data-terminal-search="${terminalId}"]`);
        if (!searchOverlay || searchOverlay.dataset.listenersSetup) return;
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return;
        const searchInput = searchOverlay.querySelector('.search-input');
        const prevBtn = searchOverlay.querySelector('.search-prev');
        const nextBtn = searchOverlay.querySelector('.search-next');
        const closeBtn = searchOverlay.querySelector('.search-close');
        const matchesDisplay = searchOverlay.querySelector('.search-matches');
        let currentMatches = 0;
        let currentIndex = 0;
        // Manual search tracking since onDidChangeResults might not be available
        let currentSearchTerm = '';
        function countMatches(searchTerm) {
            if (!searchTerm) return 0;
            try {
                // Get terminal buffer content
                const buffer = terminalData.terminal.buffer.active;
                let matchCount = 0;
                // Search through all lines in the terminal buffer
                for (let i = 0; i < buffer.length; i++) {
                    const line = buffer.getLine(i);
                    if (line) {
                        const lineText = line.translateToString();
                        // Count overlapping matches
                        let pos = 0;
                        while ((pos = lineText.toLowerCase().indexOf(searchTerm.toLowerCase(), pos)) !== -1) {
                            matchCount++;
                            pos += 1; // Move by 1 to find overlapping matches
                        }
                    }
                }
                return matchCount;
            } catch (error) {
                console.error('Error counting matches:', error);
                return 0;
            }
        }
        function updateMatchDisplay(found, isNavigation = false) {
            if (found) {
                if (!isNavigation) {
                    // Count total matches for new search
                    currentMatches = countMatches(currentSearchTerm);
                    currentIndex = 1;
                } else {
                    // For navigation, just increment/decrement index
                    // Note: This is approximate since we don't know exact position
                    if (currentMatches > 0) {
                        // We'll keep current index for now
                    }
                }
                if (currentMatches > 0) {
                    matchesDisplay.textContent = `${currentIndex} of ${currentMatches}`;
                } else {
                    matchesDisplay.textContent = 'Found';
                }
                prevBtn.disabled = false;
                nextBtn.disabled = false;
            } else {
                matchesDisplay.textContent = 'No matches';
                prevBtn.disabled = true;
                nextBtn.disabled = true;
                currentIndex = 0;
                currentMatches = 0;
            }
        }
        // Search input handler
        searchInput.addEventListener('input', () => {
            const query = searchInput.value;
            if (query) {
                try {
                    // Clear previous search decorations
                    terminalData.searchAddon.clearDecorations();
                    // Search for the term
                    const found = terminalData.searchAddon.findNext(query);
                    currentSearchTerm = query;
                    updateMatchDisplay(found, false);
                } catch (error) {
                    console.error('Search error:', error);
                    matchesDisplay.textContent = `Error`;
                }
            } else {
                try {
                    terminalData.searchAddon.clearDecorations();
                } catch (error) {
                    console.error('Clear decorations error:', error);
                }
                matchesDisplay.textContent = `0 of 0`;
                prevBtn.disabled = true;
                nextBtn.disabled = true;
                currentSearchTerm = '';
            }
        });
        // Navigation handlers
        nextBtn.addEventListener('click', () => {
            const query = searchInput.value;
            if (query) {
                try {
                    const found = terminalData.searchAddon.findNext(query);
                    if (found && currentMatches > 0) {
                        currentIndex = Math.min(currentIndex + 1, currentMatches);
                    }
                    updateMatchDisplay(found, true);
                } catch (error) {
                    console.error('Find next error:', error);
                    matchesDisplay.textContent = `Error`;
                }
            }
        });
        prevBtn.addEventListener('click', () => {
            const query = searchInput.value;
            if (query) {
                try {
                    const found = terminalData.searchAddon.findPrevious(query);
                    if (found && currentMatches > 0) {
                        currentIndex = Math.max(currentIndex - 1, 1);
                    }
                    updateMatchDisplay(found, true);
                } catch (error) {
                    console.error('Find previous error:', error);
                    matchesDisplay.textContent = `Error`;
                }
            }
        });
        // Close handler
        closeBtn.addEventListener('click', () => {
            this.hideTerminalSearch(terminalId);
        });
        // Keyboard navigation within search
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.hideTerminalSearch(terminalId);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) {
                    prevBtn.click();
                } else {
                    nextBtn.click();
                }
            }
        });
        // Mark listeners as set up
        searchOverlay.dataset.listenersSetup = 'true';
    }
    // Message validation utility
    isValidMessageContent(content) {
        return content && typeof content === 'string' && content.trim().length > 0;
    }
    // Generic modal utility functions
    showModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('show');
        }
    }
    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('show');
        }
    }
    updateHistoryModal() {
        const historyList = document.getElementById('history-list');
        if (this.messageHistory.length === 0) {
            historyList.innerHTML = `
                <div class="history-empty">
                    <p>No message history yet. Messages will appear here after they are successfully injected.</p>
                </div>
            `;
            return;
        }
        const historyHTML = this.messageHistory.map(item => {
            // Get terminal data to extract name and color
            const terminalData = this.terminals.get(item.terminalId);
            const terminalName = terminalData ? terminalData.name : `Terminal ${item.terminalId}`;
            const terminalColor = terminalData ? terminalData.color : this.terminalColors[(item.terminalId - 1) % this.terminalColors.length];
            return `
                <div class="history-item">
                    <div class="history-item-header">
                        <div class="history-item-info">
                            <span class="history-item-date">${item.injectedAt}</span>
                            <span class="history-item-meta" style="color: ${terminalColor};">
                                ${item.terminalId ? terminalName : 'Unknown Terminal'}
                                ${item.counter ? ` • #${item.counter}` : ''}
                            </span>
                        </div>
                        <div class="history-item-actions">
                            <button class="undo-btn" onclick="terminalGUI.undoFromHistory('${item.id}')" title="Add back to queue">
                                <i data-lucide="undo-2"></i>
                            </button>
                            <button class="delete-btn" onclick="terminalGUI.deleteFromHistory('${item.id}')" title="Delete from history">
                                <i data-lucide="trash-2"></i>
                            </button>
                        </div>
                    </div>
                    <div class="history-item-content" style="color: ${terminalColor};">${this.escapeHtml(item.content)}</div>
                </div>
            `;
        }).join('');
        historyList.innerHTML = historyHTML;
        // Initialize Lucide icons for the new buttons
        lucide.createIcons();
    }
    undoFromHistory(historyId) {
        // Convert historyId to appropriate type for comparison
        const historyIdParsed = typeof historyId === 'string' ? parseFloat(historyId) : historyId;
        const historyItem = this.messageHistory.find(item => item.id === historyIdParsed);
        if (!historyItem) {
            this.logAction(`History item not found. ID: ${historyId}, Available IDs: ${this.messageHistory.map(item => item.id).join(', ')}`, 'error');
            return;
        }
        // Validate content is not empty or just whitespace
        const content = (historyItem.content || '').trim();
        if (!this.isValidMessageContent(content)) {
            this.logAction('Cannot restore empty message from history', 'warning');
            return;
        }
        // Create a new message for the queue
        const now = Date.now();
        const newMessage = {
            id: this.generateMessageId(),
            content: content,
            processedContent: content,
            executeAt: now,
            createdAt: now,
            timestamp: now, // For compatibility
            sequence: ++this.messageSequenceCounter
        };
        // Add to the end of the queue
        this.messageQueue.push(newMessage);
        this.updateTrayBadge();
        this.saveMessageQueue();
        this.updateMessageList();
        this.updateStatusDisplay();
        this.logAction(`Message restored from history: "${historyItem.content.substring(0, 50)}..."`, 'info');
        // Close the history modal
        this.closeMessageHistoryModal();
    }
    deleteFromHistory(historyId) {
        // Convert historyId to appropriate type for comparison
        const historyIdParsed = typeof historyId === 'string' ? parseFloat(historyId) : historyId;
        const historyItemIndex = this.messageHistory.findIndex(item => item.id === historyIdParsed);
        if (historyItemIndex === -1) {
            this.logAction(`History item not found. ID: ${historyId}, Available IDs: ${this.messageHistory.map(item => item.id).join(', ')}`, 'error');
            return;
        }
        const historyItem = this.messageHistory[historyItemIndex];
        this.messageHistory.splice(historyItemIndex, 1);
        // Save updated history to preferences
        this.preferences.messageHistory = this.messageHistory;
        this.savePreferences();
        // Update the modal display
        this.updateHistoryModal();
        this.logAction(`Deleted message from history: "${historyItem.content.substring(0, 50)}..."`, 'info');
    }
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    // Background service utility methods
    async startPowerSaveBlocker() {
        try {
            if (!this.powerSaveBlockerActive) {
                const result = await ipcRenderer.invoke('start-power-save-blocker');
                if (result.success) {
                    this.powerSaveBlockerActive = true;
                    this.logAction('Power save blocker started - screen will stay awake during injection', 'info');
                } else {
                    this.logAction('Failed to start power save blocker: ' + result.error, 'error');
                }
            }
        } catch (error) {
            this.logAction('Error starting power save blocker: ' + error.message, 'error');
        }
    }
    async stopPowerSaveBlocker() {
        try {
            if (this.powerSaveBlockerActive) {
                const result = await ipcRenderer.invoke('stop-power-save-blocker');
                if (result.success) {
                    this.powerSaveBlockerActive = false;
                    this.logAction('Power save blocker stopped - system can sleep normally', 'info');
                } else {
                    this.logAction('Failed to stop power save blocker: ' + result.error, 'error');
                }
            }
        } catch (error) {
            this.logAction('Error stopping power save blocker: ' + error.message, 'error');
        }
    }
    setupTrayEventListeners() {
        // Set up IPC listeners for tray events
        ipcRenderer.on('tray-start-injection', () => {
            this.logAction('Start injection triggered from tray', 'info');
            if (this.messageQueue.length > 0) {
                this.scheduleNextInjection();
            } else {
                this.logAction('No messages in queue to inject', 'info');
            }
        });
        ipcRenderer.on('tray-stop-injection', () => {
            this.logAction('Stop injection triggered from tray', 'info');
            this.cancelSequentialInjection();
        });
        this.logAction('Tray event listeners setup', 'info');
    }
    async updateTrayBadge() {
        try {
            const queueSize = this.messageQueue.length;
            const result = await ipcRenderer.invoke('update-tray-badge', queueSize);
            if (result.success) {
                this.logAction(`Tray badge updated with queue size: ${queueSize}`, 'debug');
            } else {
                this.logAction('Failed to update tray badge: ' + result.error, 'error');
            }
        } catch (error) {
            this.logAction('Error updating tray badge: ' + error.message, 'error');
        }
    }
    async loadAllPreferences() {
        try {
            // Migrate localStorage data if it exists and database is empty
            await this.checkAndMigrateLocalStorageData();
            // Load all settings from database
            const dbSettings = await ipcRenderer.invoke('db-get-all-settings');
            // Parse settings and merge with defaults
            Object.keys(dbSettings).forEach(key => {
                try {
                    this.preferences[key] = JSON.parse(dbSettings[key]);
                } catch (error) {
                    this.preferences[key] = dbSettings[key];
                }
            });
            // Apply to UI and instance variables  
            this.autoscrollEnabled = this.preferences.autoscrollEnabled !== undefined ? this.preferences.autoscrollEnabled : true;
            this.autoscrollDelay = this.preferences.autoscrollDelay || 3000;
            this.autoContinueEnabled = this.preferences.autoContinueEnabled || false;
            this.planModeEnabled = this.preferences.planModeEnabled || false;
            this.planModeCommand = this.preferences.planModeCommand || 'npx claude-flow@alpha hive-mind spawn "{message}" --agents 5 --strategy development --claude';
            // Load saved timer values, but check if target datetime has passed
            if (this.preferences.timerTargetDateTime) {
                const targetDate = new Date(this.preferences.timerTargetDateTime);
                const now = new Date();
                if (now >= targetDate) {
                    // Target time has passed, clear timer and mark as expired
                    this.logAction(`Timer target time (${targetDate.toLocaleString()}) has already passed on startup`, 'info');
                    this.timerHours = 0;
                    this.timerMinutes = 0;
                    this.timerSeconds = 0;
                    this.timerExpired = true;
                    // Clear the saved values
                    this.preferences.timerTargetDateTime = null;
                    this.preferences.timerHours = 0;
                    this.preferences.timerMinutes = 0;
                    this.preferences.timerSeconds = 0;
                    this.saveAllPreferences();
                } else {
                    // Target time hasn't passed, restore timer values
                    this.timerHours = this.preferences.timerHours || 0;
                    this.timerMinutes = this.preferences.timerMinutes || 0;
                    this.timerSeconds = this.preferences.timerSeconds || 0;
                    this.timerExpired = false;
                }
            } else {
                // No target datetime saved, load timer values normally
                this.timerHours = this.preferences.timerHours || 0;
                this.timerMinutes = this.preferences.timerMinutes || 0;
                this.timerSeconds = this.preferences.timerSeconds || 0;
                this.timerExpired = false;
            }
            // Load message queue from database - only terminal 1 messages initially
            // This prevents race condition duplicates when messages target non-terminal-1 terminals
            const dbMessages = await ipcRenderer.invoke('db-get-messages');
            this.messageQueue = dbMessages
                .filter(msg => (msg.terminal_id || 1) === 1) // Only load terminal 1 messages
                .map(msg => ({
                    id: msg.message_id,
                    content: msg.content,
                    processedContent: msg.processed_content,
                    executeAt: msg.execute_at,
                    createdAt: msg.created_at,
                    timestamp: msg.created_at, // For compatibility
                    terminalId: msg.terminal_id || 1 // Include terminal ID
                }));
            // Synchronize messageIdCounter to avoid duplicate IDs
            if (this.messageQueue.length > 0) {
                this.messageIdCounter = Math.max(...this.messageQueue.map(m => m.id)) + 1;
            }
            this.updateMessageList();
            this.validateMessageIds(); // Debug: Check for ID conflicts after loading
            // Sync messages from backend after loading local messages - only for terminal 1
            this.logAction('About to sync messages from backend for terminal 1...', 'info');
            await this.syncMessagesFromBackend(true, 1); // verbose = true for initial sync, terminal 1 only
            this.logAction('Finished syncing messages from backend for terminal 1', 'info');
            // Load message history from database
            const dbHistory = await ipcRenderer.invoke('db-get-message-history');
            this.messageHistory = dbHistory.map(item => ({
                content: item.content,
                timestamp: item.timestamp
            }));
            // Load saved directory
            if (this.preferences.currentDirectory) {
                this.currentDirectory = this.preferences.currentDirectory;
                this.updateStatusDisplay();
            }
            // Load recent directories
            if (this.preferences.recentDirectories) {
                this.recentDirectories = this.preferences.recentDirectories;
            }
            // Restore usage limit waiting state
            if (this.preferences.usageLimitWaiting !== undefined) {
                this.usageLimitWaiting = this.preferences.usageLimitWaiting;
                this.logAction(`Restored usageLimitWaiting state: ${this.usageLimitWaiting}`, 'info');
            }
            // Update UI elements safely
            const autoscrollEnabledEl = document.getElementById('autoscroll-enabled');
            if (autoscrollEnabledEl) autoscrollEnabledEl.checked = this.autoscrollEnabled;
            const autoscrollDelayEl = document.getElementById('autoscroll-delay');
            if (autoscrollDelayEl) autoscrollDelayEl.value = this.autoscrollDelay;
            this.updateAutoContinueButtonState();
            this.updatePlanModeButtonState();
            const themeSelectEl = document.getElementById('theme-select');
            if (themeSelectEl) themeSelectEl.value = this.preferences.theme || 'dark';
            // Update sound settings UI
            const soundEffectsEl = document.getElementById('sound-effects-enabled');
            if (soundEffectsEl) soundEffectsEl.checked = this.preferences.completionSoundEnabled || false;
            const promptedSoundKeywordsOnlyEl = document.getElementById('prompted-sound-keywords-only');
            if (promptedSoundKeywordsOnlyEl) promptedSoundKeywordsOnlyEl.checked = this.preferences.promptedSoundKeywordsOnly || false;
            // Update background service settings UI
            const keepScreenAwakeEl = document.getElementById('keep-screen-awake');
            if (keepScreenAwakeEl) keepScreenAwakeEl.checked = this.preferences.keepScreenAwake || true;
            const showSystemNotificationsEl = document.getElementById('show-system-notifications');
            if (showSystemNotificationsEl) showSystemNotificationsEl.checked = this.preferences.showSystemNotifications || true;
            const minimizeToTrayEl = document.getElementById('minimize-to-tray');
            if (minimizeToTrayEl) minimizeToTrayEl.checked = this.preferences.minimizeToTray || true;
            const startMinimizedEl = document.getElementById('start-minimized');
            if (startMinimizedEl) startMinimizedEl.checked = this.preferences.startMinimized || false;
            // Update todo generation settings UI
            const automaticTodoGenerationEl = document.getElementById('automatic-todo-generation');
            if (automaticTodoGenerationEl) automaticTodoGenerationEl.checked = this.preferences.automaticTodoGeneration !== undefined ? this.preferences.automaticTodoGeneration : true;
            // Update plan mode settings UI
            const planModeCommandEl = document.getElementById('plan-mode-command');
            if (planModeCommandEl) planModeCommandEl.value = this.planModeCommand;
            this.updateAutoContinueButtonState();
            this.updatePlanModeButtonState();
            // Apply theme
            this.applyTheme(this.preferences.theme || 'dark');
            // Update keyword rules display
            this.updateKeywordRulesDisplay();
            // Update sound settings visibility
            this.updateSoundSettingsVisibility();
            // Populate sound effects from soundeffects folder
            await this.populateSoundEffects();
            // Load saved usage limit reset time and start auto-sync if available
            await this.loadUsageLimitResetTime();
            // Synchronize promptCount with loaded promptRules
            this.syncPromptCount();
            this.logAction('Preferences loaded successfully from database', 'success');
        } catch (error) {
            console.error('Error loading preferences:', error);
            this.logAction('Failed to load preferences - using defaults', 'error');
        }
    }
    async savePreferences() {
        // Update preferences object with current values before saving
        this.preferences.currentDirectory = this.currentDirectory;
        this.preferences.usageLimitWaiting = this.usageLimitWaiting;
        await this.saveAllPreferences();
    }
    async saveAllPreferences() {
        try {
            // Save each preference to database
            for (const [key, value] of Object.entries(this.preferences)) {
                if (key === 'messageQueue' || key === 'messageHistory') continue; // Handle separately
                await ipcRenderer.invoke('db-set-setting', key, JSON.stringify(value));
            }
            // Save terminal state
            await this.saveTerminalState();
        } catch (error) {
            console.error('Failed to save preferences:', error);
        }
    }
    async saveTerminalSessionMapping() {
        try {
            // Convert Map to object for storage
            const mappingObj = {};
            this.terminalSessionMap.forEach((sessionId, terminalId) => {
                mappingObj[terminalId] = sessionId;
            });
            await ipcRenderer.invoke('db-save-setting', 'terminalSessionMapping', mappingObj);
        } catch (error) {
            console.error('Failed to save terminal session mapping:', error);
        }
    }
    async loadTerminalSessionMapping() {
        try {
            const settings = await ipcRenderer.invoke('db-get-settings');
            let mappingObj = settings.terminalSessionMapping;
            if (mappingObj) {
                // If it's a string, parse it as JSON
                if (typeof mappingObj === 'string') {
                    mappingObj = JSON.parse(mappingObj);
                }
                this.terminalSessionMap.clear();
                Object.entries(mappingObj).forEach(([terminalId, sessionId]) => {
                    this.terminalSessionMap.set(parseInt(terminalId), sessionId);
                });
            }
        } catch (error) {
            console.error('Failed to load terminal session mapping:', error);
        }
    }
    async saveTerminalState() {
        try {
            const terminalState = {
                activeTerminalId: this.activeTerminalId,
                terminalIdCounter: this.terminalIdCounter,
                terminals: Array.from(this.terminals.entries()).map(([id, data]) => ({
                    id,
                    name: data.name,
                    color: data.color,
                    directory: data.directory
                }))
            };
            // Save to local database
            await ipcRenderer.invoke('db-set-setting', 'terminalState', JSON.stringify(terminalState));
            // Also save to backend if available
            if (this.backendAPIClient) {
                try {
                    // Update each terminal session in the backend
                    for (const [terminalId, terminalData] of this.terminals.entries()) {
                        const backendSessionId = this.terminalSessionMap.get(terminalId);
                        if (backendSessionId) {
                            await this.backendAPIClient.updateTerminalSessionComplete(
                                backendSessionId,
                                terminalData.name,
                                terminalData.color,
                                terminalId,
                                terminalId - 1, // position index
                                terminalData.directory || this.currentDirectory
                            );
                        }
                    }
                } catch (backendError) {
                    console.warn('Failed to save terminal state to backend:', backendError);
                }
            }
        } catch (error) {
            console.error('Failed to save terminal state:', error);
        }
    }
    async loadTerminalState() {
        try {
            // Load from local database first
            const settings = await ipcRenderer.invoke('db-get-all-settings');
            let terminalState = settings.terminalState;
            if (terminalState) {
                if (typeof terminalState === 'string') {
                    terminalState = JSON.parse(terminalState);
                }
                // Restore terminal counter and active terminal
                this.terminalIdCounter = terminalState.terminalIdCounter || 1;
                this.activeTerminalId = terminalState.activeTerminalId || 1;
                // Store terminal data for restoration after terminals are created
                this.savedTerminalData = terminalState.terminals || [];
            }
            // Also try to load from backend if available
            if (this.backendAPIClient) {
                try {
                    const backendSessions = await this.backendAPIClient.getTerminalSessions();
                    if (backendSessions && backendSessions.length > 0) {
                        // Convert backend sessions to local format
                        const backendTerminals = backendSessions.map(session => ({
                            id: session.frontend_terminal_id || session.id,
                            name: session.name,
                            color: session.color,
                            directory: session.current_directory
                        })).filter(t => t.id); // Only include sessions with frontend terminal IDs
                        // Merge backend data with local data, preferring backend data for names
                        if (backendTerminals.length > 0) {
                            // Create a map for easier merging
                            const localTerminals = new Map((this.savedTerminalData || []).map(t => [t.id, t]));
                            const backendMap = new Map(backendTerminals.map(t => [t.id, t]));
                            // Merge data, preferring backend names but keeping local data if backend doesn't have it
                            const mergedTerminals = [];
                            const allIds = new Set([...localTerminals.keys(), ...backendMap.keys()]);
                            for (const id of allIds) {
                                const localTerm = localTerminals.get(id);
                                const backendTerm = backendMap.get(id);
                                if (backendTerm) {
                                    // Backend has this terminal, use it but supplement with local data if needed
                                    mergedTerminals.push({
                                        id: backendTerm.id,
                                        name: backendTerm.name || (localTerm && localTerm.name) || `Terminal ${id}`,
                                        color: backendTerm.color || (localTerm && localTerm.color) || this.terminalColors[(id - 1) % this.terminalColors.length],
                                        directory: backendTerm.directory || (localTerm && localTerm.directory) || this.currentDirectory
                                    });
                                } else if (localTerm) {
                                    // Only in local data, keep it
                                    mergedTerminals.push(localTerm);
                                }
                            }
                            this.savedTerminalData = mergedTerminals;
                            // Update counters based on merged data
                            const maxId = Math.max(...mergedTerminals.map(t => t.id));
                            this.terminalIdCounter = Math.max(this.terminalIdCounter, maxId + 1);
                        }
                    }
                } catch (backendError) {
                    console.warn('Failed to load terminal state from backend:', backendError);
                }
            }
        } catch (error) {
            console.error('Failed to load terminal state:', error);
        }
    }
    restoreTerminalData() {
        // Apply saved terminal data to existing terminals (data should already be applied during creation)
        if (this.savedTerminalData && this.savedTerminalData.length > 0) {
            for (const termData of this.savedTerminalData) {
                if (this.terminals.has(termData.id)) {
                    const existingTerminal = this.terminals.get(termData.id);
                    // Update terminal data that might not have been set during creation
                    existingTerminal.name = termData.name || existingTerminal.name;
                    existingTerminal.directory = termData.directory || existingTerminal.directory;
                    // Update the title in the DOM to match the saved name
                    const titleElement = document.querySelector(`[data-terminal-id="${termData.id}"] .terminal-title`);
                    if (titleElement && termData.name) {
                        titleElement.textContent = termData.name;
                    }
                }
            }
            // Update UI to reflect loaded state
            this.updateTerminalDropdowns();
            this.updateManualTerminalDropdown();
            this.switchToTerminal(this.activeTerminalId);
            // Clear saved data after applying
            this.savedTerminalData = null;
        }
    }
    async syncMessagesFromBackend(verbose = false, specificTerminalId = null) {
        // Sync messages from backend for all terminal sessions or specific terminal
        if (verbose) {
            this.logAction('syncMessagesFromBackend called, checking backend API client...', 'info');
            this.logAction(`Backend API client available: ${!!this.backendAPIClient}`, 'info');
            this.logAction(`Terminal session map size: ${this.terminalSessionMap.size}`, 'info');
            if (specificTerminalId) {
                this.logAction(`Syncing for specific terminal: ${specificTerminalId}`, 'info');
            }
        }
        if (!this.backendAPIClient) {
            if (verbose) this.logAction('No backend API client available', 'warning');
            return;
        }
        try {
            let totalNewMessages = 0;
            // Get messages for each terminal session (filtered by specificTerminalId if provided)
            for (const [terminalId, sessionId] of this.terminalSessionMap) {
                if (specificTerminalId && terminalId !== specificTerminalId) {
                    continue; // Skip if we're only syncing for a specific terminal
                }
                if (verbose) this.logAction(`Getting messages for terminal ${terminalId}, session ${sessionId}`, 'info');
                const backendMessages = await this.backendAPIClient.getQueuedMessages(sessionId, 'pending');
                const messages = backendMessages.results || backendMessages;
                if (verbose) this.logAction(`Got ${messages.length} messages from backend for terminal ${terminalId}`, 'info');
                // Add backend messages that aren't already in local queue
                // Improved duplicate detection to prevent race condition duplicates
                for (const backendMsg of messages) {
                    const exists = this.messageQueue.some(msg => 
                        msg.backendId === backendMsg.id ||
                        (msg.content === backendMsg.content && msg.terminalId === terminalId && 
                         Math.abs(msg.createdAt - new Date(backendMsg.created_at).getTime()) < 1000) // Within 1 second to handle slight timing differences
                    );
                    if (!exists) {
                        const message = {
                            id: this.generateMessageId(),
                            content: backendMsg.content,
                            processedContent: backendMsg.content,
                            executeAt: Date.now(),
                            createdAt: new Date(backendMsg.created_at).getTime(),
                            timestamp: new Date(backendMsg.created_at).getTime(),
                            terminalId: terminalId,
                            backendId: backendMsg.id, // Store backend ID for reference
                            sequence: ++this.messageSequenceCounter
                        };
                        this.messageQueue.push(message);
                        totalNewMessages++;
                        if (verbose) this.logAction(`Added message from backend: "${backendMsg.content}"`, 'success');
                    } else {
                        if (verbose) this.logAction(`Message already exists: "${backendMsg.content}"`, 'info');
                    }
                }
            }
            // Update UI after syncing
            if (totalNewMessages > 0) {
                this.updateMessageList();
                this.updateStatusDisplay();
                this.logAction(`Added ${totalNewMessages} new messages from backend`, 'success');
            } else if (verbose) {
                this.logAction(`Synced messages from backend. Total queue size: ${this.messageQueue.length}`, 'success');
            }
        } catch (error) {
            if (verbose) this.logAction(`Failed to sync messages from backend: ${error.message}`, 'error');
        }
    }
    async loadMessagesForTerminal(terminalId, verbose = false) {
        // Load messages for a specific terminal from database and backend
        if (verbose) {
            this.logAction(`Loading messages for terminal ${terminalId}`, 'info');
        }
        try {
            // Load messages from database for this terminal
            const dbMessages = await ipcRenderer.invoke('db-get-messages');
            const terminalMessages = dbMessages
                .filter(msg => (msg.terminal_id || 1) === terminalId)
                .map(msg => ({
                    id: msg.message_id,
                    content: msg.content,
                    processedContent: msg.processed_content,
                    executeAt: msg.execute_at,
                    createdAt: msg.created_at,
                    timestamp: msg.created_at,
                    terminalId: msg.terminal_id || 1
                }));
            // Add messages that aren't already in the queue
            let addedCount = 0;
            for (const message of terminalMessages) {
                const exists = this.messageQueue.some(msg => 
                    msg.id === message.id ||
                    (msg.content === message.content && msg.terminalId === message.terminalId && msg.createdAt === message.createdAt)
                );
                if (!exists) {
                    // Update message ID counter if needed
                    if (message.id >= this.messageIdCounter) {
                        this.messageIdCounter = message.id + 1;
                    }
                    this.messageQueue.push(message);
                    addedCount++;
                }
            }
            if (verbose && addedCount > 0) {
                this.logAction(`Added ${addedCount} messages from database for terminal ${terminalId}`, 'success');
            }
            // Sync from backend for this terminal
            await this.syncMessagesFromBackend(verbose, terminalId);
            // Update UI
            this.updateMessageList();
            this.updateStatusDisplay();
        } catch (error) {
            if (verbose) this.logAction(`Failed to load messages for terminal ${terminalId}: ${error.message}`, 'error');
        }
    }
    async markMessageAsInjectedInBackend(message) {
        // Mark message as injected in backend if it has a backend ID
        if (!this.backendAPIClient || !message.backendId) {
            this.logAction(`Cannot mark message as injected - backendAPIClient: ${!!this.backendAPIClient}, backendId: ${message.backendId}`, 'warning');
            return;
        }
        try {
            await this.backendAPIClient.injectMessage(message.backendId);
            this.logAction(`Marked message ${message.backendId} as injected in backend`, 'success');
        } catch (error) {
            this.logAction(`Failed to mark message as injected in backend: ${error.message}`, 'error');
        }
    }
    connectMessageQueueWebSocket() {
        if (!this.backendAPIClient) return;
        try {
            this.messageQueueWebSocket = this.backendAPIClient.createMessageQueueWebSocket();
            this.messageQueueWebSocket.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleMessageQueueWebSocketEvent(data);
                } catch (error) {
                    this.logAction(`Error parsing WebSocket message: ${error.message}`, 'error');
                }
            };
            this.messageQueueWebSocket.onopen = () => {
                this.logAction('Connected to message queue WebSocket', 'success');
            };
            this.messageQueueWebSocket.onclose = () => {
                this.logAction('Message queue WebSocket disconnected', 'warning');
                // Attempt to reconnect after 5 seconds
                setTimeout(() => {
                    this.logAction('Attempting to reconnect to message queue WebSocket...', 'info');
                    this.connectMessageQueueWebSocket();
                }, 5000);
            };
            this.messageQueueWebSocket.onerror = (error) => {
                this.logAction(`Message queue WebSocket error: ${error}`, 'error');
            };
        } catch (error) {
            this.logAction(`Failed to connect to message queue WebSocket: ${error.message}`, 'error');
        }
    }
    handleMessageQueueWebSocketEvent(data) {
        const { type, action, message, terminal_session } = data;
        this.logAction(`WebSocket event: ${type} - ${action || 'N/A'}`, 'info');
        if (type === 'message_queue_update' || type === 'message_added') {
            this.handleMessageQueueUpdate(action, message, terminal_session);
        } else if (type === 'message_injected') {
            this.handleMessageInjected(data.message_id, terminal_session);
        }
    }
    handleMessageQueueUpdate(action, messageData, terminalSessionId) {
        // Find the terminal ID that corresponds to this session
        let terminalId = null;
        for (const [tId, sessionId] of this.terminalSessionMap) {
            if (sessionId === terminalSessionId) {
                terminalId = tId;
                break;
            }
        }
        if (!terminalId) {
            this.logAction(`Could not find terminal for session ${terminalSessionId}`, 'warning');
            return;
        }
        if (action === 'added') {
            // Check if message already exists to avoid duplicates
            const exists = this.messageQueue.some(msg => 
                msg.backendId === messageData.id || 
                (msg.content === messageData.content && msg.terminalId === terminalId)
            );
            if (!exists) {
                const message = {
                    id: this.generateMessageId(),
                    content: messageData.content,
                    processedContent: messageData.content,
                    executeAt: Date.now(),
                    createdAt: new Date(messageData.created_at).getTime(),
                    timestamp: new Date(messageData.created_at).getTime(),
                    terminalId: terminalId,
                    backendId: messageData.id,
                    sequence: ++this.messageSequenceCounter
                };
                this.messageQueue.push(message);
                this.updateMessageList();
                this.updateStatusDisplay();
                this.logAction(`Added message from WebSocket: "${messageData.content}"`, 'success');
            }
        } else if (action === 'removed') {
            // Remove message from queue
            const index = this.messageQueue.findIndex(msg => msg.backendId === messageData.id);
            if (index !== -1) {
                this.messageQueue.splice(index, 1);
                this.updateMessageList();
                this.updateStatusDisplay();
                this.logAction(`Removed message from WebSocket: "${messageData.content}"`, 'info');
            }
        }
    }
    handleMessageInjected(messageId, terminalSessionId) {
        // Find and remove the injected message from the queue
        const index = this.messageQueue.findIndex(msg => msg.backendId === messageId);
        if (index !== -1) {
            const message = this.messageQueue[index];
            this.messageQueue.splice(index, 1);
            this.updateMessageList();
            this.updateStatusDisplay();
            this.logAction(`Message injected via WebSocket: "${message.content}"`, 'success');
        }
    }
    startMessageQueuePolling() {
        // Poll for message updates every 2 seconds
        this.messageQueuePolling = setInterval(async () => {
            try {
                await this.syncMessagesFromBackend();
            } catch (error) {
                // Silently continue - error logging is handled in syncMessagesFromBackend
            }
        }, 2000);
        this.logAction('Started polling for message queue updates every 2 seconds', 'info');
    }
    stopMessageQueuePolling() {
        if (this.messageQueuePolling) {
            clearInterval(this.messageQueuePolling);
            this.messageQueuePolling = null;
            this.logAction('Stopped message queue polling', 'info');
        }
    }
    async syncTerminalSessions() {
        // Sync existing backend sessions with frontend terminals
        // This helps maintain mapping across app restarts
        if (!this.backendAPIClient) return;
        try {
            const sessions = await this.backendAPIClient.getTerminalSessions();
            const existingSessions = sessions.results || sessions;
            
            // Group sessions by terminal name and get the most recent one for each
            const sessionsByTerminal = new Map();
            for (const session of existingSessions) {
                const match = session.name.match(/Terminal (\d+)/);
                if (match) {
                    const terminalId = parseInt(match[1]);
                    const existing = sessionsByTerminal.get(terminalId);
                    
                    // Keep the most recent session (by updated_at timestamp)
                    if (!existing || new Date(session.updated_at) > new Date(existing.updated_at)) {
                        sessionsByTerminal.set(terminalId, session);
                    }
                }
            }
            
            // Map the most recent session for each terminal
            for (const [terminalId, session] of sessionsByTerminal) {
                if (!this.terminalSessionMap.has(terminalId)) {
                    this.terminalSessionMap.set(terminalId, session.id);
                    this.logAction(`Mapped Terminal ${terminalId} to backend session ${session.id}`, 'info');
                }
            }
            
            await this.saveTerminalSessionMapping();
            this.logAction(`Synced ${sessionsByTerminal.size} terminal sessions from backend`, 'info');
        } catch (error) {
            console.error('Failed to sync terminal sessions:', error);
        }
    }
    async forceSyncAllSessions() {
        // Force sync all backend sessions, replacing existing mappings
        if (!this.backendAPIClient) return;
        try {
            const sessions = await this.backendAPIClient.getTerminalSessions();
            const existingSessions = sessions.results || sessions;
            
            // Clear existing mappings
            this.terminalSessionMap.clear();
            
            // Group sessions by terminal name and get the most recent one for each
            const sessionsByTerminal = new Map();
            for (const session of existingSessions) {
                const match = session.name.match(/Terminal (\d+)/);
                if (match) {
                    const terminalId = parseInt(match[1]);
                    const existing = sessionsByTerminal.get(terminalId);
                    
                    // Keep the most recent session (by updated_at timestamp)
                    if (!existing || new Date(session.updated_at) > new Date(existing.updated_at)) {
                        sessionsByTerminal.set(terminalId, session);
                    }
                }
            }
            
            // Map the most recent session for each terminal
            for (const [terminalId, session] of sessionsByTerminal) {
                this.terminalSessionMap.set(terminalId, session.id);
                this.logAction(`Force mapped Terminal ${terminalId} to backend session ${session.id}`, 'info');
            }
            
            await this.saveTerminalSessionMapping();
            this.logAction(`Force synced ${sessionsByTerminal.size} terminal sessions from backend`, 'success');
            
            // Immediately sync messages after remapping
            await this.syncMessagesFromBackend(true);
        } catch (error) {
            console.error('Failed to force sync terminal sessions:', error);
        }
    }
    async checkAndMigrateLocalStorageData() {
        try {
            // Check if localStorage has data
            const localStorageData = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                localStorageData[key] = localStorage.getItem(key);
            }
            // Check if database has any settings
            const dbSettings = await ipcRenderer.invoke('db-get-all-settings');
            // If localStorage has data but database is empty, migrate
            if (Object.keys(localStorageData).length > 0 && Object.keys(dbSettings).length === 0) {
                this.logAction('Migrating data from localStorage to database...', 'info');
                const result = await ipcRenderer.invoke('db-migrate-localstorage', localStorageData);
                if (result.success) {
                    this.logAction('Data migration completed successfully', 'success');
                    // Clear localStorage after successful migration
                    localStorage.clear();
                } else {
                    this.logAction(`Data migration failed: ${result.error}`, 'error');
                }
            }
        } catch (error) {
            console.error('Error during migration check:', error);
        }
    }
    logAction(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = {
            id: Date.now() + Math.random(), // Unique ID for each log entry
            timestamp: timestamp,
            message: message,
            type: type,
            fullTimestamp: new Date().toISOString()
        };
        this.actionLog.push(logEntry);
        // Keep unlimited logs in memory (remove the 100 entry limit)
        // Only limit if memory becomes an issue (e.g., > 10000 entries)
        if (this.actionLog.length > 10000) {
            this.actionLog = this.actionLog.slice(-5000); // Keep last 5000 when cleaning up
        }
        this.updateActionLogDisplay();
    }
    updateActionLogDisplay() {
        if (!this.logDisplaySettings) {
            this.logDisplaySettings = {
                searchTerm: '',
                displayedCount: 50, // Start by showing last 50 entries
                maxDisplayCount: 50,
                isSearching: false
            };
        }
        this.renderLogEntries();
    }
    renderLogEntries() {
        const logContainer = document.getElementById('action-log');
        if (!logContainer) return;
        // Get filtered logs based on search
        const filteredLogs = this.getFilteredLogs();
        // Determine how many entries to show
        const entriesToShow = this.logDisplaySettings.isSearching 
            ? filteredLogs.slice(0, 200) // Show more results when searching
            : filteredLogs.slice(-this.logDisplaySettings.displayedCount); // Show recent entries normally
        // Clear container and render entries
        logContainer.innerHTML = '';
        // Add "Load more" button if there are more entries
        if (!this.logDisplaySettings.isSearching && filteredLogs.length > this.logDisplaySettings.displayedCount) {
            const loadMoreBtn = document.createElement('div');
            loadMoreBtn.className = 'log-load-more';
            loadMoreBtn.innerHTML = `
                <button class="load-more-btn">
                    Load ${Math.min(50, filteredLogs.length - this.logDisplaySettings.displayedCount)} more entries
                    (${filteredLogs.length - this.logDisplaySettings.displayedCount} remaining)
                </button>
            `;
            loadMoreBtn.querySelector('.load-more-btn').addEventListener('click', () => {
                this.logDisplaySettings.displayedCount += 50;
                this.renderLogEntries();
            });
            logContainer.appendChild(loadMoreBtn);
        }
        // Render log entries
        entriesToShow.forEach(entry => {
            const logItem = this.createLogElement(entry);
            logContainer.appendChild(logItem);
        });
        // Auto-scroll to bottom only if not searching and showing recent entries
        if (!this.logDisplaySettings.isSearching) {
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    }
    createLogElement(entry) {
        const logItem = document.createElement('div');
        logItem.className = `log-item log-${entry.type}`;
        logItem.dataset.logId = entry.id;
        const timeElement = document.createElement('span');
        timeElement.className = 'log-time';
        timeElement.textContent = `[${entry.timestamp}]`;
        const messageElement = document.createElement('span');
        messageElement.className = 'log-message';
        // Highlight search terms if searching
        if (this.logDisplaySettings.searchTerm && this.logDisplaySettings.isSearching) {
            messageElement.innerHTML = this.highlightSearchTerm(entry.message, this.logDisplaySettings.searchTerm);
        } else {
            messageElement.textContent = entry.message;
        }
        logItem.appendChild(timeElement);
        logItem.appendChild(messageElement);
        return logItem;
    }
    getFilteredLogs() {
        if (!this.logDisplaySettings.searchTerm || !this.logDisplaySettings.isSearching) {
            return this.actionLog;
        }
        const searchTerm = this.logDisplaySettings.searchTerm.toLowerCase();
        return this.actionLog.filter(entry => 
            entry.message.toLowerCase().includes(searchTerm) ||
            entry.type.toLowerCase().includes(searchTerm) ||
            entry.timestamp.toLowerCase().includes(searchTerm)
        );
    }
    highlightSearchTerm(text, searchTerm) {
        const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return text.replace(regex, '<mark class="search-highlight">$1</mark>');
    }
    clearLogSearch() {
        const logSearchInput = document.getElementById('log-search');
        if (logSearchInput) {
            logSearchInput.value = '';
            this.logDisplaySettings.searchTerm = '';
            this.logDisplaySettings.isSearching = false;
            this.logDisplaySettings.displayedCount = 50;
            this.renderLogEntries();
        }
    }
    clearActionLog() {
        this.actionLog = [];
        // Reset display settings
        if (this.logDisplaySettings) {
            this.logDisplaySettings.displayedCount = 50;
        }
        this.updateActionLogDisplay();
        this.logAction('Action log cleared', 'info');
    }
    // Keyword blocking methods
    addKeywordRule() {
        const keywordInput = document.getElementById('new-keyword');
        const responseInput = document.getElementById('new-response');
        const keyword = keywordInput.value.trim();
        const response = responseInput.value.trim();
        if (!keyword) {
            alert('Please enter a keyword');
            return;
        }
        // Check if keyword already exists
        const exists = this.preferences.keywordRules.some(rule => rule.keyword.toLowerCase() === keyword.toLowerCase());
        if (exists) {
            alert('This keyword already exists');
            return;
        }
        const rule = {
            id: Date.now().toString(),
            keyword: keyword,
            response: response
        };
        this.preferences.keywordRules.push(rule);
        this.saveAllPreferences();
        this.updateKeywordRulesDisplay();
        // Clear inputs
        keywordInput.value = '';
        responseInput.value = '';
        this.logAction(`Added keyword rule: "${keyword}" -> "${response || 'Esc only'}"`, 'info');
    }
    removeKeywordRule(ruleId) {
        const ruleIndex = this.preferences.keywordRules.findIndex(rule => rule.id === ruleId);
        if (ruleIndex !== -1) {
            const removedRule = this.preferences.keywordRules[ruleIndex];
            this.preferences.keywordRules.splice(ruleIndex, 1);
            this.saveAllPreferences();
            this.updateKeywordRulesDisplay();
            this.logAction(`Removed keyword rule: "${removedRule.keyword}"`, 'info');
        }
    }
    updateKeywordRulesDisplay() {
        const rulesList = document.getElementById('keyword-rules-list');
        rulesList.innerHTML = '';
        this.preferences.keywordRules.forEach(rule => {
            const ruleRow = document.createElement('div');
            ruleRow.className = 'keyword-rule-row';
            const keywordDiv = document.createElement('div');
            keywordDiv.className = 'keyword-rule-text';
            keywordDiv.innerHTML = `<span class="keyword-rule-keyword">${rule.keyword}</span>`;
            const responseDiv = document.createElement('div');
            responseDiv.className = 'keyword-rule-text keyword-rule-response';
            responseDiv.textContent = rule.response || '(Esc only)';
            const actionsDiv = document.createElement('div');
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-keyword-btn';
            removeBtn.textContent = 'Remove';
            removeBtn.onclick = () => this.removeKeywordRule(rule.id);
            actionsDiv.appendChild(removeBtn);
            ruleRow.appendChild(keywordDiv);
            ruleRow.appendChild(responseDiv);
            ruleRow.appendChild(actionsDiv);
            rulesList.appendChild(ruleRow);
        });
    }
    checkTerminalForKeywords(terminalOutput) {
        // Only check if we have keyword rules
        if (!this.preferences.keywordRules || this.preferences.keywordRules.length === 0) {
            return { blocked: false };
        }
        // Ensure we have terminal output to check
        if (!terminalOutput || terminalOutput.trim() === '') {
            return { blocked: false };
        }
        // Find the ╭ character which marks the start of the current Claude prompt area
        const claudePromptStart = terminalOutput.lastIndexOf("╭");
        if (claudePromptStart === -1) {
            // Fallback: check the last 1000 characters if no ╭ found
            const fallbackArea = terminalOutput.slice(-1000);
            const hasClaudePrompt = fallbackArea.includes("No, and tell Claude what to do differently");
            if (!hasClaudePrompt) {
                return { blocked: false };
            }
            // Use fallback area for keyword checking
            for (const rule of this.preferences.keywordRules) {
                if (!rule.keyword || rule.keyword.trim() === '') continue;
                const keywordLower = rule.keyword.toLowerCase().trim();
                const fallbackAreaLower = fallbackArea.toLowerCase();
                if (fallbackAreaLower.includes(keywordLower)) {
                    console.log(`Keyword "${rule.keyword}" found in fallback Claude prompt area!`);
                    return {
                        blocked: true,
                        keyword: rule.keyword,
                        response: rule.response || ''
                    };
                }
            }
            return { blocked: false };
        }
        // Extract only the text from ╭ to the end (current prompt area)
        const currentPromptArea = terminalOutput.substring(claudePromptStart);
        // Only proceed if this area contains the Claude prompt
        const hasClaudePrompt = currentPromptArea.includes("No, and tell Claude what to do differently");
        if (!hasClaudePrompt) {
            return { blocked: false };
        }
        // Debug logging
        console.log('Checking keywords in Claude prompt area:', currentPromptArea.substring(0, 200) + '...');
        // Look for keywords only in the current prompt area (from ╭ to end)
        for (const rule of this.preferences.keywordRules) {
            if (!rule.keyword || rule.keyword.trim() === '') continue;
            const keywordLower = rule.keyword.toLowerCase().trim();
            const promptAreaLower = currentPromptArea.toLowerCase();
            if (promptAreaLower.includes(keywordLower)) {
                console.log(`Keyword "${rule.keyword}" found in Claude prompt!`);
                return {
                    blocked: true,
                    keyword: rule.keyword,
                    response: rule.response || ''
                };
            }
        }
        return { blocked: false };
    }
    // Strip ANSI escape codes from text
    stripAnsiCodes(text) {
        if (!text || typeof text !== 'string') {
            return '';
        }
        // Remove ANSI escape sequences
        return text.replace(
            /\u001b\[[0-9;]*[a-zA-Z]|\u001b\][^\u0007]*\u0007|\u001b\][^\u001b]*\u001b\\|\u001b\[[0-9;]*[mGKH]|\u001b\[[0-9;]*[mK]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[[0-9;]*[m]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[[0-9;]*[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]|\u001b\[\d*[A-Za-z]|\u001b\[\d+;\d+[Hf]|\u001b\[\d+[ABCD]|\u001b\[\d+[JK]|\u001b\[\d+[ST]|\u001b\[\d+[~]|\u001b\[\d+[G]|\u001b\[[0-9;]*[mGK]|\u001b\[\d+[mGK]|\u001b\[\d+[mGKH]|\u001b\[\?[0-9;]*[hlc]/g,
            ''
        );
    }
    extractTextBetweenMarkers(text, startMarker, endMarker) {
        // Find the start marker
        const startIndex = text.lastIndexOf(startMarker);
        if (startIndex === -1) {
            return null;
        }
        // Find the end marker
        const endIndex = text.indexOf(endMarker, startIndex);
        if (endIndex === -1) {
            return null;
        }
        // Extract the text between markers
        return text.substring(startIndex, endIndex + endMarker.length);
    }
    filterAlphabeticalLines(text) {
        // Split into lines
        const lines = text.split('\n');
        // Filter lines that contain primarily alphabetical content
        const alphabeticalLines = lines.filter(line => {
            const trimmedLine = line.trim();
            // Skip empty lines
            if (trimmedLine === '') return false;
            // Skip lines that are mostly symbols or numbers without letters
            const letterCount = (trimmedLine.match(/[a-zA-Z]/g) || []).length;
            const totalLength = trimmedLine.length;
            // Keep lines that are at least 30% letters
            return letterCount > 0 && (letterCount / totalLength) >= 0.3;
        });
        return alphabeticalLines.join('\n').trim();
    }
    checkTerminalForPrompts(terminalOutput) {
        // Ensure we have terminal output to check
        if (!terminalOutput || terminalOutput.trim() === '') {
            return { found: false };
        }
        // Use dedicated function to extract text between markers
        const promptArea = this.extractTextBetweenMarkers(terminalOutput, "╭", "╯");
        if (!promptArea) {
            return { found: false };
        }
        // Check if this area contains either trigger phrase
        if (!promptArea.includes("No, keep planning") && !promptArea.includes("No, and tell Claude what to do differently")) {
            return { found: false };
        }
        // Keep the full content including formatting and colors
        // Remove only the markers but preserve everything else
        let promptContent = promptArea.replace(/╭/g, '').replace(/╯/g, '');
        // Clean up leading/trailing whitespace but preserve internal formatting
        promptContent = promptContent.trim();
        // Generate unique ID for the prompt
        const promptId = Date.now().toString() + '_' + Math.random().toString(36).substr(2, 9);
        // Create prompt object
        const prompt = {
            id: promptId,
            content: promptContent,
            timestamp: new Date().toISOString(),
            terminalId: this.activeTerminalId
        };
        console.log('Prompt detected:', prompt);
        return {
            found: true,
            prompt: prompt
        };
    }
    syncPromptCount() {
        // Synchronize promptCount with the actual length of promptRules array
        if (this.preferences.promptRules && Array.isArray(this.preferences.promptRules)) {
            this.promptCount = this.preferences.promptRules.length;
            this.updateStatusDisplay();
            console.log(`Prompt count synchronized: ${this.promptCount} prompts loaded`);
        } else {
            this.promptCount = 0;
            this.updateStatusDisplay();
        }
    }
    checkForPromptDetection() {
        // Check all terminals for prompt detection
        for (const [terminalId, terminalData] of this.terminals) {
            if (!terminalData.lastOutput || terminalData.lastOutput.trim() === '') {
                continue;
            }
            const result = this.checkTerminalForPrompts(terminalData.lastOutput);
            if (result.found) {
                // Check for duplicates using content comparison
                const isDuplicate = this.preferences.promptRules.some(existingPrompt => 
                    existingPrompt.content === result.prompt.content
                );
                if (!isDuplicate) {
                    // Add to preferences
                    this.preferences.promptRules.push(result.prompt);
                    this.saveAllPreferences();
                    // Update counter using sync method to ensure consistency
                    this.syncPromptCount();
                    console.log(`Prompt detected in Terminal ${terminalId} and added to list`);
                    return result;
                }
            }
        }
        return { found: false };
    }
    checkForKeywordBlocking() {
        // Check all terminals for keyword blocking
        for (const [terminalId, terminalData] of this.terminals) {
            if (!terminalData.lastOutput || terminalData.lastOutput.trim() === '') {
                continue;
            }
            const result = this.checkTerminalForKeywords(terminalData.lastOutput);
            if (result.blocked) {
                this.keywordCount++;
                this.updateStatusDisplay();
                console.log(`Keyword "${result.keyword}" detected in Terminal ${terminalId} - BLOCKING injection`);
                return result;
            }
        }
        return { blocked: false };
    }
    startUsageLimitSync() {
        if (!this.usageLimitResetTime || !this.autoSyncEnabled) {
            return;
        }
        // Clear any existing interval
        this.stopUsageLimitSync();
        // Start interval to update every minute
        this.usageLimitSyncInterval = setInterval(() => {
            this.updateSyncedTimer();
        }, 60000); // Update every minute
        // Update immediately
        this.updateSyncedTimer();
        this.logAction('Auto-sync to usage limit enabled - timer will update every minute', 'info');
    }
    stopUsageLimitSync() {
        if (this.usageLimitSyncInterval) {
            clearInterval(this.usageLimitSyncInterval);
            this.usageLimitSyncInterval = null;
        }
    }
    async updateSyncedTimer() {
        if (!this.usageLimitResetTime || !this.autoSyncEnabled) {
            return;
        }
        const now = new Date();
        const timeDiff = this.usageLimitResetTime.getTime() - now.getTime();
        if (timeDiff <= 0) {
            this.logAction('Usage limit reset time reached - sync completed', 'success');
            this.stopUsageLimitSync();
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitResetTime', '');
            return;
        }
        // Calculate hours, minutes, seconds until reset time
        const totalSeconds = Math.max(1, Math.floor(timeDiff / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        // Set the timer and auto-start it with usage limit waiting state
        this.timerHours = hours;
        this.timerMinutes = minutes;
        this.timerSeconds = seconds;
        this.timerExpired = false;
        this.usageLimitWaiting = true;
        this.savePreferences(); // Save usage limit state
        this.injectionManager.onUsageLimitDetected();
        // Start the timer if not already active
        if (!this.timerActive) {
            this.startTimer();
        } else {
            this.updateTimerUI();
        }
    }
    async setUsageLimitResetTime(resetTime) {
        try {
            this.usageLimitResetTime = resetTime;
            // Save to database
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitResetTime', resetTime.getTime().toString());
            // Start sync if auto-sync is enabled
            if (this.autoSyncEnabled) {
                this.startUsageLimitSync();
            }
        } catch (error) {
            console.error('Failed to save usage limit reset time:', error);
        }
    }
    async loadUsageLimitResetTime() {
        try {
            const savedResetTime = await ipcRenderer.invoke('db-get-app-state', 'usageLimitResetTime');
            if (savedResetTime) {
                const resetTime = new Date(parseInt(savedResetTime));
                const now = new Date();
                // Only use if it's in the future
                if (resetTime.getTime() > now.getTime()) {
                    this.usageLimitResetTime = resetTime;
                    this.logAction(`Loaded saved usage limit reset time: ${resetTime.toLocaleTimeString()}`, 'info');
                    // Start auto-sync if enabled
                    if (this.autoSyncEnabled) {
                        this.startUsageLimitSync();
                    }
                } else {
                    // Remove expired reset time
                    await ipcRenderer.invoke('db-set-app-state', 'usageLimitResetTime', '');
                }
            }
        } catch (error) {
            console.error('Failed to load usage limit reset time:', error);
        }
    }
    resetTimer() {
        // Check if we have a saved target datetime
        const savedTargetDateTime = this.preferences.timerTargetDateTime;
        if (savedTargetDateTime) {
            const targetDate = new Date(savedTargetDateTime);
            const now = new Date();
            // If target datetime has passed, don't restore the timer
            if (now >= targetDate) {
                this.logAction(`Timer target time (${targetDate.toLocaleString()}) has already passed - not restoring timer`, 'info');
                // Clear the saved target datetime so it doesn't keep trying to restore
                this.preferences.timerTargetDateTime = null;
                this.preferences.timerHours = 0;
                this.preferences.timerMinutes = 0;
                this.preferences.timerSeconds = 0;
                this.saveAllPreferences();
                // Set timer to 00:00:00
                this.timerActive = false;
                this.timerExpired = true; // Mark as expired since target time passed
                this.injectionInProgress = false;
                this.timerHours = 0;
                this.timerMinutes = 0;
                this.timerSeconds = 0;
                if (this.timerInterval) {
                    clearInterval(this.timerInterval);
                    this.timerInterval = null;
                }
                // Trigger injection manager since timer effectively expired
                this.injectionManager.onTimerExpired();
                this.updateTimerUI();
                return;
            }
        }
        // Restore timer to last saved values from preferences (only if target time hasn't passed)
        const savedHours = this.preferences.timerHours || 0;
        const savedMinutes = this.preferences.timerMinutes || 0;
        const savedSeconds = this.preferences.timerSeconds || 0;
        this.timerActive = false;
        this.timerExpired = false;
        this.injectionInProgress = false;
        this.timerHours = savedHours;
        this.timerMinutes = savedMinutes;
        this.timerSeconds = savedSeconds;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        this.updateTimerUI();
        this.logAction(`Timer reset to saved value: ${String(savedHours).padStart(2, '0')}:${String(savedMinutes).padStart(2, '0')}:${String(savedSeconds).padStart(2, '0')}`, 'info');
    }
    updateTerminalOutput(data) {
        // Add new data to terminal output
        this.lastTerminalOutput += data;
        // Detect if terminal was cleared
        if (data.includes('\x1b[2J') || data.includes('\x1b[H\x1b[2J') || data.includes('\x1b[3J')) {
            // Terminal was cleared, reset the output buffer
            this.lastTerminalOutput = '';
            return;
        }
        // Keep only recent output (last 5000 characters) for safety checks
        if (this.lastTerminalOutput.length > 5000) {
            this.lastTerminalOutput = this.lastTerminalOutput.slice(-5000);
        }
    }
    // Hotkey dropdown functionality
    toggleHotkeyDropdown(event) {
        const dropdown = document.getElementById('hotkey-dropdown');
        const button = document.getElementById('hotkey-btn');
        if (dropdown.classList.contains('show')) {
            this.hideHotkeyDropdown();
        } else {
            this.showHotkeyDropdown(button);
        }
    }
    showHotkeyDropdown(buttonElement) {
        const dropdown = document.getElementById('hotkey-dropdown');
        const rect = buttonElement.getBoundingClientRect();
        // Show dropdown first to get its dimensions
        dropdown.classList.add('show');
        // Get dropdown dimensions after it's visible
        const dropdownRect = dropdown.getBoundingClientRect();
        // Position dropdown so bottom-right corner touches top-left of button
        dropdown.style.left = `${rect.left - dropdownRect.width}px`;
        dropdown.style.top = `${rect.top - dropdownRect.height}px`;
    }
    hideHotkeyDropdown() {
        const dropdown = document.getElementById('hotkey-dropdown');
        dropdown.classList.remove('show');
    }
    insertHotkey(command) {
        const input = document.getElementById('message-input');
        const currentValue = input.value;
        const cursorPos = input.selectionStart;
        // Insert command at cursor position
        const beforeCursor = currentValue.substring(0, cursorPos);
        const afterCursor = currentValue.substring(cursorPos);
        const newValue = beforeCursor + command + afterCursor;
        input.value = newValue;
        input.focus();
        // Set cursor position after inserted command
        const newCursorPos = cursorPos + command.length;
        input.setSelectionRange(newCursorPos, newCursorPos);
        this.logAction(`Inserted hotkey: ${command}`, 'info');
    }
    // Smart waiting system for auto-injection
    waitForStableReadyState(callback) {
        const requiredStableDuration = 5000; // 5 seconds
        const checkInterval = 10; // 10ms
        const maxWaitTime = 60000; // 60 seconds timeout
        let stableStartTime = null;
        let checkCount = 0;
        const startTime = Date.now();
        const checkStatus = () => {
            checkCount++;
            // Check for timeout
            const elapsedTime = Date.now() - startTime;
            if (elapsedTime > maxWaitTime) {
                this.logAction(`waitForStableReadyState TIMEOUT after ${elapsedTime}ms - forcing injection`, 'warning');
                callback();
                return;
            }
            // Check if injection sequence was cancelled entirely
            // Only cancel if injection was explicitly stopped AND we're not in a timer sequence
            if (!this.injectionInProgress && !this.timerExpired && !this.usageLimitWaiting) {
                this.logAction('waitForStableReadyState CANCELLED - injection sequence stopped', 'warning');
                return;
            }
            // Get current terminal status - check all states that should block auto-injection
            const isReady = !this.currentTerminalStatus.isRunning && 
                           !this.currentTerminalStatus.isPrompting && 
                           !this.isInjecting &&
                           this.currentlyInjectingMessages.size === 0 &&
                           !this.injectionPaused &&
                           !this.injectionBlocked;
            if (isReady) {
                // Terminal is ready
                if (stableStartTime === null) {
                    // Just became ready - start timing
                    stableStartTime = Date.now();
                    this.logAction('Terminal became ready - starting 5-second stability timer', 'info');
                } else {
                    // Check if we've been stable long enough
                    const stableDuration = Date.now() - stableStartTime;
                    if (stableDuration >= requiredStableDuration) {
                        this.logAction(`Terminal stable for ${stableDuration}ms - proceeding with injection`, 'success');
                        callback();
                        return;
                    }
                }
                // Log progress every 500ms (50 checks)
                if (checkCount % 50 === 0) {
                    const elapsed = stableStartTime ? Date.now() - stableStartTime : 0;
                }
            } else {
                // Terminal is not ready - reset timer
                if (stableStartTime !== null) {
                    const wasStableFor = Date.now() - stableStartTime;
                    this.logAction(`Terminal no longer ready (was stable for ${wasStableFor}ms) - restarting timer`, 'warning');
                    stableStartTime = null;
                    checkCount = 0; // Reset check count when restarting
                }
            }
            // Continue checking
            setTimeout(checkStatus, checkInterval);
        };
        // Start checking
        checkStatus();
    }
    // Check if a specific terminal is stable and ready for injection
    isTerminalStableAndReady(terminalId) {
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return false;
        // Check if terminal is currently injecting
        const isInjectingToThisTerminal = Array.from(this.currentlyInjectingMessages).some(messageId => {
            const message = this.messageQueue.find(m => m.id === messageId);
            return message && (message.terminalId != null ? message.terminalId : this.activeTerminalId) === terminalId;
        });
        if (isInjectingToThisTerminal) return false;
        // Now we can check all terminals, not just the active one
        // Get the specific terminal's status
        const terminalStatus = this.terminalStatuses.get(terminalId);
        if (!terminalStatus) {
            // Terminal status not yet initialized
            return false;
        }
        // Check if terminal is ready for injection
        const isTerminalReady = !terminalStatus.isRunning && 
                               !terminalStatus.isPrompting && 
                               !this.isInjecting &&
                               !this.injectionPaused &&
                               !this.injectionBlocked;
        if (!isTerminalReady) {
            // Terminal not ready - reset stability timer
            this.terminalStabilityTimers.delete(terminalId);
            return false;
        }
        // Terminal is ready - check stability duration
        const now = Date.now();
        const stableStartTime = this.terminalStabilityTimers.get(terminalId);
        if (!stableStartTime) {
            // Just became ready - start timing
            this.terminalStabilityTimers.set(terminalId, now);
            this.logAction(`Terminal ${terminalId} became ready - starting stability timer`, 'info');
            return false;
        }
        // Check if stable long enough
        const stableDuration = now - stableStartTime;
        
        // Use 30 seconds if last injection was in plan mode, otherwise 5 seconds
        let requiredStableDuration = 5000; // 5 seconds default
        if (this.injectionManager && this.injectionManager.lastPlanModeCompletionTime) {
            const timeSinceLastPlanMode = Date.now() - this.injectionManager.lastPlanModeCompletionTime;
            if (timeSinceLastPlanMode < this.injectionManager.planModeDelay) {
                requiredStableDuration = 30000; // 30 seconds for plan mode
            }
        }
        
        if (stableDuration >= requiredStableDuration) {
            const delayType = requiredStableDuration === 30000 ? '30-second plan mode' : '5-second standard';
            this.logAction(`Terminal ${terminalId} stable for ${stableDuration}ms (${delayType} delay) - ready for injection`, 'success');
            return true;
        }
        return false;
    }
    // Drag and drop functionality
    // Drag and drop functionality
    handleDragStart(e) {
        // Ensure we get the message item element
        const messageItem = e.target.closest('.message-item');
        if (!messageItem) return;
        e.dataTransfer.setData('text/plain', '');
        e.dataTransfer.effectAllowed = 'move';
        this.draggedElement = messageItem;
        this.draggedIndex = parseInt(messageItem.dataset.index);
        this.isDragging = true;
        messageItem.classList.add('dragging');
        // Add active class to message list
        document.getElementById('message-list').classList.add('drag-active');
        // Add drag-mode class to sidebar to expand message queue
        document.querySelector('.sidebar').classList.add('drag-mode');
        console.log('Drag started:', this.draggedIndex);
    }
    handleDragOver(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!this.isDragging) return;
        const target = e.target.closest('.message-item');
        if (target && target !== this.draggedElement) {
            // Remove drag-over class from all items
            document.querySelectorAll('.message-item').forEach(item => {
                item.classList.remove('drag-over');
            });
            target.classList.add('drag-over');
        }
    }
    handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        if (!this.isDragging) return;
        const target = e.target.closest('.message-item');
        if (target && target !== this.draggedElement) {
            const targetIndex = parseInt(target.dataset.index);
            console.log('Dropping at:', targetIndex);
            this.reorderMessage(this.draggedIndex, targetIndex);
        }
        this.cleanupDragState();
    }
    handleDragEnd(e) {
        this.cleanupDragState();
    }
    cleanupDragState() {
        // Remove all drag-related classes
        document.querySelectorAll('.message-item').forEach(item => {
            item.classList.remove('dragging', 'drag-over');
        });
        document.getElementById('message-list').classList.remove('drag-active');
        // Remove drag-mode class from sidebar to restore normal layout
        document.querySelector('.sidebar').classList.remove('drag-mode');
        this.draggedElement = null;
        this.draggedIndex = null;
        this.isDragging = false;
        console.log('Drag state cleaned up');
    }
    reorderMessage(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;
        // Remove the dragged message from its current position
        const [movedMessage] = this.messageQueue.splice(fromIndex, 1);
        // Insert it at the new position
        this.messageQueue.splice(toIndex, 0, movedMessage);
        // Save and update UI
        this.saveMessageQueue();
        this.updateMessageList();
        this.updateStatusDisplay();
        this.logAction(`Reordered message: "${movedMessage.content.substring(0, 30)}..." from position ${fromIndex + 1} to ${toIndex + 1}`, 'info');
    }
    // Sound Effects Methods
    async populateSoundEffects() {
        try {
            // Retry logic to handle race condition with main process startup
            let result;
            let retries = 0;
            const maxRetries = 5;
            while (retries < maxRetries) {
                try {
                    result = await ipcRenderer.invoke('get-sound-effects');
                    break;
                } catch (error) {
                    if (error.message.includes('No handler registered') && retries < maxRetries - 1) {
                        retries++;
                        await new Promise(resolve => setTimeout(resolve, 100 * retries)); // Exponential backoff
                        continue;
                    }
                    throw error;
                }
            }
            // Populate all three sound effect dropdowns
            const soundSelectors = [
                'completion-sound-select',
                'injection-sound-select', 
                'prompted-sound-select'
            ];
            soundSelectors.forEach(selectorId => {
                const select = document.getElementById(selectorId);
                if (!select) return;
                // Store current selection to restore it after populating
                let currentSelection;
                if (selectorId === 'completion-sound-select') {
                    currentSelection = this.preferences.completionSoundFile;
                } else if (selectorId === 'injection-sound-select') {
                    currentSelection = this.preferences.injectionSoundFile;
                } else if (selectorId === 'prompted-sound-select') {
                    currentSelection = this.preferences.promptedSoundFile;
                }
                // Clear existing options
                select.innerHTML = '';
                // Add "None" as default option
                const defaultOption = document.createElement('option');
                defaultOption.value = '';
                defaultOption.textContent = 'None';
                select.appendChild(defaultOption);
                if (result.success && result.files.length > 0) {
                    // Add sound files as options
                    result.files.forEach(file => {
                        const option = document.createElement('option');
                        option.value = file;
                        // Create a friendly display name (remove extension and format)
                        const displayName = file.replace(/\.[^/.]+$/, '') // Remove extension
                            .replace(/[-_]/g, ' ') // Replace hyphens/underscores with spaces
                            .replace(/\b\w/g, l => l.toUpperCase()); // Capitalize words
                        option.textContent = displayName;
                        select.appendChild(option);
                    });
                }
                // Restore the previously selected sound file
                select.value = currentSelection;
            });
            if (result.success && result.files.length > 0) {
                this.logAction(`Loaded ${result.files.length} sound effects`, 'info');
            } else {
                this.logAction('No sound effects found', 'warning');
            }
        } catch (error) {
            console.error('Error populating sound effects:', error);
            this.logAction(`Error loading sound effects: ${error.message}`, 'error');
        }
    }
    updateSoundSettingsVisibility() {
        const soundGroup = document.getElementById('sound-selection-group');
        const soundEffectsCheckbox = document.getElementById('sound-effects-enabled');
        if (!soundEffectsCheckbox) return; // Guard against null element
        const isEnabled = soundEffectsCheckbox.checked;
        if (isEnabled) {
            soundGroup.classList.add('enabled');
        } else {
            soundGroup.classList.remove('enabled');
        }
    }
    testCompletionSound() {
        const soundFile = document.getElementById('completion-sound-select').value;
        if (!soundFile) {
            this.logAction('No sound file selected', 'warning');
            return;
        }
        this.playCompletionSound(soundFile);
        this.logAction(`Testing sound: ${soundFile}`, 'info');
    }
    testInjectionSound() {
        const soundFile = document.getElementById('injection-sound-select').value;
        if (!soundFile) {
            this.logAction('No injection sound file selected', 'warning');
            return;
        }
        this.playInjectionSound(soundFile);
        this.logAction(`Testing injection sound: ${soundFile}`, 'info');
    }
    testPromptedSound() {
        const soundFile = document.getElementById('prompted-sound-select').value;
        if (!soundFile) {
            this.logAction('No prompted sound file selected', 'warning');
            return;
        }
        this.playPromptedSound(soundFile);
        this.logAction(`Testing prompted sound: ${soundFile}`, 'info');
    }
    playSound(filename) {
        if (!filename) {
            return;
        }
        try {
            const audio = new Audio(`./soundeffects/${filename}`);
            audio.volume = 0.5; // Set volume to 50%
            audio.play().catch(error => {
                console.error('Error playing sound:', error);
                this.logAction(`Error playing sound: ${error.message}`, 'error');
            });
        } catch (error) {
            console.error('Error creating audio:', error);
            this.logAction(`Error creating audio: ${error.message}`, 'error');
        }
    }
    playCompletionSound(filename = null) {
        if (!this.preferences.completionSoundEnabled) {
            return;
        }
        const soundFile = filename || this.preferences.completionSoundFile;
        if (!soundFile) {
            return;
        }
        try {
            const audio = new Audio(`./soundeffects/${soundFile}`);
            audio.volume = 0.5; // Set volume to 50%
            audio.play().catch(error => {
                console.error('Error playing completion sound:', error);
                this.logAction(`Error playing completion sound: ${error.message}`, 'error');
            });
        } catch (error) {
            console.error('Error creating completion audio:', error);
            this.logAction(`Error creating completion audio: ${error.message}`, 'error');
        }
    }
    playInjectionSound(filename = null) {
        if (!this.preferences.completionSoundEnabled) {
            return;
        }
        const soundFile = filename || this.preferences.injectionSoundFile;
        if (!soundFile) {
            return;
        }
        try {
            const audio = new Audio(`./soundeffects/${soundFile}`);
            audio.volume = 0.5; // Set volume to 50%
            audio.play().catch(error => {
                console.error('Error playing injection sound:', error);
                this.logAction(`Error playing injection sound: ${error.message}`, 'error');
            });
        } catch (error) {
            console.error('Error creating injection audio:', error);
            this.logAction(`Error creating injection audio: ${error.message}`, 'error');
        }
    }
    async showSystemNotification(title, body, options = {}) {
        if (!this.preferences.showSystemNotifications) {
            return;
        }
        try {
            // Use Electron's notification system for Mac compatibility
            const result = await ipcRenderer.invoke('show-notification', title, body, options);
            if (!result.success) {
                console.error('Failed to show notification:', result.error);
                this.logAction(`Notification error: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('Error showing system notification:', error);
            this.logAction(`Notification error: ${error.message}`, 'error');
        }
    }
    playPromptedSound(filename = null) {
        if (!this.preferences.completionSoundEnabled) {
            return;
        }
        const soundFile = filename || this.preferences.promptedSoundFile;
        if (!soundFile) {
            return;
        }
        try {
            const audio = new Audio(`./soundeffects/${soundFile}`);
            audio.volume = 0.5; // Set volume to 50%
            audio.play().catch(error => {
                console.error('Error playing prompted sound:', error);
                this.logAction(`Error playing prompted sound: ${error.message}`, 'error');
            });
        } catch (error) {
            console.error('Error creating prompted audio:', error);
            this.logAction(`Error creating prompted audio: ${error.message}`, 'error');
        }
    }
    onAutoInjectionComplete() {
        // Play completion sound if enabled
        this.playCompletionSound();
        this.logAction('Auto-injection process completed', 'success');
    }
    
    // Layout management for terminals
    addTerminalToLayout(terminalWrapper, totalCount) {
        const terminalsContainer = document.getElementById('terminals-container');
        
        if (totalCount <= 2) {
            // For 1-2 terminals, add directly to container (single row layout)
            terminalsContainer.appendChild(terminalWrapper);
        } else {
            // For 3+ terminals, use two-row layout
            this.ensureTwoRowLayout();
            
            // Calculate which row to add to (alternating pattern for balance)
            const existingTerminals = terminalsContainer.querySelectorAll('.terminal-wrapper').length;
            const topRow = terminalsContainer.querySelector('.terminals-row:first-child');
            const bottomRow = terminalsContainer.querySelector('.terminals-row:last-child');
            
            // Add to the row with fewer terminals, or alternate if equal
            const topRowCount = topRow.children.length;
            const bottomRowCount = bottomRow.children.length;
            
            if (topRowCount <= bottomRowCount) {
                topRow.appendChild(terminalWrapper);
            } else {
                bottomRow.appendChild(terminalWrapper);
            }
        }
    }
    
    ensureTwoRowLayout() {
        const terminalsContainer = document.getElementById('terminals-container');
        let topRow = terminalsContainer.querySelector('.terminals-row:first-child');
        let bottomRow = terminalsContainer.querySelector('.terminals-row:last-child');
        
        // If no rows exist, create them and move existing terminals
        if (!topRow) {
            // Create two rows
            topRow = document.createElement('div');
            topRow.className = 'terminals-row';
            bottomRow = document.createElement('div');
            bottomRow.className = 'terminals-row';
            
            // Move existing terminal wrappers to rows
            const existingWrappers = Array.from(terminalsContainer.querySelectorAll('.terminal-wrapper'));
            existingWrappers.forEach((wrapper, index) => {
                if (index % 2 === 0) {
                    topRow.appendChild(wrapper);
                } else {
                    bottomRow.appendChild(wrapper);
                }
            });
            
            // Clear container and add rows
            terminalsContainer.innerHTML = '';
            terminalsContainer.appendChild(topRow);
            terminalsContainer.appendChild(bottomRow);
        }
    }
    
    // Multi-terminal management methods
    async addNewTerminal(startDirectory = null) {
        const terminalCount = this.terminals.size;
        this.terminalIdCounter++;
        const newId = this.terminalIdCounter;
        
        // Create new terminal wrapper HTML
        const terminalWrapper = document.createElement('div');
        terminalWrapper.className = 'terminal-wrapper';
        terminalWrapper.setAttribute('data-terminal-id', newId);
        const color = this.terminalColors[(newId - 1) % this.terminalColors.length];
        terminalWrapper.innerHTML = `
            <div class="terminal-header">
                <div class="terminal-title-wrapper">
                    <button class="icon-btn close-terminal-btn" title="Close terminal" data-terminal-id="${newId}" data-test-id="close-terminal-btn">
                        <i data-lucide="x"></i>
                    </button>
                    <span class="terminal-color-dot" style="background-color: ${color};"></span>
                    <span class="terminal-title editable" contenteditable="false">Terminal ${newId}</span>
                    <button class="icon-btn add-terminal-btn" title="Add new terminal" style="display: none;" data-test-id="add-terminal-btn">
                        <i data-lucide="plus"></i>
                    </button>
                </div>
                <span class="terminal-status" data-terminal-status="${newId}"></span>
            </div>
            <div class="terminal-container" data-terminal-container="${newId}"></div>
            <div class="terminal-search-overlay" data-terminal-search="${newId}" style="display: none;">
                <div class="search-bar">
                    <div class="search-input-wrapper">
                        <i class="search-icon" data-lucide="search"></i>
                        <input type="text" class="search-input" placeholder="Search in terminal..." />
                    </div>
                    <div class="search-controls">
                        <button class="search-btn search-prev" title="Previous match">
                            <i data-lucide="chevron-up"></i>
                        </button>
                        <button class="search-btn search-next" title="Next match">
                            <i data-lucide="chevron-down"></i>
                        </button>
                        <span class="search-matches">0/0</span>
                        <button class="search-btn search-close" title="Close search">
                            <i data-lucide="x"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        // Add to container using the new layout management
        this.addTerminalToLayout(terminalWrapper, terminalCount + 1);
        
        // Update layout
        const terminalsContainer = document.getElementById('terminals-container');
        terminalsContainer.setAttribute('data-terminal-count', terminalCount + 1);
        // Create terminal instance
        const terminalData = this.createTerminal(newId);
        // Create backend session if available
        if (this.backendAPIClient) {
            this.backendAPIClient.createTerminalSession(`Terminal ${newId}`, this.currentDirectory)
                .then(async session => {
                    // Store the mapping of frontend terminal ID to backend session UUID
                    this.terminalSessionMap.set(newId, session.id);
                    await this.saveTerminalSessionMapping();
                    this.logAction(`Created backend session for Terminal ${newId}`, 'info');
                })
                .catch(error => {
                    console.error('Failed to create backend terminal session:', error);
                    this.logAction(`Failed to create backend session for Terminal ${newId}`, 'error');
                });
        }
        // Start terminal process
        const directoryToUse = startDirectory || this.currentDirectory;
        ipcRenderer.send('terminal-start', { terminalId: newId, directory: directoryToUse });
        // If we're starting in a specific directory, update recent directories
        if (startDirectory) {
            this.updateRecentDirectories(startDirectory);
        }
        // Update dropdowns
        this.updateTerminalDropdowns();
        this.updateManualTerminalDropdown();
        // Re-initialize Lucide icons for new elements
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
        // Update button visibility
        this.updateTerminalButtonVisibility();
        // Resize all terminals to fit new layout
        setTimeout(() => {
            this.resizeAllTerminals();
        }, 100);
        this.logAction(`Added Terminal ${newId}`, 'info');
        // Save terminal state
        await this.saveTerminalState();
    }
    updateRecentDirectories(directory) {
        if (!directory || directory === '~' || directory === 'Loading...') return;
        // Remove the directory if it already exists in the list
        this.recentDirectories = this.recentDirectories.filter(dir => dir !== directory);
        // Add the directory to the beginning of the list
        this.recentDirectories.unshift(directory);
        // Keep only the most recent directories
        if (this.recentDirectories.length > this.maxRecentDirectories) {
            this.recentDirectories = this.recentDirectories.slice(0, this.maxRecentDirectories);
        }
        // Save to preferences
        this.preferences.recentDirectories = this.recentDirectories;
        this.saveAllPreferences();
    }
    updateTerminalButtonVisibility() {
        const terminalCount = this.terminals.size;
        // Show/hide close buttons (show when more than 1 terminal)
        const closeButtons = document.querySelectorAll('.close-terminal-btn');
        closeButtons.forEach(btn => {
            btn.style.display = terminalCount > 1 ? 'inline-flex' : 'none';
        });
        // Show/hide add buttons (show only on the last terminal)
        const addButtons = document.querySelectorAll('.add-terminal-btn');
        addButtons.forEach(btn => {
            btn.style.display = 'none'; // Hide all first
        });
        // Show add button only on the last terminal
        const terminalWrappers = document.querySelectorAll('.terminal-wrapper');
        if (terminalWrappers.length > 0) {
            const lastWrapper = terminalWrappers[terminalWrappers.length - 1];
            const addBtn = lastWrapper.querySelector('.add-terminal-btn');
            if (addBtn) {
                addBtn.style.display = 'inline-flex';
            }
        }
    }
    async closeTerminal(terminalId) {
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) {
            this.logAction(`Terminal ${terminalId} not found`, 'error');
            return;
        }
        // Can't close the last remaining terminal
        if (this.terminals.size <= 1) {
            this.logAction('Cannot close the last terminal', 'warning');
            return;
        }
        // Mark terminal as closing to prevent exit message
        terminalData.isClosing = true;
        // Remove any messages assigned to this terminal from the queue
        this.messageQueue = this.messageQueue.filter(message => {
            const messageTerminalId = message.terminalId != null ? message.terminalId : this.activeTerminalId;
            return messageTerminalId !== terminalId;
        });
        this.updateMessageList();
        // Clear the terminal before closing
        terminalData.terminal.clear();
        // Notify main process to close terminal process
        ipcRenderer.send('terminal-close', { terminalId });
        // If this was the active terminal, switch to another one BEFORE removing it
        if (terminalId === this.activeTerminalId) {
            const availableIds = Array.from(this.terminals.keys()).filter(id => id !== terminalId);
            if (availableIds.length > 0) {
                this.switchToTerminal(availableIds[0]);
            }
        }
        // Dispose of terminal
        terminalData.terminal.dispose();
        // Remove from terminals map
        this.terminals.delete(terminalId);
        // Remove from terminal session mapping
        this.terminalSessionMap.delete(terminalId);
        await this.saveTerminalSessionMapping();
        
        // Remove DOM element FIRST to ensure clean state
        const terminalWrapper = document.querySelector(`[data-terminal-id="${terminalId}"]`);
        if (terminalWrapper) {
            console.log('Removing terminal wrapper for ID:', terminalId);
            terminalWrapper.remove();
        } else {
            console.warn('Terminal wrapper not found for ID:', terminalId);
        }
        
        // Update container count AFTER removing DOM element
        const terminalsContainer = document.getElementById('terminals-container');
        terminalsContainer.setAttribute('data-terminal-count', this.terminals.size);
        console.log('Updated terminal count to:', this.terminals.size);
        
        // Force a synchronous reflow before layout refresh to ensure DOM changes are applied
        terminalsContainer.offsetHeight;
        
        // Force grid layout reflow by temporarily clearing and rebuilding the container
        this.refreshTerminalLayout();
        // If the closed terminal was selected in manual generation, reset to 'all'
        if (this.todoSystem && this.todoSystem.manualGeneration && 
            this.todoSystem.manualGeneration.selectedTerminalId === terminalId) {
            this.todoSystem.manualGeneration.selectedTerminalId = 'all';
        }
        // Clear terminal state data from sidebar controller
        if (this.sidebarController) {
            this.sidebarController.clearTerminalStateData(terminalId);
        }
        // Update button visibility
        this.updateTerminalButtonVisibility();
        // Update dropdown contents to remove references to closed terminal
        this.updateTerminalDropdowns();
        this.updateManualTerminalDropdown();
        
        // Clean up any orphaned terminal selector items that might be stuck in the DOM
        this.cleanupOrphanedTerminalSelectorItems();
        // Update the manual generation UI to reflect any changes
        if (this.todoSystem && this.todoSystem.manualGeneration) {
            this.updateManualGenerationUI();
        }
        // Resize remaining terminals to fit new layout
        setTimeout(() => {
            this.resizeAllTerminals();
        }, 100);
        this.logAction(`Closed ${terminalData.name}`, 'info');
        // Save terminal state
        await this.saveTerminalState();
    }
    
    refreshTerminalLayout() {
        const terminalsContainer = document.getElementById('terminals-container');
        const currentCount = this.terminals.size;
        
        // Clean up any orphaned terminal wrappers
        const allWrappers = terminalsContainer.querySelectorAll('.terminal-wrapper');
        allWrappers.forEach(wrapper => {
            const terminalId = parseInt(wrapper.getAttribute('data-terminal-id'));
            if (terminalId && !this.terminals.has(terminalId)) {
                console.log('Removing orphaned terminal wrapper:', terminalId);
                wrapper.remove();
            }
        });
        
        // Get remaining valid terminal wrappers
        const validWrappers = Array.from(terminalsContainer.querySelectorAll('.terminal-wrapper'));
        
        if (currentCount <= 2) {
            // For 1-2 terminals, use single row layout
            // Remove any existing row structure
            const rows = terminalsContainer.querySelectorAll('.terminals-row');
            if (rows.length > 0) {
                // Move terminals back to main container
                validWrappers.forEach(wrapper => {
                    terminalsContainer.appendChild(wrapper);
                });
                // Remove row containers
                rows.forEach(row => row.remove());
            }
        } else {
            // For 3+ terminals, ensure two-row layout
            this.reorganizeTerminalsIntoRows(validWrappers);
        }
        
        // Update terminal count attribute
        terminalsContainer.setAttribute('data-terminal-count', currentCount);
        
        // Force a reflow and resize terminals
        terminalsContainer.offsetHeight;
        setTimeout(() => {
            this.resizeAllTerminals();
        }, 50);
    }
    
    reorganizeTerminalsIntoRows(terminalWrappers) {
        const terminalsContainer = document.getElementById('terminals-container');
        
        // Create or get existing rows
        let topRow = terminalsContainer.querySelector('.terminals-row:first-child');
        let bottomRow = terminalsContainer.querySelector('.terminals-row:last-child');
        
        if (!topRow || topRow === bottomRow) {
            // Clear container and create new rows
            terminalsContainer.innerHTML = '';
            topRow = document.createElement('div');
            topRow.className = 'terminals-row';
            bottomRow = document.createElement('div');
            bottomRow.className = 'terminals-row';
            terminalsContainer.appendChild(topRow);
            terminalsContainer.appendChild(bottomRow);
        }
        
        // Redistribute terminals evenly between rows
        terminalWrappers.forEach((wrapper, index) => {
            if (index % 2 === 0) {
                topRow.appendChild(wrapper);
            } else {
                bottomRow.appendChild(wrapper);
            }
        });
    }
    
    toggleTerminalSelectorDropdown() {
        const dropdown = document.getElementById('terminal-selector-dropdown');
        const isVisible = dropdown.style.display !== 'none';
        if (isVisible) {
            this.hideTerminalSelectorDropdown();
        } else {
            this.showTerminalSelectorDropdown();
        }
    }
    showTerminalSelectorDropdown() {
        this.updateTerminalDropdowns();
        const dropdown = document.getElementById('terminal-selector-dropdown');
        dropdown.style.display = 'block';
    }
    hideTerminalSelectorDropdown() {
        const dropdown = document.getElementById('terminal-selector-dropdown');
        dropdown.style.display = 'none';
    }
    showAddTerminalDropdown(button) {
        // Hide any existing dropdown first
        this.hideAddTerminalDropdown();
        // Create dropdown element
        const dropdown = document.createElement('div');
        dropdown.className = 'add-terminal-dropdown';
        dropdown.id = 'add-terminal-dropdown';
        // Build dropdown content
        let dropdownHTML = '<div class="add-terminal-dropdown-header">New Terminal Location</div>';
        // Add default option
        dropdownHTML += `
            <button class="add-terminal-dropdown-item default-option" data-directory="default">
                <i class="directory-icon" data-lucide="home"></i>
                <span class="directory-path">Default Directory</span>
            </button>
        `;
        // Add recent directories
        if (this.recentDirectories.length > 0) {
            this.recentDirectories.forEach(dir => {
                const displayDir = dir.replace(/^\/Users\/[^\/]+/, '~');
                dropdownHTML += `
                    <button class="add-terminal-dropdown-item" data-directory="${dir}">
                        <i class="directory-icon" data-lucide="folder"></i>
                        <span class="directory-path" title="${dir}">${displayDir}</span>
                    </button>
                `;
            });
        }
        dropdown.innerHTML = dropdownHTML;
        // Position dropdown relative to button
        const buttonRect = button.getBoundingClientRect();
        const terminalWrapper = button.closest('.terminal-wrapper');
        terminalWrapper.style.position = 'relative';
        terminalWrapper.appendChild(dropdown);
        // Initialize Lucide icons in dropdown
        if (window.lucide) {
            window.lucide.createIcons();
        }
        // Show dropdown
        dropdown.style.display = 'block';
        // Add click handlers for dropdown items
        dropdown.querySelectorAll('.add-terminal-dropdown-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const directory = item.dataset.directory;
                this.hideAddTerminalDropdown();
                if (directory === 'default') {
                    this.addNewTerminal();
                } else {
                    this.addNewTerminal(directory);
                }
            });
        });
        // Close dropdown when clicking outside
        setTimeout(() => {
            document.addEventListener('click', this.addTerminalDropdownClickOutside = (e) => {
                if (!e.target.closest('.add-terminal-dropdown') && !e.target.closest('.add-terminal-btn')) {
                    this.hideAddTerminalDropdown();
                }
            });
        }, 0);
    }
    hideAddTerminalDropdown() {
        const dropdown = document.getElementById('add-terminal-dropdown');
        if (dropdown) {
            dropdown.remove();
        }
        // Remove click outside listener
        if (this.addTerminalDropdownClickOutside) {
            document.removeEventListener('click', this.addTerminalDropdownClickOutside);
            this.addTerminalDropdownClickOutside = null;
        }
    }
    selectActiveTerminal(terminalId) {
        // Use the main switchToTerminal function for consistency
        this.switchToTerminal(terminalId);
    }
    switchToTerminal(terminalId) {
        console.log('switchToTerminal called with terminalId:', terminalId);
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) {
            this.logAction(`Terminal ${terminalId} not found`, 'error');
            return;
        }
        console.log('Switching to terminal:', terminalData);
        this.activeTerminalId = terminalId;
        // Update legacy references
        this.terminal = terminalData.terminal;
        this.fitAddon = terminalData.fitAddon;
        this.currentDirectory = terminalData.directory;
        // Update UI
        const selectorBtn = document.getElementById('terminal-selector-btn');
        const selectorDot = selectorBtn.querySelector('.terminal-selector-dot');
        const selectorText = selectorBtn.querySelector('.terminal-selector-text');
        console.log('Updating selector button:', selectorBtn, selectorDot, selectorText);
        console.log('Setting color to:', terminalData.color, 'and text to:', terminalData.name);
        if (selectorDot) selectorDot.style.backgroundColor = terminalData.color;
        if (selectorText) selectorText.textContent = terminalData.name;
        // Update dropdown to show new selection
        this.updateTerminalDropdowns();
        this.updateManualTerminalDropdown();
        this.updateStatusDisplay();
        this.saveTerminalState();
        this.logAction(`Selected ${terminalData.name}`, 'info');
    }
    cycleToNextTerminal() {
        const terminalIds = Array.from(this.terminals.keys()).sort((a, b) => a - b);
        if (terminalIds.length <= 1) return;
        const currentIndex = terminalIds.indexOf(this.activeTerminalId);
        const nextIndex = (currentIndex + 1) % terminalIds.length;
        const nextTerminalId = terminalIds[nextIndex];
        this.switchToTerminal(nextTerminalId);
        // Focus the terminal after switching
        const terminalData = this.terminals.get(nextTerminalId);
        if (terminalData && terminalData.terminal) {
            terminalData.terminal.focus();
        }
    }
    cycleToPreviousTerminal() {
        const terminalIds = Array.from(this.terminals.keys()).sort((a, b) => a - b);
        if (terminalIds.length <= 1) return;
        const currentIndex = terminalIds.indexOf(this.activeTerminalId);
        const previousIndex = currentIndex === 0 ? terminalIds.length - 1 : currentIndex - 1;
        const previousTerminalId = terminalIds[previousIndex];
        this.switchToTerminal(previousTerminalId);
        // Focus the terminal after switching
        const terminalData = this.terminals.get(previousTerminalId);
        if (terminalData && terminalData.terminal) {
            terminalData.terminal.focus();
        }
    }
    updateTerminalDropdowns() {
        // Update the terminal selector dropdown
        const dropdown = document.getElementById('terminal-selector-dropdown');
        if (!dropdown) return;
        // Clear existing items
        dropdown.innerHTML = '';
        // Add items for each terminal
        this.terminals.forEach((terminalData, terminalId) => {
            const item = document.createElement('div');
            item.className = 'terminal-selector-item';
            item.dataset.terminalId = terminalId;
            if (terminalId === this.activeTerminalId) {
                item.classList.add('selected');
            }
            item.innerHTML = `
                <span class="terminal-selector-dot" style="background-color: ${terminalData.color};"></span>
                <span class="terminal-selector-text">${terminalData.name}</span>
            `;
            item.addEventListener('click', () => {
                console.log('Dropdown item clicked, switching to terminal:', terminalId);
                this.switchToTerminal(terminalId);
                this.hideTerminalSelectorDropdown();
            });
            dropdown.appendChild(item);
        });
    }
    
    cleanupOrphanedTerminalSelectorItems() {
        // Remove any terminal selector items that exist outside of the main dropdowns
        // This cleans up any stuck or improperly positioned terminal selector items
        const validTerminalIds = Array.from(this.terminals.keys());
        console.log('Cleanup: Valid terminal IDs:', validTerminalIds);
        
        // Look for all terminal selector items (including manual ones)
        const allSelectorItems = document.querySelectorAll('.terminal-selector-item, .manual-terminal-selector-item');
        console.log('Cleanup: Found', allSelectorItems.length, 'terminal selector items');
        
        allSelectorItems.forEach(item => {
            const itemTerminalId = parseInt(item.dataset.terminalId);
            
            // Skip 'all' terminal option in manual selector
            if (item.dataset.terminalId === 'all') {
                return;
            }
            
            // Remove items that refer to terminals that no longer exist
            if (!validTerminalIds.includes(itemTerminalId)) {
                console.log('Removing orphaned terminal selector item for terminal:', itemTerminalId, 'from element:', item.className);
                item.remove();
            }
            
            // Remove items that are not inside a proper dropdown container
            const isInValidDropdown = item.closest('#terminal-selector-dropdown') ||
                                    item.closest('#manual-terminal-selector-dropdown') ||
                                    item.closest('.message-dropdown');
            
            if (!isInValidDropdown) {
                console.log('Removing misplaced terminal selector item for terminal:', itemTerminalId, 'from element:', item.className);
                item.remove();
            }
        });
        
        // Clean up any orphaned manual terminal selector items that might be visible
        const manualSelectorItems = document.querySelectorAll('.manual-terminal-selector-item');
        manualSelectorItems.forEach(item => {
            if (item.dataset.terminalId !== 'all') {
                const itemTerminalId = parseInt(item.dataset.terminalId);
                if (!validTerminalIds.includes(itemTerminalId)) {
                    console.log('Removing orphaned manual terminal selector item for terminal:', itemTerminalId);
                    item.remove();
                }
            }
        });
        
        // Clean up any orphaned terminal wrappers that might still exist in DOM
        const terminalsContainer = document.getElementById('terminals-container');
        const allTerminalWrappers = terminalsContainer.querySelectorAll('.terminal-wrapper');
        allTerminalWrappers.forEach(wrapper => {
            const terminalId = parseInt(wrapper.getAttribute('data-terminal-id'));
            if (terminalId && !validTerminalIds.includes(terminalId)) {
                console.log('Removing orphaned terminal wrapper for terminal:', terminalId);
                wrapper.remove();
            }
        });
        
        // Also clean up any timer dropdowns that might be misidentified as terminal tabs
        const timerDropdowns = document.querySelectorAll('.timer-edit-dropdown');
        timerDropdowns.forEach(dropdown => {
            // Check if the dropdown is positioned at the bottom of the screen incorrectly
            const rect = dropdown.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            
            // If dropdown is stuck at the bottom unexpectedly, remove it
            if (rect.bottom >= viewportHeight - 50 && rect.top >= viewportHeight - 200) {
                console.log('Removing mispositioned timer dropdown');
                dropdown.remove();
            }
        });
        
        // Update the terminal count to ensure consistency
        const finalTerminalCount = terminalsContainer.querySelectorAll('.terminal-wrapper').length;
        terminalsContainer.setAttribute('data-terminal-count', finalTerminalCount);
        
        // Force update both dropdowns after cleanup
        this.updateTerminalDropdowns();
        this.updateManualTerminalDropdown();
    }
    
    getNextTerminalForMessage() {
        // Round-robin assignment across available terminals
        const terminalIds = Array.from(this.terminals.keys()).sort();
        if (terminalIds.length === 0) {
            return this.activeTerminalId || 1;
        }
        if (terminalIds.length === 1) {
            return terminalIds[0];
        }
        // Find next terminal in round-robin fashion
        const currentIndex = terminalIds.indexOf(this.lastAssignedTerminalId);
        const nextIndex = (currentIndex + 1) % terminalIds.length;
        this.lastAssignedTerminalId = terminalIds[nextIndex];
        // Removed debug log for cleaner output
        return this.lastAssignedTerminalId;
    }
    startEditingTerminalTitle(titleElement) {
        // Enable editing
        titleElement.contentEditable = 'true';
        titleElement.focus();
        // Select all text
        const range = document.createRange();
        range.selectNodeContents(titleElement);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        // Save original value
        const originalText = titleElement.textContent;
        const terminalId = parseInt(titleElement.closest('.terminal-wrapper').getAttribute('data-terminal-id'));
        // Handle save on Enter or blur
        const saveTitle = () => {
            titleElement.contentEditable = 'false';
            const newText = titleElement.textContent.trim();
            if (newText && newText !== originalText) {
                const terminalData = this.terminals.get(terminalId);
                if (terminalData) {
                    terminalData.name = newText;
                    this.updateTerminalDropdowns();
                    this.updateManualTerminalDropdown();
                    // Update selector if this is the active terminal
                    if (terminalId === this.activeTerminalId) {
                        document.querySelector('.terminal-selector-text').textContent = newText;
                    }
                    // Update backend session name if available
                    if (this.backendAPIClient) {
                        const backendSessionId = this.terminalSessionMap.get(terminalId);
                        if (backendSessionId) {
                            this.backendAPIClient.updateTerminalSession(backendSessionId, { name: newText })
                                .catch(error => {
                                    console.warn('Failed to update backend session name:', error);
                                });
                        }
                    }
                    // Save terminal state to persist the name change
                    this.saveTerminalState();
                    this.logAction(`Renamed terminal to: ${newText}`, 'info');
                }
            } else if (!newText) {
                titleElement.textContent = originalText;
            }
        };
        // Handle key events
        titleElement.addEventListener('keydown', function handleKey(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveTitle();
                titleElement.removeEventListener('keydown', handleKey);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                titleElement.textContent = originalText;
                titleElement.contentEditable = 'false';
                titleElement.removeEventListener('keydown', handleKey);
            }
        });
        // Handle blur
        titleElement.addEventListener('blur', function handleBlur() {
            saveTitle();
            titleElement.removeEventListener('blur', handleBlur);
        }, { once: true });
    }
    showMessageTerminalDropdown(messageItem, optionsBtn) {
        // Remove any existing dropdown
        const existingDropdown = document.querySelector('.message-terminal-dropdown');
        if (existingDropdown) {
            existingDropdown.remove();
        }
        // Create dropdown
        const dropdown = document.createElement('div');
        dropdown.className = 'message-terminal-dropdown';
        const messageId = parseInt(messageItem.getAttribute('data-message-id'));
        const message = this.messageQueue.find(m => m.id === messageId);
        const currentTerminalId = message ? message.terminalId || 1 : 1;
        this.terminals.forEach((terminalData) => {
            const item = document.createElement('div');
            item.className = 'terminal-selector-item';
            if (terminalData.id === currentTerminalId) {
                item.classList.add('selected');
            }
            item.innerHTML = `
                <span class="terminal-selector-dot" style="background-color: ${terminalData.color};"></span>
                <span>${terminalData.name}</span>
            `;
            item.addEventListener('click', () => {
                this.updateMessageTerminal(messageId, terminalData.id);
                dropdown.remove();
            });
            dropdown.appendChild(item);
        });
        // Add Plan Mode option styled like terminals
        const messagePlanState = message ? message.wrapWithPlan : undefined;
        const currentPlanState = messagePlanState !== undefined ? messagePlanState : this.planModeEnabled;
        const planModeItem = document.createElement('div');
        planModeItem.className = 'terminal-selector-item plan-mode';
        if (currentPlanState) {
            planModeItem.classList.add('selected');
        }
        planModeItem.innerHTML = `
            <span class="plan-mode-icon">
                <i data-lucide="clipboard"></i>
            </span>
            <span>Plan mode</span>
        `;
        planModeItem.addEventListener('click', () => {
            this.toggleMessagePlanMode(messageId);
            // Small delay to ensure state is saved before removing dropdown
            setTimeout(() => {
                dropdown.remove();
            }, 10);
        });
        dropdown.appendChild(planModeItem);
        // Initialize Lucide icons for the clipboard icon
        setTimeout(() => {
            if (typeof lucide !== 'undefined') {
                lucide.createIcons();
            }
        }, 0);
        // Position dropdown
        const btnRect = optionsBtn.getBoundingClientRect();
        const messageRect = messageItem.getBoundingClientRect();
        dropdown.style.position = 'absolute';
        dropdown.style.top = (btnRect.bottom - messageRect.top) + 'px';
        dropdown.style.right = '8px';
        messageItem.style.position = 'relative';
        messageItem.appendChild(dropdown);
        // Close on outside click
        setTimeout(() => {
            document.addEventListener('click', function closeDropdown(e) {
                if (!dropdown.contains(e.target) && e.target !== optionsBtn) {
                    dropdown.remove();
                    document.removeEventListener('click', closeDropdown);
                }
            });
        }, 0);
    }
    updateMessageTerminal(messageId, terminalId) {
        const message = this.messageQueue.find(m => m.id === messageId);
        if (!message) return;
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return;
        message.terminalId = terminalId;
        // Update message border color
        const messageItem = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageItem) {
            messageItem.style.setProperty('--terminal-color', terminalData.color);
            messageItem.setAttribute('data-terminal-color', terminalData.color);
        }
        this.logAction(`Updated message to inject into ${terminalData.name}`, 'info');
    }
    togglePlanMode() {
        this.planModeEnabled = !this.planModeEnabled;
        this.preferences.planModeEnabled = this.planModeEnabled;
        this.saveAllPreferences();
        this.updatePlanModeButtonState();
        if (this.planModeEnabled) {
            this.logAction('Plan mode enabled - messages will be wrapped with claude-flow command', 'info');
        } else {
            this.logAction('Plan mode disabled', 'info');
        }
    }
    toggleMessagePlanMode(messageId) {
        const message = this.messageQueue.find(m => m.id === messageId);
        if (!message) return;
        // Cycle through: undefined (auto) -> true (on) -> false (off) -> undefined (auto)
        if (message.wrapWithPlan === undefined) {
            message.wrapWithPlan = true;
            this.logAction('Message plan mode enabled', 'info');
        } else if (message.wrapWithPlan === true) {
            message.wrapWithPlan = false;
            this.logAction('Message plan mode disabled', 'info');
        } else {
            message.wrapWithPlan = undefined;
            this.logAction('Message plan mode set to auto (follow global setting)', 'info');
        }
        // Save the updated message queue and update the UI
        this.saveMessageQueue();
        this.updateMessageList();
    }
    closeAllModals() {
        // Close settings modal
        const settingsModal = document.getElementById('settings-modal');
        if (settingsModal && settingsModal.classList.contains('show')) {
            settingsModal.classList.remove('show');
        }
        // Close message history modal
        const historyModal = document.getElementById('message-history-modal');
        if (historyModal && historyModal.classList.contains('show')) {
            historyModal.classList.remove('show');
        }
        // Close usage limit modal
        const usageModal = document.getElementById('usage-limit-modal');
        if (usageModal && usageModal.style.display === 'block') {
            usageModal.style.display = 'none';
        }
        // Close terminal selector dropdown
        const terminalDropdown = document.getElementById('terminal-selector-dropdown');
        if (terminalDropdown) {
            terminalDropdown.style.display = 'none';
        }
        // Close hotkey dropdown
        const hotkeyDropdown = document.getElementById('hotkey-dropdown');
        if (hotkeyDropdown) {
            hotkeyDropdown.style.display = 'none';
        }
    }
    clearQueueWithConfirmation() {
        if (this.messageQueue.length === 0) {
            this.logAction('Queue is already empty', 'info');
            return;
        }
        const confirmed = confirm(`Are you sure you want to clear ${this.messageQueue.length} message(s) from the queue?`);
        if (confirmed) {
            this.clearQueue();
            this.logAction('Queue cleared (Cmd+Shift+.)', 'info');
        }
    }
    focusSearchInput() {
        const searchInput = document.getElementById('log-search');
        if (searchInput) {
            searchInput.focus();
            searchInput.select();
        }
    }
    focusTerminalSelector() {
        const selectorBtn = document.getElementById('terminal-selector-btn');
        const dropdown = document.getElementById('terminal-selector-dropdown');
        if (selectorBtn && dropdown) {
            // Show dropdown
            dropdown.style.display = 'block';
            // Focus the first item or selected item
            const selectedItem = dropdown.querySelector('.selected') || dropdown.querySelector('.terminal-selector-item');
            if (selectedItem) {
                selectedItem.focus();
                this.setupTerminalSelectorKeyboard(dropdown);
            }
        }
    }
    setupTerminalSelectorKeyboard(dropdown) {
        const items = dropdown.querySelectorAll('.terminal-selector-item');
        let selectedIndex = Array.from(items).findIndex(item => item.classList.contains('selected'));
        const keyHandler = (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedIndex = (selectedIndex + 1) % items.length;
                this.highlightTerminalItem(items, selectedIndex);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedIndex = selectedIndex <= 0 ? items.length - 1 : selectedIndex - 1;
                this.highlightTerminalItem(items, selectedIndex);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const terminalId = parseInt(items[selectedIndex].dataset.terminalId);
                this.switchToTerminal(terminalId);
                dropdown.style.display = 'none';
                document.removeEventListener('keydown', keyHandler);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                dropdown.style.display = 'none';
                document.removeEventListener('keydown', keyHandler);
            }
        };
        document.addEventListener('keydown', keyHandler);
    }
    highlightTerminalItem(items, index) {
        items.forEach((item, i) => {
            item.classList.toggle('highlighted', i === index);
        });
    }
    focusTimerEdit() {
        const editBtn = document.getElementById('timer-edit-btn');
        if (editBtn && editBtn.style.display !== 'none') {
            // Create a synthetic event with the timer edit button as target
            const syntheticEvent = {
                target: editBtn,
                preventDefault: () => {}
            };
            this.openTimerEditDropdown(syntheticEvent);
            // Focus on seconds input
            setTimeout(() => {
                const secondsInput = document.querySelector('.timer-segment-input[data-segment="seconds"]');
                if (secondsInput) {
                    secondsInput.focus();
                    secondsInput.select();
                    this.setupSmartTimerInput();
                }
            }, 100);
        }
    }
    setupSmartTimerInput() {
        const secondsInput = document.querySelector('.timer-edit-seconds input');
        const minutesInput = document.querySelector('.timer-edit-minutes input');
        const hoursInput = document.querySelector('.timer-edit-hours input');
        if (secondsInput) {
            secondsInput.addEventListener('input', (e) => {
                const value = parseInt(e.target.value) || 0;
                if (value >= 60) {
                    const minutes = Math.floor(value / 60);
                    const remainingSeconds = value % 60;
                    e.target.value = remainingSeconds;
                    if (minutesInput) {
                        const currentMinutes = parseInt(minutesInput.value) || 0;
                        minutesInput.value = currentMinutes + minutes;
                        minutesInput.focus();
                        minutesInput.select();
                    }
                }
            });
        }
        if (minutesInput) {
            minutesInput.addEventListener('input', (e) => {
                const value = parseInt(e.target.value) || 0;
                if (value >= 60) {
                    const hours = Math.floor(value / 60);
                    const remainingMinutes = value % 60;
                    e.target.value = remainingMinutes;
                    if (hoursInput) {
                        const currentHours = parseInt(hoursInput.value) || 0;
                        hoursInput.value = currentHours + hours;
                        hoursInput.focus();
                        hoursInput.select();
                    }
                }
            });
        }
    }
    // ===============================
    // TODO SYSTEM METHODS
    // ===============================
    async initializeTodoSystem() {
        // Restore saved view state from backend or default to action-log
        let savedView = 'action-log';
        try {
            const settings = await ipcRenderer.invoke('db-get-settings');
            savedView = settings.sidebarView || 'action-log';
        } catch (error) {
            console.warn('Failed to restore sidebar view from backend:', error);
        }
        this.todoSystem = {
            currentView: savedView,
            todos: [],
            terminalStateMonitors: new Map(),
            dotWaitStartTime: null,
            isWaitingForCompletion: false,
            manualGeneration: {
                selectedTerminalId: this.activeTerminalId,
                selectedMode: 'verify',
                customPrompt: '',
                isGenerating: false
            }
        };
        this.setupTodoEventListeners();
        // Note: Automatic todo generation now uses the existing scanSingleTerminalStatus logic
        // Apply the saved view state after DOM is ready
        setTimeout(async () => {
            try {
                await this.switchSidebarView(savedView);
            } catch (error) {
                console.warn('Failed to switch sidebar view:', error);
                // Fallback to action-log if there's an error
                await this.switchSidebarView('action-log');
            }
        }, 100);
    }
    setupTodoEventListeners() {
        // Navigation buttons
        const actionLogNavBtn = document.getElementById('action-log-nav-btn');
        const todoNavBtn = document.getElementById('todo-nav-btn');
        if (actionLogNavBtn) {
            actionLogNavBtn.addEventListener('click', async () => await this.switchSidebarView('action-log'));
        }
        if (todoNavBtn) {
            todoNavBtn.addEventListener('click', async () => await this.switchSidebarView('todo'));
        }
        // Footer buttons
        const clearTodosBtn = document.getElementById('clear-todos-btn');
        if (clearTodosBtn) {
            clearTodosBtn.addEventListener('click', () => this.clearCompletedTodos());
        }
        const clearAllTodosBtn = document.getElementById('clear-all-todos-btn');
        if (clearAllTodosBtn) {
            clearAllTodosBtn.addEventListener('click', () => this.clearAllTodos());
        }
        // Todo search
        const todoSearch = document.getElementById('todo-search');
        if (todoSearch) {
            todoSearch.addEventListener('input', (e) => this.filterTodos(e.target.value));
        }
        // Manual generation controls
        this.setupManualGenerationControls();
        const todoSearchClearBtn = document.getElementById('todo-search-clear-btn');
        if (todoSearchClearBtn) {
            todoSearchClearBtn.addEventListener('click', () => {
                todoSearch.value = '';
                this.filterTodos('');
            });
        }
    }
    setupManualGenerationControls() {
        // Manual terminal selector
        const manualTerminalSelectorBtn = document.getElementById('manual-terminal-selector-btn');
        const manualTerminalSelectorDropdown = document.getElementById('manual-terminal-selector-dropdown');
        if (manualTerminalSelectorBtn) {
            manualTerminalSelectorBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleManualTerminalSelector();
            });
        }
        // Manual mode selector
        const manualModeSelectorBtn = document.getElementById('manual-mode-selector-btn');
        const manualModeSelectorDropdown = document.getElementById('manual-mode-selector-dropdown');
        if (manualModeSelectorBtn) {
            manualModeSelectorBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleManualModeSelector();
            });
        }
        // Manual generate button
        const manualGenerateBtn = document.getElementById('manual-generate-btn');
        if (manualGenerateBtn) {
            manualGenerateBtn.addEventListener('click', () => this.handleManualGeneration());
        }
        // Custom prompt input
        const customPromptInput = document.getElementById('custom-prompt-input');
        if (customPromptInput) {
            customPromptInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.todoSystem.manualGeneration.customPrompt = customPromptInput.value;
                    this.saveCustomPrompt();
                    document.getElementById('custom-prompt-section').style.display = 'none';
                }
            });
            customPromptInput.addEventListener('input', (e) => {
                this.todoSystem.manualGeneration.customPrompt = e.target.value;
            });
        }
        // Setup dropdown click handlers
        if (manualTerminalSelectorDropdown) {
            manualTerminalSelectorDropdown.addEventListener('click', (e) => {
                if (e.target.classList.contains('manual-terminal-selector-item')) {
                    this.selectManualTerminal(e.target);
                }
            });
        }
        if (manualModeSelectorDropdown) {
            manualModeSelectorDropdown.addEventListener('click', (e) => {
                if (e.target.classList.contains('manual-mode-option')) {
                    this.selectManualMode(e.target);
                }
            });
        }
        // Close dropdowns when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.manual-generation-selector') && manualTerminalSelectorDropdown) {
                manualTerminalSelectorDropdown.style.display = 'none';
            }
            if (!e.target.closest('.manual-generation-mode') && manualModeSelectorDropdown) {
                manualModeSelectorDropdown.style.display = 'none';
            }
        });
        // Initialize the UI
        this.updateManualGenerationUI();
        this.loadCustomPrompt();
    }
    async switchSidebarView(view) {
        const actionLogView = document.getElementById('action-log-view');
        const todoView = document.getElementById('todo-view');
        const actionLogNavBtn = document.getElementById('action-log-nav-btn');
        const todoNavBtn = document.getElementById('todo-nav-btn');
        const sidebarTitle = document.getElementById('sidebar-title');
        if (view === 'action-log') {
            actionLogView.style.display = 'flex';
            todoView.style.display = 'none';
            actionLogNavBtn.classList.add('active');
            todoNavBtn.classList.remove('active');
            sidebarTitle.textContent = 'Action Log';
            this.todoSystem.currentView = 'action-log';
            // Save the current view state to backend
            try {
                await ipcRenderer.invoke('db-save-setting', 'sidebarView', 'action-log');
            } catch (error) {
                console.warn('Failed to save sidebar view to backend:', error);
            }
        } else if (view === 'todo') {
            actionLogView.style.display = 'none';
            todoView.style.display = 'flex';
            actionLogNavBtn.classList.remove('active');
            todoNavBtn.classList.add('active');
            sidebarTitle.textContent = 'To-Do';
            this.todoSystem.currentView = 'todo';
            // Save the current view state to backend
            try {
                await ipcRenderer.invoke('db-save-setting', 'sidebarView', 'todo');
            } catch (error) {
                console.warn('Failed to save sidebar view to backend:', error);
            }
            this.loadTodos();
        }
    }
    startTerminalStateMonitoring() {
        // Monitor all terminals for completion state
        setInterval(() => {
            this.checkTerminalStatesForCompletion();
        }, 1000); // Check every second
    }
    checkTerminalStatesForCompletion() {
        for (const [terminalId, terminal] of this.terminals) {
            if (!terminal.element) continue;
            // Look for the terminal status indicator using the correct selector from setTerminalStatusDisplay
            const terminalStatusElement = document.querySelector(`[data-terminal-status="${terminalId}"]`);
            const isThinking = terminalStatusElement && terminalStatusElement.textContent.includes('...');
            const isRunning = terminalStatusElement && (
                terminalStatusElement.textContent.includes('Running') || 
                terminalStatusElement.className.includes('running')
            );
            // Enhanced debug logging (increase frequency temporarily to debug)
            if (Math.random() < 0.05) { // 5% chance to log for debugging
                console.log(`[DEBUG] Terminal ${terminalId}:`, {
                    hasStatusElement: !!terminalStatusElement,
                    statusText: terminalStatusElement?.textContent?.substring(0, 100),
                    isThinking,
                    isRunning,
                    elementTagName: terminalStatusElement?.tagName,
                    elementClass: terminalStatusElement?.className
                });
            }
            // Check if terminal is in any busy state (thinking "..." or running)
            const isBusy = isThinking || isRunning;
            if (isBusy) {
                // Terminal is busy - start or update monitoring
                if (!this.todoSystem.terminalStateMonitors.has(terminalId)) {
                    this.todoSystem.terminalStateMonitors.set(terminalId, {
                        busyStartTime: Date.now(),
                        wasInBusyState: true,
                        wasRunning: isRunning // Track if we've seen the "running" state
                    });
                    this.logAction(`Terminal ${terminalId} entered busy state`, 'info');
                } else {
                    // Update the running state if we see it, and reset idle timer if terminal goes back to busy
                    const monitor = this.todoSystem.terminalStateMonitors.get(terminalId);
                    if (isRunning && !monitor.wasRunning) {
                        monitor.wasRunning = true;
                    }
                    // Reset idle timer if terminal goes back to busy after being idle
                    if (monitor.idleStartTime) {
                        delete monitor.idleStartTime;
                        this.logAction(`Terminal ${terminalId} became busy again, resetting idle timer`, 'info');
                    }
                    this.todoSystem.terminalStateMonitors.set(terminalId, monitor);
                }
            } else {
                // Terminal is now idle - check if we should generate todos
                const monitor = this.todoSystem.terminalStateMonitors.get(terminalId);
                if (monitor && monitor.wasInBusyState && monitor.wasRunning) {
                    // Terminal went through the full cycle: ... -> running -> idle
                    const busyDuration = Date.now() - monitor.busyStartTime;
                    if (busyDuration >= 3000) { // Minimum 3 seconds of activity
                        // Set idle start time if not already set
                        if (!monitor.idleStartTime) {
                            monitor.idleStartTime = Date.now();
                            this.todoSystem.terminalStateMonitors.set(terminalId, monitor);
                            this.logAction(`Terminal ${terminalId} became idle, waiting for stability...`, 'info');
                        } else {
                            // Check if idle for long enough (4 seconds)
                            const idleDuration = Date.now() - monitor.idleStartTime;
                            if (idleDuration >= 4000) { // 4 seconds of idle time
                                this.logAction(`Terminal ${terminalId} completed work (${Math.round(busyDuration/1000)}s active, ${Math.round(idleDuration/1000)}s idle)`, 'success');
                                // Note: Automatic todo generation now handled by 3-minute delay mechanism
                                this.todoSystem.terminalStateMonitors.delete(terminalId);
                            }
                        }
                    } else {
                        // If terminal wasn't busy long enough, just clean up
                        this.todoSystem.terminalStateMonitors.delete(terminalId);
                    }
                }
            }
        }
    }
    handleTerminalStateChangeForTodos(terminalId, oldStatus, newStatus) {
        // Only proceed if automatic todo generation is enabled
        if (!this.preferences.automaticTodoGeneration) {
            return;
        }
        // Initialize stability tracking for this terminal if not exists
        if (!this.terminalStabilityTracking.has(terminalId)) {
            this.terminalStabilityTracking.set(terminalId, {
                stableStartTime: null,
                lastGeneration: null,
                stabilityTimer: null
            });
        }
        const stability = this.terminalStabilityTracking.get(terminalId);
        // Check if terminal status shows '...' (idle/ready state)
        const terminalStatusElement = document.querySelector(`[data-terminal-status="${terminalId}"]`);
        const hasDotsStatus = terminalStatusElement && terminalStatusElement.textContent.includes('...');
        if (hasDotsStatus && (oldStatus === 'running' || oldStatus === 'prompting')) {
            // Terminal transitioned to '...' status, start 3-second stability check
            stability.stableStartTime = Date.now();
            this.logAction(`Terminal ${terminalId} shows '...' status, starting 3-second stability check`, 'info');
            // Clear any existing timer
            if (stability.stabilityTimer) {
                clearTimeout(stability.stabilityTimer);
            }
            // Start 3-second stability monitoring
            stability.stabilityTimer = setTimeout(() => {
                this.checkTerminalStabilityForGeneration(terminalId);
            }, 3000);
        } else if (!hasDotsStatus && (newStatus === 'running' || newStatus === 'prompting')) {
            // Terminal is no longer in '...' state, cancel any pending generation
            if (stability.stabilityTimer) {
                clearTimeout(stability.stabilityTimer);
                stability.stabilityTimer = null;
            }
            stability.stableStartTime = null;
            this.logAction(`Terminal ${terminalId} no longer shows '...' status, canceling todo generation`, 'info');
        }
    }
    checkTerminalStabilityForGeneration(terminalId) {
        const stability = this.terminalStabilityTracking.get(terminalId);
        if (!stability) return;
        // Get current terminal status element to check for '...' status
        const terminalStatusElement = document.querySelector(`[data-terminal-status="${terminalId}"]`);
        const hasDotsStatus = terminalStatusElement && terminalStatusElement.textContent.includes('...');
        if (!hasDotsStatus) {
            // Terminal doesn't have '...' status, reset and restart monitoring
            this.logAction(`Terminal ${terminalId} doesn't have '...' status, restarting stability tracking`, 'info');
            stability.stableStartTime = Date.now();
            // Clear existing timer and restart
            if (stability.stabilityTimer) {
                clearTimeout(stability.stabilityTimer);
            }
            stability.stabilityTimer = setTimeout(() => {
                this.checkTerminalStabilityForGeneration(terminalId);
            }, 3000); // Check again in 3 seconds
            return;
        }
        // Terminal has '...' status, check if it's been consistent for 3 seconds
        const now = Date.now();
        const timeSinceStable = stability.stableStartTime ? now - stability.stableStartTime : 0;
        if (timeSinceStable >= 3000) {
            // Terminal has been stable with '...' for 3 seconds, generate todos
            this.logAction(`Terminal ${terminalId} has been stable with '...' for 3 seconds, generating todos`, 'info');
            this.manualGenerateTodos();
            // Update last generation time and cleanup
            stability.lastGeneration = now;
            stability.stableStartTime = null;
            stability.stabilityTimer = null;
        } else {
            // Not stable long enough yet, check again in 1 second
            if (stability.stabilityTimer) {
                clearTimeout(stability.stabilityTimer);
            }
            stability.stabilityTimer = setTimeout(() => {
                this.checkTerminalStabilityForGeneration(terminalId);
            }, 1000); // Check again in 1 second
        }
    }
    async generateTodosViaBackend(terminalId, terminalOutput) {
        try {
            // Get the session ID for this specific terminal
            let sessionId = this.terminalSessionMap.get(terminalId);
            // If no session ID found, create one
            if (!sessionId) {
                sessionId = await this.createBackendSession(terminalId);
            }
            console.log('[DEBUG] Generating todos:', {
                terminalId,
                sessionId,
                outputLength: terminalOutput.length,
                outputPreview: terminalOutput.substring(0, 200)
            });
            const response = await fetch('http://127.0.0.1:8001/api/todos/items/generate_from_output/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    terminal_session: sessionId,
                    terminal_output: terminalOutput,
                    terminal_id: terminalId
                })
            });
            console.log('[DEBUG] Response status:', response.status);
            if (!response.ok) {
                const responseText = await response.text();
                console.error('[DEBUG] Error response:', responseText);
                throw new Error(`HTTP ${response.status}: ${responseText.substring(0, 200)}`);
            }
            const result = await response.json();
            console.log('[DEBUG] Success response:', result);
            return result;
        } catch (error) {
            console.error('[DEBUG] Todo generation error:', error);
            return { success: false, error: error.message };
        }
    }
    async createBackendSession(terminalId) {
        try {
            const response = await fetch('http://127.0.0.1:8001/api/terminal/sessions/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: `Terminal ${terminalId}`,
                    current_directory: process.cwd()
                })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const session = await response.json();
            // Store the mapping
            this.terminalSessionMap.set(terminalId, session.id);
            await this.saveTerminalSessionMapping();
            return session.id;
        } catch (error) {
            throw new Error(`Failed to create backend session: ${error.message}`);
        }
    }
    async manualGenerateTodos() {
        try {
            const activeTerminal = this.terminals.get(this.activeTerminalId);
            if (!activeTerminal || !activeTerminal.element) {
                this.logAction('No active terminal for todo generation', 'error');
                return;
            }
            // Get clean text content from the terminal buffer, not the DOM
            const terminalOutput = this.getCleanTerminalOutput(activeTerminal.terminal);
            this.logAction(`Manually generating todos from Terminal ${this.activeTerminalId}`, 'info');
            const result = await this.generateTodosViaBackend(this.activeTerminalId, terminalOutput);
            if (result.success) {
                this.logAction(`Generated ${result.todos_created} todo items`, 'success');
                this.refreshTodos();
            } else {
                this.logAction(`Manual todo generation failed: ${result.error}`, 'error');
            }
        } catch (error) {
            this.logAction(`Error in manual todo generation: ${error.message}`, 'error');
        }
    }
    toggleManualTerminalSelector() {
        const dropdown = document.getElementById('manual-terminal-selector-dropdown');
        const modeDropdown = document.getElementById('manual-mode-selector-dropdown');
        const isVisible = dropdown.style.display === 'block';
        if (isVisible) {
            dropdown.style.display = 'none';
        } else {
            // Close mode dropdown if open
            if (modeDropdown) {
                modeDropdown.style.display = 'none';
            }
            this.updateManualTerminalDropdown();
            dropdown.style.display = 'block';
        }
    }
    toggleManualModeSelector() {
        const dropdown = document.getElementById('manual-mode-selector-dropdown');
        const terminalDropdown = document.getElementById('manual-terminal-selector-dropdown');
        const isVisible = dropdown.style.display === 'block';
        if (isVisible) {
            dropdown.style.display = 'none';
        } else {
            // Close terminal dropdown if open
            if (terminalDropdown) {
                terminalDropdown.style.display = 'none';
            }
            this.updateManualModeDropdown();
            dropdown.style.display = 'block';
        }
    }
    updateManualTerminalDropdown() {
        const dropdown = document.getElementById('manual-terminal-selector-dropdown');
        if (!dropdown) return;
        // Guard against accessing todoSystem before it's initialized
        if (!this.todoSystem || !this.todoSystem.manualGeneration) return;
        // Clear existing items
        dropdown.innerHTML = '';
        // Add "All terminals" option first
        const allTerminalsItem = document.createElement('div');
        allTerminalsItem.className = 'manual-terminal-selector-item';
        allTerminalsItem.dataset.terminalId = 'all';
        if (this.todoSystem.manualGeneration.selectedTerminalId === 'all') {
            allTerminalsItem.classList.add('selected');
        }
        allTerminalsItem.innerHTML = `
            <span class="manual-terminal-selector-dot" style="background-color: #888888;"></span>
            <span class="manual-terminal-selector-text">All terminals</span>
        `;
        dropdown.appendChild(allTerminalsItem);
        // Add items for each terminal (using the same logic as updateTerminalDropdowns)
        this.terminals.forEach((terminalData, terminalId) => {
            const item = document.createElement('div');
            item.className = 'manual-terminal-selector-item';
            item.dataset.terminalId = terminalId;
            if (this.todoSystem.manualGeneration.selectedTerminalId === terminalId) {
                item.classList.add('selected');
            }
            item.innerHTML = `
                <span class="manual-terminal-selector-dot" style="background-color: ${terminalData.color};"></span>
                <span class="manual-terminal-selector-text">${terminalData.name}</span>
            `;
            dropdown.appendChild(item);
        });
    }
    updateManualModeDropdown() {
        const dropdown = document.getElementById('manual-mode-selector-dropdown');
        if (!dropdown) return;
        // Clear existing selected classes
        dropdown.querySelectorAll('.manual-mode-option').forEach(option => {
            option.classList.remove('selected');
        });
        // Add selected class to current mode
        const currentModeOption = dropdown.querySelector(`[data-mode="${this.todoSystem.manualGeneration.selectedMode}"]`);
        if (currentModeOption) {
            currentModeOption.classList.add('selected');
        }
    }
    selectManualTerminal(item) {
        const terminalId = item.dataset.terminalId;
        this.todoSystem.manualGeneration.selectedTerminalId = terminalId === 'all' ? 'all' : parseInt(terminalId);
        // Update UI
        this.updateManualGenerationUI();
        // Hide dropdown
        document.getElementById('manual-terminal-selector-dropdown').style.display = 'none';
    }
    selectManualMode(item) {
        const mode = item.dataset.mode;
        this.todoSystem.manualGeneration.selectedMode = mode;
        // Show/hide custom prompt section
        const customPromptSection = document.getElementById('custom-prompt-section');
        if (mode === 'custom') {
            customPromptSection.style.display = 'block';
            // Focus on the input if it exists
            const customPromptInput = document.getElementById('custom-prompt-input');
            if (customPromptInput) {
                customPromptInput.value = this.todoSystem.manualGeneration.customPrompt;
                customPromptInput.focus();
            }
        } else {
            customPromptSection.style.display = 'none';
        }
        // Update UI
        this.updateManualGenerationUI();
        // Hide dropdown
        document.getElementById('manual-mode-selector-dropdown').style.display = 'none';
    }
    updateManualGenerationUI() {
        // Update terminal selector button
        const terminalSelectorBtn = document.getElementById('manual-terminal-selector-btn');
        const terminalSelectorDot = terminalSelectorBtn?.querySelector('.manual-terminal-selector-dot');
        const terminalSelectorText = terminalSelectorBtn?.querySelector('.manual-terminal-selector-text');
        if (terminalSelectorBtn && terminalSelectorDot && terminalSelectorText) {
            if (this.todoSystem.manualGeneration.selectedTerminalId === 'all') {
                terminalSelectorDot.style.backgroundColor = '#888888';
                terminalSelectorText.textContent = 'All terminals';
            } else {
                const terminalData = this.terminals.get(this.todoSystem.manualGeneration.selectedTerminalId);
                if (terminalData) {
                    terminalSelectorDot.style.backgroundColor = terminalData.color;
                    terminalSelectorText.textContent = terminalData.name;
                }
            }
        }
        // Update mode selector button
        const modeSelectorBtn = document.getElementById('manual-mode-selector-btn');
        const modeSelectorText = modeSelectorBtn?.querySelector('.manual-mode-selector-text');
        if (modeSelectorText) {
            const mode = this.todoSystem.manualGeneration.selectedMode;
            modeSelectorText.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
        }
    }
    async handleManualGeneration() {
        if (this.todoSystem.manualGeneration.isGenerating) {
            return;
        }
        this.todoSystem.manualGeneration.isGenerating = true;
        this.setManualGenerationLoading(true);
        try {
            const selectedTerminalId = this.todoSystem.manualGeneration.selectedTerminalId;
            const mode = this.todoSystem.manualGeneration.selectedMode;
            if (selectedTerminalId === 'all') {
                await this.generateTodosForAllTerminals(mode);
            } else {
                await this.generateTodosForTerminal(selectedTerminalId, mode);
            }
        } catch (error) {
            this.logAction(`Error in manual generation: ${error.message}`, 'error');
        } finally {
            this.todoSystem.manualGeneration.isGenerating = false;
            this.setManualGenerationLoading(false);
        }
    }
    async generateTodosForAllTerminals(mode) {
        let totalGenerated = 0;
        for (const [terminalId, terminalData] of this.terminals) {
            if (terminalData.element && terminalData.terminal) {
                try {
                    const result = await this.generateTodosForTerminal(terminalId, mode);
                    if (result.success) {
                        totalGenerated += result.todos_created;
                    }
                } catch (error) {
                    this.logAction(`Error generating todos for Terminal ${terminalId}: ${error.message}`, 'error');
                }
            }
        }
        this.logAction(`Generated ${totalGenerated} todo items from all terminals`, 'success');
        this.refreshTodos();
    }
    async generateTodosForTerminal(terminalId, mode) {
        const terminal = this.terminals.get(terminalId);
        if (!terminal || !terminal.element) {
            this.logAction(`Terminal ${terminalId} not found or inactive`, 'error');
            return { success: false, error: 'Terminal not found' };
        }
        // Get clean text content from the terminal buffer
        const terminalOutput = this.getCleanTerminalOutput(terminal.terminal);
        this.logAction(`Generating todos from Terminal ${terminalId} (${mode} mode)`, 'info');
        const result = await this.generateTodosViaBackendWithMode(terminalId, terminalOutput, mode);
        if (result.success) {
            this.logAction(`Generated ${result.todos_created} todo items from Terminal ${terminalId}`, 'success');
        } else {
            this.logAction(`Todo generation failed for Terminal ${terminalId}: ${result.error}`, 'error');
        }
        return result;
    }
    setManualGenerationLoading(isLoading) {
        const generateBtn = document.getElementById('manual-generate-btn');
        if (!generateBtn) return;
        const icon = generateBtn.querySelector('i');
        if (isLoading) {
            generateBtn.classList.add('loading');
            generateBtn.disabled = true;
            if (icon) {
                icon.setAttribute('data-lucide', 'loader');
                // Force immediate icon update
                if (typeof lucide !== 'undefined') {
                    lucide.createIcons();
                }
            }
            this.logAction('Manual todo generation started...', 'info');
        } else {
            generateBtn.classList.remove('loading');
            generateBtn.disabled = false;
            if (icon) {
                icon.setAttribute('data-lucide', 'sparkles');
                // Force immediate icon update
                if (typeof lucide !== 'undefined') {
                    lucide.createIcons();
                }
            }
            this.logAction('Manual todo generation completed', 'success');
        }
    }
    async generateTodosViaBackendWithMode(terminalId, terminalOutput, mode) {
        try {
            // Get the session ID for this specific terminal
            let sessionId = this.terminalSessionMap.get(terminalId);
            // If no session ID found, create one
            if (!sessionId) {
                sessionId = await this.createBackendSession(terminalId);
            }
            // Prepare the request body based on mode
            const requestBody = {
                terminal_session: sessionId,
                terminal_output: terminalOutput,
                mode: mode
            };
            // Add custom prompt if mode is custom
            if (mode === 'custom') {
                requestBody.custom_prompt = this.todoSystem.manualGeneration.customPrompt;
            }
            const response = await fetch('http://127.0.0.1:8001/api/todos/items/generate_from_output/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = await response.json();
            return result;
        } catch (error) {
            throw new Error(`Failed to generate todos via backend: ${error.message}`);
        }
    }
    async saveCustomPrompt() {
        try {
            const response = await fetch('http://127.0.0.1:8001/api/settings/custom_prompt/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    prompt: this.todoSystem.manualGeneration.customPrompt
                })
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch (error) {
            console.warn('Failed to save custom prompt:', error);
        }
    }
    async loadCustomPrompt() {
        try {
            const response = await fetch('http://127.0.0.1:8001/api/settings/custom_prompt/');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this.todoSystem.manualGeneration.customPrompt = data.prompt || '';
            // Update the input if it exists
            const customPromptInput = document.getElementById('custom-prompt-input');
            if (customPromptInput) {
                customPromptInput.value = this.todoSystem.manualGeneration.customPrompt;
            }
        } catch (error) {
            console.warn('Failed to load custom prompt:', error);
        }
    }
    async loadTodos() {
        try {
            const response = await fetch('http://127.0.0.1:8001/api/todos/items/');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this.todoSystem.todos = data.results || data;
            this.renderTodos();
        } catch (error) {
            this.logAction(`Error loading todos: ${error.message}`, 'error');
        }
    }
    renderTodos() {
        const todoList = document.getElementById('todo-list');
        const clearTodosBtn = document.getElementById('clear-todos-btn');
        if (!todoList) return;
        if (this.todoSystem.todos.length === 0) {
            todoList.innerHTML = `
                <div class="todo-item">
                    <div class="todo-text">
                        <span class="todo-time">[empty]</span>
                        <span class="todo-message">No todos yet. Generate some from terminal output!</span>
                    </div>
                </div>
            `;
            // Hide Clear Completed button when no todos
            if (clearTodosBtn) clearTodosBtn.style.display = 'none';
            return;
        }
        todoList.innerHTML = this.todoSystem.todos.map(todo => {
            const terminalNumber = todo.terminal_id || this.getTerminalNumberFromSession(todo.terminal_session);
            return `
                <div class="todo-item ${todo.completed ? 'completed' : ''}" data-todo-id="${todo.id}" data-terminal="${terminalNumber}" onclick="window.terminalGUI.toggleTodo('${todo.id}')" style="cursor: pointer;">
                    <div class="todo-checkbox-wrapper">
                        <input type="checkbox" class="todo-checkbox" 
                               data-terminal="${terminalNumber}" 
                               ${todo.completed ? 'checked' : ''}
                               onchange="window.terminalGUI.toggleTodo('${todo.id}')"
                               onclick="event.stopPropagation();">
                    </div>
                    <div class="todo-text">
                        <span class="todo-message">${this.escapeHtml(todo.title)}</span>
                        ${todo.description ? `<div class="todo-description">${this.escapeHtml(todo.description)}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('');
        // Show/hide Clear Completed button based on whether there are completed todos
        const hasCompletedTodos = this.todoSystem.todos.some(todo => todo.completed);
        if (clearTodosBtn) {
            clearTodosBtn.style.display = hasCompletedTodos ? 'flex' : 'none';
        }
    }
    getTerminalNumberFromSession(sessionId) {
        // Find the terminal ID that maps to this session UUID
        for (const [terminalId, mappedSessionId] of this.terminalSessionMap.entries()) {
            if (mappedSessionId === sessionId) {
                return terminalId;
            }
        }
        // If no mapping found, return active terminal ID as fallback
        return this.activeTerminalId || 1;
    }
    getCleanTerminalOutput(terminal) {
        try {
            // Use xterm.js buffer API to get clean text content
            const buffer = terminal.buffer.active;
            const lines = [];
            // Get the last 200 lines to ensure we capture enough content
            const startLine = Math.max(0, buffer.length - 200);
            for (let i = startLine; i < buffer.length; i++) {
                const line = buffer.getLine(i);
                if (line) {
                    lines.push(line.translateToString(true)); // true = trim right whitespace
                }
            }
            const fullOutput = lines.join('\n').trim();
            // Extract last 1000 characters before '╭' character (Claude prompt indicator)
            return this.extractRelevantOutput(fullOutput);
        } catch (error) {
            console.warn('Failed to get clean terminal output, falling back to textContent:', error);
            // Fallback: try to get text from the terminal viewport
            const viewport = terminal.element?.querySelector('.xterm-screen');
            const fallbackOutput = viewport?.textContent || '';
            return this.extractRelevantOutput(fallbackOutput);
        }
    }
    extractRelevantOutput(terminalOutput) {
        // Find the last occurrence of '╭' (Claude prompt indicator)
        const lastPromptStart = terminalOutput.lastIndexOf('╭');
        if (lastPromptStart === -1) {
            // No prompt found, use the last 1000 characters
            return terminalOutput.length > 1000 ? terminalOutput.slice(-1000) : terminalOutput;
        }
        // Extract content before the prompt
        const contentBeforePrompt = terminalOutput.substring(0, lastPromptStart);
        // Get the last 1000 characters before the prompt
        return contentBeforePrompt.length > 1000 ? 
            contentBeforePrompt.slice(-1000) : 
            contentBeforePrompt;
    }
    async toggleTodo(todoId) {
        try {
            const response = await fetch(`http://127.0.0.1:8001/api/todos/items/${todoId}/toggle_completed/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const updatedTodo = await response.json();
            // Update local todos array
            const todoIndex = this.todoSystem.todos.findIndex(t => t.id === todoId);
            if (todoIndex !== -1) {
                this.todoSystem.todos[todoIndex] = updatedTodo;
                this.renderTodos();
            }
            this.logAction(`Todo "${updatedTodo.title.substring(0, 30)}..." ${updatedTodo.completed ? 'completed' : 'reopened'}`, 'info');
        } catch (error) {
            this.logAction(`Error toggling todo: ${error.message}`, 'error');
        }
    }
    async clearCompletedTodos() {
        try {
            // Check if backend is available
            if (!this.backendAPIClient || !(await this.backendAPIClient.isBackendAvailable())) {
                this.logAction('Backend not available for clearing todos', 'error');
                return;
            }
            // Get current terminal session ID
            let terminalSessionId = this.backendAPIClient.currentSessionId;
            console.log('[DEBUG] Current session ID:', terminalSessionId);
            if (!terminalSessionId) {
                // Try to create a session if none exists
                this.logAction('No session found, creating one...', 'info');
                try {
                    terminalSessionId = await this.createBackendSession(this.activeTerminalId);
                    console.log('[DEBUG] Created session ID:', terminalSessionId);
                } catch (sessionError) {
                    this.logAction(`Failed to create session: ${sessionError.message}`, 'error');
                    return;
                }
            }
            // For now, clear all completed todos regardless of session to handle legacy todos
            const result = await this.backendAPIClient.clearCompletedTodos(null);
            this.logAction(`Cleared ${result.deleted_count} completed todos`, 'success');
            this.refreshTodos();
        } catch (error) {
            this.logAction(`Error clearing completed todos: ${error.message}`, 'error');
        }
    }
    async clearAllTodos() {
        try {
            // Show confirmation dialog
            const confirmation = confirm('Are you sure you want to clear all todos? This action cannot be undone.');
            if (!confirmation) return;
            // Check if backend is available
            if (!this.backendAPIClient || !(await this.backendAPIClient.isBackendAvailable())) {
                this.logAction('Backend not available for clearing todos', 'error');
                return;
            }
            // Clear all todos using the API client method
            const result = await this.backendAPIClient.clearAllTodos();
            this.logAction(`Cleared all ${result.deleted_count} todos`, 'success');
            this.refreshTodos();
        } catch (error) {
            this.logAction(`Error clearing all todos: ${error.message}`, 'error');
        }
    }
    refreshTodos() {
        if (this.todoSystem.currentView === 'todo') {
            this.loadTodos();
        }
    }
    filterTodos(searchTerm) {
        const todoItems = document.querySelectorAll('.todo-item');
        const lowercaseSearch = searchTerm.toLowerCase();
        todoItems.forEach(item => {
            const title = item.querySelector('.todo-message')?.textContent || '';
            const description = item.querySelector('.todo-description')?.textContent || '';
            const matches = title.toLowerCase().includes(lowercaseSearch) || 
                          description.toLowerCase().includes(lowercaseSearch);
            item.style.display = matches ? 'flex' : 'none';
        });
    }
    
    // Terminal error handling and data queuing
    handleTerminalError(terminalId, error) {
        console.error(`Terminal ${terminalId} error:`, error);
        this.logAction(`Terminal ${terminalId} error: ${error.message}`, 'error');
        
        // Try to reinitialize the terminal after a short delay
        setTimeout(() => {
            const terminalData = this.terminals.get(terminalId);
            if (terminalData && !terminalData.terminal) {
                console.log(`Attempting to reinitialize terminal ${terminalId}`);
                this.reinitializeTerminal(terminalId);
            }
        }, 1000);
    }
    
    queueTerminalData(terminalId, data) {
        if (!this.pendingTerminalData.has(terminalId)) {
            this.pendingTerminalData.set(terminalId, []);
        }
        this.pendingTerminalData.get(terminalId).push(data);
        
        // Limit queue size to prevent memory issues
        const queue = this.pendingTerminalData.get(terminalId);
        if (queue.length > 100) {
            queue.splice(0, queue.length - 100);
        }
        
        console.log(`Queued data for terminal ${terminalId}, queue size: ${queue.length}`);
    }
    
    processPendingTerminalData(terminalId) {
        const queue = this.pendingTerminalData.get(terminalId);
        if (!queue || queue.length === 0) return;
        
        console.log(`Processing ${queue.length} pending data items for terminal ${terminalId}`);
        const terminalData = this.terminals.get(terminalId);
        
        if (terminalData && terminalData.terminal) {
            while (queue.length > 0) {
                const data = queue.shift();
                try {
                    terminalData.terminal.write(data.content);
                    terminalData.lastOutput = data.content;
                    this.detectAutoContinuePrompt(data.content, terminalId);
                    this.detectUsageLimit(data.content, terminalId);
                    this.detectCwdChange(data.content, terminalId);
                } catch (error) {
                    console.error('Error processing pending terminal data:', error);
                    break;
                }
            }
        }
    }
    
    reinitializeTerminal(terminalId) {
        const terminalContainer = document.querySelector(`[data-terminal-container="${terminalId}"]`);
        if (!terminalContainer) {
            console.error(`Terminal container not found for ID: ${terminalId}`);
            return;
        }
        
        // Clear existing terminal if it exists
        const existingTerminalData = this.terminals.get(terminalId);
        if (existingTerminalData && existingTerminalData.terminal) {
            existingTerminalData.terminal.dispose();
        }
        
        // Recreate the terminal
        this.createTerminal(terminalId);
        
        // Process any pending data
        this.processPendingTerminalData(terminalId);
    }
    
    setupTerminalEventHandlers(id, terminal, terminalData) {
        const terminalContainer = terminalData.element;
        if (!terminalContainer) {
            console.error('Terminal container not available for event handlers');
            return;
        }
        
        // Handle terminal input
        terminal.onData((data) => {
            ipcRenderer.send('terminal-input', { terminalId: id, data });
        });
        
        // Handle scroll events for autoscroll
        setTimeout(() => {
            const terminalViewport = terminalContainer.querySelector('.xterm-viewport');
            if (terminalViewport) {
                terminalViewport.addEventListener('scroll', () => {
                    this.handleScroll(id);
                });
            }
        }, 100);
        
        // Add click handler to focus terminal when clicked
        terminalContainer.addEventListener('click', () => {
            console.log('Terminal container clicked, focusing terminal:', id);
            terminal.focus();
            this.switchToTerminal(id);
        });
        
        // Handle terminal resize
        terminal.onResize(({ cols, rows }) => {
            ipcRenderer.send('terminal-resize', { terminalId: id, cols, rows });
        });
    }
    
    setupTerminalProcess(id, terminal, terminalData) {
        // If this is the first terminal, set legacy references and start terminal process
        if (id === 1) {
            this.terminal = terminal;
            this.fitAddon = terminalData.fitAddon;
            // Load saved directory
            const savedDirectory = this.preferences.currentDirectory;
            console.log('Starting terminal with saved directory:', savedDirectory);
            if (savedDirectory) {
                this.currentDirectory = savedDirectory;
                terminalData.directory = savedDirectory;
                this.logAction(`Starting terminal in saved directory: ${savedDirectory}`, 'info');
            } else {
                this.logAction('Starting terminal in default directory', 'info');
            }
            // Start terminal process
            console.log('Sending terminal-start IPC message...');
            ipcRenderer.send('terminal-start', { terminalId: id, directory: savedDirectory });
            // Get initial directory from main process if none saved
            if (!savedDirectory) {
                console.log('Requesting current working directory...');
                ipcRenderer.send('get-cwd', { terminalId: id });
            }
            // Create backend session if API client is available
            if (this.backendAPIClient) {
                this.createBackendSession(id).catch(error => {
                    console.warn('Failed to create backend session for terminal', id, ':', error);
                });
            }
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    try {
        window.terminalGUI = new TerminalGUI();
        // Add initial log message after app is fully initialized
        setTimeout(() => {
            window.terminalGUI.logAction('Application ready - all systems operational', 'success');
        }, 500);
    } catch (error) {
        console.error('Error creating TerminalGUI:', error);
    }
});
