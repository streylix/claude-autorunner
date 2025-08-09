/**
 * Screenshot Engine - Real-time screenshot capture and management system
 * Integrates with ADB for device screen capture and provides image management
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const EventEmitter = require('events');

class ScreenshotEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            // Capture settings
            captureInterval: options.captureInterval || 1000, // ms between captures
            maxConcurrentCaptures: options.maxConcurrentCaptures || 3,
            compressionQuality: options.compressionQuality || 80, // 1-100
            
            // Storage settings
            outputDir: options.outputDir || path.join(__dirname, '../../imported-files'),
            maxStoredScreenshots: options.maxStoredScreenshots || 50,
            autoCleanup: options.autoCleanup !== false,
            
            // Device settings
            deviceId: options.deviceId || null, // null = first available device
            adbPath: options.adbPath || 'adb',
            
            // Performance settings
            debounceTime: options.debounceTime || 500, // ms to wait after action
            maxRetries: options.maxRetries || 3,
            
            // Auto-screenshot settings
            autoScreenshotEnabled: options.autoScreenshotEnabled || false,
            actionDetectionTimeout: options.actionDetectionTimeout || 2000
        };
        
        this.state = {
            isCapturing: false,
            isInitialized: false,
            deviceConnected: false,
            captureQueue: [],
            activeCaptureProcesses: 0,
            lastCaptureTime: 0,
            screenshotCount: 0,
            errors: []
        };
        
        this.screenshots = new Map(); // id -> screenshot data
        this.actionTimers = new Map(); // terminal -> timer
        
        // Bind methods
        this.capture = this.capture.bind(this);
        this.cleanup = this.cleanup.bind(this);
    }
    
    /**
     * Initialize the screenshot engine
     */
    async initialize() {
        try {
            // Ensure output directory exists
            await fs.mkdir(this.options.outputDir, { recursive: true });
            
            // Check ADB availability
            const adbAvailable = await this.checkAdbAvailability();
            if (!adbAvailable) {
                throw new Error('ADB not found. Please install Android SDK or add adb to PATH');
            }
            
            // Check for connected devices
            const devices = await this.getConnectedDevices();
            if (devices.length === 0) {
                this.emit('warning', 'No ADB devices connected');
                this.state.deviceConnected = false;
            } else {
                this.state.deviceConnected = true;
                this.emit('deviceConnected', devices[0]);
            }
            
            this.state.isInitialized = true;
            this.emit('initialized');
            
            return true;
        } catch (error) {
            this.state.errors.push({
                timestamp: Date.now(),
                error: error.message,
                type: 'initialization'
            });
            this.emit('error', error);
            return false;
        }
    }
    
    /**
     * Check if ADB is available in system PATH
     */
    async checkAdbAvailability() {
        return new Promise((resolve) => {
            const adb = spawn(this.options.adbPath, ['version'], { stdio: 'pipe' });
            
            let output = '';
            adb.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            adb.on('close', (code) => {
                resolve(code === 0 && output.includes('Android Debug Bridge'));
            });
            
            adb.on('error', () => {
                resolve(false);
            });
        });
    }
    
    /**
     * Get list of connected ADB devices
     */
    async getConnectedDevices() {
        return new Promise((resolve, reject) => {
            const adb = spawn(this.options.adbPath, ['devices'], { stdio: 'pipe' });
            
            let output = '';
            adb.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            adb.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error('Failed to list ADB devices'));
                    return;
                }
                
                const devices = [];
                const lines = output.split('\n');
                
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line && !line.startsWith('*')) {
                        const [deviceId, status] = line.split('\t');
                        if (status === 'device') {
                            devices.push({
                                id: deviceId,
                                status: status
                            });
                        }
                    }
                }
                
                resolve(devices);
            });
            
            adb.on('error', reject);
        });
    }
    
    /**
     * Start continuous screenshot capture
     */
    async startCapture() {
        if (this.state.isCapturing) {
            return false;
        }
        
        if (!this.state.isInitialized) {
            await this.initialize();
        }
        
        if (!this.state.deviceConnected) {
            throw new Error('No device connected for screenshot capture');
        }
        
        this.state.isCapturing = true;
        this.emit('captureStarted');
        
        // Start capture loop
        this.captureLoop();
        
        return true;
    }
    
    /**
     * Stop continuous screenshot capture
     */
    stopCapture() {
        this.state.isCapturing = false;
        this.emit('captureStopped');
    }
    
    /**
     * Main capture loop for continuous screenshots
     */
    async captureLoop() {
        while (this.state.isCapturing) {
            try {
                const now = Date.now();
                const timeSinceLastCapture = now - this.state.lastCaptureTime;
                
                if (timeSinceLastCapture >= this.options.captureInterval &&
                    this.state.activeCaptureProcesses < this.options.maxConcurrentCaptures) {
                    
                    this.captureScreenshot('continuous');
                }
                
                // Wait before next iteration
                await this.sleep(Math.min(100, this.options.captureInterval / 10));
                
            } catch (error) {
                this.emit('error', error);
                // Continue loop even on error
                await this.sleep(1000);
            }
        }
    }
    
    /**
     * Capture a single screenshot
     */
    async capture(type = 'manual') {
        return await this.captureScreenshot(type);
    }
    
    /**
     * Internal screenshot capture method
     */
    async captureScreenshot(type = 'manual') {
        if (this.state.activeCaptureProcesses >= this.options.maxConcurrentCaptures) {
            this.emit('captureBusy', { type, reason: 'too_many_active' });
            return null;
        }
        
        this.state.activeCaptureProcesses++;
        const captureId = `screenshot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        try {
            const timestamp = Date.now();
            const filename = `screenshot_${timestamp}.png`;
            const filepath = path.join(this.options.outputDir, filename);
            
            // Execute ADB screencap command
            const success = await this.executeScreencap(filepath);
            
            if (success) {
                // Get file stats
                const stats = await fs.stat(filepath);
                
                const screenshotData = {
                    id: captureId,
                    filename: filename,
                    filepath: filepath,
                    relativePath: `./imported-files/${filename}`,
                    timestamp: timestamp,
                    type: type,
                    size: stats.size,
                    order: this.state.screenshotCount++
                };
                
                this.screenshots.set(captureId, screenshotData);
                this.state.lastCaptureTime = timestamp;
                
                // Emit success event
                this.emit('screenshotCaptured', screenshotData);
                
                // Auto-cleanup if enabled
                if (this.options.autoCleanup && this.screenshots.size > this.options.maxStoredScreenshots) {
                    await this.cleanupOldScreenshots();
                }
                
                return screenshotData;
            } else {
                throw new Error('ADB screencap command failed');
            }
            
        } catch (error) {
            this.state.errors.push({
                timestamp: Date.now(),
                error: error.message,
                type: 'capture',
                captureType: type
            });
            
            this.emit('captureError', { captureId, error, type });
            return null;
            
        } finally {
            this.state.activeCaptureProcesses--;
        }
    }
    
    /**
     * Execute ADB screencap command
     */
    async executeScreencap(outputPath) {
        return new Promise((resolve) => {
            const args = ['exec-out', 'screencap', '-p'];
            
            if (this.options.deviceId) {
                args.unshift('-s', this.options.deviceId);
            }
            
            const adb = spawn(this.options.adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            
            // Create write stream for output
            const writeStream = require('fs').createWriteStream(outputPath);
            
            adb.stdout.pipe(writeStream);
            
            let stderrData = '';
            adb.stderr.on('data', (data) => {
                stderrData += data.toString();
            });
            
            adb.on('close', (code) => {
                writeStream.end();
                
                if (code === 0) {
                    resolve(true);
                } else {
                    console.error('ADB screencap error:', stderrData);
                    resolve(false);
                }
            });
            
            adb.on('error', (error) => {
                console.error('ADB spawn error:', error);
                writeStream.end();
                resolve(false);
            });
        });
    }
    
    /**
     * Enable auto-screenshot after terminal actions
     */
    enableAutoScreenshot(terminalId) {
        this.options.autoScreenshotEnabled = true;
        this.emit('autoScreenshotEnabled', { terminalId });
    }
    
    /**
     * Disable auto-screenshot
     */
    disableAutoScreenshot() {
        this.options.autoScreenshotEnabled = false;
        // Clear any pending timers  
        this.actionTimers.forEach(timer => clearTimeout(timer));
        this.actionTimers.clear();
        this.emit('autoScreenshotDisabled');
    }
    
    /**
     * Trigger auto-screenshot after terminal action
     */
    onTerminalAction(terminalId, actionType = 'unknown') {
        if (!this.options.autoScreenshotEnabled) {
            return;
        }
        
        // Clear existing timer for this terminal
        if (this.actionTimers.has(terminalId)) {
            clearTimeout(this.actionTimers.get(terminalId));
        }
        
        // Set new timer for delayed screenshot
        const timer = setTimeout(async () => {
            try {
                const screenshot = await this.capture('auto');
                if (screenshot) {
                    this.emit('autoScreenshotCaptured', { 
                        screenshot, 
                        terminalId, 
                        actionType 
                    });
                }
            } catch (error) {
                this.emit('autoScreenshotError', { error, terminalId, actionType });
            } finally {
                this.actionTimers.delete(terminalId);
            }
        }, this.options.debounceTime);
        
        this.actionTimers.set(terminalId, timer);
        
        this.emit('autoScreenshotScheduled', { terminalId, actionType });
    }
    
    /**
     * Get all captured screenshots
     */
    getAllScreenshots() {
        return Array.from(this.screenshots.values()).sort((a, b) => b.timestamp - a.timestamp);
    }
    
    /**
     * Get screenshot by ID
     */
    getScreenshot(id) {
        return this.screenshots.get(id);
    }
    
    /**
     * Delete screenshot
     */
    async deleteScreenshot(id) {
        const screenshot = this.screenshots.get(id);
        if (!screenshot) {
            return false;
        }
        
        try {
            // Delete file
            await fs.unlink(screenshot.filepath);
            
            // Remove from memory
            this.screenshots.delete(id);
            
            this.emit('screenshotDeleted', { id, screenshot });
            return true;
            
        } catch (error) {
            this.emit('deleteError', { id, error });
            return false;
        }
    }
    
    /**
     * Reorder screenshots
     */
    reorderScreenshots(newOrder) {
        // newOrder should be array of screenshot IDs in desired order
        newOrder.forEach((id, index) => {
            const screenshot = this.screenshots.get(id);
            if (screenshot) {
                screenshot.order = index;
            }
        });
        
        this.emit('screenshotsReordered', newOrder);
    }
    
    /**
     * Clean up old screenshots
     */
    async cleanupOldScreenshots() {
        const screenshots = this.getAllScreenshots();
        const toDelete = screenshots.slice(this.options.maxStoredScreenshots);
        
        for (const screenshot of toDelete) {
            await this.deleteScreenshot(screenshot.id);
        }
        
        this.emit('cleanupCompleted', { deleted: toDelete.length });
    }
    
    /**
     * Export screenshots with preset data
     */
    async exportScreenshots(exportOptions = {}) {
        const screenshots = this.getAllScreenshots();
        const timestamp = Date.now();
        
        const exportData = {
            timestamp: timestamp,
            exportedAt: new Date().toISOString(),
            screenshots: screenshots.map(s => ({
                filename: s.filename,
                relativePath: s.relativePath,
                timestamp: s.timestamp,
                type: s.type,
                order: s.order
            })),
            metadata: {
                totalScreenshots: screenshots.length,
                captureSettings: this.options,
                deviceInfo: await this.getDeviceInfo()
            }
        };
        
        if (exportOptions.includeFiles) {
            // Copy screenshot files to export directory
            const exportDir = exportOptions.exportDir || path.join(this.options.outputDir, `export_${timestamp}`);
            await fs.mkdir(exportDir, { recursive: true });
            
            for (const screenshot of screenshots) {
                const destPath = path.join(exportDir, screenshot.filename);
                await fs.copyFile(screenshot.filepath, destPath);
            }
            
            exportData.exportDirectory = exportDir;
        }
        
        this.emit('screenshotsExported', exportData);
        return exportData;
    }
    
    /**
     * Get device information
     */
    async getDeviceInfo() {
        if (!this.state.deviceConnected) {
            return null;
        }
        
        try {
            const devices = await this.getConnectedDevices();
            return devices[0] || null;
        } catch (error) {
            return null;
        }
    }
    
    /**
     * Get current state and statistics
     */
    getState() {
        return {
            ...this.state,
            screenshotCount: this.screenshots.size,
            options: this.options,
            activeTimers: this.actionTimers.size
        };
    }
    
    /**
     * Clean up resources
     */
    async cleanup() {
        this.stopCapture();
        
        // Clear all timers
        this.actionTimers.forEach(timer => clearTimeout(timer));
        this.actionTimers.clear();
        
        // Optionally clean up screenshot files
        if (this.options.autoCleanup) {
            const screenshots = Array.from(this.screenshots.values());
            for (const screenshot of screenshots) {
                try {
                    await fs.unlink(screenshot.filepath);
                } catch (error) {
                    // Ignore cleanup errors
                }
            }
        }
        
        this.screenshots.clear();
        this.emit('cleanedUp');
    }
    
    /**
     * Utility function for async sleep
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = ScreenshotEngine;