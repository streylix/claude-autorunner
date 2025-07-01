const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');

class TerminalGUI {
    constructor() {
        // Multi-terminal support
        this.terminals = new Map(); // Map of terminal ID to terminal data
        this.activeTerminalId = 1;
        this.terminalIdCounter = 1;
        this.terminalColors = ['#007acc', '#28ca42', '#ff5f57', '#ffbe2e', '#af52de', '#5ac8fa'];
        
        // Legacy single terminal references (will be updated to use active terminal)
        this.terminal = null;
        this.fitAddon = null;
        
        this.messageQueue = [];
        this.injectionTimer = null;
        this.schedulingInProgress = false; // Prevent concurrent scheduling calls
        this.injectionCount = 0;
        this.currentlyInjectingMessages = new Set(); // Track messages being injected per terminal
        this.currentlyInjectingTerminals = new Set(); // Track which terminals are currently injecting
        this.terminalStabilityTimers = new Map(); // Track per-terminal stability start times
        this.lastAssignedTerminalId = 0; // For round-robin terminal assignment
        this.currentDirectory = null; // Will be set when terminal starts or directory is detected
        this.isInjecting = false;
        this.messageIdCounter = 1;
        this.messageSequenceCounter = 0;
        this.autoContinueEnabled = false;
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
            // Add timer persistence
            timerHours: 0,
            timerMinutes: 0,
            timerSeconds: 0,
            // Add message queue persistence
            messageQueue: [],
            // Add directory persistence
            currentDirectory: null,
            // Add sound effects preferences
            completionSoundEnabled: false,
            completionSoundFile: 'completion_beep.wav',
            // Add message history
            messageHistory: [],
            // Background service preferences
            keepScreenAwake: true,
            showSystemNotifications: true,
            minimizeToTray: true,
            startMinimized: false
        };
        this.usageLimitSyncInterval = null;
        this.usageLimitResetTime = null;
        this.autoSyncEnabled = true; // Auto-sync until user manually changes timer
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
        this.pausedMessageContent = null;
        this.pausedMessageIndex = 0;
        this.currentTypeInterval = null;
        this.usageLimitModalShowing = false;
        this.usageLimitWaiting = false;
        
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
        
        // Terminal idle tracking for completion sound
        this.terminalIdleTimer = null;
        this.terminalIdleStartTime = null;
        
        // Message history tracking
        this.messageHistory = [];
        
        // Background service state
        this.powerSaveBlockerActive = false;
        this.backgroundServiceActive = false;
        
        // Add global console error protection to prevent EIO crashes
        this.setupConsoleErrorProtection();
        
