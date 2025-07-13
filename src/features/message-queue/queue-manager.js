/**
 * Message Queue Manager
 * Handles message queue operations including CRUD, validation, and persistence
 */

const ValidationUtils = require('../../utils/validation');

class MessageQueueManager {
    constructor(ipcHandler, eventHandler = null) {
        this.ipcHandler = ipcHandler;
        this.eventHandler = eventHandler;
        this.validationUtils = new ValidationUtils();
        
        // Message queue state
        this.messageQueue = [];
        this.messageSequenceCounter = 0;
        this.editingMessageId = null;
        this.originalEditContent = null;
        
        // Tracking sets
        this.currentlyInjectingMessages = new Set();
        this.processedUsageLimitMessages = new Set();
        this.processedPrompts = new Set();
        
        // Attached files and previews
        this.attachedFiles = [];
        this.imagePreviews = [];
    }

    // ========================================
    // Core Queue Operations
    // ========================================

    /**
     * Add message to queue
     * @param {string} content - Message content
     * @param {number} terminalId - Target terminal ID
     * @param {Object} options - Additional options
     * @returns {Object|null} Created message or null if invalid
     */
    async addMessage(content, terminalId, options = {}) {
        // Validate content
        const validation = this.validationUtils.validateMessageContent(content);
        if (!validation.isValid) {
            console.error('Invalid message content:', validation.errors);
            return null;
        }

        // Validate terminal ID
        if (!this.validationUtils.validateTerminalId(terminalId)) {
            console.error('Invalid terminal ID:', terminalId);
            return null;
        }

        // Handle special commands
        if (content.startsWith('/')) {
            const handled = await this.handleSpecialCommand(content);
            if (handled) {
                return null; // Command was handled, don't add to queue
            }
        }

        // Prepare file paths for injection (images first, then other files)
        let filePaths = '';
        if (this.attachedFiles && this.attachedFiles.length > 0) {
            const imageFiles = this.attachedFiles.filter(f => f.isImage);
            const otherFiles = this.attachedFiles.filter(f => !f.isImage);
            const allFiles = [...imageFiles, ...otherFiles];
            const pathStrings = allFiles.map(f => `'${f.path}'`);
            filePaths = pathStrings.join(' ') + (content ? ' ' : '');
        }

        const now = Date.now();
        const message = {
            id: this.validationUtils.generateId(),
            content: content, // Original user message text only
            processedContent: filePaths + content, // File paths + user message for injection
            executeAt: now,
            createdAt: now,
            timestamp: now, // For compatibility
            terminalId: terminalId,
            sequence: ++this.messageSequenceCounter, // Add sequence counter for proper ordering
            imagePreviews: this.imagePreviews ? [...this.imagePreviews] : [], // Copy current image previews
            attachedFiles: this.attachedFiles ? [...this.attachedFiles] : [], // Copy attached files
            wrapWithPlan: options.planModeEnabled || false,
            ...options // Merge any additional options
        };

        // Add to queue
        this.messageQueue.push(message);

        // Save and update UI
        await this.saveQueue();
        this.emitEvent('messageAdded', message);
        this.emitEvent('queueUpdated');

        // Clear attachments after adding
        this.clearAttachments();

        console.log(`Added message to queue for terminal ${terminalId}: "${content}"`);

        // Save to backend if available
        await this.saveToBackend(message);

        return message;
    }

    /**
     * Update existing message in queue
     * @param {number|string} messageId - Message ID
     * @param {string} newContent - New message content
     * @returns {boolean} True if updated successfully
     */
    updateMessage(messageId, newContent) {
        const validation = this.validationUtils.validateMessageContent(newContent);
        if (!validation.isValid) {
            console.error('Invalid message content:', validation.errors);
            return false;
        }

        const index = this.messageQueue.findIndex(m => m.id === messageId);
        if (index === -1) {
            console.error('Message not found:', messageId);
            return false;
        }

        const oldContent = this.messageQueue[index].content;
        this.messageQueue[index].content = newContent;
        this.messageQueue[index].processedContent = newContent;

        this.saveQueue();
        this.emitEvent('messageUpdated', this.messageQueue[index]);
        this.emitEvent('queueUpdated');

        console.log(`Updated message: "${oldContent}" → "${newContent}"`);
        return true;
    }

