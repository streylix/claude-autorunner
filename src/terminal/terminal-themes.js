/**
 * Terminal Themes Module
 * Handles terminal color themes and visual styling
 */

class TerminalThemes {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        this.terminals = terminalGUI.terminals;
    }

    getTerminalTheme() {
        const theme = this.gui.preferences.theme || 'dark';
        
        if (theme === 'light') {
            return this.getLightTerminalTheme();
        } else {
            return this.getDarkTerminalTheme();
        }
    }

    getDarkTerminalTheme() {
        return {
            background: '#1e1e1e',
            foreground: '#ffffff',
            cursor: '#ffffff',
            cursorAccent: '#1e1e1e',
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

    getLightTerminalTheme() {
        return {
            background: '#e6e9ef',
            foreground: '#4c4f69',
            cursor: '#4c4f69',
            cursorAccent: '#e6e9ef',
            selection: '#dce0e8',
            black: '#5c5f77',
            red: '#d20f39',
            green: '#40a02b',
            yellow: '#df8e1d',
            blue: '#1e66f5',
            magenta: '#ea76cb',
            cyan: '#179299',
            white: '#4c4f69',
            brightBlack: '#6c6f85',
            brightRed: '#d20f39',
            brightGreen: '#40a02b',
            brightYellow: '#df8e1d',
            brightBlue: '#1e66f5',
            brightMagenta: '#ea76cb',
            brightCyan: '#179299',
            brightWhite: '#4c4f69'
        };
    }

    applyTheme(theme) {
        // Apply theme to all existing terminals
        this.terminals.forEach((terminalData) => {
            if (terminalData.terminal && terminalData.terminal.options) {
                // Update terminal theme
                Object.assign(terminalData.terminal.options, this.getTerminalTheme());
                
                // Refresh terminal display if possible
                try {
                    terminalData.terminal.refresh(0, terminalData.terminal.rows - 1);
                } catch (error) {
                    console.warn('Failed to refresh terminal theme:', error);
                }
            }
        });

        // Update CSS theme
        this.applyUITheme(theme);
    }

    applyUITheme(theme) {
        const html = document.documentElement;
        
        // Remove existing theme attributes
        html.removeAttribute('data-theme');
        
        // Apply new theme
        if (theme && theme !== 'dark') {
            html.setAttribute('data-theme', theme);
        }
        
        // Update preference
        this.gui.preferences.theme = theme;
        this.gui.savePreferences();
        
        this.gui.logAction(`Applied ${theme} theme`, 'info');
    }

    // Get theme colors for UI elements
    getThemeColors() {
        const theme = this.gui.preferences.theme || 'dark';
        
        if (theme === 'light') {
            return {
                primary: '#4c4f69',
                secondary: '#5c5f77',
                background: '#eff1f5',
                backgroundSecondary: '#e6e9ef',
                border: '#dce0e8',
                accent: '#1e66f5',
                success: '#40a02b',
                warning: '#df8e1d',
                error: '#d20f39'
            };
        } else {
            return {
                primary: '#ffffff',
                secondary: '#cccccc',
                background: '#2d2d2d',
                backgroundSecondary: '#1e1e1e',
                border: '#3d3d3d',
                accent: '#007acc',
                success: '#28ca42',
                warning: '#ffbe2e',
                error: '#ff5f57'
            };
        }
    }

    // Initialize theme on startup
    initializeTheme() {
        const savedTheme = this.gui.preferences.theme || 'dark';
        this.applyTheme(savedTheme);
    }

    // Theme switching utilities
    toggleTheme() {
        const currentTheme = this.gui.preferences.theme || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        this.applyTheme(newTheme);
        return newTheme;
    }

    setTheme(theme) {
        const validThemes = ['dark', 'light', 'system'];
        if (validThemes.includes(theme)) {
            this.applyTheme(theme);
            return true;
        }
        return false;
    }

    // System theme detection
    detectSystemTheme() {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return 'dark';
        } else {
            return 'light';
        }
    }

    // Apply system theme if preference is set to 'system'
    applySystemThemeIfNeeded() {
        if (this.gui.preferences.theme === 'system') {
            const systemTheme = this.detectSystemTheme();
            this.applyUITheme(systemTheme);
        }
    }

    // Listen for system theme changes
    setupSystemThemeListener() {
        if (window.matchMedia) {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
            mediaQuery.addListener(() => {
                this.applySystemThemeIfNeeded();
            });
        }
    }
}

// Export for use in main TerminalGUI class
window.TerminalThemes = TerminalThemes;