/**
 * Terminal Manager
 * Handles creation, management, and coordination of multiple terminal instances
 */

const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const { WebLinksAddon } = require('@xterm/addon-web-links');

class TerminalManager {
    constructor(ipcHandler, preferences = {}) {
        this.ipcHandler = ipcHandler;
        this.preferences = preferences;
        
        // Terminal management
        this.terminals = new Map(); // Map of terminal ID to terminal data
        this.activeTerminalId = 1;
        this.terminalIdCounter = 1;
        this.terminalColors = ['#007acc', '#28ca42', '#ff5f57', '#ffbe2e', '#af52de', '#5ac8fa'];
        this.terminalSessionMap = new Map(); // Map of terminal ID to backend session UUID
        this.terminalStatuses = new Map(); // Per-terminal status tracking
        
        // Legacy references for backward compatibility
        this.terminal = null;
        this.fitAddon = null;
        
        this.currentDirectory = null;
    }

    // ========================================
    // Terminal Theme Configuration
    // ========================================

    /**
     * Get terminal theme based on preferences
     * @returns {Object} Terminal theme configuration
     */
    getTerminalTheme() {
        const currentTheme = this.preferences.theme || 'dark';
        
        // Check for system theme if 'system' is selected
        if (currentTheme === 'system') {
            const isSystemLight = window.matchMedia('(prefers-color-scheme: light)').matches;
            return isSystemLight ? this.getLightTerminalTheme() : this.getDarkTerminalTheme();
        }
        
        return currentTheme === 'light' ? this.getLightTerminalTheme() : this.getDarkTerminalTheme();
    }

    /**
     * Get dark terminal theme
     * @returns {Object} Dark theme configuration
     */
    getDarkTerminalTheme() {
        return {
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
        };
    }

    /**
     * Get light terminal theme
     * @returns {Object} Light theme configuration
     */
    getLightTerminalTheme() {
        return {
            background: '#ffffff',
            foreground: '#000000',
            cursor: '#000000',
            cursorAccent: '#ffffff',
            selection: '#c7c7c7',
            black: '#000000',
            red: '#de3e35',
            green: '#00b32d',
            yellow: '#ff8c00',
            blue: '#006bb3',
            magenta: '#a348a3',
            cyan: '#00a3cc',
            white: '#bbbbbb',
            brightBlack: '#666666',
            brightRed: '#ff6e67',
            brightGreen: '#32d74b',
            brightYellow: '#ffcc02',
            brightBlue: '#007aff',
            brightMagenta: '#bf5af2',
            brightCyan: '#64d8ff',
            brightWhite: '#ffffff'
        };
    }

    // ========================================
    // Terminal Creation and Management
    // ========================================

