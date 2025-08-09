/**
 * ADB Integration Demo - UI component for testing ADB functionality
 * Demonstrates device discovery, selection, screenshot capture, and real-time monitoring
 */

class ADBDemo {
    constructor() {
        this.initialized = false;
        this.selectedDevice = null;
        this.devices = [];
        this.screenshotInterval = null;
        this.lastScreenshotTime = 0;
        this.screenshotCount = 0;
        
        // UI elements will be created dynamically
        this.container = null;
        this.deviceList = null;
        this.screenshotDisplay = null;
        this.statusDisplay = null;
        this.metricsDisplay = null;
        
        // Setup IPC listeners
        this.setupIPCListeners();
    }

    /**
     * Setup IPC event listeners for ADB events
     */
    setupIPCListeners() {
        const { ipcRenderer } = require('electron');

        // Device events
        ipcRenderer.on('adb-device-connected', (event, data) => {
            console.log('[ADB Demo] Device connected:', data);
            this.handleDeviceConnected(data);
        });

        ipcRenderer.on('adb-device-disconnected', (event, data) => {
            console.log('[ADB Demo] Device disconnected:', data);
            this.handleDeviceDisconnected(data);
        });

        ipcRenderer.on('adb-device-selected', (event, data) => {
            console.log('[ADB Demo] Device selected:', data);
            this.handleDeviceSelected(data);
        });

        ipcRenderer.on('adb-screenshot-ready', (event, data) => {
            console.log('[ADB Demo] Screenshot ready:', data);
            this.handleScreenshotReady(data);
        });

        ipcRenderer.on('adb-not-found', (event, data) => {
            console.log('[ADB Demo] ADB not found:', data);
            this.handleADBNotFound(data);
        });
    }

    /**
     * Initialize ADB integration
     */
    async initialize() {
        const { ipcRenderer } = require('electron');
        
        try {
            console.log('[ADB Demo] Initializing ADB integration...');
            const result = await ipcRenderer.invoke('adb-initialize');
            
            if (result.success) {
                this.initialized = true;
                this.devices = result.devices || [];
                console.log('[ADB Demo] ADB initialized successfully:', result);
                this.updateUI();
                this.showNotification('ADB Integration', 'ADB initialized successfully', 'success');
            } else {
                console.error('[ADB Demo] ADB initialization failed:', result.error);
                this.showNotification('ADB Error', result.error, 'error');
            }
        } catch (error) {
            console.error('[ADB Demo] ADB initialization error:', error);
            this.showNotification('ADB Error', error.message, 'error');
        }
    }

