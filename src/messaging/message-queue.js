/**
 * Message Queue Module
 * Handles message queue management, display, and processing
 */

class MessageQueue {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        
        // Queue state
        this.messageQueue = [];
        this.messageIdCounter = 1;
        this.messageSequenceCounter = 0;
        
        // Message editing state
        this.editingMessageId = null;
        this.originalEditContent = null;
        
        // Queue targeting
        this.lastAssignedTerminalId = 0; // For round-robin terminal assignment
        
        // Attached files for messages
        this.attachedFiles = null;
        this.imagePreviews = [];
    }

    generateMessageId() {
        return `msg_${this.messageIdCounter++}_${Date.now()}`;
    }

    validateMessageIds() {
        const ids = this.messageQueue.map(msg => msg.id);
        const uniqueIds = new Set(ids);
        if (ids.length !== uniqueIds.size) {
            this.gui.logAction('WARNING: Duplicate message IDs detected in queue', 'warning');
            console.warn('Duplicate message IDs:', ids);
            
            // Regenerate IDs for duplicates
            const seenIds = new Set();
            this.messageQueue.forEach(msg => {
                if (seenIds.has(msg.id)) {
                    msg.id = this.generateMessageId();
                }
                seenIds.add(msg.id);
            });
        }
    }

    async addMessage(messageContent, targetTerminal = null, files = null) {
        if (!messageContent || messageContent.trim() === '') return;

        // Parse special commands
        const lowerContent = messageContent.toLowerCase().trim();
        
        // Handle /debug command
        if (lowerContent === '/debug') {
            const status = await this.gui.usageLimitHandler?.getUsageLimitStatus();
            if (status) {
                if (status.firstDetected) {
                    this.gui.logAction(`Usage limit detection: ${status.message}`, 'info');
                    this.gui.logAction(`  First detected: ${status.firstDetected}`, 'info');
                    this.gui.logAction(`  Remaining time: ${status.remainingTime}`, 'info');
                } else {
                    this.gui.logAction(status.message, 'info');
                }
            }
            return;
        }

        // Handle /usage-limit-reset command
        if (lowerContent === '/usage-limit-reset') {
            try {
                await this.gui.usageLimitHandler?.resetUsageLimitTimer();
                this.gui.logAction('Usage limit auto-disable timer has been reset', 'success');
            } catch (error) {
                this.gui.logAction('Failed to reset usage limit timer', 'error');
            }
            return;
        }

        // Handle /help command
        if (lowerContent === '/help') {
            this.gui.logAction('Available commands:', 'info');
            this.gui.logAction('  /debug - Show usage limit detection status', 'info');
            this.gui.logAction('  /usage-limit-reset - Reset the 5-hour auto-disable timer', 'info');
            this.gui.logAction('  /help - Show this help message', 'info');
            return;
        }

        // Create message object
        const messageId = this.generateMessageId();
        const message = {
            id: messageId,
            content: messageContent,
            timestamp: Date.now(),
            sequence: this.messageSequenceCounter++,
            targetTerminal: targetTerminal,
            status: 'queued',
            files: files || this.attachedFiles,
            progress: {
                currentIndex: 0,
                totalCharacters: messageContent.length,
                isTyping: false
            }
        };

        this.messageQueue.push(message);
        
        // Save attached files to backend if available
        if (this.attachedFiles && this.attachedFiles.length > 0) {
            try {
                for (const file of this.attachedFiles) {
                    const isImage = file.type && file.type.startsWith('image/');
                    if (isImage) {
                        // Handle image file
                        const reader = new FileReader();
                        reader.onload = async (e) => {
                            const imageData = e.target.result;
                            // Store image data with message
                            if (!message.imageData) message.imageData = [];
                            message.imageData.push({
                                name: file.name,
                                type: file.type,
                                data: imageData
                            });
                        };
                        reader.readAsDataURL(file);
                    }
                }
                
                // Save message to backend if available
                if (this.gui.backendAPIClient) {
                    const messageIndex = this.messageQueue.length - 1;
                    const backendMessage = await this.gui.backendAPIClient.saveMessage({
                        content: messageContent,
                        files: this.attachedFiles,
                        timestamp: message.timestamp,
                        targetTerminal: targetTerminal
                    });
                    
                    if (messageIndex !== -1 && backendMessage && backendMessage.id) {
                        this.messageQueue[messageIndex].backendId = backendMessage.id;
                    }
                }
            } catch (error) {
                console.error('Error saving message to backend:', error);
            }
        }
        
        // Clear attached files after adding to message
        this.attachedFiles = null;
        this.clearImagePreviews();
        
        this.validateMessageIds();
        this.updateMessageList();
        this.gui.saveAllPreferences();
        
        this.gui.logAction(`Message added to queue (ID: ${messageId})`, 'info');
        
        // If not recording, clear the input field
        if (!this.gui.voiceRecorder?.isRecording) {
            const messageInput = document.getElementById('message-input');
            if (messageInput) {
                messageInput.value = '';
                this.gui.autoResizeMessageInput(messageInput);
            }
        }
        
        return messageId;
    }

    clearQueue() {
        this.messageQueue = [];
        this.updateMessageList();
        this.gui.saveAllPreferences();
        this.gui.logAction('Message queue cleared', 'info');
        
        // Reset queue status in injection manager
        if (this.gui.injectionManager) {
            this.gui.injectionManager.resetQueueStatus();
        }
    }

    updateMessageList() {
        const messageList = document.getElementById('message-list');
        if (!messageList) return;

        messageList.innerHTML = '';

        if (this.messageQueue.length === 0) {
            messageList.innerHTML = '<div class="empty-queue">No messages in queue</div>';
            this.updateQueueStatus();
            return;
        }

        this.messageQueue.forEach((message, index) => {
            const messageItem = document.createElement('div');
            messageItem.className = 'message-item';
            messageItem.setAttribute('data-message-id', message.id);
            
            // Add status classes
            if (message.status === 'injecting') {
                messageItem.classList.add('injecting');
            } else if (message.status === 'completed') {
                messageItem.classList.add('completed');
            } else if (message.status === 'error') {
                messageItem.classList.add('error');
            }

            // Create progress bar if message is being typed
            let progressBar = '';
            if (message.progress && message.progress.isTyping) {
                const progressPercent = Math.round((message.progress.currentIndex / message.progress.totalCharacters) * 100);
                progressBar = `
                    <div class="message-progress">
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: ${progressPercent}%"></div>
                        </div>
                        <span class="progress-text">${message.progress.currentIndex}/${message.progress.totalCharacters} (${progressPercent}%)</span>
                    </div>
                `;
            }

            // Handle target terminal display
            let targetTerminalInfo = '';
            if (message.targetTerminal) {
                const color = this.gui.terminalManager?.terminalColors[(message.targetTerminal - 1) % this.gui.terminalManager.terminalColors.length] || '#007acc';
                targetTerminalInfo = `<span class="target-terminal" style="color: ${color};">→ Terminal ${message.targetTerminal}</span>`;
            }

            // Handle attached files display
            let filesInfo = '';
            if (message.files && message.files.length > 0) {
                const fileNames = message.files.map(f => f.name).join(', ');
                filesInfo = `<div class="message-files"><i data-lucide="paperclip"></i> ${fileNames}</div>`;
            }

            messageItem.innerHTML = `
                <div class="message-header">
                    <span class="message-sequence">#${message.sequence + 1}</span>
                    ${targetTerminalInfo}
                    <span class="message-timestamp">${new Date(message.timestamp).toLocaleTimeString()}</span>
                    <div class="message-actions">
                        <button class="message-action-btn edit-message-btn" title="Edit message" data-message-id="${message.id}">
                            <i data-lucide="edit-3"></i>
                        </button>
                        <button class="message-action-btn delete-message-btn" title="Remove message" data-message-id="${message.id}">
                            <i data-lucide="trash-2"></i>
                        </button>
                        <button class="message-action-btn move-up-btn" title="Move up" data-message-id="${message.id}" ${index === 0 ? 'disabled' : ''}>
                            <i data-lucide="chevron-up"></i>
                        </button>
                        <button class="message-action-btn move-down-btn" title="Move down" data-message-id="${message.id}" ${index === this.messageQueue.length - 1 ? 'disabled' : ''}>
                            <i data-lucide="chevron-down"></i>
                        </button>
                    </div>
                </div>
                <div class="message-content" data-message-id="${message.id}">${this.escapeHtml(message.content)}</div>
                ${filesInfo}
                ${progressBar}
            `;

            messageList.appendChild(messageItem);
        });

        // Re-initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }

        this.updateQueueStatus();
        this.setupMessageItemEventListeners();
    }

    setupMessageItemEventListeners() {
        // Edit message buttons
        document.querySelectorAll('.edit-message-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const messageId = btn.getAttribute('data-message-id');
                this.editMessage(messageId);
            });
        });

        // Delete message buttons
        document.querySelectorAll('.delete-message-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const messageId = btn.getAttribute('data-message-id');
                this.removeMessage(messageId);
            });
        });

        // Move up buttons
        document.querySelectorAll('.move-up-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const messageId = btn.getAttribute('data-message-id');
                this.moveMessageUp(messageId);
            });
        });

        // Move down buttons
        document.querySelectorAll('.move-down-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const messageId = btn.getAttribute('data-message-id');
                this.moveMessageDown(messageId);
            });
        });

        // Message content click for in-place editing
        document.querySelectorAll('.message-content').forEach(contentElement => {
            contentElement.addEventListener('click', (e) => {
                const messageId = contentElement.getAttribute('data-message-id');
                this.startInPlaceEdit(messageId, contentElement);
            });
        });
    }

    editMessage(messageId) {
        const message = this.messageQueue.find(msg => msg.id === messageId);
        if (!message) return;

        this.editingMessageId = messageId;
        this.originalEditContent = message.content;

        const messageInput = document.getElementById('message-input');
        if (messageInput) {
            messageInput.value = message.content;
            messageInput.focus();
            messageInput.select();
            this.gui.autoResizeMessageInput(messageInput);
        }

        // Update UI to show editing state
        const messageItem = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageItem) {
            messageItem.classList.add('editing');
        }

        this.gui.logAction(`Editing message ${messageId}`, 'info');
    }

    startInPlaceEdit(messageId, contentElement) {
        const message = this.messageQueue.find(msg => msg.id === messageId);
        if (!message) return;

        // Create textarea for editing
        const textarea = document.createElement('textarea');
        textarea.value = message.content;
        textarea.className = 'message-edit-textarea';
        textarea.rows = Math.max(2, Math.ceil(message.content.length / 50));
        
        // Replace content with textarea
        contentElement.style.display = 'none';
        contentElement.parentNode.insertBefore(textarea, contentElement.nextSibling);
        
        textarea.focus();
        textarea.select();
        
        // Handle save/cancel
        const handleKeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.saveInPlaceEdit(messageId, textarea, contentElement);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.cancelInPlaceEdit(textarea, contentElement);
            }
        };
        
        const handleBlur = () => {
            this.saveInPlaceEdit(messageId, textarea, contentElement);
        };
        
        textarea.addEventListener('keydown', handleKeydown);
        textarea.addEventListener('blur', handleBlur);
    }

    saveInPlaceEdit(messageId, textarea, contentElement) {
        const newContent = textarea.value.trim();
        if (newContent === '') {
            this.cancelInPlaceEdit(textarea, contentElement);
            return;
        }

        this.updateMessage(messageId, newContent);
        
        // Update display
        contentElement.textContent = newContent;
        contentElement.style.display = '';
        textarea.remove();
        
        this.gui.logAction(`Message ${messageId} updated in-place`, 'info');
    }

    cancelInPlaceEdit(textarea, contentElement) {
        contentElement.style.display = '';
        textarea.remove();
    }

    updateMessage(messageId, newContent) {
        const messageIndex = this.messageQueue.findIndex(msg => msg.id === messageId);
        if (messageIndex === -1) return;

        this.messageQueue[messageIndex].content = newContent;
        this.messageQueue[messageIndex].progress.totalCharacters = newContent.length;
        
        this.updateMessageList();
        this.gui.saveAllPreferences();
        
        this.gui.logAction(`Message ${messageId} updated`, 'info');
    }

    removeMessage(messageId) {
        const messageIndex = this.messageQueue.findIndex(msg => msg.id === messageId);
        if (messageIndex === -1) return;

        this.messageQueue.splice(messageIndex, 1);
        this.updateMessageList();
        this.gui.saveAllPreferences();
        
        this.gui.logAction(`Message ${messageId} removed from queue`, 'info');
    }

    moveMessageUp(messageId) {
        const messageIndex = this.messageQueue.findIndex(msg => msg.id === messageId);
        if (messageIndex <= 0) return;

        // Swap with previous message
        [this.messageQueue[messageIndex - 1], this.messageQueue[messageIndex]] = 
        [this.messageQueue[messageIndex], this.messageQueue[messageIndex - 1]];

        this.updateMessageList();
        this.gui.saveAllPreferences();
        
        this.gui.logAction(`Message ${messageId} moved up`, 'info');
    }

    moveMessageDown(messageId) {
        const messageIndex = this.messageQueue.findIndex(msg => msg.id === messageId);
        if (messageIndex === -1 || messageIndex >= this.messageQueue.length - 1) return;

        // Swap with next message
        [this.messageQueue[messageIndex], this.messageQueue[messageIndex + 1]] = 
        [this.messageQueue[messageIndex + 1], this.messageQueue[messageIndex]];

        this.updateMessageList();
        this.gui.saveAllPreferences();
        
        this.gui.logAction(`Message ${messageId} moved down`, 'info');
    }

    updateQueueStatus() {
        // Update queue count display
        const queueCount = document.getElementById('queue-count');
        if (queueCount) {
            queueCount.textContent = this.messageQueue.length;
        }

        // Update queue badge
        const queueBadge = document.querySelector('.queue-badge');
        if (queueBadge) {
            queueBadge.textContent = this.messageQueue.length;
            queueBadge.style.display = this.messageQueue.length > 0 ? 'inline-block' : 'none';
        }

        // Update clear queue button
        const clearQueueBtn = document.getElementById('clear-queue-header-btn');
        if (clearQueueBtn) {
            clearQueueBtn.disabled = this.messageQueue.length === 0;
        }
    }

    // Get next message for injection
    getNextMessage() {
        return this.messageQueue.find(msg => msg.status === 'queued');
    }

    // Update message status
    updateMessageStatus(messageId, status, progress = null) {
        const message = this.messageQueue.find(msg => msg.id === messageId);
        if (!message) return;

        message.status = status;
        if (progress) {
            message.progress = { ...message.progress, ...progress };
        }

        this.updateMessageList();
    }

    // Get message by ID
    getMessage(messageId) {
        return this.messageQueue.find(msg => msg.id === messageId);
    }

    // Get all messages
    getAllMessages() {
        return [...this.messageQueue];
    }

    // Get queued message count
    getQueuedCount() {
        return this.messageQueue.filter(msg => msg.status === 'queued').length;
    }

    // Cancel edit mode
    cancelEdit() {
        if (this.editingMessageId) {
            const messageItem = document.querySelector(`[data-message-id="${this.editingMessageId}"]`);
            if (messageItem) {
                messageItem.classList.remove('editing');
            }

            this.editingMessageId = null;
            this.originalEditContent = null;

            const messageInput = document.getElementById('message-input');
            if (messageInput) {
                messageInput.value = '';
                this.gui.autoResizeMessageInput(messageInput);
            }

            this.gui.logAction('Message editing cancelled', 'info');
        }
    }

    // Handle message input submission
    handleMessageUpdate() {
        const messageInput = document.getElementById('message-input');
        if (!messageInput) return;

        const content = messageInput.value.trim();
        
        if (this.editingMessageId) {
            // Update existing message
            if (content === '') {
                this.cancelEdit();
            } else {
                this.updateMessage(this.editingMessageId, content);
                this.cancelEdit();
            }
        } else {
            // Add new message
            if (content !== '') {
                this.addMessage(content);
            }
        }
    }

    // Set attached files for next message
    setAttachedFiles(files) {
        this.attachedFiles = files;
    }

    // Add image previews
    addImagePreviews(imageFiles) {
        if (imageFiles.length > 0) {
            for (const file of imageFiles) {
                const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const reader = new FileReader();
                
                reader.onload = (e) => {
                    const imageData = {
                        id: imageId,
                        file: file,
                        data: e.target.result,
                        name: file.name,
                        size: file.size
                    };
                    
                    this.imagePreviews.push(imageData);
                    this.showImagePreview(imageData);
                };
                
                reader.readAsDataURL(file);
            }
        }
    }

    showImagePreview(imageData) {
        let previewContainer = document.getElementById('image-previews');
        if (!previewContainer) {
            previewContainer = document.createElement('div');
            previewContainer.id = 'image-previews';
            previewContainer.className = 'image-previews';
            
            const messageInputContainer = document.querySelector('.message-input-container');
            if (messageInputContainer) {
                messageInputContainer.appendChild(previewContainer);
            }
        }
        
        const previewItem = document.createElement('div');
        previewItem.className = 'image-preview-item';
        previewItem.setAttribute('data-image-id', imageData.id);
        
        previewItem.innerHTML = `
            <img src="${imageData.data}" alt="${imageData.name}" class="preview-image">
            <div class="preview-info">
                <span class="preview-name">${imageData.name}</span>
                <span class="preview-size">${this.formatFileSize(imageData.size)}</span>
            </div>
            <button class="preview-remove" onclick="gui.messageQueue.removeImagePreview('${imageData.id}')">
                <i data-lucide="x"></i>
            </button>
        `;
        
        previewContainer.appendChild(previewItem);
        
        // Re-initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
        
        // Add click handler for full-size preview
        const img = previewItem.querySelector('.preview-image');
        img.addEventListener('click', () => {
            this.showFullImagePreview(imageData);
        });
    }

    showFullImagePreview(imageData) {
        const modal = document.createElement('div');
        modal.className = 'image-modal';
        modal.innerHTML = `
            <div class="image-modal-content">
                <img src="${imageData.data}" alt="${imageData.name}" class="modal-image">
                <div class="image-modal-info">
                    <h3>${imageData.name}</h3>
                    <p>Size: ${this.formatFileSize(imageData.size)}</p>
                </div>
                <button class="image-modal-close">&times;</button>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // Close handlers
        const closeBtn = modal.querySelector('.image-modal-close');
        closeBtn.addEventListener('click', () => modal.remove());
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
        
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                modal.remove();
            }
        }, { once: true });
    }

    removeImagePreview(imageId) {
        // Remove from previews array
        const previewIndex = this.imagePreviews.findIndex(img => img.id === imageId);
        if (previewIndex !== -1) {
            this.imagePreviews.splice(previewIndex, 1);
        }
        
        // Remove from DOM
        const previewItem = document.querySelector(`[data-image-id="${imageId}"]`);
        if (previewItem) {
            previewItem.remove();
        }
        
        // Remove from attached files if exists
        if (this.attachedFiles) {
            const attachedIndex = this.attachedFiles.findIndex(file => file.name === 
                this.imagePreviews.find(img => img.id === imageId)?.name);
            if (attachedIndex !== -1) {
                this.attachedFiles.splice(attachedIndex, 1);
            }
        }
        
        // Hide container if no previews left
        if (this.imagePreviews.length === 0) {
            this.clearImagePreviews();
        }
    }

    clearImagePreviews() {
        this.imagePreviews = [];
        this.attachedFiles = null;
        
        const previewContainer = document.getElementById('image-previews');
        if (previewContainer) {
            previewContainer.remove();
        }
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Load queue from preferences
    loadQueueFromPreferences() {
        if (this.gui.preferences.messageQueue && Array.isArray(this.gui.preferences.messageQueue)) {
            this.messageQueue = this.gui.preferences.messageQueue.map(msg => ({
                ...msg,
                status: 'queued', // Reset status on load
                progress: {
                    currentIndex: 0,
                    totalCharacters: msg.content ? msg.content.length : 0,
                    isTyping: false
                }
            }));
            
            // Update counter to avoid ID conflicts
            const maxId = this.messageQueue.reduce((max, msg) => {
                const idNum = parseInt(msg.id.split('_')[1]);
                return isNaN(idNum) ? max : Math.max(max, idNum);
            }, 0);
            this.messageIdCounter = maxId + 1;
            
            this.updateMessageList();
        }
    }
}

module.exports = MessageQueue;