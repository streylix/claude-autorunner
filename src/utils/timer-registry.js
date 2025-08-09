/**
 * Centralized timer management to prevent memory leaks
 * Tracks all setInterval and setTimeout operations for proper cleanup
 */
class TimerRegistry {
    constructor() {
        this.intervals = new Map(); // Map of timer name to interval ID
        this.timeouts = new Map();  // Map of timer name to timeout ID
        this.cleanup = this.cleanup.bind(this);
        
        // Register cleanup on process events
        if (typeof process !== 'undefined') {
            process.on('exit', this.cleanup);
            process.on('SIGINT', this.cleanup);
            process.on('SIGTERM', this.cleanup);
        }
        
        // Register cleanup on window events (for renderer process)
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', this.cleanup);
            window.addEventListener('unload', this.cleanup);
        }
    }
    
    /**
     * Create and register an interval timer
     * @param {string} name - Unique name for the timer
     * @param {Function} callback - Function to execute
     * @param {number} delay - Delay in milliseconds
     * @returns {number} The interval ID
     */
    createInterval(name, callback, delay) {
        // Clear existing timer with same name
        this.clearInterval(name);
        
        const intervalId = setInterval(callback, delay);
        this.intervals.set(name, intervalId);
        
        console.log(`[TimerRegistry] Created interval '${name}' with ID ${intervalId}`);
        return intervalId;
    }
    
    /**
     * Create and register a timeout timer
     * @param {string} name - Unique name for the timer
     * @param {Function} callback - Function to execute
     * @param {number} delay - Delay in milliseconds
     * @returns {number} The timeout ID
     */
    createTimeout(name, callback, delay) {
        // Clear existing timer with same name
        this.clearTimeout(name);
        
        // Wrap callback to auto-remove from registry after execution
        const wrappedCallback = () => {
            this.timeouts.delete(name);
            callback();
        };
        
        const timeoutId = setTimeout(wrappedCallback, delay);
        this.timeouts.set(name, timeoutId);
        
        console.log(`[TimerRegistry] Created timeout '${name}' with ID ${timeoutId}`);
        return timeoutId;
    }
    
    /**
     * Clear a specific interval timer
     * @param {string} name - Name of the timer to clear
     */
    clearInterval(name) {
        const intervalId = this.intervals.get(name);
        if (intervalId) {
            clearInterval(intervalId);
            this.intervals.delete(name);
            console.log(`[TimerRegistry] Cleared interval '${name}' with ID ${intervalId}`);
        }
    }
    
    /**
     * Clear a specific timeout timer
     * @param {string} name - Name of the timer to clear
     */
    clearTimeout(name) {
        const timeoutId = this.timeouts.get(name);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.timeouts.delete(name);
            console.log(`[TimerRegistry] Cleared timeout '${name}' with ID ${timeoutId}`);
        }
    }
    
    /**
     * Clear all timers
     */
    clearAll() {
        console.log(`[TimerRegistry] Clearing all timers - ${this.intervals.size} intervals, ${this.timeouts.size} timeouts`);
        
        // Clear all intervals
        for (const [name, intervalId] of this.intervals) {
            clearInterval(intervalId);
            console.log(`[TimerRegistry] Cleared interval '${name}'`);
        }
        this.intervals.clear();
        
        // Clear all timeouts
        for (const [name, timeoutId] of this.timeouts) {
            clearTimeout(timeoutId);
            console.log(`[TimerRegistry] Cleared timeout '${name}'`);
        }
        this.timeouts.clear();
    }
    
    /**
     * Clean up all timers (called on exit)
     */
    cleanup() {
        console.log('[TimerRegistry] Cleanup triggered');
        this.clearAll();
    }
    
    /**
     * Get current timer statistics
     * @returns {Object} Timer statistics
     */
    getStats() {
        return {
            intervals: this.intervals.size,
            timeouts: this.timeouts.size,
            intervalNames: Array.from(this.intervals.keys()),
            timeoutNames: Array.from(this.timeouts.keys())
        };
    }
}

// Export as singleton
module.exports = new TimerRegistry();