        // Initialize the application asynchronously
        this.initialize();
    }

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
    }

    async initialize() {
        try {
            // Load preferences FIRST so we have saved directory before starting terminal
            await this.loadAllPreferences();
            
            this.initializeTerminal();
            this.setupEventListeners();
            
            this.initializeLucideIcons();
            this.updateStatusDisplay();
            this.setTerminalStatusDisplay(''); // Initialize with default status
            this.updateTimerUI(); // Initialize timer UI after loading preferences
            
            // Setup background service functionality
            this.setupTrayEventListeners();
            this.updateTrayBadge();
            
            console.log('App initialization completed successfully');
        } catch (error) {
            console.error('Error during app initialization:', error);
        }
        this.startTerminalStatusScanning(); // Start the continuous terminal scanning
    }

    initializeLucideIcons() {
        // Initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }

    initializeTerminal() {
        // Initialize first terminal
        this.createTerminal(1);
        
        // Set container to single terminal mode
        const terminalsContainer = document.getElementById('terminals-container');
        terminalsContainer.setAttribute('data-terminal-count', '1');
        
        // Update button visibility for initial state
        this.updateTerminalButtonVisibility();
        
        // Initialize terminal dropdown
        this.updateTerminalDropdowns();
        
        // Handle window resize for all terminals
        window.addEventListener('resize', () => {
            this.resizeAllTerminals();
        });
    }
    
    createTerminal(id) {
        const color = this.terminalColors[(id - 1) % this.terminalColors.length];
        
        // Create terminal instance
        const terminal = new Terminal({
            theme: this.getTerminalTheme(),
            fontFamily: 'Monaco, Menlo, Consolas, monospace',
            fontSize: 13,
            lineHeight: 1.2,
            cursorBlink: true,
            cursorStyle: 'block',
            scrollback: 1000,
            tabStopWidth: 4
        });

        // Add addons
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(new WebLinksAddon());

        // Store terminal data
        const terminalData = {
            id,
            terminal,
            fitAddon,
            color,
            name: `Terminal ${id}`,
            directory: this.preferences.currentDirectory || null,
            lastOutput: '',
            status: ''
        };
        
        this.terminals.set(id, terminalData);
        
        // Initialize status tracking for this terminal
        this.terminalStatuses.set(id, {
            isRunning: false,
            isPrompting: false,
            lastUpdate: Date.now()
        });
        
        // Open terminal in container
        const terminalContainer = document.querySelector(`[data-terminal-container="${id}"]`);
        if (terminalContainer) {
            terminal.open(terminalContainer);
            
            // Fit terminal to container
            setTimeout(() => {
                fitAddon.fit();
            }, 10);
            
            // Handle terminal input
            terminal.onData((data) => {
                ipcRenderer.send('terminal-input', { terminalId: id, data });
            });

            // Handle scroll events for autoscroll
            setTimeout(() => {
                const terminalViewport = terminalContainer.querySelector('.xterm-viewport');
                if (terminalViewport) {
                    terminalViewport.addEventListener('scroll', () => {
                        if (id === this.activeTerminalId) {
                            this.handleScroll();
                        }
                    });
                }
            }, 100);

            // Handle terminal resize
            terminal.onResize(({ cols, rows }) => {
                ipcRenderer.send('terminal-resize', { terminalId: id, cols, rows });
            });
        }
        
        // If this is the first terminal, set legacy references and start terminal process
        if (id === 1) {
            this.terminal = terminal;
            this.fitAddon = fitAddon;
            
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

    setupEventListeners() {
        // IPC listeners for terminal data (updated for multi-terminal)
        ipcRenderer.on('terminal-data', async (event, data) => {
            const terminalId = data.terminalId != null ? data.terminalId : 1;
            const terminalData = this.terminals.get(terminalId);
            
            if (terminalData) {
                terminalData.terminal.write(data.content);
                terminalData.lastOutput = data.content;
                
                // Update active terminal references
                if (terminalId === this.activeTerminalId) {
                    this.terminal = terminalData.terminal;
                    this.updateTerminalOutput(data.content);
                    this.detectAutoContinuePrompt(data.content);
                    await this.detectUsageLimit(data.content);
                    this.handleTerminalOutput();
                }
            }
        });

        ipcRenderer.on('terminal-exit', (event, data) => {
            const terminalId = data.terminalId != null ? data.terminalId : 1;
            const terminalData = this.terminals.get(terminalId);
            
            if (terminalData) {
                terminalData.terminal.write('\r\n\x1b[31mTerminal process exited\x1b[0m\r\n');
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
        document.getElementById('send-btn').addEventListener('click', () => {
            this.addMessageToQueue();
        });

        // Handle Enter key in message input
        const messageInput = document.getElementById('message-input');
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.addMessageToQueue();
            }
        });
        
        // Global keyboard shortcut for manual injection (Ctrl+Shift+I)
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key === 'I') {
                e.preventDefault();
                try {
                    this.manualInjectNextMessage();
                    this.logAction('Manual injection triggered via keyboard shortcut (Ctrl+Shift+I)', 'info');
                } catch (error) {
                    this.logAction(`Keyboard shortcut injection error: ${error.message}`, 'error');
                }
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
        
        // Consolidated click event listener for all terminal-related interactions
        document.addEventListener('click', (e) => {
            // Handle close terminal button (highest priority)
            if (e.target.closest('.close-terminal-btn')) {
                e.preventDefault();
                e.stopPropagation();
                const terminalWrapper = e.target.closest('.terminal-wrapper');
                if (terminalWrapper) {
                    const terminalId = parseInt(terminalWrapper.getAttribute('data-terminal-id'));
                    this.closeTerminal(terminalId);
                }
                return; // Stop processing other clicks
            }
            
            // Handle add terminal button
            if (e.target.closest('.add-terminal-btn')) {
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

        // Auto-continue checkbox listener
        document.getElementById('auto-continue').addEventListener('change', (e) => {
            this.autoContinueEnabled = e.target.checked;
            this.preferences.autoContinueEnabled = e.target.checked;
            this.saveAllPreferences();
            if (this.autoContinueEnabled) {
                this.logAction('Auto-continue enabled - will respond to prompts', 'info');
            } else {
                this.logAction('Auto-continue disabled', 'info');
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
        document.getElementById('settings-btn').addEventListener('click', () => {
            this.openSettingsModal();
        });


        document.getElementById('settings-close').addEventListener('click', () => {
            this.closeSettingsModal();
        });

        document.getElementById('settings-modal').addEventListener('click', (e) => {
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

        // Settings controls
        document.getElementById('autoscroll-enabled').addEventListener('change', (e) => {
            this.autoscrollEnabled = e.target.checked;
            this.preferences.autoscrollEnabled = e.target.checked;
            this.saveAllPreferences();
        });

        document.getElementById('autoscroll-delay').addEventListener('change', (e) => {
            this.autoscrollDelay = parseInt(e.target.value);
            this.preferences.autoscrollDelay = parseInt(e.target.value);
            this.saveAllPreferences();
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
        document.getElementById('completion-sound-enabled').addEventListener('change', (e) => {
            this.preferences.completionSoundEnabled = e.target.checked;
            this.saveAllPreferences();
            this.updateSoundSettingsVisibility();
            this.logAction(`Completion sound ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
        });

        document.getElementById('completion-sound-select').addEventListener('change', (e) => {
            this.preferences.completionSoundFile = e.target.value;
            this.saveAllPreferences();
            this.logAction(`Completion sound changed to: ${e.target.value || 'None'}`, 'info');
        });

        document.getElementById('test-sound-btn').addEventListener('click', () => {
            this.testCompletionSound();
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
            
            // Use original file paths directly and surround with quotes
            const filePaths = Array.from(files).map(file => `'${file.path || file.name}'`);
            const fileText = filePaths.join(' ');
            
            // Add files to current input with proper spacing
            const separator = currentText && !currentText.endsWith(' ') ? ' ' : '';
            messageInput.value = currentText + separator + fileText;
            
            // Focus on the input and place cursor at end
            messageInput.focus();
            messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
            
            const fileNames = Array.from(files).map(file => file.name);
            this.logAction(`Added ${files.length} file(s) to current message: ${fileNames.join(', ')}`, 'success');
        } catch (error) {
            console.error('Error processing files:', error);
            this.logAction(`Error processing files: ${error.message}`, 'error');
        }
    }

    generateMessageId() {
        return this.messageIdCounter++;
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

    addMessageToQueue() {
        const input = document.getElementById('message-input');
        const content = input.value.trim();
        
        // Validate content is not empty or just whitespace
        if (this.isValidMessageContent(content)) {
            const now = Date.now();
            const message = {
                id: this.generateMessageId(),
                content: content,
                processedContent: content,
                executeAt: now,
                createdAt: now,
                timestamp: now, // For compatibility
                terminalId: this.activeTerminalId, // Use currently selected terminal
                sequence: ++this.messageSequenceCounter // Add sequence counter for proper ordering
            };
            
            this.messageQueue.push(message);
            this.updateTrayBadge();
            this.saveMessageQueue();
            this.updateMessageList();
            this.updateStatusDisplay();
            input.value = '';
            
            // Reset input height after clearing
            this.autoResizeMessageInput(input);
            
            const terminalData = this.terminals.get(message.terminalId);
            const terminalName = terminalData ? terminalData.name : `Terminal ${message.terminalId}`;
            this.logAction(`Added message to queue for ${terminalName}: "${content}"`, 'info');
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
            
            if (this.isCommandMessage(message.content)) {
                messageElement.classList.add('command');
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
            content.textContent = message.content;
            
            const meta = document.createElement('div');
            meta.className = 'message-meta';
            
            // Use timestamp, createdAt, or current time as fallback
            const messageTime = message.timestamp || message.createdAt || Date.now();
            const timestamp = new Date(messageTime).toLocaleTimeString();
            const timeStamp = document.createElement('span');
            timeStamp.className = 'message-timestamp';
            timeStamp.textContent = `Added at ${timestamp}`;
            
            meta.appendChild(timeStamp);
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

    deleteMessage(messageId) {
        const index = this.messageQueue.findIndex(m => m.id === messageId);
        if (index !== -1) {
            const deletedMessage = this.messageQueue[index];
            this.messageQueue.splice(index, 1);
            this.updateTrayBadge();
            this.saveMessageQueue();
            this.updateMessageList();
            this.updateStatusDisplay();
            
            this.logAction(`Deleted message: "${deletedMessage.content}"`, 'warning');
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

    async saveToMessageHistory(message) {
        try {
            const historyItem = {
                content: message.content || message.processedContent,
                timestamp: Date.now()
            };
            
            // Save to database
            await ipcRenderer.invoke('db-save-message-history', historyItem);
            
            
            // Update local array for UI (add id for compatibility)
            const localHistoryItem = {
                id: Date.now() + Math.random(),
                content: historyItem.content,
                timestamp: new Date().toISOString(),
                injectedAt: new Date().toLocaleString()
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

    loadMessageHistory() {
        this.messageHistory = this.preferences.messageHistory || [];
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
        // If injection is in progress, handle injection pause/resume
        if (this.injectionInProgress) {
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

        this.timerActive = true;
        this.timerExpired = false;
        this.updateTimerUI();
        
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
        
        this.logAction('Timer started', 'info');
    }

    pauseTimer() {
        this.timerActive = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        this.updateTimerUI();
        this.logAction('Timer paused', 'info');
    }

    stopTimer() {
        this.timerActive = false;
        this.timerExpired = false;
        this.injectionInProgress = false;
        this.usageLimitWaiting = false;
        this.timerHours = 0;
        this.timerMinutes = 0;
        this.timerSeconds = 0;
        
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        
        // Stop power save blocker when timer is stopped
        this.stopPowerSaveBlocker();
        
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
            // Timer expired
            this.timerExpired = true;
            this.timerActive = false;
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            
            // If we were waiting for usage limit reset, clear the waiting state
            if (this.usageLimitWaiting) {
                this.logAction(`Timer expiration: clearing usageLimitWaiting. Current state - injectionInProgress: ${this.injectionInProgress}, queueLength: ${this.messageQueue.length}`, 'info');
                this.usageLimitWaiting = false;
                this.logAction('Usage limit reset time reached - resuming auto injection', 'success');
                
                // Clear the saved reset time state to allow fresh detection cycles
                // This prevents re-processing old usage limit messages from terminal buffer
                try {
                    await ipcRenderer.invoke('db-set-app-state', 'usageLimitTimerLastResetTime', null);
                } catch (error) {
                    console.error('Error clearing usage limit timer state:', error);
                }
                
                // Comprehensively clear any stuck injection states when timer expires
                this.isInjecting = false;
                this.injectionInProgress = false;
                this.currentlyInjectingMessageId = null;
                this.safetyCheckCount = 0;
                
                // Explicitly update terminal status to clear any stuck "injecting" state
                this.updateTerminalStatusIndicator();
                
                // Automatically add 'continue' to message queue when usage limit resets
                const continueContent = 'continue';
                
                // Validate the continue message (safety check)
                if (this.isValidMessageContent(continueContent)) {
                    const continueMessage = {
                        id: this.generateMessageId(),
                        content: continueContent,
                        executeAt: Date.now(),
                        createdAt: Date.now(),
                        sequence: ++this.messageSequenceCounter
                    };
                    
                    // Add to the beginning of the queue (highest priority)
                    this.messageQueue.unshift(continueMessage);
                    this.saveMessageQueue();
                    this.updateMessageList();
                    this.updateStatusDisplay();
                    
                    this.logAction('Auto-added continue message after usage limit reset', 'info');
                } else {
                    this.logAction('Failed to add continue message - validation failed', 'error');
                }
            }
            
            this.updateTimerUI();
            
            // Note: Timer expiration notification removed to prevent interrupting automated flow
            this.logAction(`Timer expiration: about to call scheduleNextInjection. Final state - injectionInProgress: ${this.injectionInProgress}, queueLength: ${this.messageQueue.length}, timerExpired: ${this.timerExpired}`, 'info');
            
            this.scheduleNextInjection();
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
        display.className = 'timer-display';
        if (this.timerActive) {
            display.classList.add('active');
        } else if (this.timerExpired && this.injectionInProgress) {
            display.classList.add('expired');
        }
        // When timer is at 00:00:00 and not injecting, it goes back to grey (no additional classes)
        
        // Update play/pause button
        if (this.injectionInProgress) {
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
        
        if (this.injectionInProgress) {
            // Show cancel button during injection
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
        } else if (timerAtZero && !this.timerActive && !this.injectionInProgress) {
            // Show refresh button when timer is at 00:00:00 and not active/injecting
            stopBtn.style.display = 'flex';
            stopBtn.innerHTML = '<i data-lucide="refresh-cw"></i>';
            stopBtn.title = 'Reset timer to last saved value';
            stopBtn.className = 'timer-btn timer-refresh';
        } else {
            stopBtn.style.display = 'none';
        }
        
        // Update edit button / status display
        if (this.injectionInProgress) {
            editBtn.style.display = 'none';
            if (waitingStatus) waitingStatus.style.display = 'none';
            if (injectionStatus) injectionStatus.style.display = 'inline';
        } else if (this.timerActive) {
            editBtn.style.display = 'none';
            if (waitingStatus) waitingStatus.style.display = 'inline';
            if (injectionStatus) injectionStatus.style.display = 'none';
        } else {
            editBtn.style.display = 'flex';
            if (waitingStatus) waitingStatus.style.display = 'none';
            if (injectionStatus) injectionStatus.style.display = 'none';
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
                            <input type="text" class="timer-segment-input" value="${String(this.timerHours).padStart(2, '0')}" maxlength="2" data-segment="hours">
                            <span class="timer-segment-label">HH</span>
                        </div>
                        <span class="timer-separator">:</span>
                        <div class="timer-segment" data-segment="minutes">
                            <input type="text" class="timer-segment-input" value="${String(this.timerMinutes).padStart(2, '0')}" maxlength="2" data-segment="minutes">
                            <span class="timer-segment-label">MM</span>
                        </div>
                        <span class="timer-separator">:</span>
                        <div class="timer-segment" data-segment="seconds">
                            <input type="text" class="timer-segment-input" value="${String(this.timerSeconds).padStart(2, '0')}" maxlength="2" data-segment="seconds">
                            <span class="timer-segment-label">SS</span>
                        </div>
                    </div>
                    <div class="timer-edit-actions">
                        <button class="timer-edit-btn-action timer-save-btn" id="save-timer">Done</button>
                        <button class="timer-edit-btn-action timer-cancel-btn" id="cancel-timer">Cancel</button>
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
        
        // Save timer values to preferences for persistence
        this.preferences.timerHours = this.timerHours;
        this.preferences.timerMinutes = this.timerMinutes;
        this.preferences.timerSeconds = this.timerSeconds;
        this.saveAllPreferences();
        
        this.updateTimerUI();
        
        // Only log when not in silent mode
        if (!silent) {
            this.logAction(`Timer set to ${String(this.timerHours).padStart(2, '0')}:${String(this.timerMinutes).padStart(2, '0')}:${String(this.timerSeconds).padStart(2, '0')}`, 'info');
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
    /*
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
             // Wait for terminal to be in ready state ('...') for 5 seconds consistently
             this.waitForStableReadyState(() => {
                 // Terminal has been ready for 5 seconds - start safety checks
                 this.performSafetyChecks(() => {
                     // Safety checks passed - inject the message
                     this.injectMessageAndContinueQueue();
                 });
             });
         }
    }

    injectMessageAndContinueQueue() {
        this.validateInjectionState('injectMessageAndContinueQueue');
        if (this.messageQueue.length === 0) {
            this.scheduleNextInjection();
            return;
        }
        
        const message = this.messageQueue.shift();
        this.saveMessageQueue(); // Save queue changes to localStorage
        this.isInjecting = true;
        // Keep injectionInProgress true throughout the entire sequence
        this.currentlyInjectingMessageId = message.id; // Track which message is being injected
        this.updateTerminalStatusIndicator(); // Use new status system
        this.updateMessageList(); // Update UI to show injecting state
        
        this.logAction(`Sequential injection: "${message.content}"`, 'success');
        
        // Type the message
        this.typeMessage(message.processedContent, () => {
            this.injectionCount++;
            this.saveToMessageHistory(message); // Save to history after successful injection
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

    cancelSequentialInjection() {
        // Stop all injection processes
        this.injectionInProgress = false;
        this.timerExpired = false;
        this.safetyCheckCount = 0;
        this.isInjecting = false;
        this.currentlyInjectingMessageId = null; // Clear injecting message tracking
        
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
        
        // Stop power save blocker
        this.stopPowerSaveBlocker();
        
        // Update UI and status
        this.updateTimerUI();
        this.updateTerminalStatusIndicator(); // Use proper status update
        this.updateMessageList(); // Update UI to clear injecting state
        
        this.logAction(`Sequential injection cancelled - ${this.messageQueue.length} messages remaining in queue`, 'warning');
    }
    */

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
        if (!this.injectionInProgress) {
            this.logAction('Cannot pause - no injection in progress', 'warning');
            return false;
        }

        this.injectionPaused = true;
        this.logAction('Injection execution paused', 'info');
        this.updateTimerUI();
        return true;
    }

    // Resume execution from where it was paused
    resumeInjectionExecution() {
        if (!this.injectionInProgress) {
            this.logAction('Cannot resume - no injection in progress', 'warning');
            return false;
        }

        if (!this.injectionPaused) {
            this.logAction('Injection is not paused', 'warning');
            return false;
        }

        this.injectionPaused = false;
        this.logAction('Injection execution resumed', 'info');
        this.updateTimerUI();

        // If we were in the middle of typing a message, continue from where we left off
        if (this.pausedMessageContent && this.pausedMessageIndex >= 0) {
            this.continueTypingFromPause();
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
        
        const isPrompting = recentOutput.includes('No, and tell Claude what to do differently');
        
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
                    this.setTerminalStatusDisplay('prompted', terminalId);
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
                
                // Update counters and UI
                this.injectionCount++;
                this.saveToMessageHistory(message);
                
                // Reset injection state
                this.isInjecting = false;
                this.injectionInProgress = false;
                this.currentlyInjectingMessageId = null;
                this.updateMessageList();
                this.updateStatusDisplay();
                
                this.logAction(`Manual injection complete via ${method}: "${message.content.substring(0, 50)}..."`, 'success');
            };
            
            // Set a timeout to ensure injection doesn't hang
            const injectionTimeout = setTimeout(() => {
                this.logAction('Manual injection timed out, forcing completion', 'warning');
                completeInjection('timeout');
            }, 30000); // 30 second timeout
            
            try {
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
                
                this.typeMessage(message.processedContent, () => {
                    this.injectionCount++;
                    this.saveToMessageHistory(message); // Save to history after successful injection
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
        };
        
        processNext();
    }

    scheduleNextInjection() {
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
        
        // Reset legacy injection flags to ensure new system can run
        this.injectionInProgress = false;
        
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
        
        // Clear stability timer since terminal is now busy injecting
        this.terminalStabilityTimers.delete(terminalId);
        
        this.logAction(`Injecting to ${terminalData.name}: "${message.content}"`, 'info');
        
        // Switch to target terminal if it's the first injection or no active injections
        if (this.currentlyInjectingMessages.size === 1) {
            if (terminalId !== this.activeTerminalId) {
                this.switchToTerminal(terminalId);
            }
        }
        
        this.typeMessageToTerminal(message.processedContent, terminalId, () => {
            this.injectionCount++;
            this.saveToMessageHistory(message);
            this.updateStatusDisplay();
            
            setTimeout(() => {
                ipcRenderer.send('terminal-input', { terminalId, data: '\r' });
                this.currentlyInjectingMessages.delete(message.id);
                this.currentlyInjectingTerminals.delete(terminalId); // Remove from busy terminals
                this.deleteMessage(message.id); // Move message deletion to after injection cleanup
                this.setTerminalStatusDisplay('', terminalId);
                
                // Schedule next injection
                this.scheduleNextInjection();
            }, 200);
        });
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
            // Check if injection was cancelled
            if (!this.currentlyInjectingMessages || this.currentlyInjectingMessages.size === 0) {
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

    detectAutoContinuePrompt(data) {
        // Check for blocking conditions for message injection
        const hasEscToInterrupt = this.lastTerminalOutput.includes("esc to interrupt") || 
                                 this.lastTerminalOutput.includes("offline)");
        const hasClaudePrompt = this.lastTerminalOutput.includes("No, and tell Claude what to do differently");
        
        // Handle keyword blocking specifically for Claude prompts (only if auto-continue is enabled)
        if (hasClaudePrompt && this.autoContinueEnabled) {
            const keywordBlockResult = this.checkForKeywordBlocking();
            if (keywordBlockResult.blocked && !this.keywordBlockingActive) {
                this.keywordBlockingActive = true;
                this.logAction(`Keyword "${keywordBlockResult.keyword}" detected in Claude prompt - executing escape sequence`, 'warning');
                
                // Send Esc key to interrupt
                ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: '\x1b' });
                
                // Wait and inject custom response if provided
                if (keywordBlockResult.response) {
                    const responseDelay = this.getRandomDelay(700, 1000);
                    setTimeout(() => {
                        this.logAction(`Injecting custom response: "${keywordBlockResult.response}"`, 'info');
                        this.typeMessage(keywordBlockResult.response, () => {
                            const enterDelay = this.getRandomDelay(150, 350);
                            setTimeout(() => {
                                ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: '\r' });
                                // Reset keyword blocking flag
                                const resetDelay = this.getRandomDelay(800, 1200);
                                setTimeout(() => {
                                    this.keywordBlockingActive = false;
                                }, resetDelay);
                            }, enterDelay);
                        });
                    }, responseDelay);
                } else {
                    // Just Esc without response
                    const resetDelay = this.getRandomDelay(800, 1200);
                    setTimeout(() => {
                        this.keywordBlockingActive = false;
                    }, resetDelay);
                }
                return; // Exit early, don't process auto-continue
            }
        }
        
        // Reset keyword blocking flag if Claude prompt is no longer present
        if (!hasClaudePrompt && this.keywordBlockingActive) {
            this.keywordBlockingActive = false;
        }
        
        // Check for custom keyword blocking for injection blocking
        const keywordBlockResult = this.checkForKeywordBlocking();
        
        // Update injection blocking status
        const previouslyBlocked = this.injectionBlocked;
        this.injectionBlocked = hasEscToInterrupt || keywordBlockResult.blocked;
        
        // Log when blocking status changes
        if (previouslyBlocked && !this.injectionBlocked) {
            this.logAction('Message injection unblocked - conditions cleared', 'success');
            // Resume injection scheduling if we have queued messages
            if (this.messageQueue.length > 0) {
                this.scheduleNextInjection();
            }
        } else if (!previouslyBlocked && this.injectionBlocked) {
            let reason = hasEscToInterrupt ? 'running process detected' : `keyword "${keywordBlockResult.keyword}" detected`;
            this.logAction(`Message injection blocked - ${reason}`, 'warning');
            // Cancel any pending injection
            if (this.injectionTimer) {
                clearTimeout(this.injectionTimer);
                this.injectionTimer = null;
            }
        }
        
        // Auto-continue logic (skip if keyword blocking just activated)
        if (!this.autoContinueEnabled || this.isInjecting || this.keywordBlockingActive) return;
        
        // Check for prompts that should trigger auto-continue
        const hasGeneralPrompt = /Do you want to proceed\?/i.test(this.lastTerminalOutput);
        const hasTrustPrompt = this.lastTerminalOutput.includes('Do you trust the files in this folder?');
        
        // Handle trust prompt - inject enter with random delay
        if (hasTrustPrompt && !this.trustPromptActive) {
            this.trustPromptActive = true;
            const delay = this.getRandomDelay(1000, 2000); // 1-2 seconds
            this.logAction(`Trust prompt detected - auto-injecting enter in ${delay}ms`, 'info');
            
            setTimeout(() => {
                ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: '\r' });
                this.trustPromptActive = false;
            }, delay);
            
            return; // Exit early to avoid other auto-continue processing
        }
        
        // Auto-continue for Claude prompt or general prompts
        if (hasClaudePrompt || hasGeneralPrompt) {
            const promptType = hasClaudePrompt ? 'Claude prompt' : 'general prompt';
            
            // If auto-continue is not already active for this prompt, start it
            if (!this.autoContinueActive) {
                console.log(`Auto-continue: ${promptType} detected! Starting persistent auto-continue.`);
                this.logAction(`Auto-continue detected ${promptType} - starting persistent checking`, 'info');
                this.autoContinueActive = true;
                this.autoContinueRetryCount = 0;
                this.performAutoContinue(promptType);
            }
        } else if (this.autoContinueActive) {
            // If we were auto-continuing but no longer see prompts, stop
            this.logAction(`Auto-continue completed - prompt cleared after ${this.autoContinueRetryCount + 1} attempts`, 'success');
            this.autoContinueActive = false;
            this.autoContinueRetryCount = 0;
        }
    }

    performAutoContinue(promptType) {
        if (!this.autoContinueActive || !this.autoContinueEnabled) return;
        
        this.autoContinueRetryCount++;
        this.logAction(`Auto-continue attempt #${this.autoContinueRetryCount} for ${promptType}`, 'info');
        
        // Send Enter key with small random delay for human-like behavior
        const enterDelay = this.getRandomDelay(50, 150);
        setTimeout(() => {
            ipcRenderer.send('terminal-input', { terminalId: this.activeTerminalId, data: '\r' });
        }, enterDelay);
        
        // Wait for terminal to process, then check if we need to continue
        const checkDelay = 1000 + this.getRandomDelay(0, 300); // 1-1.3 seconds
        setTimeout(() => {
            if (this.autoContinueActive) {
                // Check if prompt text is still present in recent output
                const hasClaudePrompt = this.lastTerminalOutput.includes("No, and tell Claude what to do differently");
                const hasGeneralPrompt = /Do you want to proceed\?/i.test(this.lastTerminalOutput);
                
                if (hasClaudePrompt || hasGeneralPrompt) {
                    // Prompt still there, continue if we haven't exceeded max attempts
                    if (this.autoContinueRetryCount < 10) {
                        this.logAction(`Prompt still present, retrying auto-continue`, 'warning');
                        this.performAutoContinue(promptType);
                    } else {
                        this.logAction(`Auto-continue stopped - max attempts (10) reached`, 'error');
                        this.autoContinueActive = false;
                        this.autoContinueRetryCount = 0;
                    }
                } else {
                    // Prompt is gone, success!
                    this.logAction(`Auto-continue successful after ${this.autoContinueRetryCount} attempts`, 'success');
                    this.autoContinueActive = false;
                    this.autoContinueRetryCount = 0;
                    // Clear the stored output
                    this.lastTerminalOutput = '';
                }
            }
        }, checkDelay);
    }

    // Helper function to generate random delays for more human-like behavior
    getRandomDelay(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    async detectUsageLimit(data) {
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
            const resetHour = parseInt(reachedMatch[1]);
            const ampm = reachedMatch[2].toLowerCase();
            const resetTimeString = `${resetHour}${ampm}`;
            
            // Set timer to exact reset time and pause injection
            await this.setTimerToUsageLimitReset(resetHour, ampm);
            
            // Check if we've already shown modal for this specific reset time
            this.checkAndShowUsageLimitModal(resetTimeString, resetHour, ampm);
        }
    }

    async setTimerToUsageLimitReset(resetHour, ampm) {
        const resetTimeString = `${resetHour}${ampm}`;
        
        try {
            // Check if we've already set timer for this reset time
            const lastTimerResetTime = await ipcRenderer.invoke('db-get-app-state', 'usageLimitTimerLastResetTime');
            
            if (lastTimerResetTime === resetTimeString) {
                console.log(`Timer already set for reset time ${resetTimeString}, skipping duplicate update`);
                return;
            }
            
            // Calculate time until reset
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
            
            const timeDiff = resetTime.getTime() - now.getTime();
            const totalSeconds = Math.max(1, Math.floor(timeDiff / 1000));
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            
            // Stop auto injection and set timer
            this.pauseInProgressInjection();
            this.usageLimitWaiting = true;
            
            // Set timer values
            this.timerHours = hours;
            this.timerMinutes = minutes;
            this.timerSeconds = seconds;
            this.timerExpired = false;
            
            // Start timer if not already active
            if (!this.timerActive) {
                this.startTimer();
            } else {
                this.updateTimerUI();
            }
            
            // Save this reset time to prevent duplicate timer updates
            await ipcRenderer.invoke('db-set-app-state', 'usageLimitTimerLastResetTime', resetTimeString);
            
            this.logAction(`Usage limit detected - timer set to reset at ${resetHour}${ampm} (${hours}h ${minutes}m ${seconds}s)`, 'warning');
        } catch (error) {
            console.error('Error checking/setting usage limit timer state:', error);
            // Fallback to original behavior if database operations fail
            this.logAction(`Error tracking timer state, proceeding with timer update for ${resetHour}${ampm}`, 'error');
        }
    }

    async checkAndShowUsageLimitModal(resetTimeString, resetHour, ampm) {
        try {
            const lastShownResetTime = await ipcRenderer.invoke('db-get-app-state', 'usageLimitModalLastResetTime');
            
            if (lastShownResetTime !== resetTimeString) {
                this.showUsageLimitModal(resetHour, ampm);
                await ipcRenderer.invoke('db-set-app-state', 'usageLimitModalLastResetTime', resetTimeString);
            }
        } catch (error) {
            console.error('Error checking usage limit modal state:', error);
        }
    }

    showUsageLimitModal(resetHour, ampm) {
        // Set flag that modal is showing and pause injection
        this.usageLimitModalShowing = true;
        this.pauseInProgressInjection();
        
        const modal = document.getElementById('usage-limit-modal');
        const progressBar = modal.querySelector('.usage-limit-progress-bar');
        const resetTimeSpan = document.getElementById('reset-time');
        const countdownSpan = document.getElementById('usage-countdown');
        const yesBtn = document.getElementById('usage-limit-yes');
        const noBtn = document.getElementById('usage-limit-no');
        
        // Calculate time until the parsed reset time
        const now = new Date();
        const resetTime = new Date();
        
        // Convert 12-hour format to 24-hour format
        let hour24 = resetHour;
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
        
        // Add 'continue' message to top of queue if there are items in queue
        if (this.messageQueue.length > 0) {
            const continueMessage = {
                id: this.generateMessageId(),
                content: 'continue', // Enter key to continue current prompt (escaped for proper handling)
                executeAt: Date.now(), // Execute immediately
                createdAt: Date.now(),
                sequence: ++this.messageSequenceCounter
            };
            
            // Add to the beginning of the queue
            this.messageQueue.unshift(continueMessage);
            this.saveMessageQueue();
            this.updateMessageList();
            this.updateStatusDisplay();
            
            this.logAction('Added continue message to handle current prompt before queue processing', 'info');
        }

        // Show modal and start progress bar animation
        modal.classList.add('show');
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
        
        yesBtn.onclick = () => handleChoice(true);
        noBtn.onclick = () => handleChoice(false);
        
        // Auto-close after 10 seconds
        setTimeout(() => {
            if (modal.classList.contains('show')) {
                handleChoice(true);
            }
        }, 10000);
    }

    handleUsageLimitChoice(queue) {
        const modal = document.getElementById('usage-limit-modal');
        const progressBar = modal.querySelector('.usage-limit-progress-bar');
        
        // Hide modal and clear flag
        modal.classList.remove('show');
        progressBar.classList.remove('active');
        this.usageLimitModalShowing = false;
        
        // Log the choice and auto-fill form if user chose to queue
        if (queue) {
            this.logAction('Usage limit detected - Queue mode enabled until 3am reset', 'info');
            // Auto-fill the Execute in form with calculated time until reset
            this.autoFillExecuteInForm();
        } else {
            this.logAction('Usage limit detected - Continuing normally', 'info');
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
                this.checkCompletionSoundTrigger(previousStatus, terminalData.status);
            }
        } else {
            // Legacy support - update active terminal
            this.setTerminalStatusDisplay(status, this.activeTerminalId);
        }
    }

    checkCompletionSoundTrigger(previousStatus, currentStatus) {
        // Trigger completion sound when transitioning from 'running' to idle ('...')
        if (previousStatus === 'running' && (currentStatus === '...' || currentStatus === '')) {
            // Start idle timer for completion sound
            if (!this.terminalIdleStartTime) {
                this.terminalIdleStartTime = Date.now();
            }
            
            // Clear any existing timer
            if (this.terminalIdleTimer) {
                clearTimeout(this.terminalIdleTimer);
            }
            
            this.terminalIdleTimer = setTimeout(() => {
                // Double-check conditions before playing sound
                const isQueueEmpty = this.messageQueue.length === 0;
                const isStillIdle = (this.terminalStatus === '...' || this.terminalStatus === '');
                
                if (isQueueEmpty && isStillIdle && !this.isInjecting) {
                    this.playCompletionSound();
                } else {
                    this.logAction('Completion sound cancelled - conditions changed', 'info');
                }
                
                this.terminalIdleTimer = null;
                this.terminalIdleStartTime = null;
            }, 100);
        } else {
            // Reset idle tracking when not transitioning from running to idle
            if (this.terminalIdleTimer) {
                clearTimeout(this.terminalIdleTimer);
                this.terminalIdleTimer = null;
            }
            this.terminalIdleStartTime = null;
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
        
        // Update execution times in message list
        const executionTimeElements = document.querySelectorAll('.execution-time');
        executionTimeElements.forEach((element, index) => {
            if (this.messageQueue[index]) {
                element.textContent = this.getTimeUntilExecution(this.messageQueue[index].executeAt);
            }
        });
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

    handleTerminalOutput() {
        if (this.autoscrollEnabled && !this.userInteracting) {
            this.scrollToBottom();
        }
        
    }

    handleScroll() {
        if (!this.autoscrollEnabled) return;

        const viewport = document.querySelector('.xterm-viewport');
        if (!viewport) return;

        const isAtBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 10;
        
        if (!isAtBottom) {
            this.userInteracting = true;
            if (this.autoscrollTimeout) {
                clearTimeout(this.autoscrollTimeout);
            }
            
            this.autoscrollTimeout = setTimeout(() => {
                this.userInteracting = false;
                if (this.autoscrollEnabled) {
                    this.scrollToBottom();
                }
            }, this.autoscrollDelay);
        } else {
            this.userInteracting = false;
            if (this.autoscrollTimeout) {
                clearTimeout(this.autoscrollTimeout);
                this.autoscrollTimeout = null;
            }
        }
    }

    scrollToBottom() {
        const viewport = document.querySelector('.xterm-viewport');
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

        const historyHTML = this.messageHistory.map(item => `
            <div class="history-item">
                <div class="history-item-header">
                    <span class="history-item-date">${item.injectedAt}</span>
                    <button class="undo-btn" onclick="terminalGUI.undoFromHistory('${item.id}')" title="Add back to queue">
                        <i data-lucide="undo-2"></i>
                    </button>
                </div>
                <div class="history-item-content">${this.escapeHtml(item.content)}</div>
            </div>
        `).join('');

        historyList.innerHTML = historyHTML;
        
        // Initialize Lucide icons for the new buttons
        lucide.createIcons();
    }

    undoFromHistory(historyId) {
        const historyItem = this.messageHistory.find(item => item.id === historyId);
        if (!historyItem) {
            this.logAction('History item not found', 'error');
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
            
            // Load saved timer values
            this.timerHours = this.preferences.timerHours || 0;
            this.timerMinutes = this.preferences.timerMinutes || 0;
            this.timerSeconds = this.preferences.timerSeconds || 0;
            
            // Load message queue from database
            const dbMessages = await ipcRenderer.invoke('db-get-messages');
            this.messageQueue = dbMessages.map(msg => ({
                id: msg.message_id,
                content: msg.content,
                processedContent: msg.processed_content,
                executeAt: msg.execute_at,
                createdAt: msg.created_at,
                timestamp: msg.created_at // For compatibility
            }));
            
            // Synchronize messageIdCounter to avoid duplicate IDs
            if (this.messageQueue.length > 0) {
                this.messageIdCounter = Math.max(...this.messageQueue.map(m => m.id)) + 1;
            }
            
            this.updateMessageList();
            this.validateMessageIds(); // Debug: Check for ID conflicts after loading
            
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
            
            // Update UI elements safely
            const autoscrollEnabledEl = document.getElementById('autoscroll-enabled');
            if (autoscrollEnabledEl) autoscrollEnabledEl.checked = this.autoscrollEnabled;
            
            const autoscrollDelayEl = document.getElementById('autoscroll-delay');
            if (autoscrollDelayEl) autoscrollDelayEl.value = this.autoscrollDelay;
            
            const autoContinueEl = document.getElementById('auto-continue');
            if (autoContinueEl) autoContinueEl.checked = this.autoContinueEnabled;
            
            const themeSelectEl = document.getElementById('theme-select');
            if (themeSelectEl) themeSelectEl.value = this.preferences.theme || 'dark';
            
            // Update sound settings UI
            const completionSoundEl = document.getElementById('completion-sound-enabled');
            if (completionSoundEl) completionSoundEl.checked = this.preferences.completionSoundEnabled || false;
            
            // Update background service settings UI
            const keepScreenAwakeEl = document.getElementById('keep-screen-awake');
            if (keepScreenAwakeEl) keepScreenAwakeEl.checked = this.preferences.keepScreenAwake || true;

            const showSystemNotificationsEl = document.getElementById('show-system-notifications');
            if (showSystemNotificationsEl) showSystemNotificationsEl.checked = this.preferences.showSystemNotifications || true;

            const minimizeToTrayEl = document.getElementById('minimize-to-tray');
            if (minimizeToTrayEl) minimizeToTrayEl.checked = this.preferences.minimizeToTray || true;

            const startMinimizedEl = document.getElementById('start-minimized');
            if (startMinimizedEl) startMinimizedEl.checked = this.preferences.startMinimized || false;
            
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
            
            this.logAction('Preferences loaded successfully from database', 'success');
        } catch (error) {
            console.error('Error loading preferences:', error);
            this.logAction('Failed to load preferences - using defaults', 'error');
        }
    }

    async savePreferences() {
        // Update preferences object with current values before saving
        this.preferences.currentDirectory = this.currentDirectory;
        await this.saveAllPreferences();
    }

    async saveAllPreferences() {
        try {
            // Save each preference to database
            for (const [key, value] of Object.entries(this.preferences)) {
                if (key === 'messageQueue' || key === 'messageHistory') continue; // Handle separately
                await ipcRenderer.invoke('db-set-setting', key, JSON.stringify(value));
            }
            
        } catch (error) {
            console.error('Failed to save preferences:', error);
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
    
    checkForKeywordBlocking() {
        // Only check if we have keyword rules
        if (!this.preferences.keywordRules || this.preferences.keywordRules.length === 0) {
            return { blocked: false };
        }
        
        // Ensure we have terminal output to check
        if (!this.lastTerminalOutput || this.lastTerminalOutput.trim() === '') {
            return { blocked: false };
        }
        
        // Find the ╭ character which marks the start of the current Claude prompt area
        const claudePromptStart = this.lastTerminalOutput.lastIndexOf("╭");
        if (claudePromptStart === -1) {
            // Fallback: check the last 1000 characters if no ╭ found
            const fallbackArea = this.lastTerminalOutput.slice(-1000);
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
        const currentPromptArea = this.lastTerminalOutput.substring(claudePromptStart);
        
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
        // Restore timer to last saved values from preferences
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

    // Command detection for styling
    isCommandMessage(content) {
        // Common command patterns
        const commandPatterns = [
            /^\^[A-Z]/,  // Ctrl commands like ^C, ^Z
            /\\x1b/,     // Escape sequences
            /\\r/,       // Return/Enter
            /\\t/,       // Tab
            /\r\n|\n|\r/, // Line breaks
            /^(ls|cd|pwd|cat|grep|find|ps|kill|top|htop|vim|nano|git|npm|yarn|docker|curl|wget)/i, // Common terminal commands
        ];
        
        return commandPatterns.some(pattern => pattern.test(content));
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
            this.logAction(`Terminal ${terminalId} became ready - starting 5-second stability timer`, 'info');
            return false;
        }

        // Check if stable long enough
        const stableDuration = now - stableStartTime;
        const requiredStableDuration = 5000; // 5 seconds

        if (stableDuration >= requiredStableDuration) {
            this.logAction(`Terminal ${terminalId} stable for ${stableDuration}ms - ready for injection`, 'success');
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
            
            const select = document.getElementById('completion-sound-select');
            
            // Store current selection to restore it after populating
            const currentSelection = this.preferences.completionSoundFile;
            
            // Clear existing options
            select.innerHTML = '';
            
            // Add "Hl2 beep" as default option
            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = 'Hl2 beep';
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
                
                this.logAction(`Loaded ${result.files.length} sound effects`, 'info');
            } else {
                this.logAction('No sound effects found', 'warning');
            }
            
            // Restore the previously selected sound file
            select.value = currentSelection;
            
        } catch (error) {
            console.error('Error populating sound effects:', error);
            this.logAction(`Error loading sound effects: ${error.message}`, 'error');
        }
    }

    updateSoundSettingsVisibility() {
        const soundGroup = document.getElementById('sound-selection-group');
        const isEnabled = document.getElementById('completion-sound-enabled').checked;
        
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
                console.error('Error playing sound:', error);
                this.logAction(`Error playing sound: ${error.message}`, 'error');
            });
        } catch (error) {
            console.error('Error creating audio:', error);
            this.logAction(`Error creating audio: ${error.message}`, 'error');
        }
    }

    onAutoInjectionComplete() {
        // Play completion sound if enabled
        this.playCompletionSound();
        this.logAction('Auto-injection process completed', 'success');
    }
    
    // Multi-terminal management methods
    addNewTerminal() {
        const terminalCount = this.terminals.size;
        if (terminalCount >= 4) {
            this.logAction('Maximum of 4 terminals reached', 'warning');
            return;
        }
        
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
                    <button class="icon-btn close-terminal-btn" title="Close terminal">
                        <i data-lucide="x"></i>
                    </button>
                    <span class="terminal-color-dot" style="background-color: ${color};"></span>
                    <span class="terminal-title editable" contenteditable="false">Terminal ${newId}</span>
                    <button class="icon-btn add-terminal-btn" title="Add new terminal" style="display: none;">
                        <i data-lucide="plus"></i>
                    </button>
                </div>
                <span class="terminal-status" data-terminal-status="${newId}"></span>
            </div>
            <div class="terminal-container" data-terminal-container="${newId}"></div>
        `;
        
        // Add to container
        const terminalsContainer = document.getElementById('terminals-container');
        terminalsContainer.appendChild(terminalWrapper);
        
        // Update layout
        terminalsContainer.setAttribute('data-terminal-count', terminalCount + 1);
        
        // Create terminal instance
        const terminalData = this.createTerminal(newId);
        
        // Start terminal process
        ipcRenderer.send('terminal-start', { terminalId: newId, directory: this.currentDirectory });
        
        // Update dropdowns
        this.updateTerminalDropdowns();
        
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
    }
    
    updateTerminalButtonVisibility() {
        const terminalCount = this.terminals.size;
        
        // Show/hide close buttons (show when more than 1 terminal)
        const closeButtons = document.querySelectorAll('.close-terminal-btn');
        closeButtons.forEach(btn => {
            btn.style.display = terminalCount > 1 ? 'inline-flex' : 'none';
        });
        
        // Show/hide add buttons (hide when 4 terminals, show on last terminal when 3 or fewer)
        const addButtons = document.querySelectorAll('.add-terminal-btn');
        addButtons.forEach(btn => {
            btn.style.display = 'none'; // Hide all first
        });
        
        // Show add button only on the last terminal if we have 3 or fewer terminals
        if (terminalCount < 4) {
            const terminalWrappers = document.querySelectorAll('.terminal-wrapper');
            if (terminalWrappers.length > 0) {
                const lastWrapper = terminalWrappers[terminalWrappers.length - 1];
                const addBtn = lastWrapper.querySelector('.add-terminal-btn');
                if (addBtn) {
                    addBtn.style.display = 'inline-flex';
                }
            }
        }
    }
    
    closeTerminal(terminalId) {
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
        
        // Remove any messages assigned to this terminal from the queue
        this.messageQueue = this.messageQueue.filter(message => {
            const messageTerminalId = message.terminalId != null ? message.terminalId : this.activeTerminalId;
            return messageTerminalId !== terminalId;
        });
        this.displayMessages();
        
        // Notify main process to close terminal process
        ipcRenderer.send('terminal-close', { terminalId });
        
        // Dispose of terminal
        terminalData.terminal.dispose();
        
        // Remove from terminals map
        this.terminals.delete(terminalId);
        
        // Remove DOM element
        const terminalWrapper = document.querySelector(`[data-terminal-id="${terminalId}"]`);
        if (terminalWrapper) {
            terminalWrapper.remove();
        }
        
        // If this was the active terminal, switch to another one
        if (terminalId === this.activeTerminalId) {
            const availableIds = Array.from(this.terminals.keys());
            if (availableIds.length > 0) {
                this.switchToTerminal(availableIds[0]);
            }
        }
        
        // Update button visibility
        this.updateTerminalButtonVisibility();
        
        // Update container count
        const terminalsContainer = document.getElementById('terminals-container');
        terminalsContainer.setAttribute('data-terminal-count', this.terminals.size);
        
        // Resize remaining terminals to fit new layout
        setTimeout(() => {
            this.resizeAllTerminals();
        }, 100);
        
        this.logAction(`Closed ${terminalData.name}`, 'info');
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
        
        this.updateStatusDisplay();
        this.logAction(`Selected ${terminalData.name}`, 'info');
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
                    
                    // Update selector if this is the active terminal
                    if (terminalId === this.activeTerminalId) {
                        document.querySelector('.terminal-selector-text').textContent = newText;
                    }
                    
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
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.terminalGUI = new TerminalGUI();
    
    // Add initial log message after app is fully initialized
    setTimeout(() => {
        window.terminalGUI.logAction('Application ready - all systems operational', 'success');
    }, 500);
});