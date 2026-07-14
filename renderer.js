const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const { WebglAddon } = require('@xterm/addon-webgl');

// Import core modules
const EventBus = require('./src/core/EventBus');
const EventProcessors = require('./src/core/EventProcessors');
const TerminalManager = require('./src/core/terminal-manager');
const { AppStateStore } = require('./src/state/AppStateStore');
const { StateManager } = require('./src/state/StateManager');
const TerminalStateManager = require('./src/state/TerminalStateManager');

// Import messaging
const MessageQueueManager = require('./src/messaging/MessageQueueManager');

// Import feature managers
const StatusManager = require('./src/features/StatusManager');
const NotificationManager = require('./src/features/NotificationManager');
const UsageLimitManager = require('./src/features/UsageLimitManager');
const VoiceManager = require('./src/features/VoiceManager');
const SoundManager = require('./src/features/SoundManager');
const PreferenceManager = require('./src/features/PreferenceManager');
const TimerManager = require('./src/features/TimerManager');
const ActionLogManager = require('./src/features/ActionLogManager');
const ManagerInstance = require('./src/features/ManagerInstance');
const PromptWatchManager = require('./src/features/PromptWatchManager');
const WakeWordManager = require('./src/features/WakeWordManager');
const RemoteMicSink = require('./src/features/RemoteMicSink');
const DiscordLinkKeyManager = require('./src/features/DiscordLinkKeyManager');
const RemoteConnectionUI = require('./src/features/RemoteConnectionUI');
const UIFocusManager = require('./src/ui/UIFocusManager');

// Import utilities
const { parseUsageLimitMessage } = require('./src/utils/usage-limit-parser');
const { BACKEND_URL } = require('./src/utils/backend-url');