    /**
     * Delete message from queue
     * @param {number|string} messageId - Message ID
     * @returns {boolean} True if deleted successfully
     */
    deleteMessage(messageId) {
        const index = this.messageQueue.findIndex(m => m.id === messageId);
        if (index === -1) {
            console.error('Message not found:', messageId);
            return false;
        }

        const message = this.messageQueue[index];
        this.messageQueue.splice(index, 1);

        this.saveQueue();
        this.emitEvent('messageDeleted', message);
        this.emitEvent('queueUpdated');

        console.log(`Deleted message: "${message.content}"`);
        return true;
    }

    /**
     * Clear entire message queue
     * @returns {number} Number of messages cleared
     */
    clearQueue() {
        const count = this.messageQueue.length;
        if (count > 0) {
            this.messageQueue = [];
            this.saveQueue();
            this.emitEvent('queueCleared', count);
            this.emitEvent('queueUpdated');
            console.log(`Cleared message queue (${count} messages removed)`);
        }
        return count;
    }

    /**
     * Get message by ID
     * @param {number|string} messageId - Message ID
     * @returns {Object|null} Message object or null if not found
     */
    getMessage(messageId) {
        return this.messageQueue.find(m => m.id === messageId) || null;
    }

    /**
     * Get all messages in queue
     * @returns {Array} Array of message objects
     */
    getAllMessages() {
        return [...this.messageQueue]; // Return copy to prevent external modification
    }

    /**
     * Get messages for specific terminal
     * @param {number} terminalId - Terminal ID
     * @returns {Array} Array of messages for the terminal
     */
    getMessagesForTerminal(terminalId) {
        return this.messageQueue.filter(m => m.terminalId === terminalId);
    }

    /**
     * Get queue length
     * @returns {number} Number of messages in queue
     */
    getQueueLength() {
        return this.messageQueue.length;
    }

    /**
     * Check if queue is empty
     * @returns {boolean} True if queue is empty
     */
    isEmpty() {
        return this.messageQueue.length === 0;
    }

    // ========================================
    // Message Editing
    // ========================================

    /**
     * Start editing a message
     * @param {number|string} messageId - Message ID
     * @returns {boolean} True if editing started successfully
     */
    startEditing(messageId) {
        const message = this.getMessage(messageId);
        if (!message) {
            console.error('Cannot start editing - message not found:', messageId);
            return false;
        }

        this.editingMessageId = messageId;
        this.originalEditContent = message.content;
        this.emitEvent('editingStarted', message);
        return true;
    }

    /**
     * Cancel editing
     */
    cancelEditing() {
        if (this.editingMessageId) {
            const messageId = this.editingMessageId;
            this.editingMessageId = null;
            this.originalEditContent = null;
            this.emitEvent('editingCancelled', messageId);
        }
    }

    /**
     * Get currently editing message ID
     * @returns {number|string|null} Message ID being edited or null
     */
    getEditingMessageId() {
        return this.editingMessageId;
    }

    // ========================================
    // File Attachments
    // ========================================

    /**
     * Add file attachment
     * @param {File} file - File to attach
     * @returns {boolean} True if added successfully
     */
    addAttachment(file) {
        const validation = this.validationUtils.validateFileType(file, [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'text/plain', 'application/json', 'text/csv'
        ]);

        if (!validation.isValid) {
            console.error('Invalid file:', validation.errors);
            return false;
        }

        const isImage = file.type.startsWith('image/');
        const attachment = {
            id: this.validationUtils.generateId('file'),
            name: file.name,
            path: file.path || '',
            type: file.type,
            size: file.size,
            isImage: isImage,
            file: file
        };

        this.attachedFiles.push(attachment);

        if (isImage) {
            this.addImagePreview(file, attachment.id);
        }

        this.emitEvent('attachmentAdded', attachment);
        return true;
    }

    /**
     * Remove file attachment
     * @param {string} attachmentId - Attachment ID
     * @returns {boolean} True if removed successfully
     */
    removeAttachment(attachmentId) {
        const index = this.attachedFiles.findIndex(f => f.id === attachmentId);
        if (index === -1) {
            return false;
        }

        const attachment = this.attachedFiles[index];
        this.attachedFiles.splice(index, 1);

        if (attachment.isImage) {
            this.removeImagePreview(attachmentId);
        }

        this.emitEvent('attachmentRemoved', attachment);
        return true;
    }

    /**
     * Clear all attachments
     */
    clearAttachments() {
        const count = this.attachedFiles.length;
        this.attachedFiles = [];
        this.imagePreviews = [];
        this.emitEvent('attachmentsCleared', count);
    }

