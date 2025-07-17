/**
 * Terminal Utils Module
 * 
 * Terminal creation, management, and helper functions
 * Extracted from TerminalGUI for better modularity
 */

class TerminalUtils {
    constructor(logAction) {
        this.logAction = logAction || console.log;
        this.terminalColors = [
            '#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57',
            '#ff9ff3', '#54a0ff', '#5f27cd', '#00d2d3', '#ff9f43'
        ];
        this.currentColorIndex = 0;
    }

    /**
     * Create new terminal instance
     * @param {string} terminalId - Terminal identifier
     * @param {Object} options - Terminal creation options
     * @returns {Object} - Terminal creation result
     */
    async createTerminal(terminalId, options = {}) {
        try {
            const { Terminal } = await import('@xterm/xterm');
            const { FitAddon } = await import('@xterm/addon-fit');
            const { SearchAddon } = await import('@xterm/addon-search');
            const { WebLinksAddon } = await import('@xterm/addon-web-links');

            // Create terminal instance
            const terminal = new Terminal({
                theme: options.theme || this.getDarkTerminalTheme(),
                fontSize: options.fontSize || 14,
                fontFamily: options.fontFamily || 'Menlo, Monaco, "Courier New", monospace',
                cursorBlink: options.cursorBlink !== false,
                scrollback: options.scrollback || 10000,
                allowTransparency: options.allowTransparency || false,
                ...options.terminalOptions
            });

            // Create addons
            const fitAddon = new FitAddon();
            const searchAddon = new SearchAddon();
            const webLinksAddon = new WebLinksAddon();

            // Load addons
            terminal.loadAddon(fitAddon);
            terminal.loadAddon(searchAddon);
            terminal.loadAddon(webLinksAddon);

            // Create terminal container
            const container = this.createTerminalContainer(terminalId, options);
            
            // Open terminal in container
            const terminalElement = container.querySelector('.xterm-container');
            terminal.open(terminalElement);

            // Fit terminal to container
            fitAddon.fit();

            // Get terminal color
            const color = this.getNextTerminalColor();

            const terminalData = {
                terminal,
                fitAddon,
                searchAddon,
                webLinksAddon,
                container,
                element: terminalElement,
                id: terminalId,
                color,
                lastOutput: '',
                status: 'ready',
                userInteracting: false,
                createdAt: new Date(),
                isActive: false
            };

            this.logAction(`Terminal ${terminalId} created successfully`, 'info');
            return { success: true, terminalData };

        } catch (error) {
            this.logAction(`Failed to create terminal ${terminalId}: ${error.message}`, 'error');
            return { success: false, error: error.message };
        }
    }

    /**
     * Create terminal container DOM element
     * @param {string} terminalId - Terminal identifier
     * @param {Object} options - Container options
     * @returns {HTMLElement} - Terminal container element
     */
    createTerminalContainer(terminalId, options = {}) {
        const container = document.createElement('div');
        container.className = 'terminal-container';
        container.id = `terminal-${terminalId}`;
        container.dataset.terminalId = terminalId;

        // Create terminal header
        const header = document.createElement('div');
        header.className = 'terminal-header';
        
        const title = document.createElement('div');
        title.className = 'terminal-title';
        title.textContent = `Terminal ${this.getTerminalDisplayNumber(terminalId)}`;
        
        const controls = document.createElement('div');
        controls.className = 'terminal-controls';
        
        // Status indicator
        const status = document.createElement('div');
        status.className = 'terminal-status';
        status.textContent = 'Ready';
        
        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'terminal-close';
        closeBtn.innerHTML = '×';
        closeBtn.title = 'Close Terminal';
        closeBtn.addEventListener('click', () => {
            this.requestTerminalClose(terminalId);
        });

        controls.appendChild(status);
        controls.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(controls);

        // Create terminal content area
        const content = document.createElement('div');
        content.className = 'terminal-content';
        
        const xtermContainer = document.createElement('div');
        xtermContainer.className = 'xterm-container';
        
        content.appendChild(xtermContainer);
        container.appendChild(header);
        container.appendChild(content);

        // Apply terminal color
        if (options.color) {
            container.style.borderColor = options.color;
            header.style.borderBottomColor = options.color;
        }

        return container;
    }

    /**
     * Get next terminal color for visual distinction
     * @returns {string} - Hex color code
     */
    getNextTerminalColor() {
        const color = this.terminalColors[this.currentColorIndex];
        this.currentColorIndex = (this.currentColorIndex + 1) % this.terminalColors.length;
        return color;
    }

