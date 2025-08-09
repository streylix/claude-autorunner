/**
 * ADB Integration Example - Simple integration example for existing applications
 * Shows how to integrate ADB functionality into existing Electron renderer processes
 */

class ADBIntegrationExample {
    constructor(parentContainer) {
        this.parentContainer = parentContainer;
        this.adbInitialized = false;
        this.devices = [];
        this.selectedDevice = null;
        
        // For coordination with ScreenshotEngine
        this.onScreenshotCallback = null;
        
        this.setupIPC();
    }

    /**
     * Setup IPC communication with main process
     */
    setupIPC() {
        const { ipcRenderer } = require('electron');

        // Listen for ADB events
        ipcRenderer.on('adb-device-connected', (event, data) => {
            this.handleDeviceConnected(data);
        });

        ipcRenderer.on('adb-device-disconnected', (event, data) => {
            this.handleDeviceDisconnected(data);
        });

        ipcRenderer.on('adb-screenshot-ready', (event, data) => {
            this.handleScreenshotReady(data);
        });
    }

    /**
     * Initialize ADB system
     */
    async initializeADB() {
        const { ipcRenderer } = require('electron');
        
        try {
            console.log('[ADB Integration] Initializing ADB...');
            const result = await ipcRenderer.invoke('adb-initialize');
            
            if (result.success) {
                this.adbInitialized = true;
                this.devices = result.devices || [];
                
                // Auto-select first connected device
                const connectedDevice = this.devices.find(d => d.isConnected);
                if (connectedDevice) {
                    await this.selectDevice(connectedDevice.device.id);
                }
                
                console.log('[ADB Integration] ADB initialized successfully');
                return { success: true, devices: this.devices };
            } else {
                console.error('[ADB Integration] ADB initialization failed:', result.error);
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error('[ADB Integration] ADB initialization error:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get available devices
     */
    async getDevices() {
        const { ipcRenderer } = require('electron');
        
        try {
            const result = await ipcRenderer.invoke('adb-get-devices');
            
            if (result.success) {
                this.devices = result.devices;
                return { success: true, devices: this.devices };
            } else {
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error('[ADB Integration] Failed to get devices:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Select a device for operations
     */
    async selectDevice(deviceId) {
        const { ipcRenderer } = require('electron');
        
        try {
            const result = await ipcRenderer.invoke('adb-select-device', deviceId);
            
            if (result.success) {
                this.selectedDevice = deviceId;
                console.log('[ADB Integration] Device selected:', deviceId);
                return { success: true, deviceId };
            } else {
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error('[ADB Integration] Failed to select device:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Take screenshot from selected device
     */
    async takeScreenshot(options = {}) {
        const { ipcRenderer } = require('electron');
        
        try {
            const result = await ipcRenderer.invoke('adb-take-screenshot', {
                deviceId: this.selectedDevice,
                timeout: options.timeout || 10000,
                useCache: options.useCache !== false
            });
            
            if (result.success) {
                console.log('[ADB Integration] Screenshot captured');
                
                // Call callback if set (for ScreenshotEngine coordination)
                if (this.onScreenshotCallback) {
                    this.onScreenshotCallback(result.screenshot);
                }
                
                return { success: true, screenshot: result.screenshot };
            } else {
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error('[ADB Integration] Screenshot failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get device display information
     */
    async getDeviceDisplayInfo(deviceId = null) {
        const { ipcRenderer } = require('electron');
        
        try {
            const result = await ipcRenderer.invoke('adb-get-display-info', deviceId || this.selectedDevice);
            
            if (result.success) {
                return { success: true, displayInfo: result.displayInfo };
            } else {
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error('[ADB Integration] Failed to get display info:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Test device connection
     */
    async testConnection(deviceId = null) {
        const { ipcRenderer } = require('electron');
        
        try {
            const result = await ipcRenderer.invoke('adb-test-connection', deviceId || this.selectedDevice);
            
            if (result.success) {
                return { success: true, connectionTest: result.connectionTest };
            } else {
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error('[ADB Integration] Connection test failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get ADB system status
     */
    async getStatus() {
        const { ipcRenderer } = require('electron');
        
        try {
            const result = await ipcRenderer.invoke('adb-get-status');
            
            if (result.success) {
                return { success: true, status: result.status, devices: result.devices };
            } else {
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error('[ADB Integration] Failed to get status:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Get performance metrics
     */
    async getMetrics() {
        const { ipcRenderer } = require('electron');
        
        try {
            const result = await ipcRenderer.invoke('adb-get-metrics');
            
            if (result.success) {
                return { success: true, metrics: result.metrics };
            } else {
                return { success: false, error: result.error };
            }
        } catch (error) {
            console.error('[ADB Integration] Failed to get metrics:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Create device selection UI
     */
    createDeviceSelector(container) {
        const selectorHtml = `
            <div class="adb-device-selector">
                <label for="adb-device-select">📱 Android Device:</label>
                <select id="adb-device-select" class="form-control">
                    <option value="">Select a device...</option>
                </select>
                <button id="adb-refresh-devices" class="btn btn-sm btn-secondary">🔄 Refresh</button>
                <button id="adb-test-device" class="btn btn-sm btn-info" disabled>🧪 Test</button>
            </div>
        `;
        
        container.innerHTML = selectorHtml;
        
        // Setup event listeners
        const deviceSelect = container.querySelector('#adb-device-select');
        const refreshButton = container.querySelector('#adb-refresh-devices');
        const testButton = container.querySelector('#adb-test-device');
        
        deviceSelect.addEventListener('change', async (e) => {
            const deviceId = e.target.value;
            if (deviceId) {
                await this.selectDevice(deviceId);
                testButton.disabled = false;
            } else {
                testButton.disabled = true;
            }
        });
        
        refreshButton.addEventListener('click', async () => {
            await this.refreshDeviceSelector(deviceSelect);
        });
        
        testButton.addEventListener('click', async () => {
            const result = await this.testConnection();
            if (result.success) {
                this.showToast('Connection test successful', 'success');
            } else {
                this.showToast(`Connection test failed: ${result.error}`, 'error');
            }
        });
        
        // Initial population
        this.refreshDeviceSelector(deviceSelect);
        
        return container;
    }

    /**
     * Refresh device selector dropdown
     */
    async refreshDeviceSelector(selectElement) {
        const result = await this.getDevices();
        
        if (result.success) {
            selectElement.innerHTML = '<option value="">Select a device...</option>';
            
            result.devices.forEach(deviceInfo => {
                const device = deviceInfo.device;
                const isConnected = deviceInfo.isConnected;
                const option = document.createElement('option');
                
                option.value = device.id;
                option.textContent = `${device.model || device.id} (${device.status})`;
                option.disabled = !isConnected;
                
                if (deviceInfo.isSelected) {
                    option.selected = true;
                }
                
                selectElement.appendChild(option);
            });
        }
    }

    /**
     * Coordinate with ScreenshotEngine agent
     */
    setScreenshotCallback(callback) {
        this.onScreenshotCallback = callback;
    }

    /**
     * Integration method for ScreenshotEngine
     */
    async captureForScreenshotEngine() {
        if (!this.selectedDevice) {
            throw new Error('No ADB device selected');
        }
        
        const result = await this.takeScreenshot();
        
        if (result.success) {
            // Return screenshot data in format expected by ScreenshotEngine
            return {
                success: true,
                data: result.screenshot.data, // Base64 data
                dataUrl: result.screenshot.dataUrl,
                width: result.screenshot.deviceInfo?.displayInfo?.width,
                height: result.screenshot.deviceInfo?.displayInfo?.height,
                format: 'png',
                source: 'adb',
                deviceId: this.selectedDevice,
                timestamp: Date.now()
            };
        } else {
            throw new Error(result.error);
        }
    }

    /**
     * Handle device connected event
     */
    handleDeviceConnected(data) {
        console.log('[ADB Integration] Device connected:', data.device?.id);
        
        // Update devices list
        this.getDevices();
        
        // Show notification if available
        this.showToast(`Device connected: ${data.device?.model || data.device?.id}`, 'success');
    }

    /**
     * Handle device disconnected event
     */
    handleDeviceDisconnected(data) {
        console.log('[ADB Integration] Device disconnected:', data.device?.id);
        
        // Update devices list
        this.getDevices();
        
        // Clear selection if this device was selected
        if (this.selectedDevice === data.device?.id) {
            this.selectedDevice = null;
        }
        
        // Show notification if available
        this.showToast(`Device disconnected: ${data.device?.model || data.device?.id}`, 'info');
    }

    /**
     * Handle screenshot ready event
     */
    handleScreenshotReady(data) {
        console.log('[ADB Integration] Screenshot ready from device:', data.deviceId);
        
        // Call callback if set
        if (this.onScreenshotCallback) {
            this.onScreenshotCallback({
                success: true,
                data: data.data,
                deviceId: data.deviceId,
                size: data.size,
                timestamp: data.timestamp
            });
        }
    }

    /**
     * Show toast notification (if toast system is available)
     */
    showToast(message, type = 'info') {
        // Try to use existing toast system
        if (window.showToast) {
            window.showToast(message, type);
        } else if (window.toastr) {
            window.toastr[type](message);
        } else {
            // Fallback to console
            console.log(`[ADB Integration] ${type.toUpperCase()}: ${message}`);
        }
    }

    /**
     * Check if ADB is available and initialized
     */
    isAvailable() {
        return this.adbInitialized && this.devices.length > 0;
    }

    /**
     * Check if a device is selected and ready
     */
    isReady() {
        return this.isAvailable() && this.selectedDevice !== null;
    }

    /**
     * Get summary information
     */
    getSummary() {
        return {
            initialized: this.adbInitialized,
            deviceCount: this.devices.length,
            connectedDevices: this.devices.filter(d => d.isConnected).length,
            selectedDevice: this.selectedDevice,
            ready: this.isReady()
        };
    }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ADBIntegrationExample;
}

// Global access
window.ADBIntegrationExample = ADBIntegrationExample;