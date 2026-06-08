const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');

// Import core modules
const EventBus = require('./src/core/EventBus');
const EventProcessors = require('./src/core/EventProcessors');
const TerminalManager = require('./src/core/terminal-manager');
const { AppStateStore } = require('./src/state/AppStateStore');
const { StateManager } = require('./src/state/StateManager');
const TerminalStateManager = require('./src/state/TerminalStateManager');

// Import messaging
const MessageQueueManager = require('./src/messaging/MessageQueueManager');
const InjectionManager = require('./src/messaging/injection-manager');

// Import feature managers
const StatusManager = require('./src/features/StatusManager');
const CompletionManager = require('./src/features/CompletionManager');
const UsageLimitManager = require('./src/features/UsageLimitManager');
const VoiceManager = require('./src/features/VoiceManager');
const SoundManager = require('./src/features/SoundManager');
const PreferenceManager = require('./src/features/PreferenceManager');
const TimerManager = require('./src/features/TimerManager');
const ActionLogManager = require('./src/features/ActionLogManager');
const ManagerInstance = require('./src/features/ManagerInstance');
const UIFocusManager = require('./src/ui/UIFocusManager');

// Import utilities
const { getAllTextIn, getLastTextIn, cleanTerminalText } = require('./utils/textExtraction');
const { parseUsageLimitMessage } = require('./src/utils/usage-limit-parser');

/**
 * Main application controller that orchestrates all modules
 */
class TerminalGUI {
    constructor() {
        console.log('🏁 TerminalGUI: Starting initialization...');
        
        // Initialize LoadingManager if available
        if (typeof LoadingManager !== 'undefined') {
            this.loadingManager = new LoadingManager();
            this.loadingManager.updateProgress('core', 'Initializing core systems...');
        }
        
        // Initialize core systems
        this.initializeCoreModules();
        
        // Initialize state management
        this.initializeStateManagement();
        
        // Initialize terminal system
        this.initializeTerminalSystem();
        
        // Initialize messaging system
        this.initializeMessaging();
        
        // Initialize feature managers
        this.initializeFeatures();
        
        // Initialize UI
        this.initializeUI();
        
        // Set up IPC communication
        this.setupIPC();
        
        // Finalize initialization
        this.finalizeInitialization();
    }
    
    initializeCoreModules() {
        // Create central event bus
        this.eventBus = new EventBus();
        console.log('📡 EventBus initialized');
        
        // Create app state store
        this.appStateStore = new AppStateStore();
        console.log('💾 AppStateStore initialized');
    }
    
    initializeStateManagement() {
        // Create the terminal state store first so StateManager can wire it.
        this.terminalStateManager = new TerminalStateManager();

        // StateManager's constructor takes no args; it is activated via initialize()
        // which wires the stores, sets up cross-store sync, and restores state.
        this.stateManager = new StateManager();
        // initialize() is async; kick it off and let cross-store sync activate.
        this.stateManager.initialize(
            this.eventBus,
            this.appStateStore,
            this.terminalStateManager
        ).catch(err => console.error('StateManager initialization failed:', err));

        console.log('🗄️ State management initialized');
    }
    
    initializeTerminalSystem() {
        // Create IPC handler wrapper (shared by terminal + messaging layers)
        this.ipcHandler = {
            send: (channel, ...args) => ipcRenderer.send(channel, ...args),
            on: (channel, handler) => ipcRenderer.on(channel, handler),
            removeListener: (channel, handler) => ipcRenderer.removeListener(channel, handler),
            invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args)
        };

        // Initialize terminal manager with proper dependencies
        this.terminalManager = new TerminalManager(this.ipcHandler, this.appStateStore.getState('settings') || {});
        
        // Map for xterm instances (for backward compatibility)
        this.terminals = new Map();
        this.activeTerminalId = null;
        
