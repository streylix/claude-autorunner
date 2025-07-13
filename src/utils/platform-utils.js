/**
 * Platform detection and keyboard shortcut utilities
 * Provides cross-platform keyboard shortcut formatting and detection
 */

class PlatformUtils {
    constructor() {
        this.isMac = process.platform === 'darwin';
        this.keySymbols = this.isMac ? {
            cmd: '⌘',
            shift: '⇧',
            ctrl: '⌃',
            alt: '⌥'
        } : {
            cmd: 'Ctrl',
            shift: 'Shift',
            ctrl: 'Ctrl',
            alt: 'Alt'
        };
    }

    /**
     * Convert keyboard shortcuts to platform-specific format
     * @param {string} shortcut - The shortcut to format (e.g., "Ctrl+Shift+P")
     * @returns {string} Platform-specific formatted shortcut
     */
    formatKeyboardShortcut(shortcut) {
        if (this.isMac) {
            return shortcut
                .replace(/Cmd\+/g, this.keySymbols.cmd)
                .replace(/Ctrl\+/g, this.keySymbols.cmd)
                .replace(/Shift\+/g, this.keySymbols.shift)
                .replace(/Alt\+/g, this.keySymbols.alt)
                .replace(/Meta\+/g, this.keySymbols.cmd);
        } else {
            return shortcut
                .replace(/Cmd\+/g, 'Ctrl+');
        }
    }

    /**
     * Helper function to detect the correct modifier key for the platform
     * @param {KeyboardEvent} e - The keyboard event
     * @returns {boolean} True if the command key is pressed
     */
    isCommandKey(e) {
        return this.isMac ? e.metaKey : e.ctrlKey;
    }

    /**
     * Helper function to check if user is typing in an input field
     * @param {KeyboardEvent} e - The keyboard event
     * @returns {boolean} True if the user is typing in an input field
     */
    isTypingInInputField(e) {
        return e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    }

    /**
     * Update all elements with data-hotkey attributes to platform-specific format
     */
    updatePlatformSpecificShortcuts() {
        const hotkeyElements = document.querySelectorAll('[data-hotkey]');
        
        console.log(`Updating ${hotkeyElements.length} hotkey elements, isMac: ${this.isMac}`);
        
        hotkeyElements.forEach(element => {
            const originalShortcut = element.getAttribute('data-hotkey');
            const formattedShortcut = this.formatKeyboardShortcut(originalShortcut);
            element.setAttribute('data-hotkey', formattedShortcut);
            
            console.log(`Updated hotkey: "${originalShortcut}" -> "${formattedShortcut}"`);
            
            // Also update title attributes if they contain keyboard shortcuts
            const title = element.getAttribute('title');
            if (title && (title.includes('Cmd+') || title.includes('Ctrl+') || title.includes('Shift+') || title.includes('Alt+'))) {
                const formattedTitle = this.formatKeyboardShortcut(title);
                element.setAttribute('title', formattedTitle);
                console.log(`Updated title: "${title}" -> "${formattedTitle}"`);
            }
        });

        // Update placeholder text that mentions keyboard shortcuts
        const messageInput = document.getElementById('message-input');
        if (messageInput && messageInput.placeholder) {
            const placeholder = messageInput.placeholder;
            if (placeholder.includes('Cmd+') || placeholder.includes('Ctrl+')) {
                const formattedPlaceholder = this.formatKeyboardShortcut(placeholder);
                messageInput.placeholder = formattedPlaceholder;
                console.log(`Updated placeholder: "${placeholder}" -> "${formattedPlaceholder}"`);
            }
        }
    }

    /**
     * Get platform information
     * @returns {Object} Platform information
     */
    getPlatformInfo() {
        return {
            isMac: this.isMac,
            platform: process.platform,
            keySymbols: this.keySymbols
        };
    }
}

module.exports = PlatformUtils;