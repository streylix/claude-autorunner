/**
 * StateManager - Coordination layer between all state stores
 * Provides unified interface for state management across the application
 * Bridges AppStateStore, TerminalStateManager, and EventBus
 * 
 * Expected reduction: 15 coordination functions replacing scattered state logic
 */
class StateManager {
    constructor() {
        this.stores = new Map();
        this.eventBus = null;
        this.initialized = false;
    }
    
    /**
     * Initialize state management system with all stores
     */
    async initialize(eventBus, appStateStore, terminalStateManager) {
        if (this.initialized) {
            console.warn('StateManager already initialized');
            return;
        }
        
        this.eventBus = eventBus;
        this.stores.set('app', appStateStore);
        this.stores.set('terminal', terminalStateManager);
        
        // Setup cross-store synchronization
        this.setupSynchronization();
        
        // Restore persisted state
        await this.restoreState();
        
        this.initialized = true;
        this.eventBus.emit('state:initialized');
    }
    
    /**
     * Get state from appropriate store
     * @param {string} domain - State domain (app, terminal)
     * @param {string} path - Path within domain
     */
    getState(domain, path = '') {
        const store = this.stores.get(domain);
        if (!store) {
            console.error(`Unknown state domain: ${domain}`);
            return undefined;
        }
        
        if (domain === 'app') {
            return store.getState(path);
        } else if (domain === 'terminal') {
            // Handle terminal-specific getters
            if (path === 'active') {
                return store.getActiveTerminal();
            } else if (path === 'all') {
                return store.getAllTerminals();
            } else if (path.startsWith('id:')) {
                const id = parseInt(path.substring(3));
                return store.getTerminal(id);
            }
            return store.getState ? store.getState(path) : undefined;
        }
    }
    
    /**
     * Set state in appropriate store
     * @param {string} domain - State domain
     * @param {string} path - Path within domain
     * @param {any} value - Value to set
     */
    setState(domain, path, value) {
        const store = this.stores.get(domain);
        if (!store) {
            console.error(`Unknown state domain: ${domain}`);
            return false;
        }
        
        // Emit pre-change event
        this.eventBus.emit('state:changing', { domain, path, value });
        
        let result = false;
        if (domain === 'app') {
            result = store.setState(path, value);
        } else if (domain === 'terminal') {
            // Handle terminal-specific setters
            const [action, ...params] = path.split(':');
            switch (action) {
                case 'create':
                    result = store.createTerminal(value);
                    break;
                case 'update':
                    const id = parseInt(params[0]);
                    result = store.updateTerminal(id, value);
                    break;
                case 'delete':
                    result = store.deleteTerminal(parseInt(value));
                    break;
                case 'setActive':
                    result = store.setActiveTerminal(value);
                    break;
                default:
                    if (store.setState) {
                        result = store.setState(path, value);
                    }
            }
        }
        
        // Emit post-change event
        if (result) {
            this.eventBus.emit('state:changed', { domain, path, value });
        }
        
        return result;
    }
    
    /**
     * Execute state transaction across multiple stores
     * @param {Function} operations - Transaction operations
     */
    async transaction(operations) {
        const backups = new Map();
        
        // Backup all stores
        for (const [name, store] of this.stores) {
            if (store.getState) {
                backups.set(name, store.getState());
            }
        }
        
        try {
            // Execute transaction
            await operations(this);
            
            // Persist state after successful transaction
            await this.persistState();
            
            return true;
        } catch (error) {
            // Rollback all stores
            console.error('Transaction failed, rolling back:', error);
            for (const [name, backup] of backups) {
                const store = this.stores.get(name);
                if (store.reset) {
                    store.reset(backup);
                }
            }
            return false;
        }
    }
    
    /**
     * Subscribe to state changes across all stores
     * @param {string} pattern - Domain:path pattern
     * @param {Function} callback - Change callback
     */
    subscribe(pattern, callback) {
        const [domain, path] = pattern.split(':');
        
        if (domain === '*') {
            // Subscribe to all domains
            const unsubscribers = [];
            for (const [name, store] of this.stores) {
                if (store.subscribe) {
                    unsubscribers.push(store.subscribe(path || '*', callback));
                }
            }
            
            // Return combined unsubscribe function
            return () => unsubscribers.forEach(unsub => unsub());
        } else {
            const store = this.stores.get(domain);
            if (store && store.subscribe) {
                return store.subscribe(path || '*', callback);
            }
        }
        
        return () => {}; // No-op unsubscribe
    }
    
