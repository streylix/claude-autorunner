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
        this.preferences = {
            autoscrollEnabled: true,
            autoscrollDelay: 3000,
            autoContinueEnabled: false,
            defaultDuration: 5,
            defaultUnit: 'seconds'
        };
        
        this.initializeTerminal();
        this.setupEventListeners();
        this.initializeLucideIcons();
        this.updateStatusDisplay();
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

        // Duration and unit change listeners
        document.getElementById('duration-input').addEventListener('change', (e) => {
            this.preferences.defaultDuration = parseInt(e.target.value) || 5;
            this.saveAllPreferences();
        });

        document.getElementById('duration-unit').addEventListener('change', (e) => {
            this.preferences.defaultUnit = e.target.value;
            this.saveAllPreferences();
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
            const processedMessage = message.replace(/\n/g, '\\ ');
            
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
        
        const message = this.messageQueue.shift();
        this.isInjecting = true;
        
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
        
        // Keep only recent output (last 2000 characters to avoid memory issues)
        if (this.lastTerminalOutput.length > 2000) {
            this.lastTerminalOutput = this.lastTerminalOutput.slice(-2000);
        }
        
        // Don't auto-continue if disabled, currently injecting, or in the middle of message injection
        if (!this.autoContinueEnabled || this.isInjecting) return;
        
        // Check for conditions that should prevent auto-continue
        const hasEscToInterrupt = this.lastTerminalOutput.includes("esc to interrupt");
        const hasClaudePrompt = this.lastTerminalOutput.includes("No, and tell Claude what to do differently");
        
        // Only proceed if we don't see either blocking condition
        if (hasEscToInterrupt || hasClaudePrompt) {
            return; // Don't auto-continue if either condition is present
        }
        
        // Prevent multiple rapid Enter presses (debounce)
        const now = Date.now();
        if (this.lastAutoContinueTime && (now - this.lastAutoContinueTime) < 2000) {
            return; // Don't auto-continue if we just did it within 2 seconds
        }
        
        // Look for other prompt patterns that should trigger auto-continue
        // For example, general "Do you want to proceed?" patterns without the Claude-specific text
        const hasGeneralPrompt = /Do you want to proceed\?/i.test(this.lastTerminalOutput);
        
        if (hasGeneralPrompt) {
            console.log('Auto-continue: General prompt detected!');
            
            // Log to action log instead of terminal
            this.logAction('Auto-continue detected prompt - pressing Enter', 'info');
            
            // Record the time to prevent rapid re-triggering
            this.lastAutoContinueTime = now;
            
            // Wait a short delay then just send Enter
            setTimeout(() => {
                ipcRenderer.send('terminal-input', '\r');
                this.logAction('Auto-continue: Enter key sent', 'success');
                
                // Clear the stored output to avoid re-triggering
                this.lastTerminalOutput = '';
            }, 500);
        }
    }

    detectDirectoryChange(data) {
        // Enhanced directory detection from terminal output
        const lines = data.split('\n');
        lines.forEach(line => {
            // Look for common directory patterns in terminal output
            const promptMatch = line.match(/.*[➜$#]\s+([^\s]+)/);
            const pwdMatch = line.match(/^([\/~].*?)(?:\s|$)/);
            
            let detectedDir = null;
            if (promptMatch && promptMatch[1] && promptMatch[1].length > 1) {
                detectedDir = promptMatch[1];
            } else if (pwdMatch && pwdMatch[1]) {
                detectedDir = pwdMatch[1];
            }
            
            if (detectedDir && detectedDir !== this.currentDirectory && detectedDir !== '~') {
                // Expand ~ to home directory if needed
                if (detectedDir.startsWith('~/')) {
                    detectedDir = detectedDir.replace('~', process.env.HOME || '/Users/' + process.env.USER);
                }
                
                this.currentDirectory = detectedDir;
                this.updateStatusDisplay();
            }
        });
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
            this.terminal.write(`\r\n\x1b[33m[DIRECTORY] Dialog failed, using prompt fallback\x1b[0m\r\n`);
            
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
        this.terminal.write(`\r\n\x1b[36m[DIRECTORY] Resetting terminal to: ${this.currentDirectory}\x1b[0m\r\n`);
        
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
        this.terminal.write(`\r\n\x1b[36m[DIRECTORY] Changing to: ${newPath}\x1b[0m\r\n`);
        
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