/**
 * Action Log Manager Module
 * 
 * Handles action logging functionality including display, filtering, and search
 * Extracted from TerminalGUI for better modularity
 */

class ActionLogManager {
    constructor() {
        this.actionLog = [];
        this.logDisplaySettings = {
            entriesPerPage: 50,
            currentPage: 0,
            searchTerm: '',
            maxEntries: 10000
        };
    }

    /**
     * Log an action with timestamp and type
     * @param {string} message - The action message
     * @param {string} type - The log type (info, warning, error, success)
     */
    logAction(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const entry = {
            id: Date.now() + Math.random(), // Unique ID for each entry
            timestamp,
            message,
            type,
            fullTimestamp: new Date()
        };
        
        this.actionLog.unshift(entry); // Add to beginning for chronological order
        
        // Limit log size to prevent memory issues
        if (this.actionLog.length > this.logDisplaySettings.maxEntries) {
            this.actionLog = this.actionLog.slice(0, this.logDisplaySettings.maxEntries);
        }
        
        // Update display if currently visible
        this.updateActionLogDisplay();
        
        return entry;
    }

    /**
     * Initialize or update the action log display
     */
    updateActionLogDisplay() {
        // Initialize display settings if needed
        if (!this.logDisplaySettings.entriesPerPage) {
            this.logDisplaySettings.entriesPerPage = 50;
            this.logDisplaySettings.currentPage = 0;
        }
        
        this.renderLogEntries();
    }

    /**
     * Render log entries to the DOM with pagination and filtering
     */
    renderLogEntries() {
        const logList = document.getElementById('action-log');
        if (!logList) return;

        // Get filtered logs based on search term
        const filteredLogs = this.getFilteredLogs();
        
        // Calculate pagination
        const startIndex = this.logDisplaySettings.currentPage * this.logDisplaySettings.entriesPerPage;
        const endIndex = startIndex + this.logDisplaySettings.entriesPerPage;
        const pageEntries = filteredLogs.slice(startIndex, endIndex);
        
        // Clear existing content
        logList.innerHTML = '';
        
        // Render entries for current page
        pageEntries.forEach(entry => {
            const logElement = this.createLogElement(entry);
            logList.appendChild(logElement);
        });
        
        // Add load more button if there are more entries
        if (endIndex < filteredLogs.length) {
            const loadMoreBtn = document.createElement('button');
            loadMoreBtn.textContent = `Load More (${filteredLogs.length - endIndex} remaining)`;
            loadMoreBtn.className = 'load-more-btn';
            loadMoreBtn.onclick = () => {
                this.logDisplaySettings.currentPage++;
                this.renderLogEntries();
            };
            logList.appendChild(loadMoreBtn);
        }
        
        // Auto-scroll to bottom if showing latest entries
        if (this.logDisplaySettings.currentPage === 0 && !this.logDisplaySettings.searchTerm) {
            logList.scrollTop = logList.scrollHeight;
        }
    }

    /**
     * Create a log element for display
     * @param {Object} entry - Log entry object
     * @returns {HTMLElement} - DOM element for the log entry
     */
    createLogElement(entry) {
        const logItem = document.createElement('div');
        logItem.className = `log-item log-${entry.type}`;
        
        const timespan = document.createElement('span');
        timespan.className = 'log-time';
        timespan.textContent = entry.timestamp;
        
        const messageSpan = document.createElement('span');
        messageSpan.className = 'log-message';
        
        // Highlight search terms if searching
        if (this.logDisplaySettings.searchTerm) {
            messageSpan.innerHTML = this.highlightSearchTerm(entry.message, this.logDisplaySettings.searchTerm);
        } else {
            messageSpan.textContent = entry.message;
        }
        
        logItem.appendChild(timespan);
        logItem.appendChild(messageSpan);
        
        return logItem;
    }

