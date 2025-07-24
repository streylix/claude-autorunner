/**
 * Modal Manager Module
 * Handles all modal dialogs and UI interactions
 */

class ModalManager {
    constructor(terminalGUI) {
        console.log('ModalManager constructor called');
        this.gui = terminalGUI;
        
        // Modal state tracking
        this.activeModals = new Set();
        this.modalStack = [];
        
        this.setupEventListeners();
        console.log('ModalManager initialized with event handlers');
    }

    setupEventListeners() {
        // Settings modal
        const settingsBtn = document.getElementById('settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                this.showSettingsModal();
            });
        }

        // Message history modal
        const messageHistoryBtn = document.getElementById('message-history-btn');
        if (messageHistoryBtn) {
            messageHistoryBtn.addEventListener('click', () => {
                this.showMessageHistoryModal();
            });
        }

        // Plans modal (if exists)
        const plansBtn = document.getElementById('plans-btn');
        if (plansBtn) {
            plansBtn.addEventListener('click', () => {
                this.showPlansModal();
            });
        }

        // Global modal event handlers
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeTopModal();
            }
        });

        // Terminal color dot click handlers - use setTimeout to ensure DOM is ready
        console.log('Adding terminal color dot click handler');
        setTimeout(() => {
            const existingDots = document.querySelectorAll('.terminal-color-dot');
            console.log('Existing color dots found:', existingDots.length, existingDots);
        }, 1000);
        
        document.addEventListener('click', (e) => {
            // Debug: log all clicks on elements that might be color dots
            if (e.target.className && e.target.className.includes('terminal')) {
                console.log('Terminal-related element clicked:', e.target.className, e.target);
            }
            
            if (e.target.classList.contains('terminal-color-dot')) {
                console.log('Color dot clicked!', e.target);
                e.preventDefault();
                e.stopPropagation();
                
                // Find terminal ID from the wrapper
                const terminalWrapper = e.target.closest('.terminal-wrapper');
                if (terminalWrapper) {
                    const terminalId = parseInt(terminalWrapper.dataset.terminalId);
                    const currentColor = e.target.style.backgroundColor;
                    
                    console.log('Terminal ID:', terminalId, 'Current color:', currentColor);
                    
                    // Convert RGB to hex if needed
                    const hexColor = this.rgbToHex(currentColor) || currentColor;
                    
                    this.showColorPickerModal(terminalId, hexColor, e);
                }
            }
        });

        // Click outside to close modals
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                // Use the GUI's closeModal method for consistency
                this.gui.closeModal(e.target.id);
            }
        });
    }

    showSettingsModal() {
        const modalId = 'settings-modal';
        
        if (this.isModalOpen(modalId)) {
            return;
        }

        const modal = this.createModal(modalId, 'Settings', this.getSettingsModalContent());
        this.openModal(modal);
        
        // Setup settings-specific event handlers
        this.setupSettingsEventHandlers(modal);
    }

    getSettingsModalContent() {
        return `
            <div class="settings-tabs">
                <button class="settings-tab active" data-tab="general">General</button>
                <button class="settings-tab" data-tab="timer">Timer</button>
                <button class="settings-tab" data-tab="injection">Injection</button>
                <button class="settings-tab" data-tab="keywords">Keywords</button>
                <button class="settings-tab" data-tab="sounds">Sounds</button>
                <button class="settings-tab" data-tab="background">Background</button>
                <button class="settings-tab" data-tab="advanced">Advanced</button>
            </div>
            
            <div class="settings-content">
                <div class="settings-panel active" data-panel="general">
                    ${this.getGeneralSettingsPanel()}
                </div>
                <div class="settings-panel" data-panel="timer">
                    ${this.getTimerSettingsPanel()}
                </div>
                <div class="settings-panel" data-panel="injection">
                    ${this.getInjectionSettingsPanel()}
                </div>
                <div class="settings-panel" data-panel="keywords">
                    ${this.getKeywordsSettingsPanel()}
                </div>
                <div class="settings-panel" data-panel="sounds">
                    ${this.getSoundsSettingsPanel()}
                </div>
                <div class="settings-panel" data-panel="background">
                    ${this.getBackgroundSettingsPanel()}
                </div>
                <div class="settings-panel" data-panel="advanced">
                    ${this.getAdvancedSettingsPanel()}
                </div>
            </div>
            
            <div class="settings-actions">
                <button id="save-settings" class="btn btn-primary">Save Settings</button>
                <button id="reset-settings" class="btn btn-secondary">Reset to Defaults</button>
                <button id="cancel-settings" class="btn btn-secondary">Cancel</button>
            </div>
        `;
    }

    getGeneralSettingsPanel() {
        return `
            <div class="setting-group">
                <h3>Theme</h3>
                <div class="setting-item">
                    <label for="theme-select">Application Theme:</label>
                    <select id="theme-select">
                        <option value="dark" ${this.gui.preferences.theme === 'dark' ? 'selected' : ''}>Dark</option>
                        <option value="light" ${this.gui.preferences.theme === 'light' ? 'selected' : ''}>Light</option>
                        <option value="system" ${this.gui.preferences.theme === 'system' ? 'selected' : ''}>System</option>
                    </select>
                </div>
            </div>
            
            
            <div class="setting-group">
                <h3>Directory</h3>
                <div class="setting-item">
                    <label for="current-directory">Current Directory:</label>
                    <input type="text" id="current-directory" value="${this.gui.currentDirectory || ''}" placeholder="Current working directory">
                    <button id="browse-directory" class="btn btn-small">Browse</button>
                </div>
            </div>
        `;
    }

    getTimerSettingsPanel() {
        return `
            <div class="setting-group">
                <h3>Default Timer</h3>
                <div class="setting-item">
                    <label for="default-duration">Default Duration:</label>
                    <input type="number" id="default-duration" value="${this.gui.preferences.defaultDuration}" min="1" max="999">
                </div>
                <div class="setting-item">
                    <label for="default-unit">Default Unit:</label>
                    <select id="default-unit">
                        <option value="seconds" ${this.gui.preferences.defaultUnit === 'seconds' ? 'selected' : ''}>Seconds</option>
                        <option value="minutes" ${this.gui.preferences.defaultUnit === 'minutes' ? 'selected' : ''}>Minutes</option>
                        <option value="hours" ${this.gui.preferences.defaultUnit === 'hours' ? 'selected' : ''}>Hours</option>
                    </select>
                </div>
            </div>
            
            <div class="setting-group">
                <h3>Timer Behavior</h3>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="timer-auto-start" ${this.gui.preferences.timerAutoStart ? 'checked' : ''}>
                        Auto-start timer when message is added
                    </label>
                </div>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="timer-auto-reset" ${this.gui.preferences.timerAutoReset ? 'checked' : ''}>
                        Auto-reset timer after injection
                    </label>
                </div>
            </div>
        `;
    }

    getInjectionSettingsPanel() {
        return `
            <div class="setting-group">
                <h3>Auto-Continue</h3>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="auto-continue-enabled" ${this.gui.preferences.autoContinueEnabled ? 'checked' : ''}>
                        Enable auto-continue
                    </label>
                </div>
                <div class="setting-item">
                    <label for="auto-continue-delay">Auto-continue delay (ms):</label>
                    <input type="number" id="auto-continue-delay" value="${this.gui.preferences.autoContinueDelay || 2000}" min="500" max="10000" step="500">
                </div>
            </div>
            
            <div class="setting-group">
                <h3>Plan Mode</h3>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="plan-mode-enabled" ${this.gui.preferences.planModeEnabled ? 'checked' : ''}>
                        Enable plan mode
                    </label>
                </div>
                <div class="setting-item">
                    <label for="plan-mode-command">Plan mode command:</label>
                    <textarea id="plan-mode-command" rows="3">${this.gui.preferences.planModeCommand || this.gui.planModeCommand}</textarea>
                </div>
            </div>
            
            <div class="setting-group">
                <h3>Typing Simulation</h3>
                <div class="setting-item">
                    <label for="typing-speed">Typing speed (chars/sec):</label>
                    <input type="number" id="typing-speed" value="${this.gui.preferences.typingSpeed || 50}" min="10" max="200" step="5">
                </div>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="typing-realistic" ${this.gui.preferences.typingRealistic ? 'checked' : ''}>
                        Realistic typing variation
                    </label>
                </div>
            </div>
        `;
    }

    getKeywordsSettingsPanel() {
        return `
            <div class="setting-group">
                <h3>Keyword Rules</h3>
                <div id="keyword-rules-list">
                    ${this.renderKeywordRules()}
                </div>
                <button id="add-keyword-rule" class="btn btn-secondary">Add Rule</button>
            </div>
            
            <div class="setting-group">
                <h3>Prompt Rules</h3>
                <div id="prompt-rules-list">
                    ${this.renderPromptRules()}
                </div>
                <button id="clear-prompt-rules" class="btn btn-secondary">Clear All Prompts</button>
            </div>
        `;
    }

    getSoundsSettingsPanel() {
        return `
            <div class="setting-group">
                <h3>Completion Sound</h3>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="completion-sound-enabled" ${this.gui.preferences.completionSoundEnabled ? 'checked' : ''}>
                        Enable completion sound
                    </label>
                </div>
                <div class="setting-item">
                    <label for="completion-sound-file">Completion sound file:</label>
                    <input type="text" id="completion-sound-file" value="${this.gui.preferences.completionSoundFile}">
                </div>
            </div>
            
            <div class="setting-group">
                <h3>Injection Sound</h3>
                <div class="setting-item">
                    <label for="injection-sound-file">Injection sound file:</label>
                    <input type="text" id="injection-sound-file" value="${this.gui.preferences.injectionSoundFile}">
                </div>
            </div>
            
            <div class="setting-group">
                <h3>Prompted Sound</h3>
                <div class="setting-item">
                    <label for="prompted-sound-file">Prompted sound file:</label>
                    <input type="text" id="prompted-sound-file" value="${this.gui.preferences.promptedSoundFile}">
                </div>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="prompted-sound-keywords-only" ${this.gui.preferences.promptedSoundKeywordsOnly ? 'checked' : ''}>
                        Only play on keyword prompts
                    </label>
                </div>
            </div>
        `;
    }

    getBackgroundSettingsPanel() {
        return `
            <div class="setting-group">
                <h3>Power Management</h3>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="keep-screen-awake" ${this.gui.preferences.keepScreenAwake ? 'checked' : ''}>
                        Keep screen awake during injection
                    </label>
                </div>
            </div>
            
            <div class="setting-group">
                <h3>Notifications</h3>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="show-system-notifications" ${this.gui.preferences.showSystemNotifications ? 'checked' : ''}>
                        Show system notifications
                    </label>
                </div>
            </div>
            
            <div class="setting-group">
                <h3>Window Behavior</h3>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="minimize-to-tray" ${this.gui.preferences.minimizeToTray ? 'checked' : ''}>
                        Minimize to system tray
                    </label>
                </div>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="start-minimized" ${this.gui.preferences.startMinimized ? 'checked' : ''}>
                        Start minimized
                    </label>
                </div>
            </div>
        `;
    }

    getAdvancedSettingsPanel() {
        return `
            <div class="setting-group">
                <h3>Todo Generation</h3>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="automatic-todo-generation" ${this.gui.preferences.automaticTodoGeneration ? 'checked' : ''}>
                        Enable automatic todo generation
                    </label>
                </div>
            </div>
            
            <div class="setting-group">
                <h3>Usage Limit Handling</h3>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="usage-limit-waiting" ${this.gui.preferences.usageLimitWaiting ? 'checked' : ''}>
                        Enable usage limit waiting
                    </label>
                </div>
            </div>
            
            <div class="setting-group">
                <h3>Debug</h3>
                <div class="setting-item">
                    <label class="checkbox-label">
                        <input type="checkbox" id="debug-mode" ${this.gui.preferences.debugMode ? 'checked' : ''}>
                        Enable debug mode
                    </label>
                </div>
                <div class="setting-item">
                    <button id="export-settings" class="btn btn-secondary">Export Settings</button>
                    <button id="import-settings" class="btn btn-secondary">Import Settings</button>
                </div>
            </div>
        `;
    }

    renderKeywordRules() {
        if (!this.gui.preferences.keywordRules || this.gui.preferences.keywordRules.length === 0) {
            return '<div class="empty-rules">No keyword rules defined</div>';
        }

        return this.gui.preferences.keywordRules.map(rule => `
            <div class="keyword-rule" data-rule-id="${rule.id}">
                <div class="rule-content">
                    <span class="rule-keyword">"${rule.keyword}"</span>
                    <span class="rule-arrow">→</span>
                    <span class="rule-response">"${rule.response}"</span>
                </div>
                <div class="rule-actions">
                    <button class="rule-action-btn edit-rule" data-rule-id="${rule.id}">
                        <i data-lucide="edit-3"></i>
                    </button>
                    <button class="rule-action-btn delete-rule" data-rule-id="${rule.id}">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    renderPromptRules() {
        if (!this.gui.preferences.promptRules || this.gui.preferences.promptRules.length === 0) {
            return '<div class="empty-rules">No detected prompts</div>';
        }

        return this.gui.preferences.promptRules.map(rule => `
            <div class="prompt-rule" data-rule-id="${rule.id}">
                <div class="rule-content">
                    <span class="rule-prompt">"${rule.pattern}"</span>
                    <span class="rule-arrow">→</span>
                    <span class="rule-response">"${rule.response}"</span>
                </div>
                <div class="rule-actions">
                    <button class="rule-action-btn delete-rule" data-rule-id="${rule.id}">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    setupSettingsEventHandlers(modal) {
        // Tab switching
        modal.querySelectorAll('.settings-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.getAttribute('data-tab');
                this.switchSettingsTab(modal, tabName);
            });
        });

        // Save settings
        modal.querySelector('#save-settings')?.addEventListener('click', () => {
            this.saveSettings(modal);
        });

        // Cancel settings
        modal.querySelector('#cancel-settings')?.addEventListener('click', () => {
            this.closeModal('settings-modal');
        });

        // Reset settings
        modal.querySelector('#reset-settings')?.addEventListener('click', () => {
            this.resetSettings(modal);
        });

        // Add keyword rule
        modal.querySelector('#add-keyword-rule')?.addEventListener('click', () => {
            this.addKeywordRule(modal);
        });

        // Clear prompt rules
        modal.querySelector('#clear-prompt-rules')?.addEventListener('click', () => {
            this.clearPromptRules(modal);
        });

        // Export/Import settings
        modal.querySelector('#export-settings')?.addEventListener('click', () => {
            this.exportSettings();
        });

        modal.querySelector('#import-settings')?.addEventListener('click', () => {
            this.importSettings();
        });
    }

    switchSettingsTab(modal, tabName) {
        // Update tab buttons
        modal.querySelectorAll('.settings-tab').forEach(tab => {
            tab.classList.toggle('active', tab.getAttribute('data-tab') === tabName);
        });

        // Update panels
        modal.querySelectorAll('.settings-panel').forEach(panel => {
            panel.classList.toggle('active', panel.getAttribute('data-panel') === tabName);
        });
    }

    saveSettings(modal) {
        // Collect all settings from the modal
        const settings = {
            theme: modal.querySelector('#theme-select')?.value,
            currentDirectory: modal.querySelector('#current-directory')?.value,
            defaultDuration: parseInt(modal.querySelector('#default-duration')?.value),
            defaultUnit: modal.querySelector('#default-unit')?.value,
            autoContinueEnabled: modal.querySelector('#auto-continue-enabled')?.checked,
            planModeEnabled: modal.querySelector('#plan-mode-enabled')?.checked,
            planModeCommand: modal.querySelector('#plan-mode-command')?.value,
            typingSpeed: parseInt(modal.querySelector('#typing-speed')?.value),
            typingRealistic: modal.querySelector('#typing-realistic')?.checked,
            completionSoundEnabled: modal.querySelector('#completion-sound-enabled')?.checked,
            completionSoundFile: modal.querySelector('#completion-sound-file')?.value,
            injectionSoundFile: modal.querySelector('#injection-sound-file')?.value,
            promptedSoundFile: modal.querySelector('#prompted-sound-file')?.value,
            promptedSoundKeywordsOnly: modal.querySelector('#prompted-sound-keywords-only')?.checked,
            keepScreenAwake: modal.querySelector('#keep-screen-awake')?.checked,
            showSystemNotifications: modal.querySelector('#show-system-notifications')?.checked,
            minimizeToTray: modal.querySelector('#minimize-to-tray')?.checked,
            startMinimized: modal.querySelector('#start-minimized')?.checked,
            automaticTodoGeneration: modal.querySelector('#automatic-todo-generation')?.checked,
            usageLimitWaiting: modal.querySelector('#usage-limit-waiting')?.checked,
            debugMode: modal.querySelector('#debug-mode')?.checked
        };

        // Update preferences
        Object.assign(this.gui.preferences, settings);
        this.gui.saveAllPreferences();

        // Apply changes
        if (settings.theme) {
            this.gui.terminalManager?.applyTheme(settings.theme);
        }

        if (settings.currentDirectory && settings.currentDirectory !== this.gui.currentDirectory) {
            this.gui.terminalManager?.setCurrentDirectory(settings.currentDirectory);
        }

        this.gui.logAction('Settings saved successfully', 'success');
        this.closeModal('settings-modal');
    }

    resetSettings(modal) {
        if (confirm('Are you sure you want to reset all settings to defaults? This cannot be undone.')) {
            // Reset to default preferences
            this.gui.preferences = this.gui.getDefaultPreferences();
            this.gui.saveAllPreferences();
            
            this.gui.logAction('Settings reset to defaults', 'info');
            this.closeModal('settings-modal');
            
            // Reopen settings modal to show updated values
            setTimeout(() => {
                this.showSettingsModal();
            }, 100);
        }
    }

    showMessageHistoryModal() {
        const modalId = 'message-history-modal';
        
        if (this.isModalOpen(modalId)) {
            return;
        }

        const modal = this.createModal(modalId, 'Message History', this.getMessageHistoryContent());
        this.openModal(modal);
        
        this.setupMessageHistoryEventHandlers(modal);
    }

    getMessageHistoryContent() {
        const history = this.gui.messageHistory || [];
        
        if (history.length === 0) {
            return '<div class="empty-history">No message history available</div>';
        }

        const historyHtml = history.map(entry => `
            <div class="history-entry">
                <div class="history-header">
                    <span class="history-timestamp">${new Date(entry.timestamp).toLocaleString()}</span>
                    <span class="history-status ${entry.status}">${entry.status}</span>
                </div>
                <div class="history-content">${this.escapeHtml(entry.content)}</div>
                ${entry.response ? `<div class="history-response">${this.escapeHtml(entry.response)}</div>` : ''}
            </div>
        `).join('');

        return `
            <div class="message-history-list">
                ${historyHtml}
            </div>
            <div class="message-history-actions">
                <button id="clear-message-history" class="btn btn-secondary">Clear History</button>
                <button id="export-message-history" class="btn btn-secondary">Export History</button>
            </div>
        `;
    }

    setupMessageHistoryEventHandlers(modal) {
        modal.querySelector('#clear-message-history')?.addEventListener('click', () => {
            this.clearMessageHistory();
        });

        modal.querySelector('#export-message-history')?.addEventListener('click', () => {
            this.exportMessageHistory();
        });
    }

    showUsageLimitModal(resetHour, ampm, exactResetTime = null) {
        const modalId = 'usage-limit-modal';
        
        // Close existing modal if open
        if (this.isModalOpen(modalId)) {
            this.closeModal(modalId);
        }

        let timeDisplay;
        if (exactResetTime) {
            timeDisplay = new Date(exactResetTime).toLocaleString();
        } else {
            timeDisplay = `${resetHour}${ampm}`;
        }

        const content = `
            <div class="usage-limit-content">
                <div class="usage-limit-icon">
                    <i data-lucide="clock"></i>
                </div>
                <h2>Usage Limit Detected</h2>
                <p>Claude usage limit has been reached. The limit will reset at <strong>${timeDisplay}</strong>.</p>
                
                <div class="usage-limit-options">
                    <div class="option-group">
                        <h3>Timer Options</h3>
                        <button id="set-timer-to-reset" class="btn btn-primary">Set Timer to Reset Time</button>
                        <button id="keep-current-timer" class="btn btn-secondary">Keep Current Timer</button>
                    </div>
                    
                    <div class="option-group">
                        <h3>Waiting Mode</h3>
                        <button id="enable-waiting-mode" class="btn btn-secondary">Enable Waiting Mode</button>
                        <p class="option-description">Queue will automatically resume when usage limit resets</p>
                    </div>
                </div>
                
                <div class="usage-limit-actions">
                    <button id="dismiss-usage-limit" class="btn btn-tertiary">Dismiss</button>
                </div>
            </div>
        `;

        const modal = this.createModal(modalId, '', content, { closeable: false });
        this.openModal(modal);

        // Setup event handlers
        modal.querySelector('#set-timer-to-reset')?.addEventListener('click', async () => {
            await this.gui.timerController?.setTimerToUsageLimitReset(resetHour, ampm, exactResetTime);
            this.closeModal(modalId);
        });

        modal.querySelector('#keep-current-timer')?.addEventListener('click', () => {
            this.closeModal(modalId);
        });

        modal.querySelector('#enable-waiting-mode')?.addEventListener('click', () => {
            this.gui.usageLimitWaiting = true;
            this.gui.preferences.usageLimitWaiting = true;
            this.gui.saveAllPreferences();
            this.gui.logAction('Usage limit waiting mode enabled', 'info');
            this.closeModal(modalId);
        });

        modal.querySelector('#dismiss-usage-limit')?.addEventListener('click', () => {
            this.closeModal(modalId);
        });
    }

    // Generic modal creation and management
    createModal(id, title, content, options = {}) {
        const modal = document.createElement('div');
        modal.id = id;
        modal.className = 'modal';
        
        const closeButton = options.closeable !== false ? 
            `<button class="modal-close" data-modal-id="${id}">&times;</button>` : '';

        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    ${title ? `<h2>${title}</h2>` : ''}
                    ${closeButton}
                </div>
                <div class="modal-body">
                    ${content}
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Setup close handler
        if (options.closeable !== false) {
            modal.querySelector('.modal-close')?.addEventListener('click', () => {
                this.closeModal(id);
            });
        }

        return modal;
    }

    openModal(modal) {
        const modalId = modal.id;
        
        this.activeModals.add(modalId);
        this.modalStack.push(modalId);
        
        modal.style.display = 'flex';
        
        // Focus trap
        setTimeout(() => {
            const firstFocusable = modal.querySelector('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
            if (firstFocusable) {
                firstFocusable.focus();
            }
        }, 100);

        // Re-initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.remove();
        }

        this.activeModals.delete(modalId);
        const stackIndex = this.modalStack.indexOf(modalId);
        if (stackIndex > -1) {
            this.modalStack.splice(stackIndex, 1);
        }
    }

    closeTopModal() {
        if (this.modalStack.length > 0) {
            const topModalId = this.modalStack[this.modalStack.length - 1];
            this.closeModal(topModalId);
        }
    }

    closeAllModals() {
        [...this.activeModals].forEach(modalId => {
            this.closeModal(modalId);
        });
    }

    isModalOpen(modalId) {
        return this.activeModals.has(modalId);
    }

    hasActiveModals() {
        return this.activeModals.size > 0;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Helper method to convert RGB to hex
    rgbToHex(rgb) {
        if (!rgb || rgb === 'transparent') return null;
        
        // Handle hex colors (already in correct format)
        if (rgb.startsWith('#')) return rgb;
        
        // Handle rgb() format
        const rgbMatch = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (rgbMatch) {
            const r = parseInt(rgbMatch[1]);
            const g = parseInt(rgbMatch[2]);
            const b = parseInt(rgbMatch[3]);
            return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
        }
        
        return null;
    }

    // Color picker modal for terminal color selection
    showColorPickerModal(terminalId, currentColor, clickEvent) {
        console.log('showColorPickerModal called:', terminalId, currentColor);
        const colors = this.gui.terminalManager ? this.gui.terminalManager.terminalColors : this.gui.terminalColors;
        console.log('Available colors:', colors);
        
        // Create color grid HTML
        const colorGrid = colors.map(color => `
            <div class="color-option" 
                 data-color="${color}" 
                 style="background-color: ${color};" 
                 title="Select ${color}"
                 ${color === currentColor ? 'data-selected="true"' : ''}>
                ${color === currentColor ? '<i data-lucide="check"></i>' : ''}
            </div>
        `).join('');

        const modalContent = `
            <div class="color-picker-container">
                <div class="color-picker-grid">
                    ${colorGrid}
                </div>
            </div>
        `;

        // Use existing modal system
        const modalBody = document.getElementById('color-picker-modal-body');
        if (modalBody) {
            modalBody.innerHTML = modalContent;
        }

        // Position modal below the clicked color dot
        const modal = document.getElementById('terminal-color-picker-modal');
        if (clickEvent && clickEvent.target && modal) {
            const rect = clickEvent.target.getBoundingClientRect();
            const modalContent = modal.querySelector('.modal-content');
            
            // Position dropdown-style below the color dot
            modalContent.style.position = 'absolute';
            modalContent.style.left = `${rect.left}px`;
            modalContent.style.top = `${rect.bottom + 5}px`;
            modalContent.style.width = '200px';
            modalContent.style.maxWidth = 'none';
        }

        // Handle color selection
        const colorOptions = modal.querySelectorAll('.color-option');
        colorOptions.forEach(option => {
            option.addEventListener('click', (e) => {
                const selectedColor = e.currentTarget.dataset.color;
                this.handleColorSelection(terminalId, selectedColor);
                this.gui.closeModal('terminal-color-picker-modal');
            });
        });

        // Use the existing modal system
        this.gui.showModal('terminal-color-picker-modal');
        
        // Initialize lucide icons for check marks
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }

    // Handle color selection and update terminal
    handleColorSelection(terminalId, newColor) {
        // Update terminal color in terminal manager
        if (this.gui.terminalManager) {
            this.gui.terminalManager.updateTerminalColor(terminalId, newColor);
        } else {
            this.gui.updateTerminalColor(terminalId, newColor);
        }
        
        // Update all visual representations of this terminal's color
        this.updateTerminalColorElements(terminalId, newColor);
    }

    // Update all visual elements showing terminal color
    updateTerminalColorElements(terminalId, newColor) {
        // Update terminal header color dot
        const terminalWrapper = document.querySelector(`.terminal-wrapper[data-terminal-id="${terminalId}"]`);
        if (terminalWrapper) {
            const colorDot = terminalWrapper.querySelector('.terminal-color-dot');
            if (colorDot) {
                colorDot.style.backgroundColor = newColor;
            }
        }

        // Update status panel color dot if this is the active terminal
        const activeTerminalId = this.gui.terminalManager ? this.gui.terminalManager.activeTerminalId : this.gui.activeTerminalId;
        if (activeTerminalId === terminalId) {
            const statusDot = document.getElementById('status-terminal-dot');
            if (statusDot) {
                statusDot.style.backgroundColor = newColor;
            }
        }

        // Update terminal selector dropdown
        const selectorOptions = document.querySelectorAll('.terminal-selector-option');
        selectorOptions.forEach(option => {
            if (parseInt(option.dataset.terminalId) === terminalId) {
                const colorDot = option.querySelector('.terminal-color-dot');
                if (colorDot) {
                    colorDot.style.backgroundColor = newColor;
                }
            }
        });
    }
}

module.exports = ModalManager;