        console.log('💻 Terminal system initialized');
    }
    
    initializeMessaging() {
        // Create injection manager, passing the GUI as its context (fix 7).
        this.injectionManager = new InjectionManager(this);

        // Create message queue manager with explicit dependencies and an ipc
        // wrapper (no longer coupled to the renderer "context" object).
        this.messageQueueManager = new MessageQueueManager(
            this.eventBus,
            this.appStateStore,
            this.terminalStateManager,
            this.ipcHandler
        );

        // Allow the message queue manager to delegate injection scheduling.
        this.messageQueueManager.injectionManager = this.injectionManager;

        console.log('📨 Messaging system initialized');
    }
    
    initializeFeatures() {
        // Initialize all feature managers
        this.statusManager = new StatusManager(this.eventBus, this.appStateStore);
        this.completionManager = new CompletionManager(this.eventBus, this.appStateStore);
        this.usageLimitManager = new UsageLimitManager(this.eventBus, this.appStateStore);
        this.voiceManager = new VoiceManager(this.eventBus, this.appStateStore);
        this.soundManager = new SoundManager(this.eventBus, this.appStateStore);
        this.preferenceManager = new PreferenceManager(this.eventBus, this.appStateStore);
        this.timerManager = new TimerManager(this.eventBus, this.appStateStore);
        this.uiFocusManager = new UIFocusManager(this.eventBus, this.appStateStore);

        // Left sidebar: action log feed + view navigation
        this.actionLogManager = new ActionLogManager(this.eventBus, this.appStateStore);
        this.actionLogManager.initialize();

        // Hidden manager Claude instance (terminal 999) - steers the interface
        this.managerInstance = new ManagerInstance(this.eventBus, this.appStateStore, this.ipcHandler, this);
        this.managerInstance.initializeUI();

        // The injection gate (R3) blocks while a countdown is armed, so the
        // queue needs a handle on the timer to call isRunning().
        this.messageQueueManager.timerManager = this.timerManager;

        // Restore the master send toggle state (default: sending enabled).
        this.messageQueueManager.injectionPaused = this.appStateStore.getState('injectionPaused') === true;

        // Wire the usage-limit manager to the timer + message queue so it can
        // drive the countdown (R2) and hold the injection gate (R3). Without
        // this the manager's timerManager/messageQueueManager stay null.
        this.usageLimitManager.setManagers(this.timerManager, this.messageQueueManager);
        this.usageLimitManager.initialize();

        // Wire centralized event processors onto the EventBus (fix 8).
        this.setupEventProcessors();

        console.log('🎨 Feature managers initialized');
    }

    setupEventProcessors() {
        // EventProcessors consolidates category-level event handling. Feature
        // managers still subscribe directly; processors provide defensive,
        // best-effort routing/bookkeeping per category.
        this.eventProcessors = new EventProcessors(
            this.stateManager,
            this.terminalManager,
            this.messageQueueManager
        );

        const ep = this.eventProcessors;
        this.eventBus.registerProcessor('terminal', ep.processTerminalEvents.bind(ep));
        this.eventBus.registerProcessor('message', ep.processMessageEvents.bind(ep));
        this.eventBus.registerProcessor('timer', ep.processTimerEvents.bind(ep));
        this.eventBus.registerProcessor('ui', ep.processUIEvents.bind(ep));
        this.eventBus.registerProcessor('state', ep.processStateEvents.bind(ep));
        this.eventBus.registerProcessor('completion', ep.processCompletionEvents.bind(ep));
        this.eventBus.registerProcessor('input', ep.processInputEvents.bind(ep));
        this.eventBus.registerProcessor('ipc', ep.processIPCEvents.bind(ep));
        this.eventBus.registerProcessor('file', ep.processFileEvents.bind(ep));
        this.eventBus.registerProcessor('audio', ep.processAudioEvents.bind(ep));
        this.eventBus.registerProcessor('error', ep.processErrorEvents.bind(ep));
        this.eventBus.registerProcessor('default', ep.processDefaultEvents.bind(ep));

        console.log('🧩 Event processors registered');
    }
    
    initializeUI() {
        // Set up DOM event handlers
        this.setupDOMEventHandlers();
        
        // Set up terminal-specific UI
        this.setupTerminalUI();
        
        console.log('🖼️ UI initialized');
    }
    
    setupIPC() {
        // Terminal creation/destruction
        ipcRenderer.on('create-terminal', () => this.createTerminal());
        ipcRenderer.on('close-terminal', (event, id) => this.closeTerminal(id));
        
        // Terminal data flow (main sends a single { terminalId, content } payload)
        ipcRenderer.on('terminal-data', (event, payload) => {
            const { terminalId, content } = payload || {};
            const terminalData = this.terminals.get(terminalId);
            if (terminalData && terminalData.terminal) {
                terminalData.terminal.write(content);

                // Update state
                this.terminalStateManager.updateTerminal(terminalId, {
                    lastOutput: content,
                    updatedAt: Date.now()
                });

                // Emit event
                this.eventBus.emit('terminal:data', { terminalId, data: content });
            }
        });

        // PTY lifecycle (main sends { terminalId, ... } payloads)
        ipcRenderer.on('terminal-ready', (event, { terminalId }) => {
            const previousStatus = this.terminalStateManager.setTerminalStatus(terminalId, '...');
            if (previousStatus !== null) {
                this.eventBus.emit('terminal:status:changed', {
                    terminalId, status: '...', previousStatus, source: 'pty-ready'
                });
            }
        });

        ipcRenderer.on('terminal-exit', (event, { terminalId, exitCode, signal }) => {
            // A terminal closed by the user kills its PTY, which emits exit
            // AFTER we removed the terminal - ignore exits for gone terminals.
            if (!this.terminals.has(terminalId)) return;
            this.terminalStateManager.updateTerminal(terminalId, { isReady: false, isBusy: false });
            this.eventBus.emit('terminal:exit', { terminalId, exitCode, signal });
        });

        // Claude Code hook events: ground-truth state pushed by hooks running
        // inside app-spawned terminals (via main's HookServer)
        ipcRenderer.on('claude-hook-event', (event, payload) => {
            const HOOK_STATUS_MAP = {
                'prompt-submit': 'running',
                'notification': 'prompted',
                'stop': '...' // '...' is the app's stale/idle state convention
            };
            if (!this.terminals.has(payload.terminalId)) return;

            // Every hook payload carries the session cwd — keep the terminal's
            // directory in sync from ground truth instead of prompt regex.
            const cwd = payload.hook && (payload.hook.new_cwd || payload.hook.cwd);
            if (cwd) {
                const existing = this.terminalStateManager.getTerminal(payload.terminalId);
                if (existing && existing.directory !== cwd) {
                    this.terminalStateManager.updateTerminal(payload.terminalId, { directory: cwd });
                    this.eventBus.emit('terminal:directory', { terminalId: payload.terminalId, directory: cwd });
                }
            }

            // Persist session identity so external controllers (manager
            // instance) can map terminal -> conversation -> transcript on disk.
            if (payload.hook && (payload.hook.session_id || payload.hook.transcript_path)) {
                this.terminalStateManager.updateTerminal(payload.terminalId, {
                    sessionId: payload.hook.session_id || null,
                    transcriptPath: payload.hook.transcript_path || null
                });
            }

            // Usage-limit detection (R1): the Notification hook's stdin JSON
            // carries a human-readable `message`. Parsing that one structured
            // string is far more reliable than scraping raw terminal output.
            if (payload.event === 'notification' && payload.hook && payload.hook.message) {
                const parsed = parseUsageLimitMessage(payload.hook.message);
                if (parsed) {
                    this.eventBus.emit('usageLimit:detected', {
                        terminalId: payload.terminalId,
                        resetTime: parsed.resetTime,
                        source: 'notification-hook'
                    });
                }
            }

            // Stop events arrive enriched with Claude's last message (read
            // from the session transcript in main) - record it as a completion
            if (payload.event === 'stop' && payload.lastAssistantText) {
                const completionData = {
                    terminalId: payload.terminalId,
                    text: payload.lastAssistantText,
                    directory: cwd || null,
                    sessionId: (payload.hook && payload.hook.session_id) || null
                };
                this.eventBus.emit('completion:recorded', completionData);

                // Opt-in plain-English mode: headless Claude compresses the
                // message to 1-2 sentences (costs quota - off by default)
                if (this.appStateStore.getState('summarizeCompletions') && completionData.sessionId) {
                    this.ipcHandler.invoke('summarize-completion', payload.lastAssistantText)
                        .then((summary) => {
                            if (summary) {
                                this.eventBus.emit('completion:summarized', {
                                    sessionId: completionData.sessionId,
                                    summary
                                });
                            }
                        })
                        .catch(() => { /* summarizer is best-effort */ });
                }
            }

            const status = HOOK_STATUS_MAP[payload.event];
            if (!status) return; // cwd-changed carries no status transition

            const previousStatus = this.terminalStateManager.setTerminalStatus(payload.terminalId, status);
            if (previousStatus !== null && previousStatus !== status) {
                this.eventBus.emit('terminal:status:changed', {
                    terminalId: payload.terminalId,
                    status,
                    previousStatus,
                    source: 'claude-hook',
                    detail: payload.hook // session_id, cwd, notification message, etc.
                });
            }
        });
        
        // Terminal status updates (canonical: terminal:status:changed)
        ipcRenderer.on('terminal-status', (event, terminalId, status) => {
            const previousStatus = this.terminalStateManager.setTerminalStatus(terminalId, status);
            if (previousStatus !== null) {
                this.eventBus.emit('terminal:status:changed', {
                    terminalId,
                    status,
                    previousStatus,
                    source: 'ipc'
                });
            }
        });
        
        // Directory changes
        ipcRenderer.on('directory-changed', (event, terminalId, directory) => {
            this.terminalStateManager.updateTerminal(terminalId, { directory });
            this.eventBus.emit('terminal:directory', { terminalId, directory });
        });

        // External queue-add requests arriving via the HookServer API
        // (POST /queue/add - e.g. the manager instance steering a terminal)
        ipcRenderer.on('queue-add-request', (event, { terminalId, content }) => {
            this.messageQueueManager.addMessage({ content, terminalId });
            this.eventBus.emit('log:action', {
                message: `Queued message for Terminal ${terminalId} via control API`,
                type: 'info'
            });
        });

        // Control requests needing a response (terminal create/update/delete
        // via the HookServer) - correlated back to main by requestId
        ipcRenderer.on('control-request', (event, { requestId, action, payload }) => {
            let result;
            try {
                result = this.handleControlRequest(action, payload);
            } catch (error) {
                result = { ok: false, error: error.message };
            }
            ipcRenderer.send('control-response', { requestId, result });
        });

        // Mirror terminal state to main so the HookServer's GET /state can
        // answer external controllers without a renderer round trip.
        const sendStateSnapshot = () => {
            const terminals = [];
            this.terminalStateManager.getAllTerminals().forEach((data, id) => {
                terminals.push({
                    id,
                    status: data.status || '...',
                    directory: data.directory || null,
                    sessionId: data.sessionId || null,
                    transcriptPath: data.transcriptPath || null,
                    title: data.title || `Terminal ${id}`
                });
            });
            ipcRenderer.send('ccbot-state-snapshot', {
                activeTerminalId: this.activeTerminalId,
                queuedMessages: this.messageQueueManager.messageQueue.length,
                terminals,
                updatedAt: Date.now()
            });
        };
        ['terminal:status:changed', 'terminal:directory', 'terminal:created', 'terminal:closed', 'queue:updated']
            .forEach((evt) => this.eventBus.on(evt, sendStateSnapshot));
        setTimeout(sendStateSnapshot, 1000); // initial snapshot after init settles

        console.log('📡 IPC handlers established');
    }
    
    setupDOMEventHandlers() {
        // Terminal controls (kebab-case IDs per index.html)
        const addTerminalBtn = document.getElementById('add-terminal-btn');
        if (addTerminalBtn) {
            addTerminalBtn.addEventListener('click', () => this.createTerminal());
        }

        // Message queue controls
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-btn');

        if (messageInput && sendButton) {
            const handleAddMessage = () => {
                const message = messageInput.value.trim();
                if (message) {
                    this.messageQueueManager.addMessage({
                        content: message,
                        // Selector choice wins; falls back to the active terminal
                        terminalId: this.queueTargetTerminalId ?? this.activeTerminalId
                    });
                    messageInput.value = '';
                }
            };

            sendButton.addEventListener('click', handleAddMessage);
            messageInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleAddMessage();
                }
            });
        }

        // Injection controls
        const injectNowBtn = document.getElementById('inject-now-btn');
        if (injectNowBtn) {
            injectNowBtn.addEventListener('click', () => {
                this.messageQueueManager.injectNextMessage();
            });
        }

        const clearQueueBtn = document.getElementById('clear-queue-header-btn');
        if (clearQueueBtn) {
            clearQueueBtn.addEventListener('click', () => {
                this.messageQueueManager.clearQueue();
            });
        }

        // Timer controls. The play/pause button toggles; the stop button stops.
        const timerPlayPauseBtn = document.getElementById('timer-play-pause-btn');
        if (timerPlayPauseBtn) {
            timerPlayPauseBtn.addEventListener('click', () => {
                this.timerManager.toggleTimer();
            });
        }

        const timerStopBtn = document.getElementById('timer-stop-btn');
        if (timerStopBtn) {
            timerStopBtn.addEventListener('click', () => {
                this.timerManager.stopTimer();
            });
        }

        // Timer edit: inline-edit the HH:MM:SS display (Electron disables
        // window.prompt, which is why the old edit silently did nothing).
        const timerEditBtn = document.getElementById('timer-edit-btn');
        const timerDisplay = document.getElementById('timer-display');
        const commitTimerEdit = () => {
            const m = timerDisplay.textContent.trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
            timerDisplay.removeAttribute('contenteditable');
            timerDisplay.classList.remove('editing');
            if (!m) {
                this.timerManager.updateTimerDisplay(); // restore last good value
                this.eventBus.emit('log:action', { message: 'Invalid time (use HH:MM:SS)', type: 'error' });
                return;
            }
            const h = Math.min(99, parseInt(m[1], 10));
            const min = Math.min(59, parseInt(m[2], 10));
            const s = Math.min(59, parseInt(m[3], 10));
            this.timerManager.setTimer(h, min, s, true);
        };
        const beginTimerEdit = () => {
            if (!timerDisplay || timerDisplay.getAttribute('contenteditable') === 'true') return;
            timerDisplay.setAttribute('contenteditable', 'true');
            timerDisplay.classList.add('editing');
            timerDisplay.focus();
            // Select all the text for quick overwrite
            const range = document.createRange();
            range.selectNodeContents(timerDisplay);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        };
        if (timerEditBtn) timerEditBtn.addEventListener('click', beginTimerEdit);
        if (timerDisplay) {
            timerDisplay.addEventListener('click', beginTimerEdit);
            timerDisplay.addEventListener('blur', commitTimerEdit);
            timerDisplay.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); timerDisplay.blur(); }
                if (e.key === 'Escape') { timerDisplay.removeAttribute('contenteditable'); timerDisplay.classList.remove('editing'); this.timerManager.updateTimerDisplay(); }
            });
        }

        // Master send toggle (queue header): pauses/resumes injection entirely.
        // The timer is now purely a suppressor; this is the on/off switch.
        const sendToggleBtn = document.getElementById('send-toggle-btn');
        if (sendToggleBtn) {
            sendToggleBtn.addEventListener('click', () => this.toggleSending());
            this.syncSendToggleButton();
        }

        // Queue-target terminal selector (the dropdown next to the input)
        this.setupTerminalSelector();

        // Re-fit all visible terminals whenever grid membership changes
        // (terminals share the row; column widths shift on add/remove/toggle)
        const refitVisibleTerminals = () => {
            requestAnimationFrame(() => {
                this.terminals.forEach((data) => {
                    if (!data.container.classList.contains('manager-hidden')) {
                        try { data.fitAddon.fit(); } catch { /* not yet laid out */ }
                    }
                });
            });
        };
        ['terminal:created', 'terminal:closed', 'manager:visibility']
            .forEach((evt) => this.eventBus.on(evt, refitVisibleTerminals));
        window.addEventListener('resize', refitVisibleTerminals);

        // Collapsible right-sidebar panels (Status, Timer) with persistence
        document.querySelectorAll('.collapse-toggle[data-collapse-target]').forEach((btn) => {
            const section = btn.closest('.collapsible-section');
            if (!section) return;
            const key = `panelCollapsed:${btn.dataset.collapseTarget}`;
            if (localStorage.getItem(key) === '1') {
                section.classList.add('collapsed');
            }
            btn.addEventListener('click', () => {
                const collapsed = section.classList.toggle('collapsed');
                localStorage.setItem(key, collapsed ? '1' : '0');
            });
        });

        // Settings button
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                this.eventBus.emit('ui:settings:open');
            });
        }

        console.log('🎮 DOM event handlers configured');
    }
    
    /**
     * Terminal selector: picks which terminal queued messages target.
     * Lists every visible terminal plus the Manager (yellow) when running.
     */
    setupTerminalSelector() {
        this.queueTargetTerminalId = null; // null = follow the active terminal
        const btn = document.getElementById('terminal-selector-btn');
        const dropdown = document.getElementById('terminal-selector-dropdown');
        if (!btn || !dropdown) return;

        const repopulate = () => {
            dropdown.innerHTML = '';
            this.terminals.forEach((data, id) => {
                const isManager = this.managerInstance && id === ManagerInstance.TERMINAL_ID;
                if (isManager && !this.managerInstance.isRunning()) return;

                const state = this.terminalStateManager.getTerminal(id);
                const item = document.createElement('button');
                item.className = 'terminal-selector-item';
                item.dataset.terminalId = id;

                const dot = document.createElement('span');
                dot.className = 'terminal-selector-dot';
                dot.style.backgroundColor = isManager ? 'var(--accent-warning)' : 'var(--accent-primary)';

                const label = document.createElement('span');
                label.textContent = isManager ? 'Manager' : ((state && state.title) || `Terminal ${id}`);

                item.appendChild(dot);
                item.appendChild(label);
                item.addEventListener('click', () => {
                    this.queueTargetTerminalId = id;
                    this.updateSelectorDisplay(id);
                    dropdown.style.display = 'none';
                });
                dropdown.appendChild(item);
            });
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = dropdown.style.display !== 'none';
            if (!open) repopulate();
            dropdown.style.display = open ? 'none' : '';
        });
        document.addEventListener('click', () => {
            dropdown.style.display = 'none';
        });

        // Keep the selector honest as terminals come and go
        ['terminal:created', 'terminal:closed', 'manager:started', 'manager:visibility']
            .forEach((evt) => this.eventBus.on(evt, repopulate));
        this.eventBus.on('terminal:closed', ({ terminalId }) => {
            if (this.queueTargetTerminalId === terminalId) {
                this.queueTargetTerminalId = null;
                this.updateSelectorDisplay(this.activeTerminalId);
            }
        });
    }

    updateSelectorDisplay(terminalId) {
        const text = document.querySelector('.terminal-selector-text');
        const dot = document.querySelector('.terminal-selector-btn .terminal-selector-dot');
        const isManager = this.managerInstance && terminalId === ManagerInstance.TERMINAL_ID;
        const state = this.terminalStateManager.getTerminal(terminalId);
        if (text) text.textContent = isManager ? 'Manager' : ((state && state.title) || `Terminal ${terminalId}`);
        if (dot) dot.style.backgroundColor = isManager ? 'var(--accent-warning)' : 'var(--accent-primary)';
    }

    setupTerminalUI() {
        // Terminal tab handlers
        const terminalsContainer = document.getElementById('terminals-container');
        if (terminalsContainer) {
            terminalsContainer.addEventListener('click', (e) => {
                const tab = e.target.closest('.terminal-tab');
                if (tab) {
                    const terminalId = parseInt(tab.dataset.terminalId);
                    this.setActiveTerminal(terminalId);
                }
                
                const closeBtn = e.target.closest('.close-terminal-btn');
                if (closeBtn) {
                    const terminalId = parseInt(closeBtn.dataset.terminalId);
                    this.closeTerminal(terminalId);
                }
            });
        }
    }
    
    createTerminal(options = {}) {
        // options.id: explicit terminal id (e.g. 0 = the hidden manager instance)
        // options.directory: cwd for the PTY
        // options.hidden: keep the wrapper out of the visible grid
        // options.skipActive: don't steal focus/active state
        const terminalId = options.id !== undefined
            ? options.id
            : this.terminalManager.terminalIdCounter++;

        // Create xterm instance
        const terminal = new Terminal({
            theme: this.terminalManager.getTerminalTheme(),
            fontSize: 14,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            cursorBlink: true,
            allowProposedApi: true
        });

        // Add addons
        const fitAddon = new FitAddon();
        const searchAddon = new SearchAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(searchAddon);

        // Mount point: index.html ships a full wrapper (header chrome + search
        // overlay + .terminal-container mount) for terminal 1 — reuse it when
        // present instead of appending a chrome-less duplicate. New/hidden
        // terminals get a dynamically built wrapper.
        let container;
        let mount = document.querySelector(`.terminal-container[data-terminal-container="${terminalId}"]`);
        if (mount && !options.hidden) {
            container = mount.closest('.terminal-wrapper') || mount;
        } else {
            container = document.createElement('div');
            container.className = options.hidden ? 'terminal-wrapper manager-hidden' : 'terminal-wrapper';
            if (options.cssClass) container.classList.add(options.cssClass);
            container.dataset.terminalId = terminalId;

            // Dynamic terminals get the same chrome as the static wrapper:
            // header (dot, title, status) + a .terminal-container mount.
            // Titles are editable unless locked (the Manager can't be renamed).
            const titleText = options.title || `Terminal ${terminalId}`;
            const dotColor = options.color || 'var(--accent-primary)';
            const header = document.createElement('div');
            header.className = 'terminal-header';
            // Manager (locked) gets no close button - it's managed by the app.
            const closeBtnHtml = options.lockTitle ? '' :
                `<button class="icon-btn close-terminal-btn hotkey-enabled" title="Close terminal" data-terminal-id="${terminalId}" data-test-id="close-terminal-btn"><i data-lucide="x"></i></button>`;
            header.innerHTML = `
                <div class="terminal-title-wrapper">
                    <span class="terminal-color-dot" style="background-color: ${dotColor};"></span>
                    <span class="terminal-title${options.lockTitle ? '' : ' editable'}" contenteditable="false"></span>
                </div>
                <div class="terminal-header-right">
                    <span class="terminal-status" data-terminal-status="${terminalId}"></span>
                    ${closeBtnHtml}
                </div>`;
            header.querySelector('.terminal-title').textContent = titleText;
            container.appendChild(header);
            if (window.lucide) window.lucide.createIcons({ nameAttr: 'data-lucide', root: header });

            mount = document.createElement('div');
            mount.className = 'terminal-container';
            mount.dataset.terminalContainer = terminalId;
            container.appendChild(mount);

            const terminalsContainer = document.getElementById('terminals-container');
            if (terminalsContainer) {
                terminalsContainer.appendChild(container);
            }
        }

        // Open terminal
        terminal.open(mount);
        if (options.hidden) {
            // fit() on a display:none container computes garbage dimensions -
            // give concealed terminals (the manager) a sane fixed size; the
            // dispatch tab re-fits when it reveals the terminal.
            terminal.resize(120, 30);
        } else {
            fitAddon.fit();
        }
        if (!options.skipActive) {
            terminal.focus(); // blinking caret from the first paint
        }
        
        // Set up data handler (main expects an { terminalId, data } payload)
        terminal.onData((data) => {
            ipcRenderer.send('terminal-input', { terminalId, data });
            this.terminalStateManager.updateTerminal(terminalId, {
                lastInput: data,
                updatedAt: Date.now()
            });
        });

        // Keep the PTY dimensions in sync with the xterm viewport
        terminal.onResize(({ cols, rows }) => {
            ipcRenderer.send('terminal-resize', { terminalId, cols, rows });
        });
        
        // Store terminal
        const terminalData = {
            id: terminalId,
            terminal,
            fitAddon,
            searchAddon,
            container
        };
        
        this.terminals.set(terminalId, terminalData);
        
        // Update state
        this.terminalStateManager.createTerminal({
            id: terminalId,
            terminal,
            directory: options.directory || process.cwd(),
            title: options.title
        });

        // Spawn the PTY in main (channel + payload shape match main.js's handler)
        ipcRenderer.send('terminal-start', { terminalId, directory: options.directory || null });

        // Set as active (manager and other background terminals skip this)
        if (!options.skipActive) {
            this.setActiveTerminal(terminalId);
        }

        // Emit event
        this.eventBus.emit('terminal:created', { terminalId, hidden: !!options.hidden });

        console.log(`✅ Terminal ${terminalId} created${options.hidden ? ' (hidden)' : ''}`);
        return terminalId;
    }
    
    closeTerminal(terminalId) {
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return;
        
        // Dispose terminal
        terminalData.terminal.dispose();
        terminalData.container.remove();
        
        // Remove from maps
        this.terminals.delete(terminalId);
        this.terminalStateManager.removeTerminal(terminalId);
        
        // Kill the PTY in main (channel + payload shape match main.js's handler)
        ipcRenderer.send('terminal-close', { terminalId });
        
        // Select another terminal if this was active
        if (this.activeTerminalId === terminalId) {
            const remaining = Array.from(this.terminals.keys());
            if (remaining.length > 0) {
                this.setActiveTerminal(remaining[0]);
            } else {
                this.activeTerminalId = null;
            }
        }
        
        // Emit event
        this.eventBus.emit('terminal:closed', { terminalId });
        
        console.log(`✅ Terminal ${terminalId} closed`);
    }
    
    setActiveTerminal(terminalId) {
        if (!this.terminals.has(terminalId)) return;
        
        this.activeTerminalId = terminalId;
        this.terminalStateManager.setActiveTerminal(terminalId);
        
        // Update UI
        document.querySelectorAll('.terminal-wrapper').forEach(wrapper => {
            wrapper.classList.toggle('active', 
                parseInt(wrapper.dataset.terminalId) === terminalId);
        });
        
        // Focus terminal
        const terminalData = this.terminals.get(terminalId);
        if (terminalData) {
            terminalData.terminal.focus();
        }

        // The queue target follows the active terminal unless the user
        // explicitly picked one from the selector afterward
        this.queueTargetTerminalId = terminalId;
        this.updateSelectorDisplay(terminalId);

        // Emit event
        this.eventBus.emit('terminal:active', { terminalId });
    }

    /**
     * Swap a lucide icon inside a button reliably. lucide replaces the
     * <i data-lucide> with an <svg> on render, so you can't re-set the <i>'s
     * attribute afterward - you must replace the button's icon content and
     * re-run createIcons. Shared helper for all dynamic icon state.
     */
    setButtonIcon(btnOrId, iconName) {
        const btn = typeof btnOrId === 'string' ? document.getElementById(btnOrId) : btnOrId;
        if (!btn) return;
        btn.innerHTML = `<i data-lucide="${iconName}"></i>`;
        if (window.lucide) window.lucide.createIcons({ nameAttr: 'data-lucide', root: btn });
    }

    /** Toggle the master send switch (injectionPaused) and reflect it. */
    toggleSending() {
        const mqm = this.messageQueueManager;
        mqm.injectionPaused = !mqm.injectionPaused;
        this.appStateStore.setState('injectionPaused', mqm.injectionPaused);
        this.syncSendToggleButton();
        this.eventBus.emit('log:action', {
            message: mqm.injectionPaused ? 'Sending paused — messages will hold in the queue' : 'Sending resumed',
            type: mqm.injectionPaused ? 'warning' : 'success'
        });
        // On resume, flush anything that became eligible while paused
        if (!mqm.injectionPaused) {
            this.terminals.forEach((_, id) => mqm.maybeAutoInject(id));
        }
    }

    syncSendToggleButton() {
        const paused = this.messageQueueManager.injectionPaused;
        const btn = document.getElementById('send-toggle-btn');
        if (!btn) return;
        // Sending active -> show pause (click to pause); paused -> show play.
        this.setButtonIcon(btn, paused ? 'play' : 'pause');
        btn.classList.toggle('paused', paused);
        btn.title = paused ? 'Sending paused — click to resume' : 'Sending enabled — click to pause';
    }

    /**
     * Update a terminal tab's metadata (title and/or color) and reflect it in
     * the DOM chrome immediately. Used by the control API and any UI rename.
     */
    setTerminalMetadata(terminalId, { title, color } = {}) {
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) return false;

        const updates = {};
        if (typeof title === 'string' && title.trim()) updates.title = title.trim();
        if (typeof color === 'string' && color.trim()) updates.color = color.trim();
        if (Object.keys(updates).length === 0) return false;

        this.terminalStateManager.updateTerminal(terminalId, updates);

        const wrapper = terminalData.container;
        if (updates.title) {
            const titleEl = wrapper.querySelector('.terminal-title');
            if (titleEl) titleEl.textContent = updates.title;
        }
        if (updates.color) {
            const dot = wrapper.querySelector('.terminal-color-dot');
            if (dot) dot.style.backgroundColor = updates.color;
        }

        this.eventBus.emit('terminal:metadata', { terminalId, ...updates });
        if (terminalId === this.queueTargetTerminalId) this.updateSelectorDisplay(terminalId);
        return true;
    }

    /**
     * Handle a control-API request (terminal create/update/delete) and return
     * a structured { ok, ... } result for the HookServer to relay.
     */
    handleControlRequest(action, payload = {}) {
        if (action === 'terminal-create') {
            const id = this.createTerminal({
                directory: payload.directory || null,
                title: payload.title || undefined,
                color: payload.color || undefined
            });
            this.eventBus.emit('log:action', {
                message: `Terminal ${id} created via control API${payload.directory ? ' in ' + payload.directory : ''}`,
                type: 'success'
            });
            return { ok: true, terminalId: id };
        }

        if (action === 'terminal-update') {
            const terminalId = parseInt(payload.terminalId, 10);
            if (terminalId === ManagerInstance.TERMINAL_ID) {
                return { ok: false, error: 'the manager terminal cannot be renamed' };
            }
            const ok = this.setTerminalMetadata(terminalId, { title: payload.title, color: payload.color });
            return ok ? { ok: true, terminalId } : { ok: false, error: 'terminal not found or nothing to update' };
        }

        if (action === 'terminal-delete') {
            const terminalId = parseInt(payload.terminalId, 10);
            if (terminalId === ManagerInstance.TERMINAL_ID) {
                return { ok: false, error: 'the manager terminal cannot be deleted via the API' };
            }
            if (!this.terminals.has(terminalId)) {
                return { ok: false, error: 'terminal not found' };
            }
            this.closeTerminal(terminalId);
            this.eventBus.emit('log:action', {
                message: `Terminal ${terminalId} deleted via control API`,
                type: 'warning'
            });
            return { ok: true, terminalId };
        }

        return { ok: false, error: `unknown control action: ${action}` };
    }
    
    finalizeInitialization() {
        // Create initial terminal
        this.createTerminal();

        // Boot the manager instance if the user configured a directory for it
        this.managerInstance.startIfConfigured();

        // Hide loading screen
        if (this.loadingManager) {
            this.loadingManager.completeStep('finalization');
        } else {
            const loadingModal = document.getElementById('loading-modal');
            if (loadingModal) {
                loadingModal.style.display = 'none';
            }
        }
        
        // Expose for debugging
        window.terminalGUI = this;
        window.eventBus = this.eventBus;
        window.stateManager = this.stateManager;
        window.terminalManager = this.terminalManager;
        window.messageQueueManager = this.messageQueueManager;
        
        console.log('✅ TerminalGUI initialization complete');
    }
    
    // ===== Compatibility shims for InjectionManager (fix 7) =====
    // InjectionManager reads several fields/methods off its gui context. These
    // shims keep it from crashing and bridge to the canonical subsystems.
    logAction(message, type = 'info') {
        this.eventBus.emit('log:action', { message, type });
    }

    get messageQueue() {
        return this.appStateStore.getState('messages.queue') || [];
    }

    get terminalStatuses() {
        return (this.statusManager && this.statusManager.terminalStatuses) || new Map();
    }

    get injectionPaused() {
        return this.messageQueueManager ? this.messageQueueManager.injectionPaused : false;
    }

    get usageLimitWaiting() {
        return this.messageQueueManager ? this.messageQueueManager.usageLimitWaiting : false;
    }
    set usageLimitWaiting(v) {
        if (this.messageQueueManager) this.messageQueueManager.usageLimitWaiting = v;
    }

    get timerExpired() {
        return this.messageQueueManager ? this.messageQueueManager.timerExpired : false;
    }
    set timerExpired(v) {
        if (this.messageQueueManager) this.messageQueueManager.timerExpired = v;
    }

    processMessage(message) {
        // Delegate actual injection to the message queue manager.
        if (this.messageQueueManager && typeof this.messageQueueManager.injectNextMessage === 'function') {
            this.messageQueueManager.injectNextMessage();
        }
    }

    cleanup() {
        // Dispose all terminals
        this.terminals.forEach(terminalData => {
            terminalData.terminal.dispose();
        });
        this.terminals.clear();
        
        // Clean up managers
        this.eventBus.removeAllListeners();
        
        console.log('🧹 TerminalGUI cleanup completed');
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('📄 DOMContentLoaded - Initializing TerminalGUI...');
    
    try {
        const gui = new TerminalGUI();
        console.log('✅ TerminalGUI created successfully');
    } catch (error) {
        console.error('❌ Failed to initialize TerminalGUI:', error);
        
        // Hide loading screen even on error
        const loadingModal = document.getElementById('loading-modal');
        if (loadingModal) {
            loadingModal.style.display = 'none';
        }
    }
});