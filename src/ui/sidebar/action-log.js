/**
 * Action Log Module
 * Handles action logging, filtering, and display in the sidebar
 */

class ActionLog {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        this.actionLog = [];
        this.maxLogEntries = 500; // Limit log size for performance
        this.logSearchTerm = '';
        this.logHistory = []; // For undo functionality
    }

    // Log an action with type and automatic timestamp
    logAction(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = {
            id: Date.now() + Math.random(), // Unique ID
            timestamp: timestamp,
            message: message,
            type: type, // 'info', 'success', 'warning', 'error'
            time: Date.now()
        };

        // Add to log
        this.actionLog.unshift(logEntry);

        // Limit log size
        if (this.actionLog.length > this.maxLogEntries) {
            this.actionLog = this.actionLog.slice(0, this.maxLogEntries);
        }

        // Update display
        this.renderLogEntries();

        // Auto-scroll to top for new entries
        this.scrollLogToTop();

        // Store in history for undo functionality
        this.addToHistory({
            action: 'log',
            entry: logEntry,
            timestamp: Date.now()
        });
    }

    // Render log entries with current filter
    renderLogEntries() {
        const logContainer = document.getElementById('action-log');
        if (!logContainer) return;

        const filteredLogs = this.getFilteredLogs();
        
        // Clear container
        logContainer.innerHTML = '';

        // Add filtered entries
        filteredLogs.forEach(entry => {
            const logElement = this.createLogElement(entry);
            logContainer.appendChild(logElement);
        });

        // Show "no results" message if filtered and empty
        if (filteredLogs.length === 0 && this.logSearchTerm) {
            const noResultsElement = document.createElement('div');
            noResultsElement.className = 'log-item log-no-results';
            noResultsElement.innerHTML = `
                <span class="log-time">[search]</span>
                <span class="log-message">No results found for "${this.logSearchTerm}"</span>
            `;
            logContainer.appendChild(noResultsElement);
        }
    }

    // Create a log entry DOM element
    createLogElement(entry) {
        const logElement = document.createElement('div');
        logElement.className = `log-item log-${entry.type}`;
        logElement.setAttribute('data-log-id', entry.id);

        // Highlight search term if searching
        let messageText = this.escapeHtml(entry.message);
        if (this.logSearchTerm) {
            messageText = this.highlightSearchTerm(messageText, this.logSearchTerm);
        }

        logElement.innerHTML = `
            <span class="log-time">[${entry.timestamp}]</span>
            <span class="log-message">${messageText}</span>
        `;

        // Add click handler for detailed view (optional)
        logElement.addEventListener('click', () => {
            this.showLogDetails(entry);
        });

        return logElement;
    }

    // Get filtered log entries based on search term
    getFilteredLogs() {
        if (!this.logSearchTerm || this.logSearchTerm.trim() === '') {
            return this.actionLog;
        }

        const searchTerm = this.logSearchTerm.toLowerCase();
        return this.actionLog.filter(entry => 
            entry.message.toLowerCase().includes(searchTerm) ||
            entry.type.toLowerCase().includes(searchTerm) ||
            entry.timestamp.toLowerCase().includes(searchTerm)
        );
    }

    // Highlight search term in text
    highlightSearchTerm(text, searchTerm) {
        if (!searchTerm) return text;
        
        const regex = new RegExp(`(${this.escapeRegex(searchTerm)})`, 'gi');
        return text.replace(regex, '<mark>$1</mark>');
    }

    // Set search filter
    setLogSearchFilter(searchTerm) {
        this.logSearchTerm = searchTerm;
        this.renderLogEntries();
    }

    // Clear search filter
    clearLogSearch() {
        this.logSearchTerm = '';
        const searchInput = document.getElementById('log-search');
        if (searchInput) {
            searchInput.value = '';
        }
        this.renderLogEntries();
    }

    // Clear all log entries
    clearActionLog() {
        if (this.actionLog.length === 0) {
            this.logAction('Action log is already empty', 'info');
            return;
        }

        const count = this.actionLog.length;
        
        // Store in history for undo
        this.addToHistory({
            action: 'clear',
            entries: [...this.actionLog],
            timestamp: Date.now()
        });

        this.actionLog = [];
        this.renderLogEntries();
        
        // Log the clear action (will be the only entry)
        this.logAction(`Action log cleared (${count} entries removed)`, 'info');
    }

    // Undo last action (clear or specific entry removal)
    undoFromHistory() {
        if (this.logHistory.length === 0) {
            this.logAction('No actions to undo', 'warning');
            return;
        }

        const lastAction = this.logHistory.pop();
        
        if (lastAction.action === 'clear') {
            // Restore cleared entries
            this.actionLog = [...lastAction.entries];
            this.renderLogEntries();
            this.logAction(`Restored ${lastAction.entries.length} log entries`, 'success');
        } else if (lastAction.action === 'remove') {
            // Restore removed entry
            this.actionLog.unshift(lastAction.entry);
            this.renderLogEntries();
            this.logAction('Log entry restored', 'success');
        }
    }

    // Add action to history for undo functionality
    addToHistory(historyEntry) {
        this.logHistory.push(historyEntry);
        
        // Limit history size
        if (this.logHistory.length > 10) {
            this.logHistory = this.logHistory.slice(-10);
        }
    }

    // Remove specific log entry
    removeLogEntry(entryId) {
        const entryIndex = this.actionLog.findIndex(entry => entry.id === entryId);
        if (entryIndex !== -1) {
            const removedEntry = this.actionLog.splice(entryIndex, 1)[0];
            
            // Store in history for undo
            this.addToHistory({
                action: 'remove',
                entry: removedEntry,
                timestamp: Date.now()
            });
            
            this.renderLogEntries();
            this.logAction('Log entry removed', 'info');
        }
    }

    // Show detailed log entry (optional feature)
    showLogDetails(entry) {
        // Could open a modal with full details, stack trace, etc.
        console.log('Log entry details:', entry);
    }

    // Scroll log to top (for new entries)
    scrollLogToTop() {
        const logContainer = document.getElementById('action-log');
        if (logContainer) {
            logContainer.scrollTop = 0;
        }
    }

    // Scroll log to bottom
    scrollLogToBottom() {
        const logContainer = document.getElementById('action-log');
        if (logContainer) {
            logContainer.scrollTop = logContainer.scrollHeight;
        }
    }

    // Export log entries
    exportLog() {
        const logData = {
            exportedAt: new Date().toISOString(),
            totalEntries: this.actionLog.length,
            entries: this.actionLog
        };

        const dataStr = JSON.stringify(logData, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        
        const link = document.createElement('a');
        link.href = URL.createObjectURL(dataBlob);
        link.download = `action-log-${new Date().toISOString().split('T')[0]}.json`;
        link.click();

        this.logAction('Action log exported successfully', 'success');
    }

    // Import log entries
    async importLog(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            
            if (data.entries && Array.isArray(data.entries)) {
                const currentCount = this.actionLog.length;
                
                // Add imported entries
                this.actionLog = [...data.entries, ...this.actionLog];
                
                // Limit total size
                if (this.actionLog.length > this.maxLogEntries) {
                    this.actionLog = this.actionLog.slice(0, this.maxLogEntries);
                }
                
                this.renderLogEntries();
                this.logAction(`Imported ${data.entries.length} log entries`, 'success');
                return true;
            } else {
                throw new Error('Invalid log file format');
            }
        } catch (error) {
            console.error('Failed to import log:', error);
            this.logAction('Failed to import log: ' + error.message, 'error');
            return false;
        }
    }

    // Get log statistics
    getLogStats() {
        const stats = {
            total: this.actionLog.length,
            byType: {
                info: 0,
                success: 0,
                warning: 0,
                error: 0
            },
            oldest: null,
            newest: null
        };

        this.actionLog.forEach(entry => {
            stats.byType[entry.type] = (stats.byType[entry.type] || 0) + 1;
            
            if (!stats.oldest || entry.time < stats.oldest.time) {
                stats.oldest = entry;
            }
            if (!stats.newest || entry.time > stats.newest.time) {
                stats.newest = entry;
            }
        });

        return stats;
    }

    // Setup event listeners for log controls
    setupEventListeners() {
        // Search input
        const searchInput = document.getElementById('log-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.setLogSearchFilter(e.target.value);
            });
        }

        // Clear search button
        const clearSearchBtn = document.getElementById('search-clear-btn');
        if (clearSearchBtn) {
            clearSearchBtn.addEventListener('click', () => {
                this.clearLogSearch();
            });
        }

        // Clear log button
        const clearLogBtn = document.getElementById('clear-log-btn');
        if (clearLogBtn) {
            clearLogBtn.addEventListener('click', () => {
                this.clearActionLog();
            });
        }
    }

    // Utility functions
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Initialize the action log
    initialize() {
        this.setupEventListeners();
        this.renderLogEntries();
        this.logAction('Action log initialized', 'info');
    }

    // Get current log entries (for persistence)
    getLogEntries() {
        return this.actionLog;
    }

    // Load log entries (from persistence)
    loadLogEntries(entries) {
        if (entries && Array.isArray(entries)) {
            this.actionLog = entries;
            this.renderLogEntries();
            return true;
        }
        return false;
    }
}

// Export for use in main TerminalGUI class
window.ActionLog = ActionLog;