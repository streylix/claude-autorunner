/**
 * Terminal Manager Module
 * Handles multi-terminal creation, management, and lifecycle
 */

// Browser-only imports - handle gracefully in Node.js environment
let Terminal, FitAddon, SearchAddon, WebLinksAddon;

try {
    if (typeof window !== 'undefined') {
        const xtermModule = require('@xterm/xterm');
        Terminal = xtermModule.Terminal;
        FitAddon = require('@xterm/addon-fit').FitAddon;
        SearchAddon = require('@xterm/addon-search').SearchAddon;
        WebLinksAddon = require('@xterm/addon-web-links').WebLinksAddon;
    }
} catch (error) {
    // Running in Node.js environment - terminal functionality won't be available
    console.log('Terminal modules not available in Node.js environment');
}

class TerminalManager {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        
        // Multi-terminal support
        this.terminals = new Map(); // Map of terminal ID to terminal data
        this.activeTerminalId = 1;
        this.terminalIdCounter = 1;
        this.terminalColors = ['#007acc', '#28ca42', '#ff5f57', '#ffbe2e', '#af52de', '#5ac8fa'];
        this.terminalSessionMap = new Map(); // Map of terminal ID to backend session UUID
        
        // Legacy single terminal references (will be updated to use active terminal)
        this.terminal = null;
        this.fitAddon = null;
        
        // Terminal status tracking
        this.terminalStatuses = new Map(); // Per-terminal status tracking
        this.terminalStabilityTracking = new Map(); // Track stability for each terminal
        this.terminalStabilityTimers = new Map(); // Track per-terminal stability start times
        this.lastAssignedTerminalId = 0; // For round-robin terminal assignment
        this.previousTerminalStatuses = new Map(); // Track previous status for each terminal for sound triggering
        
