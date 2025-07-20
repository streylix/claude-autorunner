/**
 * UI Utils Module
 * 
 * Common UI interaction functions and DOM utilities
 * Extracted from TerminalGUI for better modularity
 */

class UIUtils {
    constructor() {
        this.platform = this.detectPlatform();
        this.throttledConsoleMethods = this.setupThrottledConsole();
    }

    /**
     * Detect current platform
     * @returns {string} - Platform identifier
     */
    detectPlatform() {
        if (typeof process !== 'undefined' && process.platform) {
            return process.platform;
        }
        
        const userAgent = navigator.userAgent.toLowerCase();
        if (userAgent.includes('mac')) return 'darwin';
        if (userAgent.includes('win')) return 'win32';
        if (userAgent.includes('linux')) return 'linux';
        return 'unknown';
    }

    /**
     * Safely add event listener to element
     * @param {string} elementId - Element ID
     * @param {string} event - Event type
     * @param {Function} handler - Event handler
     * @returns {boolean} - Success status
     */
    safeAddEventListener(elementId, event, handler) {
        const element = document.getElementById(elementId);
        if (element && typeof handler === 'function') {
            element.addEventListener(event, handler);
            return true;
        }
        console.warn(`Could not add event listener: element '${elementId}' not found or handler invalid`);
        return false;
    }

    /**
     * Escape HTML characters in text
     * @param {string} text - Text to escape
     * @returns {string} - Escaped HTML text
     */
    escapeHtml(text) {
        if (typeof text !== 'string') return text;
        
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }


    /**
     * Generic modal display function
     * @param {string} modalId - Modal element ID
     * @param {Object} options - Display options
     */
    showModal(modalId, options = {}) {
        const modal = document.getElementById(modalId);
        if (!modal) {
            console.warn(`Modal '${modalId}' not found`);
            return false;
        }

        modal.style.display = 'block';
        
        // Apply options
        if (options.zIndex) {
            modal.style.zIndex = options.zIndex;
        }
        
        if (options.backdrop !== false) {
            modal.classList.add('modal-backdrop');
        }

        // Focus management
        if (options.focusElement) {
            const focusEl = modal.querySelector(options.focusElement);
            if (focusEl) {
                setTimeout(() => focusEl.focus(), 100);
            }
        }

        return true;
    }

