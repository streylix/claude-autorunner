/**
 * UIFocusManager - Centralized focus and keyboard navigation management
 * Consolidates 15 focus-related functions from renderer.js
 */
class UIFocusManager {
    constructor(eventBus, appStateStore) {
        this.eventBus = eventBus;
        this.appStateStore = appStateStore;
        
        // Track focused elements
        this.currentFocus = null;
        this.previousFocus = null;
        
        // Focus trap stacks for modals
        this.focusTrapStack = [];
        
        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // Listen for focus requests
        this.eventBus.on('focus:search', () => this.focusSearchInput());
        this.eventBus.on('focus:terminal-selector', () => this.focusTerminalSelector());
        this.eventBus.on('focus:timer', () => this.focusTimerEdit());
        this.eventBus.on('focus:message-input', () => this.focusMessageInput());
        this.eventBus.on('focus:action-log', () => this.focusActionLog());
        
        // Listen for modal events to manage focus traps
        this.eventBus.on('modal:opened', (modalId) => this.setupModalFocusTrap(modalId));
        this.eventBus.on('modal:closed', (modalId) => this.removeModalFocusTrap(modalId));
        
        // Listen for terminal changes
        this.eventBus.on('terminal:switched', (terminalId) => this.focusTerminal(terminalId));
    }
    
    // ======= MAIN FOCUS METHODS =======
    focusSearchInput() {
        const searchInput = document.getElementById('log-search');
        if (searchInput) {
            this.setFocus(searchInput);
            searchInput.select();
            
            this.eventBus.emit('log:action', {
                message: 'Search input focused',
                type: 'info'
            });
        }
    }
    
    focusTerminalSelector() {
        const selector = document.getElementById('terminal-selector');
        if (selector) {
            this.setFocus(selector);
            
            // Open dropdown if not already open
            if (!selector.classList.contains('open')) {
                selector.click();
            }
            
            this.eventBus.emit('log:action', {
                message: 'Terminal selector focused',
                type: 'info'
            });
        }
    }
    
    focusTimerEdit() {
        // Try to focus hours input first
        const hoursInput = document.getElementById('timer-hours-input');
        const minutesInput = document.getElementById('timer-minutes-input');
        const secondsInput = document.getElementById('timer-seconds-input');
        
        if (hoursInput && hoursInput.style.display !== 'none') {
            this.setFocus(hoursInput);
            hoursInput.select();
        } else if (minutesInput && minutesInput.style.display !== 'none') {
            this.setFocus(minutesInput);
            minutesInput.select();
        } else if (secondsInput && secondsInput.style.display !== 'none') {
            this.setFocus(secondsInput);
            secondsInput.select();
        }
        
        this.eventBus.emit('log:action', {
            message: 'Timer edit focused',
            type: 'info'
        });
    }
    
    focusMessageInput() {
        const messageInput = document.getElementById('message-input');
        if (messageInput) {
            this.setFocus(messageInput);
            
            // Place cursor at end
            const length = messageInput.value.length;
            messageInput.setSelectionRange(length, length);
            
            this.eventBus.emit('log:action', {
                message: 'Message input focused',
                type: 'info'
            });
        }
    }
    
    focusActionLog() {
        const actionLog = document.getElementById('action-log');
        if (actionLog) {
            this.setFocus(actionLog);
            
            // Scroll to bottom
            actionLog.scrollTop = actionLog.scrollHeight;
            
            this.eventBus.emit('log:action', {
                message: 'Action log focused',
                type: 'info'
            });
        }
    }
    
    focusTerminal(terminalId) {
        const terminalElement = document.querySelector(`[data-terminal-id="${terminalId}"] .xterm`);
        if (terminalElement) {
            this.setFocus(terminalElement);
            
            // Emit event for terminal to grab focus
            this.eventBus.emit('terminal:focus-requested', terminalId);
        }
    }
    
    // ======= KEYBOARD NAVIGATION =======
    setupTerminalSelectorKeyboard() {
        const selector = document.getElementById('terminal-selector');
        if (!selector) return;
        
        let currentIndex = -1;
        const items = selector.querySelectorAll('.terminal-selector-item');
        
        selector.addEventListener('keydown', (e) => {
            switch(e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    currentIndex = Math.min(currentIndex + 1, items.length - 1);
                    this.highlightSelectorItem(items, currentIndex);
                    break;
                    
                case 'ArrowUp':
                    e.preventDefault();
                    currentIndex = Math.max(currentIndex - 1, 0);
                    this.highlightSelectorItem(items, currentIndex);
                    break;
                    
                case 'Enter':
                    e.preventDefault();
                    if (currentIndex >= 0 && items[currentIndex]) {
                        items[currentIndex].click();
                    }
                    break;
                    
                case 'Escape':
                    e.preventDefault();
                    selector.classList.remove('open');
                    this.focusMessageInput();
                    break;
            }
        });
    }
    
