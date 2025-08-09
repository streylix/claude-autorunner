/**
 * ObserverManager - Centralized management for ResizeObserver and MutationObserver instances
 * Prevents memory leaks by properly tracking and disposing observers
 */
class ObserverManager {
    constructor() {
        this.resizeObservers = new Map();
        this.mutationObservers = new Map();
        this.observerCallbacks = new Map();
        this.activeObservers = new Set();
    }

    /**
     * Create and register a ResizeObserver
     * @param {string} id - Unique identifier for the observer
     * @param {Function} callback - Callback function for resize events
     * @param {Object} options - Observer options
     * @returns {ResizeObserver} The created observer
     */
    createResizeObserver(id, callback, options = {}) {
        // Clean up existing observer with same ID
        if (this.resizeObservers.has(id)) {
            this.disposeResizeObserver(id);
        }

        // Wrap callback to add error handling and performance tracking
        const wrappedCallback = (entries, observer) => {
            try {
                // Debounce logic to prevent excessive calls
                if (options.debounce) {
                    if (this.observerCallbacks.has(id)) {
                        clearTimeout(this.observerCallbacks.get(id));
                    }
                    const timeoutId = setTimeout(() => {
                        callback(entries, observer);
                        this.observerCallbacks.delete(id);
                    }, options.debounce);
                    this.observerCallbacks.set(id, timeoutId);
                } else {
                    callback(entries, observer);
                }
            } catch (error) {
                console.error(`ResizeObserver ${id} callback error:`, error);
            }
        };

        const observer = new ResizeObserver(wrappedCallback);
        this.resizeObservers.set(id, observer);
        this.activeObservers.add(id);

        return observer;
    }

    /**
     * Create and register a MutationObserver
     * @param {string} id - Unique identifier for the observer
     * @param {Function} callback - Callback function for mutations
     * @param {Object} options - Observer options
     * @returns {MutationObserver} The created observer
     */
    createMutationObserver(id, callback, options = {}) {
        // Clean up existing observer with same ID
        if (this.mutationObservers.has(id)) {
            this.disposeMutationObserver(id);
        }

        // Wrap callback to add error handling
        const wrappedCallback = (mutations, observer) => {
            try {
                // Batch mutations if requested
                if (options.batch) {
                    if (this.observerCallbacks.has(id)) {
                        clearTimeout(this.observerCallbacks.get(id));
                    }
                    const timeoutId = setTimeout(() => {
                        callback(mutations, observer);
                        this.observerCallbacks.delete(id);
                    }, options.batch);
                    this.observerCallbacks.set(id, timeoutId);
                } else {
                    callback(mutations, observer);
                }
            } catch (error) {
                console.error(`MutationObserver ${id} callback error:`, error);
            }
        };

        const observer = new MutationObserver(wrappedCallback);
        this.mutationObservers.set(id, observer);
        this.activeObservers.add(id);

        return observer;
    }

    /**
     * Dispose of a ResizeObserver
     * @param {string} id - Observer identifier
     */
    disposeResizeObserver(id) {
        const observer = this.resizeObservers.get(id);
        if (observer) {
            observer.disconnect();
            this.resizeObservers.delete(id);
            this.activeObservers.delete(id);
            
            // Clear any pending callbacks
            if (this.observerCallbacks.has(id)) {
                clearTimeout(this.observerCallbacks.get(id));
                this.observerCallbacks.delete(id);
            }
        }
    }

    /**
     * Dispose of a MutationObserver
     * @param {string} id - Observer identifier
     */
    disposeMutationObserver(id) {
        const observer = this.mutationObservers.get(id);
        if (observer) {
            observer.disconnect();
            this.mutationObservers.delete(id);
            this.activeObservers.delete(id);
            
            // Clear any pending callbacks
            if (this.observerCallbacks.has(id)) {
                clearTimeout(this.observerCallbacks.get(id));
                this.observerCallbacks.delete(id);
            }
        }
    }

    /**
     * Dispose all observers
     */
    disposeAll() {
        // Dispose all ResizeObservers
        for (const id of this.resizeObservers.keys()) {
            this.disposeResizeObserver(id);
        }

        // Dispose all MutationObservers
        for (const id of this.mutationObservers.keys()) {
            this.disposeMutationObserver(id);
        }

        // Clear all pending callbacks
        for (const timeoutId of this.observerCallbacks.values()) {
            clearTimeout(timeoutId);
        }
        this.observerCallbacks.clear();
        this.activeObservers.clear();
    }

    /**
     * Get active observer count
     * @returns {number} Number of active observers
     */
    getActiveCount() {
        return this.activeObservers.size;
    }

    /**
     * Get observer statistics
     * @returns {Object} Observer statistics
     */
    getStats() {
        return {
            resizeObservers: this.resizeObservers.size,
            mutationObservers: this.mutationObservers.size,
            pendingCallbacks: this.observerCallbacks.size,
            totalActive: this.activeObservers.size
        };
    }

    /**
     * Cleanup inactive observers (called periodically)
     */
    cleanup() {
        // This method can be extended to implement more sophisticated cleanup logic
        // For now, it just reports statistics
        const stats = this.getStats();
        if (stats.totalActive > 50) {
            console.warn('High number of active observers:', stats);
        }
        return stats;
    }
}

module.exports = ObserverManager;