    /**
     * Get terminal display number from ID
     * @param {string} terminalId - Terminal identifier
     * @returns {string} - Display number
     */
    getTerminalDisplayNumber(terminalId) {
        // Extract number from terminal ID or use the ID itself
        const match = terminalId.match(/\d+/);
        return match ? match[0] : terminalId;
    }

    /**
     * Switch active terminal
     * @param {string} terminalId - Terminal to activate
     * @param {Map} terminals - Terminals map
     * @returns {boolean} - Success status
     */
    switchToTerminal(terminalId, terminals) {
        if (!terminals || !terminals.has(terminalId)) {
            this.logAction(`Cannot switch to terminal ${terminalId}: not found`, 'error');
            return false;
        }

        // Hide all terminal containers
        terminals.forEach((terminalData, id) => {
            const container = terminalData.container;
            if (container) {
                container.classList.remove('active');
                terminalData.isActive = false;
            }
        });

        // Show selected terminal
        const targetTerminal = terminals.get(terminalId);
        if (targetTerminal.container) {
            targetTerminal.container.classList.add('active');
            targetTerminal.isActive = true;
            
            // Fit terminal to new size
            if (targetTerminal.fitAddon) {
                setTimeout(() => {
                    targetTerminal.fitAddon.fit();
                }, 50);
            }
        }

        this.logAction(`Switched to terminal ${terminalId}`, 'info');
        return true;
    }

    /**
     * Resize all terminals to fit their containers
     * @param {Map} terminals - Terminals map
     */
    resizeAllTerminals(terminals) {
        if (!terminals) return;

        terminals.forEach((terminalData, terminalId) => {
            try {
                if (terminalData.fitAddon && terminalData.isActive) {
                    terminalData.fitAddon.fit();
                }
            } catch (error) {
                this.logAction(`Failed to resize terminal ${terminalId}: ${error.message}`, 'error');
            }
        });
    }

    /**
     * Update terminal dropdown selectors
     * @param {Map} terminals - Terminals map
     * @param {string} activeTerminalId - Currently active terminal
     */
    updateTerminalDropdowns(terminals, activeTerminalId) {
        const dropdowns = document.querySelectorAll('.terminal-dropdown');
        
        dropdowns.forEach(dropdown => {
            dropdown.innerHTML = '';
            
            // Add "Current Terminal" option
            const currentOption = document.createElement('option');
            currentOption.value = 'current';
            currentOption.textContent = 'Current Terminal';
            dropdown.appendChild(currentOption);

            // Add "All Terminals" option
            const allOption = document.createElement('option');
            allOption.value = 'all';
            allOption.textContent = 'All Terminals';
            dropdown.appendChild(allOption);

            // Add individual terminals
            terminals.forEach((terminalData, terminalId) => {
                const option = document.createElement('option');
                option.value = terminalId;
                option.textContent = `Terminal ${this.getTerminalDisplayNumber(terminalId)}`;
                
                if (terminalId === activeTerminalId) {
                    option.textContent += ' (Active)';
                }
                
                dropdown.appendChild(option);
            });
        });
    }

    /**
     * Update terminal status indicators
     * @param {Map} terminals - Terminals map
     * @param {Map} terminalStatuses - Terminal statuses map
     */
    updateTerminalStatusIndicator(terminals, terminalStatuses) {
        if (!terminals || !terminalStatuses) return;

        terminals.forEach((terminalData, terminalId) => {
            const status = terminalStatuses.get(terminalId);
            const statusElement = terminalData.container?.querySelector('.terminal-status');
            
            if (statusElement && status) {
                const { isRunning, isPrompting } = status;
                
                let statusText = 'Ready';
                let statusClass = 'ready';
                
                if (isRunning) {
                    statusText = 'Running';
                    statusClass = 'running';
                } else if (isPrompting) {
                    statusText = 'Prompting';
                    statusClass = 'prompting';
                }
                
                statusElement.textContent = statusText;
                statusElement.className = `terminal-status ${statusClass}`;
                terminalData.status = statusClass;
            }
        });
    }

