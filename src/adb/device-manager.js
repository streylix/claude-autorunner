/**
 * Device Manager - High-level device state management and coordination
 * Manages device selection, status tracking, and screenshot capture coordination
 */

const { EventEmitter } = require('events');
const ADBManager = require('./adb-manager');

class DeviceManager extends EventEmitter {
    constructor() {
        super();
        
        // Core ADB functionality
        this.adbManager = new ADBManager();
        
        // Device state management
        this.selectedDevice = null; // Currently selected device for operations
        this.deviceStates = new Map(); // deviceId -> state info
        this.screenshotQueue = new Map(); // deviceId -> screenshot request queue
        
        // Screenshot optimization
        this.screenshotCache = new Map(); // deviceId -> cached screenshot data
        this.screenshotCacheTimeout = 1000; // 1 second cache
        this.lastScreenshotTime = new Map(); // deviceId -> timestamp
        
        // Connection tracking
        this.connectionAttempts = new Map(); // deviceId -> attempt count
        this.maxConnectionAttempts = 3;
        this.connectionTimeout = 10000; // 10 seconds
        
        // Performance metrics
        this.metrics = {
            screenshotsCount: 0,
            screenshotErrors: 0,
            averageScreenshotTime: 0,
            connectionAttempts: 0,
            successfulConnections: 0
        };
        
        // Setup ADB manager event handlers
        this.setupADBEventHandlers();
        
        // Auto-initialize
        this.initialize();
    }

    /**
     * Initialize device manager
     */
    async initialize() {
        try {
            console.log('[DeviceManager] Initializing...');
            
            // Initialize ADB
            const adbReady = await this.adbManager.detectADBPath();
            if (!adbReady) {
                throw new Error('ADB not found on system');
            }
            
            // Get initial device list
            const devices = await this.adbManager.getDevices();
            this.processInitialDevices(devices);
            
            // Start monitoring
            this.adbManager.startDeviceMonitoring();
            
            this.emit('initialized', {
                adbPath: this.adbManager.adbPath,
                deviceCount: devices.length,
                connectedDevices: devices.filter(d => d.status === 'device').length
            });
            
            console.log('[DeviceManager] Initialized successfully');
            
        } catch (error) {
            console.error('[DeviceManager] Initialization failed:', error.message);
            this.emit('initialization-error', error);
            throw error;
        }
    }

    /**
     * Setup ADB manager event handlers
     */
    setupADBEventHandlers() {
        this.adbManager.on('device-connected', (device) => {
            console.log(`[DeviceManager] Device connected: ${device.id} (${device.model || 'Unknown'})`);
            this.handleDeviceConnected(device);
        });

        this.adbManager.on('device-disconnected', (device) => {
            console.log(`[DeviceManager] Device disconnected: ${device.id}`);
            this.handleDeviceDisconnected(device);
        });

        this.adbManager.on('adb-ready', (info) => {
            console.log(`[DeviceManager] ADB ready at: ${info.path}`);
            this.emit('adb-ready', info);
        });

        this.adbManager.on('adb-not-found', (info) => {
            console.error('[DeviceManager] ADB not found');
            this.emit('adb-not-found', info);
        });

        this.adbManager.on('screenshot-captured', (data) => {
            this.handleScreenshotCaptured(data);
        });

        this.adbManager.on('monitoring-error', (error) => {
            console.error('[DeviceManager] Monitoring error:', error.message);
            this.emit('monitoring-error', error);
        });
    }

    /**
     * Process initial device list
     */
    processInitialDevices(devices) {
        for (const device of devices) {
            this.deviceStates.set(device.id, {
                ...device,
                firstSeen: Date.now(),
                lastScreenshot: null,
                screenshotCount: 0,
                connectionAttempts: 0,
                isSelected: false
            });
            
            // Auto-select first connected device if none selected
            if (!this.selectedDevice && device.status === 'device') {
                this.selectDevice(device.id);
            }
        }
    }

    /**
     * Handle device connection
     */
    handleDeviceConnected(device) {
        // Update device state
        const existingState = this.deviceStates.get(device.id);
        this.deviceStates.set(device.id, {
            ...device,
            firstSeen: existingState?.firstSeen || Date.now(),
            lastScreenshot: existingState?.lastScreenshot || null,
            screenshotCount: existingState?.screenshotCount || 0,
            connectionAttempts: (existingState?.connectionAttempts || 0) + 1,
            isSelected: existingState?.isSelected || false,
            connectedAt: Date.now()
        });
        
        // Auto-select if no device selected
        if (!this.selectedDevice) {
            this.selectDevice(device.id);
        }
        
        // Clear connection attempts counter
        this.connectionAttempts.delete(device.id);
        
        // Update metrics
        this.metrics.successfulConnections++;
        
        this.emit('device-connected', {
            device,
            state: this.deviceStates.get(device.id),
            isSelected: this.selectedDevice === device.id
        });
    }

