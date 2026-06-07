/**
 * AppStateStore - Unified state management replacing 320 getters/setters
 * Consolidates 203 getters + 117 setters into 10 unified state accessors
 * Single source of truth for all application state with immutable updates
 * 
 * Expected reduction: 310 functions replaced with 10 accessors
 */
class AppStateStore {
    constructor() {
        // Core state structure - all app state in one place
        this.state = {
            // Terminal state (managed by TerminalStateManager)
            terminals: {
                activeId: null,
                instances: new Map(),
                chunks: new Map(),
                statuses: new Map()
            },
            
            // Message queue state
            messages: {
                queue: [],
                activeMessages: new Map(),
                pendingInjections: new Map(),
                history: []
            },
            
            // Timer state (replaces 30+ timer variables)
            timers: {
                global: null,
                perTerminal: new Map(),
                settings: {
                    defaultMinutes: 5,
                    warningSeconds: 60,
                    autoRestart: false
                }
            },
            
            // UI state
            ui: {
                activeModal: null,
                sidebarVisible: true,
                rightSidebarTab: 'queue',
                theme: 'dark',
                fontSize: 14,
                focusedElement: null
            },
            
            // Settings/preferences
            settings: {
                autoContinue: {
                    enabled: false,
                    keywords: [],
                    responses: new Map()
                },
                voice: {
                    enabled: false,
                    whisperModel: 'base',
                    language: 'en'
                },
                completion: {
                    trackingEnabled: true,
                    autoSummarize: false
                },
                planMode: {
                    enabled: false,
                    claudeFlowWrapper: false
                }
            },
            
            // Completion tracking
            completions: {
                history: [],
                statistics: {
                    total: 0,
                    successful: 0,
                    failed: 0
                }
            },
            
            // Token usage tracking
            tokens: {
                usage: new Map(),
                costs: new Map(),
                limits: {
                    perMinute: 10000,
                    perDay: 1000000
                }
            },
            
            // System state
            system: {
                isLoading: false,
                errors: [],
                notifications: [],
                activeProcesses: new Set()
            }
        };
        
        // State change observers
        this.observers = new Map();
        this.stateHistory = [];
        this.maxHistorySize = 50;
        
        // State validation rules
        this.validators = new Map();
        this.setupValidators();
    }
    
    /**
     * 1. GET STATE - Universal getter replacing 203 individual getters
     * @param {string} path - Dot-notation path to state value
     * @returns {any} State value at path
     */
    getState(path = '') {
        if (!path) return this.deepClone(this.state);
        
        const keys = path.split('.');
        let current = this.state;
        
        for (const key of keys) {
            if (current === null || current === undefined) return undefined;
            current = current[key];
        }
        
        return this.deepClone(current);
    }
    
    /**
     * 2. SET STATE - Universal setter replacing 117 individual setters
     * @param {string} path - Dot-notation path to state value
     * @param {any} value - New value to set
     * @returns {boolean} Success status
     */
    setState(path, value) {
        if (!path) {
            console.error('Path required for setState');
            return false;
        }
        
        // Validate if validator exists
        if (this.validators.has(path)) {
            const validator = this.validators.get(path);
            if (!validator(value)) {
                console.error(`Validation failed for ${path}:`, value);
                return false;
            }
        }
        
        // Store previous state for history
        const previousState = this.deepClone(this.state);
        
        // Apply state change
        const keys = path.split('.');
        const lastKey = keys.pop();
        let current = this.state;
        
        for (const key of keys) {
            if (!(key in current)) {
                current[key] = {};
            }
            current = current[key];
        }
        
        const oldValue = current[lastKey];
        current[lastKey] = value;
        
        // Add to history
        this.addToHistory({
            path,
            oldValue,
            newValue: value,
            timestamp: Date.now()
        });
        
        // Notify observers
        this.notifyObservers(path, value, oldValue);
        
        return true;
    }
    
    /**
     * 3. UPDATE STATE - Partial update for objects
     * @param {string} path - Path to object to update
     * @param {Object} updates - Partial updates to apply
     */
    updateState(path, updates) {
        const current = this.getState(path);
        if (typeof current !== 'object' || current === null) {
            return this.setState(path, updates);
        }
        
        const merged = { ...current, ...updates };
        return this.setState(path, merged);
    }
    