    /**
     * Get dark terminal theme configuration
     * @returns {Object} - Dark theme configuration
     */
    getDarkTerminalTheme() {
        return {
            background: '#1a1a1a',
            foreground: '#ffffff',
            cursor: '#ffffff',
            cursorAccent: '#000000',
            selection: '#ffffff40',
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

    /**
     * Get light terminal theme configuration
     * @returns {Object} - Light theme configuration
     */
    getLightTerminalTheme() {
        return {
            background: '#ffffff',
            foreground: '#000000',
            cursor: '#000000',
            cursorAccent: '#ffffff',
            selection: '#00000040',
            black: '#000000',
            red: '#da3633',
            green: '#007427',
            yellow: '#b08500',
            blue: '#0451a5',
            magenta: '#bc05bc',
            cyan: '#0598bc',
            white: '#595959',
            brightBlack: '#303030',
            brightRed: '#cd3131',
            brightGreen: '#00bc00',
            brightYellow: '#949800',
            brightBlue: '#0451a5',
            brightMagenta: '#bc05bc',
            brightCyan: '#0598bc',
            brightWhite: '#000000'
        };
    }

    /**
     * Get terminal theme based on theme name
     * @param {string} theme - Theme name ('dark' or 'light')
     * @returns {Object} - Terminal theme configuration
     */
    getTerminalTheme(theme = 'dark') {
        return theme === 'light' ? this.getLightTerminalTheme() : this.getDarkTerminalTheme();
    }

    /**
     * Apply theme to all terminals
     * @param {Map} terminals - Terminals map
     * @param {string} theme - Theme name
     */
    applyThemeToAllTerminals(terminals, theme) {
        if (!terminals) return;

        const terminalTheme = this.getTerminalTheme(theme);
        
        terminals.forEach((terminalData, terminalId) => {
            try {
                if (terminalData.terminal) {
                    terminalData.terminal.options.theme = terminalTheme;
                }
            } catch (error) {
                this.logAction(`Failed to apply theme to terminal ${terminalId}: ${error.message}`, 'error');
            }
        });

        this.logAction(`Applied ${theme} theme to all terminals`, 'info');
    }

    /**
     * Get available terminal list for selection
     * @param {Map} terminals - Terminals map
     * @returns {Array} - Array of terminal info objects
     */
    getAvailableTerminals(terminals) {
        if (!terminals) return [];

        return Array.from(terminals.entries()).map(([terminalId, terminalData]) => ({
            id: terminalId,
            number: this.getTerminalDisplayNumber(terminalId),
            color: terminalData.color,
            status: terminalData.status,
            isActive: terminalData.isActive,
            createdAt: terminalData.createdAt
        }));
    }

    /**
     * Find optimal terminal for message assignment
     * @param {Map} terminals - Terminals map
     * @param {Map} terminalStatuses - Terminal statuses map
     * @param {string} preferredTerminalId - Preferred terminal ID
     * @returns {string|null} - Optimal terminal ID or null
     */
    findOptimalTerminal(terminals, terminalStatuses, preferredTerminalId = null) {
        if (!terminals || terminals.size === 0) return null;

        // If preferred terminal is specified and available, use it
        if (preferredTerminalId && terminals.has(preferredTerminalId)) {
            return preferredTerminalId;
        }

        // Find ready terminals (not running or prompting)
        const readyTerminals = Array.from(terminals.keys()).filter(terminalId => {
            const status = terminalStatuses?.get(terminalId);
            return status && !status.isRunning && !status.isPrompting;
        });

        if (readyTerminals.length > 0) {
            // Return the first ready terminal
            return readyTerminals[0];
        }

        // If no ready terminals, return the first available terminal
        return Array.from(terminals.keys())[0];
    }

    /**
     * Get clean terminal output for analysis
     * @param {Object} terminalData - Terminal data object
     * @param {number} maxLines - Maximum lines to extract
     * @returns {string} - Clean terminal output
     */
    getCleanTerminalOutput(terminalData, maxLines = 100) {
        if (!terminalData || !terminalData.terminal) return '';

        try {
            const terminal = terminalData.terminal;
            const buffer = terminal.buffer.active;
            const endLine = buffer.baseY + buffer.cursorY;
            const startLine = Math.max(0, endLine - maxLines);
            
            let output = '';
            for (let i = startLine; i <= endLine; i++) {
                const line = buffer.getLine(i);
                if (line) {
                    output += line.translateToString(true) + '\n';
                }
            }
            
            // Clean ANSI codes and trim whitespace
            return this.stripAnsiCodes(output).trim();
        } catch (error) {
            this.logAction(`Failed to get clean output: ${error.message}`, 'error');
            return terminalData.lastOutput || '';
        }
    }

    /**
     * Strip ANSI escape codes from text
     * @param {string} text - Text with ANSI codes
     * @returns {string} - Clean text
     */
    stripAnsiCodes(text) {
        return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    }

    /**
     * Extract relevant output for analysis (last meaningful section)
     * @param {string} terminalOutput - Full terminal output
     * @returns {string} - Relevant output section
     */
    extractRelevantOutput(terminalOutput) {
        if (!terminalOutput) return '';

        // Split by common command prompts and take the last section
        const sections = terminalOutput.split(/[$#>]\s+/);
        const lastSection = sections[sections.length - 1];
        
        // Return last 2000 characters of the relevant section
        return lastSection.slice(-2000).trim();
    }

    /**
     * Get terminal session mapping info
     * @param {string} terminalId - Terminal identifier
     * @param {Map} sessionMapping - Session mapping
     * @returns {Object} - Session info
     */
    getTerminalSessionInfo(terminalId, sessionMapping) {
        const sessionId = sessionMapping?.get(terminalId);
        const terminalNumber = this.getTerminalDisplayNumber(terminalId);
        
        return {
            terminalId,
            terminalNumber,
            sessionId,
            hasSession: !!sessionId
        };
    }

    /**
     * Request terminal close (to be handled by parent)
     * @param {string} terminalId - Terminal to close
     */
    requestTerminalClose(terminalId) {
        // This would trigger an event that the parent TerminalGUI can handle
        const event = new CustomEvent('terminal-close-requested', {
            detail: { terminalId }
        });
        document.dispatchEvent(event);
    }

    /**
     * Setup terminal interaction handlers
     * @param {Object} terminalData - Terminal data object
     * @param {Object} handlers - Event handlers
     */
    setupTerminalInteractionHandlers(terminalData, handlers = {}) {
        if (!terminalData.terminal) return;

        const terminal = terminalData.terminal;

        // Mouse interaction detection
        terminalData.container.addEventListener('mousedown', () => {
            terminalData.userInteracting = true;
            if (handlers.onInteractionStart) {
                handlers.onInteractionStart(terminalData.id);
            }
        });

        terminalData.container.addEventListener('mouseup', () => {
            setTimeout(() => {
                terminalData.userInteracting = false;
                if (handlers.onInteractionEnd) {
                    handlers.onInteractionEnd(terminalData.id);
                }
            }, 1000); // Grace period
        });

        // Terminal data handler
        terminal.onData(data => {
            if (handlers.onData) {
                handlers.onData(terminalData.id, data);
            }
        });

        // Resize handler
        terminal.onResize(({ cols, rows }) => {
            if (handlers.onResize) {
                handlers.onResize(terminalData.id, cols, rows);
            }
        });

        // Selection change handler
        terminal.onSelectionChange(() => {
            if (handlers.onSelectionChange) {
                handlers.onSelectionChange(terminalData.id, terminal.getSelection());
            }
        });
    }

    /**
     * Dispose terminal and clean up resources
     * @param {Object} terminalData - Terminal data object
     */
    disposeTerminal(terminalData) {
        if (!terminalData) return;

        try {
            // Dispose terminal instance
            if (terminalData.terminal) {
                terminalData.terminal.dispose();
            }

            // Remove container from DOM
            if (terminalData.container && terminalData.container.parentNode) {
                terminalData.container.parentNode.removeChild(terminalData.container);
            }

            this.logAction(`Terminal ${terminalData.id} disposed`, 'info');
        } catch (error) {
            this.logAction(`Error disposing terminal ${terminalData.id}: ${error.message}`, 'error');
        }
    }

    /**
     * Get terminal statistics
     * @param {Map} terminals - Terminals map
     * @returns {Object} - Terminal statistics
     */
    getTerminalStats(terminals) {
        if (!terminals) return { total: 0 };

        const stats = {
            total: terminals.size,
            active: 0,
            ready: 0,
            running: 0,
            prompting: 0
        };

        terminals.forEach(terminalData => {
            if (terminalData.isActive) stats.active++;
            
            switch (terminalData.status) {
                case 'ready': stats.ready++; break;
                case 'running': stats.running++; break;
                case 'prompting': stats.prompting++; break;
            }
        });

        return stats;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TerminalUtils;
} else if (typeof window !== 'undefined') {
    window.TerminalUtils = TerminalUtils;
}