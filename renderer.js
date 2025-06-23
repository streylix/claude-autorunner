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
        
        this.initializeTerminal();
        this.setupEventListeners();
        this.updateStatusDisplay();
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
        });

        ipcRenderer.on('terminal-exit', () => {
            this.terminal.write('\r\n\x1b[31mTerminal process exited\x1b[0m\r\n');
        });

        // UI event listeners
        document.getElementById('add-message-btn').addEventListener('click', () => {
            this.addMessageToQueue();
        });

        document.getElementById('clear-queue-btn').addEventListener('click', () => {
            this.clearQueue();
        });

        document.getElementById('execution-time').addEventListener('change', () => {
            this.updateInjectionTimer();
        });

        document.getElementById('execution-date').addEventListener('change', () => {
            this.updateInjectionTimer();
        });

        document.getElementById('auto-agree').addEventListener('change', () => {
            this.updateStatusDisplay();
        });

        // Add immediate injection button for testing
        const immediateBtn = document.createElement('button');
        immediateBtn.type = 'button';
        immediateBtn.textContent = 'Inject Now';
        immediateBtn.style.marginLeft = '8px';
        immediateBtn.addEventListener('click', () => {
            this.injectMessages();
        });
        document.querySelector('.input-controls').appendChild(immediateBtn);

        // Set default date and time (5 seconds from now for testing)
        const now = new Date();
        const futureTime = new Date(now.getTime() + 5000); // 5 seconds from now
        document.getElementById('execution-date').value = futureTime.toISOString().split('T')[0];
        document.getElementById('execution-time').value = futureTime.toTimeString().split(' ')[0].substring(0, 8);
    }

    addMessageToQueue() {
        const messageInput = document.getElementById('message-input');
        const message = messageInput.value.trim();
        
        if (message) {
            this.messageQueue.push({
                id: Date.now(),
                content: message,
                timestamp: new Date().toISOString()
            });
            
            messageInput.value = '';
            this.updateMessageList();
            this.updateStatusDisplay();
            this.updateInjectionTimer(); // Automatically set up timer when message is added
        }
    }

    clearQueue() {
        this.messageQueue = [];
        this.updateMessageList();
        this.updateStatusDisplay();
        
        if (this.injectionTimer) {
            clearTimeout(this.injectionTimer);
            this.injectionTimer = null;
        }
    }

    updateMessageList() {
        const messageList = document.getElementById('message-list');
        messageList.innerHTML = '';
        
        this.messageQueue.forEach((message, index) => {
            const messageElement = document.createElement('div');
            messageElement.className = 'message-item';
            messageElement.textContent = message.content;
            messageElement.title = `Added: ${new Date(message.timestamp).toLocaleString()}`;
            messageList.appendChild(messageElement);
        });
    }

    updateInjectionTimer() {
        if (this.injectionTimer) {
            clearTimeout(this.injectionTimer);
            this.injectionTimer = null;
        }

        const dateInput = document.getElementById('execution-date').value;
        const timeInput = document.getElementById('execution-time').value;
        
        if (dateInput && timeInput && this.messageQueue.length > 0) {
            const targetTime = new Date(`${dateInput}T${timeInput}`);
            const now = new Date();
            const delay = targetTime.getTime() - now.getTime();
            
            console.log(`Setting injection timer: ${delay}ms delay`);
            
            if (delay > 0) {
                this.injectionTimer = setTimeout(() => {
                    console.log('Timer triggered, injecting messages...');
                    this.injectMessages();
                }, delay);
                
                document.getElementById('injection-time').textContent = targetTime.toLocaleString();
            } else if (delay <= 0 && delay > -60000) { // If time has passed but within last minute, inject immediately
                console.log('Time has passed, injecting immediately...');
                setTimeout(() => this.injectMessages(), 100);
                document.getElementById('injection-time').textContent = 'Injecting now...';
            } else {
                document.getElementById('injection-time').textContent = 'Time has passed';
            }
        } else {
            document.getElementById('injection-time').textContent = '[input_time]';
        }
        
        this.updateStatusDisplay();
    }

    injectMessages() {
        if (this.messageQueue.length === 0 || this.isInjecting) return;

        console.log(`Injecting ${this.messageQueue.length} messages...`);
        this.isInjecting = true;
        
        // Show injection status
        this.terminal.write('\r\n\x1b[32m[AUTO-INJECT] Starting message injection...\x1b[0m\r\n');

        const autoAgree = document.getElementById('auto-agree').checked;
        
        // Process messages in FIFO order
        const processNextMessage = () => {
            if (this.messageQueue.length > 0) {
                const message = this.messageQueue.shift();
                
                console.log(`Processing message: ${message.content}`);
                this.terminal.write(`\x1b[33m[AUTO-INJECT] Typing: ${message.content}\x1b[0m\r\n`);
                
                // Type the message character by character for realistic effect
                this.typeMessage(message.content, () => {
                    this.injectionCount++;
                    this.updateStatusDisplay();
                    
                    // Send Enter key
                    setTimeout(() => {
                        ipcRenderer.send('terminal-input', '\r');
                        
                        // If auto-agree is enabled and there are more messages, continue
                        if (autoAgree && this.messageQueue.length > 0) {
                            setTimeout(processNextMessage, 1000); // 1 second delay between messages
                        } else if (this.messageQueue.length === 0) {
                            this.isInjecting = false;
                            this.terminal.write('\r\n\x1b[32m[AUTO-INJECT] All messages injected successfully!\x1b[0m\r\n');
                        } else {
                            this.isInjecting = false;
                            this.terminal.write('\r\n\x1b[33m[AUTO-INJECT] Injection paused (auto-agree disabled)\x1b[0m\r\n');
                        }
                    }, 200);
                });
                
                this.updateMessageList();
            } else {
                this.isInjecting = false;
            }
        };

        processNextMessage();
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

    detectDirectoryChange(data) {
        // Simple directory detection from terminal output
        const lines = data.split('\n');
        lines.forEach(line => {
            // Look for common directory patterns in terminal output
            const match = line.match(/.*[➜$#]\s+([^\s]+)/);
            if (match && match[1] !== this.currentDirectory) {
                this.currentDirectory = match[1];
                this.updateStatusDisplay();
            }
        });
    }

    updateStatusDisplay() {
        const importantDetails = document.querySelector('.important-details .section-header span');
        const statusText = `Current directory: ${this.currentDirectory} | Injections made: ${this.injectionCount} | Queued messages: ${this.messageQueue.length}`;
        
        // Update the important details section
        importantDetails.textContent = statusText;
        
        // Update injection time display
        const dateInput = document.getElementById('execution-date').value;
        const timeInput = document.getElementById('execution-time').value;
        
        if (dateInput && timeInput && this.messageQueue.length > 0) {
            const targetTime = new Date(`${dateInput}T${timeInput}`);
            const now = new Date();
            const delay = targetTime.getTime() - now.getTime();
            
            if (delay > 0) {
                document.getElementById('injection-time').textContent = targetTime.toLocaleString();
            } else {
                document.getElementById('injection-time').textContent = 'Ready to inject';
            }
        } else {
            document.getElementById('injection-time').textContent = '[input_time]';
        }
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new TerminalGUI();
});

// Handle window controls
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