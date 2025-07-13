/**
 * Validation and ID generation utilities
 * Provides message validation and unique ID generation functions
 */

class ValidationUtils {
    constructor() {
        this.idCounters = new Map();
    }

    /**
     * Generate unique message ID
     * @param {string} prefix - Optional prefix for the ID
     * @returns {number|string} Unique ID
     */
    generateId(prefix = null) {
        if (prefix) {
            const currentCount = this.idCounters.get(prefix) || 0;
            const newId = currentCount + 1;
            this.idCounters.set(prefix, newId);
            return `${prefix}-${newId}`;
        } else {
            // Default numeric ID generation (for backward compatibility)
            const currentCount = this.idCounters.get('default') || 0;
            const newId = currentCount + 1;
            this.idCounters.set('default', newId);
            return newId;
        }
    }

    /**
     * Reset ID counter for a specific prefix
     * @param {string} prefix - The prefix to reset
     */
    resetIdCounter(prefix = 'default') {
        this.idCounters.set(prefix, 0);
    }

    /**
     * Validate message queue for duplicate IDs
     * @param {Array} messageQueue - Array of message objects with id property
     * @returns {boolean} True if all IDs are unique
     */
    validateMessageIds(messageQueue) {
        const ids = messageQueue.map(m => m.id);
        const uniqueIds = new Set(ids);
        
        if (ids.length !== uniqueIds.size) {
            console.error('Duplicate message IDs detected:', ids);
            console.error('Message queue:', messageQueue);
            return false;
        }
        
        return true;
    }

    /**
     * Validate message content
     * @param {string} content - The message content to validate
     * @returns {Object} Validation result with isValid and errors
     */
    validateMessageContent(content) {
        const errors = [];
        
        if (!content || typeof content !== 'string') {
            errors.push('Content must be a non-empty string');
        }
        
        if (content && content.trim().length === 0) {
            errors.push('Content cannot be only whitespace');
        }
        
        if (content && content.length > 10000) {
            errors.push('Content exceeds maximum length of 10,000 characters');
        }
        
        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Validate terminal ID
     * @param {number} terminalId - The terminal ID to validate
     * @returns {boolean} True if valid terminal ID
     */
    validateTerminalId(terminalId) {
        return typeof terminalId === 'number' && 
               terminalId > 0 && 
               Number.isInteger(terminalId);
    }

    /**
     * Validate timer values
     * @param {number} hours - Hours value
     * @param {number} minutes - Minutes value  
     * @param {number} seconds - Seconds value
     * @returns {Object} Validation result with isValid and errors
     */
    validateTimerValues(hours, minutes, seconds) {
        const errors = [];
        
        if (!Number.isInteger(hours) || hours < 0 || hours > 23) {
            errors.push('Hours must be an integer between 0 and 23');
        }
        
        if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
            errors.push('Minutes must be an integer between 0 and 59');
        }
        
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 59) {
            errors.push('Seconds must be an integer between 0 and 59');
        }
        
        if (hours === 0 && minutes === 0 && seconds === 0) {
            errors.push('Timer must have at least 1 second');
        }
        
        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Sanitize string for safe display
     * @param {string} input - Input string to sanitize
     * @returns {string} Sanitized string
     */
    sanitizeString(input) {
        if (typeof input !== 'string') {
            return '';
        }
        
        return input
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;');
    }

    /**
     * Validate file type for attachments
     * @param {File} file - File object to validate
     * @param {Array} allowedTypes - Array of allowed MIME types
     * @returns {Object} Validation result
     */
    validateFileType(file, allowedTypes = []) {
        const errors = [];
        
        if (!file || !(file instanceof File)) {
            errors.push('Invalid file object');
            return { isValid: false, errors };
        }
        
        if (allowedTypes.length > 0 && !allowedTypes.includes(file.type)) {
            errors.push(`File type ${file.type} is not allowed`);
        }
        
        if (file.size > 10 * 1024 * 1024) { // 10MB limit
            errors.push('File size exceeds 10MB limit');
        }
        
        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Generate session ID
     * @param {string} prefix - Optional prefix for session
     * @returns {string} Unique session ID
     */
    generateSessionId(prefix = 'session') {
        const timestamp = Date.now();
        const randomId = Math.random().toString(36).substr(2, 9);
        return `${prefix}-${timestamp}-${randomId}`;
    }

    /**
     * Validate email address format
     * @param {string} email - Email to validate
     * @returns {boolean} True if valid email format
     */
    validateEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    /**
     * Validate URL format
     * @param {string} url - URL to validate
     * @returns {boolean} True if valid URL format
     */
    validateUrl(url) {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }
}

module.exports = ValidationUtils;