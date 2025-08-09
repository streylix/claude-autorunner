/**
 * Screenshot UI Controller - Manages screenshot interface and user interactions
 * Integrates with the main renderer process and screenshot engine
 */

class ScreenshotUIController {
    constructor() {
        this.state = {
            isInitialized: false,
            isCapturing: false,
            deviceConnected: false,
            autoScreenshotEnabled: false,
            screenshots: [],
            currentPreview: null
        };
        
        this.elements = {
            container: null,
            deviceStatus: null,
            captureBtn: null,
            autoCaptureCheckbox: null,
            screenshotList: null,
            exportBtn: null,
            statusDisplay: null
        };
        
        this.dragState = {
            isDragging: false,
            dragElement: null,
            startIndex: -1,
            currentIndex: -1
        };
        
        // Bind methods
        this.handleScreenshotCaptured = this.handleScreenshotCaptured.bind(this);
        this.handleDeviceConnected = this.handleDeviceConnected.bind(this);
        this.handleCaptureStarted = this.handleCaptureStarted.bind(this);
        this.handleCaptureStopped = this.handleCaptureStopped.bind(this);
        this.handleError = this.handleError.bind(this);
        
        this.init();
    }
    
    /**
     * Initialize the screenshot UI controller
     */
    async init() {
        try {
            await this.createUI();
            await this.setupEventListeners();
            await this.initializeEngine();
            
            this.state.isInitialized = true;
            console.log('Screenshot UI Controller initialized');
            
        } catch (error) {
            console.error('Failed to initialize Screenshot UI Controller:', error);
            this.showError('Failed to initialize screenshot system');
        }
    }
    
    /**
     * Create the screenshot UI elements
     */
    async createUI() {
        // Find or create container in the right sidebar
        const rightSidebar = document.getElementById('right-sidebar');
        if (!rightSidebar) {
            throw new Error('Right sidebar not found');
        }
        
        // Create screenshot section
        const screenshotSection = document.createElement('div');
        screenshotSection.className = 'screenshot-section';
        screenshotSection.innerHTML = `
            <div class="section-header">
                <span class="screenshot-title">Device Recording</span>
                <div class="screenshot-actions">
                    <button class="icon-btn" id="screenshot-capture-btn" title="Take screenshot" disabled>
                        <i data-lucide="camera"></i>
                    </button>
                    <button class="icon-btn" id="screenshot-export-btn" title="Export screenshots" disabled>
                        <i data-lucide="download"></i>
                    </button>
                </div>
            </div>
            
            <div class="screenshot-status" id="screenshot-status">
                <div class="device-status" id="device-status">
                    <span class="status-indicator offline" id="device-indicator"></span>
                    <span class="status-text">No device connected</span>
                </div>
                <div class="capture-controls">
                    <label class="checkbox-label">
                        <input type="checkbox" id="auto-screenshot-enabled" disabled>
                        <span class="checkbox-text">Auto-screenshot after action</span>
                    </label>
                    <button class="capture-toggle-btn" id="live-capture-btn" disabled>
                        <i data-lucide="video"></i>
                        <span>Start Live Capture</span>
                    </button>
                </div>
            </div>
            
            <div class="screenshot-list-container">
                <div class="screenshot-list-header">
                    <span class="list-title">Screenshots (<span id="screenshot-count">0</span>)</span>
                    <button class="icon-btn" id="clear-screenshots-btn" title="Clear all screenshots" disabled>
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
                <div class="screenshot-list" id="screenshot-list">
                    <div class="screenshot-empty" id="screenshot-empty">
                        <p>No screenshots captured yet</p>
                        <p class="screenshot-help">Connect an Android device via ADB to start capturing screenshots</p>
                    </div>
                </div>
            </div>
        `;
        
        // Insert before the input section
        const inputSection = rightSidebar.querySelector('.input-section');
        if (inputSection) {
            rightSidebar.insertBefore(screenshotSection, inputSection);
        } else {
            rightSidebar.appendChild(screenshotSection);
        }
        
        // Store element references
        this.elements.container = screenshotSection;
        this.elements.deviceStatus = screenshotSection.querySelector('#device-status');
        this.elements.captureBtn = screenshotSection.querySelector('#screenshot-capture-btn');
        this.elements.autoCaptureCheckbox = screenshotSection.querySelector('#auto-screenshot-enabled');
        this.elements.screenshotList = screenshotSection.querySelector('#screenshot-list');
        this.elements.exportBtn = screenshotSection.querySelector('#screenshot-export-btn');
        this.elements.statusDisplay = screenshotSection.querySelector('#screenshot-status');
        this.elements.liveCaptureBtn = screenshotSection.querySelector('#live-capture-btn');
        this.elements.clearBtn = screenshotSection.querySelector('#clear-screenshots-btn');
        this.elements.screenshotCount = screenshotSection.querySelector('#screenshot-count');
        this.elements.emptyState = screenshotSection.querySelector('#screenshot-empty');
        
        // Initialize Lucide icons
        if (window.lucide) {
            window.lucide.createIcons();
        }
    }
    