    /**
     * Create a new terminal instance
     * @param {number} id - Terminal ID
     * @returns {Object} Terminal data object
     */
    createTerminal(id) {
        const color = this.terminalColors[(id - 1) % this.terminalColors.length];
        
        // Create terminal instance
        // Platform-specific terminal options
        const isWindows = navigator.platform.toLowerCase().includes('win');
        const terminalOptions = {
            theme: this.getTerminalTheme(),
            fontFamily: isWindows ? 'Consolas, "Courier New", monospace' : 'Monaco, Menlo, "Consolas", "Courier New", monospace',
            fontSize: 12,
            lineHeight: 1.2,
            cursorBlink: true,
            cursorStyle: 'block',
            scrollback: 1000,
            tabStopWidth: 4,
            allowTransparency: false,
            convertEol: isWindows, // Convert \n to \r\n on Windows
            windowsMode: isWindows, // Enable Windows-specific behavior
            fastScrollModifier: isWindows ? 'shift' : 'alt', // Use Shift for fast scroll on Windows
            rightClickSelectsWord: true,
            macOptionIsMeta: !isWindows // Only enable on non-Windows
        };
        
        const terminal = new Terminal(terminalOptions);

        // Add addons
        const fitAddon = new FitAddon();
        const searchAddon = new SearchAddon();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(searchAddon);
        terminal.loadAddon(new WebLinksAddon());

        // Store terminal data
        const terminalData = {
            id,
            terminal,
            fitAddon,
            searchAddon,
            color,
            name: `Terminal ${id}`,
            directory: this.preferences.currentDirectory || null,
            lastOutput: '',
            status: '',
            userInteracting: false,
            searchVisible: false
        };
        
        this.terminals.set(id, terminalData);
        
        // Initialize status tracking for this terminal
        this.terminalStatuses.set(id, {
            isRunning: false,
            isPrompting: false,
            lastUpdate: Date.now()
        });
        
        // Open terminal in container
        const terminalContainer = document.querySelector(`[data-terminal-container="${id}"]`);
        if (terminalContainer) {
            terminal.open(terminalContainer);
            
            // Store the terminal container element for later access
            terminalData.element = terminalContainer;
            
            // Fit terminal to container
            setTimeout(() => {
                fitAddon.fit();
            }, 10);
            
            // Handle terminal input
            terminal.onData((data) => {
                this.ipcHandler.sendTerminalInput(id, data);
            });

            // Add click handler to focus terminal when clicked
            terminalContainer.addEventListener('click', () => {
                console.log('Terminal container clicked, focusing terminal:', id);
                terminal.focus();
                this.switchToTerminal(id);
            });

            // Handle terminal resize
            terminal.onResize(({ cols, rows }) => {
                this.ipcHandler.resizeTerminal(id, cols, rows);
            });
        }
        
        // If this is the first terminal, set legacy references and start terminal process
        if (id === 1) {
            this.terminal = terminal;
            this.fitAddon = fitAddon;
            
            // Load saved directory
            const savedDirectory = this.preferences.currentDirectory;
            console.log('Starting terminal with saved directory:', savedDirectory);
            
            if (savedDirectory) {
                this.currentDirectory = savedDirectory;
                terminalData.directory = savedDirectory;
            }
            
            console.log('Sending terminal-start IPC message...');
            this.ipcHandler.startTerminal(id, savedDirectory);
            
            if (!savedDirectory) {
                console.log('Requesting current working directory...');
                this.ipcHandler.getCurrentWorkingDirectory(id);
            }
        }
        
        // Update terminal ID counter if needed
        if (id > this.terminalIdCounter) {
            this.terminalIdCounter = id;
        }
        
        return terminalData;
    }

    /**
     * Create additional terminal from saved data
     * @param {Object} termData - Saved terminal data
     * @returns {Object} Created terminal data
     */
    createAdditionalTerminalFromData(termData) {
        const id = termData.id;
        const color = termData.color || this.terminalColors[(id - 1) % this.terminalColors.length];
        
        // Create terminal wrapper
        const terminalWrapper = document.createElement('div');
        terminalWrapper.className = 'terminal-wrapper';
        terminalWrapper.setAttribute('data-terminal-id', id);
        terminalWrapper.style.display = id === this.activeTerminalId ? 'block' : 'none';
        
        // Create terminal container
        const terminalContainer = document.createElement('div');
        terminalContainer.className = 'terminal-container';
        terminalContainer.setAttribute('data-terminal-container', id);
        terminalContainer.style.height = '100%';
        terminalWrapper.appendChild(terminalContainer);
        
        // Add to terminals container
        const terminalsContainer = document.getElementById('terminals-container');
        terminalsContainer.appendChild(terminalWrapper);
        
        // Create the actual terminal
        const createdTerminalData = this.createTerminal(id);
        
        // Restore terminal properties from saved data
        if (termData.name) {
            createdTerminalData.name = termData.name;
        }
        if (termData.directory) {
            createdTerminalData.directory = termData.directory;
        }
        
        // Start terminal process
        this.ipcHandler.startTerminal(id, termData.directory || this.currentDirectory);
        
        // Update terminal counter
        this.terminalIdCounter = Math.max(this.terminalIdCounter, id);
        
        return createdTerminalData;
    }