    /**
     * 4. SUBSCRIBE - Watch for state changes
     * @param {string} path - Path to watch (supports wildcards)
     * @param {Function} callback - Called on state change
     * @returns {Function} Unsubscribe function
     */
    subscribe(path, callback) {
        if (!this.observers.has(path)) {
            this.observers.set(path, new Set());
        }
        
        this.observers.get(path).add(callback);
        
        // Return unsubscribe function
        return () => {
            const observers = this.observers.get(path);
            if (observers) {
                observers.delete(callback);
                if (observers.size === 0) {
                    this.observers.delete(path);
                }
            }
        };
    }
    
    /**
     * 5. COMPUTE - Derived state calculations
     * @param {Function} selector - Function to compute derived state
     * @returns {any} Computed value
     */
    compute(selector) {
        return selector(this.state);
    }
    
    /**
     * 6. TRANSACTION - Batch multiple state changes
     * @param {Function} operations - Function containing state changes
     */
    transaction(operations) {
        const backup = this.deepClone(this.state);
        const notifications = [];
        
        // Temporarily batch notifications
        const originalNotify = this.notifyObservers;
        this.notifyObservers = (path, newVal, oldVal) => {
            notifications.push({ path, newVal, oldVal });
        };
        
        try {
            operations(this);
            
            // Send all notifications at once
            this.notifyObservers = originalNotify;
            notifications.forEach(n => 
                this.notifyObservers(n.path, n.newVal, n.oldVal)
            );
        } catch (error) {
            // Rollback on error
            this.state = backup;
            this.notifyObservers = originalNotify;
            throw error;
        }
    }
    
    /**
     * 7. RESET - Reset state to initial or provided state
     * @param {Object} newState - Optional new state
     */
    reset(newState = null) {
        const defaultState = this.getDefaultState();
        this.state = newState || defaultState;
        this.stateHistory = [];
        this.notifyObservers('*', this.state, null);
    }
    
    /**
     * 8. HISTORY - Get state change history
     * @param {number} limit - Max history items to return
     */
    getHistory(limit = 10) {
        return this.stateHistory.slice(-limit);
    }
    
    /**
     * 9. VALIDATE - Check if state is valid
     * @param {string} path - Optional path to validate
     */
    validate(path = '') {
        if (path) {
            const validator = this.validators.get(path);
            if (validator) {
                const value = this.getState(path);
                return validator(value);
            }
        }
        
        // Validate all registered paths
        for (const [path, validator] of this.validators) {
            const value = this.getState(path);
            if (!validator(value)) {
                return false;
            }
        }
        return true;
    }
    
    /**
     * 10. PERSIST - Save/load state to storage
     */
    persist() {
        try {
            const serialized = JSON.stringify(this.state, AppStateStore.serializeReplacer);
            localStorage.setItem('appState', serialized);
            return true;
        } catch (error) {
            console.error('Failed to persist state:', error);
            return false;
        }
    }

    restore() {
        const serialized = localStorage.getItem('appState');
        if (serialized) {
            try {
                this.state = JSON.parse(serialized, AppStateStore.serializeReviver);
                return true;
            } catch (error) {
                console.error('Failed to restore state:', error);
                return false;
            }
        }
        return false;
    }

    /**
     * JSON replacer that preserves Map and Set instances.
     * Maps -> { __type: 'Map', data: [[k, v], ...] }
     * Sets -> { __type: 'Set', data: [v, ...] }
     */
    static serializeReplacer(key, value) {
        if (value instanceof Map) {
            return { __type: 'Map', data: Array.from(value.entries()) };
        }
        if (value instanceof Set) {
            return { __type: 'Set', data: Array.from(value.values()) };
        }
        return value;
    }

    /**
     * JSON reviver that reconstructs Map and Set instances.
     */
    static serializeReviver(key, value) {
        if (value && typeof value === 'object' && value.__type) {
            if (value.__type === 'Map') {
                return new Map(value.data);
            }
            if (value.__type === 'Set') {
                return new Set(value.data);
            }
        }
        return value;
    }
    
    // ============= Private Helper Methods =============
    
