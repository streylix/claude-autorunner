/**
 * EventProcessors - Consolidated event processing
 * Replaces 82 scattered handlers with 12 focused processors
 * Each processor handles a category of related events
 */

class EventProcessors {
    constructor(stateManager, terminalManager, messageManager) {
        this.stateManager = stateManager;
        this.terminalManager = terminalManager;
        this.messageManager = messageManager;
    }

    /**
     * Process all terminal-related events
     * Consolidates ~25 terminal handlers into 1 processor
     */
    processTerminalEvents({ event, data, bus }) {
        // Canonical events use the form `terminal:status:changed`, so the
        // meaningful sub-type is everything after the first segment.
        const eventType = event.split(':').slice(1).join(':');

        switch (eventType) {
            case 'data':
                this.handleTerminalData(data);
                break;
            case 'ready':
                this.handleTerminalReady(data);
                break;
            case 'closed':
                this.handleTerminalClosed(data);
                break;
            case 'error':
                this.handleTerminalError(data);
                break;
            case 'status:changed':
                this.handleTerminalStatusChange(data);
                break;
            case 'selected':
                this.handleTerminalSelection(data);
                break;
            case 'created':
                this.handleTerminalCreation(data);
                break;
            default:
                // Many terminal:* events are consumed directly by feature managers
                // (StatusManager, CompletionManager). Those are intentionally not
                // handled here; stay silent to avoid noisy warnings.
                break;
        }
    }

    /**
     * Process all message-related events
     * Consolidates ~20 message handlers into 1 processor
     */
    processMessageEvents({ event, data, bus }) {
        const eventType = event.split(':')[1];
        
        // MessageQueueManager subscribes to its own message:* events directly.
        // The processor defensively forwards to optional handlers if present.
        const handlerMap = {
            queued: 'handleMessageQueued',
            inject: 'handleMessageInject',
            completed: 'handleMessageCompleted',
            failed: 'handleMessageFailed',
            cleared: 'handleQueueCleared'
        };
        const method = handlerMap[eventType];
        if (method) {
            this.safeCall(this.messageManager, method, data);
        }
    }

    /**
     * Process timer events
     * Consolidates ~12 timer handlers into 1 processor
     */
    processTimerEvents({ event, data, bus }) {
        const eventType = event.split(':')[1];
        
        // Timer lifecycle is owned by TimerManager (direct subscriptions).
        // The processor only reacts to expiry for injection resumption.
        switch (eventType) {
            case 'expired':
                this.handleTimerExpired(data);
                break;
            default:
                break;
        }
    }

    /**
     * Process UI events
     * Consolidates ~15 UI handlers into 1 processor
     */
    processUIEvents({ event, data, bus }) {
        const eventType = event.split(':')[1];
        
        // UI events are largely handled by dedicated UI managers / direct
        // subscriptions. Route only known state-backed UI actions, defensively.
        switch (eventType) {
            case 'theme-change':
                this.safeCall(this.stateManager, 'setState', 'app', 'ui.theme', data.theme);
                break;
            default:
                break;
        }
    }

    /**
     * Process state change events
     * Consolidates state update handlers
     */
    processStateEvents({ event, data, bus }) {
        const eventType = event.split(':')[1];
        
        switch (eventType) {
            case 'updated':
                this.handleStateUpdate(data);
                break;
            case 'saved':
                this.handleStateSaved(data);
                break;
            case 'loaded':
                this.handleStateLoaded(data);
                break;
            case 'reset':
                this.handleStateReset(data);
                break;
            default:
                // state:changing / state:changed / state:initialized etc. are
                // observed elsewhere; ignore quietly here.
                break;
        }
    }

    /**
     * Process completion tracking events
     */
    processCompletionEvents({ event, data, bus }) {
        const eventType = event.split(':')[1];
        
        switch (eventType) {
            case 'detected':
                this.handleCompletionDetected(data);
                break;
            case 'tracked':
                this.handleCompletionTracked(data);
                break;
            case 'analyzed':
                this.handleCompletionAnalyzed(data);
                break;
            default:
                // Other completion:* events are handled by CompletionManager.
                break;
        }
    }

    /**
     * Process input events (keyboard and mouse)
     * Consolidates input handlers
     */
    processInputEvents({ event, data, bus }) {
        const eventType = event.split(':')[1];
        
        if (eventType === 'shortcut') {
            this.handleKeyboardShortcut(data);
        } else if (eventType === 'click') {
            this.handleMouseClick(data);
        }
    }

    /**
     * Process IPC events from main process
     * Consolidates IPC handlers
     */
    processIPCEvents({ event, data, bus }) {
        const ipcEvent = event.replace('ipc:', '');
        
        // Forward to appropriate processor
        if (ipcEvent.startsWith('terminal-')) {
            bus.emit(`terminal:${ipcEvent.replace('terminal-', '')}`, data);
        } else if (ipcEvent.startsWith('message-')) {
            bus.emit(`message:${ipcEvent.replace('message-', '')}`, data);
        } else if (ipcEvent.startsWith('timer-')) {
            bus.emit(`timer:${ipcEvent.replace('timer-', '')}`, data);
        }
    }

