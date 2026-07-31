const ValidationUtils = require('../utils/validation');
const { BoundedSet, BoundedArray } = require('../utils/bounded-collections');
const { evaluateInjectionGate } = require('./injection-gate');

// The hidden manager instance lives on this terminal id. When "manager input"
// is disabled, NOTHING (normal, urgent, force, or the auto completion push) may
// be injected here until it is re-enabled.
const MANAGER_TERMINAL_ID = 999;

/**
 * MessageQueueManager - Centralized message queue and injection system
 * 
 * Extracted from renderer.js to reduce complexity and improve maintainability.
 * Handles all message queue operations, injection logic, and backend synchronization.
 * 
 * ARCHITECTURE:
 * - EventBus integration for clean event propagation
 * - AppStateStore integration for centralized state
 * - Clean separation from UI concerns (terminal rendering)
 * - Support for both sequential and parallel injection
 */
class MessageQueueManager {
    constructor(eventBus, appStateStore, terminalStateManager, ipc) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        this.terminalStateManager = terminalStateManager;
        // ipc wrapper: { send, on, removeListener } built by the renderer.
        this.ipc = ipc || null;

        // Remote Mode (docs/REMOTE_MODE.md): in a browser-served renderer the
        // queue is a live VIEW, but the injection engine and queue persistence
        // stay exclusively in the local Electron renderer — two engines against
        // the same PTYs would double-inject, and two writers would clobber the
        // store. Adds made remotely are forwarded to the authoritative local
        // queue over the WS bridge (see addMessageToQueue).
        this.isRemote = typeof window !== 'undefined' && !!window.__CCBOT_REMOTE__;

        // Operational flags formerly read off the renderer context.
        // These are now owned by the message system itself.
        this.timerExpired = false;
        this.usageLimitWaiting = false;
        this.planModeEnabled = false;
        this.injectionPaused = false;
        this.pendingUsageLimitReset = null;
        this.attachedFiles = [];
        this.imagePreviews = [];
        this.backendAPIClient = null; // set by renderer if/when available
        this.preferences = {};
        // Default priority applied to user-entered messages; set by the input-bar
        // type selector (renderer). Programmatic adds pass their own type.
        this.selectedMessageType = 'normal';

        // Utils and validation
        this.validationUtils = new ValidationUtils();
        
        // Message queue constants
        this.MAX_PROCESSED_MESSAGES = 1000;
        this.MAX_MESSAGE_HISTORY = 100;
        
        // Initialize core state
        this.initializeState();
        
