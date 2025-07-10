/**
 * Message Queue Utils Module
 * 
 * Message queue processing and management utilities
 * Extracted from TerminalGUI for better modularity
 */

class MessageQueueUtils {
    constructor(logAction) {
        this.logAction = logAction || console.log;
        this.messageIdCounter = 0;
        this.duplicateIdMap = new Map();
    }

    /**
     * Validate message content
     * @param {string} content - Message content to validate
     * @returns {Object} - Validation result
     */
    isValidMessageContent(content) {
        if (!content || typeof content !== 'string') {
            return { valid: false, reason: 'Content must be a non-empty string' };
        }

        const trimmed = content.trim();
        if (trimmed.length === 0) {
            return { valid: false, reason: 'Content cannot be empty or only whitespace' };
        }

        if (trimmed.length > 10000) {
            return { valid: false, reason: 'Content too long (max 10,000 characters)' };
        }

        return { valid: true, content: trimmed };
    }

    /**
     * Generate unique message ID
     * @returns {string} - Unique message identifier
     */
    generateMessageId() {
        this.messageIdCounter++;
        return `msg_${Date.now()}_${this.messageIdCounter}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Validate message IDs for duplicates (debug function)
     * @param {Array} messages - Array of messages to validate
     * @returns {Object} - Validation result with duplicate info
     */
    validateMessageIds(messages) {
        const seenIds = new Set();
        const duplicates = [];

        messages.forEach((message, index) => {
            if (seenIds.has(message.id)) {
                duplicates.push({ id: message.id, index, message });
            } else {
                seenIds.add(message.id);
            }
        });

        return {
            hasDuplicates: duplicates.length > 0,
            duplicates,
            totalMessages: messages.length,
            uniqueMessages: seenIds.size
        };
    }

    /**
     * Create message object with validation
     * @param {string} content - Message content
     * @param {Object} options - Message options
     * @returns {Object} - Created message object or error
     */
    createMessage(content, options = {}) {
        const validation = this.isValidMessageContent(content);
        if (!validation.valid) {
            return { success: false, error: validation.reason };
        }

        const message = {
            id: options.id || this.generateMessageId(),
            content: validation.content,
            timestamp: options.timestamp || new Date().toISOString(),
            type: options.type || 'user',
            status: options.status || 'pending',
            terminalId: options.terminalId || null,
            priority: options.priority || 'normal',
            metadata: options.metadata || {},
            retries: 0,
            maxRetries: options.maxRetries || 3
        };

        return { success: true, message };
    }

    /**
     * Update message queue display
     * @param {Array} messageQueue - Current message queue
     * @param {HTMLElement} container - Container element for queue display
     * @param {Object} options - Display options
     */
    updateMessageList(messageQueue, container, options = {}) {
        if (!container) return;

        container.innerHTML = '';

        if (!messageQueue || messageQueue.length === 0) {
            const emptyMessage = document.createElement('div');
            emptyMessage.className = 'empty-state';
            emptyMessage.textContent = 'No messages in queue';
            container.appendChild(emptyMessage);
            return;
        }

        // Create header if enabled
        if (options.showHeader !== false) {
            const header = document.createElement('div');
            header.className = 'queue-header';
            header.innerHTML = `
                <span class="queue-count">${messageQueue.length} message${messageQueue.length !== 1 ? 's' : ''}</span>
                <span class="queue-actions">
                    <button class="clear-queue-btn" title="Clear Queue">Clear</button>
                </span>
            `;
            container.appendChild(header);

            // Add clear queue functionality
            const clearBtn = header.querySelector('.clear-queue-btn');
            if (clearBtn && options.onClear) {
                clearBtn.addEventListener('click', options.onClear);
            }
        }

        // Create queue list
        const queueList = document.createElement('div');
        queueList.className = 'queue-list';

        messageQueue.forEach((message, index) => {
            const messageElement = this.createMessageElement(message, index, options);
            queueList.appendChild(messageElement);
        });

        container.appendChild(queueList);

        // Setup drag and drop if enabled
        if (options.allowReorder !== false) {
            this.setupMessageReordering(queueList, options.onReorder);
        }
    }

    /**
     * Create message element for display
     * @param {Object} message - Message object
     * @param {number} index - Message index in queue
     * @param {Object} options - Display options
     * @returns {HTMLElement} - Message DOM element
     */
    createMessageElement(message, index, options = {}) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `queue-message ${message.status} ${message.priority}`;
        messageDiv.dataset.messageId = message.id;
        messageDiv.dataset.index = index;

        // Message content
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.textContent = this.truncateMessage(message.content, options.maxLength || 100);
        contentDiv.title = message.content; // Full content on hover

        // Message metadata
        const metaDiv = document.createElement('div');
        metaDiv.className = 'message-meta';
        
        const timeSpan = document.createElement('span');
        timeSpan.className = 'message-time';
        timeSpan.textContent = this.formatTimestamp(message.timestamp);
        
        const statusSpan = document.createElement('span');
        statusSpan.className = `message-status status-${message.status}`;
        statusSpan.textContent = message.status.toUpperCase();

        metaDiv.appendChild(timeSpan);
        metaDiv.appendChild(statusSpan);

        // Terminal assignment if available
        if (message.terminalId) {
            const terminalSpan = document.createElement('span');
            terminalSpan.className = 'message-terminal';
            terminalSpan.textContent = `Terminal ${message.terminalId}`;
            metaDiv.appendChild(terminalSpan);
        }

        // Message actions
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'message-actions';

        // Edit button
        if (options.allowEdit !== false) {
            const editBtn = document.createElement('button');
            editBtn.className = 'edit-message-btn';
            editBtn.innerHTML = '✎';
            editBtn.title = 'Edit Message';
            editBtn.addEventListener('click', () => {
                if (options.onEdit) options.onEdit(message, index);
            });
            actionsDiv.appendChild(editBtn);
        }

        // Remove button
        if (options.allowRemove !== false) {
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-message-btn';
            removeBtn.innerHTML = '×';
            removeBtn.title = 'Remove Message';
            removeBtn.addEventListener('click', () => {
                if (options.onRemove) options.onRemove(message, index);
            });
            actionsDiv.appendChild(removeBtn);
        }

        // Priority indicator
        if (message.priority !== 'normal') {
            const priorityIndicator = document.createElement('div');
            priorityIndicator.className = `priority-indicator priority-${message.priority}`;
            priorityIndicator.textContent = message.priority === 'high' ? '⬆' : '⬇';
            messageDiv.appendChild(priorityIndicator);
        }

        messageDiv.appendChild(contentDiv);
        messageDiv.appendChild(metaDiv);
        messageDiv.appendChild(actionsDiv);

        return messageDiv;
    }

    /**
     * Setup message reordering via drag and drop
     * @param {HTMLElement} container - Container element
     * @param {Function} onReorder - Reorder callback
     */
    setupMessageReordering(container, onReorder) {
        if (!container || typeof onReorder !== 'function') return;

        let draggedElement = null;
        let draggedIndex = null;

        // Make messages draggable
        container.querySelectorAll('.queue-message').forEach(message => {
            message.draggable = true;
            
            message.addEventListener('dragstart', (e) => {
                draggedElement = message;
                draggedIndex = parseInt(message.dataset.index);
                message.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            message.addEventListener('dragend', () => {
                if (draggedElement) {
                    draggedElement.classList.remove('dragging');
                    draggedElement = null;
                    draggedIndex = null;
                }
                
                // Remove drop indicators
                container.querySelectorAll('.drop-indicator').forEach(indicator => {
                    indicator.remove();
                });
            });

            message.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                
                // Show drop indicator
                const rect = message.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                const isAbove = e.clientY < midY;
                
                // Remove existing indicators
                container.querySelectorAll('.drop-indicator').forEach(indicator => {
                    indicator.remove();
                });
                
                // Add new indicator
                const indicator = document.createElement('div');
                indicator.className = 'drop-indicator';
                
                if (isAbove) {
                    message.parentNode.insertBefore(indicator, message);
                } else {
                    message.parentNode.insertBefore(indicator, message.nextSibling);
                }
            });

            message.addEventListener('drop', (e) => {
                e.preventDefault();
                
                if (draggedElement && draggedElement !== message) {
                    const targetIndex = parseInt(message.dataset.index);
                    const rect = message.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    const isAbove = e.clientY < midY;
                    
                    let newIndex = targetIndex;
                    if (!isAbove) newIndex++;
                    if (draggedIndex < newIndex) newIndex--;
                    
                    onReorder(draggedIndex, newIndex);
                }
            });
        });
    }

    /**
     * Clear message queue with confirmation
     * @param {Array} messageQueue - Current message queue
     * @param {Function} onClear - Clear callback
     * @returns {boolean} - Whether queue was cleared
     */
    clearQueue(messageQueue, onClear) {
        if (!messageQueue || messageQueue.length === 0) {
            this.logAction('Queue is already empty', 'info');
            return false;
        }

        const confirmed = confirm(`Are you sure you want to clear all ${messageQueue.length} messages from the queue?`);
        if (confirmed && typeof onClear === 'function') {
            onClear();
            this.logAction(`Cleared ${messageQueue.length} messages from queue`, 'info');
            return true;
        }
        
        return false;
    }

    /**
     * Filter messages by criteria
     * @param {Array} messages - Messages to filter
     * @param {Object} criteria - Filter criteria
     * @returns {Array} - Filtered messages
     */
    filterMessages(messages, criteria = {}) {
        if (!messages || !Array.isArray(messages)) return [];

        return messages.filter(message => {
            // Filter by status
            if (criteria.status && message.status !== criteria.status) {
                return false;
            }

            // Filter by terminal
            if (criteria.terminalId && message.terminalId !== criteria.terminalId) {
                return false;
            }

            // Filter by priority
            if (criteria.priority && message.priority !== criteria.priority) {
                return false;
            }

            // Filter by content search
            if (criteria.search) {
                const searchTerm = criteria.search.toLowerCase();
                if (!message.content.toLowerCase().includes(searchTerm)) {
                    return false;
                }
            }

            // Filter by date range
            if (criteria.fromDate || criteria.toDate) {
                const messageDate = new Date(message.timestamp);
                
                if (criteria.fromDate && messageDate < criteria.fromDate) {
                    return false;
                }
                
                if (criteria.toDate && messageDate > criteria.toDate) {
                    return false;
                }
            }

            return true;
        });
    }

    /**
     * Sort messages by criteria
     * @param {Array} messages - Messages to sort
     * @param {string} sortBy - Sort field
     * @param {string} direction - Sort direction ('asc' or 'desc')
     * @returns {Array} - Sorted messages
     */
    sortMessages(messages, sortBy = 'timestamp', direction = 'desc') {
        if (!messages || !Array.isArray(messages)) return [];

        return [...messages].sort((a, b) => {
            let aVal = a[sortBy];
            let bVal = b[sortBy];

            // Handle timestamps
            if (sortBy === 'timestamp') {
                aVal = new Date(aVal);
                bVal = new Date(bVal);
            }

            // Handle priority
            if (sortBy === 'priority') {
                const priorityOrder = { high: 3, normal: 2, low: 1 };
                aVal = priorityOrder[aVal] || 2;
                bVal = priorityOrder[bVal] || 2;
            }

            let comparison = 0;
            if (aVal > bVal) comparison = 1;
            if (aVal < bVal) comparison = -1;

            return direction === 'desc' ? -comparison : comparison;
        });
    }

    /**
     * Get queue statistics
     * @param {Array} messageQueue - Message queue
     * @returns {Object} - Queue statistics
     */
    getQueueStats(messageQueue) {
        if (!messageQueue || !Array.isArray(messageQueue)) {
            return { total: 0 };
        }

        const stats = {
            total: messageQueue.length,
            byStatus: {},
            byPriority: {},
            byTerminal: {},
            avgContentLength: 0,
            oldestMessage: null,
            newestMessage: null
        };

        let totalContentLength = 0;
        let oldestTime = null;
        let newestTime = null;

        messageQueue.forEach(message => {
            // Count by status
            stats.byStatus[message.status] = (stats.byStatus[message.status] || 0) + 1;

            // Count by priority
            stats.byPriority[message.priority] = (stats.byPriority[message.priority] || 0) + 1;

            // Count by terminal
            const terminal = message.terminalId || 'unassigned';
            stats.byTerminal[terminal] = (stats.byTerminal[terminal] || 0) + 1;

            // Content length
            totalContentLength += message.content.length;

            // Timestamps
            const messageTime = new Date(message.timestamp);
            if (!oldestTime || messageTime < oldestTime) {
                oldestTime = messageTime;
                stats.oldestMessage = message;
            }
            if (!newestTime || messageTime > newestTime) {
                newestTime = messageTime;
                stats.newestMessage = message;
            }
        });

        stats.avgContentLength = Math.round(totalContentLength / messageQueue.length) || 0;

        return stats;
    }

    /**
     * Truncate message content for display
     * @param {string} content - Message content
     * @param {number} maxLength - Maximum length
     * @returns {string} - Truncated content
     */
    truncateMessage(content, maxLength = 100) {
        if (!content || content.length <= maxLength) return content;
        return content.substring(0, maxLength - 3) + '...';
    }

    /**
     * Format timestamp for display
     * @param {string} timestamp - ISO timestamp
     * @returns {string} - Formatted timestamp
     */
    formatTimestamp(timestamp) {
        try {
            const date = new Date(timestamp);
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (error) {
            return 'Invalid time';
        }
    }

    /**
     * Export messages as JSON
     * @param {Array} messages - Messages to export
     * @returns {string} - JSON string
     */
    exportMessages(messages) {
        try {
            return JSON.stringify(messages, null, 2);
        } catch (error) {
            this.logAction(`Failed to export messages: ${error.message}`, 'error');
            return null;
        }
    }

    /**
     * Import messages from JSON
     * @param {string} jsonData - JSON string of messages
     * @returns {Object} - Import result
     */
    importMessages(jsonData) {
        try {
            const imported = JSON.parse(jsonData);
            
            if (!Array.isArray(imported)) {
                throw new Error('Invalid format: expected array of messages');
            }

            // Validate and clean imported messages
            const validMessages = imported.filter(message => {
                if (!message || typeof message !== 'object') return false;
                if (!message.content || typeof message.content !== 'string') return false;
                return true;
            }).map(message => {
                // Ensure all required fields exist
                return {
                    id: message.id || this.generateMessageId(),
                    content: message.content,
                    timestamp: message.timestamp || new Date().toISOString(),
                    type: message.type || 'user',
                    status: message.status || 'pending',
                    terminalId: message.terminalId || null,
                    priority: message.priority || 'normal',
                    metadata: message.metadata || {},
                    retries: 0,
                    maxRetries: message.maxRetries || 3
                };
            });

            return {
                success: true,
                messages: validMessages,
                imported: validMessages.length,
                skipped: imported.length - validMessages.length
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Find message by ID
     * @param {Array} messages - Messages to search
     * @param {string} messageId - Message ID to find
     * @returns {Object|null} - Found message or null
     */
    findMessageById(messages, messageId) {
        if (!messages || !Array.isArray(messages) || !messageId) return null;
        return messages.find(message => message.id === messageId) || null;
    }

    /**
     * Remove message by ID
     * @param {Array} messages - Messages array
     * @param {string} messageId - Message ID to remove
     * @returns {boolean} - Whether message was removed
     */
    removeMessageById(messages, messageId) {
        if (!messages || !Array.isArray(messages) || !messageId) return false;
        
        const index = messages.findIndex(message => message.id === messageId);
        if (index !== -1) {
            messages.splice(index, 1);
            return true;
        }
        return false;
    }

    /**
     * Move message to new position
     * @param {Array} messages - Messages array
     * @param {number} fromIndex - Source index
     * @param {number} toIndex - Target index
     * @returns {boolean} - Whether message was moved
     */
    moveMessage(messages, fromIndex, toIndex) {
        if (!messages || !Array.isArray(messages)) return false;
        if (fromIndex < 0 || fromIndex >= messages.length) return false;
        if (toIndex < 0 || toIndex >= messages.length) return false;
        if (fromIndex === toIndex) return false;

        const message = messages.splice(fromIndex, 1)[0];
        messages.splice(toIndex, 0, message);
        return true;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MessageQueueUtils;
} else if (typeof window !== 'undefined') {
    window.MessageQueueUtils = MessageQueueUtils;
}