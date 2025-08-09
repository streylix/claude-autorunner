/**
 * DOMCache - Cache frequently accessed DOM elements to improve performance
 */
class DOMCache {
    constructor() {
        this.cache = new Map();
        this.queries = new Map(); // Track query frequency
        this.hitCount = new Map(); // Track cache hits
        this.missCount = new Map(); // Track cache misses
        this.maxCacheSize = 100;
        this.cleanupInterval = 10 * 60 * 1000; // 10 minutes
        this.lastAccess = new Map(); // Track last access time
        
        // Start periodic cleanup
        this.startCleanup();
    }

    /**
     * Get an element by selector with caching
     * @param {string} selector - CSS selector
     * @param {Element} context - Context element (optional)
     * @returns {Element|null} The found element
     */
    querySelector(selector, context = document) {
        const cacheKey = this.getCacheKey(selector, context);
        
        // Update query frequency
        this.queries.set(selector, (this.queries.get(selector) || 0) + 1);
        
        // Check cache first
        if (this.cache.has(cacheKey)) {
            const cachedElement = this.cache.get(cacheKey);
            
            // Verify element is still in DOM
            if (this.isElementValid(cachedElement)) {
                this.hitCount.set(selector, (this.hitCount.get(selector) || 0) + 1);
                this.lastAccess.set(cacheKey, Date.now());
                return cachedElement;
            } else {
                // Element is stale, remove from cache
                this.cache.delete(cacheKey);
            }
        }
        
        // Cache miss - query the DOM
        const element = context.querySelector(selector);
        this.missCount.set(selector, (this.missCount.get(selector) || 0) + 1);
        
        // Cache the result if element exists and cache isn't full
        if (element && this.shouldCache(selector)) {
            this.setCache(cacheKey, element);
        }
        
        return element;
    }

    /**
     * Get elements by selector with caching
     * @param {string} selector - CSS selector
     * @param {Element} context - Context element (optional)
     * @returns {NodeList} The found elements
     */
    querySelectorAll(selector, context = document) {
        const cacheKey = this.getCacheKey(selector + ':all', context);
        
        // Update query frequency
        this.queries.set(selector, (this.queries.get(selector) || 0) + 1);
        
        // Check cache first
        if (this.cache.has(cacheKey)) {
            const cachedElements = this.cache.get(cacheKey);
            
            // Verify all elements are still in DOM
            if (this.areElementsValid(cachedElements)) {
                this.hitCount.set(selector, (this.hitCount.get(selector) || 0) + 1);
                this.lastAccess.set(cacheKey, Date.now());
                return cachedElements;
            } else {
                // Elements are stale, remove from cache
                this.cache.delete(cacheKey);
            }
        }
        
        // Cache miss - query the DOM
        const elements = context.querySelectorAll(selector);
        this.missCount.set(selector, (this.missCount.get(selector) || 0) + 1);
        
        // Cache the result if elements exist and cache isn't full
        if (elements.length > 0 && this.shouldCache(selector)) {
            this.setCache(cacheKey, elements);
        }
        
        return elements;
    }

    /**
     * Get element by ID with caching (optimized for frequent ID lookups)
     * @param {string} id - Element ID
     * @returns {Element|null} The found element
     */
    getElementById(id) {
        return this.querySelector(`#${id}`);
    }

    /**
     * Invalidate cache for a specific selector
     * @param {string} selector - CSS selector to invalidate
     */
    invalidate(selector) {
        const keysToDelete = [];
        for (const key of this.cache.keys()) {
            if (key.startsWith(selector)) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => {
            this.cache.delete(key);
            this.lastAccess.delete(key);
        });
    }

    /**
     * Clear all cached elements
     */
    clear() {
        this.cache.clear();
        this.lastAccess.clear();
        console.log('DOM cache cleared');
    }

    /**
     * Generate cache key
     * @private
     */
    getCacheKey(selector, context) {
        const contextId = context === document ? 'document' : 
                         (context.id || context.tagName || 'unknown');
        return `${selector}:${contextId}`;
    }

    /**
     * Check if element is still valid (in DOM)
     * @private
     */
    isElementValid(element) {
        return element && element.isConnected;
    }

