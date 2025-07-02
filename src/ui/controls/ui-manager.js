/**
 * UI Manager Module
 * Handles UI updates, modal management, and control interactions
 */

class UIManager {
    constructor(terminalGUI) {
        this.gui = terminalGUI;
        this.currentModal = null;
        this.modalStack = [];
        this.openDropdowns = new Set();
    }

    // Status display management
    updateStatusDisplay() {
        this.updateQueueStatus();
        this.updateTimerStatus();
        this.updateTerminalStatus();
        this.updateInjectionStatus();
    }

    updateQueueStatus() {
        const queueCount = this.gui.messageQueue ? this.gui.messageQueue.getQueueSize() : 0;
        
        // Update queue count display
        const queueCountElement = document.getElementById('queue-count');
        if (queueCountElement) {
            queueCountElement.textContent = queueCount;
        }

        // Update queue status text
        const queueStatusElement = document.getElementById('queue-status');
        if (queueStatusElement) {
            if (queueCount === 0) {
                queueStatusElement.textContent = 'Queue empty';
                queueStatusElement.className = 'status-text status-empty';
            } else {
                queueStatusElement.textContent = `${queueCount} message${queueCount !== 1 ? 's' : ''} queued`;
                queueStatusElement.className = 'status-text status-queued';
            }
        }

        // Update tray badge
        this.updateTrayBadge(queueCount);
    }

    updateTimerStatus() {
        if (!this.gui.timerManager) return;

        const timerState = this.gui.timerManager.getTimerState();
        const timerStatusElement = document.getElementById('timer-status');
        
        if (timerStatusElement) {
            if (timerState.active) {
                timerStatusElement.textContent = `Timer: ${timerState.formatted}`;
                timerStatusElement.className = 'status-text status-active';
            } else if (timerState.hasTime) {
                timerStatusElement.textContent = `Timer set: ${timerState.formatted}`;
                timerStatusElement.className = 'status-text status-set';
            } else {
                timerStatusElement.textContent = 'No timer set';
                timerStatusElement.className = 'status-text status-empty';
            }
        }
    }

    updateTerminalStatus() {
        const activeTerminalId = this.gui.activeTerminalId;
        const terminalStatusElement = document.getElementById('terminal-status');
        
        if (terminalStatusElement && activeTerminalId) {
            const terminalData = this.gui.terminals.get(activeTerminalId);
            if (terminalData) {
                terminalStatusElement.textContent = `Active: ${terminalData.name}`;
                terminalStatusElement.className = 'status-text status-active';
            }
        }
    }

    updateInjectionStatus() {
        if (!this.gui.injectionEngine) return;

        const injectionState = this.gui.injectionEngine.getInjectionState();
        const injectionStatusElement = document.getElementById('injection-status');
        
        if (injectionStatusElement) {
            if (injectionState.isInjecting) {
                injectionStatusElement.textContent = 'Injecting...';
                injectionStatusElement.className = 'status-text status-injecting';
            } else if (injectionState.injectionPaused) {
                injectionStatusElement.textContent = 'Paused';
                injectionStatusElement.className = 'status-text status-paused';
            } else if (injectionState.injectionBlocked) {
                injectionStatusElement.textContent = 'Blocked';
                injectionStatusElement.className = 'status-text status-blocked';
            } else {
                injectionStatusElement.textContent = `${injectionState.injectionCount} injected`;
                injectionStatusElement.className = 'status-text status-idle';
            }
        }
    }

    // Modal management
    showModal(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) {
            console.warn(`Modal ${modalId} not found`);
            return false;
        }

        // Hide current modal if exists
        if (this.currentModal && this.currentModal !== modalId) {
            this.modalStack.push(this.currentModal);
            this.hideModal(this.currentModal, false);
        }

        // Show new modal
        modal.style.display = 'flex';
        modal.classList.add('modal-show');
        this.currentModal = modalId;

        // Focus management
        this.focusModal(modal);

        // Add escape key handler
        this.addModalEscapeHandler(modal);