    highlightSelectorItem(items, index) {
        // Remove previous highlight
        items.forEach(item => item.classList.remove('highlighted'));
        
        // Add new highlight
        if (index >= 0 && items[index]) {
            items[index].classList.add('highlighted');
            items[index].scrollIntoView({ block: 'nearest' });
        }
    }
    
    // ======= MODAL FOCUS MANAGEMENT =======
    setupModalFocusTrap(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        
        // Find all focusable elements in modal
        const focusableElements = modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        
        if (focusableElements.length === 0) return;
        
        const firstFocusable = focusableElements[0];
        const lastFocusable = focusableElements[focusableElements.length - 1];
        
        // Store trap info
        const trapInfo = {
            modalId,
            firstFocusable,
            lastFocusable,
            previousFocus: document.activeElement
        };
        
        this.focusTrapStack.push(trapInfo);
        
        // Focus first element
        setTimeout(() => firstFocusable.focus(), 50);
        
        // Add trap listener
        const trapHandler = (e) => {
            if (e.key !== 'Tab') return;
            
            if (e.shiftKey) {
                // Shift+Tab - moving backwards
                if (document.activeElement === firstFocusable) {
                    e.preventDefault();
                    lastFocusable.focus();
                }
            } else {
                // Tab - moving forwards
                if (document.activeElement === lastFocusable) {
                    e.preventDefault();
                    firstFocusable.focus();
                }
            }
        };
        
        modal.addEventListener('keydown', trapHandler);
        modal.dataset.trapHandler = trapHandler;
    }
    
    removeModalFocusTrap(modalId) {
        const trapIndex = this.focusTrapStack.findIndex(trap => trap.modalId === modalId);
        if (trapIndex === -1) return;
        
        const trapInfo = this.focusTrapStack[trapIndex];
        this.focusTrapStack.splice(trapIndex, 1);
        
        // Remove trap listener
        const modal = document.getElementById(modalId);
        if (modal && modal.dataset.trapHandler) {
            modal.removeEventListener('keydown', modal.dataset.trapHandler);
            delete modal.dataset.trapHandler;
        }
        
        // Restore previous focus
        if (trapInfo.previousFocus && trapInfo.previousFocus.focus) {
            trapInfo.previousFocus.focus();
        }
    }
    
    // ======= UTILITY METHODS =======
    setFocus(element) {
        if (!element) return;
        
        this.previousFocus = this.currentFocus;
        this.currentFocus = element;
        
        // Use requestAnimationFrame for smoother focus
        requestAnimationFrame(() => {
            element.focus();
        });
    }
    
    restorePreviousFocus() {
        if (this.previousFocus && this.previousFocus.focus) {
            this.setFocus(this.previousFocus);
        }
    }
    
    getCurrentFocus() {
        return document.activeElement;
    }
    
    isElementFocused(element) {
        return document.activeElement === element;
    }
    
    // ======= PUBLIC API =======
    initialize() {
        // Setup initial keyboard navigation
        this.setupTerminalSelectorKeyboard();
        
        // Setup global keyboard shortcuts for focus
        document.addEventListener('keydown', (e) => {
            // Cmd/Ctrl+F for search
            if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
                if (!this.isModalOpen()) {
                    e.preventDefault();
                    this.focusSearchInput();
                }
            }
            
            // Cmd/Ctrl+K for terminal selector
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                this.focusTerminalSelector();
            }
            
            // Escape to return focus to message input
            if (e.key === 'Escape' && !this.isModalOpen()) {
                this.focusMessageInput();
            }
        });
    }
    
    isModalOpen() {
        return this.focusTrapStack.length > 0;
    }
    
    // Get focus statistics for debugging
    getFocusStats() {
        return {
            currentFocus: this.currentFocus?.id || 'none',
            previousFocus: this.previousFocus?.id || 'none',
            modalTraps: this.focusTrapStack.length,
            activeElement: document.activeElement?.id || 'none'
        };
    }
}

module.exports = UIFocusManager;