    /**
     * Get filtered logs based on current search term
     * @returns {Array} - Filtered log entries
     */
    getFilteredLogs() {
        if (!this.logDisplaySettings.searchTerm) {
            return this.actionLog;
        }
        
        const searchTerm = this.logDisplaySettings.searchTerm.toLowerCase();
        return this.actionLog.filter(entry => 
            entry.message.toLowerCase().includes(searchTerm) ||
            entry.type.toLowerCase().includes(searchTerm)
        );
    }

    /**
     * Highlight search terms in log messages
     * @param {string} text - Original text
     * @param {string} searchTerm - Term to highlight
     * @returns {string} - HTML with highlighted terms
     */
    highlightSearchTerm(text, searchTerm) {
        if (!searchTerm) return text;
        
        const regex = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        return text.replace(regex, '<mark>$1</mark>');
    }

    /**
     * Set search term and update display
     * @param {string} searchTerm - Search term to filter by
     */
    setSearchTerm(searchTerm) {
        this.logDisplaySettings.searchTerm = searchTerm;
        this.logDisplaySettings.currentPage = 0; // Reset to first page
        this.renderLogEntries();
    }

    /**
     * Clear search and reset display
     */
    clearLogSearch() {
        const searchInput = document.getElementById('log-search');
        if (searchInput) {
            searchInput.value = '';
        }
        
        this.logDisplaySettings.searchTerm = '';
        this.logDisplaySettings.currentPage = 0;
        this.renderLogEntries();
    }

    /**
     * Clear all log entries
     */
    clearActionLog() {
        this.actionLog = [];
        this.logDisplaySettings.currentPage = 0;
        this.logDisplaySettings.searchTerm = '';
        
        const searchInput = document.getElementById('log-search');
        if (searchInput) {
            searchInput.value = '';
        }
        
        this.renderLogEntries();
    }

    /**
     * Get log statistics
     * @returns {Object} - Log statistics
     */
    getLogStats() {
        const stats = {
            total: this.actionLog.length,
            byType: {}
        };
        
        this.actionLog.forEach(entry => {
            stats.byType[entry.type] = (stats.byType[entry.type] || 0) + 1;
        });
        
        return stats;
    }

    /**
     * Export logs as JSON
     * @returns {string} - JSON string of logs
     */
    exportLogs() {
        return JSON.stringify(this.actionLog, null, 2);
    }

    /**
     * Import logs from JSON
     * @param {string} jsonData - JSON string of logs
     */
    importLogs(jsonData) {
        try {
            const importedLogs = JSON.parse(jsonData);
            if (Array.isArray(importedLogs)) {
                this.actionLog = importedLogs;
                this.updateActionLogDisplay();
                return true;
            }
        } catch (error) {
            console.error('Failed to import logs:', error);
        }
        return false;
    }

    /**
     * Get recent logs within specified time range
     * @param {number} minutes - Number of minutes to look back
     * @returns {Array} - Recent log entries
     */
    getRecentLogs(minutes = 5) {
        const cutoffTime = new Date(Date.now() - minutes * 60 * 1000);
        return this.actionLog.filter(entry => 
            entry.fullTimestamp && entry.fullTimestamp > cutoffTime
        );
    }

    /**
     * Initialize event listeners for log interface
     */
    initializeEventListeners() {
        // Search input listener
        const searchInput = document.getElementById('log-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.setSearchTerm(e.target.value);
            });
        }

        // Clear search button
        const clearSearchBtn = document.getElementById('clear-log-search');
        if (clearSearchBtn) {
            clearSearchBtn.addEventListener('click', () => {
                this.clearLogSearch();
            });
        }

        // Clear log button
        const clearLogBtn = document.getElementById('clear-action-log');
        if (clearLogBtn) {
            clearLogBtn.addEventListener('click', () => {
                this.clearActionLog();
            });
        }
    }

    /**
     * Destroy and cleanup
     */
    destroy() {
        this.actionLog = [];
        this.logDisplaySettings = {
            entriesPerPage: 50,
            currentPage: 0,
            searchTerm: '',
            maxEntries: 10000
        };
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ActionLogManager;
} else if (typeof window !== 'undefined') {
    window.ActionLogManager = ActionLogManager;
}