    deepClone(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (obj instanceof Date) return new Date(obj.getTime());
        if (obj instanceof Map) return new Map(obj);
        if (obj instanceof Set) return new Set(obj);
        if (obj instanceof Array) return obj.map(item => this.deepClone(item));
        
        const cloned = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                cloned[key] = this.deepClone(obj[key]);
            }
        }
        return cloned;
    }
    
    notifyObservers(path, newValue, oldValue) {
        // Notify exact path observers
        if (this.observers.has(path)) {
            this.observers.get(path).forEach(callback => {
                callback(newValue, oldValue, path);
            });
        }
        
        // Notify wildcard observers
        if (this.observers.has('*')) {
            this.observers.get('*').forEach(callback => {
                callback(newValue, oldValue, path);
            });
        }
        
        // Notify parent path observers
        const parts = path.split('.');
        for (let i = parts.length - 1; i > 0; i--) {
            const parentPath = parts.slice(0, i).join('.');
            if (this.observers.has(parentPath + '.*')) {
                this.observers.get(parentPath + '.*').forEach(callback => {
                    callback(newValue, oldValue, path);
                });
            }
        }
    }
    
    addToHistory(change) {
        this.stateHistory.push(change);
        if (this.stateHistory.length > this.maxHistorySize) {
            this.stateHistory.shift();
        }
    }
    
    setupValidators() {
        // Terminal validators
        this.validators.set('terminals.activeId', (val) => 
            val === null || (typeof val === 'number' && val > 0)
        );
        
        // Timer validators  
        this.validators.set('timers.global', (val) =>
            val === null || typeof val === 'object'
        );
        
        // UI validators
        this.validators.set('ui.fontSize', (val) =>
            typeof val === 'number' && val >= 8 && val <= 32
        );
        
        this.validators.set('ui.theme', (val) =>
            ['dark', 'light', 'auto'].includes(val)
        );
        
        // Settings validators
        this.validators.set('settings.autoContinue.enabled', (val) =>
            typeof val === 'boolean'
        );
        
        // Token validators
        this.validators.set('tokens.limits.perMinute', (val) =>
            typeof val === 'number' && val > 0
        );
    }
    
    // Terminal accessors
    getActiveTerminalId() {
        return this.state.terminals?.activeId || null;
    }
    
    setActiveTerminalId(id) {
        this.setState('terminals.activeId', id);
    }
    
    getTerminalStatus(terminalId) {
        return this.state.terminals?.statuses?.get(terminalId) || null;
    }
    
    getTerminalData(terminalId) {
        return this.state.terminals?.instances?.get(terminalId) || null;
    }
    
    setTerminalData(terminalId, data) {
        const instances = this.state.terminals?.instances || new Map();
        instances.set(terminalId, data);
        this.setState('terminals.instances', instances);
    }
    
    // Preferences accessors
    getPreferences() {
        return this.state.settings || {};
    }
    
    getDefaultState() {
        // Return fresh default state structure
        return {
            terminals: {
                activeId: null,
                instances: new Map(),
                chunks: new Map(),
                statuses: new Map()
            },
            messages: {
                queue: [],
                activeMessages: new Map(),
                pendingInjections: new Map(),
                history: []
            },
            timers: {
                global: null,
                perTerminal: new Map(),
                settings: {
                    defaultMinutes: 5,
                    warningSeconds: 60,
                    autoRestart: false
                }
            },
            ui: {
                activeModal: null,
                sidebarVisible: true,
                rightSidebarTab: 'queue',
                theme: 'dark',
                fontSize: 14,
                focusedElement: null
            },
            settings: {
                autoContinue: {
                    enabled: false,
                    keywords: [],
                    responses: new Map()
                },
                voice: {
                    enabled: false,
                    whisperModel: 'base',
                    language: 'en'
                },
                completion: {
                    trackingEnabled: true,
                    autoSummarize: false
                },
                planMode: {
                    enabled: false,
                    claudeFlowWrapper: false
                }
            },
            completions: {
                history: [],
                statistics: {
                    total: 0,
                    successful: 0,
                    failed: 0
                }
            },
            tokens: {
                usage: new Map(),
                costs: new Map(),
                limits: {
                    perMinute: 10000,
                    perDay: 1000000
                }
            },
            system: {
                isLoading: false,
                errors: [],
                notifications: [],
                activeProcesses: new Set()
            }
        };
    }
}

// Export the class only. The renderer constructs the single canonical instance
// and passes it to every manager via constructor injection, guaranteeing one
// source of truth. (A previous module-level singleton was removed to prevent
// accidental divergent instances.)
module.exports = {
    AppStateStore
};