    /**
     * Compute derived state across stores
     * @param {Function} selector - Selector function
     */
    compute(selector) {
        const stateProxy = {};
        for (const [name, store] of this.stores) {
            if (store.getState) {
                stateProxy[name] = store.getState();
            }
        }
        return selector(stateProxy);
    }
    
    /**
     * Get aggregated metrics from all stores
     */
    getMetrics() {
        return {
            terminals: {
                total: this.getState('terminal', 'all')?.length || 0,
                active: this.getState('terminal', 'active')?.id || null,
                ready: this.stores.get('terminal')?.readyTerminals?.size || 0,
                busy: this.stores.get('terminal')?.busyTerminals?.size || 0
            },
            messages: {
                queued: this.getState('app', 'messages.queue')?.length || 0,
                active: this.getState('app', 'messages.activeMessages')?.size || 0,
                pending: this.getState('app', 'messages.pendingInjections')?.size || 0
            },
            timers: {
                active: this.getState('app', 'timers.global') !== null,
                perTerminal: this.getState('app', 'timers.perTerminal')?.size || 0
            },
            system: {
                isLoading: this.getState('app', 'system.isLoading'),
                errorCount: this.getState('app', 'system.errors')?.length || 0,
                processCount: this.getState('app', 'system.activeProcesses')?.size || 0
            }
        };
    }
    
    /**
     * Reset all stores to default state
     */
    resetAll() {
        for (const [name, store] of this.stores) {
            if (store.reset) {
                store.reset();
            }
        }
        this.eventBus.emit('state:reset');
    }
    
    /**
     * Persist state to storage
     */
    async persistState() {
        const state = {};
        for (const [name, store] of this.stores) {
            if (store.getState) {
                state[name] = store.getState();
            }
        }
        
        try {
            localStorage.setItem('unifiedState', JSON.stringify(state));
            return true;
        } catch (error) {
            console.error('Failed to persist state:', error);
            return false;
        }
    }
    
    /**
     * Restore state from storage
     */
    async restoreState() {
        try {
            const saved = localStorage.getItem('unifiedState');
            if (!saved) return false;
            
            const state = JSON.parse(saved);
            
            // Restore each store
            for (const [name, storeState] of Object.entries(state)) {
                const store = this.stores.get(name);
                if (store && store.reset) {
                    store.reset(storeState);
                }
            }
            
            this.eventBus.emit('state:restored');
            return true;
        } catch (error) {
            console.error('Failed to restore state:', error);
            return false;
        }
    }
    
    /**
     * Setup cross-store synchronization
     */
    setupSynchronization() {
        const terminalStore = this.stores.get('terminal');
        const appStore = this.stores.get('app');

        // TerminalStateManager exposes an observer API (addObserver) rather than
        // the path-based subscribe() of AppStateStore. Bridge it here so changes
        // in the terminal store are mirrored into the unified app state.
        if (terminalStore && typeof terminalStore.addObserver === 'function') {
            terminalStore.addObserver((event, data) => {
                // Keep the canonical active id in sync.
                if (event === 'active-terminal-changed') {
                    appStore.setState('terminals.activeId', data.current ?? null);
                }

                // Mirror the terminal instances Map into app state on any change
                // to terminal membership/state.
                if (event === 'terminal-created' || event === 'terminal-removed' ||
                    event === 'terminal-updated' || event === 'terminal-status-changed') {
                    appStore.setState('terminals.instances', terminalStore.getAllTerminals());
                }
            });
        }

        // Emit events for app-state changes (wildcard observer).
        if (appStore && typeof appStore.subscribe === 'function') {
            appStore.subscribe('*', (newVal, oldVal, path) => {
                this.eventBus.emit('app:state:changed', { path, newVal, oldVal });
            });

            // Handle system loading state changes.
            appStore.subscribe('system.isLoading', (isLoading) => {
                this.eventBus.emit(isLoading ? 'system:loading' : 'system:ready');
            });

            // Handle error state changes.
            appStore.subscribe('system.errors', (errors) => {
                if (Array.isArray(errors) && errors.length > 0) {
                    this.eventBus.emit('system:error', errors[errors.length - 1]);
                }
            });
        }
    }
    
    /**
     * Debug helper - dump all state
     */
    dumpState() {
        const state = {};
        for (const [name, store] of this.stores) {
            if (store.getState) {
                state[name] = store.getState();
            } else if (name === 'terminal') {
                state[name] = {
                    terminals: store.getAllTerminals(),
                    active: store.getActiveTerminal(),
                    ready: Array.from(store.readyTerminals || []),
                    busy: Array.from(store.busyTerminals || [])
                };
            }
        }
        return state;
    }
}

// Export singleton instance
const stateManager = new StateManager();

module.exports = {
    StateManager,
    stateManager
};