    /**
     * Setup event listeners
     */
    async setupEventListeners() {
        // Button click handlers
        this.elements.captureBtn.addEventListener('click', () => this.captureScreenshot());
        this.elements.liveCaptureBtn.addEventListener('click', () => this.toggleLiveCapture());  
        this.elements.exportBtn.addEventListener('click', () => this.exportScreenshots());
        this.elements.clearBtn.addEventListener('click', () => this.clearAllScreenshots());
        
        // Auto-screenshot toggle
        this.elements.autoCaptureCheckbox.addEventListener('change', (e) => {
            this.toggleAutoScreenshot(e.target.checked);
        });
        
        // IPC event listeners from main process
        if (window.ipcRenderer) {
            window.ipcRenderer.on('screenshot-initialized', this.handleInitialized.bind(this));
            window.ipcRenderer.on('screenshot-device-connected', this.handleDeviceConnected);
            window.ipcRenderer.on('screenshot-captured', this.handleScreenshotCaptured);
            window.ipcRenderer.on('screenshot-capture-started', this.handleCaptureStarted);
            window.ipcRenderer.on('screenshot-capture-stopped', this.handleCaptureStopped);
            window.ipcRenderer.on('screenshot-error', this.handleError);
            window.ipcRenderer.on('screenshot-auto-captured', this.handleAutoScreenshotCaptured.bind(this));
        }
        
        // Drag and drop for screenshot reordering
        this.setupDragAndDrop();
    }
    
    /**
     * Initialize the screenshot engine
     */
    async initializeEngine() {
        try {
            const result = await window.ipcRenderer.invoke('screenshot-init', {
                captureInterval: 2000, // 2 seconds for live capture
                autoCleanup: true,
                maxStoredScreenshots: 20
            });
            
            if (!result.success) {
                throw new Error(result.error || 'Failed to initialize screenshot engine');
            }
            
            // Load existing screenshots
            await this.loadExistingScreenshots();
            
        } catch (error) {
            console.error('Error initializing screenshot engine:', error);
            this.showError('Failed to initialize screenshot engine: ' + error.message);
        }
    }
    
    /**
     * Load existing screenshots from the engine
     */
    async loadExistingScreenshots() {
        try {
            const result = await window.ipcRenderer.invoke('screenshot-get-all');
            if (result.success) {
                this.state.screenshots = result.screenshots || [];
                this.updateScreenshotList();
            }
        } catch (error) {
            console.error('Error loading existing screenshots:', error);
        }
    }
    
    /**
     * Handle screenshot engine initialized
     */
    handleInitialized() {
        console.log('Screenshot engine initialized');
    }
    
