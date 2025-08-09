/**
 * ADB Manager - Core ADB functionality for device discovery and communication
 * Handles ADB device operations, command execution, and error handling
 */

const { spawn, exec } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

class ADBManager extends EventEmitter {
    constructor() {
        super();
        
        // ADB binary detection
        this.adbPath = null;
        this.isInitialized = false;
        
        // Device management
        this.devices = new Map(); // deviceId -> device info
        this.connectedDevices = new Set(); // Currently connected device IDs
        
        // Command execution tracking
        this.activeCommands = new Map(); // commandId -> process
        this.commandIdCounter = 1;
        
        // Auto-reconnection settings
        this.reconnectionEnabled = true;
        this.reconnectionInterval = 5000; // 5 seconds
        this.reconnectionTimer = null;
        
        // Platform-specific settings
        this.platform = os.platform();
        this.isWindows = this.platform === 'win32';
        this.isMac = this.platform === 'darwin';
        this.isLinux = this.platform === 'linux';
        
        // Initialize ADB path detection
        this.detectADBPath();
    }

    /**
     * Detect ADB binary path across different platforms
     */
    async detectADBPath() {
        const possiblePaths = this.getPossibleADBPaths();
        
        for (const adbPath of possiblePaths) {
            try {
                if (await this.testADBPath(adbPath)) {
                    this.adbPath = adbPath;
                    this.isInitialized = true;
                    this.emit('adb-ready', { path: adbPath });
                    console.log(`[ADB] Found ADB at: ${adbPath}`);
                    return true;
                }
            } catch (error) {
                // Continue to next path
                continue;
            }
        }
        
        // ADB not found
        this.emit('adb-not-found', { 
            searchedPaths: possiblePaths,
            platform: this.platform 
        });
        console.error('[ADB] ADB binary not found in standard locations');
        return false;
    }

    /**
     * Get possible ADB paths based on platform
     */
    getPossibleADBPaths() {
        const paths = [];
        
        if (this.isWindows) {
            // Windows common locations
            paths.push(
                'C:\\Program Files\\Android\\platform-tools\\adb.exe',
                'C:\\Android\\platform-tools\\adb.exe',
                'C:\\Users\\%USERNAME%\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
                path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
                'adb.exe' // In PATH
            );
        } else if (this.isMac) {
            // macOS common locations
            paths.push(
                '/Users/' + os.userInfo().username + '/Library/Android/sdk/platform-tools/adb',
                '/opt/homebrew/bin/adb',
                '/usr/local/bin/adb',
                path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
                'adb' // In PATH
            );
        } else {
            // Linux common locations
            paths.push(
                '/home/' + os.userInfo().username + '/Android/Sdk/platform-tools/adb',
                '/usr/bin/adb',
                '/usr/local/bin/adb',
                '/opt/android-sdk/platform-tools/adb',
                path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'),
                'adb' // In PATH
            );
        }
        
        return paths;
    }

    /**
     * Test if ADB path is valid
     */
    async testADBPath(adbPath) {
        return new Promise((resolve) => {
            const process = spawn(adbPath, ['version'], { 
                stdio: 'pipe',
                timeout: 5000 
            });
            
            let output = '';
            process.stdout?.on('data', (data) => {
                output += data.toString();
            });
            
            process.on('close', (code) => {
                resolve(code === 0 && output.includes('Android Debug Bridge'));
            });
            
            process.on('error', () => {
                resolve(false);
            });
            
            // Timeout fallback
            setTimeout(() => {
                try {
                    process.kill();
                } catch (e) {
                    // Ignore
                }
                resolve(false);
            }, 5000);
        });
    }

    /**
     * Get list of connected devices
     */
    async getDevices() {
        if (!this.isInitialized) {
            throw new Error('ADB not initialized. Call detectADBPath() first.');
        }

        return new Promise((resolve, reject) => {
            const commandId = this.commandIdCounter++;
            const process = spawn(this.adbPath, ['devices', '-l'], {
                stdio: 'pipe',
                timeout: 10000
            });

            let output = '';
            let errorOutput = '';

            process.stdout.on('data', (data) => {
                output += data.toString();
            });

            process.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            process.on('close', (code) => {
                this.activeCommands.delete(commandId);
                
                if (code === 0) {
                    const devices = this.parseDevicesOutput(output);
                    this.updateDeviceList(devices);
                    resolve(devices);
                } else {
                    reject(new Error(`ADB devices command failed: ${errorOutput}`));
                }
            });

            process.on('error', (error) => {
                this.activeCommands.delete(commandId);
                reject(error);
            });

            this.activeCommands.set(commandId, process);
        });
    }

