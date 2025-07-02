/**
 * Message Queue Module
 * Handles message queue management, scheduling, and injection
 */

class MessageQueue {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        this.terminals = terminalGUI.terminals;
        
        // Message queue state
        this.messageQueue = [];
        this.messageIdCounter = 1;
        this.messageSequenceCounter = 0;
        this.injectionTimer = null;
        this.schedulingInProgress = false;
        this.injectionCount = 0;
        this.currentlyInjectingMessages = new Set();
        this.currentlyInjectingTerminals = new Set();
        this.currentlyInjectingMessageId = null;
        this.isInjecting = false;
        
        // Message editing state
        this.editingMessageId = null;
        this.originalEditContent = null;
        
        // Message history
        this.messageHistory = [];
        
        // Injection timing
        this.injectionInProgress = false;
        this.injectionPaused = false;
        this.pausedMessageContent = null;
        this.pausedMessageIndex = 0;
        this.currentTypeInterval = null;
    }

    // Message ID generation and validation
    generateMessageId() {
        return this.messageIdCounter++;
    }

    validateMessageIds() {
        const ids = this.messageQueue.map(m => m.id);
        const uniqueIds = new Set(ids);
        if (ids.length !== uniqueIds.size) {
            console.error('Duplicate message IDs detected:', ids);
            console.error('Message queue:', this.messageQueue);
        }
        return ids.length === uniqueIds.size;
    }

    // Message content validation
    isValidMessageContent(content) {
        return content && content.trim().length > 0;
    }

    // Add message to queue
    addMessageToQueue() {
        const input = document.getElementById('message-input');
        const content = input.value.trim();
        
        if (this.isValidMessageContent(content)) {
            const now = Date.now();
            const message = {
                id: this.generateMessageId(),
                content: content,
                processedContent: content,
                executeAt: now,
                createdAt: now,
                timestamp: now,
                terminalId: this.gui.activeTerminalId,
                sequence: ++this.messageSequenceCounter
            };
            
            this.messageQueue.push(message);
            this.gui.updateTrayBadge();
            this.saveMessageQueue();
            this.updateMessageList();
            this.gui.updateStatusDisplay();
            input.value = '';
            
            // Reset input height after clearing
            this.gui.autoResizeMessageInput(input);
            
            const terminalData = this.terminals.get(message.terminalId);
            const terminalName = terminalData ? terminalData.name : `Terminal ${message.terminalId}`;
            this.gui.logAction(`Added message to queue for ${terminalName}: "${content}"`, 'info');
        }
    }

    // Clear entire queue
    clearQueue() {
        if (this.messageQueue.length > 0) {
            const count = this.messageQueue.length;
            this.messageQueue = [];
            this.gui.updateTrayBadge();
            this.saveMessageQueue();
            this.updateMessageList();
            this.gui.updateStatusDisplay();
            
            this.gui.logAction(`Cleared message queue (${count} messages removed)`, 'warning');
        }
    }

    // Delete specific message
    deleteMessage(messageId) {
        const index = this.messageQueue.findIndex(m => m.id === messageId);
        if (index !== -1) {
            const message = this.messageQueue[index];
            this.messageQueue.splice(index, 1);
            this.saveMessageQueue();
            this.updateMessageList();
            this.gui.updateStatusDisplay();
            this.gui.updateTrayBadge();
            
            this.gui.logAction(`Deleted message: "${message.content}"`, 'warning');
        }
    }

    // Update message content
    updateMessage(messageId, newContent) {
        const message = this.messageQueue.find(m => m.id === messageId);
        if (message && this.isValidMessageContent(newContent)) {
            const oldContent = message.content;
            message.content = newContent;
            message.processedContent = newContent;
            
            this.saveMessageQueue();
            this.updateMessageList();
            
            this.gui.logAction(`Updated message: "${oldContent}" → "${newContent}"`, 'info');
        }
    }

    // Message editing functions
    editMessage(messageId) {
        this.cancelEdit(); // Cancel any existing edit
        
        const message = this.messageQueue.find(m => m.id === messageId);
        if (!message) return;
        
        this.editingMessageId = messageId;
        this.originalEditContent = message.content;
        
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            const contentElement = messageElement.querySelector('.message-content');
            if (contentElement) {
                contentElement.contentEditable = true;
                contentElement.focus();
                contentElement.classList.add('editing');
                
                // Select all text
                const range = document.createRange();
                range.selectNodeContents(contentElement);
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
            }
        }
    }

    cancelEdit() {
        if (this.editingMessageId) {
            const messageElement = document.querySelector(`[data-message-id="${this.editingMessageId}"]`);
            if (messageElement) {
                const contentElement = messageElement.querySelector('.message-content');
                if (contentElement) {
                    contentElement.contentEditable = false;
                    contentElement.classList.remove('editing');
                    contentElement.textContent = this.originalEditContent;
                }
            }
            
            this.editingMessageId = null;
            this.originalEditContent = null;
        }
    }

    handleMessageUpdate() {
        if (this.editingMessageId) {
            const messageElement = document.querySelector(`[data-message-id="${this.editingMessageId}"]`);
            const contentElement = messageElement?.querySelector('.message-content');
            const content = contentElement?.textContent?.trim();
            
            if (content && content !== this.originalEditContent) {
                this.updateMessage(this.editingMessageId, content);
                this.cancelEdit();
            } else if (!content && this.editingMessageId) {
                this.deleteMessage(this.editingMessageId);
                this.cancelEdit();
            }
        }
    }

    // Message reordering
    reorderMessage(fromIndex, toIndex) {
        if (fromIndex === toIndex) return;
        
        const message = this.messageQueue.splice(fromIndex, 1)[0];
        this.messageQueue.splice(toIndex, 0, message);
        
        this.saveMessageQueue();
        this.updateMessageList();
        
        this.gui.logAction(`Reordered message: "${message.content}" moved from position ${fromIndex + 1} to ${toIndex + 1}`, 'info');
    }

    // Queue persistence
    async saveMessageQueue() {
        try {
            const { ipcRenderer } = require('electron');
            await ipcRenderer.invoke('db-save-messages', this.messageQueue);
        } catch (error) {
            console.error('Failed to save message queue:', error);
            this.gui.logAction('Failed to save message queue to database', 'error');
        }
    }

    async loadMessageQueue() {
        try {
            const { ipcRenderer } = require('electron');
            const savedMessages = await ipcRenderer.invoke('db-get-messages');
            if (savedMessages && Array.isArray(savedMessages)) {
                this.messageQueue = savedMessages;
                this.updateMessageList();
                this.gui.updateStatusDisplay();
                this.gui.updateTrayBadge();
                
                // Update counters to prevent ID conflicts
                if (this.messageQueue.length > 0) {
                    this.messageIdCounter = Math.max(...this.messageQueue.map(m => m.id || 0)) + 1;
                    this.messageSequenceCounter = Math.max(...this.messageQueue.map(m => m.sequence || 0));
                }
            }
        } catch (error) {
            console.error('Failed to load message queue:', error);
            this.gui.logAction('Failed to load message queue from database', 'error');
        }
    }

    // Message history management
    saveToMessageHistory(message) {
        const historyEntry = {
            id: message.id,
            content: message.content,
            terminalId: message.terminalId,
            injectedAt: Date.now(),
            originalTimestamp: message.timestamp
        };
        
        this.messageHistory.unshift(historyEntry);
        
        // Keep only the last 100 messages in history
        if (this.messageHistory.length > 100) {
            this.messageHistory = this.messageHistory.slice(0, 100);
        }
        
        // Save to preferences
        this.gui.preferences.messageHistory = this.messageHistory;
        this.gui.savePreferences();
    }

    clearMessageHistory() {
        this.messageHistory = [];
        this.gui.preferences.messageHistory = [];
        this.gui.savePreferences();
        this.gui.logAction('Message history cleared', 'info');
    }

    // UI Update functions
    updateMessageList() {
        const messageList = document.getElementById('message-list');
        messageList.innerHTML = '';
        
        // Add drag and drop event listeners
        if (!messageList.hasAttribute('data-drag-listeners-added')) {
            messageList.addEventListener('dragover', (e) => {
                e.preventDefault();
                this.gui.handleDragOver(e);
            });
            messageList.addEventListener('drop', (e) => {
                e.preventDefault();
                this.gui.handleDrop(e);
            });
            messageList.setAttribute('data-drag-listeners-added', 'true');
        }
        
        this.messageQueue.forEach((message, index) => {
            const messageElement = document.createElement('div');
            messageElement.className = 'message-item';
            messageElement.draggable = true;
            messageElement.dataset.messageId = message.id;
            messageElement.dataset.index = index;
            
            if (message.id === this.currentlyInjectingMessageId) {
                messageElement.classList.add('injecting');
            }
            
            // Get terminal info
            const terminalData = this.terminals.get(message.terminalId);
            const terminalColor = terminalData ? terminalData.color : this.gui.terminalColors[0];
            const terminalName = terminalData ? terminalData.name : `Terminal ${message.terminalId}`;
            
            messageElement.innerHTML = `
                <div class="message-header">
                    <div class="message-terminal">
                        <span class="terminal-color-dot" style="background-color: ${terminalColor};"></span>
                        <span class="terminal-name">${terminalName}</span>
                    </div>
                    <div class="message-actions">
                        <button class="icon-btn edit-message-btn" title="Edit message" onclick="event.stopPropagation(); window.terminalGUI.messageQueue.editMessage(${message.id})">
                            <i data-lucide="edit-3"></i>
                        </button>
                        <button class="icon-btn delete-message-btn" title="Delete message" onclick="event.stopPropagation(); window.terminalGUI.messageQueue.deleteMessage(${message.id})">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </div>
                </div>
                <div class="message-content">${this.gui.escapeHtml(message.content)}</div>
                <div class="message-timestamp">${this.gui.formatTimestamp(message.timestamp)}</div>
            `;
            
            // Add drag event listeners
            messageElement.addEventListener('dragstart', (e) => {
                this.gui.handleDragStart(e);
            });
            
            messageList.appendChild(messageElement);
        });
        
        // Initialize Lucide icons for new elements
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    // Message injection and scheduling
    injectMessageAndContinueQueue() {
        this.gui.validateInjectionState('injectMessageAndContinueQueue');
        if (this.messageQueue.length === 0) {
            this.scheduleNextInjection();
            return;
        }
        
        const message = this.messageQueue.shift();
        this.saveMessageQueue();
        this.isInjecting = true;
        this.currentlyInjectingMessageId = message.id;
        this.gui.updateTerminalStatusIndicator();
        this.updateMessageList();
        
        this.gui.logAction(`Sequential injection: "${message.content}"`, 'success');
        
        // Type the message
        this.gui.typeMessage(message.processedContent, () => {
            this.injectionCount++;
            this.saveToMessageHistory(message);
            this.gui.updateStatusDisplay();
            this.updateMessageList();
            
            // Send Enter key with random delay
            const enterDelay = this.gui.getRandomDelay(150, 300);
            setTimeout(() => {
                const { ipcRenderer } = require('electron');
                ipcRenderer.send('terminal-input', { 
                    terminalId: this.gui.activeTerminalId, 
                    data: '\r' 
                });
                
                // Add post-injection delay
                const postInjectionDelay = this.gui.getRandomDelay(500, 800);
                setTimeout(() => {
                    this.isInjecting = false;
                    this.currentlyInjectingMessageId = null;
                    this.gui.updateTerminalStatusIndicator();
                    this.updateMessageList();
                    
                    // Continue with next message if timer is active
                    if (this.gui.timerActive) {
                        setTimeout(() => {
                            this.scheduleNextInjection();
                        }, this.gui.getRandomDelay(200, 500));
                    }
                }, postInjectionDelay);
            }, enterDelay);
        });
    }

    scheduleNextInjection() {
        // Prevent concurrent scheduling calls
        if (this.schedulingInProgress) {
            return;
        }
        this.schedulingInProgress = true;
        
        // Clear any existing timer
        if (this.injectionTimer) {
            clearTimeout(this.injectionTimer);
            this.injectionTimer = null;
        }
        
        // Don't schedule if no messages
        if (this.messageQueue.length === 0) {
            this.schedulingInProgress = false;
            return;
        }
        
        // Reset injection flags
        this.injectionInProgress = false;
        
        // Track busy terminals
        const busyTerminals = new Set(this.currentlyInjectingTerminals);
        
        // Group available messages by terminal
        const messagesByTerminal = new Map();
        const now = Date.now();
        
        this.messageQueue.forEach(message => {
            const terminalId = message.terminalId != null ? message.terminalId : this.gui.activeTerminalId;
            const terminalData = this.terminals.get(terminalId);
            
            // Skip if terminal doesn't exist or is busy
            if (!terminalData || busyTerminals.has(terminalId)) {
                return;
            }

            // Skip if terminal is not stable and ready
            if (!this.gui.isTerminalStableAndReady(terminalId)) {
                return;
            }
            
            // Only consider messages ready to execute
            if (message.executeAt <= now) {
                const existingMessage = messagesByTerminal.get(terminalId);
                if (!existingMessage || 
                    message.executeAt < existingMessage.executeAt ||
                    (message.executeAt === existingMessage.executeAt && 
                     (message.sequence || 0) < (existingMessage.sequence || 0))) {
                    messagesByTerminal.set(terminalId, message);
                }
            }
        });
        
        // Process all available messages simultaneously
        if (messagesByTerminal.size > 0) {
            messagesByTerminal.forEach(message => {
                this.gui.processMessage(message);
            });
        }
        
        // Schedule next check for remaining messages
        const remainingMessages = this.messageQueue.filter(message => {
            const terminalId = message.terminalId != null ? message.terminalId : this.gui.activeTerminalId;
            return !messagesByTerminal.has(terminalId);
        });
        
        if (remainingMessages.length > 0) {
            // Find the next earliest message
            const nextMessage = remainingMessages.reduce((earliest, message) => {
                if (!earliest) return message;
                if (message.executeAt < earliest.executeAt) return message;
                if (message.executeAt === earliest.executeAt && 
                    (message.sequence || 0) < (earliest.sequence || 0)) return message;
                return earliest;
            }, null);
            
            if (nextMessage) {
                const delay = Math.max(100, nextMessage.executeAt - now);
                this.injectionTimer = setTimeout(() => {
                    this.schedulingInProgress = false;
                    this.scheduleNextInjection();
                }, delay);
            }
        }
        
        this.schedulingInProgress = false;
    }

    // Manual injection functions
    injectMessages() {
        if (this.messageQueue.length === 0) {
            this.gui.logAction('No messages in queue to inject', 'warning');
            return;
        }
        
        // Perform safety checks before manual injection
        const activeTerminalData = this.terminals.get(this.gui.activeTerminalId);
        if (!activeTerminalData) {
            this.gui.logAction('No active terminal for injection', 'error');
            return;
        }
        
        this.gui.performSafetyChecks(() => {
            this.injectMessageAndContinueQueue();
        });
    }

    manualInjectNextMessage() {
        if (this.messageQueue.length === 0) {
            this.gui.logAction('No messages in queue to inject', 'warning');
            return;
        }
        
        // Bypass safety checks for manual injection
        this.injectMessageAndContinueQueue();
    }

    // Utility functions for queue management
    getQueueSize() {
        return this.messageQueue.length;
    }

    getNextMessage() {
        return this.messageQueue.length > 0 ? this.messageQueue[0] : null;
    }

    hasMessagesForTerminal(terminalId) {
        return this.messageQueue.some(message => 
            (message.terminalId != null ? message.terminalId : this.gui.activeTerminalId) === terminalId
        );
    }

    getMessagesForTerminal(terminalId) {
        return this.messageQueue.filter(message => 
            (message.terminalId != null ? message.terminalId : this.gui.activeTerminalId) === terminalId
        );
    }

    // Queue statistics
    getQueueStats() {
        const stats = {
            total: this.messageQueue.length,
            byTerminal: new Map(),
            oldestMessage: null,
            newestMessage: null
        };
        
        this.messageQueue.forEach(message => {
            const terminalId = message.terminalId != null ? message.terminalId : this.gui.activeTerminalId;
            stats.byTerminal.set(terminalId, (stats.byTerminal.get(terminalId) || 0) + 1);
            
            if (!stats.oldestMessage || message.createdAt < stats.oldestMessage.createdAt) {
                stats.oldestMessage = message;
            }
            if (!stats.newestMessage || message.createdAt > stats.newestMessage.createdAt) {
                stats.newestMessage = message;
            }
        });
        
        return stats;
    }
}

// Export for use in main TerminalGUI class
window.MessageQueue = MessageQueue;