    /**
     * Handle device connected
     */
    handleDeviceConnected(device) {
        this.state.deviceConnected = true;
        
        const indicator = this.elements.deviceStatus.querySelector('#device-indicator');
        const statusText = this.elements.deviceStatus.querySelector('.status-text');
        
        indicator.className = 'status-indicator online';
        statusText.textContent = `Device connected: ${device.id}`;
        
        // Enable controls
        this.elements.captureBtn.disabled = false;
        this.elements.autoCaptureCheckbox.disabled = false;
        this.elements.liveCaptureBtn.disabled = false;
        
        this.showSuccess('Device connected successfully');
    }
    
    /**
     * Handle screenshot captured
     */
    handleScreenshotCaptured(screenshot) {
        this.state.screenshots.unshift(screenshot); // Add to beginning
        this.updateScreenshotList();
        
        // Play sound effect if available
        this.playScreenshotSound();
        
        // Show brief success indicator
        this.showSuccess('Screenshot captured');
    }
    
    /**
     * Handle auto-screenshot captured  
     */
    handleAutoScreenshotCaptured(data) {
        const { screenshot, terminalId, actionType } = data;
        this.handleScreenshotCaptured(screenshot);
        
        // Log the auto-capture event
        if (window.terminalGUI && window.terminalGUI.logAction) {
            window.terminalGUI.logAction(
                `Auto-screenshot captured for Terminal ${terminalId} (${actionType})`, 
                'info'
            );
        }
    }
    
    /**
     * Handle capture started
     */
    handleCaptureStarted() {
        this.state.isCapturing = true;
        
        const btn = this.elements.liveCaptureBtn;
        btn.innerHTML = '<i data-lucide="square"></i><span>Stop Live Capture</span>';
        btn.classList.add('active');
        
        if (window.lucide) {
            window.lucide.createIcons();
        }
        
        this.showInfo('Live capture started');
    }
    
    /**
     * Handle capture stopped
     */
    handleCaptureStopped() {
        this.state.isCapturing = false;
        
        const btn = this.elements.liveCaptureBtn;
        btn.innerHTML = '<i data-lucide="video"></i><span>Start Live Capture</span>';
        btn.classList.remove('active');
        
        if (window.lucide) {
            window.lucide.createIcons();
        }
        
        this.showInfo('Live capture stopped');
    }
    
    /**
     * Handle screenshot engine error
     */
    handleError(errorMessage) {
        console.error('Screenshot engine error:', errorMessage);
        this.showError('Screenshot error: ' + errorMessage);
    }
    
    /**
     * Capture a single screenshot
     */
    async captureScreenshot() {
        try {
            this.elements.captureBtn.disabled = true;
            
            const result = await window.ipcRenderer.invoke('screenshot-capture', 'manual');
            if (!result.success) {
                throw new Error(result.error || 'Failed to capture screenshot');
            }
            
            // Screenshot will be handled by the event listener
            
        } catch (error) {
            console.error('Error capturing screenshot:', error);
            this.showError('Failed to capture screenshot: ' + error.message);
        } finally {
            this.elements.captureBtn.disabled = false;
        }
    }
    
    /**
     * Toggle live capture mode
     */
    async toggleLiveCapture() {
        try {
            if (this.state.isCapturing) {
                const result = await window.ipcRenderer.invoke('screenshot-stop-capture');
                if (!result.success) {
                    throw new Error(result.error || 'Failed to stop capture');
                }
            } else {
                const result = await window.ipcRenderer.invoke('screenshot-start-capture');
                if (!result.success) {
                    throw new Error(result.error || 'Failed to start capture');
                }
            }
        } catch (error) {
            console.error('Error toggling live capture:', error);
            this.showError('Failed to toggle live capture: ' + error.message);
        }
    }
    
