const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');

class TerminalGUI {
    constructor() {
        this.terminal = null;
        this.fitAddon = null;
        this.messageQueue = [];
        this.injectionTimer = null;
        this.injectionCount = 0;
        this.currentDirectory = process.cwd();
        this.isInjecting = false;
        this.messageIdCounter = 1;
        this.autoContinueEnabled = false;
        this.lastTerminalOutput = '';
        this.autoscrollEnabled = true;
        this.autoscrollDelay = 3000;
        this.autoscrollTimeout = null;
        this.userInteracting = false;
        this.actionLog = [];
        this.injectionBlocked = false;
        this.autoContinueActive = false;
        this.autoContinueRetryCount = 0;
        this.keywordBlockingActive = false;
        this.terminalStatus = '';
        this.currentResetTime = null;
        this.statusUpdateTimeout = null;
        this.preferences = {
            autoscrollEnabled: true,
            autoscrollDelay: 3000,
            autoContinueEnabled: false,
            defaultDuration: 5,
            defaultUnit: 'seconds',
            keywordRules: [
                {
                    id: "claude_credit_example",
                    keyword: "🤖 Generated with",
                    response: "do not credit yourself"
                }
            ]
        };
        this.usageLimitSyncInterval = null;
        this.usageLimitResetTime = null;
        this.autoSyncEnabled = true; // Auto-sync until user manually changes timer
        
        this.initializeTerminal();
        this.setupEventListeners();
        this.initializeLucideIcons();
        this.updateStatusDisplay();
        this.setTerminalStatusDisplay(''); // Initialize with default status
        this.loadAllPreferences();
    }

