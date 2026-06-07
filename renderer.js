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
                        terminalId: this.activeTerminalId
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
    
    createTerminal() {
        const terminalId = this.terminalManager.terminalIdCounter++;
        
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
        
        // Create container
        const container = document.createElement('div');
        container.className = 'terminal-wrapper';
        container.dataset.terminalId = terminalId;
        
        const terminalsContainer = document.getElementById('terminals-container');
        if (terminalsContainer) {
            terminalsContainer.appendChild(container);
        }
        
        // Open terminal
        terminal.open(container);
        fitAddon.fit();
        
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
            directory: process.cwd()
        });
        
        // Spawn the PTY in main (channel + payload shape match main.js's handler)
        ipcRenderer.send('terminal-start', { terminalId, directory: null });
        
        // Set as active
        this.setActiveTerminal(terminalId);
        
        // Emit event
        this.eventBus.emit('terminal:created', { terminalId });
        
        console.log(`✅ Terminal ${terminalId} created`);
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
        
        // Emit event
        this.eventBus.emit('terminal:active', { terminalId });
    }
    
    finalizeInitialization() {
        // Create initial terminal
        this.createTerminal();
        
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