    /**
     * Toggle auto-screenshot feature
     */
    async toggleAutoScreenshot(enabled) {
        try {
            this.state.autoScreenshotEnabled = enabled;
            
            if (enabled) {
                // Enable for current terminal
                const currentTerminalId = window.terminalGUI?.activeTerminalId || 1;
                const result = await window.ipcRenderer.invoke('screenshot-enable-auto', currentTerminalId);
                
                if (!result.success) {
                    throw new Error(result.error || 'Failed to enable auto-screenshot');
                }
                
                // Hook into terminal actions
                this.hookTerminalActions();
                
                this.showInfo('Auto-screenshot enabled');
                
            } else {
                const result = await window.ipcRenderer.invoke('screenshot-disable-auto');
                
                if (!result.success) {
                    throw new Error(result.error || 'Failed to disable auto-screenshot');
                }
                
                this.unhookTerminalActions();
                
                this.showInfo('Auto-screenshot disabled');
            }
            
        } catch (error) {
            console.error('Error toggling auto-screenshot:', error);
            this.showError('Failed to toggle auto-screenshot: ' + error.message);
            
            // Reset checkbox on error
            this.elements.autoCaptureCheckbox.checked = !enabled;
            this.state.autoScreenshotEnabled = !enabled;
        }
    }
    
    /**
     * Hook into terminal actions for auto-screenshot
     */
    hookTerminalActions() {
        // Hook into the terminal input handler
        if (window.ipcRenderer) {
            const originalSend = window.ipcRenderer.send;
            
            window.ipcRenderer.send = (...args) => {
                const [event, data] = args;
                
                // Detect terminal input events
                if (event === 'terminal-input' && this.state.autoScreenshotEnabled) {
                    const terminalId = typeof data === 'object' ? data.terminalId : 1;
                    
                    // Notify screenshot engine of terminal action
                    window.ipcRenderer.invoke('screenshot-terminal-action', terminalId, 'input')
                        .catch(error => console.error('Error notifying terminal action:', error));
                }
                
                return originalSend.apply(window.ipcRenderer, args);
            };
        }
    }
    
    /**
     * Unhook terminal actions
     */
    unhookTerminalActions() {
        // This would restore the original ipcRenderer.send if we stored it
        // For now, just ensure we don't trigger more auto-screenshots
        this.state.autoScreenshotEnabled = false;
    }
    
    /**
     * Export screenshots
     */
    async exportScreenshots() {
        try {
            if (this.state.screenshots.length === 0) {
                this.showWarning('No screenshots to export');
                return;
            }
            
            this.elements.exportBtn.disabled = true;
            
            const result = await window.ipcRenderer.invoke('screenshot-export', {
                includeFiles: true
            });
            
            if (!result.success) {
                throw new Error(result.error || 'Failed to export screenshots');
            }
            
            this.showSuccess(`Exported ${result.exportData.screenshots.length} screenshots`);
            
        } catch (error) {
            console.error('Error exporting screenshots:', error);
            this.showError('Failed to export screenshots: ' + error.message);
        } finally {
            this.elements.exportBtn.disabled = false;
        }
    }
    
    /**
     * Clear all screenshots
     */
    async clearAllScreenshots() {
        try {
            if (this.state.screenshots.length === 0) {
                return;
            }
            
            if (!confirm('Are you sure you want to delete all screenshots?')) {
                return;
            }
            
            // Delete each screenshot
            for (const screenshot of this.state.screenshots) {
                await window.ipcRenderer.invoke('screenshot-delete', screenshot.id);
            }
            
            this.state.screenshots = [];
            this.updateScreenshotList();
            
            this.showSuccess('All screenshots cleared');
            
        } catch (error) {
            console.error('Error clearing screenshots:', error);
            this.showError('Failed to clear screenshots: ' + error.message);
        }
    }
    
    /**
     * Update the screenshot list display
     */
    updateScreenshotList() {
        const list = this.elements.screenshotList;
        const count = this.elements.screenshotCount;
        const empty = this.elements.emptyState;
        
        // Update count
        count.textContent = this.state.screenshots.length;
        
        // Clear existing items (except empty state)
        const items = list.querySelectorAll('.screenshot-item');
        items.forEach(item => item.remove());
        
        if (this.state.screenshots.length === 0) {
            empty.style.display = 'block';
            this.elements.exportBtn.disabled = true;
            this.elements.clearBtn.disabled = true;
            return;
        }
        
        empty.style.display = 'none';
        this.elements.exportBtn.disabled = false;
        this.elements.clearBtn.disabled = false;
        
        // Create screenshot items
        this.state.screenshots.forEach((screenshot, index) => {
            const item = this.createScreenshotItem(screenshot, index);
            list.appendChild(item);
        });
    }
    
