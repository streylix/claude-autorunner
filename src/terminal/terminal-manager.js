/**
 * Terminal Manager Module
 * Handles terminal creation, switching, deletion, and basic management
 */

class TerminalManager {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        this.terminals = terminalGUI.terminals;
        this.terminalStatuses = terminalGUI.terminalStatuses;
        this.activeTerminalId = 1;
        this.maxTerminals = 4;
        this.terminalColors = ['#007acc', '#28ca42', '#ff5f57', '#ffbe2e'];
    }

    async createTerminal(id) {
        try {
            if (this.terminals.has(id)) {
                console.warn(`Terminal ${id} already exists`);
                return false;
            }

            // Create xterm terminal instance
            const terminal = new Terminal(this.gui.getTerminalTheme());
            const fitAddon = new FitAddon();
            terminal.loadAddon(fitAddon);
            terminal.loadAddon(new WebLinksAddon());

            // Store terminal data
            const color = this.terminalColors[(id - 1) % this.terminalColors.length];
            const terminalData = {
                id,
                terminal,
                fitAddon,
                color,
                name: `Terminal ${id}`,
                directory: this.gui.preferences.currentDirectory || null,
                lastOutput: '',
                status: '',
                // Usage limit tracking per terminal
                usageLimitReached: false,
                usageResetTime: null,
                isWaiting: false
            };
            
            this.terminals.set(id, terminalData);
            
            // Initialize status tracking for this terminal
            this.terminalStatuses.set(id, {
                isRunning: false,
                isPrompting: false,
                isWaiting: false,
                lastUpdate: Date.now()
            });

            // Create DOM elements if they don't exist
            const existingWrapper = document.querySelector(`[data-terminal-id="${id}"]`);
            if (!existingWrapper) {
                this.createTerminalDOM(id, color, terminalData.name);
            }

            // Open terminal in container
            const terminalContainer = document.querySelector(`[data-terminal-container="${id}"]`);
            if (terminalContainer) {
                terminal.open(terminalContainer);
                
                // Fit terminal to container
                setTimeout(() => {
                    try {
                        fitAddon.fit();
                    } catch (error) {
                        console.warn('Failed to fit terminal:', error);
                    }
                }, 100);

                // Set up terminal event handlers
                terminal.onData((data) => {
                    // Send data to backend via IPC
                    ipcRenderer.send('terminal-input', { terminalId: id, data: data });
                });

                terminal.onResize((size) => {
                    // Send resize event to backend
                    ipcRenderer.send('terminal-resize', { terminalId: id, cols: size.cols, rows: size.rows });
                });

                // Focus this terminal if it's the first one or specifically requested
                if (this.terminals.size === 1 || id === this.activeTerminalId) {
                    this.switchToTerminal(id);
                }

                // Start terminal process via IPC
                ipcRenderer.send('terminal-start', { 
                    terminalId: id, 
                    directory: terminalData.directory 
                });

                // Update UI
                this.updateTerminalButtonVisibility();
                this.updateTerminalDropdowns();
                this.gui.updateTerminalStatusIndicator();

                this.gui.logAction(`Created terminal ${id} (${terminalData.name})`, 'success');
                
                // Save terminal state
                await this.saveTerminalState();
                
                return true;
            }
        } catch (error) {
            console.error('Error creating terminal:', error);
            this.gui.logAction(`Failed to create terminal ${id}: ${error.message}`, 'error');
            return false;
        }
    }

    createTerminalDOM(id, color, name) {
        const terminalsContainer = document.getElementById('terminals-container');
        if (!terminalsContainer) {
            console.error('terminals-container not found');
            return;
        }
        
        // Create terminal wrapper
        const terminalWrapper = document.createElement('div');
        terminalWrapper.className = 'terminal-wrapper';
        terminalWrapper.setAttribute('data-terminal-id', id);
        terminalWrapper.style.display = 'none'; // Hidden by default
        
        // Create terminal header
        const terminalHeader = document.createElement('div');
        terminalHeader.className = 'terminal-header';
        terminalHeader.innerHTML = `
            <div class="terminal-title-wrapper">
                <button class="icon-btn close-terminal-btn" style="display: none;" title="Close terminal">
                    <i data-lucide="x"></i>
                </button>
                <span class="terminal-color-dot" style="background-color: ${color};"></span>
                <span class="terminal-title editable" contenteditable="false">${name}</span>
                <button class="icon-btn add-terminal-btn" title="Add new terminal" style="display: none;">
                    <i data-lucide="plus"></i>
                </button>
            </div>
            <span class="terminal-status" data-terminal-status="${id}"></span>
        `;
        
        // Create terminal container
        const terminalContainer = document.createElement('div');
        terminalContainer.className = 'terminal-container';
        terminalContainer.setAttribute('data-terminal-container', id);
        
        // Assemble wrapper
        terminalWrapper.appendChild(terminalHeader);
        terminalWrapper.appendChild(terminalContainer);
        terminalsContainer.appendChild(terminalWrapper);
    }

    switchToTerminal(terminalId) {
        if (!this.terminals.has(terminalId)) {
            console.warn(`Terminal ${terminalId} does not exist`);
            return false;
        }

        // Hide all terminal wrappers
        document.querySelectorAll('.terminal-wrapper').forEach(wrapper => {
            wrapper.style.display = 'none';
        });

        // Show target terminal wrapper
        const targetWrapper = document.querySelector(`[data-terminal-id="${terminalId}"]`);
        if (targetWrapper) {
            targetWrapper.style.display = 'block';
        }

        // Update active terminal reference
        this.activeTerminalId = terminalId;
        this.gui.activeTerminalId = terminalId;
        
        const terminalData = this.terminals.get(terminalId);
        if (terminalData) {
            this.gui.terminal = terminalData.terminal;
            
            // Focus the terminal
            setTimeout(() => {
                terminalData.terminal.focus();
                
                // Ensure proper fit
                try {
                    terminalData.fitAddon.fit();
                } catch (error) {
                    console.warn('Failed to fit terminal on switch:', error);
                }
            }, 50);
        }

        // Update UI elements
        this.updateActiveTerminalIndicators();
        this.updateTerminalDropdowns();
        
        this.gui.logAction(`Switched to terminal ${terminalId} (${terminalData?.name || 'Unknown'})`, 'info');
        return true;
    }

    closeTerminal(terminalId) {
        if (!this.terminals.has(terminalId)) {
            console.warn(`Terminal ${terminalId} does not exist`);
            return false;
        }

        const terminalData = this.terminals.get(terminalId);
        const terminalName = terminalData?.name || `Terminal ${terminalId}`;

        try {
            // Close terminal process via IPC
            ipcRenderer.send('terminal-close', { terminalId });

            // Clean up terminal instance
            if (terminalData?.terminal) {
                terminalData.terminal.dispose();
            }

            // Remove from maps
            this.terminals.delete(terminalId);
            this.terminalStatuses.delete(terminalId);

            // Remove DOM elements
            const terminalWrapper = document.querySelector(`[data-terminal-id="${terminalId}"]`);
            if (terminalWrapper) {
                terminalWrapper.remove();
            }

            // If this was the active terminal, switch to another one
            if (this.activeTerminalId === terminalId) {
                const remainingTerminals = Array.from(this.terminals.keys());
                if (remainingTerminals.length > 0) {
                    this.switchToTerminal(remainingTerminals[0]);
                } else {
                    this.activeTerminalId = null;
                    this.gui.activeTerminalId = null;
                    this.gui.terminal = null;
                }
            }

            // Update UI
            this.updateTerminalButtonVisibility();
            this.updateTerminalDropdowns();
            this.gui.updateTerminalStatusIndicator();

            this.gui.logAction(`Closed terminal ${terminalId} (${terminalName})`, 'info');
            
            // Save terminal state
            this.saveTerminalState();
            
            return true;
        } catch (error) {
            console.error('Error closing terminal:', error);
            this.gui.logAction(`Failed to close terminal ${terminalId}: ${error.message}`, 'error');
            return false;
        }
    }

    addNewTerminal() {
        // Find the next available terminal ID
        let nextId = 1;
        while (this.terminals.has(nextId) && nextId <= this.maxTerminals) {
            nextId++;
        }

        if (nextId > this.maxTerminals) {
            this.gui.logAction(`Maximum number of terminals (${this.maxTerminals}) reached`, 'warning');
            return false;
        }

        const success = this.createTerminal(nextId);
        if (success) {
            // Re-initialize Lucide icons for new elements
            if (typeof lucide !== 'undefined') {
                lucide.createIcons();
            }

            this.gui.logAction(`Added Terminal ${nextId}`, 'info');
            
            // Save terminal state
            this.saveTerminalState();
        }
        
        return success;
    }

    updateTerminalButtonVisibility() {
        const addTerminalBtn = document.getElementById('add-terminal-btn');
        const hasCloseableTerminals = this.terminals.size > 1;
        
        // Show/hide add terminal button based on max terminals
        if (addTerminalBtn) {
            addTerminalBtn.style.display = this.terminals.size >= this.maxTerminals ? 'none' : 'inline-block';
        }

        // Show/hide close buttons on terminal headers
        document.querySelectorAll('.close-terminal-btn').forEach(btn => {
            btn.style.display = hasCloseableTerminals ? 'inline-block' : 'none';
        });
    }

    updateActiveTerminalIndicators() {
        // Update terminal selector button states
        document.querySelectorAll('.terminal-selector-btn').forEach(btn => {
            const terminalId = parseInt(btn.getAttribute('data-terminal-id'));
            if (terminalId === this.activeTerminalId) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    updateTerminalDropdowns() {
        // Update terminal selector dropdown
        this.updateTerminalSelectorDropdown();
        
        // Update message terminal dropdowns
        this.updateMessageTerminalDropdowns();
    }

    updateTerminalSelectorDropdown() {
        const dropdown = document.querySelector('.terminal-selector-dropdown');
        if (!dropdown) return;

        // Clear existing items
        dropdown.innerHTML = '';

        // Add terminal items
        this.terminals.forEach((terminalData, terminalId) => {
            const item = document.createElement('div');
            item.className = 'terminal-selector-item';
            item.setAttribute('data-terminal-id', terminalId);
            
            if (terminalId === this.activeTerminalId) {
                item.classList.add('active');
            }

            item.innerHTML = `
                <span class="terminal-indicator" style="background-color: ${terminalData.color}"></span>
                <span class="terminal-name">${terminalData.name}</span>
                ${this.terminals.size > 1 ? `<button class="close-terminal-btn" data-terminal-id="${terminalId}">×</button>` : ''}
            `;

            // Add click handler for switching
            item.addEventListener('click', (e) => {
                if (!e.target.classList.contains('close-terminal-btn')) {
                    this.switchToTerminal(terminalId);
                    this.hideTerminalSelectorDropdown();
                }
            });

            // Add close handler
            const closeBtn = item.querySelector('.close-terminal-btn');
            if (closeBtn) {
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.closeTerminal(terminalId);
                });
            }

            dropdown.appendChild(item);
        });

        // Add "Add New Terminal" option if under limit
        if (this.terminals.size < this.maxTerminals) {
            const addItem = document.createElement('div');
            addItem.className = 'terminal-selector-item add-terminal-item';
            addItem.innerHTML = `
                <span class="terminal-indicator" style="background-color: #666">+</span>
                <span class="terminal-name">Add Terminal</span>
            `;
            
            addItem.addEventListener('click', () => {
                this.addNewTerminal();
                this.hideTerminalSelectorDropdown();
            });

            dropdown.appendChild(addItem);
        }
    }

    updateMessageTerminalDropdowns() {
        // This will be implemented when message system is extracted
        // For now, just update any existing message terminal dropdowns
        document.querySelectorAll('.message-terminal-dropdown').forEach(dropdown => {
            // Update logic will be moved to message system module
        });
    }

    showTerminalSelectorDropdown() {
        const dropdown = document.querySelector('.terminal-selector-dropdown');
        if (dropdown) {
            dropdown.style.display = 'block';
            this.updateTerminalSelectorDropdown();
        }
    }

    hideTerminalSelectorDropdown() {
        const dropdown = document.querySelector('.terminal-selector-dropdown');
        if (dropdown) {
            dropdown.style.display = 'none';
        }
    }

    toggleTerminalSelectorDropdown() {
        const dropdown = document.querySelector('.terminal-selector-dropdown');
        if (dropdown) {
            if (dropdown.style.display === 'block') {
                this.hideTerminalSelectorDropdown();
            } else {
                this.showTerminalSelectorDropdown();
            }
        }
    }

    resizeAllTerminals() {
        this.terminals.forEach((terminalData) => {
            try {
                terminalData.fitAddon.fit();
            } catch (error) {
                console.warn('Failed to resize terminal:', error);
            }
        });
    }

    async saveTerminalState() {
        try {
            const terminalState = {
                activeTerminalId: this.activeTerminalId,
                terminals: Array.from(this.terminals.entries()).map(([id, data]) => ({
                    id,
                    name: data.name,
                    color: data.color,
                    directory: data.directory
                }))
            };

            await ipcRenderer.invoke('db-set-app-state', 'terminalState', JSON.stringify(terminalState));
        } catch (error) {
            console.error('Failed to save terminal state:', error);
        }
    }

    async restoreTerminalState() {
        try {
            const savedState = await ipcRenderer.invoke('db-get-app-state', 'terminalState');
            if (!savedState) {
                // No saved state, create default terminal
                return await this.createTerminal(1);
            }

            const terminalState = JSON.parse(savedState);
            
            // Restore terminals
            const restoredTerminals = [];
            for (const terminalInfo of terminalState.terminals) {
                const success = await this.createTerminal(terminalInfo.id);
                if (success) {
                    // Update terminal data with saved info
                    const terminalData = this.terminals.get(terminalInfo.id);
                    if (terminalData) {
                        terminalData.name = terminalInfo.name;
                        terminalData.directory = terminalInfo.directory;
                        this.updateTerminalUI(terminalInfo.id, terminalInfo.name, terminalInfo.color);
                    }
                    restoredTerminals.push(terminalInfo.id);
                }
            }

            // Switch to previously active terminal
            if (restoredTerminals.includes(terminalState.activeTerminalId)) {
                this.switchToTerminal(terminalState.activeTerminalId);
            } else if (restoredTerminals.length > 0) {
                this.switchToTerminal(restoredTerminals[0]);
            }

            return restoredTerminals.length > 0;
        } catch (error) {
            console.error('Failed to restore terminal state:', error);
            // Fallback: create default terminal
            return await this.createTerminal(1);
        }
    }

    updateTerminalUI(terminalId, name, color) {
        const titleElement = document.querySelector(`[data-terminal-title="${terminalId}"]`);
        if (titleElement) {
            titleElement.textContent = name;
        }

        const indicatorElement = document.querySelector(`[data-terminal-id="${terminalId}"] .terminal-color-dot`);
        if (indicatorElement) {
            indicatorElement.style.backgroundColor = color;
        }

        // Update dropdowns
        this.updateTerminalDropdowns();
    }

    getNextTerminalForMessage() {
        // Round-robin terminal assignment
        const terminalIds = Array.from(this.terminals.keys()).sort();
        if (terminalIds.length === 0) return null;

        const currentIndex = terminalIds.indexOf(this.activeTerminalId);
        const nextIndex = (currentIndex + 1) % terminalIds.length;
        return terminalIds[nextIndex];
    }

    selectActiveTerminal(terminalId) {
        return this.switchToTerminal(terminalId);
    }
}

// Export for use in main TerminalGUI class
window.TerminalManager = TerminalManager;