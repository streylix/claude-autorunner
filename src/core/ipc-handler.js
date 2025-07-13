/**
 * IPC Communication Handler
 * Provides abstraction layer for IPC communication between renderer and main process
 */

const { ipcRenderer } = require('electron');

class IPCHandler {
    constructor() {
        this.listeners = new Map();
    }

    // ========================================
    // Terminal IPC Methods
    // ========================================

    /**
     * Start a terminal session
     * @param {number} terminalId - The terminal ID
     * @param {string} directory - Starting directory (optional)
     * @returns {void}
     */
    startTerminal(terminalId, directory = null) {
        ipcRenderer.send('terminal-start', { terminalId, directory });
    }

    /**
     * Send input to terminal
     * @param {number} terminalId - The terminal ID
     * @param {string} data - Data to send to terminal
     * @returns {void}
     */
    sendTerminalInput(terminalId, data) {
        ipcRenderer.send('terminal-input', { terminalId, data });
    }

    /**
     * Resize terminal
     * @param {number} terminalId - The terminal ID
     * @param {number} cols - Number of columns
     * @param {number} rows - Number of rows
     * @returns {void}
     */
    resizeTerminal(terminalId, cols, rows) {
        ipcRenderer.send('terminal-resize', { terminalId, cols, rows });
    }

    /**
     * Get current working directory
     * @param {number} terminalId - The terminal ID
     * @returns {void}
     */
    getCurrentWorkingDirectory(terminalId) {
        ipcRenderer.send('get-cwd', { terminalId });
    }

    // ========================================
    // Audio/Voice IPC Methods
    // ========================================

    /**
     * Transcribe audio buffer
     * @param {ArrayBuffer} audioBuffer - Audio data to transcribe
     * @returns {Promise<string>} Transcription result
     */
    async transcribeAudio(audioBuffer) {
        return await ipcRenderer.invoke('transcribe-audio', audioBuffer);
    }

    // ========================================
    // Database IPC Methods
    // ========================================

    /**
     * Save message queue to database
     * @param {Array} messageQueue - Array of messages to save
     * @returns {Promise<boolean>} Success status
     */
    async saveMessageQueue(messageQueue) {
        return await ipcRenderer.invoke('db-save-message-queue', messageQueue);
    }

    /**
     * Load message queue from database
     * @returns {Promise<Array>} Array of messages
     */
    async loadMessageQueue() {
        return await ipcRenderer.invoke('db-load-message-queue');
    }

    /**
     * Save message history item
     * @param {Object} historyItem - History item to save
     * @returns {Promise<boolean>} Success status
     */
    async saveMessageHistory(historyItem) {
        return await ipcRenderer.invoke('db-save-message-history', historyItem);
    }

    /**
     * Load message history
     * @returns {Promise<Array>} Array of history items
     */
    async loadMessageHistory() {
        return await ipcRenderer.invoke('db-load-message-history');
    }

    /**
     * Clear message history
     * @returns {Promise<boolean>} Success status
     */
    async clearMessageHistory() {
        return await ipcRenderer.invoke('db-clear-message-history');
    }

    /**
     * Set application state
     * @param {string} key - State key
     * @param {any} value - State value
     * @returns {Promise<boolean>} Success status
     */
    async setAppState(key, value) {
        return await ipcRenderer.invoke('db-set-app-state', key, value);
    }

    /**
     * Get application state
     * @param {string} key - State key
     * @returns {Promise<any>} State value
     */
    async getAppState(key) {
        return await ipcRenderer.invoke('db-get-app-state', key);
    }

    /**
     * Save preferences
     * @param {Object} preferences - Preferences object
     * @returns {Promise<boolean>} Success status
     */
    async savePreferences(preferences) {
        return await ipcRenderer.invoke('db-save-preferences', preferences);
    }

    /**
     * Load preferences
     * @returns {Promise<Object>} Preferences object
     */
    async loadPreferences() {
        return await ipcRenderer.invoke('db-load-preferences');
    }

    // ========================================
    // Event Listener Management
    // ========================================

    /**
     * Add event listener for IPC events
     * @param {string} channel - IPC channel name
     * @param {Function} listener - Event listener function
     * @returns {void}
     */
    on(channel, listener) {
        if (!this.listeners.has(channel)) {
            this.listeners.set(channel, []);
        }
        this.listeners.get(channel).push(listener);
        ipcRenderer.on(channel, listener);
    }

    /**
     * Remove event listener for IPC events
     * @param {string} channel - IPC channel name
     * @param {Function} listener - Event listener function to remove
     * @returns {void}
     */
    off(channel, listener) {
        ipcRenderer.off(channel, listener);
        
        if (this.listeners.has(channel)) {
            const listeners = this.listeners.get(channel);
            const index = listeners.indexOf(listener);
            if (index > -1) {
                listeners.splice(index, 1);
            }
            if (listeners.length === 0) {
                this.listeners.delete(channel);
            }
        }
    }

    /**
     * Remove all listeners for a channel
     * @param {string} channel - IPC channel name
     * @returns {void}
     */
    removeAllListeners(channel) {
        if (this.listeners.has(channel)) {
            const listeners = this.listeners.get(channel);
            listeners.forEach(listener => {
                ipcRenderer.off(channel, listener);
            });
            this.listeners.delete(channel);
        }
    }

    /**
     * Send IPC message
     * @param {string} channel - IPC channel name
     * @param {...any} args - Arguments to send
     * @returns {void}
     */
    send(channel, ...args) {
        ipcRenderer.send(channel, ...args);
    }

    /**
     * Invoke IPC method (async)
     * @param {string} channel - IPC channel name
     * @param {...any} args - Arguments to send
     * @returns {Promise<any>} Response from main process
     */
    async invoke(channel, ...args) {
        return await ipcRenderer.invoke(channel, ...args);
    }

    // ========================================
    // Specialized Terminal Methods
    // ========================================

    /**
     * Send Enter key to terminal
     * @param {number} terminalId - The terminal ID
     * @returns {void}
     */
    sendEnterKey(terminalId) {
        this.sendTerminalInput(terminalId, '\r');
    }

    /**
     * Send text to terminal
     * @param {number} terminalId - The terminal ID
     * @param {string} text - Text to send
     * @returns {void}
     */
    sendTextToTerminal(terminalId, text) {
        this.sendTerminalInput(terminalId, text);
    }

    /**
     * Send command to terminal (with enter)
     * @param {number} terminalId - The terminal ID
     * @param {string} command - Command to send
     * @returns {void}
     */
    sendCommandToTerminal(terminalId, command) {
        this.sendTerminalInput(terminalId, command);
        this.sendEnterKey(terminalId);
    }

    // ========================================
    // Cleanup
    // ========================================

    /**
     * Clean up all listeners
     * @returns {void}
     */
    cleanup() {
        for (const [channel, listeners] of this.listeners) {
            listeners.forEach(listener => {
                ipcRenderer.off(channel, listener);
            });
        }
        this.listeners.clear();
    }
}

module.exports = IPCHandler;