    /**
     * Add image preview
     * @param {File} file - Image file
     * @param {string} id - Preview ID
     */
    addImagePreview(file, id) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const preview = {
                id: id,
                name: file.name,
                dataUrl: e.target.result,
                size: file.size
            };
            this.imagePreviews.push(preview);
            this.emitEvent('imagePreviewAdded', preview);
        };
        reader.readAsDataURL(file);
    }

    /**
     * Remove image preview
     * @param {string} previewId - Preview ID
     */
    removeImagePreview(previewId) {
        const index = this.imagePreviews.findIndex(p => p.id === previewId);
        if (index > -1) {
            const preview = this.imagePreviews[index];
            this.imagePreviews.splice(index, 1);
            this.emitEvent('imagePreviewRemoved', preview);
        }
    }

    // ========================================
    // Special Commands
    // ========================================

    /**
     * Handle special commands (starting with /)
     * @param {string} content - Command content
     * @returns {boolean} True if command was handled
     */
    async handleSpecialCommand(content) {
        if (content.startsWith('/usage-limit-status')) {
            // This would be handled by usage limit handler
            this.emitEvent('specialCommand', { type: 'usage-limit-status', content });
            return true;
        }

        if (content.startsWith('/usage-limit-reset')) {
            // This would be handled by usage limit handler
            this.emitEvent('specialCommand', { type: 'usage-limit-reset', content });
            return true;
        }

        if (content.startsWith('/help')) {
            // This would be handled by help system
            this.emitEvent('specialCommand', { type: 'help', content });
            return true;
        }

        return false; // Command not handled
    }

    // ========================================
    // Persistence
    // ========================================

    /**
     * Save queue to persistent storage
     */
    async saveQueue() {
        try {
            if (this.ipcHandler) {
                await this.ipcHandler.saveMessageQueue(this.messageQueue);
            }
        } catch (error) {
            console.error('Failed to save message queue:', error);
        }
    }

    /**
     * Load queue from persistent storage
     */
    async loadQueue() {
        try {
            if (this.ipcHandler) {
                const loadedQueue = await this.ipcHandler.loadMessageQueue();
                if (loadedQueue && Array.isArray(loadedQueue)) {
                    this.messageQueue = loadedQueue;
                    this.emitEvent('queueLoaded', this.messageQueue);
                    this.emitEvent('queueUpdated');
                }
            }
        } catch (error) {
            console.error('Failed to load message queue:', error);
        }
    }

    /**
     * Save message to backend
     * @param {Object} message - Message to save
     */
    async saveToBackend(message) {
        // This would be implemented by backend integration
        // Left as placeholder for future implementation
        console.log('saveToBackend called - backend integration needed');
    }

    // ========================================
    // Validation and Utilities
    // ========================================

    /**
     * Validate all message IDs in queue
     * @returns {boolean} True if all IDs are unique
     */
    validateMessageIds() {
        return this.validationUtils.validateMessageIds(this.messageQueue);
    }

    /**
     * Get next sequence number
     * @returns {number} Next sequence number
     */
    getNextSequence() {
        return ++this.messageSequenceCounter;
    }

    /**
     * Reset sequence counter
     */
    resetSequenceCounter() {
        this.messageSequenceCounter = 0;
    }

    /**
     * Get queue statistics
     * @returns {Object} Queue statistics
     */
    getStatistics() {
        const terminalCounts = {};
        this.messageQueue.forEach(message => {
            terminalCounts[message.terminalId] = (terminalCounts[message.terminalId] || 0) + 1;
        });

        return {
            totalMessages: this.messageQueue.length,
            terminalCounts: terminalCounts,
            attachmentCount: this.attachedFiles.length,
            imagePreviewCount: this.imagePreviews.length,
            editingMessage: this.editingMessageId
        };
    }

    // ========================================
    // Event Handling
    // ========================================

    /**
     * Emit event if event handler is available
     * @param {string} eventName - Event name
     * @param {any} data - Event data
     */
    emitEvent(eventName, data) {
        if (this.eventHandler && typeof this.eventHandler.emit === 'function') {
            this.eventHandler.emit(eventName, data);
        }
    }

    // ========================================
    // Cleanup
    // ========================================

    /**
     * Clean up resources
     */
    cleanup() {
        this.clearQueue();
        this.clearAttachments();
        this.cancelEditing();
        this.currentlyInjectingMessages.clear();
        this.processedUsageLimitMessages.clear();
        this.processedPrompts.clear();
    }
}

module.exports = MessageQueueManager;