        return true;
    }

    hideModal(modalId, updateStack = true) {
        const modal = document.getElementById(modalId);
        if (!modal) return false;

        modal.style.display = 'none';
        modal.classList.remove('modal-show');

        if (this.currentModal === modalId) {
            this.currentModal = null;

            // Show previous modal if exists
            if (updateStack && this.modalStack.length > 0) {
                const previousModal = this.modalStack.pop();
                this.showModal(previousModal);
            }
        }

        return true;
    }

    closeModal(modalId = null) {
        const targetModal = modalId || this.currentModal;
        if (targetModal) {
            this.hideModal(targetModal);
        }
    }

    focusModal(modal) {
        // Focus first focusable element in modal
        const focusableElements = modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        
        if (focusableElements.length > 0) {
            focusableElements[0].focus();
        }
    }

    addModalEscapeHandler(modal) {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                this.closeModal();
                document.removeEventListener('keydown', handleKeyDown);
            }
        };
        
        document.addEventListener('keydown', handleKeyDown);
    }

    // Dropdown management
    showDropdown(dropdownSelector) {
        const dropdown = document.querySelector(dropdownSelector);
        if (dropdown) {
            dropdown.style.display = 'block';
            this.openDropdowns.add(dropdownSelector);
            this.addDropdownOutsideClickHandler();
        }
    }

    hideDropdown(dropdownSelector) {
        const dropdown = document.querySelector(dropdownSelector);
        if (dropdown) {
            dropdown.style.display = 'none';
            this.openDropdowns.delete(dropdownSelector);
            
            if (this.openDropdowns.size === 0) {
                this.removeDropdownOutsideClickHandler();
            }
        }
    }

    hideAllDropdowns() {
        this.openDropdowns.forEach(selector => {
            this.hideDropdown(selector);
        });
        this.openDropdowns.clear();
    }

    addDropdownOutsideClickHandler() {
        if (this.dropdownClickHandler) return;

        this.dropdownClickHandler = (event) => {
            // Check if click is outside all open dropdowns
            let clickedInsideDropdown = false;
            
            this.openDropdowns.forEach(selector => {
                const dropdown = document.querySelector(selector);
                if (dropdown && dropdown.contains(event.target)) {
                    clickedInsideDropdown = true;
                }
            });

            if (!clickedInsideDropdown) {
                this.hideAllDropdowns();
            }
        };

        document.addEventListener('click', this.dropdownClickHandler);
    }

    removeDropdownOutsideClickHandler() {
        if (this.dropdownClickHandler) {
            document.removeEventListener('click', this.dropdownClickHandler);
            this.dropdownClickHandler = null;
        }
    }

    // Button state management
    updateButtonStates() {
        this.updatePlayPauseButton();
        this.updateStopButton();
        this.updateInjectButton();
    }

    updatePlayPauseButton() {
        const playPauseBtn = document.getElementById('timer-play-pause-btn');
        if (!playPauseBtn) return;

        const icon = playPauseBtn.querySelector('i');
        const isTimerActive = this.gui.timerManager && this.gui.timerManager.isTimerActive();
        
        if (isTimerActive) {
            icon.setAttribute('data-lucide', 'pause');
            playPauseBtn.title = 'Pause timer';
            playPauseBtn.classList.add('active');
        } else {
            icon.setAttribute('data-lucide', 'play');
            playPauseBtn.title = 'Start timer';
            playPauseBtn.classList.remove('active');
        }
    }

    updateStopButton() {
        const stopBtn = document.getElementById('timer-stop-btn');
        if (!stopBtn) return;

        const icon = stopBtn.querySelector('i');
        const isInjecting = this.gui.injectionEngine && this.gui.injectionEngine.getInjectionState().isInjecting;
        const isTimerActive = this.gui.timerManager && this.gui.timerManager.isTimerActive();
        
        if (isInjecting) {
            icon.setAttribute('data-lucide', 'x');
            stopBtn.title = 'Cancel injection';
            stopBtn.classList.add('cancel');
        } else if (isTimerActive) {
            icon.setAttribute('data-lucide', 'square');
            stopBtn.title = 'Stop timer';
            stopBtn.classList.remove('cancel');
        } else {
            icon.setAttribute('data-lucide', 'rotate-ccw');
            stopBtn.title = 'Reset timer';
            stopBtn.classList.remove('cancel');
        }
    }

    updateInjectButton() {
        const injectBtn = document.getElementById('inject-messages-btn');
        if (!injectBtn) return;

        const queueSize = this.gui.messageQueue ? this.gui.messageQueue.getQueueSize() : 0;
        const isInjecting = this.gui.injectionEngine && this.gui.injectionEngine.getInjectionState().isInjecting;
        
        injectBtn.disabled = queueSize === 0 || isInjecting;
        
        if (isInjecting) {
            injectBtn.textContent = 'Injecting...';
            injectBtn.classList.add('injecting');
        } else {
            injectBtn.textContent = 'Inject Messages';
            injectBtn.classList.remove('injecting');
        }
    }

    // Notification management
    showNotification(title, message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <div class="notification-content">
                <div class="notification-title">${this.escapeHtml(title)}</div>
                <div class="notification-message">${this.escapeHtml(message)}</div>
            </div>
            <button class="notification-close">×</button>
        `;

        // Add to notification container
        let container = document.getElementById('notification-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'notification-container';
            container.className = 'notification-container';
            document.body.appendChild(container);
        }

        container.appendChild(notification);

        // Add click to close
        const closeBtn = notification.querySelector('.notification-close');
        closeBtn.addEventListener('click', () => {
            this.hideNotification(notification);
        });

        // Auto-hide after 5 seconds
        setTimeout(() => {
            this.hideNotification(notification);
        }, 5000);

        // Show with animation
        setTimeout(() => {
            notification.classList.add('notification-show');
        }, 10);
    }

    hideNotification(notification) {
        notification.classList.remove('notification-show');
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }

    // System tray badge update
    updateTrayBadge(count = null) {
        const queueCount = count !== null ? count : (this.gui.messageQueue ? this.gui.messageQueue.getQueueSize() : 0);
        
        try {
            const { ipcRenderer } = require('electron');
            ipcRenderer.invoke('update-tray-badge', queueCount);
        } catch (error) {
            console.warn('Failed to update tray badge:', error);
        }
    }

    // Voice button state management
    updateVoiceButtonState(isRecording = false) {
        const voiceBtn = document.getElementById('voice-record-btn');
        if (!voiceBtn) return;

        const icon = voiceBtn.querySelector('i');
        
        if (icon) {
            if (isRecording) {
                icon.setAttribute('data-lucide', 'square');
                voiceBtn.title = 'Stop recording';
                voiceBtn.classList.add('recording');
            } else {
                icon.setAttribute('data-lucide', 'mic');
                voiceBtn.title = 'Start voice recording';
                voiceBtn.classList.remove('recording');
            }

            // Refresh Lucide icons
            if (window.lucide) {
                window.lucide.createIcons();
            }
        }
    }

    // Sound settings visibility
    updateSoundSettingsVisibility() {
        const soundEnabled = this.gui.preferences.completionSoundEnabled;
        const soundFileGroup = document.querySelector('.sound-file-group');
        
        if (soundFileGroup) {
            soundFileGroup.style.display = soundEnabled ? 'block' : 'none';
        }
    }

    // Auto-resize textarea utilities
    autoResizeTextarea(textarea) {
        if (!textarea) return;
        
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }

    autoResizeMessageInput(input) {
        this.autoResizeTextarea(input);
    }

    // Scroll utilities
    scrollToBottom(element) {
        if (element) {
            element.scrollTop = element.scrollHeight;
        }
    }

    scrollToTop(element) {
        if (element) {
            element.scrollTop = 0;
        }
    }

    // Utility functions
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatTimestamp(timestamp) {
        return new Date(timestamp).toLocaleTimeString();
    }

    // Theme management
    applyTheme(theme) {
        const body = document.body;
        body.classList.remove('theme-light', 'theme-dark');
        body.classList.add(`theme-${theme}`);
    }

    // Initialize UI manager
    initialize() {
        this.updateStatusDisplay();
        this.updateButtonStates();
        
        // Setup periodic updates
        setInterval(() => {
            this.updateStatusDisplay();
            this.updateButtonStates();
        }, 1000);
    }

    // Cleanup
    destroy() {
        this.hideAllDropdowns();
        this.removeDropdownOutsideClickHandler();
        
        if (this.currentModal) {
            this.hideModal(this.currentModal);
        }
        
        this.modalStack = [];
        this.openDropdowns.clear();
    }
}

// Export for use in main TerminalGUI class
window.UIManager = UIManager;