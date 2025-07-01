const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');

class TerminalGUI {
    constructor() {
        this.terminal = null;
        this.fitAddon = null;
        this.messageQueue = [];
        this.injectionTimer = null;
        this.injectionCount = 0;
        this.currentDirectory = null; // Will be set when terminal starts or directory is detected
        this.isInjecting = false;
        this.messageIdCounter = 1;
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
        
        // Terminal idle tracking for completion sound
        this.terminalIdleTimer = null;
        this.terminalIdleStartTime = null;
        
        // Message history tracking
        this.messageHistory = [];
        
        // Background service state
        this.powerSaveBlockerActive = false;
        this.backgroundServiceActive = false;
        
        // Initialize the application asynchronously
        this.initialize();
    }

    async initialize() {
        try {
            console.log('Starting app initialization...');
            
            // Load preferences FIRST so we have saved directory before starting terminal
            console.log('Loading preferences...');
            await this.loadAllPreferences();
            console.log('Preferences loaded successfully');
            
            console.log('Initializing terminal...');
            this.initializeTerminal();
            console.log('Terminal initialized');
            
            console.log('Setting up event listeners...');
            this.setupEventListeners();
            console.log('Event listeners set up');
            
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
        // Create terminal instance
        this.terminal = new Terminal({
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
        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(new WebLinksAddon());

        // Open terminal in container
        const terminalContainer = document.getElementById('terminal-container');
        this.terminal.open(terminalContainer);
        
        // Fit terminal to container - add delay to ensure container is rendered
        setTimeout(() => {
            this.fitAddon.fit();
        }, 10);
        
        // Ensure terminal starts at bottom on initialization
        setTimeout(() => {
            this.scrollToBottom();
        }, 100);

        // Handle terminal input
        this.terminal.onData((data) => {
            ipcRenderer.send('terminal-input', data);
        });

        // Handle scroll events for autoscroll (needs to be set after terminal is ready)
        setTimeout(() => {
            const terminalViewport = terminalContainer.querySelector('.xterm-viewport');
            if (terminalViewport) {
                terminalViewport.addEventListener('scroll', () => {
                    this.handleScroll();
                });
            }
        }, 100);

        // Handle terminal resize
        this.terminal.onResize(({ cols, rows }) => {
            ipcRenderer.send('terminal-resize', cols, rows);
        });

        // Load saved directory before starting terminal (preferences already loaded in constructor)
        const savedDirectory = this.preferences.currentDirectory;
        console.log('Starting terminal with saved directory:', savedDirectory);
        
        if (savedDirectory) {
            this.currentDirectory = savedDirectory;
            this.logAction(`Starting terminal in saved directory: ${savedDirectory}`, 'info');
        } else {
            this.logAction('Starting terminal in default directory', 'info');
        }

        // Start terminal process in saved directory (or default if none saved)
        console.log('Sending terminal-start IPC message...');
        ipcRenderer.send('terminal-start', savedDirectory);
        
        // Get initial directory from main process if none saved
        if (!savedDirectory) {
            console.log('Requesting current working directory...');
            ipcRenderer.send('get-cwd');
        }

        // Handle window resize
        window.addEventListener('resize', () => {
            this.fitAddon.fit();
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
        // IPC listeners for terminal data
        ipcRenderer.on('terminal-data', async (event, data) => {
            console.log('Received terminal data:', data);
            this.terminal.write(data);
            this.updateTerminalOutput(data);
            this.detectAutoContinuePrompt(data);
            await this.detectUsageLimit(data);
            // Terminal status is now handled by continuous scanning system
            this.handleTerminalOutput();
        });

        ipcRenderer.on('terminal-exit', () => {
            this.terminal.write('\r\n\x1b[31mTerminal process exited\x1b[0m\r\n');
        });

        ipcRenderer.on('cwd-response', (event, cwd) => {
            this.currentDirectory = cwd;
            this.updateStatusDisplay();
            this.savePreferences();
            this.logAction(`Set directory to: ${cwd}`, 'info');
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
                timestamp: now // For compatibility
            };
            
            this.messageQueue.push(message);
            this.updateTrayBadge();
            this.saveMessageQueue();
            this.updateMessageList();
            this.updateStatusDisplay();
            input.value = '';
            
            // Reset input height after clearing
            this.autoResizeMessageInput(input);
            
            this.logAction(`Added message to queue: "${content}"`, 'info');
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

            messageElement.addEventListener('dragstart', (e) => {
                console.log('dragstart event listener called');
                this.handleDragStart(e);
            });
            messageElement.addEventListener('dragover', (e) => {
                console.log('dragover on individual message element');
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                this.handleDragOver(e);
            });
            messageElement.addEventListener('drop', (e) => {
                console.log('drop on individual message element');
                e.preventDefault();
                this.handleDrop(e);
            });
            messageElement.addEventListener('dragend', (e) => {
                console.log('dragend event listener called');
                this.handleDragEnd(e);
            });
            
            console.log('Added drag event listeners to message element');
            
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
            
            actions.appendChild(editBtn);
            actions.appendChild(deleteBtn);
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
                console.error('Error in decrementTimer:', error);
                this.logAction('Timer error: ' + error.message, 'error');
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
                this.usageLimitWaiting = false;
                this.logAction('Usage limit reset time reached - resuming auto injection', 'success');
                
                // Clear the saved reset time state to allow fresh detection cycles
                // This prevents re-processing old usage limit messages from terminal buffer
                try {
                    await ipcRenderer.invoke('db-set-app-state', 'usageLimitTimerLastResetTime', null);
                } catch (error) {
                    console.error('Error clearing usage limit timer state:', error);
                }
                
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
                        createdAt: Date.now()
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
            
            this.startSequentialInjection();
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

    async startSequentialInjection() {
        if (this.messageQueue.length === 0) {
            this.logAction('Timer expired but no messages to inject', 'warning');
            return;
        }
        
        // State recovery: if we're already in an injection state but stuck, reset it
        if (this.injectionInProgress && !this.isInjecting) {
            this.logAction('Detected stuck injection state - recovering', 'warning');
            this.injectionInProgress = false;
            this.isInjecting = false;
            this.safetyCheckCount = 0;
        }
        
        // Start power save blocker if enabled
        if (this.preferences.keepScreenAwake) {
            await this.startPowerSaveBlocker();
        }
        
        this.injectionInProgress = true;
        this.updateTimerUI();
        this.logAction(`Timer expired - starting sequential injection of ${this.messageQueue.length} messages (timerExpired=${this.timerExpired}, usageLimitWaiting=${this.usageLimitWaiting})`, 'success');
        
        // Start with first message (no 30-second delay for first message)
        this.processNextQueuedMessage(true);
    }

    processNextQueuedMessage(isFirstMessage = false) {
        
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
        if (this.messageQueue.length === 0) {
            this.processNextQueuedMessage();
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
                ipcRenderer.send('terminal-input', '\r');
                this.isInjecting = false;
                // Don't reset injectionInProgress here - keep it true for the entire sequence
                this.currentlyInjectingMessageId = null; // Clear injecting message tracking
                this.updateTerminalStatusIndicator(); // Use new status system
                this.updateMessageList(); // Update UI to clear injecting state
                
                // Continue with next message after a short delay (only for timer-based injection)
                if (this.timerExpired) {
                    const nextMessageDelay = this.getRandomDelay(800, 1200);
                    setTimeout(() => {
                        this.processNextQueuedMessage();
                    }, nextMessageDelay);
                } else {
                    // Manual injection complete - reset all states
                    this.injectionInProgress = false;
                    this.logAction('Manual injection complete - stopped after one message', 'info');
                }
                
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
                ipcRenderer.send('terminal-input', message[index]);
                index++;
            } else {
                clearInterval(typeInterval);
                
                // Message completed, continue with normal flow
                const enterDelay = this.getRandomDelay(300, 800);
                setTimeout(() => {
                    ipcRenderer.send('terminal-input', '\r');
                    this.isInjecting = false;
                    this.currentlyInjectingMessageId = null;
                    
                    // Continue with next message if timer expired
                    if (this.timerExpired) {
                        const nextMessageDelay = this.getRandomDelay(800, 1200);
                        setTimeout(() => {
                            this.processNextQueuedMessage();
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
        // Get recent terminal output from multiple sources for better accuracy
        let recentOutput = '';
        
        // Try to get output from terminal buffer if available
        if (this.terminal && this.terminal.buffer && this.terminal.buffer.active) {
            try {
                // Get last 20 lines from terminal buffer
                const buffer = this.terminal.buffer.active;
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
                // Fallback to lastTerminalOutput if buffer reading fails
                recentOutput = this.lastTerminalOutput.slice(-2000);
            }
        } else {
            // Fallback to lastTerminalOutput
            recentOutput = this.lastTerminalOutput.slice(-2000);
        }
        
        // Better detection patterns for running state
        // Look for "esc to interrupt" specifically, not just "to interrupt)" which can match false positives
        // Also check for "offline)" which can appear instead of "esc to interrupt" but indicates the same running state
        const isRunning = recentOutput.includes('esc to interrupt') || 
                         recentOutput.includes('(esc to interrupt)') ||
                         recentOutput.includes('ESC to interrupt') ||
                         recentOutput.includes('offline)');
        
        const isPrompting = recentOutput.includes('No, and tell Claude what to do differently');
        
        // Update current status
        const statusChanged = (this.currentTerminalStatus.isRunning !== isRunning || 
                             this.currentTerminalStatus.isPrompting !== isPrompting);
        
        // Completion sound logic has been moved to checkCompletionSoundTrigger()
        // This ensures proper state transition detection from 'running' to idle
        
        // Debug logging for status changes
        if (statusChanged) {
            const newStatus = isRunning ? 'running' : (isPrompting ? 'prompting' : 'ready');
            const oldStatus = this.currentTerminalStatus.isRunning ? 'running' : 
                             (this.currentTerminalStatus.isPrompting ? 'prompting' : 'ready');

            
        }
        
        this.currentTerminalStatus = {
            isRunning: isRunning,
            isPrompting: isPrompting,
            lastUpdate: Date.now()
        };
        
        // Update status display if status changed
        if (statusChanged) {
            this.updateTerminalStatusIndicator();
        }
    }

    updateTerminalStatusIndicator() {
        // When waiting for usage limit reset, always show default "..." status
        if (this.usageLimitWaiting) {
            this.setTerminalStatusDisplay('');
            return;
        }
        
        if (this.isInjecting) {
            this.setTerminalStatusDisplay('injecting');
        } else if (this.currentTerminalStatus.isRunning) {
            this.setTerminalStatusDisplay('running');
        } else if (this.currentTerminalStatus.isPrompting) {
            this.setTerminalStatusDisplay('prompted');
        } else {
            this.setTerminalStatusDisplay('');
        }
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
                            ipcRenderer.send('terminal-input', '\r');
                        }, 100);
                    }
                    
                    completeInjection('typeMessage');
                });
            } catch (error) {
                clearTimeout(injectionTimeout);
                
                // Fallback: direct input if typeMessage fails
                this.logAction(`TypeMessage failed, using direct input: ${error.message}`, 'warning');
                try {
                    ipcRenderer.send('terminal-input', message.content);
                    
                    // Send Enter if not a control sequence
                    const hasControlSequence = /(\^[A-Z]|\\x1b|\\r|\\t)/g.test(message.content);
                    if (!hasControlSequence) {
                        setTimeout(() => {
                            ipcRenderer.send('terminal-input', '\r');
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
        this.setTerminalStatusDisplay('injecting');
        let index = 0;
        
        const processNext = () => {
            if (index < messages.length) {
                const message = messages[index];
                console.log(`Processing batch message: ${message.content}`);
                this.logAction(`Processing batch message: "${message.content}"`, 'info');
                
                this.typeMessage(message.processedContent, () => {
                    this.injectionCount++;
                    this.saveToMessageHistory(message); // Save to history after successful injection
                    this.updateStatusDisplay();
                    
                    setTimeout(() => {
                        ipcRenderer.send('terminal-input', '\r');
                        index++;
                        
                        if (index < messages.length) {
                            setTimeout(processNext, 1000);
                        } else {
                            this.isInjecting = false;
                            this.setTerminalStatusDisplay('');
                            this.logAction('Batch injection completed successfully', 'success');
                            this.scheduleNextInjection(); // Schedule any remaining messages
                        }
                    }, 200);
                });
            }
        };
        
        processNext();
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
                    ipcRenderer.send('terminal-input', controlChars[charIndex]);
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
                ipcRenderer.send('terminal-input', message[index]);
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
                ipcRenderer.send('terminal-input', '\x1b');
                
                // Wait and inject custom response if provided
                if (keywordBlockResult.response) {
                    const responseDelay = this.getRandomDelay(700, 1000);
                    setTimeout(() => {
                        this.logAction(`Injecting custom response: "${keywordBlockResult.response}"`, 'info');
                        this.typeMessage(keywordBlockResult.response, () => {
                            const enterDelay = this.getRandomDelay(150, 350);
                            setTimeout(() => {
                                ipcRenderer.send('terminal-input', '\r');
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
                ipcRenderer.send('terminal-input', '\r');
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
            ipcRenderer.send('terminal-input', '\r');
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
                createdAt: Date.now()
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
            this.startSequentialInjection();
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


    setTerminalStatusDisplay(status) {
        const statusElement = document.getElementById('terminal-status');
        if (!statusElement) return;
        
        // Store previous status for completion sound logic
        const previousStatus = this.terminalStatus;
        this.terminalStatus = status || '...';
        
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
                // Show default status
                statusElement.className = 'terminal-status';
                statusElement.textContent = '...';
        }
        
        // Check for completion sound trigger: running -> idle transition
        this.checkCompletionSoundTrigger(previousStatus, this.terminalStatus);
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
            timestamp: now // For compatibility
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
                this.startSequentialInjection();
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
        this.actionLog.push({
            timestamp: timestamp,
            message: message,
            type: type
        });
        
        if (this.actionLog.length > 100) {
            this.actionLog = this.actionLog.slice(-100);
        }
        
        this.updateActionLogDisplay();
    }

    updateActionLogDisplay() {
        const logContainer = document.getElementById('action-log');
        logContainer.innerHTML = '';
        
        this.actionLog.slice(-20).forEach(entry => {
            const logItem = document.createElement('div');
            logItem.className = `log-item log-${entry.type}`;
            
            const timeElement = document.createElement('span');
            timeElement.className = 'log-time';
            timeElement.textContent = `[${entry.timestamp}]`;
            
            const messageElement = document.createElement('span');
            messageElement.className = 'log-message';
            messageElement.textContent = entry.message;
            
            logItem.appendChild(timeElement);
            logItem.appendChild(messageElement);
            logContainer.appendChild(logItem);
        });
        
        logContainer.scrollTop = logContainer.scrollHeight;
    }
    
    clearActionLog() {
        this.actionLog = [];
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
            
            // Get current terminal status
            const isReady = !this.currentTerminalStatus.isRunning && 
                           !this.currentTerminalStatus.isPrompting && 
                           !this.isInjecting;
            
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
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.terminalGUI = new TerminalGUI();
    
    // Add initial log message after app is fully initialized
    setTimeout(() => {
        window.terminalGUI.logAction('Application ready - all systems operational', 'success');
    }, 500);
});