    /**
     * Generic modal hiding function
     * @param {string} modalId - Modal element ID
     */
    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.style.display = 'none';
            modal.classList.remove('modal-backdrop');
            return true;
        }
        return false;
    }

    /**
     * Open settings modal
     */
    openSettingsModal() {
        return this.showModal('settings-modal', {
            focusElement: '#theme-select'
        });
    }

    /**
     * Close settings modal
     */
    closeSettingsModal() {
        return this.closeModal('settings-modal');
    }

    /**
     * Open message history modal
     */
    openMessageHistoryModal() {
        return this.showModal('message-history-modal', {
            focusElement: '#history-search'
        });
    }

    /**
     * Close message history modal
     */
    closeMessageHistoryModal() {
        return this.closeModal('message-history-modal');
    }

    /**
     * Format keyboard shortcut for current platform
     * @param {string} shortcut - Generic shortcut string
     * @returns {string} - Platform-specific shortcut
     */
    formatKeyboardShortcut(shortcut) {
        if (this.platform === 'darwin') {
            return shortcut
                .replace(/Ctrl/g, '⌘')
                .replace(/Alt/g, '⌥')
                .replace(/Shift/g, '⇧');
        }
        return shortcut;
    }

    /**
     * Check if command key is pressed (cross-platform)
     * @param {KeyboardEvent} e - Keyboard event
     * @returns {boolean} - True if command key is pressed
     */
    isCommandKey(e) {
        return this.platform === 'darwin' ? e.metaKey : e.ctrlKey;
    }

    /**
     * Check if user is typing in an input field
     * @param {KeyboardEvent} e - Keyboard event
     * @returns {boolean} - True if typing in input field
     */
    isTypingInInputField(e) {
        const target = e.target;
        return target && (
            target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable ||
            target.classList.contains('editable')
        );
    }

    /**
     * Update platform-specific keyboard shortcuts in UI
     */
    updatePlatformSpecificShortcuts() {
        const shortcutElements = document.querySelectorAll('[data-shortcut]');
        shortcutElements.forEach(element => {
            const shortcut = element.getAttribute('data-shortcut');
            element.textContent = this.formatKeyboardShortcut(shortcut);
        });
    }

    /**
     * Direct console logging that bypasses throttling
     * @param {string} message - Log message
     * @param {string} level - Log level (log, warn, error)
     */
    directLog(message, level = 'log') {
        const originalMethod = console[level];
        if (originalMethod) {
            originalMethod.call(console, `[Direct] ${message}`);
        }
    }

    /**
     * Setup throttled console methods for performance
     * @returns {Object} - Throttled console methods
     */
    setupThrottledConsole() {
        const throttleMap = new Map();
        const throttleDelay = 1000; // 1 second throttle

        const createThrottledMethod = (method) => {
            return (...args) => {
                const key = args.join(' ');
                const now = Date.now();
                
                if (!throttleMap.has(key) || now - throttleMap.get(key) > throttleDelay) {
                    throttleMap.set(key, now);
                    console[method](...args);
                }
            };
        };

        return {
            log: createThrottledMethod('log'),
            warn: createThrottledMethod('warn'),
            error: createThrottledMethod('error'),
            info: createThrottledMethod('info')
        };
    }

    /**
     * Setup console error protection
     */
    setupConsoleErrorProtection() {
        const originalError = console.error;
        console.error = (...args) => {
            // Filter out noisy errors
            const message = args.join(' ').toLowerCase();
            const ignoredErrors = [
                'favicon.ico',
                'non-passive event listener',
                'webkit-fake-url'
            ];

            if (!ignoredErrors.some(ignore => message.includes(ignore))) {
                originalError.apply(console, args);
            }
        };
    }

    /**
     * Create DOM element with attributes and children
     * @param {string} tag - HTML tag name
     * @param {Object} attributes - Element attributes
     * @param {Array|string} children - Child elements or text content
     * @returns {HTMLElement} - Created element
     */
    createElement(tag, attributes = {}, children = []) {
        const element = document.createElement(tag);
        
        // Set attributes
        Object.entries(attributes).forEach(([key, value]) => {
            if (key === 'className') {
                element.className = value;
            } else if (key === 'style' && typeof value === 'object') {
                Object.assign(element.style, value);
            } else {
                element.setAttribute(key, value);
            }
        });

        // Add children
        if (typeof children === 'string') {
            element.textContent = children;
        } else if (Array.isArray(children)) {
            children.forEach(child => {
                if (typeof child === 'string') {
                    element.appendChild(document.createTextNode(child));
                } else if (child instanceof HTMLElement) {
                    element.appendChild(child);
                }
            });
        }

        return element;
    }

    /**
     * Apply theme classes to elements
     * @param {string} theme - Theme name ('dark' or 'light')
     * @param {Array} elements - Elements to apply theme to
     */
    applyThemeToElements(theme, elements = []) {
        const themeClass = theme === 'light' ? 'light-theme' : 'dark-theme';
        
        elements.forEach(elementId => {
            const element = typeof elementId === 'string' 
                ? document.getElementById(elementId)
                : elementId;
                
            if (element) {
                element.classList.remove('light-theme', 'dark-theme');
                element.classList.add(themeClass);
            }
        });
    }

    /**
     * Show temporary status message
     * @param {string} message - Status message
     * @param {string} type - Message type (success, error, warning, info)
     * @param {number} duration - Display duration in milliseconds
     */
    showStatusMessage(message, type = 'info', duration = 3000) {
        // Remove existing status messages
        const existing = document.querySelectorAll('.status-message');
        existing.forEach(el => el.remove());

        const statusEl = this.createElement('div', {
            className: `status-message status-${type}`,
            style: {
                position: 'fixed',
                top: '20px',
                right: '20px',
                padding: '10px 20px',
                borderRadius: '4px',
                zIndex: '10000',
                maxWidth: '400px',
                boxShadow: '0 2px 10px rgba(0,0,0,0.2)'
            }
        }, message);

        document.body.appendChild(statusEl);

        // Auto-remove after duration
        setTimeout(() => {
            if (statusEl.parentNode) {
                statusEl.remove();
            }
        }, duration);

        return statusEl;
    }

    /**
     * Animate element with CSS transition
     * @param {HTMLElement} element - Element to animate
     * @param {Object} fromStyles - Starting styles
     * @param {Object} toStyles - Ending styles
     * @param {number} duration - Animation duration in milliseconds
     * @returns {Promise} - Promise that resolves when animation completes
     */
    animateElement(element, fromStyles, toStyles, duration = 300) {
        return new Promise((resolve) => {
            if (!element) {
                resolve();
                return;
            }

            // Set initial styles
            Object.assign(element.style, fromStyles);
            element.style.transition = `all ${duration}ms ease`;

            // Trigger animation on next frame
            requestAnimationFrame(() => {
                Object.assign(element.style, toStyles);
            });

            // Clean up and resolve
            setTimeout(() => {
                element.style.transition = '';
                resolve();
            }, duration);
        });
    }

    /**
     * Debounce function calls
     * @param {Function} func - Function to debounce
     * @param {number} delay - Delay in milliseconds
     * @returns {Function} - Debounced function
     */
    debounce(func, delay) {
        let timeoutId;
        return (...args) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => func.apply(this, args), delay);
        };
    }

    /**
     * Throttle function calls
     * @param {Function} func - Function to throttle
     * @param {number} delay - Delay in milliseconds
     * @returns {Function} - Throttled function
     */
    throttle(func, delay) {
        let lastCall = 0;
        return (...args) => {
            const now = Date.now();
            if (now - lastCall >= delay) {
                lastCall = now;
                return func.apply(this, args);
            }
        };
    }

    /**
     * Format duration in human-readable format
     * @param {number} milliseconds - Duration in milliseconds
     * @returns {string} - Formatted duration
     */
    formatDuration(milliseconds) {
        const seconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    /**
     * Copy text to clipboard
     * @param {string} text - Text to copy
     * @returns {Promise<boolean>} - Success status
     */
    async copyToClipboard(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            } else {
                // Fallback for older browsers
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.select();
                const success = document.execCommand('copy');
                document.body.removeChild(textarea);
                return success;
            }
        } catch (error) {
            console.error('Failed to copy to clipboard:', error);
            return false;
        }
    }

    /**
     * Get element dimensions and position
     * @param {HTMLElement} element - Element to measure
     * @returns {Object} - Element bounds
     */
    getElementBounds(element) {
        if (!element) return null;

        const rect = element.getBoundingClientRect();
        return {
            width: rect.width,
            height: rect.height,
            top: rect.top,
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            centerX: rect.left + rect.width / 2,
            centerY: rect.top + rect.height / 2
        };
    }

    /**
     * Check if element is visible in viewport
     * @param {HTMLElement} element - Element to check
     * @returns {boolean} - True if element is visible
     */
    isElementVisible(element) {
        if (!element) return false;

        const rect = element.getBoundingClientRect();
        const windowHeight = window.innerHeight || document.documentElement.clientHeight;
        const windowWidth = window.innerWidth || document.documentElement.clientWidth;

        return rect.bottom > 0 && 
               rect.right > 0 && 
               rect.top < windowHeight && 
               rect.left < windowWidth;
    }

    /**
     * Scroll element into view smoothly
     * @param {HTMLElement} element - Element to scroll to
     * @param {Object} options - Scroll options
     */
    scrollIntoView(element, options = {}) {
        if (!element) return;

        const defaultOptions = {
            behavior: 'smooth',
            block: 'center',
            inline: 'nearest'
        };

        element.scrollIntoView({ ...defaultOptions, ...options });
    }

    /**
     * Get computed style property value
     * @param {HTMLElement} element - Element to check
     * @param {string} property - CSS property name
     * @returns {string} - Property value
     */
    getComputedStyleProperty(element, property) {
        if (!element) return null;
        return window.getComputedStyle(element).getPropertyValue(property);
    }

    /**
     * Setup global keyboard shortcuts
     * @param {Object} shortcuts - Shortcut mappings
     */
    setupGlobalKeyboardShortcuts(shortcuts) {
        document.addEventListener('keydown', (e) => {
            // Skip if typing in input field
            if (this.isTypingInInputField(e)) return;

            const key = e.key.toLowerCase();
            const modifiers = {
                ctrl: e.ctrlKey,
                cmd: e.metaKey,
                alt: e.altKey,
                shift: e.shiftKey
            };

            // Check each shortcut
            Object.entries(shortcuts).forEach(([shortcutKey, handler]) => {
                if (this.matchesShortcut(key, modifiers, shortcutKey)) {
                    e.preventDefault();
                    handler(e);
                }
            });
        });
    }

    /**
     * Check if key combination matches shortcut
     * @param {string} key - Pressed key
     * @param {Object} modifiers - Modifier keys state
     * @param {string} shortcut - Shortcut pattern
     * @returns {boolean} - True if matches
     */
    matchesShortcut(key, modifiers, shortcut) {
        const parts = shortcut.toLowerCase().split('+');
        const expectedKey = parts.pop();
        
        if (key !== expectedKey) return false;

        const expectedModifiers = {
            ctrl: parts.includes('ctrl'),
            cmd: parts.includes('cmd'),
            alt: parts.includes('alt'),
            shift: parts.includes('shift')
        };

        return Object.entries(expectedModifiers).every(([mod, expected]) => 
            modifiers[mod] === expected
        );
    }

    /**
     * Initialize UI utilities
     */
    initialize() {
        this.updatePlatformSpecificShortcuts();
        this.setupConsoleErrorProtection();
    }

    /**
     * Destroy and cleanup
     */
    destroy() {
        // Clean up any global event listeners or resources
        const statusMessages = document.querySelectorAll('.status-message');
        statusMessages.forEach(el => el.remove());
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = UIUtils;
} else if (typeof window !== 'undefined') {
    window.UIUtils = UIUtils;
}