        // Setup event listeners
        this.setupEventListeners();
    }
    
    initializeState() {
        // Initialize message queue in AppStateStore
        this.appStateStore.setState('messages.queue', []);
        
        // Injection state
        this.injectionTimer = null;
        this.schedulingInProgress = false;
        this.injectionCount = 0;
        this.currentlyInjectingMessages = new Set();
        this.currentlyInjectingTerminals = new Set();
        this.terminalStabilityTimers = new Map();
        
        // Terminal tracking for auto-continue and usage limits
        this.usageLimitTerminals = new Set();
        this.continueTargetTerminals = new Set();
        this.keywordResponseTerminals = new Map();
        
        // Bounded collections to prevent memory leaks
        this.processedUsageLimitMessages = new BoundedSet(this.MAX_PROCESSED_MESSAGES);
        this.processedPrompts = new BoundedSet(this.MAX_PROCESSED_MESSAGES);
        
        // Injection state flags
        this.isInjecting = false;
        this.injectionInProgress = false;
        this.injectionPaused = false;
        this.injectionPausedByTimer = false;
        this.pausedMessageContent = null;
        this.pausedMessageIndex = 0;
        this.currentlyInjectingMessageId = null;
        this.safetyCheckCount = 0;
        this.currentTypeInterval = null;
        
        // Message editing state
        this.editingMessageId = null;
        this.originalEditContent = null;
        
        // Message history with bounds
        this.messageHistory = new BoundedArray(this.MAX_MESSAGE_HISTORY);
        
        // Message ID tracking
        this.messageIdCounter = 1;
        this.messageSequenceCounter = 0;
    }
    
    setupEventListeners() {
        // Keep our local preferences mirror populated so consumers like the
        // queue send delay (injectionDelayMs) and keepScreenAwake actually read
        // the user's saved values. Without these, this.preferences stayed {} and
        // every read fell through to its hardcoded default.
        this.eventBus.on('preferences:applied', (prefs) => {
            if (prefs) this.preferences = { ...this.preferences, ...prefs };
        });
        this.eventBus.on('preference:changed', ({ key, value } = {}) => {
            if (key != null) this.preferences[key] = value;
        });

        // Listen for timer events
        this.eventBus.on('timer:expired', () => {
            this.handleTimerExpired();
        });

        // The usage-limit gate was just released (limit reset). Re-attempt the
        // queue now that the (a) timer==0 + (b) no-usage-limit conditions hold.
        this.eventBus.on('usageLimit:reset', () => {
            if (this.messageQueue.length > 0 && !this.injectionInProgress) {
                this.startSequentialInjection();
            }
        });

        // Core premise: a queued message injects when its target terminal goes
        // idle. When a terminal transitions out of running/prompted, attempt
        // injection (the gate enforces timer/usage-limit/status rules).
        this.eventBus.on('terminal:status:changed', ({ terminalId, status }) => {
            if (status !== 'running' && status !== 'prompted') {
                this.maybeAutoInject(terminalId);
            }
        });

        // Keep the visible queue list in sync with every queue mutation.
        this.eventBus.on('message:queue-updated', () => this.updateQueueDisplay());
        
        // Listen for message events
        this.eventBus.on('message:add', (data) => {
            this.addMessageToQueue(data.content, data.terminalId);
        });
        
        this.eventBus.on('message:delete', (messageId) => {
            this.deleteMessage(messageId);
        });
        
        this.eventBus.on('message:clear-queue', () => {
            this.clearQueue();
        });
        
    }
    
    // Getter for message queue from AppStateStore
    get messageQueue() {
        return this.appStateStore.getState('messages.queue') || [];
    }
    
    // Setter for message queue to AppStateStore
    set messageQueue(value) {
        this.appStateStore.setState('messages.queue', value);
    }
    
    /**
     * MESSAGE QUEUE CORE FUNCTIONS
     */
    
    generateMessageId() {
        return this.validationUtils.generateId();
    }

    // ======= CONTEXT-DECOUPLING HELPERS =======
    /**
     * Emit a log:action event (replaces the former this.context.logAction).
     */
    logAction(message, type = 'info') {
        this.eventBus.emit('log:action', { message, type });
    }

    /**
     * The currently-active terminal id, sourced from TerminalStateManager.
     */
    get activeTerminalId() {
        return this.terminalStateManager ? this.terminalStateManager.activeTerminalId : null;
    }

    /**
     * Send raw input to a terminal via the injected ipc wrapper.
     * The main-process 'terminal-input' handler expects a single object
     * payload { terminalId, data } (see main.js), NOT
     * positional args.
     */
    sendTerminalInput(terminalId, data) {
        if (this.ipc && typeof this.ipc.send === 'function') {
            this.ipc.send('terminal-input', { terminalId, data });
        } else {
            this.logAction(`Cannot send to terminal ${terminalId}: ipc unavailable`, 'error');
        }
    }

    /**
     * R3 INJECTION GATE - single source of truth for "may I inject now?".
     *
     * Nothing may inject until BOTH:
     *   (a) the timer has reached 0 (timerExpired) AND no usage-limit wait is active, and
     *   (b) the target terminal's status is neither 'running' nor 'prompted'.
     *
     * The stale/idle status in this codebase is the string '...'; any status
     * other than 'running'/'prompted' (including '...') passes the terminal gate.
     *
     * @param {number} terminalId
     * @returns {{ allowed: boolean, reason: string }}
     */
    /**
     * Attempt to inject a queued message now (the terminal just went idle, or a
     * message was just queued). No-op unless there's an injectable message and
     * the gate allows it - reuses the gated injection engine. This is what makes
     * "queue a message, it injects when the terminal is free" actually happen.
     */
    /**
     * Per-terminal PARALLEL auto-injection. When a terminal goes idle (or a
     * message is queued for it), inject that terminal's earliest queued message
     * — independently of every other terminal. Two idle terminals with one
     * message each therefore fire at the same time instead of serially.
     *
     * The old engine used one global `injectionInProgress` lock and a broken
     * `injectionManager.scheduleNextInjection()` call that threw and wedged the
     * lock on, which is why the 2nd queued message never went out.
     */
    maybeAutoInject(terminalId) {
        const tid = terminalId != null ? terminalId : this.activeTerminalId;
        if (tid == null) return;
        if (this.currentlyInjectingTerminals.has(tid)) return; // already busy on this terminal

        const message = this.messageQueue.find(
            msg => (msg.terminalId || this.activeTerminalId) === tid
        );
        if (!message) return;

        if (!this.canInjectToTerminal(tid, message.type).allowed) return;
        this._injectToTerminal(message, tid);
    }

    /**
     * Fan out: attempt an injection for every terminal that currently has a
     * queued message. Each terminal is gated independently, so all eligible
     * terminals inject in parallel. Used by the timer/usage-limit release paths.
     */
    flushAllTerminals() {
        const ids = new Set(
            this.messageQueue.map(msg => msg.terminalId || this.activeTerminalId)
        );
        ids.forEach(id => this.maybeAutoInject(id));
    }

    /**
     * Inject a single message into a single terminal, marking that terminal busy
     * for the duration so a second message can't pile in on top of it.
     */
    _injectToTerminal(message, terminalId) {
        // Remote Mode: never inject from a browser renderer. This is the single
        // sink every injection path (auto, "Send now", inject-next) flows
        // through, so one guard here disables the whole engine remotely.
        // Silent: the auto path probes on every idle transition and would spam
        // the log; injectMessageNow surfaces the explanation for explicit sends.
        if (this.isRemote) return;
        // Universal manager-input guard. canInjectToTerminal already blocks the
        // auto path, but injectMessageNow ("Send now" / force) bypasses the gate
        // entirely — so re-check here, the single sink every injection flows
        // through, to guarantee a disabled manager (999) is never reached by ANY
        // path. The message stays queued and flushes once input is re-enabled.
        if (terminalId === MANAGER_TERMINAL_ID && this.isManagerInputDisabled()) {
            this.logAction('Manager input disabled — message held, not injected to the manager (999)', 'info');
            return;
        }
        // Bare-shell guard re-check (P4). canInjectToTerminal enforces this on the
        // auto path, but injectMessageNow / "Send now" / the control-API inject-now
        // route bypass the gate entirely and flow straight here. For a NON-urgent
        // message, refuse to type into a terminal with no live Claude session
        // (definitive runtime 'shell') — otherwise the prompt text + carriage
        // return runs as host shell commands. Mirrors evaluateInjectionGate: only a
        // definitive 'shell' blocks; 'claude'/'unknown'/undefined fail open so a
        // transient detection gap never freezes legitimate injection. Urgent keeps
        // its documented bypass (a remote SSH'd Claude is detected locally as shell).
        if ((message.type || 'normal') !== 'urgent' && this.terminalStateManager) {
            const terminal = this.terminalStateManager.getTerminal(terminalId);
            if (terminal && terminal.runtime === 'shell') {
                this.logAction(`Held: terminal ${terminalId} is a bare shell (no Claude session) — message not injected`, 'warning');
                return;
            }
        }
        this.currentlyInjectingTerminals.add(terminalId);
        this.currentlyInjectingMessages.add(message.id);
        this.eventBus.emit('message:injection-started', { messageId: message.id, terminalId });

        this.typeMessageToTerminal(message.content, terminalId, () => {
            this._finishInjection(message, terminalId);
        });
    }

    /**
     * Post-injection bookkeeping: drop the message from the queue, release the
     * terminal, persist, then try to drain the next message for THAT terminal.
     */
    _finishInjection(message, terminalId) {
        const queue = [...this.messageQueue];
        const idx = queue.findIndex(m => m.id === message.id);
        if (idx !== -1) queue.splice(idx, 1);
        this.messageQueue = queue;

        this.currentlyInjectingTerminals.delete(terminalId);
        this.currentlyInjectingMessages.delete(message.id);
        if (this.currentlyInjectingMessageId === message.id) {
            this.currentlyInjectingMessageId = null;
        }

        this.injectionCount++;
        this.saveToMessageHistory(message, terminalId, this.injectionCount);
        this.markMessageAsInjectedInBackend(message);
        this.saveMessageQueue();

        this.eventBus.emit('message:queue-updated', { queue: this.messageQueue });
        this.eventBus.emit('message:injection-completed', { messageId: message.id, terminalId });
        this.eventBus.emit('ui:update-status');

        // Drain the next message for this same terminal once it settles. If the
        // terminal goes 'running' (Claude is working), the gate blocks here and
        // terminal:status:changed re-triggers maybeAutoInject when it idles.
        // The wait is the user-tunable "queue send delay" (injectionDelayMs);
        // default 400 preserves the previous hardcoded spacing.
        const sendDelayMs = (this.preferences && this.preferences.injectionDelayMs != null)
            ? Math.max(0, Number(this.preferences.injectionDelayMs))
            : 400;
        setTimeout(() => this.maybeAutoInject(terminalId), sendDelayMs);
    }

    /**
     * Inject a specific queued message immediately (the "Send immediately" menu
     * action and the toolbar inject button). Honors the R3 gate and the
     * carriage-return submit convention.
     */
    injectMessageNow(messageId) {
        if (this.isRemote) {
            this.logAction('Injection runs on the app host — the message will send from there when its terminal idles', 'info');
            return;
        }
        const message = this.messageQueue.find(m => m.id === messageId);
        if (!message) return;
        const tid = message.terminalId || this.activeTerminalId;
        if (tid == null) {
            this.logAction('Cannot send: no target terminal', 'error');
            return;
        }
        // Explicit manual override — "Send immediately" must fire even when the
        // master send toggle is paused (or a timer/usage-limit wait is active);
        // bypassing that gate is the whole point. Only refuse to race an
        // in-flight injection already running on this same terminal.
        if (this.currentlyInjectingTerminals.has(tid)) return;
        this._injectToTerminal(message, tid);
    }

    /**
     * Live read of the "manager input" toggle. Read at SEND time (never cached)
     * so flipping it in the UI takes effect immediately. Default = enabled:
     * undefined/true mean enabled; only an explicit `false` disables. Mirrors the
     * managerCompletionWatchEnabled preference into settings.managerInputEnabled.
     */
    isManagerInputDisabled() {
        const v = this.appStateStore
            ? this.appStateStore.getState('settings.managerInputEnabled')
            : undefined;
        return v === false;
    }

    canInjectToTerminal(terminalId, messageType = 'normal') {
        // Gather live state; the policy (precedence, the bare-shell P4 guard, and
        // the urgent status-gate bypass) lives in evaluateInjectionGate.
        // `runtime` is pushed from main (ground-truth /proc detection); a 'shell'
        // value means no live Claude session, so a prompt would run as shell
        // commands - the gate refuses it regardless of priority.
        const tid = terminalId != null ? terminalId : this.activeTerminalId;
        // Manager-input gate: blocks the manager terminal (999) for EVERY message
        // type, deliberately ahead of evaluateInjectionGate's urgent bypass so a
        // disabled manager can't be reached even by urgent/voice-memo messages.
        if (tid === MANAGER_TERMINAL_ID && this.isManagerInputDisabled()) {
            return { allowed: false, reason: 'manager input disabled' };
        }
        const terminal = (tid != null && this.terminalStateManager)
            ? this.terminalStateManager.getTerminal(tid)
            : null;
        return evaluateInjectionGate({
            usageLimitWaiting: this.usageLimitWaiting,
            timerRunning: !!(this.timerManager && this.timerManager.isRunning()),
            injectionPaused: this.injectionPaused,
            terminalId: tid,
            status: terminal ? terminal.status : null,
            runtime: terminal ? terminal.runtime : undefined,
            messageType
        });
    }

    /**
     * Emit a request to update the tray badge with the current queue count.
     */
    updateTrayBadge() {
        this.eventBus.emit('ui:tray-badge', { count: this.messageQueue.length });
    }

    /**
     * Emit a request to show a system notification.
     */
    showSystemNotification(title, body) {
        this.eventBus.emit('ui:system-notification', { title, body });
    }

    /**
     * Power-save blocker hooks delegated to the main process via events.
     */
    async startPowerSaveBlocker() {
        this.eventBus.emit('power:save-blocker:start');
    }

    stopPowerSaveBlocker() {
        this.eventBus.emit('power:save-blocker:stop');
    }

    /**
     * Called when an auto-injection sequence completes (plays completion sound).
     */
    onAutoInjectionComplete() {
        this.eventBus.emit('sound:play-completion');
    }

    /**
     * Load a persisted preference via ipc (replaces this.context.loadPreference).
     */
    async loadPreference(key) {
        if (this.ipc && typeof this.ipc.invoke === 'function') {
            try {
                return await this.ipc.invoke('db-get-setting', key);
            } catch (error) {
                console.error(`Failed to load preference ${key}:`, error);
            }
        }
        return null;
    }

    /**
     * Persist the message queue atomically via ipc.
     * Returns true on success. (TODO: wire to a richer atomic-write path if needed.)
     */
    async saveQueuedMessagesWithAtomicWrite() {
        // Remote Mode: the local renderer owns queue persistence; a remote
        // view writing its partial copy would clobber the real queue on disk.
        if (this.isRemote) return true;
        if (this.ipc && typeof this.ipc.invoke === 'function') {
            try {
                await this.ipc.invoke('db-set-setting', 'messageQueue', JSON.stringify(this.messageQueue));
                return true;
            } catch (error) {
                console.error('Failed to persist message queue:', error);
                return false;
            }
        }
        // No ipc available - treat as a successful no-op so callers don't retry forever.
        return true;
    }

    /**
     * Restore the persisted queue from the store on startup. The queue is SAVED
     * on every mutation but was never read back, so messages survived on disk
     * yet looked lost. Populates state + the visible list WITHOUT auto-injecting
     * — restored messages inject normally once a target terminal next goes idle.
     */
    async restoreQueue() {
        try {
            const raw = await this.loadPreference('messageQueue'); // db-get-setting
            if (!raw) return;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (Array.isArray(parsed) && parsed.length) {
                this.messageQueue = parsed;
                this.eventBus.emit('message:queue-updated', { queue: this.messageQueue });
                this.updateQueueDisplay();
                this.logAction(`Restored ${parsed.length} queued message(s) from last session`, 'info');
            }
        } catch (error) {
            console.error('Failed to restore message queue:', error);
        }
    }

    /**
     * Public entrypoint used by the renderer to add a message.
     * Accepts either an object { content, terminalId } or positional args.
     */
    addMessage(data) {
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            return this.addMessageToQueue(data.content, data.terminalId, data.type);
        }
        return this.addMessageToQueue(data);
    }

    /**
     * REMOTE VIEWS ONLY: replace this renderer's queue with the authoritative
     * one pushed by main ('remote-queue-sync' — fed from the local renderer's
     * state snapshots, which fire on every queue mutation). This is a pure
     * mirror: no persistence, no injection, no re-broadcast — just state +
     * display, so the remote panel reflects add / inject / remove / clear
     * within push latency instead of showing already-delivered messages.
     */
    applyRemoteQueueMirror(queue) {
        if (!this.isRemote) return; // the local renderer OWNS the queue
        this.messageQueue = (Array.isArray(queue) ? queue : []).map((m) => ({
            id: m.id,
            content: typeof m.content === 'string' ? m.content : '',
            terminalId: m.terminalId,
            type: m.type === 'urgent' ? 'urgent' : 'normal'
        }));
        this.eventBus.emit('message:queue-updated', { queue: this.messageQueue });
    }

    /**
     * Inject the next message in the queue immediately.
     */
    injectNextMessage() {
        const queue = this.messageQueue;
        if (queue.length === 0) return;
        // Route through the gated, carriage-return-correct injection path.
        this.injectMessageNow(queue[0].id);
    }

    /**
     * Update the queue display in the DOM
     */
    updateQueueDisplay() {
        // The mount is a <div id="message-list"> in index.html (kebab-case).
        const queueList = document.getElementById('message-list');
        if (!queueList) return;

        // One document-level closer for the option popovers (bound once).
        if (!this._queueMenuCloserBound) {
            document.addEventListener('click', () => {
                document.querySelectorAll('.message-menu.open').forEach(m => m.classList.remove('open'));
            });
            this._queueMenuCloserBound = true;
        }

        queueList.innerHTML = '';

        this.messageQueue.forEach(message => {
            const color = this._terminalColor(message.terminalId);

            const item = document.createElement('div');
            item.className = 'message-item';
            item.dataset.messageId = message.id;
            item.draggable = true;
            // Tint the left border + dot with the destination terminal's color.
            item.style.borderLeft = `3px solid ${color}`;

            const dot = document.createElement('span');
            dot.className = 'message-terminal-dot';
            dot.style.backgroundColor = color;
            dot.title = message.terminalId === 999 ? 'Manager' : `Terminal ${message.terminalId}`;

            // Priority badge (urgent only, to keep the list quiet).
            const type = message.type || 'normal';
            let badge = null;
            if (type === 'urgent') {
                badge = document.createElement('span');
                badge.className = `message-priority-badge priority-${type}`;
                badge.textContent = 'URGENT';
                badge.style.color = 'var(--accent-danger, #ff5f57)';
                badge.style.fontSize = '9px';
                badge.style.fontWeight = '700';
                badge.style.marginRight = '4px';
                badge.style.letterSpacing = '0.5px';
            }

            const messageText = document.createElement('span');
            messageText.className = 'message-text';
            messageText.textContent = message.content;

            // Single "⋯" button → options popover (send / edit / delete).
            const menuWrap = document.createElement('div');
            menuWrap.className = 'message-menu-wrap';

            const menuBtn = document.createElement('button');
            menuBtn.className = 'message-menu-btn';
            menuBtn.textContent = '⋯';
            menuBtn.title = 'Options';

            const menu = document.createElement('div');
            menu.className = 'message-menu';

            const addOption = (label, icon, handler, variant) => {
                const opt = document.createElement('button');
                opt.className = 'message-menu-item' + (variant ? ` ${variant}` : '');
                opt.title = label;
                opt.innerHTML = `<i data-lucide="${icon}"></i><span>${label}</span>`;
                opt.addEventListener('click', (e) => {
                    e.stopPropagation();
                    menu.classList.remove('open');
                    handler();
                });
                menu.appendChild(opt);
            };
            addOption('Send immediately', 'send', () => this.injectMessageNow(message.id));
            addOption('Edit', 'pencil', () => this.beginInlineEdit(item, message.id));
            // Priority changes (skip the current one). Re-uses applyControlUpdate
            // so urgent re-positions to the front, same as the control API.
            if (type !== 'urgent') addOption('Mark urgent', 'flag', () => this.applyControlUpdate({ messageId: message.id, type: 'urgent' }));
            if (type !== 'normal') addOption('Mark normal', 'flag', () => this.applyControlUpdate({ messageId: message.id, type: 'normal' }));
            // Retarget: move this message to a different destination terminal.
            this._terminalChoices(message.terminalId).forEach(({ id, label }) => {
                addOption(`Move to ${label}`, 'arrow-right-circle', () => {
                    const r = this.applyControlUpdate({ messageId: message.id, terminalId: id });
                    if (r && r.ok) this.logAction(`Moved message to ${label}`, 'info');
                });
            });
            addOption('Delete', 'trash-2', () => this.deleteMessage(message.id), 'danger');

            menuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = menu.classList.contains('open');
                document.querySelectorAll('.message-menu.open').forEach(m => m.classList.remove('open'));
                if (!isOpen) menu.classList.add('open');
            });

            // Dedicated per-message "Send now" button — force-injects regardless
            // of pause/timer/usage-limit gates (same path as the menu option).
            const sendNowBtn = document.createElement('button');
            sendNowBtn.className = 'message-send-now-btn';
            sendNowBtn.title = 'Send now (force inject)';
            sendNowBtn.innerHTML = '<i data-lucide="send-horizontal"></i>';
            sendNowBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.injectMessageNow(message.id);
            });

            menuWrap.appendChild(menuBtn);
            menuWrap.appendChild(menu);

            item.appendChild(dot);
            if (badge) item.appendChild(badge);
            item.appendChild(messageText);
            item.appendChild(sendNowBtn);
            item.appendChild(menuWrap);

            // Drag-to-reorder within the queue.
            item.addEventListener('dragstart', (e) => {
                this._dragMessageId = message.id;
                item.classList.add('dragging');
                if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            });
            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                this._dragMessageId = null;
                queueList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            });
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (this._dragMessageId && this._dragMessageId !== message.id) {
                    item.classList.add('drag-over');
                }
            });
            item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                this.handleMessageDrop(message.id);
            });

            queueList.appendChild(item);
        });

        // Render the lucide icons inside the freshly-built option menus.
        if (window.lucide) window.lucide.createIcons({ nameAttr: 'data-lucide', root: queueList });

        // Queue counter in the status panel (#queue-count)
        const queueCounter = document.getElementById('queue-count');
        if (queueCounter) {
            queueCounter.textContent = this.messageQueue.length;
        }
    }

    /** List retarget destinations for the queue menu — every known terminal
     *  except the message's current one. Manager (999) is excluded as a target. */
    _terminalChoices(currentTerminalId) {
        if (!this.terminalStateManager || typeof this.terminalStateManager.getAllTerminals !== 'function') {
            return [];
        }
        const choices = [];
        this.terminalStateManager.getAllTerminals().forEach((data, id) => {
            if (id === currentTerminalId || id === 999) return;
            choices.push({ id, label: (data && data.title) || `Terminal ${id}` });
        });
        return choices;
    }

    /** Resolve a terminal's dot color (manager → yellow) for the queue UI. */
    _terminalColor(terminalId) {
        if (terminalId === 999) return 'var(--accent-warning)';
        const term = this.terminalStateManager && this.terminalStateManager.getTerminal(terminalId);
        return (term && term.color) || 'var(--accent-primary)';
    }

    /** Turn a queued message's text into an inline editor (Enter saves, Esc cancels). */
    beginInlineEdit(item, messageId) {
        const message = this.messageQueue.find(m => m.id === messageId);
        if (!message) return;
        const textEl = item.querySelector('.message-text');
        if (!textEl) return;

        item.draggable = false; // don't start a drag while editing
        const editor = document.createElement('textarea');
        editor.className = 'message-edit-input';
        editor.value = message.content;
        textEl.replaceWith(editor);
        editor.focus();
        editor.select();

        const commit = () => {
            const value = editor.value.trim();
            if (value && value !== message.content) {
                this.updateMessage(messageId, value); // re-renders via queue-updated
            } else {
                this.updateQueueDisplay(); // restore unchanged
            }
        };
        editor.addEventListener('blur', commit);
        editor.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editor.blur(); }
            if (e.key === 'Escape') { editor.value = message.content; this.updateQueueDisplay(); }
        });
    }

    /** Reorder the dragged message to the dropped-on message's position. */
    handleMessageDrop(targetMessageId) {
        const fromIndex = this.messageQueue.findIndex(m => m.id === this._dragMessageId);
        const toIndex = this.messageQueue.findIndex(m => m.id === targetMessageId);
        this._dragMessageId = null;
        if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
        this.reorderMessage(fromIndex, toIndex);
    }
    
    async addMessageToQueue(providedContent = null, providedTerminalId = null, providedType = null, opts = {}) {
        const input = document.getElementById('message-input');
        const content = providedContent !== null ? providedContent.trim() : input.value.trim();

        // Validate content is not empty or just whitespace
        if (!this.isValidMessageContent(content)) {
            return;
        }

        // Remote Mode: a browser-originated add is forwarded to the
        // AUTHORITATIVE local queue over the WS bridge (RemoteServer re-emits
        // it as the same queue-add-request push the control API uses). The
        // local renderer queues + persists + injects it, and the resulting
        // broadcast echo (opts.fromBroadcast) lands back here for display —
        // so we do NOT also add it locally now, or it would show twice.
        if (this.isRemote && !opts.fromBroadcast) {
            const targetId = providedTerminalId != null ? providedTerminalId : this.activeTerminalId;
            this.ipc.send('remote-queue-add', {
                terminalId: targetId,
                content,
                type: MessageQueueManager.normalizeType(providedType != null ? providedType : this.selectedMessageType)
            });
            if (providedContent === null && input) input.value = '';
            this.logAction(`Message sent to the app host's queue for Terminal ${targetId}`, 'info');
            return;
        }

        // Handle special commands first
        if (await this.handleSpecialCommands(content, input)) {
            return;
        }

        // Create message object
        const message = await this.createMessageObject(content, providedTerminalId, providedType);

        // Add to queue. 'urgent' jumps to the front of the whole queue so it is
        // the next thing injected anywhere; everything else waits its turn.
        const queue = [...this.messageQueue];
        if (message.type === 'urgent') {
            queue.unshift(message);
        } else {
            queue.push(message);
        }
        this.messageQueue = queue;
        
        // Clear input and update UI
        if (providedContent === null) {
            input.value = '';
        }
        
        // Handle attachments
        await this.handleMessageAttachments(message);
        
        // Save and update UI
        await this.saveMessageQueue();
        
        // Emit events
        this.eventBus.emit('message:queue-updated', { queue: this.messageQueue });
        this.eventBus.emit('ui:update-status');
        
        // Sync with backend if available
        if (this.backendAPIClient) {
            try {
                await this.syncMessageWithBackend(message);
            } catch (error) {
                console.error('Backend sync failed:', error);
            }
        }
        
        this.logAction(`Message added to queue for Terminal ${message.terminalId}: "${content.substring(0, 50)}..."`, 'info');

        // If the target terminal is already idle, inject right away (gated).
        this.maybeAutoInject(message.terminalId || this.activeTerminalId);
    }
    
    async handleSpecialCommands(content, input) {
        // Usage-limit slash commands are delegated to the UsageLimitManager via events.
        if (content.startsWith('/usage-limit-status')) {
            this.eventBus.emit('usageLimit:status:request');
            input.value = '';
            return true;
        }

        if (content.startsWith('/usage-limit-reset')) {
            this.eventBus.emit('usageLimit:reset:request');
            input.value = '';
            return true;
        }

        if (content.startsWith('/debug-usage-limit')) {
            this.logAction('DEBUG: Triggering usage limit detection with 30-second countdown', 'warning');
            const debugResetTime = new Date(Date.now() + 30000);
            this.pendingUsageLimitReset = {
                resetHour: debugResetTime.getHours() % 12 || 12,
                ampm: debugResetTime.getHours() >= 12 ? 'pm' : 'am',
                debugResetTime: debugResetTime.getTime()
            };
            this.eventBus.emit('usageLimit:debug:trigger', {
                resetHour: this.pendingUsageLimitReset.resetHour,
                ampm: this.pendingUsageLimitReset.ampm
            });
            input.value = '';
            return true;
        }

        return false;
    }

    /**
     * Validate message content (non-empty, not just whitespace).
     */
    isValidMessageContent(content) {
        return typeof content === 'string' && content.trim().length > 0;
    }
    
    async createMessageObject(content, providedTerminalId, providedType) {
        const terminalId = providedTerminalId || this.activeTerminalId || 'terminal_1';

        return {
            id: this.generateMessageId(),
            content: content,
            terminalId: terminalId,
            // Priority: 'normal' (default - injects whenever the destination
            // terminal isn't 'prompted' and no countdown is active; it does NOT
            // wait on the finnicky 'running' state), 'urgent' (jumps to the
            // front AND bypasses the status gate). See canInjectToTerminal.
            type: MessageQueueManager.normalizeType(providedType != null ? providedType : this.selectedMessageType),
            timestamp: Date.now(),
            wrapWithPlan: this.planModeEnabled
        };
    }
    
    async handleMessageAttachments(message) {
        // Handle file attachments
        if (this.attachedFiles && this.attachedFiles.length > 0) {
            const otherFiles = this.attachedFiles.filter(file => 
                !file.type.startsWith('image/')
            );
            
            if (otherFiles.length > 0) {
                message.attachedFiles = [...this.attachedFiles];
                this.attachedFiles = [];
                this.eventBus.emit('ui:attached-files:cleared');
            }
        }

        // Handle image previews
        if (this.imagePreviews && this.imagePreviews.length > 0) {
            message.imagePreviews = [...this.imagePreviews];
            this.imagePreviews = [];
            this.eventBus.emit('ui:image-previews:cleared');
        }
    }
    
    async syncMessageWithBackend(message) {
        if (!this.backendAPIClient) return;
        
        try {
            const terminalSessionId = (this.backendAPIClient.getOrCreateTerminalSession
                ? await this.backendAPIClient.getOrCreateTerminalSession(message.terminalId)
                : message.terminalId);
            const backendMessage = await this.backendAPIClient.createMessage({
                content: message.content,
                terminal_session_id: terminalSessionId,
                wrap_with_plan: message.wrapWithPlan || false,
                attachments: message.attachedFiles || []
            });
            
            if (backendMessage && backendMessage.id) {
                message.backendId = backendMessage.id;
                const messageIndex = this.messageQueue.findIndex(m => m.id === message.id);
                if (messageIndex !== -1) {
                    const queue = [...this.messageQueue];
                    queue[messageIndex] = message;
                    this.messageQueue = queue;
                }
            }
        } catch (error) {
            console.error('Failed to sync message with backend:', error);
            throw error;
        }
    }
    
    clearQueue() {
        if (this.messageQueue.length > 0) {
            const count = this.messageQueue.length;
            this.messageQueue = [];
            
            // Update UI and save
            this.updateTrayBadge();
            this.saveMessageQueue();
            
            // Emit events
            this.eventBus.emit('message:queue-updated', { queue: this.messageQueue });
            this.eventBus.emit('ui:update-status');
            
            this.logAction(`Cleared message queue (${count} messages removed)`, 'warning');
        }
    }
    
    async deleteMessage(messageId) {
        const index = this.messageQueue.findIndex(msg => msg.id === messageId);
        if (index !== -1) {
            const queue = [...this.messageQueue];
            const deletedMessage = queue.splice(index, 1)[0];
            this.messageQueue = queue;
            
            // Sync deletion with backend
            if (this.backendAPIClient && deletedMessage.backendId) {
                try {
                    await this.backendAPIClient.deleteMessage(deletedMessage.backendId);
                } catch (error) {
                    console.error('Failed to delete message from backend:', error);
                }
            }
            
            // Save and update UI
            await this.saveMessageQueue();
            this.eventBus.emit('message:queue-updated', { queue: this.messageQueue });
            this.eventBus.emit('ui:update-status');
            
            this.logAction(`Deleted message: "${deletedMessage.content.substring(0, 30)}..."`, 'warning');
        }
    }
    
    updateMessage(messageId, newContent) {
        const index = this.messageQueue.findIndex(msg => msg.id === messageId);
        if (index !== -1) {
            const queue = [...this.messageQueue];
            queue[index] = { ...queue[index], content: newContent };
            this.messageQueue = queue;
            
            this.saveMessageQueue();
            this.eventBus.emit('message:queue-updated', { queue: this.messageQueue });
        }
    }
    
    reorderMessage(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;
        
        const queue = [...this.messageQueue];
        const [removed] = queue.splice(fromIndex, 1);
        queue.splice(toIndex, 0, removed);
        this.messageQueue = queue;
        
        this.saveMessageQueue();
        this.eventBus.emit('message:queue-updated', { queue: this.messageQueue });
        this.logAction(`Reordered message from position ${fromIndex + 1} to ${toIndex + 1}`, 'info');
    }
    
    async saveMessageQueue() {
        const maxRetries = 3;
        let retries = 0;
        
        while (retries < maxRetries) {
            try {
                const success = await this.saveQueuedMessagesWithAtomicWrite();
                if (success) {
                    return;
                }
            } catch (error) {
                console.error(`Save attempt ${retries + 1} failed:`, error);
            }
            
            retries++;
            if (retries < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 100 * retries));
            }
        }
        
        console.error('Failed to save message queue after', maxRetries, 'attempts');
    }
    
    /**
     * INJECTION ENGINE FUNCTIONS
     */
    
    handleTimerExpired() {
        // The R3 timer gate keys off this flag. It is the canonical "timer has
        // reached 0" signal for the injection engine.
        this.timerExpired = true;

        // If a usage-limit wait is still active, the usageLimitWaiting gate keeps
        // injection blocked even though the timer fired; the UsageLimitManager
        // clears that flag from its own timer:expired handler.
        if (this.messageQueue.length > 0 && !this.injectionInProgress) {
            this.startSequentialInjection();
        }
    }
    
    /**
     * Release the queue across all terminals. Named "sequential" for historical
     * callers (timer:expired, usageLimit:reset, injection:start), but injection
     * is now per-terminal parallel via flushAllTerminals() — each terminal is
     * gated independently so eligible ones fire together.
     */
    async startSequentialInjection() {
        if (this.isRemote) return; // injection engine lives in the local renderer only
        if (this.messageQueue.length === 0) {
            this.logAction('Injection requested but no messages to inject', 'warning');
            return;
        }

        // Start power save blocker if enabled
        if (this.preferences.keepScreenAwake) {
            await this.startPowerSaveBlocker();
        }

        this.logAction(`Flushing message queue (${this.messageQueue.length} queued) across idle terminals`, 'info');
        this.flushAllTerminals();
        this.eventBus.emit('ui:update-timer');
    }
    
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
            if (!this.usageLimitWaiting) {
                this.timerExpired = false;
            }
            this.safetyCheckCount = 0;
            this.eventBus.emit('ui:update-timer');
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
                this.injectMessageAndContinueQueue();
            });
        } else {
            this.scheduleNextInjection();
        }
    }
    
    injectMessageAndContinueQueue() {
        if (this.isRemote) return; // injection engine lives in the local renderer only
        // Implementation would continue here...
        // This is a complex method that handles the actual message injection
        // For brevity, I'm showing the structure but not the full implementation
        
        if (this.messageQueue.length === 0) {
            this.logAction('No messages to inject', 'warning');
            return;
        }
        
        // R3 gate (auto path): only pick a message whose target terminal is both
        // free of an in-flight injection AND passes canInjectToTerminal (not
        // running/prompted, no usage-limit/timer block).
        const messageIndex = this.messageQueue.findIndex(msg => {
            const terminalId = msg.terminalId || this.activeTerminalId;
            if (this.currentlyInjectingTerminals.has(terminalId)) return false;
            return this.canInjectToTerminal(terminalId).allowed;
        });

        if (messageIndex === -1) {
            // Either all terminals are busy/running/prompted or the timer/usage
            // gate is still closed; retry shortly. If the usage-limit gate is the
            // blocker we stop the loop entirely - it resumes on timer:expired.
            if (this.usageLimitWaiting || (this.timerManager && this.timerManager.isRunning())) {
                this.logAction('Injection gated (usage limit / timer) - awaiting release', 'info');
                return;
            }
            this.logAction('All target terminals busy or not idle - waiting...', 'info');
            setTimeout(() => this.injectMessageAndContinueQueue(), 1000);
            return;
        }
        
        const message = this.messageQueue[messageIndex];
        const terminalId = message.terminalId || this.activeTerminalId;
        
        // Mark terminal and message as injecting
        this.currentlyInjectingTerminals.add(terminalId);
        this.currentlyInjectingMessages.add(message.id);
        this.currentlyInjectingMessageId = message.id;
        
        // Emit event for UI update
        this.eventBus.emit('message:injection-started', { messageId: message.id, terminalId });
        
        // Handle plan mode wrapping
        const shouldWrapWithPlan = message.wrapWithPlan && this.planModeEnabled;
        
        if (shouldWrapWithPlan) {
            this.injectMessageWithPlanMode(message, () => {
                this.completeMessageInjection(message, terminalId);
            });
        } else {
            this.typeMessageToTerminal(message.content, terminalId, () => {
                this.completeMessageInjection(message, terminalId);
            });
        }
    }
    
    completeMessageInjection(message, terminalId) {
        // Remove message from queue
        const queue = [...this.messageQueue];
        const index = queue.findIndex(m => m.id === message.id);
        if (index !== -1) {
            queue.splice(index, 1);
            this.messageQueue = queue;
        }
        
        // Clear injection tracking
        this.currentlyInjectingTerminals.delete(terminalId);
        this.currentlyInjectingMessages.delete(message.id);
        
        // Update counters
        this.injectionCount++;
        
        // Save to history
        this.saveToMessageHistory(message, terminalId, this.injectionCount);
        
        // Mark as injected in backend
        this.markMessageAsInjectedInBackend(message);
        
        // Save queue and update UI
        this.saveMessageQueue();
        this.eventBus.emit('message:queue-updated', { queue: this.messageQueue });
        this.eventBus.emit('message:injection-completed', { messageId: message.id, terminalId });
        
        // Continue with next message if any
        if (this.messageQueue.length > 0) {
            this.processNextQueuedMessage(false);
        } else {
            this.injectionInProgress = false;
            this.eventBus.emit('ui:update-timer');
            this.logAction('All messages injected successfully', 'success');
        }
    }
    
    // Additional methods would be implemented here...
    // Including: manualInjectNextMessage, pauseInjectionExecution, resumeInjectionExecution, etc.
    
    /**
     * MESSAGE HISTORY FUNCTIONS
     */
    
    async saveToMessageHistory(message, terminalId = null, counter = null) {
        if (this.isRemote) return; // history is recorded by the injecting (local) renderer
        const historyItem = {
            id: message.id,
            content: message.content,
            terminalId: terminalId || message.terminalId,
            timestamp: Date.now(),
            injectedAt: Date.now(),
            counter: counter || this.injectionCount,
            backendId: message.backendId
        };
        
        this.messageHistory.push(historyItem);

        // Sync with backend if available (best-effort; usually unset)
        if (this.backendAPIClient) {
            try {
                await this.backendAPIClient.saveMessageHistory(historyItem);
            } catch (error) {
                console.error('Failed to save message history to backend:', error);
            }
        }

        // Clean up old history
        this.cleanupOldMessageHistory();

        // Persist to the local store so history survives reload/restart. The
        // backend sync above is almost always a no-op (backendAPIClient is null),
        // so without this the history only ever lived in memory.
        this.persistMessageHistory();

        // Emit event for UI update
        this.eventBus.emit('message:history-updated', { history: this.messageHistory });
    }

    /** Persist message history to the unified store via ipc (JSON-encoded,
     *  same channel the queue uses). */
    persistMessageHistory() {
        if (this.ipc && typeof this.ipc.invoke === 'function') {
            try {
                this.ipc.invoke('db-set-setting', 'messageHistory', JSON.stringify([...this.messageHistory]));
            } catch (error) {
                console.error('Failed to persist message history:', error);
            }
        }
    }
    
    cleanupOldMessageHistory() {
        if (this.messageHistory.length > this.MAX_MESSAGE_HISTORY) {
            this.messageHistory.splice(0, this.messageHistory.length - this.MAX_MESSAGE_HISTORY);
        }
        
        // Remove items older than 7 days
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        for (let i = this.messageHistory.length - 1; i >= 0; i--) {
            const item = this.messageHistory[i];
            if (!item.injectedAt && item.timestamp && item.timestamp < sevenDaysAgo) {
                this.messageHistory.splice(i, 1);
            } else if (!item.injectedAt) {
                this.messageHistory.splice(i, 1);
            }
        }
    }
    
    async loadMessageHistory() {
        try {
            // db-get-setting returns the raw stored value; persistMessageHistory
            // writes it JSON-encoded, so parse a string back into an array.
            const raw = await this.loadPreference('messageHistory');
            const savedHistory = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (savedHistory && Array.isArray(savedHistory)) {
                this.messageHistory = new BoundedArray(this.MAX_MESSAGE_HISTORY);
                savedHistory.forEach(item => this.messageHistory.push(item));
                this.cleanupOldMessageHistory();
                this.eventBus.emit('message:history-updated', { history: this.messageHistory });
            }
        } catch (error) {
            console.error('Failed to load message history:', error);
        }
    }

    clearMessageHistory() {
        // BoundedArray extends Array and has no clear(); truncate in place.
        this.messageHistory.length = 0;
        this.persistMessageHistory();
        this.eventBus.emit('message:history-updated', { history: this.messageHistory });
        this.logAction('Message history cleared', 'info');
    }
    
    /**
     * UTILITY METHODS
     */
    
    async performSafetyChecks(callback) {
        // Implementation for safety checks before injection
        // This would include terminal status checks, rate limiting, etc.
        callback();
    }
    
    async markMessageAsInjectedInBackend(message) {
        if (!this.backendAPIClient || !message.backendId) {
            return;
        }
        
        try {
            await this.backendAPIClient.updateMessage(message.backendId, {
                status: 'injected',
                injected_at: new Date().toISOString()
            });
        } catch (error) {
            console.error('Failed to mark message as injected in backend:', error);
        }
    }
    
    // Placeholder methods for complex injection logic
    injectMessageWithPlanMode(message, callback) {
        // Implementation for plan mode injection
        callback();
    }
    
    /**
     * Inject a message's content into a terminal. Injection is a single IPC
     * write of the content plus a trailing newline (which submits the prompt to
     * Claude). The callback runs once the write has been dispatched.
     */
    typeMessageToTerminal(content, terminalId, callback) {
        const tid = terminalId != null ? terminalId : this.activeTerminalId;
        if (tid == null) {
            this.logAction('Cannot inject: no target terminal', 'error');
            if (typeof callback === 'function') callback();
            return;
        }
        // Translate any `[[Ctrl+C]]`-style terminal-command tokens (composed via
        // the keyboard menu) into the real control bytes before typing.
        const data = MessageQueueManager.translateTerminalTokens(content);
        // PTY Enter is carriage return (\r), NOT \n. TUIs like Claude Code
        // treat \n as a literal newline in the input box and never submit;
        // send the text first, then \r as a separate write after a short delay
        // so the TUI has flushed the pasted content before the submit lands.
        this.sendTerminalInput(tid, data);
        setTimeout(() => {
            this.sendTerminalInput(tid, '\r');
            this.eventBus.emit('message:injected', { terminalId: tid, content });
            if (typeof callback === 'function') callback();
        }, 150);
    }

    /**
     * Schedule the next queued injection after a delay, re-checking the R3 gate
     * at fire time.
     */
    scheduleNextInjection() {
        if (this.injectionTimer) {
            clearTimeout(this.injectionTimer);
        }
        const delayMs = (this.preferences && this.preferences.injectionDelayMs) || 1000;
        this.injectionTimer = setTimeout(() => {
            this.injectionTimer = null;
            this.injectMessageAndContinueQueue();
        }, delayMs);
    }

    /**
     * Set the default priority for user-entered messages (input-bar selector).
     */
    setSelectedMessageType(type) {
        this.selectedMessageType = MessageQueueManager.normalizeType(type);
        return this.selectedMessageType;
    }

    /**
     * Apply a control-API edit to a queued message (POST /queue/update). One of:
     *  - { messageId, remove: true }       → drop the message
     *  - { messageId, content }            → replace its text
     *  - { messageId, type }               → change priority (re-positions to the
     *                                        front if it becomes 'urgent')
     *  - { messageId, terminalId }          → retarget to a different terminal
     *                                        (validated to exist)
     * content/type/terminalId may be combined. Returns { ok, ... } for the HookServer.
     */
    applyControlUpdate(payload = {}) {
        const id = payload.messageId;
        if (id == null) return { ok: false, error: 'messageId required' };
        const queue = [...this.messageQueue];
        const idx = queue.findIndex(m => String(m.id) === String(id));
        if (idx === -1) return { ok: false, error: 'message not found in queue' };

        // Refuse to mutate a message that is mid-injection (PTY type in flight).
        if (this.currentlyInjectingMessages.has(queue[idx].id)) {
            return { ok: false, error: 'message is currently injecting' };
        }

        if (payload.remove === true) {
            const [removed] = queue.splice(idx, 1);
            this.messageQueue = queue;
            this._afterControlMutation();
            return { ok: true, removed: removed.id };
        }

        const message = { ...queue[idx] };
        let changed = false;
        if (typeof payload.content === 'string' && payload.content.trim()) {
            message.content = payload.content.trim();
            changed = true;
        }
        if (payload.type != null) {
            message.type = MessageQueueManager.normalizeType(payload.type);
            changed = true;
        }
        if (payload.terminalId != null) {
            const tid = parseInt(payload.terminalId, 10);
            if (!Number.isInteger(tid)) {
                return { ok: false, error: 'terminalId must be a number' };
            }
            // Validate the destination exists before moving the message there,
            // so a typo'd id doesn't strand the message on a phantom terminal.
            const exists = this.terminalStateManager && this.terminalStateManager.getTerminal(tid);
            if (!exists) {
                return { ok: false, error: `terminal ${tid} not found` };
            }
            message.terminalId = tid;
            changed = true;
        }
        if (!changed) return { ok: false, error: 'nothing to update (content, type, or terminalId)' };

        queue.splice(idx, 1);
        // Re-promoting to 'urgent' moves it to the front; otherwise keep position.
        if (message.type === 'urgent') {
            queue.unshift(message);
        } else {
            queue.splice(idx, 0, message);
        }
        this.messageQueue = queue;
        this._afterControlMutation();
        // A newly-urgent message may now be injectable.
        this.maybeAutoInject(message.terminalId || this.activeTerminalId);
        return { ok: true, messageId: message.id, type: message.type };
    }

    /** Persist + refresh UI/snapshot after a control-API queue mutation. */
    _afterControlMutation() {
        this.saveMessageQueue();
        this.eventBus.emit('message:queue-updated', { queue: this.messageQueue });
        this.eventBus.emit('ui:update-status');
    }

    /** Coerce any value to a valid priority (default normal). A legacy/API
     *  'important' is no longer valid and coerces to 'normal'. */
    static normalizeType(type) {
        return MessageQueueManager.VALID_TYPES.includes(type) ? type : 'normal';
    }

    /**
     * Replace `[[Label]]` terminal-command tokens with their raw control bytes.
     * Only the curated, delimited tokens below are translated, so ordinary prose
     * (even text containing "^C") is never affected. Unknown `[[...]]` is left
     * verbatim. Keys MUST match the keyboard menu's .hotkey-label text.
     */
    static translateTerminalTokens(content) {
        if (typeof content !== 'string' || content.indexOf('[[') === -1) return content;
        return content.replace(/\[\[([^\]]+)\]\]/g, (whole, name) => {
            const bytes = MessageQueueManager.TERMINAL_TOKENS[name.trim()];
            return bytes != null ? bytes : whole;
        });
    }
}

MessageQueueManager.VALID_TYPES = ['normal', 'urgent'];

// label (matches index.html .hotkey-label) -> raw control sequence
MessageQueueManager.TERMINAL_TOKENS = {
    'Ctrl+C': '\x03',
    'Ctrl+C Ctrl+C': '\x03\x03',
    'Ctrl+Z': '\x1a',
    'Ctrl+D': '\x04',
    'Esc': '\x1b',
    'Enter': '\r',
    'Tab': '\t',
    'Shift+Tab': '\x1b[Z',
    'Shift+Up': '\x1b[1;2A',
    'Shift+Down': '\x1b[1;2B',
    'Shift+Right': '\x1b[1;2C',
    'Shift+Left': '\x1b[1;2D'
};

module.exports = MessageQueueManager;