    /**
     * Check if all elements in NodeList are still valid
     * @private
     */
    areElementsValid(elements) {
        if (!elements || elements.length === 0) return false;
        
        // Check a sample of elements for performance
        const sampleSize = Math.min(5, elements.length);
        for (let i = 0; i < sampleSize; i++) {
            if (!this.isElementValid(elements[i])) {
                return false;
            }
        }
        return true;
    }

    /**
     * Determine if selector should be cached
     * @private
     */
    shouldCache(selector) {
        // Cache frequently queried selectors
        const queryCount = this.queries.get(selector) || 0;
        const shouldCache = queryCount >= 2 || this.isHighPrioritySelector(selector);
        
        // Don't cache if we're at capacity (unless it's high priority)
        if (this.cache.size >= this.maxCacheSize && !this.isHighPrioritySelector(selector)) {
            return false;
        }
        
        return shouldCache;
    }

    /**
     * Check if selector is high priority for caching
     * @private
     */
    isHighPrioritySelector(selector) {
        const highPriorityPatterns = [
            /^#/, // IDs
            /terminal/i,
            /input/i,
            /button/i,
            /modal/i,
            /sidebar/i
        ];
        
        return highPriorityPatterns.some(pattern => pattern.test(selector));
    }

    /**
     * Set cache with size management
     * @private
     */
    setCache(key, element) {
        // If at capacity, remove least recently used item
        if (this.cache.size >= this.maxCacheSize) {
            this.removeLRU();
        }
        
        this.cache.set(key, element);
        this.lastAccess.set(key, Date.now());
    }

    /**
     * Remove least recently used item
     * @private
     */
    removeLRU() {
        let oldestKey = null;
        let oldestTime = Date.now();
        
        for (const [key, time] of this.lastAccess) {
            if (time < oldestTime) {
                oldestTime = time;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            this.cache.delete(oldestKey);
            this.lastAccess.delete(oldestKey);
        }
    }

    /**
     * Start periodic cleanup
     * @private
     */
    startCleanup() {
        setInterval(() => {
            this.cleanup();
        }, this.cleanupInterval);
    }

    /**
     * Clean up stale cache entries
     */
    cleanup() {
        const now = Date.now();
        const maxAge = 30 * 60 * 1000; // 30 minutes
        const keysToDelete = [];
        
        // Remove stale entries
        for (const [key, lastAccessTime] of this.lastAccess) {
            if (now - lastAccessTime > maxAge) {
                keysToDelete.push(key);
            }
        }
        
        // Remove invalid elements
        for (const [key, element] of this.cache) {
            if (Array.isArray(element) || NodeList.prototype.isPrototypeOf(element)) {
                if (!this.areElementsValid(element)) {
                    keysToDelete.push(key);
                }
            } else if (!this.isElementValid(element)) {
                keysToDelete.push(key);
            }
        }
        
        keysToDelete.forEach(key => {
            this.cache.delete(key);
            this.lastAccess.delete(key);
        });
        
        if (keysToDelete.length > 0) {
            console.log(`DOM cache cleanup: removed ${keysToDelete.length} stale entries`);
        }
    }

    /**
     * Get cache statistics
     */
    getStats() {
        const totalQueries = Array.from(this.queries.values()).reduce((sum, count) => sum + count, 0);
        const totalHits = Array.from(this.hitCount.values()).reduce((sum, count) => sum + count, 0);
        const totalMisses = Array.from(this.missCount.values()).reduce((sum, count) => sum + count, 0);
        
        return {
            cacheSize: this.cache.size,
            maxCacheSize: this.maxCacheSize,
            totalQueries,
            totalHits,
            totalMisses,
            hitRate: totalQueries > 0 ? ((totalHits / totalQueries) * 100).toFixed(1) + '%' : '0%',
            topSelectors: this.getTopSelectors()
        };
    }

    /**
     * Get most frequently queried selectors
     * @private
     */
    getTopSelectors() {
        return Array.from(this.queries.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([selector, count]) => ({ selector, count }));
    }

    /**
     * Get cache report
     */
    getReport() {
        const stats = this.getStats();
        return `
DOM Cache Report:
- Cache Size: ${stats.cacheSize}/${stats.maxCacheSize}
- Total Queries: ${stats.totalQueries}
- Cache Hit Rate: ${stats.hitRate}
- Top Selectors: ${stats.topSelectors.map(s => `${s.selector} (${s.count})`).join(', ')}
        `.trim();
    }
}

// Create singleton instance
const domCache = new DOMCache();

module.exports = domCache;