    /**
     * Switch to a specific terminal
     * @param {number} terminalId - ID of terminal to switch to
     */
    switchToTerminal(terminalId) {
        if (!this.terminals.has(terminalId)) {
            console.warn(`Terminal ${terminalId} not found`);
            return;
        }

        // Hide all terminals
        this.terminals.forEach((terminalData, id) => {
            const wrapper = document.querySelector(`[data-terminal-id="${id}"]`);
            if (wrapper) {
                wrapper.style.display = 'none';
            }
        });

        // Show target terminal
        const wrapper = document.querySelector(`[data-terminal-id="${terminalId}"]`);
        if (wrapper) {
            wrapper.style.display = 'block';
        }

        // Update active terminal
        this.activeTerminalId = terminalId;
        const terminalData = this.terminals.get(terminalId);
        
        // Update legacy references
        this.terminal = terminalData.terminal;
        this.fitAddon = terminalData.fitAddon;
        
        // Focus the terminal
        setTimeout(() => {
            terminalData.terminal.focus();
            terminalData.fitAddon.fit();
        }, 10);

        // Update UI
        this.updateTerminalSelector();
    }

    /**
     * Close a terminal
     * @param {number} terminalId - ID of terminal to close
     */
    closeTerminal(terminalId) {
        if (!this.terminals.has(terminalId) || this.terminals.size <= 1) {
            console.warn('Cannot close terminal - invalid ID or last terminal');
            return;
        }

        const terminalData = this.terminals.get(terminalId);
        
        // Mark terminal as closing to prevent further operations
        terminalData.isClosing = true;
        
        // Dispose of terminal
        terminalData.terminal.dispose();
        
        // Remove from DOM
        const wrapper = document.querySelector(`[data-terminal-id="${terminalId}"]`);
        if (wrapper) {
            wrapper.remove();
        }
        
        // Remove from maps
        this.terminals.delete(terminalId);
        this.terminalStatuses.delete(terminalId);
        this.terminalSessionMap.delete(terminalId);
        
        // Switch to another terminal if this was active
        if (this.activeTerminalId === terminalId) {
            const remainingTerminals = Array.from(this.terminals.keys());
            if (remainingTerminals.length > 0) {
                this.switchToTerminal(remainingTerminals[0]);
            }
        }
        
        this.updateTerminalSelector();
    }

    /**
     * Add a new terminal
     * @returns {number} ID of the new terminal
     */
    addNewTerminal() {
        const newId = this.terminalIdCounter + 1;
        
        // Create terminal wrapper in DOM first
        const terminalWrapper = document.createElement('div');
        terminalWrapper.className = 'terminal-wrapper';
        terminalWrapper.setAttribute('data-terminal-id', newId);
        terminalWrapper.style.display = 'none'; // Hidden initially
        
        const terminalContainer = document.createElement('div');
        terminalContainer.className = 'terminal-container';
        terminalContainer.setAttribute('data-terminal-container', newId);
        terminalContainer.style.height = '100%';
        terminalWrapper.appendChild(terminalContainer);
        
        const terminalsContainer = document.getElementById('terminals-container');
        terminalsContainer.appendChild(terminalWrapper);
        
        // Create the terminal
        this.createTerminal(newId);
        
        // Switch to new terminal
        this.switchToTerminal(newId);
        
        this.updateTerminalSelector();
        
        return newId;
    }

    // ========================================
    // Terminal Utilities
    // ========================================

    /**
     * Resize all terminals to fit their containers
     */
    resizeAllTerminals() {
        this.terminals.forEach((terminalData) => {
            terminalData.fitAddon.fit();
        });
    }