    /**
     * Process file system events
     */
    processFileEvents({ event, data, bus }) {
        const eventType = event.split(':')[1];
        
        switch (eventType) {
            case 'saved':
                this.handleFileSaved(data);
                break;
            case 'loaded':
                this.handleFileLoaded(data);
                break;
            case 'deleted':
                this.handleFileDeleted(data);
                break;
            default:
                break;
        }
    }

    /**
     * Process audio events
     */
    processAudioEvents({ event, data, bus }) {
        const eventType = event.split(':')[1];
        
        if (eventType === 'play' && data.sound) {
            this.playSound(data.sound);
        }
    }

    /**
     * Process error events
     */
    processErrorEvents({ event, data, bus }) {
        console.error(`Error event: ${event}`, data);

        // Surface the error to the action log via the bus.
        bus.emit('log:action', {
            message: `Error: ${(data && data.message) || 'Unknown error'}`,
            type: 'error'
        });
    }

    /**
     * Default processor for uncategorized events
     */
    processDefaultEvents({ event, data, bus }) {
        // Uncategorized events are commonly consumed by direct subscribers
        // (e.g. log:action, sound:*, queue:*). No central handling needed.
    }

    // Helper methods for terminal events.
    // NOTE: terminal output is written to xterm and mirrored into state by the
    // renderer's IPC handler. These processors only perform best-effort state
    // bookkeeping and defensively guard against absent manager methods, since
    // the underlying managers expose differing APIs.
    handleTerminalData(data) {
        // Output rendering/state is owned by the renderer IPC handler; no-op here
        // to avoid double-writing to the terminal.
    }

    handleTerminalReady(data) {
        this.safeCall(this.terminalManager, 'markTerminalReady', data.terminalId);
        this.safeCall(this.stateManager, 'setState', 'terminal', `update:${data.terminalId}`, { isReady: true });
    }

    handleTerminalClosed(data) {
        this.safeCall(this.terminalManager, 'removeTerminal', data.terminalId);
    }

    handleTerminalError(data) {
        console.error(`Terminal ${data.terminalId} error:`, data.error);
    }

    handleTerminalStatusChange(data) {
        // StatusManager owns status display/state; processor stays out of the way.
    }

    handleTerminalSelection(data) {
        this.safeCall(this.stateManager, 'setState', 'terminal', 'setActive', data.terminalId);
    }

    handleTerminalCreation(data) {
        // Terminal creation is driven directly by the renderer; nothing to do here.
    }

    /**
     * Call a method on target only if it exists; never throw.
     */
    safeCall(target, method, ...args) {
        if (target && typeof target[method] === 'function') {
            try {
                return target[method](...args);
            } catch (error) {
                console.error(`EventProcessors.safeCall(${method}) failed:`, error);
            }
        }
        return undefined;
    }

    // Helper methods for other events
    handleTimerExpired(data) {
        if (data && data.terminalId) {
            this.safeCall(this.messageManager, 'resumeInjection', data.terminalId);
        }
    }

    handleStateUpdate(data) {
        // Trigger UI updates as needed
        if (data.path && data.path.startsWith('ui.')) {
            this.updateUI(data.path, data.value);
        }
    }

    handleStateSaved(data) {
        console.log('State saved successfully');
    }

    handleStateLoaded(data) {
        console.log('State loaded successfully');
    }

    handleStateReset(data) {
        console.log('State reset to defaults');
    }

    handleCompletionDetected(data) {
        // CompletionManager owns completion lifecycle; no-op fallback.
    }

    handleCompletionTracked(data) {
        // CompletionManager owns completion lifecycle; no-op fallback.
    }

    handleCompletionAnalyzed(data) {
        // CompletionManager owns completion lifecycle; no-op fallback.
    }

    handleKeyboardShortcut(data) {
        // Route keyboard shortcuts to appropriate handlers
        const actions = {
            'cmd+n': () => this.terminalManager.createNewTerminal(),
            'cmd+w': () => this.terminalManager.closeActiveTerminal(),
            'cmd+tab': () => this.terminalManager.switchToNextTerminal(),
            'cmd+shift+tab': () => this.terminalManager.switchToPreviousTerminal(),
            'cmd+1': () => this.terminalManager.switchToTerminal(1),
            'cmd+2': () => this.terminalManager.switchToTerminal(2),
            'cmd+3': () => this.terminalManager.switchToTerminal(3),
            'cmd+s': () => this.stateManager.saveState(),
            'cmd+,': () => this.stateManager.openSettings()
        };
        
        if (actions[data.key]) {
            actions[data.key]();
        }
    }

    handleMouseClick(data) {
        // Handle mouse clicks on specific elements
        if (data.target && data.target.dataset.action) {
            this.handleAction(data.target.dataset.action, data);
        }
    }

    handleFileSaved(data) {
        console.log(`File saved: ${data.path}`);
    }

    handleFileLoaded(data) {
        console.log(`File loaded: ${data.path}`);
    }

    handleFileDeleted(data) {
        console.log(`File deleted: ${data.path}`);
    }

    playSound(soundName) {
        // Delegate to audio manager when available
        if (this.audioManager) {
            this.audioManager.play(soundName);
        }
    }

    updateUI(path, value) {
        // Trigger UI updates based on state changes
        // This will be connected to the UI layer
    }

    handleAction(action, data) {
        // Route UI actions to appropriate handlers
        console.log(`Action: ${action}`, data);
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = EventProcessors;
}