    /**
     * Handle device disconnection
     */
    handleDeviceDisconnected(device) {
        const state = this.deviceStates.get(device.id);
        if (state) {
            state.disconnectedAt = Date.now();
            state.isSelected = false;
        }
        
        // Clear caches for disconnected device
        this.screenshotCache.delete(device.id);
        this.lastScreenshotTime.delete(device.id);
        this.screenshotQueue.delete(device.id);
        
        // If this was the selected device, auto-select another
        if (this.selectedDevice === device.id) {
            this.selectedDevice = null;
            this.autoSelectDevice();
        }
        
        this.emit('device-disconnected', {
            device,
            state: this.deviceStates.get(device.id),
            wasSelected: this.selectedDevice === device.id
        });
    }

    /**
     * Auto-select the best available device
     */
    autoSelectDevice() {
        const connectedDevices = this.getConnectedDevices();
        if (connectedDevices.length > 0) {
            // Select first connected device
            this.selectDevice(connectedDevices[0].id);
        }
    }

    /**
     * Select a device for operations
     */
    selectDevice(deviceId) {
        if (!deviceId) {
            this.selectedDevice = null;
            this.emit('device-selected', null);
            return;
        }

        const device = this.adbManager.getDeviceById(deviceId);
        if (!device) {
            throw new Error(`Device ${deviceId} not found`);
        }

        if (device.status !== 'device') {
            throw new Error(`Device ${deviceId} is not ready (status: ${device.status})`);
        }

        // Update selection state
        if (this.selectedDevice) {
            const previousState = this.deviceStates.get(this.selectedDevice);
            if (previousState) {
                previousState.isSelected = false;
            }
        }

        this.selectedDevice = deviceId;
        const state = this.deviceStates.get(deviceId);
        if (state) {
            state.isSelected = true;
            state.selectedAt = Date.now();
        }

        console.log(`[DeviceManager] Selected device: ${deviceId} (${device.model || 'Unknown'})`);
        
        this.emit('device-selected', {
            device,
            state: this.deviceStates.get(deviceId)
        });
    }

    /**
     * Get all connected devices
     */
    getConnectedDevices() {
        return this.adbManager.getConnectedDevices();
    }

    /**
     * Get device information including state
     */
    getDeviceInfo(deviceId) {
        const device = this.adbManager.getDeviceById(deviceId);
        const state = this.deviceStates.get(deviceId);
        
        return {
            device,
            state,
            isSelected: this.selectedDevice === deviceId,
            isConnected: device?.status === 'device'
        };
    }

    /**
     * Get all devices with state information
     */
    getAllDevicesWithState() {
        const devices = [];
        for (const [deviceId, device] of this.adbManager.devices) {
            devices.push(this.getDeviceInfo(deviceId));
        }
        return devices;
    }

    /**
     * Take screenshot from selected device
     */
    async takeScreenshot(deviceId = null, options = {}) {
        const targetDeviceId = deviceId || this.selectedDevice;
        
        if (!targetDeviceId) {
            throw new Error('No device selected for screenshot');
        }

        const device = this.adbManager.getDeviceById(targetDeviceId);
        if (!device || device.status !== 'device') {
            throw new Error(`Device ${targetDeviceId} not available for screenshot`);
        }

        // Check cache if enabled
        if (options.useCache !== false) {
            const cached = this.getCachedScreenshot(targetDeviceId);
            if (cached) {
                return cached;
            }
        }

        try {
            const startTime = Date.now();
            
            // Take screenshot via ADB manager
            const result = await this.adbManager.takeScreenshot(targetDeviceId, options);
            
            const duration = Date.now() - startTime;
            
            // Update metrics
            this.metrics.screenshotsCount++;
            this.metrics.averageScreenshotTime = 
                (this.metrics.averageScreenshotTime * (this.metrics.screenshotsCount - 1) + duration) / 
                this.metrics.screenshotsCount;
            
            // Update device state
            const state = this.deviceStates.get(targetDeviceId);
            if (state) {
                state.lastScreenshot = Date.now();
                state.screenshotCount = (state.screenshotCount || 0) + 1;
            }
            
            // Cache screenshot
            this.cacheScreenshot(targetDeviceId, result);
            
            return {
                ...result,
                duration,
                deviceInfo: this.getDeviceInfo(targetDeviceId)
            };
            
        } catch (error) {
            this.metrics.screenshotErrors++;
            console.error(`[DeviceManager] Screenshot failed for device ${targetDeviceId}:`, error.message);
            throw error;
        }
    }