    /**
     * Get terminal data by ID
     * @param {number} terminalId - Terminal ID
     * @returns {Object|null} Terminal data or null if not found
     */
    getTerminal(terminalId) {
        return this.terminals.get(terminalId) || null;
    }

    /**
     * Get active terminal data
     * @returns {Object|null} Active terminal data or null
     */
    getActiveTerminal() {
        return this.terminals.get(this.activeTerminalId) || null;
    }

    /**
     * Get all terminal IDs
     * @returns {Array<number>} Array of terminal IDs
     */
    getTerminalIds() {
        return Array.from(this.terminals.keys());
    }

    /**
     * Check if terminal exists
     * @param {number} terminalId - Terminal ID to check
     * @returns {boolean} True if terminal exists
     */
    hasTerminal(terminalId) {
        return this.terminals.has(terminalId);
    }

    /**
     * Apply theme to all terminals
     * @param {string} theme - Theme name ('light', 'dark', 'system')
     */
    applyTheme(theme) {
        this.preferences.theme = theme;
        const terminalTheme = this.getTerminalTheme();
        
        this.terminals.forEach((terminalData) => {
            terminalData.terminal.options.theme = terminalTheme;
        });
    }

    /**
     * Update terminal selector UI (to be implemented by parent class)
     */
    updateTerminalSelector() {
        // This should be implemented by the main application class
        // Left as a placeholder for integration
        console.log('updateTerminalSelector called - should be implemented by parent');
    }

    /**
     * Update terminal status
     * @param {number} terminalId - Terminal ID
     * @param {Object} status - Status object
     */
    updateTerminalStatus(terminalId, status) {
        if (this.terminalStatuses.has(terminalId)) {
            const currentStatus = this.terminalStatuses.get(terminalId);
            this.terminalStatuses.set(terminalId, {
                ...currentStatus,
                ...status,
                lastUpdate: Date.now()
            });
        }
    }

    /**
     * Get terminal status
     * @param {number} terminalId - Terminal ID
     * @returns {Object|null} Terminal status or null
     */
    getTerminalStatus(terminalId) {
        return this.terminalStatuses.get(terminalId) || null;
    }

    /**
     * Update terminal color
     * @param {number} terminalId - Terminal ID
     * @param {string} color - New color hex value
     */
    updateTerminalColor(terminalId, color) {
        const terminalData = this.terminals.get(terminalId);
        if (terminalData) {
            terminalData.color = color;
            console.log(`Updated terminal ${terminalId} color to ${color}`);
        }
    }

    /**
     * Write data to terminal
     * @param {number} terminalId - Terminal ID
     * @param {string} data - Data to write
     */
    writeToTerminal(terminalId, data) {
        const terminalData = this.terminals.get(terminalId);
        if (terminalData && !terminalData.isClosing) {
            terminalData.terminal.write(data);
        }
    }

    /**
     * Set terminal directory
     * @param {number} terminalId - Terminal ID
     * @param {string} directory - Directory path
     */
    setTerminalDirectory(terminalId, directory) {
        const terminalData = this.terminals.get(terminalId);
        if (terminalData) {
            terminalData.directory = directory;
            if (terminalId === this.activeTerminalId) {
                this.currentDirectory = directory;
            }
        }
    }

    /**
     * Get serializable terminal data for persistence
     * @returns {Array} Array of serializable terminal data
     */
    getSerializableTerminalData() {
        const terminalDataArray = [];
        
        this.terminals.forEach((terminalData, id) => {
            terminalDataArray.push({
                id: id,
                name: terminalData.name,
                directory: terminalData.directory,
                color: terminalData.color,
                status: terminalData.status
            });
        });
        
        return terminalDataArray;
    }

    /**
     * Clean up all terminals
     */
    cleanup() {
        this.terminals.forEach((terminalData) => {
            terminalData.terminal.dispose();
        });
        
        this.terminals.clear();
        this.terminalStatuses.clear();
        this.terminalSessionMap.clear();
    }
}

module.exports = TerminalManager;