        // Current directory tracking
        this.currentDirectory = null;
        this.recentDirectories = [];
        this.maxRecentDirectories = 5;
    }

    initializeTerminal() {
        // Restore saved terminal data if available
        if (this.gui.savedTerminalData && this.gui.savedTerminalData.length > 0) {
            // Restore terminals in order
            for (const termData of this.gui.savedTerminalData) {
                if (termData.id === 1) {
                    // Create main terminal first
                    this.createTerminal(1);
                    // Set active terminal
                    this.activeTerminalId = 1;
                    this.terminal = this.terminals.get(1).terminal;
                    this.fitAddon = this.terminals.get(1).fitAddon;
                } else {
                    // Create additional terminals
                    this.createAdditionalTerminalFromData(termData);
                }
            }
            
            this.terminalIdCounter = Math.max(...this.gui.savedTerminalData.map(t => t.id)) + 1;
        } else {
            // Create first terminal
            this.createTerminal(1);
            this.activeTerminalId = 1;
            this.terminal = this.terminals.get(1).terminal;
            this.fitAddon = this.terminals.get(1).fitAddon;
        }
        
        // Auto-fit terminals when window visibility changes
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                return;
            }
            setTimeout(() => this.resizeAllTerminals(), 100);
        });
    }

    createAdditionalTerminalFromData(termData) {
        const terminalsContainer = document.getElementById('terminals-container');
        const terminalCount = this.terminals.size;
        const newId = termData.id;
        
        // Update terminal ID counter
        this.terminalIdCounter = Math.max(this.terminalIdCounter, newId + 1);
        
        // Get color for this terminal
        const colorIndex = (newId - 1) % this.terminalColors.length;
        const terminalColor = this.terminalColors[colorIndex];
        
        // Create terminal wrapper
        const terminalWrapper = document.createElement('div');
        terminalWrapper.className = 'terminal-wrapper';
        terminalWrapper.setAttribute('data-terminal-id', newId);
        
        terminalWrapper.innerHTML = `
            <div class="terminal-header">
                <div class="terminal-title" style="border-color: ${terminalColor}; color: ${terminalColor};">
                    Terminal ${newId}
                </div>
                <div class="terminal-controls">
                    <button class="terminal-control-btn close-terminal-btn" title="Close terminal" data-terminal-id="${newId}">
                        <i data-lucide="x"></i>
                    </button>
                    <button class="terminal-control-btn add-terminal-btn" title="Add new terminal" data-start-directory="">
                        <i data-lucide="plus"></i>
                    </button>
                </div>
            </div>
            <div class="terminal-container" id="terminal-${newId}"></div>
            <div class="terminal-search-container" id="search-container-${newId}" style="display: none;">
                <div class="terminal-search">
                    <div class="search-input-container">
                        <input type="text" class="search-input" placeholder="Search terminal..." data-terminal-id="${newId}">
                        <button class="search-btn search-prev" title="Previous match">
                            <i data-lucide="chevron-up"></i>
                        </button>
                        <button class="search-btn search-next" title="Next match">
                            <i data-lucide="chevron-down"></i>
                        </button>
                        <span class="search-matches">0/0</span>
                        <button class="search-btn search-close" title="Close search">
                            <i data-lucide="x"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        // Add to container
        terminalsContainer.appendChild(terminalWrapper);
        
        // Update layout
        terminalsContainer.setAttribute('data-terminal-count', terminalCount + 1);
        
        // Create terminal instance
        const terminalData = this.createTerminal(newId);
        
        // Re-initialize Lucide icons for new elements
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
        
        // Update button visibility
        this.updateTerminalButtonVisibility();
        
        // Resize all terminals to fit new layout
        setTimeout(() => {
            this.resizeAllTerminals();
        }, 100);
        
        this.gui.logAction(`Restored Terminal ${newId}`, 'info');
        
        return terminalData;
    }

    createTerminal(id) {
        let terminalContainer = document.getElementById(`terminal-${id}`);
        if (!terminalContainer) {
            // Try alternative selector for existing HTML structure
            terminalContainer = document.querySelector(`[data-terminal-container="${id}"]`);
        }
        if (!terminalContainer) {
            console.error(`Terminal container not found for ID: ${id}`);
            return null;
        }

        // Create xterm.js terminal
        const terminal = new Terminal({
            cursorBlink: true,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            fontSize: 13,
            lineHeight: 1.2,
            theme: this.getTerminalTheme(),
            scrollback: 10000,
            allowTransparency: true
        });

        // Create addons
        const fitAddon = new FitAddon();
        const searchAddon = new SearchAddon();
        const webLinksAddon = new WebLinksAddon();
        
        // Load addons
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(searchAddon);
        terminal.loadAddon(webLinksAddon);

        // Open terminal in container
        terminal.open(terminalContainer);
        
        // Get color for this terminal
        const colorIndex = (id - 1) % this.terminalColors.length;
        const terminalColor = this.terminalColors[colorIndex];

        // Create terminal data object
        const terminalData = {
            id: id,
            terminal: terminal,
            fitAddon: fitAddon,
            searchAddon: searchAddon,
            webLinksAddon: webLinksAddon,
            color: terminalColor,
            status: 'initializing',
            isClosing: false,
            directory: null,
            lastOutput: '',
            lastActivity: Date.now()
        };

        // Store terminal data
        this.terminals.set(id, terminalData);
        this.terminalStatuses.set(id, {
            isRunning: false,
            isPrompting: false,
            lastUpdate: Date.now()
        });

        // Set up terminal event handlers
        this.setupTerminalEventHandlers(id, terminal, terminalData);

        // Fit terminal to container
        setTimeout(() => {
            try {
                fitAddon.fit();
                
                // Ensure terminal viewport is properly sized
                const terminalViewport = terminalContainer.querySelector('.xterm-viewport');
                if (terminalViewport) {
                    terminalViewport.style.width = '100%';
                }
                
                // Focus terminal if it's the active one
                if (id === this.activeTerminalId) {
                    terminal.focus();
                }
            } catch (error) {
                console.error('Error fitting terminal:', error);
            }
        }, 100);

        // Handle first terminal setup
        if (id === 1) {
            this.terminal = terminal;
            this.fitAddon = fitAddon;
            
            // Set current directory from saved state
            const savedDirectory = this.gui.preferences.currentDirectory;
            if (savedDirectory) {
                this.currentDirectory = savedDirectory;
                terminalData.directory = savedDirectory;
            }
            
            // Update recent directories if not exists
            if (!savedDirectory) {
                this.updateRecentDirectories(this.currentDirectory || process.env.HOME || '~');
            }
            
            // Create backend session if available
            if (this.gui.backendAPIClient) {
                this.createBackendSession(id, `Terminal ${id}`, this.currentDirectory);
            }
        }

        // For additional terminals, inherit current directory
        if (id !== 1) {
            terminalData.directory = this.currentDirectory;
        }

        return terminalData;
    }

    setupTerminalEventHandlers(id, terminal, terminalData) {
        // Handle terminal data
        terminal.onData(data => {
            if (terminalData && !terminalData.isClosing) {
                this.gui.ipcRenderer?.send('terminal-input', { terminalId: id, data: data });
            }
        });

        // Handle terminal selection change
        terminal.onSelectionChange(() => {
            if (terminalData) {
                this.activeTerminalId = id;
                
                // Update legacy references for active terminal
                if (id === this.activeTerminalId) {
                    this.terminal = terminal;
                    this.fitAddon = terminalData.fitAddon;
                }
                
                // Update UI to show active terminal
                this.updateActiveTerminalUI();
            }
        });

        // Handle resize
        terminal.onResize(({ cols, rows }) => {
            if (terminalData) {
                this.gui.ipcRenderer?.send('terminal-resize', { 
                    terminalId: id, 
                    cols: cols, 
                    rows: rows 
                });
            }
        });
    }

    updateActiveTerminalUI() {
        // Update terminal wrapper styling to show active terminal
        document.querySelectorAll('.terminal-wrapper').forEach(wrapper => {
            const terminalId = parseInt(wrapper.getAttribute('data-terminal-id'));
            if (terminalId === this.activeTerminalId) {
                wrapper.classList.add('active');
            } else {
                wrapper.classList.remove('active');
            }
        });
    }

    resizeAllTerminals() {
        this.terminals.forEach(terminalData => {
            try {
                terminalData.fitAddon.fit();
            } catch (error) {
                console.error(`Error resizing terminal ${terminalData.id}:`, error);
            }
        });
    }

    getTerminalTheme() {
        const currentTheme = this.gui.preferences.theme;
        
        if (currentTheme === 'system') {
            // Detect system theme
            const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            return isDark ? this.getDarkTerminalTheme() : this.getLightTerminalTheme();
        } else if (currentTheme === 'light') {
            return this.getLightTerminalTheme();
        } else {
            return this.getDarkTerminalTheme();
        }
    }

    getDarkTerminalTheme() {
        return {
            foreground: '#ffffff',
            background: '#1a1a1a',
            cursor: '#ffffff',
            cursorAccent: '#000000',
            selection: 'rgba(255, 255, 255, 0.3)',
            black: '#000000',
            red: '#ff5555',
            green: '#50fa7b',
            yellow: '#f1fa8c',
            blue: '#bd93f9',
            magenta: '#ff79c6',
            cyan: '#8be9fd',
            white: '#bfbfbf',
            brightBlack: '#4d4d4d',
            brightRed: '#ff6e67',
            brightGreen: '#5af78e',
            brightYellow: '#f4f99d',
            brightBlue: '#caa9fa',
            brightMagenta: '#ff92d0',
            brightCyan: '#9aedfe',
            brightWhite: '#e6e6e6'
        };
    }

    getLightTerminalTheme() {
        return {
            foreground: '#000000',
            background: '#ffffff',
            cursor: '#000000',
            cursorAccent: '#ffffff',
            selection: 'rgba(0, 0, 0, 0.3)',
            black: '#2e2e2e',
            red: '#c91b00',
            green: '#00c200',
            yellow: '#c7c400',
            blue: '#0037da',
            magenta: '#c930c7',
            cyan: '#00c5c7',
            white: '#c7c7c7',
            brightBlack: '#767676',
            brightRed: '#ff6d67',
            brightGreen: '#5bfa6b',
            brightYellow: '#fcfc54',
            brightBlue: '#6a7eff',
            brightMagenta: '#ff5bf0',
            brightCyan: '#4febf0',
            brightWhite: '#ffffff'
        };
    }

    applyTheme(theme) {
        this.gui.preferences.theme = theme;
        this.gui.saveAllPreferences();
        
        if (theme === 'system') {
            // Listen for system theme changes
            if (window.matchMedia) {
                const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
                mediaQuery.addEventListener('change', () => {
                    this.updateTerminalThemes();
                });
            }
        }
        
        // Update terminal themes
        this.updateTerminalThemes();
    }

    updateTerminalThemes() {
        const newTheme = this.getTerminalTheme();
        this.terminals.forEach(terminalData => {
            try {
                terminalData.terminal.options.theme = newTheme;
            } catch (error) {
                console.error(`Error updating theme for terminal ${terminalData.id}:`, error);
            }
        });
    }

    async addTerminal(startDirectory = null) {
        const terminalCount = this.terminals.size;
        if (terminalCount >= 4) {
            this.gui.logAction('Maximum of 4 terminals allowed', 'warning');
            return;
        }

        const newId = this.terminalIdCounter++;
        const terminalsContainer = document.getElementById('terminals-container');
        
        // Get color for this terminal
        const colorIndex = (newId - 1) % this.terminalColors.length;
        const terminalColor = this.terminalColors[colorIndex];
        
        // Create terminal wrapper
        const terminalWrapper = document.createElement('div');
        terminalWrapper.className = 'terminal-wrapper';
        terminalWrapper.setAttribute('data-terminal-id', newId);
        
        terminalWrapper.innerHTML = `
            <div class="terminal-header">
                <div class="terminal-title" style="border-color: ${terminalColor}; color: ${terminalColor};">
                    Terminal ${newId}
                </div>
                <div class="terminal-controls">
                    <button class="terminal-control-btn close-terminal-btn" title="Close terminal" data-terminal-id="${newId}">
                        <i data-lucide="x"></i>
                    </button>
                    <button class="terminal-control-btn add-terminal-btn" title="Add new terminal" data-start-directory="">
                        <i data-lucide="plus"></i>
                    </button>
                </div>
            </div>
            <div class="terminal-container" id="terminal-${newId}"></div>
            <div class="terminal-search-container" id="search-container-${newId}" style="display: none;">
                <div class="terminal-search">
                    <div class="search-input-container">
                        <input type="text" class="search-input" placeholder="Search terminal..." data-terminal-id="${newId}">
                        <button class="search-btn search-prev" title="Previous match">
                            <i data-lucide="chevron-up"></i>
                        </button>
                        <button class="search-btn search-next" title="Next match">
                            <i data-lucide="chevron-down"></i>
                        </button>
                        <span class="search-matches">0/0</span>
                        <button class="search-btn search-close" title="Close search">
                            <i data-lucide="x"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        // Add to container
        terminalsContainer.appendChild(terminalWrapper);
        
        // Update layout
        terminalsContainer.setAttribute('data-terminal-count', terminalCount + 1);
        
        // Create terminal instance
        const terminalData = this.createTerminal(newId);
        
        // Create backend session if available
        if (this.gui.backendAPIClient) {
            this.createBackendSession(newId, `Terminal ${newId}`, this.currentDirectory);
        }
        
        // Start terminal process
        const directoryToUse = startDirectory || this.currentDirectory;
        this.gui.ipcRenderer?.send('terminal-start', { terminalId: newId, directory: directoryToUse });
        
        // If we're starting in a specific directory, update recent directories
        if (startDirectory) {
            this.updateRecentDirectories(startDirectory);
        }
        
        // Update dropdowns
        this.updateTerminalDropdowns();
        this.updateManualTerminalDropdown();
        
        // Re-initialize Lucide icons for new elements
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
        
        // Update button visibility
        this.updateTerminalButtonVisibility();
        
        // Resize all terminals to fit new layout
        setTimeout(() => {
            this.resizeAllTerminals();
        }, 100);
        
        this.gui.logAction(`Added Terminal ${newId}`, 'info');
        
        // Save terminal state
        await this.saveTerminalState();
    }

    async createBackendSession(terminalId, name, directory) {
        try {
            const session = await this.gui.backendAPIClient.createTerminalSession(name, directory);
            // Store the mapping of frontend terminal ID to backend session UUID
            this.terminalSessionMap.set(terminalId, session.id);
            await this.saveTerminalSessionMapping();
            this.gui.logAction(`Created backend session for Terminal ${terminalId}`, 'info');
        } catch (error) {
            console.error('Failed to create backend terminal session:', error);
            this.gui.logAction(`Failed to create backend session for Terminal ${terminalId}`, 'error');
        }
    }

    updateRecentDirectories(directory) {
        if (!directory || directory === '~' || directory === 'Loading...') return;
        
        // Remove the directory if it already exists in the list
        this.recentDirectories = this.recentDirectories.filter(dir => dir !== directory);
        
        // Add the directory to the beginning of the list
        this.recentDirectories.unshift(directory);
        
        // Keep only the most recent directories
        if (this.recentDirectories.length > this.maxRecentDirectories) {
            this.recentDirectories = this.recentDirectories.slice(0, this.maxRecentDirectories);
        }
        
        // Save to preferences
        this.gui.preferences.recentDirectories = this.recentDirectories;
        this.gui.saveAllPreferences();
    }

    updateTerminalButtonVisibility() {
        const terminalCount = this.terminals.size;
        
        // Show/hide close buttons (show when more than 1 terminal)
        const closeButtons = document.querySelectorAll('.close-terminal-btn');
        closeButtons.forEach(btn => {
            btn.style.display = terminalCount > 1 ? 'inline-flex' : 'none';
        });
        
        // Show/hide add buttons (hide when 4 terminals, show on last terminal when 3 or fewer)
        const addButtons = document.querySelectorAll('.add-terminal-btn');
        addButtons.forEach((btn, index) => {
            if (terminalCount >= 4) {
                btn.style.display = 'none';
            } else {
                // Show add button only on the last terminal
                btn.style.display = index === terminalCount - 1 ? 'inline-flex' : 'none';
            }
        });
    }

    async closeTerminal(terminalId) {
        if (this.terminals.size <= 1) {
            this.gui.logAction('Cannot close the last terminal', 'warning');
            return;
        }

        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) {
            this.gui.logAction(`Terminal ${terminalId} not found`, 'error');
            return;
        }

        // Mark as closing to prevent further operations
        terminalData.isClosing = true;

        // Close backend session if exists
        const sessionId = this.terminalSessionMap.get(terminalId);
        if (sessionId && this.gui.backendAPIClient) {
            try {
                await this.gui.backendAPIClient.deleteTerminalSession(sessionId);
                this.terminalSessionMap.delete(terminalId);
                await this.saveTerminalSessionMapping();
                this.gui.logAction(`Closed backend session for Terminal ${terminalId}`, 'info');
            } catch (error) {
                console.error('Failed to close backend session:', error);
            }
        }

        // Clean up terminal
        terminalData.terminal.dispose();
        this.terminals.delete(terminalId);
        this.terminalStatuses.delete(terminalId);
        this.terminalStabilityTracking.delete(terminalId);
        
        // Clear stability timers
        if (this.terminalStabilityTimers.has(terminalId)) {
            clearTimeout(this.terminalStabilityTimers.get(terminalId));
            this.terminalStabilityTimers.delete(terminalId);
        }

        // Remove DOM element
        const terminalWrapper = document.querySelector(`[data-terminal-id="${terminalId}"]`);
        if (terminalWrapper) {
            terminalWrapper.remove();
        }

        // Update container layout
        const terminalsContainer = document.getElementById('terminals-container');
        terminalsContainer.setAttribute('data-terminal-count', this.terminals.size);

        // Switch to different terminal if this was active
        if (this.activeTerminalId === terminalId) {
            const remainingTerminals = Array.from(this.terminals.keys());
            if (remainingTerminals.length > 0) {
                this.activeTerminalId = remainingTerminals[0];
                const newActiveTerminal = this.terminals.get(this.activeTerminalId);
                this.terminal = newActiveTerminal.terminal;
                this.fitAddon = newActiveTerminal.fitAddon;
                this.updateActiveTerminalUI();
                newActiveTerminal.terminal.focus();
            }
        }

        // Update button visibility
        this.updateTerminalButtonVisibility();

        // Resize remaining terminals
        setTimeout(() => {
            this.resizeAllTerminals();
        }, 100);

        // Send close signal to main process
        this.gui.ipcRenderer?.send('terminal-exit', { terminalId: terminalId });

        this.gui.logAction(`Closed Terminal ${terminalId}`, 'info');

        // Save terminal state
        await this.saveTerminalState();
    }

    switchToTerminal(terminalId) {
        const terminalData = this.terminals.get(terminalId);
        if (!terminalData) {
            this.gui.logAction(`Terminal ${terminalId} not found`, 'error');
            return;
        }

        this.activeTerminalId = terminalId;
        this.terminal = terminalData.terminal;
        this.fitAddon = terminalData.fitAddon;
        
        this.updateActiveTerminalUI();
        terminalData.terminal.focus();
        
        this.gui.logAction(`Switched to Terminal ${terminalId}`, 'info');
    }

    updateTerminalDropdowns() {
        // Update any dropdowns that list terminals
        // This would be implemented based on specific UI requirements
    }

    updateManualTerminalDropdown() {
        // Update manual terminal selection dropdown
        // This would be implemented based on specific UI requirements
    }

    async saveTerminalState() {
        const terminalStates = Array.from(this.terminals.values()).map(terminalData => ({
            id: terminalData.id,
            color: terminalData.color,
            status: terminalData.status,
            directory: terminalData.directory
        }));

        this.gui.preferences.terminalStates = terminalStates;
        this.gui.saveAllPreferences();
    }

    async saveTerminalSessionMapping() {
        const mapping = Object.fromEntries(this.terminalSessionMap);
        await this.gui.ipcRenderer?.invoke('db-save-setting', 'terminalSessionMapping', mapping);
    }

    // Get active terminal data
    getActiveTerminal() {
        return this.terminals.get(this.activeTerminalId);
    }

    // Get terminal by ID
    getTerminal(terminalId) {
        return this.terminals.get(terminalId);
    }

    // Get all terminal IDs
    getTerminalIds() {
        return Array.from(this.terminals.keys());
    }

    // Update terminal status
    updateTerminalStatus(terminalId, status) {
        const terminalData = this.terminals.get(terminalId);
        if (terminalData) {
            terminalData.status = status;
            terminalData.lastActivity = Date.now();
        }

        const terminalStatus = this.terminalStatuses.get(terminalId);
        if (terminalStatus) {
            terminalStatus.lastUpdate = Date.now();
        }
    }

    // Set current directory
    setCurrentDirectory(directory) {
        this.currentDirectory = directory;
        this.gui.preferences.currentDirectory = directory;
        this.gui.saveAllPreferences();
        this.updateRecentDirectories(directory);
    }
}

module.exports = TerminalManager;