    /**
     * Cache screenshot data
     */
    cacheScreenshot(deviceId, screenshotData) {
        this.screenshotCache.set(deviceId, {
            ...screenshotData,
            cachedAt: Date.now()
        });
        
        this.lastScreenshotTime.set(deviceId, Date.now());
        
        // Auto-cleanup old cache
        setTimeout(() => {
            this.screenshotCache.delete(deviceId);
        }, this.screenshotCacheTimeout);
    }

    /**
     * Get cached screenshot if valid
     */
    getCachedScreenshot(deviceId) {
        const cached = this.screenshotCache.get(deviceId);
        if (!cached) return null;
        
        const age = Date.now() - cached.cachedAt;
        if (age > this.screenshotCacheTimeout) {
            this.screenshotCache.delete(deviceId);
            return null;
        }
        
        return {
            ...cached,
            fromCache: true,
            cacheAge: age
        };
    }

    /**
     * Handle screenshot captured event
     */
    handleScreenshotCaptured(data) {
        this.emit('screenshot-ready', {
            ...data,
            deviceInfo: this.getDeviceInfo(data.deviceId)
        });
    }

    /**
     * Get device display information
     */
    async getDeviceDisplayInfo(deviceId = null) {
        const targetDeviceId = deviceId || this.selectedDevice;
        
        if (!targetDeviceId) {
            throw new Error('No device selected');
        }

        try {
            const displayInfo = await this.adbManager.getDisplayInfo(targetDeviceId);
            
            return {
                ...displayInfo,
                deviceId: targetDeviceId,
                deviceInfo: this.getDeviceInfo(targetDeviceId)
            };
        } catch (error) {
            console.error(`[DeviceManager] Failed to get display info for ${targetDeviceId}:`, error.message);
            throw error;
        }
    }

    /**
     * Get manager status
     */
    getStatus() {
        return {
            initialized: this.adbManager.isInitialized,
            adbPath: this.adbManager.adbPath,
            selectedDevice: this.selectedDevice,
            deviceCount: this.adbManager.devices.size,
            connectedDeviceCount: this.adbManager.connectedDevices.size,
            metrics: { ...this.metrics },
            monitoring: !!this.adbManager.reconnectionTimer
        };
    }

    /**
     * Refresh device list
     */
    async refreshDevices() {
        try {
            console.log('[DeviceManager] Refreshing device list...');
            const devices = await this.adbManager.getDevices();
            
            this.emit('devices-refreshed', {
                devices,
                deviceCount: devices.length,
                connectedCount: devices.filter(d => d.status === 'device').length
            });
            
            return devices;
        } catch (error) {
            console.error('[DeviceManager] Failed to refresh devices:', error.message);
            throw error;
        }
    }

    /**
     * Test device connection
     */
    async testConnection(deviceId = null) {
        const targetDeviceId = deviceId || this.selectedDevice;
        
        if (!targetDeviceId) {
            throw new Error('No device specified for connection test');
        }

        try {
            // Test with a simple command
            const result = await this.adbManager.executeCommand(
                targetDeviceId,
                ['shell', 'echo', 'test'],
                [],
                { timeout: 5000 }
            );
            
            return {
                success: true,
                deviceId: targetDeviceId,
                responseTime: Date.now(),
                output: result.output.trim()
            };
        } catch (error) {
            return {
                success: false,
                deviceId: targetDeviceId,
                error: error.message
            };
        }
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        console.log('[DeviceManager] Cleaning up...');
        
        // Clear caches
        this.screenshotCache.clear();
        this.lastScreenshotTime.clear();
        this.screenshotQueue.clear();
        this.deviceStates.clear();
        this.connectionAttempts.clear();
        
        // Cleanup ADB manager
        this.adbManager.cleanup();
        
        // Remove listeners
        this.removeAllListeners();
        
        console.log('[DeviceManager] Cleanup completed');
    }

    /**
     * Get performance metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            deviceCount: this.adbManager.devices.size,
            connectedDevices: this.adbManager.connectedDevices.size,
            selectedDevice: this.selectedDevice,
            cacheSize: this.screenshotCache.size,
            uptime: Date.now() - (this.initTime || Date.now())
        };
    }
}

module.exports = DeviceManager;