    /**
     * Create demo UI
     */
    createUI() {
        // Create main container
        this.container = document.createElement('div');
        this.container.className = 'adb-demo-container';
        this.container.innerHTML = `
            <div class="adb-demo-header">
                <h3>🤖 ADB Integration Demo</h3>
                <div class="adb-demo-controls">
                    <button id="adb-init-btn" class="btn btn-primary">Initialize ADB</button>
                    <button id="adb-refresh-btn" class="btn btn-secondary" disabled>Refresh Devices</button>
                    <button id="adb-screenshot-btn" class="btn btn-success" disabled>Take Screenshot</button>
                    <button id="adb-start-capture-btn" class="btn btn-info" disabled>Start Live Capture</button>
                    <button id="adb-stop-capture-btn" class="btn btn-warning" disabled>Stop Live Capture</button>
                </div>
            </div>

            <div class="adb-demo-content">
                <div class="adb-demo-sidebar">
                    <div class="adb-status">
                        <h4>📊 Status</h4>
                        <div id="adb-status-display">Not initialized</div>
                    </div>
                    
                    <div class="adb-devices">
                        <h4>📱 Devices</h4>
                        <div id="adb-device-list">No devices found</div>
                    </div>
                    
                    <div class="adb-metrics">
                        <h4>📈 Metrics</h4>
                        <div id="adb-metrics-display">No metrics available</div>
                    </div>
                </div>

                <div class="adb-demo-main">
                    <div class="adb-screenshot-container">
                        <h4>📸 Device Screenshot</h4>
                        <div id="adb-screenshot-display">
                            <div class="no-screenshot">No screenshot available</div>
                        </div>
                        <div class="screenshot-info">
                            <span id="screenshot-count">Screenshots: 0</span>
                            <span id="screenshot-time">Last: Never</span>
                            <span id="screenshot-size">Size: -</span>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Add CSS styles
        this.addStyles();

        // Setup event listeners
        this.setupEventListeners();

        // Cache UI elements
        this.deviceList = this.container.querySelector('#adb-device-list');
        this.screenshotDisplay = this.container.querySelector('#adb-screenshot-display');
        this.statusDisplay = this.container.querySelector('#adb-status-display');
        this.metricsDisplay = this.container.querySelector('#adb-metrics-display');

        return this.container;
    }

    /**
     * Add CSS styles for the demo UI
     */
    addStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .adb-demo-container {
                background: #2d2d2d;
                border: 1px solid #555;
                border-radius: 8px;
                margin: 10px;
                overflow: hidden;
            }

            .adb-demo-header {
                background: #3d3d3d;
                padding: 15px;
                border-bottom: 1px solid #555;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .adb-demo-header h3 {
                margin: 0;
                color: #fff;
                font-size: 18px;
            }

            .adb-demo-controls {
                display: flex;
                gap: 10px;
            }

            .adb-demo-controls .btn {
                padding: 6px 12px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                transition: all 0.2s;
            }

            .btn-primary { background: #007acc; color: white; }
            .btn-secondary { background: #6c757d; color: white; }
            .btn-success { background: #28a745; color: white; }
            .btn-info { background: #17a2b8; color: white; }
            .btn-warning { background: #ffc107; color: black; }
            .btn:disabled { background: #555; color: #999; cursor: not-allowed; }
            .btn:not(:disabled):hover { transform: translateY(-1px); box-shadow: 0 2px 4px rgba(0,0,0,0.2); }

            .adb-demo-content {
                display: flex;
                height: 500px;
            }

            .adb-demo-sidebar {
                width: 300px;
                background: #353535;
                border-right: 1px solid #555;
                overflow-y: auto;
            }

            .adb-demo-sidebar > div {
                padding: 15px;
                border-bottom: 1px solid #555;
            }

            .adb-demo-sidebar h4 {
                margin: 0 0 10px 0;
                color: #fff;
                font-size: 14px;
            }

            .adb-demo-main {
                flex: 1;
                padding: 15px;
                overflow: auto;
            }

            .adb-screenshot-container h4 {
                margin: 0 0 15px 0;
                color: #fff;
                font-size: 14px;
            }

            #adb-screenshot-display {
                border: 1px solid #555;
                border-radius: 4px;
                min-height: 300px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: #1e1e1e;
                position: relative;
                overflow: hidden;
            }

            #adb-screenshot-display img {
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
            }

            .no-screenshot {
                color: #999;
                font-style: italic;
            }

            .screenshot-info {
                margin-top: 10px;
                display: flex;
                justify-content: space-between;
                font-size: 12px;
                color: #ccc;
            }

            .device-item {
                background: #404040;
                border: 1px solid #555;
                border-radius: 4px;
                padding: 10px;
                margin: 5px 0;
                cursor: pointer;
                transition: all 0.2s;
            }

            .device-item:hover {
                background: #4a4a4a;
                border-color: #007acc;
            }

            .device-item.selected {
                background: #007acc;
                border-color: #0056b3;
            }

            .device-name {
                font-weight: bold;
                color: #fff;
                margin-bottom: 5px;
            }

            .device-details {
                font-size: 11px;
                color: #ccc;
            }

            .device-status {
                display: inline-block;
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 10px;
                font-weight: bold;
                text-transform: uppercase;
            }

            .device-status.device { background: #28a745; color: white; }
            .device-status.unauthorized { background: #ffc107; color: black; }
            .device-status.offline { background: #dc3545; color: white; }

            .status-item, .metrics-item {
                display: flex;
                justify-content: space-between;
                margin: 5px 0;
                font-size: 12px;
                color: #ccc;
            }

            .status-value, .metrics-value {
                color: #fff;
                font-weight: bold;
            }

            .notification {
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 12px 20px;
                border-radius: 4px;
                color: white;
                font-weight: bold;
                z-index: 1000;
                animation: slideIn 0.3s ease-out;
            }

            .notification.success { background: #28a745; }
            .notification.error { background: #dc3545; }
            .notification.info { background: #17a2b8; }

            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Setup event listeners for UI interactions
     */
    setupEventListeners() {
        // Initialize ADB
        this.container.querySelector('#adb-init-btn').addEventListener('click', () => {
            this.initialize();
        });

        // Refresh devices
        this.container.querySelector('#adb-refresh-btn').addEventListener('click', () => {
            this.refreshDevices();
        });

        // Take screenshot
        this.container.querySelector('#adb-screenshot-btn').addEventListener('click', () => {
            this.takeScreenshot();
        });

        // Start live capture
        this.container.querySelector('#adb-start-capture-btn').addEventListener('click', () => {
            this.startLiveCapture();
        });

        // Stop live capture
        this.container.querySelector('#adb-stop-capture-btn').addEventListener('click', () => {
            this.stopLiveCapture();
        });
    }

    /**
     * Update UI state
     */
    updateUI() {
        // Update button states
        const initBtn = this.container.querySelector('#adb-init-btn');
        const refreshBtn = this.container.querySelector('#adb-refresh-btn');
        const screenshotBtn = this.container.querySelector('#adb-screenshot-btn');
        const startCaptureBtn = this.container.querySelector('#adb-start-capture-btn');
        const stopCaptureBtn = this.container.querySelector('#adb-stop-capture-btn');

        if (this.initialized) {
            initBtn.textContent = 'Reinitialize ADB';
            refreshBtn.disabled = false;
            
            if (this.selectedDevice) {
                screenshotBtn.disabled = false;
                startCaptureBtn.disabled = false;
            }
        }

        if (this.screenshotInterval) {
            startCaptureBtn.disabled = true;
            stopCaptureBtn.disabled = false;
        } else {
            stopCaptureBtn.disabled = true;
        }

        // Update device list
        this.updateDeviceList();
        
        // Update status
        this.updateStatus();
        
        // Update metrics
        this.updateMetrics();
    }

    /**
     * Update device list display
     */
    updateDeviceList() {
        if (!this.deviceList) return;

        if (this.devices.length === 0) {
            this.deviceList.innerHTML = '<div class="no-devices">No devices found</div>';
            return;
        }

        this.deviceList.innerHTML = this.devices.map(deviceInfo => {
            const device = deviceInfo.device;
            const state = deviceInfo.state;
            const isSelected = deviceInfo.isSelected;
            
            return `
                <div class="device-item ${isSelected ? 'selected' : ''}" data-device-id="${device.id}">
                    <div class="device-name">
                        ${device.model || device.id}
                        <span class="device-status ${device.status}">${device.status}</span>
                    </div>
                    <div class="device-details">
                        ID: ${device.id}<br>
                        Product: ${device.product || 'Unknown'}<br>
                        Screenshots: ${state?.screenshotCount || 0}
                    </div>
                </div>
            `;
        }).join('');

        // Add click handlers
        this.deviceList.querySelectorAll('.device-item').forEach(item => {
            item.addEventListener('click', () => {
                const deviceId = item.dataset.deviceId;
                this.selectDevice(deviceId);
            });
        });
    }

    /**
     * Update status display
     */
    updateStatus() {
        if (!this.statusDisplay) return;

        const status = this.initialized ? 'Initialized' : 'Not initialized';
        const deviceCount = this.devices.length;
        const connectedCount = this.devices.filter(d => d.isConnected).length;
        const selectedDevice = this.selectedDevice ? 
            (this.devices.find(d => d.device.id === this.selectedDevice)?.device.model || this.selectedDevice) : 
            'None';

        this.statusDisplay.innerHTML = `
            <div class="status-item">
                <span>Status:</span>
                <span class="status-value">${status}</span>
            </div>
            <div class="status-item">
                <span>Devices:</span>
                <span class="status-value">${connectedCount}/${deviceCount}</span>
            </div>
            <div class="status-item">
                <span>Selected:</span>
                <span class="status-value">${selectedDevice}</span>
            </div>
            <div class="status-item">
                <span>Live Capture:</span>
                <span class="status-value">${this.screenshotInterval ? 'Active' : 'Inactive'}</span>
            </div>
        `;
    }

    /**
     * Update metrics display
     */
    async updateMetrics() {
        if (!this.metricsDisplay || !this.initialized) return;

        try {
            const { ipcRenderer } = require('electron');
            const result = await ipcRenderer.invoke('adb-get-metrics');
            
            if (result.success) {
                const metrics = result.metrics;
                this.metricsDisplay.innerHTML = `
                    <div class="metrics-item">
                        <span>Screenshots:</span>
                        <span class="metrics-value">${metrics.screenshotsCount || 0}</span>
                    </div>
                    <div class="metrics-item">
                        <span>Errors:</span>
                        <span class="metrics-value">${metrics.screenshotErrors || 0}</span>
                    </div>
                    <div class="metrics-item">
                        <span>Avg Time:</span>
                        <span class="metrics-value">${Math.round(metrics.averageScreenshotTime || 0)}ms</span>
                    </div>
                    <div class="metrics-item">
                        <span>Cache Size:</span>
                        <span class="metrics-value">${metrics.cacheSize || 0}</span>
                    </div>
                `;
            }
        } catch (error) {
            console.error('[ADB Demo] Failed to get metrics:', error);
        }
    }

    /**
     * Refresh device list
     */
    async refreshDevices() {
        const { ipcRenderer } = require('electron');
        
        try {
            const result = await ipcRenderer.invoke('adb-get-devices');
            
            if (result.success) {
                this.devices = result.devices;
                this.updateUI();
                this.showNotification('Devices', 'Device list refreshed', 'info');
            } else {
                this.showNotification('Error', result.error, 'error');
            }
        } catch (error) {
            console.error('[ADB Demo] Failed to refresh devices:', error);
            this.showNotification('Error', error.message, 'error');
        }
    }

    /**
     * Select a device
     */
    async selectDevice(deviceId) {
        const { ipcRenderer } = require('electron');
        
        try {
            const result = await ipcRenderer.invoke('adb-select-device', deviceId);
            
            if (result.success) {
                this.selectedDevice = deviceId;
                this.updateUI();
                
                const device = this.devices.find(d => d.device.id === deviceId);
                const deviceName = device?.device.model || deviceId;
                this.showNotification('Device Selected', deviceName, 'success');
            } else {
                this.showNotification('Error', result.error, 'error');
            }
        } catch (error) {
            console.error('[ADB Demo] Failed to select device:', error);
            this.showNotification('Error', error.message, 'error');
        }
    }

    /**
     * Take a screenshot
     */
    async takeScreenshot() {
        const { ipcRenderer } = require('electron');
        
        try {
            const result = await ipcRenderer.invoke('adb-take-screenshot', {
                deviceId: this.selectedDevice,
                timeout: 10000
            });
            
            if (result.success) {
                this.displayScreenshot(result.screenshot);
                this.screenshotCount++;
                this.updateScreenshotInfo(result.screenshot);
                this.updateUI();
            } else {
                this.showNotification('Screenshot Error', result.error, 'error');
            }
        } catch (error) {
            console.error('[ADB Demo] Screenshot failed:', error);
            this.showNotification('Screenshot Error', error.message, 'error');
        }
    }

    /**
     * Start live capture
     */
    startLiveCapture() {
        if (this.screenshotInterval) return;

        this.screenshotInterval = setInterval(() => {
            this.takeScreenshot();
        }, 2000); // 2 second interval

        this.updateUI();
        this.showNotification('Live Capture', 'Started live capture (2s interval)', 'info');
    }

    /**
     * Stop live capture
     */
    stopLiveCapture() {
        if (this.screenshotInterval) {
            clearInterval(this.screenshotInterval);
            this.screenshotInterval = null;
        }

        this.updateUI();
        this.showNotification('Live Capture', 'Stopped live capture', 'info');
    }

    /**
     * Display screenshot in UI
     */
    displayScreenshot(screenshot) {
        if (!this.screenshotDisplay) return;

        const img = document.createElement('img');
        img.src = screenshot.dataUrl;
        img.alt = 'Device screenshot';
        
        this.screenshotDisplay.innerHTML = '';
        this.screenshotDisplay.appendChild(img);
    }

    /**
     * Update screenshot info
     */
    updateScreenshotInfo(screenshot) {
        const countElement = this.container.querySelector('#screenshot-count');
        const timeElement = this.container.querySelector('#screenshot-time');
        const sizeElement = this.container.querySelector('#screenshot-size');

        if (countElement) {
            countElement.textContent = `Screenshots: ${this.screenshotCount}`;
        }

        if (timeElement) {
            const now = new Date();
            timeElement.textContent = `Last: ${now.toLocaleTimeString()}`;
        }

        if (sizeElement && screenshot.size) {
            const kb = Math.round(screenshot.size / 1024);
            sizeElement.textContent = `Size: ${kb}KB`;
        }
    }

    /**
     * Handle device connected event
     */
    handleDeviceConnected(data) {
        this.refreshDevices();
        const deviceName = data.device?.model || data.device?.id || 'Unknown';
        this.showNotification('Device Connected', deviceName, 'success');
    }

    /**
     * Handle device disconnected event
     */
    handleDeviceDisconnected(data) {
        this.refreshDevices();
        const deviceName = data.device?.model || data.device?.id || 'Unknown';
        this.showNotification('Device Disconnected', deviceName, 'info');
    }

    /**
     * Handle device selected event
     */
    handleDeviceSelected(data) {
        if (data) {
            this.selectedDevice = data.device?.id;
            this.updateUI();
        }
    }

    /**
     * Handle screenshot ready event
     */
    handleScreenshotReady(data) {
        // This is handled automatically by the screenshot capture process
        console.log('[ADB Demo] Screenshot ready event received:', data);
    }

    /**
     * Handle ADB not found error
     */
    handleADBNotFound(data) {
        this.showNotification('ADB Not Found', 'Please install Android SDK Platform Tools', 'error');
        
        // Show detailed error information
        console.error('[ADB Demo] ADB not found:', data);
        
        if (this.statusDisplay) {
            this.statusDisplay.innerHTML = `
                <div class="status-item error">
                    <span>Error:</span>
                    <span class="status-value">ADB not found</span>
                </div>
                <div class="status-item">
                    <span>Platform:</span>
                    <span class="status-value">${data.platform}</span>
                </div>
                <div class="status-item">
                    <span>Searched paths:</span>
                    <span class="status-value">${data.searchedPaths?.length || 0}</span>
                </div>
            `;
        }
    }

    /**
     * Show notification
     */
    showNotification(title, message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `<strong>${title}:</strong> ${message}`;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 4000);
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        this.stopLiveCapture();
        
        if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ADBDemo;
}

// Global access
window.ADBDemo = ADBDemo;