// Remote Mode (docs/REMOTE_MODE.md): when this same renderer runs in a browser
// tab served by RemoteServer, remote-bootstrap.js sets this flag. A remote
// renderer is a fully interactive VIEW — it renders everything and sends
// inputs — but must NOT re-run the authoritative singletons that exist once in
// the local Electron window (injection engine, manager scheduler, state
// snapshot mirror, DB persistence), or it would double-drive them.
const IS_REMOTE = typeof window !== 'undefined' && !!window.__CCBOT_REMOTE__;

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

        // Stable per-terminal color palette. A terminal's color tints its header
        // dot AND its queued messages; the manager (999) is always yellow.
        this.terminalColorPalette = [
            '#007acc', '#28ca42', '#ff5f57', '#ffbe2e',
            '#af52de', '#5ac8fa', '#ff8c00', '#00c2a8'
        ];

        console.log('💻 Terminal system initialized');
    }
    
    initializeMessaging() {
        // Create message queue manager with explicit dependencies and an ipc
        // wrapper (no longer coupled to the renderer "context" object).
        this.messageQueueManager = new MessageQueueManager(
            this.eventBus,
            this.appStateStore,
            this.terminalStateManager,
            this.ipcHandler
        );

        console.log('📨 Messaging system initialized');
    }
    
    initializeFeatures() {
        // Initialize all feature managers
        this.statusManager = new StatusManager(this.eventBus, this.appStateStore);
        this.notificationManager = new NotificationManager(this.eventBus, this.appStateStore);
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

        // Watches for worker terminals opening a real interactive prompt/menu
        // and pushes an "awaiting input" note to the manager (999). Subscribes
        // to terminal:status:changed on construction.
        this.promptWatchManager = new PromptWatchManager(this.eventBus, this.appStateStore, this);

        // Always-on "Hey Claude" wake word → records a command → routes it to
        // the manager (999) as a voice memo. Off until enabled in settings.
        this.wakeWordManager = new WakeWordManager(this.eventBus, this.appStateStore, this);

        // Remote client microphone forwarding (docs/REMOTE_MODE.md §10): a
        // Remote Mode viewer's mic streams over the WS into THIS renderer's
        // wake-word + Whisper pipeline. LOCAL renderer only — a remote view
        // has no pipeline of its own (it is the microphone, not the brain).
        if (!IS_REMOTE) {
            this.remoteMicSink = new RemoteMicSink(this.eventBus, this);
            this.remoteMicSink.initialize();
        }

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

        // Load persisted settings from the DB and apply them. Without this,
        // PreferenceManager runs on constructor defaults forever — saved
        // settings never load and toggles don't survive a restart. (Async;
        // applyLoadedPreferences reflects values onto controls once loaded.)
        this.preferenceManager.initialize();

        // Wire centralized event processors onto the EventBus (fix 8).
        this.setupEventProcessors();

        // Remote-SSH style client (the bottom-left corner indicator): connect
        // to another machine's Remote Mode over the user's own ssh and embed
        // its full interface in-app. LOCAL desktop app only — a remote browser
        // view must not offer a nested remote hop.
        if (!IS_REMOTE) {
            this.remoteConnectionUI = new RemoteConnectionUI(this.ipcHandler);
            this.remoteConnectionUI.initialize();
        }

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

        // Wire drag-to-resize on the left/right sidebars
        this.setupSidebarResizing();

        console.log('🖼️ UI initialized');
    }

    /**
     * Drag-to-resize for the left (action-log) and right sidebars. The
     * resize-handle divs existed in index.html but were never wired to any
     * drag logic, and the PreferenceManager's `sidebar:resize` event (carrying
     * persisted widths) had no listener - so resizing silently did nothing.
     * This binds both: live drag updates the element width + persists via
     * PreferenceManager.updateSidebarWidth, and `sidebar:resize` applies the
     * stored widths on load.
     */
    setupSidebarResizing() {
        // Range matches the sidebars' CSS min/max-width; per-side CSS min-width
        // (left 200, right 300) still enforces sensible floors.
        const MIN = 200, MAX = 700;
        const clamp = (w) => Math.max(MIN, Math.min(MAX, w));

        const leftSidebar = document.getElementById('action-log-sidebar');
        const rightSidebar = document.getElementById('right-sidebar');

        // Apply persisted widths when PreferenceManager loads them.
        this.eventBus.on('sidebar:resize', ({ left, right }) => {
            if (left && leftSidebar) leftSidebar.style.width = `${clamp(left)}px`;
            if (right && rightSidebar) rightSidebar.style.width = `${clamp(right)}px`;
        });

        // The Manager terminal lives in the LEFT sidebar tab, so widening that
        // sidebar must refit it (the grid refit path deliberately skips 999).
        const fitManager = () => {
            const mgr = this.terminals.get(ManagerInstance.TERMINAL_ID);
            const view = document.getElementById('manager-view');
            if (mgr && view && view.style.display !== 'none') {
                try { mgr.fitAddon.fit(); } catch { /* not laid out */ }
            }
        };

        const wireHandle = (handleId, sidebar, side) => {
            const handle = document.getElementById(handleId);
            if (!handle || !sidebar) return;
            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                // The left sidebar grows rightward from its left edge; the right
                // sidebar grows leftward from its right edge. Compute width from
                // the fixed edge so the cursor tracks the handle exactly.
                const rect = sidebar.getBoundingClientRect();
                const fixedEdge = side === 'left' ? rect.left : rect.right;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';

                const onMove = (ev) => {
                    const width = clamp(side === 'left'
                        ? ev.clientX - fixedEdge
                        : fixedEdge - ev.clientX);
                    sidebar.style.width = `${width}px`;
                    if (side === 'left') fitManager(); // live-refit the manager terminal
                };
                const onUp = (ev) => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                    const width = clamp(side === 'left'
                        ? ev.clientX - fixedEdge
                        : fixedEdge - ev.clientX);
                    if (this.preferenceManager) this.preferenceManager.updateSidebarWidth(side, width);
                    // Terminals reflow when the grid area changes size.
                    this.eventBus.emit('terminals:refit');
                    if (side === 'left') fitManager();
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        };

        wireHandle('resize-handle-left', leftSidebar, 'left');
        wireHandle('resize-handle-right', rightSidebar, 'right');
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

                // 'always' forces the viewport down on every output; 'smart'
                // (default) is xterm's native behavior — follow only when
                // already at the bottom.
                if (this.appStateStore.getState('settings.terminalScrollBehavior') === 'always') {
                    try { terminalData.terminal.scrollToBottom(); } catch { /* disposed */ }
                }

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
                // message to 1-2 sentences (costs quota - off by default).
                // Local renderer only: a remote browser invoking this too
                // would run (and bill) the summarizer twice per completion.
                if (!IS_REMOTE && this.appStateStore.getState('summarizeCompletions') && completionData.sessionId) {
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

        // Ground-truth PTY runtime (claude | shell | unknown), pushed from main's
        // /proc watcher. Stored on the terminal so the injection gate can refuse
        // to leak a prompt into a bare shell (P4 leak-guard).
        ipcRenderer.on('terminal-runtime', (event, { terminalId, runtime }) => {
            if (!this.terminals.has(terminalId)) return;
            this.terminalStateManager.updateTerminal(terminalId, { runtime });
        });

        // PTY spawn failure after all retries — surface it in the log and mark
        // the terminal errored (main sends this; it was previously dropped).
        ipcRenderer.on('terminal-error', (event, { terminalId, error }) => {
            this.eventBus.emit('log:action', {
                message: `Terminal ${terminalId} failed to start: ${error}`,
                type: 'error'
            });
            const previousStatus = this.terminalStateManager.setTerminalStatus(terminalId, 'error');
            if (previousStatus !== null) {
                this.eventBus.emit('terminal:status:changed', {
                    terminalId,
                    status: 'error',
                    previousStatus,
                    source: 'ipc'
                });
            }
        });

        // Tray menu "Start/Stop Injection" — drive the master send switch
        ipcRenderer.on('tray-start-injection', () => {
            if (this.messageQueueManager.injectionPaused) this.toggleSending();
        });
        ipcRenderer.on('tray-stop-injection', () => {
            if (!this.messageQueueManager.injectionPaused) this.toggleSending();
        });

        // Renderer→main bridges: MessageQueueManager emits these on the event
        // bus; the main-process handlers already exist but nothing invoked them.
        this.eventBus.on('ui:tray-badge', ({ count }) => {
            ipcRenderer.invoke('update-tray-badge', count).catch(() => {});
        });
        this.eventBus.on('ui:system-notification', ({ title, body }) => {
            ipcRenderer.invoke('show-notification', title, body).catch(() => {});
        });
        this.eventBus.on('power:save-blocker:start', () => {
            ipcRenderer.invoke('start-power-save-blocker').catch(() => {});
        });
        this.eventBus.on('power:save-blocker:stop', () => {
            ipcRenderer.invoke('stop-power-save-blocker').catch(() => {});
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
        ipcRenderer.on('queue-add-request', (event, { terminalId, content, type }) => {
            // fromBroadcast: in a remote renderer this add is display-only (the
            // local renderer owns injection/persistence); in the local renderer
            // the flag is inert and this behaves exactly as before.
            this.messageQueueManager.addMessageToQueue(content, terminalId, type, { fromBroadcast: true });
            this.eventBus.emit('log:action', {
                message: `Queued ${type === 'urgent' ? 'URGENT ' : ''}message for Terminal ${terminalId} via control API`,
                type: 'info'
            });
        });

        // Cross-renderer topology sync (Remote Mode): another attached renderer
        // (local window or a remote browser) created/closed a terminal in main.
        // Build/drop a matching view here. The originator's own echo is skipped
        // by the has-check; closeTerminal's redundant terminal-close send is a
        // harmless no-op in main (the PTY is already gone).
        ipcRenderer.on('remote-terminal-created', (event, { terminalId, directory }) => {
            if (this.terminals.has(terminalId)) return;
            if (terminalId === ManagerInstance.TERMINAL_ID) return; // manager mounts via its own tab
            this.createTerminal({ id: terminalId, directory: directory || undefined, skipActive: true });
        });
        ipcRenderer.on('remote-terminal-closed', (event, { terminalId }) => {
            if (!this.terminals.has(terminalId)) return;
            this.closeTerminal(terminalId);
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
        // LOCAL renderer only: the local window owns the snapshot; a remote
        // browser pushing its (partial) view would corrupt main's cache. The
        // RemoteServer drops the channel server-side too (defense in depth).
        const sendStateSnapshot = () => {
            if (IS_REMOTE) return;
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
            // Full queue detail for GET /queue and the manager's edit endpoint.
            // Content is capped so the snapshot stays small on long messages.
            const queue = this.messageQueueManager.messageQueue.map((m) => ({
                id: m.id,
                terminalId: m.terminalId,
                type: m.type || 'normal',
                content: typeof m.content === 'string' && m.content.length > 2000
                    ? m.content.slice(0, 2000) + '…[truncated]'
                    : m.content
            }));
            ipcRenderer.send('ccbot-state-snapshot', {
                activeTerminalId: this.activeTerminalId,
                queuedMessages: queue.length,
                queue,
                terminals,
                updatedAt: Date.now()
            });
        };
        ['terminal:status:changed', 'terminal:directory', 'terminal:created', 'terminal:closed', 'message:queue-updated']
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

        // Empty-state "New terminal" button (shown when no visible terminals remain)
        const emptyNewBtn = document.getElementById('terminals-empty-new-btn');
        if (emptyNewBtn) {
            emptyNewBtn.addEventListener('click', () => this.createTerminal());
        }


        // Message queue controls
        const messageInput = document.getElementById('message-input');
        const sendButton = document.getElementById('send-btn');

        if (messageInput && sendButton) {
            // Auto-grow the textarea to fit its content (then scroll past the CSS
            // max-height). A textarea won't resize itself — we must measure
            // scrollHeight on each input. Reset to 'auto' first so it can also
            // SHRINK back as text is removed.
            const autoSizeInput = () => {
                messageInput.style.height = 'auto';
                messageInput.style.height = `${messageInput.scrollHeight}px`;
            };

            const handleAddMessage = () => {
                const message = messageInput.value.trim();
                // PTY injection is text-only, so attachments ride along as
                // absolute paths appended to the prompt text.
                const attachments = this.pendingAttachments || [];
                if (message || attachments.length) {
                    let content = message;
                    if (attachments.length) {
                        const list = attachments.map(a => a.path).join('\n');
                        content = content
                            ? `${content}\n\nAttached file(s):\n${list}`
                            : `Attached file(s):\n${list}`;
                    }
                    this.messageQueueManager.addMessage({
                        content,
                        // Selector choice wins; falls back to the active terminal
                        terminalId: this.queueTargetTerminalId ?? this.activeTerminalId
                    });
                    messageInput.value = '';
                    this.clearAttachments();
                    autoSizeInput(); // collapse back to one row after sending
                }
            };

            messageInput.addEventListener('input', autoSizeInput);
            autoSizeInput(); // set the correct initial height

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
            // User took manual control of the timer — stop the usage-limit
            // auto-sync so it doesn't fight their edit.
            this.eventBus.emit('timer:manual-change', { hours: h, minutes: min, seconds: s });
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
                    if (data.id === ManagerInstance.TERMINAL_ID) return; // fits via its sidebar tab
                    if (!data.container.classList.contains('manager-hidden')) {
                        try { data.fitAddon.fit(); } catch { /* not yet laid out */ }
                    }
                });
            });
        };
        window.addEventListener('resize', refitVisibleTerminals);
        // Explicit refit requests (e.g. after a sidebar drag-resize) reflow the
        // grid too — previously this event was emitted but never listened to.
        this.eventBus.on('terminals:refit', refitVisibleTerminals);
        // Showing/hiding the manager changes the visible set → re-chunk the grid.
        // (create/close already relayout inline.)
        this.eventBus.on('manager:visibility', () => this.relayoutTerminals());

        // Persist terminal metadata (name/dir/color) whenever it changes so the
        // workspace survives a restart. directory updates come from Claude hooks.
        ['terminal:created', 'terminal:closed', 'terminal:metadata', 'terminal:directory']
            .forEach((evt) => this.eventBus.on(evt, () => this.persistTerminalMetadata()));

        // Keep the Status panel's Directory live when the selected terminal's
        // cwd changes (cwd hook → terminal:directory).
        this.eventBus.on('terminal:directory', ({ terminalId }) => {
            if (terminalId === this.activeTerminalId) this.updateStatusBar(terminalId);
        });

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

        // Global keyboard shortcuts. The old EventBus.setupKeyboardShortcuts()
        // was never called, so every data-hotkey button (Cmd+T, Cmd+I, …) was
        // dead. Map the modifier combos to actions here. (Cmd+F / Cmd+K stay
        // with UIFocusManager, which owns search + the terminal selector.)
        document.addEventListener('keydown', (e) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            const key = e.key.toLowerCase();
            const shift = e.shiftKey;
            const click = (id) => { const el = document.getElementById(id); if (el) el.click(); };

            if (key === 't' && !shift) { e.preventDefault(); this.createTerminal(); }
            else if (key === 'w' && shift) {
                e.preventDefault();
                if (this.activeTerminalId != null && this.activeTerminalId !== ManagerInstance.TERMINAL_ID) {
                    this.closeTerminal(this.activeTerminalId);
                }
            }
            else if (key === 'i' && !shift) { e.preventDefault(); this.messageQueueManager.injectNextMessage(); }
            else if (key === 'p' && !shift) { e.preventDefault(); this.timerManager.toggleTimer(); }
            else if (key === 's' && !shift) { e.preventDefault(); click('settings-btn'); }
            else if (key === 'm' && !shift) { e.preventDefault(); click('manager-nav-btn'); }
            else if (key === 'h' && shift) { e.preventDefault(); click('message-history-btn'); }
            else if (key === 'l' && shift) { e.preventDefault(); click('clear-log-btn'); }
            // Terminal search: Cmd+F (mac) or Ctrl+Shift+F (bare Ctrl+F would
            // shadow readline's forward-char inside the PTY).
            else if (key === 'f' && (e.metaKey || shift)) {
                e.preventDefault();
                this.toggleTerminalSearch(this.activeTerminalId);
            }
        });

        this.setupFileAttachments();

        console.log('🎮 DOM event handlers configured');
    }

    /**
     * File attach: drag-drop onto the input area, paste-image, and the hidden
     * #file-input. Files become absolute-path references appended to the
     * message (PTY injection is text-only); pasted images are saved to disk
     * first via the existing save-screenshot IPC.
     */
    setupFileAttachments() {
        this.pendingAttachments = [];
        const dropZone = document.getElementById('drop-zone');
        const dropOverlay = document.getElementById('drop-overlay');
        const fileInput = document.getElementById('file-input');
        const messageInput = document.getElementById('message-input');

        const attachDiskFile = (name, absPath) => {
            if (!absPath) return;
            if (this.pendingAttachments.some(a => a.path === absPath)) return;
            this.pendingAttachments.push({ name: name || absPath.split('/').pop(), path: absPath });
            this.renderAttachmentChips();
        };

        const attachFiles = async (fileList) => {
            for (const file of Array.from(fileList || [])) {
                if (file.path) {
                    // Real disk file (Electron exposes the absolute path)
                    attachDiskFile(file.name, file.path);
                } else if (file.type && file.type.startsWith('image/')) {
                    // Clipboard-pasted image blob — persist it first
                    try {
                        const dataUrl = await new Promise((resolve, reject) => {
                            const r = new FileReader();
                            r.onload = () => resolve(r.result);
                            r.onerror = reject;
                            r.readAsDataURL(file);
                        });
                        const res = await this.ipcHandler.invoke('save-screenshot', dataUrl);
                        if (res && res.success) attachDiskFile(res.fileName, res.filePath);
                        else this.eventBus.emit('log:action', { message: `Could not save pasted image: ${res && res.error}`, type: 'error' });
                    } catch (err) {
                        this.eventBus.emit('log:action', { message: `Could not save pasted image: ${err.message}`, type: 'error' });
                    }
                }
            }
        };

        if (dropZone) {
            let dragDepth = 0;
            const showOverlay = (on) => { if (dropOverlay) dropOverlay.style.display = on ? '' : 'none'; };
            dropZone.addEventListener('dragenter', (e) => {
                e.preventDefault(); dragDepth++; showOverlay(true);
            });
            dropZone.addEventListener('dragover', (e) => e.preventDefault());
            dropZone.addEventListener('dragleave', () => {
                dragDepth = Math.max(0, dragDepth - 1);
                if (!dragDepth) showOverlay(false);
            });
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault(); dragDepth = 0; showOverlay(false);
                attachFiles(e.dataTransfer && e.dataTransfer.files);
            });
        }

        if (messageInput) {
            messageInput.addEventListener('paste', (e) => {
                const items = e.clipboardData && e.clipboardData.items;
                if (!items) return;
                const files = [];
                for (const item of items) {
                    if (item.kind === 'file') {
                        const f = item.getAsFile();
                        if (f) files.push(f);
                    }
                }
                if (files.length) { e.preventDefault(); attachFiles(files); }
            });
        }

        if (fileInput) {
            fileInput.addEventListener('change', () => {
                attachFiles(fileInput.files);
                fileInput.value = '';
            });
        }
    }

    renderAttachmentChips() {
        const container = document.getElementById('image-preview-container');
        const list = document.getElementById('image-preview-list');
        if (!container || !list) return;
        list.innerHTML = '';
        this.pendingAttachments.forEach((att, i) => {
            const chip = document.createElement('div');
            chip.className = 'attachment-chip';
            const name = document.createElement('span');
            name.textContent = att.name;
            name.title = att.path;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.title = 'Remove attachment';
            remove.addEventListener('click', () => {
                this.pendingAttachments.splice(i, 1);
                this.renderAttachmentChips();
            });
            chip.appendChild(name);
            chip.appendChild(remove);
            list.appendChild(chip);
        });
        container.style.display = this.pendingAttachments.length ? '' : 'none';
    }

    clearAttachments() {
        this.pendingAttachments = [];
        this.renderAttachmentChips();
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

                const item = document.createElement('button');
                item.className = 'terminal-selector-item';
                item.dataset.terminalId = id;

                const dot = document.createElement('span');
                dot.className = 'terminal-selector-dot';
                dot.style.backgroundColor = this.terminalColorFor(id);

                const label = document.createElement('span');
                label.textContent = this.terminalNameFor(id);

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
        if (text) text.textContent = this.terminalNameFor(terminalId);
        if (dot) dot.style.backgroundColor = this.terminalColorFor(terminalId);
    }

    setupTerminalUI() {
        // Terminal tab handlers
        const terminalsContainer = document.getElementById('terminals-container');
        const idFromHeader = (el) => {
            const wrapper = el.closest('.terminal-wrapper');
            const id = wrapper && parseInt(wrapper.dataset.terminalId, 10);
            return Number.isFinite(id) ? id : null;
        };
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

                // Click the header color dot to recolor the terminal.
                const dot = e.target.closest('.terminal-color-dot');
                if (dot) {
                    const terminalId = idFromHeader(dot);
                    if (terminalId != null) this.openColorPicker(terminalId);
                }
            });

            // Double-click an editable title to rename the terminal.
            terminalsContainer.addEventListener('dblclick', (e) => {
                const titleEl = e.target.closest('.terminal-title.editable');
                if (!titleEl) return;
                const terminalId = idFromHeader(titleEl);
                if (terminalId != null) this.beginTitleEdit(titleEl, terminalId);
            });

            // Shift + mouse wheel pages the terminal grid horizontally. Without
            // this, a wheel event over a terminal is swallowed by xterm's own
            // scrollback handler and never reaches the container. Capture phase +
            // stopPropagation run before xterm so the gesture moves the grid.
            //
            // The grid uses `scroll-snap-type: x mandatory` with each chunk a
            // full-width (100%) snap point, so a sub-page scrollLeft nudge just
            // snaps straight back — we must advance a whole page (clientWidth) to
            // land on the next chunk. Throttled so one wheel gesture's momentum
            // doesn't skip several pages. No-op when the grid isn't horizontally
            // scrollable (e.g. a single chunk), letting normal behaviour through.
            let lastGridPageScroll = 0;
            terminalsContainer.addEventListener('wheel', (e) => {
                if (!e.shiftKey) return;
                if (terminalsContainer.scrollWidth <= terminalsContainer.clientWidth) return;
                e.preventDefault();
                e.stopPropagation();
                const dir = Math.sign(e.deltaY || e.deltaX);
                if (!dir) return;
                if (e.timeStamp - lastGridPageScroll < 350) return; // ignore momentum after the first notch
                lastGridPageScroll = e.timeStamp;
                terminalsContainer.scrollBy({ left: dir * terminalsContainer.clientWidth, behavior: 'smooth' });
            }, { passive: false, capture: true });
        }

        // Wire the secondary UI the thin refactor left unconnected.
        this.setupSecondaryUI();
    }

    /**
     * Wire secondary controls whose DOM exists in index.html but were never
     * connected by the refactored renderer: settings modal, voice recording,
     * hotkey dropdown, and pricing.
     */
    setupSecondaryUI() {
        // ---- Settings modal ----
        const settingsBtn = document.getElementById('settings-btn');
        const settingsModal = document.getElementById('settings-modal');
        const settingsClose = document.getElementById('settings-close');
        // Discord voice-bridge link-key widget (Settings → Discord Voice Bridge).
        if (!this.discordLinkKey) {
            this.discordLinkKey = new DiscordLinkKeyManager();
            this.discordLinkKey.init();
        }
        const openSettings = () => {
            if (settingsModal) settingsModal.classList.add('show');
            this.populateMicrophoneSelect();
            // Re-reflect saved voice/wake/delay values on open (covers round-trip:
            // change a setting, reopen, see the change; and any missed load event).
            if (this._syncVoiceSettingsForms) this._syncVoiceSettingsForms();
            // Pull the current, bridge-acceptable /link key each time Settings opens
            // so it never goes stale (e.g. after the control port rotates).
            if (this.discordLinkKey) this.discordLinkKey.refresh(false);
        };
        const closeSettings = () => { if (settingsModal) settingsModal.classList.remove('show'); };
        if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
        if (settingsClose) settingsClose.addEventListener('click', closeSettings);
        if (settingsModal) settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });

        // ---- Message history modal ----
        // The modal markup, the MAX-bounded history array, and the store IPC all
        // existed, but nothing opened the modal or rendered the list — so history
        // was invisible. Wire open/close/clear + render here.
        const historyBtn = document.getElementById('message-history-btn');
        const historyModal = document.getElementById('message-history-modal');
        const historyClose = document.getElementById('message-history-close');
        const clearHistoryBtn = document.getElementById('clear-history-btn');
        const historyList = document.getElementById('history-list');

        const renderHistory = () => {
            if (!historyList) return;
            const items = Array.from((this.messageQueueManager && this.messageQueueManager.messageHistory) || []);
            if (!items.length) {
                historyList.innerHTML = '<div class="history-empty"><p>No message history yet. Messages will appear here after they are successfully injected.</p></div>';
                return;
            }
            historyList.innerHTML = '';
            // newest first
            items.slice().reverse().forEach((item) => {
                const row = document.createElement('div');
                row.className = 'history-item';
                const when = item.injectedAt || item.timestamp;
                const meta = document.createElement('div');
                meta.className = 'history-item-meta';
                meta.textContent = [
                    (item.terminalId != null ? `Terminal ${item.terminalId}` : ''),
                    (when ? new Date(when).toLocaleString() : ''),
                ].filter(Boolean).join(' · ');
                const body = document.createElement('div');
                body.className = 'history-item-content';
                body.textContent = item.content || ''; // textContent = XSS-safe
                row.appendChild(meta);
                row.appendChild(body);
                historyList.appendChild(row);
            });
        };

        const openHistory = () => { if (historyModal) { renderHistory(); historyModal.classList.add('show'); } };
        const closeHistory = () => { if (historyModal) historyModal.classList.remove('show'); };
        if (historyBtn) historyBtn.addEventListener('click', openHistory);
        if (historyClose) historyClose.addEventListener('click', closeHistory);
        if (historyModal) historyModal.addEventListener('click', (e) => { if (e.target === historyModal) closeHistory(); });
        if (clearHistoryBtn) clearHistoryBtn.addEventListener('click', () => {
            this.messageQueueManager.clearMessageHistory();
            renderHistory();
        });
        // Live-refresh while the modal is open as new messages are injected.
        this.eventBus.on('message:history-updated', () => {
            if (historyModal && historyModal.classList.contains('show')) renderHistory();
        });

        // ---- Microphone picker (settings modal) ----
        // Options are (re)enumerated on every settings open; the choice persists
        // as the 'microphoneDeviceId' preference, which VoiceManager listens for.
        //
        // REMOTE view: the picker lists the VIEWING browser's inputs, so the
        // choice is per-device — persisted in this browser's localStorage and fed
        // to the remote-mic forwarder + the local VoiceManager instance. It must
        // NEVER be written to the shared 'microphoneDeviceId' preference: that
        // would clobber the desktop's own mic choice with a device id that only
        // exists on the viewer's machine.
        const micSelect = document.getElementById('microphone-select');
        if (micSelect) {
            micSelect.addEventListener('change', () => {
                if (IS_REMOTE) {
                    const v = micSelect.value;
                    // 'off' only stops the wake stream; the manual voice button
                    // keeps recording from the browser default (never 'off' as
                    // a device id — that would OverconstrainedError getUserMedia).
                    if (this.voiceManager) this.voiceManager.setMicrophoneDevice(v === 'off' ? 'default' : v);
                    const rm = window.__ccbotRemoteMic;
                    if (rm && typeof rm.setDevice === 'function') {
                        // (Re)starts the mic stream on that device — wake word +
                        // voice pipeline now listen to THIS machine's mic.
                        rm.setDevice(v).catch(() => {});
                    } else {
                        try { window.localStorage.setItem('ccbotRemoteMicDeviceId', v); } catch (_) { /* ignore */ }
                    }
                    return;
                }
                this.preferenceManager.updatePreference('microphoneDeviceId', micSelect.value);
            });
        }
        if (IS_REMOTE && this.voiceManager) {
            // Boot: restore this browser's saved input so the voice button
            // records from the right mic without reopening Settings.
            try {
                const savedRemoteMic = window.localStorage.getItem('ccbotRemoteMicDeviceId');
                if (savedRemoteMic && savedRemoteMic !== 'off') this.voiceManager.setMicrophoneDevice(savedRemoteMic);
            } catch (_) { /* private mode */ }
        }

        // ---- Queue send delay (injectionDelayMs) ----
        // Delay after a terminal becomes free before its next queued message is
        // auto-injected; consumed by MessageQueueManager._finishInjection.
        const injDelay = document.getElementById('injection-delay-ms');
        const injDelayVal = document.getElementById('injection-delay-value');
        const syncInjDelay = () => {
            const ms = this.preferenceManager.preferences.injectionDelayMs;
            const v = ms != null ? ms : 400;
            if (injDelay) injDelay.value = v;
            if (injDelayVal) injDelayVal.textContent = `${(v / 1000).toFixed(1)}s`;
        };
        syncInjDelay();
        if (injDelay) injDelay.addEventListener('input', () => {
            const v = parseInt(injDelay.value, 10);
            if (injDelayVal) injDelayVal.textContent = `${(v / 1000).toFixed(1)}s`;
            this.preferenceManager.updatePreference('injectionDelayMs', v);
        });

        // ---- Wake word ("Hey Claude") ----
        const wakeEnabled = document.getElementById('wake-word-enabled');
        const wakePhrase = document.getElementById('wake-word-phrase');
        const wakeSilence = document.getElementById('wake-silence-ms');
        const wakeSilenceVal = document.getElementById('wake-silence-value');
        const wakeThreshold = document.getElementById('wake-threshold');
        const wakeThresholdVal = document.getElementById('wake-threshold-value');
        const wakeActSound = document.getElementById('wake-activation-sound');
        const wakeStopSound = document.getElementById('wake-stop-sound');
        const wakeMuteDuringCall = document.getElementById('wake-mute-during-call');

        // Reflect persisted prefs into the controls when the settings open.
        const syncWakeUI = () => {
            const p = this.preferenceManager.preferences;
            if (wakeEnabled) wakeEnabled.checked = !!p.wakeWordEnabled;
            if (wakeMuteDuringCall) wakeMuteDuringCall.checked = !!p.wakeMuteDuringCall;
            if (wakePhrase) wakePhrase.value = p.wakeWordPhrase || 'hey claude';
            if (wakeSilence) wakeSilence.value = p.wakeSilenceMs || 5000;
            if (wakeSilenceVal) wakeSilenceVal.textContent = `${((p.wakeSilenceMs || 5000) / 1000).toFixed(1)}s`;
            const thr = p.wakeMatchThreshold != null ? p.wakeMatchThreshold : 0.75;
            if (wakeThreshold) wakeThreshold.value = thr;
            if (wakeThresholdVal) wakeThresholdVal.textContent = `${Math.round(thr * 100)}%`;
            // Reflect the persisted wake sound choices too, but only once their
            // <option>s exist (they're populated asynchronously below).
            if (wakeActSound && wakeActSound.options.length) wakeActSound.value = p.wakeActivationSound || 'screenshot.wav';
            if (wakeStopSound && wakeStopSound.options.length) wakeStopSound.value = p.wakeStopSound || 'hud4.wav';
        };
        // Populate the sound dropdowns from the real soundeffects folder, then
        // select the persisted choices (falling back to the fixed defaults).
        ipcRenderer.invoke('get-sound-effects').then((files) => {
            const list = Array.isArray(files) ? files : [];
            [[wakeActSound, 'wakeActivationSound', 'screenshot.wav'], [wakeStopSound, 'wakeStopSound', 'hud4.wav']]
                .forEach(([sel, key, def]) => {
                    if (!sel) return;
                    const chosen = this.preferenceManager.preferences[key] || def;
                    sel.innerHTML = '';
                    (list.length ? list : [def]).forEach((f) => {
                        const o = document.createElement('option');
                        o.value = f; o.textContent = f;
                        if (f === chosen) o.selected = true;
                        sel.appendChild(o);
                    });
                });
        }).catch(() => {});
        syncWakeUI();

        // The saved values arrive asynchronously — preferenceManager.initialize()
        // (the DB load) runs AFTER this wiring and is not awaited, so the first
        // syncWakeUI()/syncInjDelay() above read constructor defaults. Without
        // re-reflecting, the form stayed frozen on the hardcoded HTML defaults
        // (e.g. the wake phrase showed "hey claude" while detection used the real
        // saved phrase). Re-reflect every voice/wake/delay control both when the
        // persisted prefs finish loading and on each settings-modal open, so the
        // form always shows what the system actually uses.
        this._syncVoiceSettingsForms = () => { syncWakeUI(); syncInjDelay(); };
        this.eventBus.on('preferences:applied', () => this._syncVoiceSettingsForms());

        if (wakeEnabled) wakeEnabled.addEventListener('change', () => {
            this.preferenceManager.updatePreference('wakeWordEnabled', wakeEnabled.checked);
        });
        if (wakeMuteDuringCall) wakeMuteDuringCall.addEventListener('change', () => {
            this.preferenceManager.updatePreference('wakeMuteDuringCall', wakeMuteDuringCall.checked);
        });
        if (wakePhrase) wakePhrase.addEventListener('change', () => {
            const v = wakePhrase.value.trim().toLowerCase() || 'hey claude';
            wakePhrase.value = v;
            this.preferenceManager.updatePreference('wakeWordPhrase', v);
        });
        if (wakeSilence) wakeSilence.addEventListener('input', () => {
            if (wakeSilenceVal) wakeSilenceVal.textContent = `${(wakeSilence.value / 1000).toFixed(1)}s`;
            this.preferenceManager.updatePreference('wakeSilenceMs', parseInt(wakeSilence.value, 10));
        });
        if (wakeThreshold) wakeThreshold.addEventListener('input', () => {
            const v = parseFloat(wakeThreshold.value);
            if (wakeThresholdVal) wakeThresholdVal.textContent = `${Math.round(v * 100)}%`;
            this.preferenceManager.updatePreference('wakeMatchThreshold', v);
        });
        if (wakeActSound) wakeActSound.addEventListener('change', () => {
            this.preferenceManager.updatePreference('wakeActivationSound', wakeActSound.value);
        });
        if (wakeStopSound) wakeStopSound.addEventListener('change', () => {
            this.preferenceManager.updatePreference('wakeStopSound', wakeStopSound.value);
        });

        // ---- Voice recording ----
        const voiceBtn = document.getElementById('voice-btn');
        if (voiceBtn) {
            // VoiceManager fetches the transcribe URL directly; give it a
            // truthy client so its internal guard passes, and activate it.
            this.voiceManager.setBackendClient({ baseUrl: BACKEND_URL });
            this.voiceManager.initialize();
            voiceBtn.addEventListener('click', () => {
                // Branch on the button's current state. While the wake-word system
                // is mid-capture (YELLOW / wake-listening), a tap CANCELS that
                // capture — nothing is transcribed or sent — and must NOT also fall
                // through to start a manual recording. The normal and red-recording
                // cases are unchanged and handled by the 'voice:toggle' flow.
                if (this.wakeWordManager && this.wakeWordManager.isCapturing && this.wakeWordManager.isCapturing()) {
                    this.wakeWordManager.cancelCapture();
                    return;
                }
                this.eventBus.emit('voice:toggle');
            });
            // Reflect recording/processing state on the button
            this.eventBus.on('voice:button-state', (state) => {
                voiceBtn.classList.toggle('recording', state === 'recording');
                voiceBtn.classList.toggle('processing', state === 'processing');
            });
            // Reflect wake-word (auto) listening state on the same button, but with
            // a YELLOW path independent of the manual red 'recording' path:
            //   capturing    -> yellow glow (wake-listening), no spinner
            //   transcribing -> reuse the manual blue spinner (.processing)
            //   listening/idle/error -> back to normal (clear both)
            this.eventBus.on('wake:state', ({ state } = {}) => {
                const capturing = state === 'capturing';
                const transcribing = state === 'transcribing';
                voiceBtn.classList.toggle('wake-listening', capturing);
                voiceBtn.classList.toggle('processing', transcribing);
            });
            // Drop transcribed text into the message input
            this.eventBus.on('voice:insert-text', (text) => {
                const input = document.getElementById('message-input');
                if (input && text) {
                    input.value = (input.value ? input.value + ' ' : '') + text;
                    input.focus();
                }
            });
        }

        // ---- Hotkey dropdown (keyboard button) ----
        const hotkeyBtn = document.getElementById('hotkey-btn');
        const hotkeyDropdown = document.getElementById('hotkey-dropdown');
        if (hotkeyBtn && hotkeyDropdown) {
            hotkeyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const willShow = !hotkeyDropdown.classList.contains('show');
                hotkeyDropdown.classList.toggle('show', willShow);
                // The dropdown is position:fixed at body level with no anchor, so
                // without this it opened in a random corner. Pin it just above
                // the button (the input bar lives at the bottom), right-aligned.
                if (willShow) {
                    const r = hotkeyBtn.getBoundingClientRect();
                    hotkeyDropdown.style.left = 'auto';
                    hotkeyDropdown.style.top = 'auto';
                    hotkeyDropdown.style.right = `${Math.round(window.innerWidth - r.right)}px`;
                    hotkeyDropdown.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
                }
            });
            hotkeyDropdown.addEventListener('click', (e) => {
                const item = e.target.closest('.hotkey-item');
                if (!item) return;
                // Don't fire at the PTY — compose the command INTO the message as
                // a readable `[[Label]]` token. It's translated to the real control
                // bytes when the message is injected (MessageQueueManager). The
                // user sends when ready; nothing is auto-sent.
                const label = (item.querySelector('.hotkey-label')?.textContent || '').trim();
                const input = document.getElementById('message-input');
                if (label && input) {
                    const token = `[[${label}]]`;
                    const start = input.selectionStart ?? input.value.length;
                    const end = input.selectionEnd ?? input.value.length;
                    input.value = input.value.slice(0, start) + token + input.value.slice(end);
                    const caret = start + token.length;
                    input.setSelectionRange(caret, caret);
                    input.focus();
                    input.dispatchEvent(new Event('input', { bubbles: true })); // resize/observers
                }
                hotkeyDropdown.classList.remove('show');
            });
            document.addEventListener('click', () => hotkeyDropdown.classList.remove('show'));
        }

        // ---- Message priority selector ----
        // An icon button that opens a small panel of priorities (each with its
        // own icon). Picking one stores it on the queue manager; user-entered
        // messages fall back to it (createMessageObject). Default: normal.
        const priorityBtn = document.getElementById('message-priority-btn');
        const priorityMenu = document.getElementById('priority-menu');
        if (priorityBtn && priorityMenu) {
            const COLORS = {
                normal: 'var(--text-tertiary)',
                urgent: 'var(--accent-danger, #ff5f57)'
            };
            const LABELS = { normal: 'Normal', urgent: 'Urgent' };
            const applyPriority = (type) => {
                const t = COLORS[type] ? type : 'normal';
                this.messageQueueManager.setSelectedMessageType(t);
                priorityBtn.dataset.priority = t;
                priorityBtn.style.color = COLORS[t];
                priorityBtn.title = `Message priority: ${LABELS[t]}`;
                priorityMenu.querySelectorAll('.priority-option').forEach((opt) => {
                    opt.classList.toggle('active', opt.dataset.priority === t);
                });
            };
            priorityBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                priorityMenu.classList.toggle('open');
            });
            priorityMenu.addEventListener('click', (e) => {
                const opt = e.target.closest('.priority-option');
                if (!opt) return;
                e.stopPropagation();
                applyPriority(opt.dataset.priority);
                priorityMenu.classList.remove('open');
            });
            document.addEventListener('click', () => priorityMenu.classList.remove('open'));
            applyPriority('normal');
        }

        // ---- Pricing / token usage ----
        const pricingRefresh = document.getElementById('pricing-refresh-btn');
        const pricingRetry = document.getElementById('pricing-retry-btn');
        const loadPricing = () => this.loadPricingData();
        if (pricingRefresh) pricingRefresh.addEventListener('click', loadPricing);
        if (pricingRetry) pricingRetry.addEventListener('click', loadPricing);
        // Load when the pricing view is first shown
        this.eventBus.on('ui:sidebar-view-changed', ({ viewId }) => {
            if (viewId === 'pricing-view' && !this._pricingLoaded) {
                this._pricingLoaded = true;
                loadPricing();
            }
        });
    }

    /**
     * Fill the settings-modal microphone <select> with the machine's audio
     * inputs. Device labels are only exposed after mic permission has been
     * granted, so a short throwaway stream is opened first (Electron grants
     * this without prompting); without it every option would read
     * "Microphone N". Runs on every settings open so plugged/unplugged
     * devices show up.
     */
    async populateMicrophoneSelect() {
        const micSelect = document.getElementById('microphone-select');
        if (!micSelect || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        try {
            try {
                const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
                tmp.getTracks().forEach(t => t.stop());
            } catch { /* no mic / denied — enumerate anyway, labels may be blank */ }

            const devices = await navigator.mediaDevices.enumerateDevices();
            const mics = devices.filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
            // enumerateDevices always describes the machine RUNNING this code —
            // the desktop locally, the viewer's own browser in Remote Mode. The
            // saved selection must come from the matching store: the shared
            // preference locally, this browser's localStorage remotely.
            let saved = 'default';
            if (IS_REMOTE) {
                // Unset = never opted in = not streaming — show that as Off.
                try { saved = window.localStorage.getItem('ccbotRemoteMicDeviceId') || 'off'; } catch (_) { saved = 'off'; }
            } else {
                saved = this.preferenceManager.getPreference('microphoneDeviceId') || 'default';
            }

            micSelect.innerHTML = '';
            if (IS_REMOTE) {
                // Remote view: picking a mic STARTS streaming it to the desktop
                // pipeline, so the picker needs an explicit way to stop — the
                // "Off" row (persisted; also blocks the auto-resume on reconnect).
                const offOpt = document.createElement('option');
                offOpt.value = 'off';
                offOpt.textContent = 'Off — don\'t stream this device\'s mic';
                micSelect.appendChild(offOpt);
            }
            const defOpt = document.createElement('option');
            defOpt.value = 'default';
            defOpt.textContent = 'System default';
            micSelect.appendChild(defOpt);
            mics.forEach((d, i) => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Microphone ${i + 1}`;
                micSelect.appendChild(opt);
            });
            // Re-select the saved device; if it vanished, fall back visually too.
            micSelect.value = saved;
            if (micSelect.value !== saved) micSelect.value = 'default';
        } catch (error) {
            console.error('Failed to enumerate microphones:', error);
        }
    }

    /** Fetch token usage/cost and populate the pricing view.
     *  ccusage runs in the MAIN process (host) via IPC, not the Docker backend —
     *  the container has no Node/npx and no ~/.claude logs, so the old
     *  `POST /api/ccusage/` always failed. See src/main/ccusage.js. */
    async loadPricingData() {
        const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
        show('pricing-loading', true); show('pricing-error', false); show('pricing-data', false);
        try {
            // Runs `npx ccusage` on the host; a cold run can download the package.
            const data = await this.ipcHandler.invoke('get-ccusage');
            if (!data || data.success === false) throw new Error((data && data.error) || 'pricing unavailable');
            const num = (v) => (typeof v === 'number' ? v : 0);
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
            set('daily-cost', `$${num(data.daily).toFixed(2)}`);
            set('weekly-cost', `$${num(data.weekly).toFixed(2)}`);
            set('total-cost', `$${num(data.total).toFixed(2)}`);
            set('receipt-total-cost', `$${num(data.total).toFixed(2)}`);

            // ccusage is a local-log ESTIMATE, not Anthropic billing. On a Pro/Max
            // plan the real charge is the flat subscription fee, so spell out that
            // these dollars are a notional "API-equivalent" cost.
            const dataEl = document.getElementById('pricing-data');
            if (dataEl && data.estimate && !dataEl.querySelector('.pricing-disclaimer')) {
                const note = document.createElement('p');
                note.className = 'pricing-disclaimer';
                note.textContent = 'Estimated from local Claude Code logs (ccusage). On a Pro/Max plan your real charge is the flat subscription fee — these figures are a notional API-equivalent cost.';
                dataEl.appendChild(note);
            }
            show('pricing-loading', false); show('pricing-data', true);
        } catch (err) {
            show('pricing-loading', false); show('pricing-error', true);
            const errText = document.querySelector('#pricing-error .error-text');
            if (errText) errText.textContent = `Pricing unavailable: ${err.message}. Needs Node/npx on PATH and a logged-in Claude Code (ccusage reads ~/.claude logs).`;
        }
    }

    /**
     * Wire a terminal's search overlay to its SearchAddon. The overlay existed
     * in the markup (and the addon was always loaded) but nothing bound them.
     */
    setupTerminalSearch(terminalData) {
        const { id, container, terminal, searchAddon } = terminalData;
        if (!container || !searchAddon) return;
        let overlay = container.querySelector('.terminal-search-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'terminal-search-overlay';
            overlay.dataset.terminalSearch = id;
            overlay.style.display = 'none';
            overlay.innerHTML = `
                <div class="search-bar">
                    <div class="search-input-wrapper">
                        <i class="search-icon" data-lucide="search"></i>
                        <input type="text" class="search-input" placeholder="Search in terminal..." />
                    </div>
                    <div class="search-controls">
                        <button class="search-btn search-prev" title="Previous match"><i data-lucide="chevron-up"></i></button>
                        <button class="search-btn search-next" title="Next match"><i data-lucide="chevron-down"></i></button>
                        <span class="search-matches">0/0</span>
                        <button class="search-btn search-close" title="Close search"><i data-lucide="x"></i></button>
                    </div>
                </div>`;
            const mount = container.querySelector('.terminal-container');
            container.insertBefore(overlay, mount);
            if (window.lucide) window.lucide.createIcons({ nameAttr: 'data-lucide', root: overlay });
        }

        const input = overlay.querySelector('.search-input');
        const matchesEl = overlay.querySelector('.search-matches');
        if (!input) return;

        // Decorations make onDidChangeResults fire (for the n/m counter) and
        // highlight matches; fall back to plain search on any API mismatch.
        const SEARCH_OPTS = {
            decorations: {
                matchBackground: '#3e4451',
                activeMatchBackground: '#528bff',
                matchOverviewRuler: '#3e4451',
                activeMatchColorOverviewRuler: '#528bff'
            }
        };
        const run = (dir, incremental = false) => {
            const q = input.value;
            if (!q) {
                try { searchAddon.clearDecorations(); } catch { /* older addon */ }
                if (matchesEl) matchesEl.textContent = '0/0';
                return;
            }
            try {
                const opts = incremental ? { ...SEARCH_OPTS, incremental: true } : SEARCH_OPTS;
                if (dir === 'prev') searchAddon.findPrevious(q, opts);
                else searchAddon.findNext(q, opts);
            } catch {
                if (dir === 'prev') searchAddon.findPrevious(q);
                else searchAddon.findNext(q);
            }
        };
        try {
            searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
                if (matchesEl) matchesEl.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : '0/0';
            });
        } catch { /* counter stays static on older addon versions */ }

        input.addEventListener('input', () => run('next', true));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); run(e.shiftKey ? 'prev' : 'next'); }
            else if (e.key === 'Escape') { e.preventDefault(); this.toggleTerminalSearch(id, false); }
        });
        const bindClick = (sel, fn) => { const b = overlay.querySelector(sel); if (b) b.addEventListener('click', fn); };
        bindClick('.search-prev', () => run('prev'));
        bindClick('.search-next', () => run('next'));
        bindClick('.search-close', () => this.toggleTerminalSearch(id, false));
    }

    /** Show/hide a terminal's search overlay. force: true=open, false=close. */
    toggleTerminalSearch(terminalId, force) {
        const td = this.terminals.get(terminalId != null ? terminalId : this.activeTerminalId);
        if (!td || !td.container) return;
        const overlay = td.container.querySelector('.terminal-search-overlay');
        if (!overlay) return;
        const show = force !== undefined ? force : overlay.style.display === 'none';
        overlay.style.display = show ? '' : 'none';
        if (show) {
            const input = overlay.querySelector('.search-input');
            if (input) { input.focus(); input.select(); }
        } else {
            try { td.searchAddon.clearDecorations(); } catch { /* older addon */ }
            td.terminal.focus();
        }
    }

    createTerminal(options = {}) {
        // options.id: explicit terminal id (e.g. 0 = the hidden manager instance)
        // options.directory: cwd for the PTY
        // options.hidden: keep the wrapper out of the visible grid
        // options.skipActive: don't steal focus/active state
        // Allocate the LOWEST free id so that closing Terminal 2 and adding
        // another reuses "2" rather than ever-incrementing. Explicit ids
        // (the manager 999, restored sessions) bypass this.
        let terminalId;
        if (options.id !== undefined) {
            terminalId = options.id;
        } else {
            terminalId = 1;
            while (this.terminals.has(terminalId)) terminalId++;
        }

        // Stable per-terminal color (manager → yellow): header dot + queue tint.
        const terminalColor = options.color || this.getTerminalColor(terminalId);

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
        // mountTarget (e.g. the Manager sidebar tab) always builds a fresh wrapper
        // in that target rather than reusing/creating a grid wrapper.
        if (mount && !options.hidden && !options.mountTarget) {
            container = mount.closest('.terminal-wrapper') || mount;
            // The static terminal-1 wrapper hardcodes its dot to --accent-primary
            // and its title to "Terminal 1"; sync both to the restored metadata —
            // otherwise a renamed terminal 1 silently reverts on screen every
            // restart even though the saved title round-trips through the store.
            const staticDot = container.querySelector && container.querySelector('.terminal-color-dot');
            if (staticDot) staticDot.style.backgroundColor = terminalColor;
            const staticTitle = container.querySelector && container.querySelector('.terminal-title');
            if (staticTitle && options.title) staticTitle.textContent = options.title;
        } else {
            container = document.createElement('div');
            container.className = options.hidden ? 'terminal-wrapper manager-hidden' : 'terminal-wrapper';
            if (options.cssClass) container.classList.add(options.cssClass);
            container.dataset.terminalId = terminalId;

            // Dynamic terminals get the same chrome as the static wrapper:
            // header (dot, title, status) + a .terminal-container mount.
            // Titles are editable unless locked (the Manager can't be renamed).
            const titleText = options.title || `Terminal ${terminalId}`;
            const dotColor = terminalColor;
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

            mount = document.createElement('div');
            mount.className = 'terminal-container';
            mount.dataset.terminalContainer = terminalId;
            container.appendChild(mount);

            // Mount into a custom target (Manager sidebar tab) or the grid.
            const mountParent = options.mountTarget || document.getElementById('terminals-container');
            if (mountParent) {
                mountParent.appendChild(container);
            }
            // Render icons AFTER the wrapper is in the document. lucide.createIcons
            // scans the live document, so rendering while still detached left the
            // close (x) icon blank until the NEXT terminal was added (which ran a
            // later scan that finally caught this one).
            if (window.lucide) window.lucide.createIcons({ nameAttr: 'data-lucide', root: container });
        }

        // Open terminal
        terminal.open(mount);

        // GPU-accelerated rendering. xterm's default DOM renderer is the single
        // biggest per-terminal memory/CPU cost; the WebGL renderer draws to a
        // canvas via the GPU and is dramatically lighter when several terminals
        // are open at once. Must load AFTER open() (it needs an attached canvas)
        // and only for VISIBLE terminals — a display:none/zero-size canvas (the
        // hidden manager) would burn one of the browser's ~16 scarce WebGL
        // contexts for nothing and can throw. On context loss (GPU sleep/wake,
        // too many contexts) dispose the addon so xterm reverts to DOM rendering
        // instead of going blank.
        let webglAddon = null;
        if (!options.hidden && !options.noWebgl) {
            try {
                webglAddon = new WebglAddon();
                webglAddon.onContextLoss(() => {
                    webglAddon.dispose();
                    webglAddon = null;
                });
                terminal.loadAddon(webglAddon);
            } catch (err) {
                console.warn(`WebGL renderer unavailable for terminal ${terminalId}, using DOM renderer:`, err && err.message);
                webglAddon = null;
            }
        }

        if (options.hidden || options.mountTarget) {
            // fit() on a display:none container computes garbage dimensions -
            // the manager mounts into its sidebar tab which is hidden until
            // selected, so give it a sane fixed size; its tab re-fits on reveal.
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

        // Right-click → a small "Copy" context menu for pulling text out of the
        // pane (xterm captures normal selection-copy, so the human needs an
        // explicit affordance). Copies the current selection, or the visible
        // buffer when nothing is selected.
        mount.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.showTerminalContextMenu(e, terminalId);
        });

        // Clicking/focusing a terminal makes it the active one (focusin bubbles
        // from xterm's hidden textarea), so the Status panel + queue target track
        // the terminal the user is actually working in.
        container.addEventListener('focusin', () => {
            if (this.activeTerminalId !== terminalId) this.setActiveTerminal(terminalId);
        });
        
        // Store terminal
        const terminalData = {
            id: terminalId,
            terminal,
            fitAddon,
            searchAddon,
            webglAddon,
            container
        };
        
        this.terminals.set(terminalId, terminalData);

        // Bind the in-terminal search overlay (builds one for dynamic terminals;
        // the static terminal-1 wrapper ships it in index.html).
        if (!options.hidden) this.setupTerminalSearch(terminalData);

        // Update state (color is read back by the message queue to tint dots)
        this.terminalStateManager.createTerminal({
            id: terminalId,
            terminal,
            directory: options.directory || process.cwd(),
            title: options.title,
            color: terminalColor
        });

        // Spawn the PTY in main (channel + payload shape match main.js's handler)
        ipcRenderer.send('terminal-start', { terminalId, directory: options.directory || null });

        // Set as active (manager and other background terminals skip this)
        if (!options.skipActive) {
            this.setActiveTerminal(terminalId);
        }

        // Emit event
        this.eventBus.emit('terminal:created', { terminalId, hidden: !!options.hidden });

        this.updateEmptyState();
        // Re-chunk the grid so the new terminal lands in the right cell/page.
        this.relayoutTerminals();

        console.log(`✅ Terminal ${terminalId} created${options.hidden ? ' (hidden)' : ''}`);
        return terminalId;
    }

    /**
     * Show a minimal context menu over a terminal pane with copy actions.
     * Closes on the next click anywhere (a one-shot document listener).
     */
    showTerminalContextMenu(e, terminalId) {
        document.querySelectorAll('.terminal-context-menu').forEach(m => m.remove());

        const menu = document.createElement('div');
        menu.className = 'terminal-context-menu';
        menu.style.position = 'fixed';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        menu.style.zIndex = '10000';

        const data = this.terminals.get(terminalId);
        const hasSelection = !!(data && data.terminal && data.terminal.hasSelection && data.terminal.hasSelection());

        const addItem = (label, handler) => {
            const opt = document.createElement('button');
            opt.className = 'terminal-context-menu-item';
            opt.textContent = label;
            opt.addEventListener('click', (ev) => {
                ev.stopPropagation();
                menu.remove();
                handler();
            });
            menu.appendChild(opt);
        };

        addItem(hasSelection ? 'Copy selection' : 'Copy selection (none)', () => this.copyTerminalText(terminalId, false));
        addItem('Copy visible buffer', () => this.copyTerminalText(terminalId, true));

        document.body.appendChild(menu);
        // Defer so this same right-click doesn't immediately close the menu.
        setTimeout(() => {
            document.addEventListener('click', () => menu.remove(), { once: true });
        }, 0);
    }

    /**
     * Copy text out of a terminal to the clipboard. With wholeBuffer=false, copies
     * the current xterm selection (no-op if empty); with true (or no selection),
     * copies the visible viewport's rendered text.
     */
    copyTerminalText(terminalId, wholeBuffer) {
        const data = this.terminals.get(terminalId);
        if (!data || !data.terminal) return;
        const term = data.terminal;
        let text = '';
        if (!wholeBuffer && term.hasSelection && term.hasSelection()) {
            text = term.getSelection();
        } else {
            // Read the visible viewport lines from the active buffer.
            const buffer = term.buffer.active;
            const lines = [];
            for (let i = 0; i < term.rows; i++) {
                const line = buffer.getLine(buffer.viewportY + i);
                if (line) lines.push(line.translateToString(true));
            }
            text = lines.join('\n').replace(/\s+$/, '');
        }
        if (!text) {
            this.eventBus.emit('log:action', { message: `Nothing to copy from Terminal ${terminalId}`, type: 'info' });
            return;
        }
        navigator.clipboard.writeText(text).then(() => {
            this.eventBus.emit('log:action', { message: `Copied ${text.length} chars from Terminal ${terminalId}`, type: 'success' });
        }).catch((err) => {
            this.eventBus.emit('log:action', { message: `Copy failed: ${err.message}`, type: 'error' });
        });
    }

    // Toggle the "No terminals open" empty state. The hidden manager (id 999)
    // carries .manager-hidden, so count only visible wrappers — terminals.size
    // would always be ≥1 once the manager boots.
    updateEmptyState() {
        const emptyEl = document.getElementById('terminals-empty');
        if (!emptyEl) return;
        // Scope to the grid container — the Manager wrapper now lives in the
        // left sidebar tab and must not count toward the grid's empty state.
        const visibleCount = document.querySelectorAll(
            '#terminals-container .terminal-wrapper:not(.manager-hidden)'
        ).length;
        emptyEl.style.display = visibleCount === 0 ? 'flex' : 'none';
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

        this.updateEmptyState();
        // Re-chunk the grid so survivors reflow into the correct layout.
        this.relayoutTerminals();

        console.log(`✅ Terminal ${terminalId} closed`);
    }

    /**
     * Stable color for a terminal id (manager 999 → yellow). Used for the header
     * dot and to tint that terminal's queued messages.
     */
    getTerminalColor(id) {
        if (this.managerInstance && id === ManagerInstance.TERMINAL_ID) {
            return 'var(--accent-warning)';
        }
        const palette = this.terminalColorPalette;
        const idx = ((Number(id) || 1) - 1) % palette.length;
        return palette[idx];
    }

    /**
     * Effective color/name for a terminal in chrome (selector, status bar):
     * a custom color set via the control API wins over the palette default, and
     * the manager is always yellow / "Manager".
     */
    terminalColorFor(id) {
        if (id === ManagerInstance.TERMINAL_ID) return 'var(--accent-warning)';
        const state = this.terminalStateManager.getTerminal(id) || {};
        return state.color || this.getTerminalColor(id);
    }

    terminalNameFor(id) {
        if (id === ManagerInstance.TERMINAL_ID) return 'Manager';
        const state = this.terminalStateManager.getTerminal(id) || {};
        return state.title || `Terminal ${id}`;
    }

    /** Reflect the active/focused terminal in the Status panel ("Terminal Selected"). */
    updateStatusBar(terminalId) {
        const name = document.getElementById('status-terminal-name');
        const dot = document.getElementById('status-terminal-dot');
        if (name) name.textContent = this.terminalNameFor(terminalId);
        if (dot) dot.style.backgroundColor = this.terminalColorFor(terminalId);

        // Directory follows the selected terminal — pulled from its tracked cwd
        // (kept current by the hook cwd events). Was previously a hardcoded path.
        const dirEl = document.getElementById('current-directory');
        const tipEl = document.getElementById('directory-tooltip');
        if (dirEl) {
            const state = this.terminalStateManager.getTerminal(terminalId);
            const dir = (state && state.directory) || '—';
            // The tooltip span is a child of #current-directory; set only the
            // leading text node so we don't clobber it.
            if (dirEl.firstChild && dirEl.firstChild.nodeType === Node.TEXT_NODE) {
                dirEl.firstChild.textContent = dir;
            } else {
                dirEl.insertBefore(document.createTextNode(dir), dirEl.firstChild);
            }
            dirEl.setAttribute('title', dir);
            if (tipEl) tipEl.textContent = dir;
        }
    }

    /**
     * Persist visible terminals' METADATA (id, name, directory, color) to the
     * store so the workspace can be rebuilt next launch. The live PTY/xterm
     * runtime is intentionally NOT saved — only the lightweight descriptors.
     * The manager (999) is excluded; it boots from its own configuration.
     */
    persistTerminalMetadata() {
        if (IS_REMOTE) return; // the local renderer owns workspace persistence
        if (this._restoringTerminals) return; // don't clobber mid-restore
        const meta = [];
        this.terminals.forEach((data, id) => {
            if (id === ManagerInstance.TERMINAL_ID) return;
            const state = this.terminalStateManager.getTerminal(id) || {};
            meta.push({
                id,
                title: state.title || `Terminal ${id}`,
                color: state.color || this.getTerminalColor(id),
                directory: state.directory || null
            });
        });
        this.persistSetting('terminalMetadata', meta);
    }

    /**
     * Rebuild last session's terminals from saved metadata (then restore the
     * queued messages, after terminals exist so message dots resolve their
     * terminal color). Falls back to a single fresh terminal on first run.
     */
    async restoreTerminalsAndQueue() {
        let saved = await this.getPersistedSetting('terminalMetadata', []);
        if (!Array.isArray(saved)) saved = [];
        const valid = saved.filter(t => t && t.id != null && t.id !== ManagerInstance.TERMINAL_ID);

        if (valid.length > 0) {
            this._restoringTerminals = true;
            const ids = new Set(valid.map(t => t.id));
            // index.html ships a static Terminal-1 shell; if id 1 wasn't saved,
            // drop it so it doesn't render as an empty pane in the grid.
            if (!ids.has(1)) {
                const staticWrapper = document.querySelector('#terminals-container .terminal-wrapper[data-terminal-id="1"]');
                if (staticWrapper) staticWrapper.remove();
            }
            valid.sort((a, b) => (a.id || 0) - (b.id || 0));
            valid.forEach((t, i) => {
                this.createTerminal({
                    id: t.id,
                    title: t.title || undefined,
                    color: t.color || undefined,
                    directory: t.directory || undefined,
                    skipActive: i !== valid.length - 1 // focus the last restored terminal
                });
            });
            this._restoringTerminals = false;
            this.persistTerminalMetadata(); // single authoritative write
        } else {
            this.createTerminal();
        }

        await this.messageQueueManager.restoreQueue();
        // Rehydrate persisted message history too, so the history modal shows
        // past sessions' injected messages after a reload/restart (saveToMessageHistory
        // persists on every injection; without this load it only lived in memory).
        await this.messageQueueManager.loadMessageHistory();
    }

    /** How many terminals share one on-screen "page" (the chunk size setting). */
    getMaxVisibleTerminals() {
        const n = parseInt(this.appStateStore.getState('settings.terminalsPerChunk'), 10);
        if (isNaN(n)) return 4;
        return Math.min(8, Math.max(1, n));
    }

    /**
     * Arrange visible terminals into the grid the user asked for:
     *   1 → full view, 2 → side by side, 3 → top-left + tall-right + bottom-left,
     *   4 → quadrants. Beyond the chunk size, terminals page into additional
     *   horizontally- (or vertically-) scrolling "chunks" in the same order.
     *
     * Implementation: group the .terminal-wrapper elements into .terminal-chunk
     * containers of `chunkSize`; each chunk's .chunk-N CSS lays out its members.
     * The hidden manager wrapper and the absolutely-positioned empty state are
     * left untouched.
     */
    relayoutTerminals() {
        const container = document.getElementById('terminals-container');
        if (!container) return;

        const chunkSize = this.getMaxVisibleTerminals();
        const vertical = this.appStateStore.getState('settings.chunkOrientation') === 'vertical';

        // Lift any existing chunk children back up, then drop the empty chunks.
        container.querySelectorAll('.terminal-chunk').forEach(chunk => {
            while (chunk.firstChild) container.insertBefore(chunk.firstChild, chunk);
            chunk.remove();
        });

        // Visible terminal wrappers, in ascending id order.
        const wrappers = Array.from(container.querySelectorAll('.terminal-wrapper'))
            .filter(w => !w.classList.contains('manager-hidden'));
        wrappers.sort((a, b) =>
            (parseInt(a.dataset.terminalId, 10) || 0) - (parseInt(b.dataset.terminalId, 10) || 0));

        container.classList.remove(
            'layout-single', 'layout-dual', 'layout-triple', 'layout-quad',
            'layout-scroll', 'layout-scroll-vertical'
        );
        container.classList.add(vertical ? 'layout-scroll-vertical' : 'layout-scroll');

        const emptyEl = document.getElementById('terminals-empty');
        for (let start = 0; start < wrappers.length; start += chunkSize) {
            const group = wrappers.slice(start, start + chunkSize);
            const chunk = document.createElement('div');
            chunk.className = `terminal-chunk chunk-${group.length}`;
            group.forEach(w => chunk.appendChild(w));
            container.insertBefore(chunk, emptyEl || null);
        }

        // Re-fit every visible terminal to its new cell.
        requestAnimationFrame(() => {
            this.terminals.forEach(data => {
                if (data.id === ManagerInstance.TERMINAL_ID) return; // fits via its sidebar tab
                if (!data.container.classList.contains('manager-hidden')) {
                    try { data.fitAddon.fit(); } catch { /* not laid out yet */ }
                }
            });
        });
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

        // Reflect the focused terminal in the Status panel.
        this.updateStatusBar(terminalId);

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
        if (terminalId === this.activeTerminalId) this.updateStatusBar(terminalId);
        return true;
    }

    /**
     * Turn a terminal's title span into an inline editor. Commit on Enter/blur,
     * cancel on Escape. Commits flow through setTerminalMetadata (state + DOM +
     * persistence). The manager title is locked (no `.editable` class), so it
     * never reaches here.
     */
    beginTitleEdit(titleEl, terminalId) {
        if (titleEl.getAttribute('contenteditable') === 'true') return;
        const original = titleEl.textContent;

        titleEl.setAttribute('contenteditable', 'true');
        titleEl.focus();
        const range = document.createRange();
        range.selectNodeContents(titleEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        const finish = (commit) => {
            titleEl.removeEventListener('keydown', onKey);
            titleEl.removeEventListener('blur', onBlur);
            titleEl.setAttribute('contenteditable', 'false');
            const next = titleEl.textContent.trim();
            if (commit && next && next !== original) {
                this.setTerminalMetadata(terminalId, { title: next });
            } else {
                titleEl.textContent = original; // revert empty/unchanged/cancelled
            }
        };
        const onKey = (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); titleEl.blur(); }
            else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
        };
        const onBlur = () => finish(true);
        titleEl.addEventListener('keydown', onKey);
        titleEl.addEventListener('blur', onBlur);
    }

    /**
     * Open the color-picker modal for a terminal: palette swatches plus a custom
     * picker. Selecting a color commits via setTerminalMetadata.
     */
    openColorPicker(terminalId) {
        if (terminalId === ManagerInstance.TERMINAL_ID) return; // manager is always yellow
        const modal = document.getElementById('terminal-color-picker-modal');
        const body = document.getElementById('color-picker-modal-body');
        if (!modal || !body) return;

        const close = () => { modal.classList.remove('show'); };
        const current = String(this.terminalColorFor(terminalId) || '').toLowerCase();

        body.innerHTML = '';
        const title = document.createElement('div');
        title.className = 'color-picker-title';
        title.textContent = `Color · ${this.terminalNameFor(terminalId)}`;
        body.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'color-swatch-grid';
        this.terminalColorPalette.forEach((c) => {
            const sw = document.createElement('button');
            sw.type = 'button';
            sw.className = 'color-swatch';
            sw.style.backgroundColor = c;
            if (c.toLowerCase() === current) sw.classList.add('selected');
            sw.addEventListener('click', () => {
                this.setTerminalMetadata(terminalId, { color: c });
                close();
            });
            grid.appendChild(sw);
        });
        body.appendChild(grid);

        const customRow = document.createElement('label');
        customRow.className = 'color-custom-row';
        const customLabel = document.createElement('span');
        customLabel.textContent = 'Custom';
        const input = document.createElement('input');
        input.type = 'color';
        input.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#007acc';
        input.addEventListener('change', () => {
            this.setTerminalMetadata(terminalId, { color: input.value });
            close();
        });
        customRow.appendChild(customLabel);
        customRow.appendChild(input);
        body.appendChild(customRow);

        modal.classList.add('show');
        modal.onclick = (e) => { if (e.target === modal) close(); };
    }

    /**
     * Read a terminal's rendered xterm buffer as text. Used by the /terminal/screen
     * control endpoint and by PromptWatchManager to detect interactive prompts.
     * Defaults to the visible viewport; pass { scrollback:true } for the full buffer.
     * @returns {{ok:true, terminalId, rows, cols, cursorRow, cursorCol, screen}|{ok:false, error}}
     */
    readTerminalScreen(terminalId, opts = {}) {
        const id = parseInt(terminalId, 10);
        const td = this.terminals.get(id);
        if (!td || !td.terminal) return { ok: false, error: 'terminal not found' };
        const term = td.terminal;
        const buf = term.buffer.active;
        const includeScrollback = opts.scrollback === true || opts.scrollback === 'true';
        const start = includeScrollback ? 0 : buf.baseY;
        const end = buf.baseY + term.rows; // through the bottom of the visible screen
        const lines = [];
        for (let i = start; i < end; i++) {
            const line = buf.getLine(i);
            lines.push(line ? line.translateToString(true) : '');
        }
        // Trim trailing blank lines so the dump ends at the last real output.
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        let screen = lines.join('\n');
        const MAX = 50000;
        if (screen.length > MAX) screen = '…[truncated]\n' + screen.slice(screen.length - MAX);
        return {
            ok: true,
            terminalId: id,
            rows: term.rows,
            cols: term.cols,
            cursorRow: buf.cursorY,
            cursorCol: buf.cursorX,
            screen
        };
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

        if (action === 'terminal-screen') {
            // Dump a terminal's rendered xterm buffer so the manager can "see"
            // the live screen (input box, menus, progress) - which the transcript
            // JSONL does not contain. Defaults to the visible viewport; pass
            // scrollback:true for the full buffer.
            return this.readTerminalScreen(payload.terminalId, { scrollback: payload.scrollback });
        }

        if (action === 'queue-update') {
            return this.messageQueueManager.applyControlUpdate(payload);
        }

        if (action === 'queue-inject-now') {
            // Force-inject a queued message immediately, bypassing pause/timer/
            // usage-limit gates (the manual override path). POST /queue/inject-now.
            const messageId = payload.messageId;
            if (messageId == null) return { ok: false, error: 'messageId required' };
            const message = this.messageQueueManager.messageQueue.find(m => String(m.id) === String(messageId));
            if (!message) return { ok: false, error: 'message not found in queue' };
            this.messageQueueManager.injectMessageNow(message.id);
            return { ok: true, messageId: message.id };
        }

        return { ok: false, error: `unknown control action: ${action}` };
    }
    
    /** Read a persisted setting from the SQLite store (JSON-decoded). */
    async getPersistedSetting(key, fallback) {
        try {
            const raw = await this.ipcHandler.invoke('db-get-setting', key);
            if (raw == null) return fallback;
            try { return JSON.parse(raw); } catch { return raw; }
        } catch { return fallback; }
    }

    /** Persist a setting to the SQLite store (JSON-encoded). */
    persistSetting(key, value) {
        try { this.ipcHandler.invoke('db-set-setting', key, JSON.stringify(value)); } catch { /* best effort */ }
    }

    /**
     * Load persisted settings, apply them, and wire the settings-modal controls.
     * The refactor created SoundManager/PreferenceManager but never initialized
     * them and never bound the modal inputs — so sound effects, the chunk-size
     * (max-visible) setting, theme, etc. all silently did nothing.
     */
    async setupSettings() {
        // ---- Load persisted values (in PARALLEL) ----
        // These were 7 sequential IPC awaits, which at cold start delayed wiring
        // the sound toggle/test buttons by up to a second or two. They're
        // independent reads, so batch them.
        const [
            soundEnabled, completionSound, injectionSound, promptedSound,
            terminalsPerChunk, chunkOrientation, theme,
            ttsPreferredVoice, ttsPlaybackSpeed, ttsAutoplayEnabled, managerInputEnabled,
            managerPromptWatchEnabled, managerAutoPassEnabled, managerPassIntervalMinutes,
            terminalScrollBehavior, keepScreenAwake, promptedKeywordsOnly,
        ] = await Promise.all([
            this.getPersistedSetting('soundEffectsEnabled', false),
            this.getPersistedSetting('completionSound', 'completion.mp3'),
            this.getPersistedSetting('injectionSound', 'injection.mp3'),
            this.getPersistedSetting('promptedSound', 'prompted.mp3'),
            this.getPersistedSetting('terminalsPerChunk', 4),
            this.getPersistedSetting('chunkOrientation', 'horizontal'),
            this.getPersistedSetting('theme', 'dark'),
            this.getPersistedSetting('ttsPreferredVoice', 'af_heart'),
            this.getPersistedSetting('ttsPlaybackSpeed', 1.3),
            this.getPersistedSetting('ttsAutoplayEnabled', true),
            this.getPersistedSetting('managerCompletionWatchEnabled', true),
            this.getPersistedSetting('managerPromptWatchEnabled', true),
            this.getPersistedSetting('managerAutoPassEnabled', true),
            this.getPersistedSetting('managerPassIntervalMinutes', 60),
            this.getPersistedSetting('terminalScrollBehavior', 'smart'),
            this.getPersistedSetting('keepScreenAwake', false),
            this.getPersistedSetting('promptedSoundKeywordsOnly', false),
        ]);

        // Apply TTS prefs to the NotificationManager immediately (it may already
        // be polling/playing before the settings modal is ever opened).
        if (this.notificationManager) {
            this.notificationManager.setPlaybackRate(ttsPlaybackSpeed);
            this.notificationManager.setAutoplay(ttsAutoplayEnabled);
        }
        if (this.managerInstance && this.managerInstance.setCompletionWatchEnabled) {
            this.managerInstance.setCompletionWatchEnabled(managerInputEnabled);
        }
        // Mirror into app state so the injection gate can read it live at send
        // time (blocks ALL injection to the manager terminal 999 when disabled).
        this.appStateStore.setState('settings.managerInputEnabled', !!managerInputEnabled);

        // Manager behavior settings — read live from the state store by
        // PromptWatchManager / ManagerInstance (previously write-nowhere keys).
        this.appStateStore.setState('managerPromptWatchEnabled', !!managerPromptWatchEnabled);
        this.appStateStore.setState('managerAutoPassEnabled', !!managerAutoPassEnabled);
        this.appStateStore.setState('managerPassIntervalMinutes', Number(managerPassIntervalMinutes) || 60);
        this.appStateStore.setState('settings.terminalScrollBehavior', terminalScrollBehavior);
        this.appStateStore.setState('settings.sound.promptedKeywordsOnly', !!promptedKeywordsOnly);

        // ---- Mirror into the app state store (SoundManager reads settings.sound.*) ----
        this.appStateStore.setState('settings.sound.enabled', !!soundEnabled);
        this.appStateStore.setState('settings.sound.completion', completionSound);
        this.appStateStore.setState('settings.sound.injection', injectionSound);
        this.appStateStore.setState('settings.sound.prompted', promptedSound);
        this.appStateStore.setState('settings.terminalsPerChunk', terminalsPerChunk);
        this.appStateStore.setState('settings.chunkOrientation', chunkOrientation);

        // ---- Apply theme + relayout with the loaded chunk size ----
        document.documentElement.setAttribute('data-theme', theme);
        this.applyThemeToTerminals(theme);
        this.relayoutTerminals();

        // ---- Wire the controls BEFORE the (async) sound-file load ----
        // Wiring used to sit behind `await soundManager.initialize()`, which
        // awaits an IPC dir-read. During that cold-start window (~1-2s after
        // launch) the sound toggle and test buttons were unbound, so toggling
        // "sound effects" did nothing. Wire first so they work immediately; the
        // sound <select>s repopulate on the 'sound:files-loaded' event below.
        this.wireSettingsControls({
            soundEnabled, completionSound, injectionSound, promptedSound,
            terminalsPerChunk, chunkOrientation, theme,
            ttsPreferredVoice, ttsPlaybackSpeed, ttsAutoplayEnabled, managerInputEnabled,
            managerPromptWatchEnabled, managerAutoPassEnabled, managerPassIntervalMinutes,
            terminalScrollBehavior, keepScreenAwake, promptedKeywordsOnly
        });

        // ---- Init sound manager (loads available files; heals stale prefs) ----
        await this.soundManager.initialize();
    }

    /** Push a theme to the data-theme attribute and live xterm instances. */
    applyThemeToTerminals(theme) {
        this.terminalManager.preferences.theme = theme;
        const xtermTheme = this.terminalManager.getTerminalTheme();
        this.terminals.forEach(data => {
            try { data.terminal.options.theme = xtermTheme; } catch { /* ignore */ }
        });
    }

    wireSettingsControls(current) {
        const byId = (id) => document.getElementById(id);

        // ---- Theme ----
        const themeSelect = byId('theme-select');
        if (themeSelect) {
            themeSelect.value = current.theme;
            themeSelect.addEventListener('change', () => {
                const v = themeSelect.value;
                document.documentElement.setAttribute('data-theme', v);
                this.applyThemeToTerminals(v);
                this.persistSetting('theme', v);
            });
        }

        // ---- Sound effects ----
        const soundToggle = byId('sound-effects-enabled');
        const soundGroup = byId('sound-selection-group');
        // Toggle the `.enabled` class the CSS keys on. The group is
        // `pointer-events: none` by default and only `auto` with `.enabled`, so
        // setting inline opacity alone (the previous behaviour) dimmed the group
        // but left every select/test button permanently unclickable.
        const reflectSoundGroup = (on) => { if (soundGroup) soundGroup.classList.toggle('enabled', !!on); };
        if (soundToggle) {
            soundToggle.checked = !!current.soundEnabled;
            reflectSoundGroup(soundToggle.checked);
            soundToggle.addEventListener('change', () => {
                this.soundManager.setSoundEnabled(soundToggle.checked);
                this.persistSetting('soundEffectsEnabled', soundToggle.checked);
                reflectSoundGroup(soundToggle.checked);
            });
        }

        // Populate the three sound <select>s from the available files. This may
        // run before SoundManager.initialize() has loaded the real file list, so
        // it is idempotent (uses `sel.onchange`, not addEventListener) and is
        // re-run on 'sound:files-loaded' once the files arrive.
        const populateSoundSelects = () => {
            const sounds = (this.soundManager.getAvailableSounds && this.soundManager.getAvailableSounds()) || [];
            const fill = (selectId, value, onChange) => {
                const sel = byId(selectId);
                if (!sel) return;
                const opts = (sounds.length ? sounds.slice() : ['none', 'completion.mp3', 'injection.mp3', 'prompted.mp3']);
                if (!opts.includes('none')) opts.unshift('none');
                sel.innerHTML = '';
                opts.forEach(f => { const o = document.createElement('option'); o.value = f; o.textContent = f; sel.appendChild(o); });
                sel.value = value;
                sel.onchange = () => onChange(sel.value); // idempotent across repopulation
            };
            // Read selected values from the SoundManager (it heals stale .mp3
            // prefs on init) so the <select> reflects a file that actually exists.
            fill('completion-sound-select', this.soundManager.getCompletionSound(), (v) => {
                this.soundManager.setCompletionSound(v); this.persistSetting('completionSound', v);
            });
            fill('injection-sound-select', this.soundManager.getInjectionSound(), (v) => {
                this.soundManager.setInjectionSound(v); this.persistSetting('injectionSound', v);
            });
            fill('prompted-sound-select', this.soundManager.getPromptedSound(), (v) => {
                this.soundManager.setPromptedSound(v); this.persistSetting('promptedSound', v);
            });
        };
        populateSoundSelects();
        // Repopulate after SoundManager.initialize() finishes. We listen for
        // 'sound:update-ui' (emitted at the END of initialize, AFTER stale-pref
        // healing) rather than 'sound:files-loaded' (emitted mid-init, before
        // healing) so the <select> reflects the healed, real-file selection.
        this.eventBus.on('sound:update-ui', () => populateSoundSelects());

        const wireTest = (id, fn) => { const b = byId(id); if (b) b.addEventListener('click', () => this.soundManager[fn]()); };
        wireTest('test-completion-sound-btn', 'testCompletionSound');
        wireTest('test-injection-sound-btn', 'testInjectionSound');
        wireTest('test-prompted-sound-btn', 'testPromptedSound');

        // ---- Spoken notifications (Kokoro TTS) ----
        const nm = this.notificationManager;
        // Preferred voice: fetch the catalog from the backend, then bind change.
        const voiceSelect = byId('tts-voice-select');
        if (voiceSelect) {
            const selected = current.ttsPreferredVoice || 'af_heart';
            fetch(`${BACKEND_URL}/api/tts/voices/`)
                .then(r => r.json())
                .then(({ voices }) => {
                    voiceSelect.innerHTML = '';
                    (voices || []).forEach(v => {
                        const o = document.createElement('option');
                        o.value = v.id; o.textContent = v.label || v.id;
                        voiceSelect.appendChild(o);
                    });
                    voiceSelect.value = selected;
                })
                .catch(() => { voiceSelect.value = selected; });
            voiceSelect.addEventListener('change', () => {
                const v = voiceSelect.value;
                this.persistSetting('ttsPreferredVoice', v);
                if (nm) nm.setPreferredVoice(v);
            });
        }
        const testVoiceBtn = byId('test-tts-voice-btn');
        if (testVoiceBtn) testVoiceBtn.addEventListener('click', () => {
            if (nm) nm.testVoice(voiceSelect ? voiceSelect.value : 'af_heart');
        });

        // Playback speed (applied client-side as audio.playbackRate).
        const speedRange = byId('tts-playback-speed');
        const speedValue = byId('tts-playback-speed-value');
        if (speedRange) {
            speedRange.value = current.ttsPlaybackSpeed;
            if (speedValue) speedValue.textContent = `${Number(current.ttsPlaybackSpeed).toFixed(2)}×`;
            speedRange.addEventListener('input', () => {
                if (speedValue) speedValue.textContent = `${Number(speedRange.value).toFixed(2)}×`;
                if (nm) nm.setPlaybackRate(speedRange.value);
            });
            speedRange.addEventListener('change', () => {
                this.persistSetting('ttsPlaybackSpeed', parseFloat(speedRange.value));
            });
        }

        // Autoplay toggle.
        const autoplayToggle = byId('tts-autoplay-enabled');
        if (autoplayToggle) {
            autoplayToggle.checked = !!current.ttsAutoplayEnabled;
            autoplayToggle.addEventListener('change', () => {
                if (nm) nm.setAutoplay(autoplayToggle.checked);
                this.persistSetting('ttsAutoplayEnabled', autoplayToggle.checked);
            });
        }

        // Manager-input toggle — mirrored in two places (Notifications tab toolbar
        // + this settings group). Both drive the same preference and stay in sync.
        const applyManagerInput = (on, persist) => {
            const tabToggle = byId('manager-input-enabled');
            const settingToggle = byId('manager-input-enabled-setting');
            if (tabToggle) tabToggle.checked = on;
            if (settingToggle) settingToggle.checked = on;
            if (this.managerInstance && this.managerInstance.setCompletionWatchEnabled) {
                this.managerInstance.setCompletionWatchEnabled(on);
            }
            // Live gate for the injection path: read by MessageQueueManager at
            // send time so toggling takes effect immediately (no restart).
            this.appStateStore.setState('settings.managerInputEnabled', on);
            // Re-enabling: flush any manager messages that were held while off.
            if (on && this.messageQueueManager && this.messageQueueManager.maybeAutoInject) {
                this.messageQueueManager.maybeAutoInject(999);
            }
            if (persist) this.persistSetting('managerCompletionWatchEnabled', on);
        };
        applyManagerInput(!!current.managerInputEnabled, false);
        ['manager-input-enabled', 'manager-input-enabled-setting'].forEach(id => {
            const el = byId(id);
            if (el) el.addEventListener('change', () => applyManagerInput(el.checked, true));
        });

        // ---- Manager behavior toggles (read live off the state store) ----
        const promptWatchToggle = byId('manager-prompt-watch-enabled');
        if (promptWatchToggle) {
            promptWatchToggle.checked = !!current.managerPromptWatchEnabled;
            promptWatchToggle.addEventListener('change', () => {
                this.appStateStore.setState('managerPromptWatchEnabled', promptWatchToggle.checked);
                this.persistSetting('managerPromptWatchEnabled', promptWatchToggle.checked);
            });
        }

        const autoPassToggle = byId('manager-auto-pass-enabled');
        if (autoPassToggle) {
            autoPassToggle.checked = !!current.managerAutoPassEnabled;
            autoPassToggle.addEventListener('change', () => {
                this.appStateStore.setState('managerAutoPassEnabled', autoPassToggle.checked);
                this.persistSetting('managerAutoPassEnabled', autoPassToggle.checked);
            });
        }

        const passIntervalRange = byId('manager-pass-interval-minutes');
        const passIntervalValue = byId('manager-pass-interval-value');
        if (passIntervalRange) {
            passIntervalRange.value = Number(current.managerPassIntervalMinutes) || 60;
            if (passIntervalValue) passIntervalValue.textContent = `${passIntervalRange.value}m`;
            passIntervalRange.addEventListener('input', () => {
                if (passIntervalValue) passIntervalValue.textContent = `${passIntervalRange.value}m`;
            });
            passIntervalRange.addEventListener('change', () => {
                const mins = parseInt(passIntervalRange.value, 10);
                this.appStateStore.setState('managerPassIntervalMinutes', mins);
                this.persistSetting('managerPassIntervalMinutes', mins);
            });
        }

        // ---- Terminal scroll behavior ----
        const scrollBehavior = byId('terminal-scroll-behavior');
        if (scrollBehavior) {
            scrollBehavior.value = current.terminalScrollBehavior || 'smart';
            scrollBehavior.addEventListener('change', () => {
                this.appStateStore.setState('settings.terminalScrollBehavior', scrollBehavior.value);
                this.persistSetting('terminalScrollBehavior', scrollBehavior.value);
            });
        }

        // ---- Keep screen awake (power-save blocker gate, read by MQM) ----
        const keepAwakeToggle = byId('keep-screen-awake');
        if (keepAwakeToggle) {
            keepAwakeToggle.checked = !!current.keepScreenAwake;
            keepAwakeToggle.addEventListener('change', () => {
                // Route through PreferenceManager: persists AND emits
                // preference:changed, which MessageQueueManager merges live.
                this.preferenceManager.updatePreference('keepScreenAwake', keepAwakeToggle.checked);
            });
        }

        // ---- Prompted sound: keywords-only filter ----
        const keywordsOnlyToggle = byId('prompted-sound-keywords-only');
        if (keywordsOnlyToggle) {
            keywordsOnlyToggle.checked = !!current.promptedKeywordsOnly;
            keywordsOnlyToggle.addEventListener('change', () => {
                this.soundManager.setPromptedKeywordsOnly(keywordsOnlyToggle.checked);
                this.persistSetting('promptedSoundKeywordsOnly', keywordsOnlyToggle.checked);
            });
        }

        // ---- Terminal chunk layout (max visible per page) ----
        const chunkRange = byId('terminals-per-chunk');
        const chunkValue = byId('terminals-per-chunk-value');
        if (chunkRange) {
            chunkRange.value = current.terminalsPerChunk;
            if (chunkValue) chunkValue.textContent = current.terminalsPerChunk;
            chunkRange.addEventListener('input', () => { if (chunkValue) chunkValue.textContent = chunkRange.value; });
            chunkRange.addEventListener('change', () => {
                const n = parseInt(chunkRange.value, 10);
                this.appStateStore.setState('settings.terminalsPerChunk', n);
                this.persistSetting('terminalsPerChunk', n);
                this.relayoutTerminals();
            });
        }

        const orientation = byId('chunk-orientation');
        if (orientation) {
            orientation.value = current.chunkOrientation;
            orientation.addEventListener('change', () => {
                this.appStateStore.setState('settings.chunkOrientation', orientation.value);
                this.persistSetting('chunkOrientation', orientation.value);
                this.relayoutTerminals();
            });
        }
    }

    finalizeInitialization() {
        // Restore last session's terminals (metadata) + queued messages from the
        // store; falls back to one fresh terminal on first run.
        this.restoreTerminalsAndQueue();

        // Load + wire the settings modal (sounds, chunk size, theme). Async;
        // self-sequences (loads persisted values, inits sound, relayouts).
        this.setupSettings();

        // Load notification history and start polling the TTS backend for new
        // spoken notifications (the manager produces them; this just plays/shows).
        // Local: the TTS backend lives on the app host's loopback — poll it.
        // Remote: audio pushes over the WS and PLAYS HERE, on the device showing
        // the interface (REMOTE_MODE.md §9) — and since /api/* is reverse-proxied
        // by the RemoteServer, the list itself loads + polls same-origin too, so
        // the Notifications panel mirrors the desktop's instead of sitting empty.
        // The id watermark (lastSeenId) + items map dedupe the two feeds: whoever
        // delivers a notification first wins, the other skips it.
        if (!IS_REMOTE) {
            this.notificationManager.initialize();
        } else {
            this.notificationManager.initializeRemote();
            // History FIRST (it sets the id watermark), polling after — else the
            // first poll would see the whole backlog as "fresh" and read it out.
            this.notificationManager.loadHistory()
                .then(() => this.notificationManager.startPolling())
                .catch(() => this.notificationManager.startPolling());
        }

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
    
    // Bridge kept for script-loaded modules (microwave-mode) that call
    // gui.logAction directly.
    logAction(message, type = 'info') {
        this.eventBus.emit('log:action', { message, type });
    }

    cleanup() {
        // Stop the TTS notification poller (otherwise it fetches forever)
        if (this.notificationManager && this.notificationManager.stopPolling) {
            this.notificationManager.stopPolling();
        }

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
        // Teardown on window close: stops the notification poller and disposes
        // terminals (cleanup() previously existed but nothing invoked it).
        window.addEventListener('beforeunload', () => gui.cleanup());
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