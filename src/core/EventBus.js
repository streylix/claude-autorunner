/**
 * EventBus - Centralized event management system
 * Replaces 9 duplicate setupEventListeners with single source of truth
 * Consolidates 82 scattered handlers into 12 focused processors
 * 
 * Expected function reduction: 70 functions
 */
class EventBus {
    constructor() {
        console.log('🚀 EventBus: Initializing...');
        this.events = new Map();
        this.processors = new Map();
        this.eventHistory = [];
        this.maxHistorySize = 100;
        console.log('✅ EventBus: Initialized successfully');
    }

    /**
     * Register an event processor for a category of events
     * Replaces multiple individual handlers with single processor
     */
    registerProcessor(category, processor) {
        if (typeof processor !== 'function') {
            throw new Error(`Processor for ${category} must be a function`);
        }
        this.processors.set(category, processor);
        return this;
    }

    /**
     * Subscribe to specific events
     * Unified subscription replacing scattered event listeners
     */
    on(event, handler, context = null) {
        if (!this.events.has(event)) {
            this.events.set(event, []);
        }
        
        const handlers = this.events.get(event);
        handlers.push({ handler, context });
        
        return () => this.off(event, handler);
    }

    /**
     * One-time event subscription
     */
    once(event, handler, context = null) {
        const wrappedHandler = (...args) => {
            handler.apply(context, args);
            this.off(event, wrappedHandler);
        };
        
        return this.on(event, wrappedHandler, context);
    }

    /**
     * Unsubscribe from events
     */
    off(event, handler) {
        if (!this.events.has(event)) return;
        
        const handlers = this.events.get(event);
        const index = handlers.findIndex(h => h.handler === handler);
        
        if (index !== -1) {
            handlers.splice(index, 1);
        }
        
        if (handlers.length === 0) {
            this.events.delete(event);
        }
    }

    /**
     * Emit events with automatic processor routing
     * This replaces dozens of individual handler calls
     */
    emit(event, data = {}) {
        // Record event for debugging
        this.recordEvent(event, data);
        
        // Route to appropriate processor based on event category
        const category = this.getEventCategory(event);
        if (this.processors.has(category)) {
            const processor = this.processors.get(category);
            processor({ event, data, bus: this });
        }
        
        // Call specific handlers
        if (this.events.has(event)) {
            const handlers = this.events.get(event).slice();
            handlers.forEach(({ handler, context }) => {
                try {
                    handler.call(context, data);
                } catch (error) {
                    console.error(`Error in event handler for ${event}:`, error);
                }
            });
        }
        
        // Emit wildcard for monitoring
        if (event !== '*' && this.events.has('*')) {
            this.emit('*', { event, data });
        }
    }

    /**
     * Batch emit multiple events efficiently
     */
    emitBatch(events) {
        events.forEach(({ event, data }) => this.emit(event, data));
    }

    /**
     * Get event category for processor routing
     * This categorization replaces 82 individual handlers with 12 processors
     */
    getEventCategory(event) {
        const [category] = event.split(':');
        
        // Map event prefixes to processor categories
        const categoryMap = {
            'terminal': 'terminal',
            'message': 'message',
            'timer': 'timer',
            'ui': 'ui',
            'state': 'state',
            'completion': 'completion',
            'keyboard': 'input',
            'mouse': 'input',
            'ipc': 'ipc',
            'file': 'file',
            'audio': 'audio',
            'error': 'error'
        };
        
        return categoryMap[category] || 'default';
    }

    /**
     * Record event for debugging and replay
     */
    recordEvent(event, data) {
        this.eventHistory.push({
            event,
            data,
            timestamp: Date.now()
        });
        
        // Maintain bounded history
        if (this.eventHistory.length > this.maxHistorySize) {
            this.eventHistory.shift();
        }
    }

    /**
     * Get event history for debugging
     */
    getHistory(filter = null) {
        if (!filter) return this.eventHistory.slice();
        
        return this.eventHistory.filter(entry => 
            entry.event.includes(filter) || 
            this.getEventCategory(entry.event) === filter
        );
    }

    /**
     * Clear all event subscriptions
     */
    clear() {
        this.events.clear();
        this.processors.clear();
        this.eventHistory = [];
    }

    /**
     * Get statistics about event usage
     */
    getStats() {
        const stats = {
            totalEvents: this.events.size,
            totalHandlers: 0,
            totalProcessors: this.processors.size,
            eventsByCategory: new Map()
        };
        
        this.events.forEach((handlers, event) => {
            stats.totalHandlers += handlers.length;
            const category = this.getEventCategory(event);
            stats.eventsByCategory.set(
                category,
                (stats.eventsByCategory.get(category) || 0) + 1
            );
        });
        
        return stats;
    }

    /**
     * Setup IPC event forwarding
     * Consolidates IPC handler setup from multiple files
     */
    setupIPCForwarding(ipcRenderer) {
        const ipcEvents = [
            'terminal-data',
            'terminal-ready',
            'terminal-closed',
            'terminal-error',
            'message-queued',
            'message-injected',
            'timer-update',
            'completion-detected',
            'usage-limit-reached'
        ];
        
        ipcEvents.forEach(ipcEvent => {
            ipcRenderer.on(ipcEvent, (event, data) => {
                this.emit(`ipc:${ipcEvent}`, data);
            });
        });
    }

    /**
     * Setup unified keyboard shortcuts
     * Replaces scattered keyboard handlers
     */
    setupKeyboardShortcuts(shortcuts) {
        document.addEventListener('keydown', (e) => {
            const key = this.getKeyCombo(e);
            
            if (shortcuts[key]) {
                e.preventDefault();
                this.emit('keyboard:shortcut', {
                    key,
                    action: shortcuts[key],
                    event: e
                });
            }
        });
    }

    /**
     * Get normalized key combination
     */
    getKeyCombo(e) {
        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push('cmd');
        if (e.altKey) parts.push('alt');
        if (e.shiftKey) parts.push('shift');
        parts.push(e.key.toLowerCase());
        return parts.join('+');
    }
}

// Export for both Node and browser environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = EventBus;
} else if (typeof window !== 'undefined') {
    window.EventBus = EventBus;
}