    /**
     * Create a screenshot item element
     */
    createScreenshotItem(screenshot, index) {
        const item = document.createElement('div');
        item.className = 'screenshot-item';
        item.dataset.screenshotId = screenshot.id;
        item.dataset.index = index;
        item.draggable = true;
        
        const time = new Date(screenshot.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        
        item.innerHTML = `
            <div class="screenshot-number">${index + 1}</div>
            <div class="screenshot-thumbnail">
                <img src="file://${screenshot.filepath}" alt="Screenshot ${index + 1}" loading="lazy">
            </div>
            <div class="screenshot-info">
                <div class="screenshot-type">${screenshot.type}</div>
                <div class="screenshot-time">${time}</div>
            </div>
            <button class="screenshot-remove" title="Delete screenshot">×</button>
        `;
        
        // Event listeners
        const img = item.querySelector('img');
        const removeBtn = item.querySelector('.screenshot-remove');
        
        img.addEventListener('click', () => this.showScreenshotPreview(screenshot));
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.deleteScreenshot(screenshot.id);
        });
        
        return item;
    }
    
    /**
     * Show screenshot preview modal
     */
    showScreenshotPreview(screenshot) {
        // Reuse existing image preview system if available
        if (window.terminalGUI && window.terminalGUI.showImagePreview) {
            const imageData = {
                file: { 
                    name: screenshot.filename,
                    path: screenshot.filepath
                },
                path: screenshot.filepath
            };
            window.terminalGUI.showImagePreview(imageData);
        } else {
            // Fallback simple modal
            this.showSimpleImagePreview(screenshot);
        }
    }
    
    /**
     * Simple image preview modal
     */
    showSimpleImagePreview(screenshot) {
        const modal = document.createElement('div');
        modal.className = 'screenshot-preview-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <button class="modal-close">×</button>
                <img src="file://${screenshot.filepath}" alt="${screenshot.filename}">
                <div class="screenshot-details">
                    <h3>${screenshot.filename}</h3>
                    <p>Captured: ${new Date(screenshot.timestamp).toLocaleString()}</p>
                    <p>Type: ${screenshot.type}</p>
                </div>
            </div>
        `;
        
        const closeBtn = modal.querySelector('.modal-close');
        closeBtn.addEventListener('click', () => modal.remove());
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
        
        document.addEventListener('keydown', function escapeHandler(e) {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', escapeHandler);
            }
        });
        
        document.body.appendChild(modal);
    }
    
    /**
     * Delete a screenshot
     */
    async deleteScreenshot(screenshotId) {
        try {
            const result = await window.ipcRenderer.invoke('screenshot-delete', screenshotId);
            
            if (!result.success) {
                throw new Error('Failed to delete screenshot');
            }
            
            // Remove from local state
            const index = this.state.screenshots.findIndex(s => s.id === screenshotId);
            if (index !== -1) {
                this.state.screenshots.splice(index, 1);
                this.updateScreenshotList();
            }
            
        } catch (error) {
            console.error('Error deleting screenshot:', error);
            this.showError('Failed to delete screenshot');
        }
    }
    
    /**
     * Setup drag and drop for reordering
     */
    setupDragAndDrop() {
        const list = this.elements.screenshotList;
        
        list.addEventListener('dragstart', (e) => {
            if (!e.target.classList.contains('screenshot-item')) {
                return;
            }
            
            this.dragState.isDragging = true;
            this.dragState.dragElement = e.target;
            this.dragState.startIndex = parseInt(e.target.dataset.index);
            
            e.target.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        
        list.addEventListener('dragover', (e) => {
            if (!this.dragState.isDragging) return;
            
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            const afterElement = this.getDragAfterElement(list, e.clientY);
            const dragElement = this.dragState.dragElement;
            
            if (afterElement == null) {
                list.appendChild(dragElement);
            } else {
                list.insertBefore(dragElement, afterElement);
            }
        });
        
        list.addEventListener('dragend', (e) => {
            if (!this.dragState.isDragging) return;
            
            e.target.classList.remove('dragging');
            this.applyReorder();
            
            this.dragState.isDragging = false;
            this.dragState.dragElement = null;
            this.dragState.startIndex = -1;
        });
    }
    
    /**
     * Get element to insert dragged item after
     */
    getDragAfterElement(container, y) {
        const draggableElements = [...container.querySelectorAll('.screenshot-item:not(.dragging)')];
        
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }
    
    /**
     * Apply reordering after drag and drop
     */
    async applyReorder() {
        const items = this.elements.screenshotList.querySelectorAll('.screenshot-item');
        const newOrder = Array.from(items).map(item => item.dataset.screenshotId);
        
        try {
            const result = await window.ipcRenderer.invoke('screenshot-reorder', newOrder);
            
            if (result.success) {
                // Update local state to match new order
                const reorderedScreenshots = newOrder.map(id => 
                    this.state.screenshots.find(s => s.id === id)
                ).filter(Boolean);
                
                this.state.screenshots = reorderedScreenshots;
                this.updateScreenshotList();
            }
            
        } catch (error) {
            console.error('Error reordering screenshots:', error);
            // Restore original order on error
            this.updateScreenshotList();
        }
    }
    
    /**
     * Play screenshot sound effect
     */
    playScreenshotSound() {
        // Integrate with existing sound system if available
        if (window.terminalGUI && window.terminalGUI.playSoundEffect) {
            window.terminalGUI.playSoundEffect('screenshot.wav');
        }
    }
    
    /**
     * Show success message
     */
    showSuccess(message) {
        console.log('Screenshot Success:', message);
        if (window.terminalGUI && window.terminalGUI.logAction) {
            window.terminalGUI.logAction(message, 'success');
        }
    }
    
    /**
     * Show info message
     */
    showInfo(message) {
        console.log('Screenshot Info:', message);
        if (window.terminalGUI && window.terminalGUI.logAction) {
            window.terminalGUI.logAction(message, 'info');
        }
    }
    
    /**
     * Show warning message
     */
    showWarning(message) {
        console.warn('Screenshot Warning:', message);
        if (window.terminalGUI && window.terminalGUI.logAction) {
            window.terminalGUI.logAction(message, 'warning');
        }
    }
    
    /**
     * Show error message
     */
    showError(message) {
        console.error('Screenshot Error:', message);
        if (window.terminalGUI && window.terminalGUI.logAction) {
            window.terminalGUI.logAction(message, 'error');
        }
    }
    
    /**
     * Get current state for debugging
     */
    getState() {
        return {
            ...this.state,
            screenshotCount: this.state.screenshots.length
        };
    }
    
    /**
     * Clean up resources
     */
    cleanup() {
        // Remove event listeners
        if (window.ipcRenderer) {
            window.ipcRenderer.removeAllListeners('screenshot-initialized');
            window.ipcRenderer.removeAllListeners('screenshot-device-connected');
            window.ipcRenderer.removeAllListeners('screenshot-captured');
            window.ipcRenderer.removeAllListeners('screenshot-capture-started');
            window.ipcRenderer.removeAllListeners('screenshot-capture-stopped');
            window.ipcRenderer.removeAllListeners('screenshot-error');
            window.ipcRenderer.removeAllListeners('screenshot-auto-captured');
        }
        
        // Remove UI elements
        if (this.elements.container) {
            this.elements.container.remove();
        }
    }
}

// Export for use in renderer
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ScreenshotUIController;
} else {
    window.ScreenshotUIController = ScreenshotUIController;
}