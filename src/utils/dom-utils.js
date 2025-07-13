/**
 * DOM manipulation utilities
 * Provides safe DOM access and manipulation functions
 */

class DomUtils {
    /**
     * Safely add event listener to element by ID
     * @param {string} elementId - The ID of the element
     * @param {string} event - The event type to listen for
     * @param {Function} handler - The event handler function
     * @returns {boolean} True if listener was added successfully
     */
    static safeAddEventListener(elementId, event, handler) {
        const element = document.getElementById(elementId);
        if (element) {
            element.addEventListener(event, handler);
            return true;
        } else {
            console.warn(`Element with ID '${elementId}' not found - skipping event listener`);
            return false;
        }
    }

    /**
     * Safely get element by ID with optional warning
     * @param {string} elementId - The ID of the element
     * @param {boolean} silent - Whether to suppress warning if not found
     * @returns {Element|null} The element or null if not found
     */
    static safeGetElementById(elementId, silent = false) {
        const element = document.getElementById(elementId);
        if (!element && !silent) {
            console.warn(`Element with ID '${elementId}' not found`);
        }
        return element;
    }

    /**
     * Safely set element text content
     * @param {string} elementId - The ID of the element
     * @param {string} content - The text content to set
     * @returns {boolean} True if content was set successfully
     */
    static safeSetTextContent(elementId, content) {
        const element = this.safeGetElementById(elementId, true);
        if (element) {
            element.textContent = content;
            return true;
        }
        return false;
    }

    /**
     * Safely set element HTML content
     * @param {string} elementId - The ID of the element
     * @param {string} html - The HTML content to set
     * @returns {boolean} True if content was set successfully
     */
    static safeSetHTML(elementId, html) {
        const element = this.safeGetElementById(elementId, true);
        if (element) {
            element.innerHTML = html;
            return true;
        }
        return false;
    }

    /**
     * Safely add CSS class to element
     * @param {string} elementId - The ID of the element
     * @param {string} className - The CSS class to add
     * @returns {boolean} True if class was added successfully
     */
    static safeAddClass(elementId, className) {
        const element = this.safeGetElementById(elementId, true);
        if (element) {
            element.classList.add(className);
            return true;
        }
        return false;
    }

    /**
     * Safely remove CSS class from element
     * @param {string} elementId - The ID of the element
     * @param {string} className - The CSS class to remove
     * @returns {boolean} True if class was removed successfully
     */
    static safeRemoveClass(elementId, className) {
        const element = this.safeGetElementById(elementId, true);
        if (element) {
            element.classList.remove(className);
            return true;
        }
        return false;
    }

    /**
     * Safely toggle CSS class on element
     * @param {string} elementId - The ID of the element
     * @param {string} className - The CSS class to toggle
     * @returns {boolean} True if class was toggled successfully
     */
    static safeToggleClass(elementId, className) {
        const element = this.safeGetElementById(elementId, true);
        if (element) {
            element.classList.toggle(className);
            return true;
        }
        return false;
    }

    /**
     * Create element with attributes and content
     * @param {string} tagName - The tag name for the element
     * @param {Object} attributes - Object of attributes to set
     * @param {string} content - Text content for the element
     * @returns {Element} The created element
     */
    static createElement(tagName, attributes = {}, content = '') {
        const element = document.createElement(tagName);
        
        // Set attributes
        Object.entries(attributes).forEach(([key, value]) => {
            element.setAttribute(key, value);
        });
        
        // Set content
        if (content) {
            element.textContent = content;
        }
        
        return element;
    }

    /**
     * Wait for element to exist in DOM
     * @param {string} selector - CSS selector for the element
     * @param {number} timeout - Maximum time to wait in milliseconds
     * @returns {Promise<Element>} Promise that resolves with the element
     */
    static waitForElement(selector, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const checkElement = () => {
                const element = document.querySelector(selector);
                if (element) {
                    resolve(element);
                    return;
                }
                
                if (Date.now() - startTime >= timeout) {
                    reject(new Error(`Element ${selector} not found within ${timeout}ms`));
                    return;
                }
                
                setTimeout(checkElement, 100);
            };
            
            checkElement();
        });
    }

    /**
     * Check if element is visible
     * @param {Element} element - The element to check
     * @returns {boolean} True if element is visible
     */
    static isElementVisible(element) {
        if (!element) return false;
        
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && 
               style.visibility !== 'hidden' && 
               style.opacity !== '0';
    }
}

module.exports = DomUtils;