    initializeLucideIcons() {
        // Initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }

    initializeTerminal() {
        // Create terminal instance
        this.terminal = new Terminal({
            theme: {
                background: '#1e1e1e',
                foreground: '#ffffff',
                cursor: '#ffffff',
                cursorAccent: '#000000',
                selection: '#3d3d3d',
                black: '#000000',
                red: '#ff5f57',
                green: '#28ca42',
                yellow: '#ffbe2e',
                blue: '#007acc',
                magenta: '#af52de',
                cyan: '#5ac8fa',
                white: '#ffffff',
                brightBlack: '#666666',
                brightRed: '#ff6e67',
                brightGreen: '#32d74b',
                brightYellow: '#ffcc02',
                brightBlue: '#007aff',
                brightMagenta: '#bf5af2',
                brightCyan: '#64d8ff',
                brightWhite: '#ffffff'
            },
            fontFamily: 'Monaco, Menlo, Consolas, monospace',
            fontSize: 13,
            lineHeight: 1.2,
            cursorBlink: true,
            cursorStyle: 'block',
            scrollback: 1000,
            tabStopWidth: 4
        });

        // Add addons
        this.fitAddon = new FitAddon();
        this.terminal.loadAddon(this.fitAddon);
        this.terminal.loadAddon(new WebLinksAddon());

        // Open terminal in container
        const terminalContainer = document.getElementById('terminal-container');
        this.terminal.open(terminalContainer);
        
        // Fit terminal to container
        this.fitAddon.fit();
        
        // Ensure terminal starts at bottom on initialization
        setTimeout(() => {
            this.scrollToBottom();
        }, 50);

        // Handle terminal input
        this.terminal.onData((data) => {
            ipcRenderer.send('terminal-input', data);
        });

        // Handle scroll events for autoscroll (needs to be set after terminal is ready)
        setTimeout(() => {
            const terminalViewport = terminalContainer.querySelector('.xterm-viewport');
            if (terminalViewport) {
                terminalViewport.addEventListener('scroll', () => {
                    this.handleScroll();
                });
            }
        }, 100);

        // Handle terminal resize
        this.terminal.onResize(({ cols, rows }) => {
            ipcRenderer.send('terminal-resize', cols, rows);
        });

        // Start terminal process
        ipcRenderer.send('terminal-start');

        // Handle window resize
        window.addEventListener('resize', () => {
            this.fitAddon.fit();
        });
    }

    setupEventListeners() {
        // IPC listeners for terminal data
        ipcRenderer.on('terminal-data', (event, data) => {
            this.terminal.write(data);
            this.detectDirectoryChange(data);
            this.detectAutoContinuePrompt(data);
            this.detectUsageLimit(data);
            this.updateTerminalStatus(); // Call after lastTerminalOutput is updated
            this.handleTerminalOutput();
        });

        ipcRenderer.on('terminal-exit', () => {
            this.terminal.write('\r\n\x1b[31mTerminal process exited\x1b[0m\r\n');
        });

        // UI event listeners
        document.getElementById('send-btn').addEventListener('click', () => {
            this.addMessageToQueue();
        });

        // Directory click handler
        document.getElementById('current-directory').addEventListener('click', () => {
            this.openDirectoryBrowser();
        });

        document.getElementById('clear-queue-header-btn').addEventListener('click', () => {
            this.clearQueue();
        });

        document.getElementById('inject-now-btn').addEventListener('click', () => {
            this.injectMessages();
        });

        // Smart input handling
        const messageInput = document.getElementById('message-input');
        messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    // Shift+Enter: allow new line (default behavior)
                    return;
                } else {
                    // Enter: add to queue
                    e.preventDefault();
                    this.addMessageToQueue();
                }
            }
        });

        // Auto-continue checkbox listener
        document.getElementById('auto-continue').addEventListener('change', (e) => {
            this.autoContinueEnabled = e.target.checked;
            this.preferences.autoContinueEnabled = e.target.checked;
            this.saveAllPreferences();
            if (this.autoContinueEnabled) {
                this.logAction('Auto-continue enabled - will respond to prompts', 'info');
            } else {
                this.logAction('Auto-continue disabled', 'info');
            }
        });

        // Duration and unit change listeners - disable auto-sync when user manually changes
        document.getElementById('duration-input').addEventListener('change', (e) => {
            this.preferences.defaultDuration = parseInt(e.target.value) || 5;
            this.saveAllPreferences();
            // Disable auto-sync when user manually changes the value
            this.disableAutoSync();
        });

        document.getElementById('duration-unit').addEventListener('change', (e) => {
            this.preferences.defaultUnit = e.target.value;
            this.saveAllPreferences();
            // Disable auto-sync when user manually changes the unit
            this.disableAutoSync();
        });

        // Action log clear button
        document.getElementById('clear-log-btn').addEventListener('click', () => {
            this.clearActionLog();
        });

        // Settings modal listeners
        document.getElementById('settings-btn').addEventListener('click', () => {
            this.openSettingsModal();
        });


        document.getElementById('settings-close').addEventListener('click', () => {
            this.closeSettingsModal();
        });

        document.getElementById('settings-modal').addEventListener('click', (e) => {
            if (e.target.id === 'settings-modal') {
                this.closeSettingsModal();
            }
        });

        // Settings controls
        document.getElementById('autoscroll-enabled').addEventListener('change', (e) => {
            this.autoscrollEnabled = e.target.checked;
            this.preferences.autoscrollEnabled = e.target.checked;
            this.saveAllPreferences();
        });

        document.getElementById('autoscroll-delay').addEventListener('change', (e) => {
            this.autoscrollDelay = parseInt(e.target.value);
            this.preferences.autoscrollDelay = parseInt(e.target.value);
            this.saveAllPreferences();
        });

        // Keyword blocking controls
        document.getElementById('add-keyword-btn').addEventListener('click', () => {
            this.addKeywordRule();
        });

        document.getElementById('new-keyword').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.addKeywordRule();
            }
        });

        document.getElementById('new-response').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.addKeywordRule();
            }
        });

    }

    addMessageToQueue() {
        const messageInput = document.getElementById('message-input');
        const message = messageInput.value.trim();
        const duration = parseInt(document.getElementById('duration-input').value) || this.preferences.defaultDuration;
        const unit = document.getElementById('duration-unit').value || this.preferences.defaultUnit;
        
        if (message) {
            let delayMs;
            switch (unit) {
                case 'seconds': delayMs = duration * 1000; break;
                case 'minutes': delayMs = duration * 60 * 1000; break;
                case 'hours': delayMs = duration * 60 * 60 * 1000; break;
                default: delayMs = duration * 1000;
            }
            
            const executeAt = new Date(Date.now() + delayMs);
            
            // Convert newlines to escape sequence for injection
            const processedMessage = message.replace(/\n/g, '\\\n');
            
            this.messageQueue.push({
                id: this.messageIdCounter++,
                content: message,
                processedContent: processedMessage,
                executeAt: executeAt,
                duration: duration,
                unit: unit,
                timestamp: new Date().toISOString()
            });
            
            messageInput.value = '';
            this.sortQueueByExecutionTime();
            this.updateMessageList();
            this.updateStatusDisplay();
            this.scheduleNextInjection();
            
            // Log the action
            this.logAction(`Added message to queue: "${message}" (${duration} ${unit})`, 'info');
        }
    }

    sortQueueByExecutionTime() {
        this.messageQueue.sort((a, b) => a.executeAt.getTime() - b.executeAt.getTime());
    }

    clearQueue() {
        const clearedCount = this.messageQueue.length;
        this.messageQueue = [];
        this.updateMessageList();
        this.updateStatusDisplay();
        
        if (this.injectionTimer) {
            clearTimeout(this.injectionTimer);
            this.injectionTimer = null;
        }
        
        // Log to action log instead of terminal
        this.logAction(`Cleared ${clearedCount} messages from queue`, 'warning');
    }

    updateMessageList() {
        const messageList = document.getElementById('message-list');
        messageList.innerHTML = '';
        
        this.messageQueue.forEach((message, index) => {
            const messageElement = document.createElement('div');
            messageElement.className = 'message-item';
            
            const content = document.createElement('div');
            content.className = 'message-content';
            content.textContent = message.content;
            
            const meta = document.createElement('div');
            meta.className = 'message-meta';
            
            const timeUntil = this.getTimeUntilExecution(message.executeAt);
            const executionTime = document.createElement('span');
            executionTime.className = 'execution-time';
            executionTime.textContent = timeUntil;
            
            meta.appendChild(executionTime);
            content.appendChild(meta);
            
            const actions = document.createElement('div');
            actions.className = 'message-actions';
            
            // Delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'message-delete-btn';
            deleteBtn.innerHTML = '<i data-lucide="trash-2"></i>';
            deleteBtn.title = 'Delete message';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.deleteMessage(message.id);
            });
            
            // Three dots menu button
            const menuBtn = document.createElement('button');
            menuBtn.className = 'message-menu-btn';
            menuBtn.innerHTML = '<i data-lucide="more-horizontal"></i>';
            menuBtn.title = 'Adjust timing';
            menuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleMessageDropdown(e, message, menuBtn);
            });
            
            actions.appendChild(deleteBtn);
            actions.appendChild(menuBtn);
            messageElement.appendChild(content);
            messageElement.appendChild(actions);
            messageList.appendChild(messageElement);
        });
        
        // Reinitialize icons for new elements
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }

    getTimeUntilExecution(executeAt) {
        const now = new Date();
        const diff = executeAt.getTime() - now.getTime();
        
        if (diff <= 0) return 'Ready';
        
        const seconds = Math.floor(diff / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    deleteMessage(messageId) {
        const index = this.messageQueue.findIndex(m => m.id === messageId);
        if (index !== -1) {
            const deletedMessage = this.messageQueue[index];
            this.messageQueue.splice(index, 1);
            this.updateMessageList();
            this.updateStatusDisplay();
            this.scheduleNextInjection();
            
            // Log the action instead of writing to terminal
            this.logAction(`Deleted message: "${deletedMessage.content}"`, 'warning');
        }
    }

    toggleMessageDropdown(event, message, button) {
        // Close any existing dropdowns
        this.closeAllDropdowns();
        
        // Create dropdown
        const dropdown = document.createElement('div');
        dropdown.className = 'message-dropdown';
        dropdown.innerHTML = `
            <div class="dropdown-content">
                <div class="dropdown-header">Adjust Timing</div>
                <div class="timing-form">
                    <div class="form-row">
                        <label>Duration:</label>
                        <input type="number" id="dropdown-duration" value="${message.duration}" min="1" class="dropdown-input">
                    </div>
                    <div class="form-row">
                        <label>Unit:</label>
                        <select id="dropdown-unit" class="dropdown-select">
                            <option value="seconds" ${message.unit === 'seconds' ? 'selected' : ''}>seconds</option>
                            <option value="minutes" ${message.unit === 'minutes' ? 'selected' : ''}>minutes</option>
                            <option value="hours" ${message.unit === 'hours' ? 'selected' : ''}>hours</option>
                        </select>
                    </div>
                    <div class="form-actions">
                        <button class="dropdown-btn save-btn" id="save-timing">Save</button>
                        <button class="dropdown-btn cancel-btn" id="cancel-timing">Cancel</button>
                    </div>
                </div>
            </div>
        `;
        
        // Position dropdown to bottom-left of button
        const rect = button.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = (rect.left - 200 + rect.width) + 'px'; // Position to the left of button
        dropdown.style.top = (rect.bottom + 5) + 'px';
        dropdown.style.zIndex = '1000';
        
        document.body.appendChild(dropdown);
        
        // Adjust position if dropdown goes off-screen
        setTimeout(() => {
            const dropdownRect = dropdown.getBoundingClientRect();
            if (dropdownRect.left < 10) {
                dropdown.style.left = '10px';
            }
        }, 0);
        
        // Add event listeners
        dropdown.querySelector('#save-timing').addEventListener('click', () => {
            const newDuration = parseInt(dropdown.querySelector('#dropdown-duration').value);
            const newUnit = dropdown.querySelector('#dropdown-unit').value;
            
            if (newDuration && newDuration > 0) {
                this.updateMessageTiming(message.id, newDuration, newUnit);
            }
            this.closeAllDropdowns();
        });
        
        dropdown.querySelector('#cancel-timing').addEventListener('click', () => {
            this.closeAllDropdowns();
        });
        
        // Close dropdown when clicking outside
        setTimeout(() => {
            document.addEventListener('click', this.closeDropdownOnOutsideClick.bind(this), { once: true });
        }, 10);
    }
    
    closeAllDropdowns() {
        const dropdowns = document.querySelectorAll('.message-dropdown');
        dropdowns.forEach(dropdown => dropdown.remove());
    }
    
    closeDropdownOnOutsideClick(event) {
        if (!event.target.closest('.message-dropdown') && !event.target.closest('.message-menu-btn')) {
            this.closeAllDropdowns();
        }
    }

    updateMessageTiming(messageId, duration, unit) {
        const message = this.messageQueue.find(m => m.id === messageId);
        if (message) {
            let delayMs;
            switch (unit) {
                case 'seconds': delayMs = duration * 1000; break;
                case 'minutes': delayMs = duration * 60 * 1000; break;
                case 'hours': delayMs = duration * 60 * 60 * 1000; break;
                default: return;
            }
            
            const oldTiming = `${message.duration} ${message.unit}`;
            message.duration = duration;
            message.unit = unit;
            message.executeAt = new Date(Date.now() + delayMs);
            
            this.sortQueueByExecutionTime();
            this.updateMessageList();
            this.scheduleNextInjection();
            
            // Log the timing change
            this.logAction(`Updated timing for "${message.content}": ${oldTiming} → ${duration} ${unit}`, 'info');
        }
    }

    scheduleNextInjection() {
        if (this.injectionTimer) {
            clearTimeout(this.injectionTimer);
            this.injectionTimer = null;
        }

        if (this.messageQueue.length > 0) {
            // Don't schedule if injection is blocked
            if (this.injectionBlocked) {
                this.logAction('Injection scheduling paused - waiting for blocking conditions to clear', 'warning');
                return;
            }
            
            const nextMessage = this.messageQueue[0];
            const now = new Date();
            const delay = nextMessage.executeAt.getTime() - now.getTime();
            
            if (delay > 0) {
                this.injectionTimer = setTimeout(() => {
                    this.injectNextMessage();
                }, delay);
            } else {
                // Message is ready to be injected
                setTimeout(() => this.injectNextMessage(), 100);
            }
        }
    }

    injectNextMessage() {
        if (this.messageQueue.length === 0 || this.isInjecting) return;
        
        // Check current terminal state for blocking conditions before injecting
        const hasEscToInterrupt = this.lastTerminalOutput.includes("esc to interrupt");
        const hasClaudePrompt = this.lastTerminalOutput.includes("No, and tell Claude what to do differently");
        const keywordBlockResult = this.checkForKeywordBlocking();
        
        if (hasEscToInterrupt || hasClaudePrompt || keywordBlockResult.blocked) {
            let reason;
            if (hasEscToInterrupt) {
                reason = 'esc to interrupt detected';
            } else if (hasClaudePrompt) {
                reason = 'Claude prompt detected';
            } else if (keywordBlockResult.blocked) {
                reason = `keyword "${keywordBlockResult.keyword}" detected`;
            }
            this.logAction(`Message injection blocked - ${reason}`, 'warning');
            
            // Update blocking status
            this.injectionBlocked = true;
            
            // Reschedule for later
            setTimeout(() => {
                this.scheduleNextInjection();
            }, 2000);
            return;
        }
        
        // Clear blocking status if no blocking conditions found
        this.injectionBlocked = false;
        
        const message = this.messageQueue.shift();
        this.isInjecting = true;
        this.setTerminalStatusDisplay('injecting');
        
        console.log(`Injecting message: ${message.content}`);
        
        // Log to action log instead of terminal
        this.logAction(`Injecting: "${message.content}"`, 'success');
        
        // Type the processed message (with newlines converted)
        this.typeMessage(message.processedContent, () => {
            this.injectionCount++;
            this.updateStatusDisplay();
            this.updateMessageList();
            
            // Log successful injection
            this.logAction(`Successfully injected: "${message.content}"`, 'success');
            
            // Send Enter key
            setTimeout(() => {
                ipcRenderer.send('terminal-input', '\r');
                this.isInjecting = false;
                this.setTerminalStatusDisplay('');
                
                // If auto-continue is enabled and there are more messages, continue
                const autoContinue = document.getElementById('auto-continue').checked;
                if (autoContinue && this.messageQueue.length > 0) {
                    setTimeout(() => this.scheduleNextInjection(), 1000);
                } else {
                    this.scheduleNextInjection();
                }
            }, 200);
        });
    }

    injectMessages() {
        if (this.messageQueue.length === 0) return;
        
        // Inject all ready messages immediately
        const now = new Date();
        const readyMessages = this.messageQueue.filter(msg => msg.executeAt.getTime() <= now.getTime());
        
        if (readyMessages.length === 0) {
            this.logAction('No messages ready for injection', 'warning');
            return;
        }
        
        console.log(`Force injecting ${readyMessages.length} ready messages...`);
        
        // Log to action log instead of terminal
        this.logAction(`Force injecting ${readyMessages.length} ready messages`, 'info');
        
        // Remove ready messages from queue and process them
        this.messageQueue = this.messageQueue.filter(msg => !readyMessages.includes(msg));
        this.updateMessageList();
        
        this.processMessageBatch(readyMessages);
    }
    
    processMessageBatch(messages) {
        if (messages.length === 0 || this.isInjecting) return;
        
        this.isInjecting = true;
        this.setTerminalStatusDisplay('injecting');
        let index = 0;
        
        const processNext = () => {
            if (index < messages.length) {
                const message = messages[index];
                console.log(`Processing batch message: ${message.content}`);
                this.logAction(`Processing batch message: "${message.content}"`, 'info');
                
                this.typeMessage(message.processedContent, () => {
                    this.injectionCount++;
                    this.updateStatusDisplay();
                    
                    setTimeout(() => {
                        ipcRenderer.send('terminal-input', '\r');
                        index++;
                        
                        if (index < messages.length) {
                            setTimeout(processNext, 1000);
                        } else {
                            this.isInjecting = false;
                            this.setTerminalStatusDisplay('');
                            this.logAction('Batch injection completed successfully', 'success');
                            this.scheduleNextInjection(); // Schedule any remaining messages
                        }
                    }, 200);
                });
            }
        };
        
        processNext();
    }

    typeMessage(message, callback) {
        let index = 0;
        const typeInterval = setInterval(() => {
            if (index < message.length) {
                ipcRenderer.send('terminal-input', message[index]);
                index++;
            } else {
                clearInterval(typeInterval);
                if (callback) callback();
            }
        }, 50); // 50ms between characters for realistic typing speed
    }

    detectAutoContinuePrompt(data) {
        // Store recent terminal output for analysis
        this.lastTerminalOutput += data;
        
        // Keep only recent output (last 4000 characters to ensure we capture full Claude prompts)
        if (this.lastTerminalOutput.length > 4000) {
            this.lastTerminalOutput = this.lastTerminalOutput.slice(-4000);
        }
        
        // Check for blocking conditions for message injection
        const hasEscToInterrupt = this.lastTerminalOutput.includes("esc to interrupt");
        const hasClaudePrompt = this.lastTerminalOutput.includes("No, and tell Claude what to do differently");
        
        // Handle keyword blocking specifically for Claude prompts (only if auto-continue is enabled)
        if (hasClaudePrompt && this.autoContinueEnabled) {
            const keywordBlockResult = this.checkForKeywordBlocking();
            if (keywordBlockResult.blocked && !this.keywordBlockingActive) {
                this.keywordBlockingActive = true;
                this.logAction(`Keyword "${keywordBlockResult.keyword}" detected in Claude prompt - executing escape sequence`, 'warning');
                
                // Send Esc key to interrupt
                ipcRenderer.send('terminal-input', '\x1b');
                
                // Wait and inject custom response if provided
                if (keywordBlockResult.response) {
                    setTimeout(() => {
                        this.logAction(`Injecting custom response: "${keywordBlockResult.response}"`, 'info');
                        this.typeMessage(keywordBlockResult.response, () => {
                            setTimeout(() => {
                                ipcRenderer.send('terminal-input', '\r');
                                // Reset keyword blocking flag
                                setTimeout(() => {
                                    this.keywordBlockingActive = false;
                                }, 1000);
                            }, 200);
                        });
                    }, 800);
                } else {
                    // Just Esc without response
                    setTimeout(() => {
                        this.keywordBlockingActive = false;
                    }, 1000);
                }
                return; // Exit early, don't process auto-continue
            }
        }
        
        // Reset keyword blocking flag if Claude prompt is no longer present
        if (!hasClaudePrompt && this.keywordBlockingActive) {
            this.keywordBlockingActive = false;
        }
        
        // Check for custom keyword blocking for injection blocking
        const keywordBlockResult = this.checkForKeywordBlocking();
        
        // Update injection blocking status
        const previouslyBlocked = this.injectionBlocked;
        this.injectionBlocked = hasEscToInterrupt || keywordBlockResult.blocked;
        
        // Log when blocking status changes
        if (previouslyBlocked && !this.injectionBlocked) {
            this.logAction('Message injection unblocked - conditions cleared', 'success');
            // Resume injection scheduling if we have queued messages
            if (this.messageQueue.length > 0) {
                this.scheduleNextInjection();
            }
        } else if (!previouslyBlocked && this.injectionBlocked) {
            let reason = hasEscToInterrupt ? 'esc to interrupt detected' : `keyword "${keywordBlockResult.keyword}" detected`;
            this.logAction(`Message injection blocked - ${reason}`, 'warning');
            // Cancel any pending injection
            if (this.injectionTimer) {
                clearTimeout(this.injectionTimer);
                this.injectionTimer = null;
            }
        }
        
        // Auto-continue logic (skip if keyword blocking just activated)
        if (!this.autoContinueEnabled || this.isInjecting || this.keywordBlockingActive) return;
        
        // Check for prompts that should trigger auto-continue
        const hasGeneralPrompt = /Do you want to proceed\?/i.test(this.lastTerminalOutput);
        
        // Auto-continue for Claude prompt or general prompts
        if (hasClaudePrompt || hasGeneralPrompt) {
            const promptType = hasClaudePrompt ? 'Claude prompt' : 'general prompt';
            
            // If auto-continue is not already active for this prompt, start it
            if (!this.autoContinueActive) {
                console.log(`Auto-continue: ${promptType} detected! Starting persistent auto-continue.`);
                this.logAction(`Auto-continue detected ${promptType} - starting persistent checking`, 'info');
                this.autoContinueActive = true;
                this.autoContinueRetryCount = 0;
                this.performAutoContinue(promptType);
            }
        } else if (this.autoContinueActive) {
            // If we were auto-continuing but no longer see prompts, stop
            this.logAction(`Auto-continue completed - prompt cleared after ${this.autoContinueRetryCount + 1} attempts`, 'success');
            this.autoContinueActive = false;
            this.autoContinueRetryCount = 0;
        }
    }

    performAutoContinue(promptType) {
        if (!this.autoContinueActive || !this.autoContinueEnabled) return;
        
        this.autoContinueRetryCount++;
        this.logAction(`Auto-continue attempt #${this.autoContinueRetryCount} for ${promptType}`, 'info');
        
        // Send Enter key
        ipcRenderer.send('terminal-input', '\r');
        
        // Wait for terminal to process, then check if we need to continue
        setTimeout(() => {
            if (this.autoContinueActive) {
                // Check if prompt text is still present in recent output
                const hasClaudePrompt = this.lastTerminalOutput.includes("No, and tell Claude what to do differently");
                const hasGeneralPrompt = /Do you want to proceed\?/i.test(this.lastTerminalOutput);
                
                if (hasClaudePrompt || hasGeneralPrompt) {
                    // Prompt still there, continue if we haven't exceeded max attempts
                    if (this.autoContinueRetryCount < 10) {
                        this.logAction(`Prompt still present, retrying auto-continue`, 'warning');
                        this.performAutoContinue(promptType);
                    } else {
                        this.logAction(`Auto-continue stopped - max attempts (10) reached`, 'error');
                        this.autoContinueActive = false;
                        this.autoContinueRetryCount = 0;
                    }
                } else {
                    // Prompt is gone, success!
                    this.logAction(`Auto-continue successful after ${this.autoContinueRetryCount} attempts`, 'success');
                    this.autoContinueActive = false;
                    this.autoContinueRetryCount = 0;
                    // Clear the stored output
                    this.lastTerminalOutput = '';
                }
            }
        }, 1000); // Wait 1 second for terminal to process
    }

    detectDirectoryChange(data) {
        // Enhanced directory detection from terminal output
        const lines = data.split('\n');
        let detectedDir = null;
        
        // Process lines to find directory information
        for (const line of lines) {
            // Look for common directory patterns in terminal output
            const promptMatch = line.match(/.*[➜$#]\s+([^\s]+)/);
            const pwdMatch = line.match(/^([\/~].*?)(?:\s|$)/);
            
            if (promptMatch && promptMatch[1] && promptMatch[1].length > 1) {
                detectedDir = promptMatch[1];
                break; // Use first match found
            } else if (pwdMatch && pwdMatch[1]) {
                detectedDir = pwdMatch[1];
                break; // Use first match found
            }
        }
        
        // Only update if we found a directory and it's different from current
        if (detectedDir && detectedDir !== this.currentDirectory && detectedDir !== '~') {
            // Expand ~ to home directory if needed
            if (detectedDir.startsWith('~/')) {
                detectedDir = detectedDir.replace('~', process.env.HOME || '/Users/' + process.env.USER);
            }
            
            // Only update if the expanded directory is still different
            if (detectedDir !== this.currentDirectory) {
                this.currentDirectory = detectedDir;
                this.updateStatusDisplay();
                this.logAction(`Directory changed to: ${detectedDir}`, 'info');
            }
        }
    }

    detectUsageLimit(data) {
        // Check for usage limit message and parse the reset time
        const usageLimitMatch = data.match(/Approaching usage limit · resets at (\d{1,2})(am|pm)/i);
        if (usageLimitMatch) {
            const resetHour = parseInt(usageLimitMatch[1]);
            const ampm = usageLimitMatch[2].toLowerCase();
            const resetTimeString = `${resetHour}${ampm}`;
            
            // Check if we've already shown modal for this specific reset time
            const lastShownResetTime = localStorage.getItem('usageLimitModalLastResetTime');
            
            if (lastShownResetTime !== resetTimeString) {
                this.showUsageLimitModal(resetHour, ampm);
                localStorage.setItem('usageLimitModalLastResetTime', resetTimeString);
            }
        }
    }

    showUsageLimitModal(resetHour, ampm) {
        const modal = document.getElementById('usage-limit-modal');
        const progressBar = modal.querySelector('.usage-limit-progress-bar');
        const resetTimeSpan = document.getElementById('reset-time');
        const countdownSpan = document.getElementById('usage-countdown');
        const yesBtn = document.getElementById('usage-limit-yes');
        const noBtn = document.getElementById('usage-limit-no');
        
        // Calculate time until the parsed reset time
        const now = new Date();
        const resetTime = new Date();
        
        // Convert 12-hour format to 24-hour format
        let hour24 = resetHour;
        if (ampm === 'pm' && resetHour !== 12) {
            hour24 = resetHour + 12;
        } else if (ampm === 'am' && resetHour === 12) {
            hour24 = 0;
        }
        
        resetTime.setHours(hour24, 0, 0, 0);
        
        // If the reset time has already passed today, it must be tomorrow
        if (resetTime.getTime() <= now.getTime()) {
            resetTime.setDate(resetTime.getDate() + 1);
        }
        
        const timeDiff = resetTime.getTime() - now.getTime();
        const hours = Math.floor(timeDiff / (1000 * 60 * 60));
        const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
        
        // Store the reset time info for auto-fill
        this.currentResetTime = { resetHour, ampm, hour24, resetTime };
        this.setUsageLimitResetTime(resetTime);
        
        // Update reset time text
        if (hours > 0) {
            resetTimeSpan.textContent = `${hours}h ${minutes}m`;
        } else {
            resetTimeSpan.textContent = `${minutes}m`;
        }
        
        // Show modal and start progress bar animation
        modal.classList.add('show');
        setTimeout(() => {
            progressBar.classList.add('active');
        }, 100);
        
        // Start countdown timer
        let countdown = 10;
        const countdownInterval = setInterval(() => {
            countdown--;
            countdownSpan.textContent = countdown;
            
            if (countdown <= 0) {
                clearInterval(countdownInterval);
                this.handleUsageLimitChoice(true);
            }
        }, 1000);
        
        // Handle button clicks
        const handleChoice = (choice) => {
            clearInterval(countdownInterval);
            this.handleUsageLimitChoice(choice);
        };
        
        yesBtn.onclick = () => handleChoice(true);
        noBtn.onclick = () => handleChoice(false);
        
        // Auto-close after 10 seconds
        setTimeout(() => {
            if (modal.classList.contains('show')) {
                handleChoice(true);
            }
        }, 10000);
    }

    handleUsageLimitChoice(queue) {
        const modal = document.getElementById('usage-limit-modal');
        const progressBar = modal.querySelector('.usage-limit-progress-bar');
        
        // Hide modal
        modal.classList.remove('show');
        progressBar.classList.remove('active');
        
        // Log the choice and auto-fill form if user chose to queue
        if (queue) {
            this.logAction('Usage limit detected - Queue mode enabled until 3am reset', 'info');
            // Auto-fill the Execute in form with calculated time until reset
            this.autoFillExecuteInForm();
        } else {
            this.logAction('Usage limit detected - Continuing normally', 'info');
        }
    }

    autoFillExecuteInForm() {
        // Use the stored reset time from the modal
        if (!this.currentResetTime) {
            this.logAction('No current reset time available for auto-fill', 'warning');
            return;
        }
        
        const now = new Date();
        const timeDiff = this.currentResetTime.resetTime.getTime() - now.getTime();
        const totalMinutes = Math.floor(timeDiff / (1000 * 60));
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        
        // Fill the form based on the calculated time
        const durationInput = document.getElementById('duration-input');
        const unitSelect = document.getElementById('duration-unit');
        
        if (totalMinutes <= 0) {
            // Reset time has passed, set to 1 minute as fallback
            durationInput.value = 1;
            unitSelect.value = 'minutes';
            this.preferences.defaultDuration = 1;
            this.preferences.defaultUnit = 'minutes';
            this.logAction('Reset time has passed, auto-filled Execute in: 1 minute', 'warning');
        } else {
            // Use minutes for all cases to provide better accuracy
            const roundedMinutes = Math.max(1, totalMinutes); // Round total minutes, ensure at least 1 minute
            durationInput.value = roundedMinutes;
            unitSelect.value = 'minutes';
            this.preferences.defaultDuration = roundedMinutes;
            this.preferences.defaultUnit = 'minutes';
            this.logAction(`Auto-filled Execute in: ${roundedMinutes} minutes until ${this.currentResetTime.resetHour}${this.currentResetTime.ampm} reset`, 'info');
        }
        
        // Save preferences
        this.saveAllPreferences();
    }

    updateTerminalStatus() {
        let newStatus = '';
        
        if (this.isInjecting) {
            newStatus = 'injecting';
        } else {
            // Check for status indicators in recent output (case-insensitive)
            const recentOutput = this.lastTerminalOutput.toLowerCase();
            
            if (recentOutput.includes('esc to interrupt')) {
                newStatus = 'running';
            } else if (recentOutput.includes('no, and tell claude what to do differently')) {
                newStatus = 'prompted';
            } else if (recentOutput.includes('processing') || recentOutput.includes('thinking') || recentOutput.includes('working')) {
                newStatus = 'running';
            } else if (recentOutput.includes('$') || recentOutput.includes('➜') || recentOutput.includes('#')) {
                newStatus = ''; // Ready state
            }
        }
        
        // Only update if status actually changed
        if (newStatus !== this.terminalStatus) {
            this.terminalStatus = newStatus;
            this.setTerminalStatusDisplay(newStatus);
        }
    }

    setTerminalStatusDisplay(status) {
        const statusElement = document.getElementById('terminal-status');
        if (!statusElement) return;
        
        // Clear all classes
        statusElement.className = 'terminal-status';
        
        // Set new status
        switch(status) {
            case 'running':
                statusElement.className = 'terminal-status visible running';
                statusElement.textContent = 'Running';
                break;
            case 'prompted':
                statusElement.className = 'terminal-status visible prompted';
                statusElement.textContent = 'Prompted';
                break;
            case 'injecting':
                statusElement.className = 'terminal-status visible injecting';
                statusElement.textContent = 'Injecting';
                break;
            default:
                // Show default status
                statusElement.className = 'terminal-status';
                statusElement.textContent = '...';
        }
    }

    updateStatusDisplay() {
        // Update individual status elements
        const directoryElement = document.getElementById('current-directory');
        const tooltipElement = document.getElementById('directory-tooltip');
        
        // Update both the display text and tooltip
        directoryElement.childNodes[0].textContent = this.currentDirectory;
        tooltipElement.textContent = this.currentDirectory;
        
        document.getElementById('injection-count').textContent = this.injectionCount;
        document.getElementById('queue-count').textContent = this.messageQueue.length;
        
        // Update execution times in message list
        const executionTimeElements = document.querySelectorAll('.execution-time');
        executionTimeElements.forEach((element, index) => {
            if (this.messageQueue[index]) {
                element.textContent = this.getTimeUntilExecution(this.messageQueue[index].executeAt);
            }
        });
    }

    async openDirectoryBrowser() {
        try {
            const result = await ipcRenderer.invoke('show-directory-dialog', this.currentDirectory);
            
            if (!result.canceled && result.filePaths.length > 0) {
                const selectedPath = result.filePaths[0];
                if (selectedPath !== this.currentDirectory) {
                    this.changeDirectory(selectedPath);
                }
            }
        } catch (error) {
            console.error('Error opening directory dialog:', error);
            this.logAction('Directory dialog failed, using prompt fallback', 'warning');
            
            // Fallback to prompt-based directory selection
            this.openDirectoryPrompt();
        }
    }

    openDirectoryPrompt() {
        // Simple directory browser using prompt for now
        const newPath = prompt('Enter directory path or press OK to reset terminal to current directory:', this.currentDirectory);
        
        if (newPath === null) {
            return; // User cancelled
        }
        
        if (newPath.trim() === '' || newPath.trim() === this.currentDirectory) {
            // Reset terminal to current directory
            this.resetTerminalToCurrentDirectory();
        } else if (newPath.trim() !== this.currentDirectory) {
            this.changeDirectory(newPath.trim());
        }
    }

    resetTerminalToCurrentDirectory() {
        // Reset terminal to the current directory
        const cdCommand = `cd "${this.currentDirectory}"`;
        this.logAction(`Resetting terminal to: ${this.currentDirectory}`, 'info');
        
        // Type the command in the terminal
        this.typeMessage(cdCommand, () => {
            // Send Enter key
            setTimeout(() => {
                ipcRenderer.send('terminal-input', '\r');
            }, 200);
        });
    }

    changeDirectory(newPath) {
        // Send cd command to terminal
        const cdCommand = `cd "${newPath}"`;
        this.logAction(`Changing directory to: ${newPath}`, 'info');
        
        // Type the command in the terminal
        this.typeMessage(cdCommand, () => {
            // Send Enter key
            setTimeout(() => {
                ipcRenderer.send('terminal-input', '\r');
                
                // Update current directory after a short delay to allow command to execute
                setTimeout(() => {
                    this.currentDirectory = newPath;
                    this.updateStatusDisplay();
                }, 500);
            }, 200);
        });
    }

    handleTerminalOutput() {
        if (this.autoscrollEnabled && !this.userInteracting) {
            this.scrollToBottom();
        }
    }

    handleScroll() {
        if (!this.autoscrollEnabled) return;

        const viewport = document.querySelector('.xterm-viewport');
        if (!viewport) return;

        const isAtBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 10;
        
        if (!isAtBottom) {
            this.userInteracting = true;
            if (this.autoscrollTimeout) {
                clearTimeout(this.autoscrollTimeout);
            }
            
            this.autoscrollTimeout = setTimeout(() => {
                this.userInteracting = false;
                if (this.autoscrollEnabled) {
                    this.scrollToBottom();
                }
            }, this.autoscrollDelay);
        } else {
            this.userInteracting = false;
            if (this.autoscrollTimeout) {
                clearTimeout(this.autoscrollTimeout);
                this.autoscrollTimeout = null;
            }
        }
    }

    scrollToBottom() {
        const viewport = document.querySelector('.xterm-viewport');
        if (viewport) {
            viewport.scrollTo({
                top: viewport.scrollHeight,
                behavior: 'smooth'
            });
        }
    }

    openSettingsModal() {
        const modal = document.getElementById('settings-modal');
        modal.classList.add('show');
        this.loadAllPreferences();
    }

    closeSettingsModal() {
        const modal = document.getElementById('settings-modal');
        modal.classList.remove('show');
    }

    loadAllPreferences() {
        try {
            const saved = JSON.parse(localStorage.getItem('terminalGUIPreferences') || '{}');
            
            // Merge with defaults
            this.preferences = {
                ...this.preferences,
                ...saved
            };
            
            // Apply to UI and instance variables
            this.autoscrollEnabled = this.preferences.autoscrollEnabled;
            this.autoscrollDelay = this.preferences.autoscrollDelay;
            this.autoContinueEnabled = this.preferences.autoContinueEnabled;
            
            // Update UI elements
            document.getElementById('autoscroll-enabled').checked = this.autoscrollEnabled;
            document.getElementById('autoscroll-delay').value = this.autoscrollDelay;
            document.getElementById('auto-continue').checked = this.autoContinueEnabled;
            document.getElementById('duration-input').value = this.preferences.defaultDuration;
            document.getElementById('duration-unit').value = this.preferences.defaultUnit;
            
            // Update keyword rules display
            this.updateKeywordRulesDisplay();
            
            // Load saved usage limit reset time and start auto-sync if available
            this.loadUsageLimitResetTime();
            
        } catch (error) {
            console.error('Error loading preferences:', error);
        }
    }

    saveAllPreferences() {
        try {
            localStorage.setItem('terminalGUIPreferences', JSON.stringify(this.preferences));
        } catch (error) {
            console.error('Error saving preferences:', error);
        }
    }

    // Legacy method for compatibility
    loadSettings() {
        this.loadAllPreferences();
    }

    saveSettings() {
        this.saveAllPreferences();
    }

    // Action Log Methods
    logAction(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = {
            time: timestamp,
            message: message,
            type: type,
            id: Date.now()
        };
        
        this.actionLog.push(logEntry);
        this.updateActionLogDisplay();
        
        // Keep log size manageable
        if (this.actionLog.length > 100) {
            this.actionLog = this.actionLog.slice(-100);
        }
    }
    
    updateActionLogDisplay() {
        const logContainer = document.getElementById('action-log');
        
        // Clear existing content
        logContainer.innerHTML = '';
        
        // Add all log entries
        this.actionLog.forEach(entry => {
            const logItem = document.createElement('div');
            logItem.className = `log-item log-${entry.type}`;
            
            const timeSpan = document.createElement('span');
            timeSpan.className = 'log-time';
            timeSpan.textContent = `[${entry.time}]`;
            
            const messageSpan = document.createElement('span');
            messageSpan.className = 'log-message';
            messageSpan.textContent = entry.message;
            
            logItem.appendChild(timeSpan);
            logItem.appendChild(messageSpan);
            logContainer.appendChild(logItem);
        });
        
        // Auto-scroll to bottom
        logContainer.scrollTop = logContainer.scrollHeight;
    }
    
    clearActionLog() {
        this.actionLog = [];
        this.updateActionLogDisplay();
        this.logAction('Action log cleared', 'info');
    }

    // Keyword blocking methods
    addKeywordRule() {
        const keywordInput = document.getElementById('new-keyword');
        const responseInput = document.getElementById('new-response');
        
        const keyword = keywordInput.value.trim();
        const response = responseInput.value.trim();
        
        if (!keyword) {
            alert('Please enter a keyword');
            return;
        }
        
        // Check if keyword already exists
        const exists = this.preferences.keywordRules.some(rule => rule.keyword.toLowerCase() === keyword.toLowerCase());
        if (exists) {
            alert('This keyword already exists');
            return;
        }
        
        const rule = {
            id: Date.now().toString(),
            keyword: keyword,
            response: response
        };
        
        this.preferences.keywordRules.push(rule);
        this.saveAllPreferences();
        this.updateKeywordRulesDisplay();
        
        // Clear inputs
        keywordInput.value = '';
        responseInput.value = '';
        
        this.logAction(`Added keyword rule: "${keyword}" -> "${response || 'Esc only'}"`, 'info');
    }
    
    removeKeywordRule(ruleId) {
        const ruleIndex = this.preferences.keywordRules.findIndex(rule => rule.id === ruleId);
        if (ruleIndex !== -1) {
            const removedRule = this.preferences.keywordRules[ruleIndex];
            this.preferences.keywordRules.splice(ruleIndex, 1);
            this.saveAllPreferences();
            this.updateKeywordRulesDisplay();
            this.logAction(`Removed keyword rule: "${removedRule.keyword}"`, 'info');
        }
    }
    
    updateKeywordRulesDisplay() {
        const rulesList = document.getElementById('keyword-rules-list');
        rulesList.innerHTML = '';
        
        this.preferences.keywordRules.forEach(rule => {
            const ruleRow = document.createElement('div');
            ruleRow.className = 'keyword-rule-row';
            
            const keywordDiv = document.createElement('div');
            keywordDiv.className = 'keyword-rule-text';
            keywordDiv.innerHTML = `<span class="keyword-rule-keyword">${rule.keyword}</span>`;
            
            const responseDiv = document.createElement('div');
            responseDiv.className = 'keyword-rule-text keyword-rule-response';
            responseDiv.textContent = rule.response || '(Esc only)';
            
            const actionsDiv = document.createElement('div');
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-keyword-btn';
            removeBtn.textContent = 'Remove';
            removeBtn.onclick = () => this.removeKeywordRule(rule.id);
            actionsDiv.appendChild(removeBtn);
            
            ruleRow.appendChild(keywordDiv);
            ruleRow.appendChild(responseDiv);
            ruleRow.appendChild(actionsDiv);
            
            rulesList.appendChild(ruleRow);
        });
    }
    
    checkForKeywordBlocking() {
        // Only check if we have keyword rules
        if (!this.preferences.keywordRules || this.preferences.keywordRules.length === 0) {
            return { blocked: false };
        }
        
        // Find the ╭ character which marks the start of the current Claude prompt area
        const claudePromptStart = this.lastTerminalOutput.lastIndexOf("╭");
        if (claudePromptStart === -1) {
            return { blocked: false };
        }
        
        // Extract only the text from ╭ to the end (current prompt area)
        const currentPromptArea = this.lastTerminalOutput.substring(claudePromptStart);
        
        // Only proceed if this area contains the Claude prompt
        const hasClaudePrompt = currentPromptArea.includes("No, and tell Claude what to do differently");
        if (!hasClaudePrompt) {
            return { blocked: false };
        }
        
        // Debug logging
        console.log('Checking keywords in Claude prompt area:', currentPromptArea.substring(0, 200) + '...');
        
        // Look for keywords only in the current prompt area (from ╭ to end)
        for (const rule of this.preferences.keywordRules) {
            const keywordLower = rule.keyword.toLowerCase();
            const promptAreaLower = currentPromptArea.toLowerCase();
            
            if (promptAreaLower.includes(keywordLower)) {
                console.log(`Keyword "${rule.keyword}" found in Claude prompt!`);
                return {
                    blocked: true,
                    keyword: rule.keyword,
                    response: rule.response
                };
            }
        }
        
        return { blocked: false };
    }

    startUsageLimitSync() {
        if (!this.usageLimitResetTime || !this.autoSyncEnabled) {
            return;
        }

        // Clear any existing interval
        this.stopUsageLimitSync();

        // Start interval to update every minute
        this.usageLimitSyncInterval = setInterval(() => {
            this.updateSyncedTimer();
        }, 60000); // Update every minute

        // Update immediately
        this.updateSyncedTimer();
        this.logAction('Auto-sync to usage limit enabled - timer will update every minute', 'info');
    }

    stopUsageLimitSync() {
        if (this.usageLimitSyncInterval) {
            clearInterval(this.usageLimitSyncInterval);
            this.usageLimitSyncInterval = null;
        }
    }

    disableAutoSync() {
        this.autoSyncEnabled = false;
        this.stopUsageLimitSync();
        this.logAction('Auto-sync disabled - user manually changed timer', 'info');
    }

    updateSyncedTimer() {
        if (!this.usageLimitResetTime || !this.autoSyncEnabled) {
            return;
        }

        const now = new Date();
        const timeDiff = this.usageLimitResetTime.getTime() - now.getTime();
        
        if (timeDiff <= 0) {
            this.logAction('Usage limit reset time reached - sync completed', 'success');
            this.stopUsageLimitSync();
            localStorage.removeItem('usageLimitResetTime');
            return;
        }

        const totalMinutes = Math.max(1, Math.floor(timeDiff / (1000 * 60)));

        // Update the form without triggering change events
        const durationInput = document.getElementById('duration-input');
        const unitSelect = document.getElementById('duration-unit');

        // Temporarily remove event listeners to prevent disabling auto-sync
        const oldOnChange = durationInput.onchange;
        durationInput.onchange = null;
        unitSelect.onchange = null;

        durationInput.value = totalMinutes;
        unitSelect.value = 'minutes';
        this.preferences.defaultDuration = totalMinutes;
        this.preferences.defaultUnit = 'minutes';
        this.saveAllPreferences();

        // Restore event listeners
        setTimeout(() => {
            durationInput.onchange = oldOnChange;
        }, 0);

        this.logAction(`Auto-synced: ${totalMinutes} minutes until usage limit reset`, 'info');
    }

    setUsageLimitResetTime(resetTime) {
        this.usageLimitResetTime = resetTime;
        
        // Save to localStorage
        localStorage.setItem('usageLimitResetTime', resetTime.getTime().toString());
        
        // Start sync if auto-sync is enabled
        if (this.autoSyncEnabled) {
            this.startUsageLimitSync();
        }
    }

    loadUsageLimitResetTime() {
        const savedResetTime = localStorage.getItem('usageLimitResetTime');
        if (savedResetTime) {
            const resetTime = new Date(parseInt(savedResetTime));
            const now = new Date();
            
            // Only use if it's in the future
            if (resetTime.getTime() > now.getTime()) {
                this.usageLimitResetTime = resetTime;
                this.logAction(`Loaded saved usage limit reset time: ${resetTime.toLocaleTimeString()}`, 'info');
                
                // Start auto-sync if enabled
                if (this.autoSyncEnabled) {
                    this.startUsageLimitSync();
                }
            } else {
                // Remove expired reset time
                localStorage.removeItem('usageLimitResetTime');
            }
        }
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    const app = new TerminalGUI();
    
    // Add initial log message after app is fully initialized
    setTimeout(() => {
        app.logAction('Application ready - all systems operational', 'success');
    }, 500);
});

// Handle window controls (NOTE: buttons removed, keeping for reference)
document.querySelector('.control-button.close').addEventListener('click', () => {
    window.close();
});

document.querySelector('.control-button.minimize').addEventListener('click', () => {
    const { remote } = require('electron');
    remote.getCurrentWindow().minimize();
});

document.querySelector('.control-button.maximize').addEventListener('click', () => {
    const { remote } = require('electron');
    const win = remote.getCurrentWindow();
    if (win.isMaximized()) {
        win.unmaximize();
    } else {
        win.maximize();
    }
}); 