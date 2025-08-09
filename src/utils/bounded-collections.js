/**
 * Bounded collections to prevent memory leaks
 * Automatically removes oldest items when max size is reached
 */

/**
 * A Set that automatically limits its size by removing oldest items
 */
class BoundedSet extends Set {
    constructor(maxSize = 1000) {
        super();
        this.maxSize = maxSize;
        this.insertionOrder = []; // Track insertion order
    }
    
    add(value) {
        // If value already exists, remove it from insertion order
        if (this.has(value)) {
            const index = this.insertionOrder.indexOf(value);
            if (index > -1) {
                this.insertionOrder.splice(index, 1);
            }
        }
        
        // Add value
        super.add(value);
        this.insertionOrder.push(value);
        
        // Remove oldest items if over limit
        while (this.size > this.maxSize) {
            const oldest = this.insertionOrder.shift();
            super.delete(oldest);
            console.log(`[BoundedSet] Removed oldest item to maintain size limit: ${oldest}`);
        }
        
        return this;
    }
    
    delete(value) {
        const result = super.delete(value);
        if (result) {
            const index = this.insertionOrder.indexOf(value);
            if (index > -1) {
                this.insertionOrder.splice(index, 1);
            }
        }
        return result;
    }
    
    clear() {
        super.clear();
        this.insertionOrder = [];
    }
    
    getStats() {
        return {
            currentSize: this.size,
            maxSize: this.maxSize,
            oldestItem: this.insertionOrder[0],
            newestItem: this.insertionOrder[this.insertionOrder.length - 1]
        };
    }
}

/**
 * A Map that automatically limits its size by removing least recently used items
 */
class BoundedMap extends Map {
    constructor(maxSize = 1000) {
        super();
        this.maxSize = maxSize;
    }
    
    set(key, value) {
        // If key exists, delete and re-add to move to end (most recent)
        if (this.has(key)) {
            super.delete(key);
        }
        
        // Add new item
        super.set(key, value);
        
        // Remove oldest items if over limit
        while (this.size > this.maxSize) {
            const firstKey = this.keys().next().value;
            super.delete(firstKey);
            console.log(`[BoundedMap] Removed oldest item to maintain size limit: ${firstKey}`);
        }
        
        return this;
    }
    
    get(key) {
        const value = super.get(key);
        if (value !== undefined) {
            // Move to end (most recent) by deleting and re-adding
            super.delete(key);
            super.set(key, value);
        }
        return value;
    }
    
    getStats() {
        return {
            currentSize: this.size,
            maxSize: this.maxSize,
            oldestKey: this.keys().next().value,
            newestKey: Array.from(this.keys()).pop()
        };
    }
}

/**
 * A bounded array that maintains a maximum size
 */
class BoundedArray extends Array {
    constructor(maxSize = 1000) {
        super();
        this.maxSize = maxSize;
    }
    
    push(...items) {
        const result = super.push(...items);
        
        // Remove oldest items if over limit
        while (this.length > this.maxSize) {
            const removed = this.shift();
            console.log(`[BoundedArray] Removed oldest item to maintain size limit`);
        }
        
        return result;
    }
    
    unshift(...items) {
        const result = super.unshift(...items);
        
        // Remove newest items if over limit
        while (this.length > this.maxSize) {
            const removed = this.pop();
            console.log(`[BoundedArray] Removed newest item to maintain size limit`);
        }
        
        return result;
    }
    
    getStats() {
        return {
            currentSize: this.length,
            maxSize: this.maxSize,
            oldestItem: this[0],
            newestItem: this[this.length - 1]
        };
    }
}

module.exports = {
    BoundedSet,
    BoundedMap,
    BoundedArray
};