    /**
     * Parse ADB devices command output
     */
    parseDevicesOutput(output) {
        const devices = [];
        const lines = output.split('\n').filter(line => line.trim() && !line.includes('List of devices'));
        
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                const deviceId = parts[0];
                const status = parts[1];
                
                // Parse additional device info
                const deviceInfo = {
                    id: deviceId,
                    status: status,
                    model: null,
                    device: null,
                    product: null,
                    transport_id: null
                };
                
                // Extract model, device, product from additional info
                const additionalInfo = parts.slice(2).join(' ');
                const modelMatch = additionalInfo.match(/model:([^\s]+)/);
                const deviceMatch = additionalInfo.match(/device:([^\s]+)/);
                const productMatch = additionalInfo.match(/product:([^\s]+)/);
                const transportMatch = additionalInfo.match(/transport_id:([^\s]+)/);
                
                if (modelMatch) deviceInfo.model = modelMatch[1];
                if (deviceMatch) deviceInfo.device = deviceMatch[1];
                if (productMatch) deviceInfo.product = productMatch[1];
                if (transportMatch) deviceInfo.transport_id = transportMatch[1];
                
                devices.push(deviceInfo);
            }
        }
        
        return devices;
    }

    /**
     * Update internal device tracking
     */
    updateDeviceList(devices) {
        const currentDeviceIds = new Set();
        
        // Update device info
        for (const device of devices) {
            currentDeviceIds.add(device.id);
            const wasConnected = this.devices.has(device.id);
            this.devices.set(device.id, device);
            
            // Check for new connections
            if (device.status === 'device' && !wasConnected) {
                this.connectedDevices.add(device.id);
                this.emit('device-connected', device);
            }
        }
        
        // Check for disconnections
        for (const [deviceId, device] of this.devices) {
            if (!currentDeviceIds.has(deviceId) || 
                (currentDeviceIds.has(deviceId) && this.getDeviceById(deviceId)?.status !== 'device')) {
                if (this.connectedDevices.has(deviceId)) {
                    this.connectedDevices.delete(deviceId);
                    this.emit('device-disconnected', device);
                }
            }
        }
        
        // Remove disconnected devices from tracking
        for (const deviceId of this.devices.keys()) {
            if (!currentDeviceIds.has(deviceId)) {
                this.devices.delete(deviceId);
            }
        }
    }

    /**
     * Get device by ID
     */
    getDeviceById(deviceId) {
        return this.devices.get(deviceId);
    }

    /**
     * Get all connected devices
     */
    getConnectedDevices() {
        return Array.from(this.connectedDevices).map(id => this.devices.get(id)).filter(Boolean);
    }

    /**
     * Execute ADB command for specific device
     */
    async executeCommand(deviceId, command, args = [], options = {}) {
        if (!this.isInitialized) {
            throw new Error('ADB not initialized');
        }

        const commandId = this.commandIdCounter++;
        const fullArgs = deviceId ? ['-s', deviceId, ...command, ...args] : [...command, ...args];
        
        return new Promise((resolve, reject) => {
            const process = spawn(this.adbPath, fullArgs, {
                stdio: 'pipe',
                timeout: options.timeout || 30000,
                ...options.spawnOptions
            });

            let output = '';
            let errorOutput = '';

            if (process.stdout) {
                process.stdout.on('data', (data) => {
                    output += data.toString();
                    if (options.onData) {
                        options.onData(data);
                    }
                });
            }

            if (process.stderr) {
                process.stderr.on('data', (data) => {
                    errorOutput += data.toString();
                });
            }

            process.on('close', (code) => {
                this.activeCommands.delete(commandId);
                
                if (code === 0) {
                    resolve({
                        success: true,
                        output: output,
                        exitCode: code
                    });
                } else {
                    reject(new Error(`ADB command failed (exit code ${code}): ${errorOutput}`));
                }
            });

            process.on('error', (error) => {
                this.activeCommands.delete(commandId);
                reject(error);
            });

            this.activeCommands.set(commandId, process);
        });
    }

    /**
     * Take screenshot from device
     */
    async takeScreenshot(deviceId, options = {}) {
        if (!deviceId) {
            throw new Error('Device ID is required for screenshot');
        }

        try {
            const result = await this.executeCommand(
                deviceId,
                ['shell', 'screencap', '-p'],
                [],
                {
                    timeout: options.timeout || 10000,
                    spawnOptions: { encoding: null } // Binary data
                }
            );

            // Convert screenshot data
            const screenshotData = Buffer.from(result.output, 'binary');
            
            // Emit screenshot event
            this.emit('screenshot-captured', {
                deviceId,
                data: screenshotData,
                size: screenshotData.length,
                timestamp: Date.now()
            });

            return {
                success: true,
                data: screenshotData,
                size: screenshotData.length,
                format: 'png',
                deviceId
            };
        } catch (error) {
            throw new Error(`Screenshot failed for device ${deviceId}: ${error.message}`);
        }
    }

    /**
     * Get device display information
     */
    async getDisplayInfo(deviceId) {
        try {
            const result = await this.executeCommand(
                deviceId,
                ['shell', 'wm', 'size']
            );

            // Parse display size
            const sizeMatch = result.output.match(/Physical size: (\d+)x(\d+)/);
            const width = sizeMatch ? parseInt(sizeMatch[1]) : null;
            const height = sizeMatch ? parseInt(sizeMatch[2]) : null;

            // Get density
            const densityResult = await this.executeCommand(
                deviceId,
                ['shell', 'wm', 'density']
            );
            
            const densityMatch = densityResult.output.match(/Physical density: (\d+)/);
            const density = densityMatch ? parseInt(densityMatch[1]) : null;

            return {
                width,
                height,
                density,
                aspectRatio: width && height ? (width / height).toFixed(2) : null
            };
        } catch (error) {
            throw new Error(`Failed to get display info for device ${deviceId}: ${error.message}`);
        }
    }

    /**
     * Start device monitoring
     */
    startDeviceMonitoring() {
        if (this.reconnectionTimer) {
            clearInterval(this.reconnectionTimer);
        }

        this.reconnectionTimer = setInterval(async () => {
            try {
                await this.getDevices();
            } catch (error) {
                console.error('[ADB] Device monitoring error:', error.message);
                this.emit('monitoring-error', error);
            }
        }, this.reconnectionInterval);

        this.emit('monitoring-started');
    }

    /**
     * Stop device monitoring
     */
    stopDeviceMonitoring() {
        if (this.reconnectionTimer) {
            clearInterval(this.reconnectionTimer);
            this.reconnectionTimer = null;
        }

        this.emit('monitoring-stopped');
    }

    /**
     * Kill all active ADB commands
     */
    killAllCommands() {
        for (const [commandId, process] of this.activeCommands) {
            try {
                process.kill('SIGTERM');
                console.log(`[ADB] Killed command ${commandId}`);
            } catch (error) {
                console.error(`[ADB] Failed to kill command ${commandId}:`, error.message);
            }
        }
        this.activeCommands.clear();
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        this.stopDeviceMonitoring();
        this.killAllCommands();
        this.devices.clear();
        this.connectedDevices.clear();
        this.removeAllListeners();
    }

    /**
     * Get ADB version
     */
    async getVersion() {
        if (!this.isInitialized) {
            throw new Error('ADB not initialized');
        }

        try {
            const result = await this.executeCommand(null, ['version']);
            return result.output.trim();
        } catch (error) {
            throw new Error(`Failed to get ADB version: ${error.message}`);
        }
    }

    /**
     * Check if device is authorized
     */
    async isDeviceAuthorized(deviceId) {
        const device = this.getDeviceById(deviceId);
        return device && device.status === 'device';
    }

    /**
     * Wait for device to be ready
     */
    async waitForDevice(deviceId, timeout = 30000) {
        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const checkDevice = async () => {
                try {
                    if (await this.isDeviceAuthorized(deviceId)) {
                        resolve(true);
                        return;
                    }
                } catch (error) {
                    // Continue checking
                }
                
                if (Date.now() - startTime > timeout) {
                    reject(new Error(`Timeout waiting for device ${deviceId}`));
                    return;
                }
                
                setTimeout(checkDevice, 1000);
            };
            
            checkDevice();
        });
    }
}

module.exports = ADBManager;