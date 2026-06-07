const ValidationUtils = require('../utils/validation');
const { BoundedSet, BoundedArray } = require('../utils/bounded-collections');

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
        this.injectionManager = null; // set by renderer if/when available
        this.preferences = {};

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
        
        // Listen for injection events
        this.eventBus.on('injection:start', () => {
            this.startSequentialInjection();
        });
        
        this.eventBus.on('injection:pause', () => {
            this.pauseInjectionExecution();
        });
        
        this.eventBus.on('injection:resume', () => {
            this.resumeInjectionExecution();
        });
        
        this.eventBus.on('injection:cancel', () => {
            this.cancelSequentialInjection();
        });
        
        this.eventBus.on('injection:manual', () => {
            this.manualInjectNextMessage();
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
     * payload { terminalId, data } (see main.js / ipc-handler.js), NOT
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
    maybeAutoInject(terminalId) {
        if (this.injectionInProgress) return; // engine already running; it will pick this up
        if (this.currentlyInjectingTerminals.has(terminalId)) return;
        const hasInjectable = this.messageQueue.some(msg => {
            const tid = msg.terminalId || this.activeTerminalId;
            return tid === terminalId && this.canInjectToTerminal(tid).allowed;
        });
        if (!hasInjectable) return;
        this.injectionInProgress = true;
        this.injectMessageAndContinueQueue();
    }

    canInjectToTerminal(terminalId) {
        // (a) Timer / usage-limit gate.
        if (this.usageLimitWaiting) {
            return { allowed: false, reason: 'usage limit active - waiting for reset' };
        }
        // Block only while a countdown is ACTIVELY armed (manual auto-inject or
        // usage-limit deferral). With no timer running, inject when idle - the
        // old `!timerExpired` check was a one-shot edge flag that stayed false
        // forever when no timer was ever set, silently blocking all injection.
        if (this.timerManager && this.timerManager.isRunning()) {
            return { allowed: false, reason: 'timer still counting down' };
        }
        if (this.injectionPaused) {
            return { allowed: false, reason: 'injection paused' };
        }

        // (b) Target terminal status gate.
        const tid = terminalId != null ? terminalId : this.activeTerminalId;
        if (tid == null) {
            return { allowed: false, reason: 'no target terminal' };
        }
        const terminal = this.terminalStateManager
            ? this.terminalStateManager.getTerminal(tid)
            : null;
        const status = terminal ? terminal.status : null;
        if (status === 'running' || status === 'prompted') {
            return { allowed: false, reason: `terminal ${tid} is ${status}` };
        }

        return { allowed: true, reason: 'ok' };
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
     * Public entrypoint used by the renderer to add a message.
     * Accepts either an object { content, terminalId } or positional args.
     */
    addMessage(data) {
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            return this.addMessageToQueue(data.content, data.terminalId);
        }
        return this.addMessageToQueue(data);
    }

    /**
     * Inject the next message in the queue immediately.
     */
    injectNextMessage() {
        const queue = this.messageQueue;
        if (queue.length === 0) return;

        const peek = queue[0];
        const terminalId = peek.terminalId || this.activeTerminalId;

        // R3 gate (manual path): block + warn rather than inject into a busy
        // terminal or during a usage-limit/timer wait.
        const gate = this.canInjectToTerminal(terminalId);
        if (!gate.allowed) {
            this.logAction(`Manual injection blocked: ${gate.reason}`, 'warning');
            return;
        }

        const message = queue.shift();
        this.messageQueue = queue;

        if (terminalId) {
            this.sendTerminalInput(terminalId, message.content + '\n');

            // Update state
            this.injectionCount++;
            this.eventBus.emit('message:injected', { message, terminalId });
        }

        this.updateQueueDisplay();
    }

    /**
     * Update the queue display in the DOM
     */
    updateQueueDisplay() {
        const queueList = document.getElementById('messageQueueList');
        if (!queueList) return;
        
        queueList.innerHTML = '';
        
        this.messageQueue.forEach(message => {
            const li = document.createElement('li');
            li.className = 'message-item';
            li.dataset.messageId = message.id;
            
            const messageText = document.createElement('span');
            messageText.className = 'message-text';
            messageText.textContent = message.content;
            
            const injectBtn = document.createElement('button');
            injectBtn.className = 'inject-btn';
            injectBtn.textContent = 'Inject';
            injectBtn.onclick = () => {
                this.injectSpecificMessage(message.id);
            };
            
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-btn';
            deleteBtn.textContent = '×';
            deleteBtn.onclick = () => {
                this.deleteMessage(message.id);
            };
            
            li.appendChild(messageText);
            li.appendChild(injectBtn);
            li.appendChild(deleteBtn);
            queueList.appendChild(li);
        });
        
        // Update queue counter
        const queueCounter = document.getElementById('queueCounter');
        if (queueCounter) {
            queueCounter.textContent = this.messageQueue.length;
        }
    }
    
    /**
     * Inject a specific message by ID
     */
    injectSpecificMessage(messageId) {
        const queue = this.messageQueue;
        const messageIndex = queue.findIndex(m => m.id === messageId);
        
        if (messageIndex === -1) return;

        const terminalId = queue[messageIndex].terminalId || this.activeTerminalId;

        // R3 gate (manual path): block + warn.
        const gate = this.canInjectToTerminal(terminalId);
        if (!gate.allowed) {
            this.logAction(`Manual injection blocked: ${gate.reason}`, 'warning');
            return;
        }

        const [message] = queue.splice(messageIndex, 1);
        this.messageQueue = queue;

        if (terminalId) {
            this.sendTerminalInput(terminalId, message.content + '\n');

            this.injectionCount++;
            this.eventBus.emit('message:injected', { message, terminalId });
        }

        this.updateQueueDisplay();
    }

    validateMessageIds() {
        const ids = this.messageQueue.map(m => m.id);
        const uniqueIds = new Set(ids);
        if (ids.length !== uniqueIds.size) {
            console.error('Duplicate message IDs detected:', ids);
            console.error('Message queue:', this.messageQueue);
        }
        return ids.length === uniqueIds.size;
    }
    
    setTerminalForNextMessage(terminalId) {
        // Request the renderer/UI to switch to the specified terminal.
        this.eventBus.emit('terminal:select:request', { terminalId });
        this.eventBus.emit('ui:update-terminal-selector');
        this.logAction(`Terminal ${terminalId} selected for next message`, 'info');
    }
    
    queueContinueMessage() {
        // Auto-queue a "continue" message to resume conversation flow when usage limit resets
        const continueMessage = {
            id: this.generateMessageId(),
            content: 'continue',
            terminalId: this.activeTerminalId,
            timestamp: Date.now(),
            wrapWithPlan: this.planModeEnabled,
            isAutoContinue: true
        };
        
        // Add to the front of the queue so it executes first when timer expires
        const queue = [...this.messageQueue];
        queue.unshift(continueMessage);
        this.messageQueue = queue;
        
        // Emit events for UI updates
        this.eventBus.emit('message:queue-updated', { queue: this.messageQueue });
        this.eventBus.emit('ui:update-status');
        
        this.logAction('Auto-queued "continue" message to resume conversation flow when usage limit resets', 'info');
    }
    
    async addMessageToQueue(providedContent = null, providedTerminalId = null) {
        const input = document.getElementById('message-input');
        const content = providedContent !== null ? providedContent.trim() : input.value.trim();
        
        // Validate content is not empty or just whitespace
        if (!this.isValidMessageContent(content)) {
            return;
        }
        
        // Handle special commands first
        if (await this.handleSpecialCommands(content, input)) {
            return;
        }
        
        // Create message object
        const message = await this.createMessageObject(content, providedTerminalId);
        
        // Add to queue
        const queue = [...this.messageQueue];
        queue.push(message);
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
    
    async createMessageObject(content, providedTerminalId) {
        const terminalId = providedTerminalId || this.activeTerminalId || 'terminal_1';
        
        return {
            id: this.generateMessageId(),
            content: content,
            terminalId: terminalId,
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
        this.eventBus.emit('ui:update-timer');
        this.showSystemNotification('Injection Started', `Sequential injection of ${this.messageQueue.length} messages has begun.`);
        this.logAction(`Timer expired - starting sequential injection of ${this.messageQueue.length} messages (timerExpired=${this.timerExpired}, usageLimitWaiting=${this.usageLimitWaiting})`, 'success');
        
        // Validate state after setting injection progress
        this.validateInjectionState('startSequentialInjection-after');
        
        // Start with first message (no 30-second delay for first message)
        this.processNextQueuedMessage(true);
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
            // Use injection manager for proper plan mode delay handling
            if (this.injectionManager) {
                this.injectionManager.scheduleNextInjection();
            } else {
                // Fallback to direct scheduling
                this.scheduleNextInjection();
            }
        }
    }
    
    injectMessageAndContinueQueue() {
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
        
        // Sync with backend if available
        if (this.backendAPIClient) {
            try {
                await this.backendAPIClient.saveMessageHistory(historyItem);
            } catch (error) {
                console.error('Failed to save message history to backend:', error);
            }
        }
        
        // Clean up old history
        this.cleanupOldMessageHistory();
        
        // Emit event for UI update
        this.eventBus.emit('message:history-updated', { history: this.messageHistory });
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
            const savedHistory = await this.loadPreference('messageHistory');
            if (savedHistory && Array.isArray(savedHistory)) {
                this.messageHistory = new BoundedArray(this.MAX_MESSAGE_HISTORY);
                savedHistory.forEach(item => this.messageHistory.push(item));
                this.cleanupOldMessageHistory();
            }
        } catch (error) {
            console.error('Failed to load message history:', error);
        }
    }
    
    clearMessageHistory() {
        this.messageHistory.clear();
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
        this.sendTerminalInput(tid, content + '\n');
        this.eventBus.emit('message:injected', { terminalId: tid, content });
        if (typeof callback === 'function') callback();
    }

    /**
     * Schedule the next queued injection after a delay, re-checking the R3 gate
     * at fire time. Used as the fallback when no external injectionManager is set.
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
     * Manually inject the next queued message (toolbar / shortcut). Honors the
     * R3 gate via injectNextMessage, which warns + blocks when not allowed.
     */
    manualInjectNextMessage() {
        this.injectNextMessage();
    }
    
    pauseInjectionExecution() {
        this.injectionPaused = true;
        this.eventBus.emit('injection:paused');
        this.logAction('Injection execution paused', 'info');
    }
    
    resumeInjectionExecution() {
        this.injectionPaused = false;
        this.eventBus.emit('injection:resumed');
        this.logAction('Injection execution resumed', 'info');
    }
    
    cancelSequentialInjection() {
        this.injectionInProgress = false;
        this.injectionPaused = false;
        this.isInjecting = false;
        
        // Clear all timers and intervals
        if (this.injectionTimer) {
            clearTimeout(this.injectionTimer);
            this.injectionTimer = null;
        }
        
        if (this.currentTypeInterval) {
            clearInterval(this.currentTypeInterval);
            this.currentTypeInterval = null;
        }
        
        // Clear injection tracking
        this.currentlyInjectingTerminals.clear();
        this.currentlyInjectingMessages.clear();
        this.currentlyInjectingMessageId = null;
        
        this.eventBus.emit('injection:cancelled');
        this.eventBus.emit('ui:update-timer');
        this.logAction('Sequential injection cancelled', 'warning');
    }
}

module.exports = MessageQueueManager;
