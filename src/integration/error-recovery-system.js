/**
 * Error Handling and Recovery System for Scratch Preset Builder
 * Provides comprehensive error management and graceful degradation
 */

class ErrorRecoverySystem {
    constructor() {
        this.errorHandlers = new Map();
        this.recoveryStrategies = new Map();
        this.errorHistory = [];
        this.maxErrorHistory = 100;
        this.retryAttempts = new Map();
        this.maxRetryAttempts = 3;
        this.circuitBreakers = new Map();
        
        this.initializeDefaultHandlers();
    }

    /**
     * Initialize default error handlers and recovery strategies
     */
    initializeDefaultHandlers() {
        // ADB Connection Errors
        this.registerErrorHandler('ADB_DISCONNECTED', {
            severity: 'high',
            handler: async (errorRecord) => await this.handleAdbDisconnection(errorRecord),
            recovery: async (errorRecord) => await this.recoverAdbConnection(errorRecord),
            fallback: async (errorRecord) => await this.fallbackToManualMode(errorRecord)
        });

        // Screenshot Capture Errors
        this.registerErrorHandler('SCREENSHOT_FAILED', {
            severity: 'medium',
            handler: async (errorRecord) => await this.handleScreenshotFailure(errorRecord),
            recovery: async (errorRecord) => await this.retryScreenshotCapture(errorRecord),
            fallback: async (errorRecord) => await this.skipScreenshotStep(errorRecord)
        });

        // Recording Engine Errors
        this.registerErrorHandler('RECORDING_FAILED', {
            severity: 'high',
            handler: async (errorRecord) => await this.handleRecordingFailure(errorRecord),
            recovery: async (errorRecord) => await this.restartRecordingEngine(errorRecord),
            fallback: async (errorRecord) => await this.savePartialRecording(errorRecord)
        });

        // Export System Errors
        this.registerErrorHandler('EXPORT_FAILED', {
            severity: 'medium',
            handler: async (errorRecord) => await this.handleExportFailure(errorRecord),
            recovery: async (errorRecord) => await this.retryExport(errorRecord),
            fallback: async (errorRecord) => await this.exportBasicFormat(errorRecord)
        });

        // Device Detection Errors
        this.registerErrorHandler('DEVICE_NOT_FOUND', {
            severity: 'high',
            handler: async (errorRecord) => await this.handleDeviceNotFound(errorRecord),
            recovery: async (errorRecord) => await this.scanForDevices(errorRecord),
            fallback: async (errorRecord) => await this.showDeviceSetupGuide(errorRecord)
        });

        // Memory/Performance Errors
        this.registerErrorHandler('MEMORY_EXCEEDED', {
            severity: 'high',
            handler: async (errorRecord) => await this.handleMemoryExceeded(errorRecord),
            recovery: async (errorRecord) => await this.freeMemoryResources(errorRecord),
            fallback: async (errorRecord) => await this.reduceQuality(errorRecord)
        });

        // Network/Permission Errors
        this.registerErrorHandler('PERMISSION_DENIED', {
            severity: 'medium',
            handler: async (errorRecord) => await this.handlePermissionDenied(errorRecord),
            recovery: async (errorRecord) => await this.requestPermissions(errorRecord),
            fallback: async (errorRecord) => await this.showPermissionGuide(errorRecord)
        });
    }

    /**
     * Register custom error handler
     */
    registerErrorHandler(errorType, config) {
        this.errorHandlers.set(errorType, {
            severity: config.severity || 'medium',
            handler: config.handler,
            recovery: config.recovery,
            fallback: config.fallback,
            maxRetries: config.maxRetries || this.maxRetryAttempts,
            cooldownTime: config.cooldownTime || 5000 // 5 seconds
        });
    }

    /**
     * Handle error with automatic recovery attempts
     */
    async handleError(errorType, errorData, context = {}) {
        const timestamp = new Date().toISOString();
        const errorId = `${errorType}_${Date.now()}`;
        
        // Log error
        const errorRecord = {
            id: errorId,
            type: errorType,
            data: errorData,
            context: context,
            timestamp: timestamp,
            handled: false,
            recovered: false,
            attempts: 0
        };

        this.addToErrorHistory(errorRecord);
        
        console.error(`🚨 Error occurred: ${errorType}`, errorData);

        // Check if we have a handler for this error type
        const handler = this.errorHandlers.get(errorType);
        if (!handler) {
            console.warn(`⚠️ No handler registered for error type: ${errorType}`);
            return this.handleUnknownError(errorRecord);
        }

        // Check circuit breaker
        if (this.isCircuitBreakerOpen(errorType)) {
            console.warn(`🔌 Circuit breaker open for ${errorType}, using fallback immediately`);
            return await this.executeFallback(handler, errorRecord);
        }

        try {
            // Execute primary error handler
            await handler.handler(errorRecord);
            errorRecord.handled = true;

            // Attempt recovery
            const recoveryResult = await this.attemptRecovery(handler, errorRecord);
            
            if (recoveryResult.success) {
                errorRecord.recovered = true;
                this.resetRetryCount(errorType);
                console.log(`✅ Successfully recovered from ${errorType}`);
                return { success: true, errorId: errorId, recovered: true };
            } else {
                // Recovery failed, try fallback
                const fallbackResult = await this.executeFallback(handler, errorRecord);
                return { success: fallbackResult.success, errorId: errorId, usedFallback: true };
            }

        } catch (handlerError) {
            console.error(`💥 Error handler itself failed for ${errorType}:`, handlerError);
            errorRecord.handlerError = handlerError.message;
            
            // Try fallback as last resort
            const fallbackResult = await this.executeFallback(handler, errorRecord);
            return { success: fallbackResult.success, errorId: errorId, handlerFailed: true };
        }
    }

    /**
     * Attempt recovery with retry logic
     */
    async attemptRecovery(handler, errorRecord) {
        const errorType = errorRecord.type;
        const currentAttempts = this.getRetryCount(errorType);
        
        if (currentAttempts >= handler.maxRetries) {
            console.warn(`⚠️ Max retry attempts (${handler.maxRetries}) reached for ${errorType}`);
            this.openCircuitBreaker(errorType);
            return { success: false, reason: 'max_retries_exceeded' };
        }

        try {
            this.incrementRetryCount(errorType);
            errorRecord.attempts = currentAttempts + 1;
            
            console.log(`🔄 Attempting recovery for ${errorType} (attempt ${errorRecord.attempts}/${handler.maxRetries})`);
            
            const recoveryResult = await handler.recovery(errorRecord);
            
            if (recoveryResult && recoveryResult.success) {
                console.log(`✅ Recovery successful for ${errorType}`);
                return { success: true };
            } else {
                console.warn(`❌ Recovery failed for ${errorType}:`, recoveryResult?.error || 'Unknown error');
                return { success: false, reason: recoveryResult?.error || 'recovery_failed' };
            }
            
        } catch (recoveryError) {
            console.error(`💥 Recovery attempt failed for ${errorType}:`, recoveryError);
            return { success: false, reason: recoveryError.message };
        }
    }

    /**
     * Execute fallback strategy
     */
    async executeFallback(handler, errorRecord) {
        try {
            console.log(`🔄 Executing fallback for ${errorRecord.type}`);
            
            const fallbackResult = await handler.fallback(errorRecord);
            
            if (fallbackResult && fallbackResult.success) {
                console.log(`✅ Fallback successful for ${errorRecord.type}`);
                errorRecord.fallbackUsed = true;
                return { success: true };
            } else {
                console.error(`❌ Fallback failed for ${errorRecord.type}:`, fallbackResult?.error);
                return { success: false, reason: fallbackResult?.error || 'fallback_failed' };
            }
            
        } catch (fallbackError) {
            console.error(`💥 Fallback execution failed for ${errorRecord.type}:`, fallbackError);
            return { success: false, reason: fallbackError.message };
        }
    }

    /**
     * Specific Error Handlers
     */

    // ADB Disconnection Handler
    async handleAdbDisconnection(errorRecord) {
        console.log('🔌 Handling ADB disconnection...');
        
        // Stop any ongoing operations
        this.pauseAllOperations();
        
        // Show user notification
        this.showErrorNotification('ADB Connection Lost', 
            'The Android Debug Bridge connection was lost. Attempting to reconnect...');
        
        errorRecord.context.operationsPaused = true;
    }

    async recoverAdbConnection(errorRecord) {
        try {
            // Attempt to restart ADB
            console.log('🔄 Attempting to restart ADB...');
            
            // In a real implementation, this would execute ADB commands
            // For now, simulate the recovery process
            await this.simulateAdbRestart();
            
            // Check if devices are now available
            await this.simulateDeviceDetection();
            
            // Resume operations if successful
            this.resumeAllOperations();
            
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async fallbackToManualMode(errorRecord) {
        console.log('📱 Falling back to manual mode...');
        
        // Show manual setup instructions
        this.showManualSetupInstructions();
        
        return { success: true, mode: 'manual' };
    }

    // Screenshot Failure Handler
    async handleScreenshotFailure(errorRecord) {
        console.log('📸 Handling screenshot failure...');
        
        const screenshotData = errorRecord.data;
        
        // Check if it's a temporary failure or persistent issue
        if (screenshotData && screenshotData.retryable !== false) {
            errorRecord.context.canRetry = true;
        }
        
        // Show user notification
        this.showErrorNotification('Screenshot Failed', 
            'Failed to capture screenshot. This may be due to device permissions or connectivity issues.');
    }

    async retryScreenshotCapture(errorRecord) {
        try {
            console.log('📸 Retrying screenshot capture...');
            
            // Wait a moment before retry
            await this.sleep(1000);
            
            // Simulate screenshot capture retry
            const retryResult = await this.simulateScreenshotCapture();
            
            if (retryResult.success) {
                return { success: true, screenshot: retryResult.screenshot };
            } else {
                return { success: false, error: retryResult.error };
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async skipScreenshotStep(errorRecord) {
        console.log('⏭️ Skipping screenshot step...');
        
        // Continue recording without screenshot
        this.showInfoNotification('Screenshot Skipped', 
            'Continuing recording without screenshot for this step.');
        
        return { success: true, skipped: true };
    }

    // Recording Failure Handler
    async handleRecordingFailure(errorRecord) {
        console.log('🎥 Handling recording failure...');
        
        // Save what we have so far
        await this.savePartialRecording(errorRecord);
        
        this.showErrorNotification('Recording Failed', 
            'Recording encountered an error. Partial recording has been saved.');
    }

    async restartRecordingEngine(errorRecord) {
        try {
            console.log('🔄 Restarting recording engine...');
            
            // Stop current recording
            await this.stopCurrentRecording();
            
            // Reinitialize recording engine
            await this.initializeRecordingEngine();
            
            // Resume recording
            const resumeResult = await this.resumeRecording(errorRecord.context);
            
            return { success: resumeResult.success };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async savePartialRecording(errorRecord) {
        try {
            console.log('💾 Saving partial recording...');
            
            const partialData = {
                recording: errorRecord.context.recordingData || {},
                actions: errorRecord.context.actions || [],
                screenshots: errorRecord.context.screenshots || [],
                timestamp: new Date().toISOString(),
                incomplete: true,
                error: errorRecord.data
            };
            
            // Save to storage
            await this.saveToStorage('partial_recording', partialData);
            
            return { success: true, saved: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Export Failure Handler
    async handleExportFailure(errorRecord) {
        console.log('📤 Handling export failure...');
        
        this.showErrorNotification('Export Failed', 
            'Failed to export preset. Attempting recovery...');
    }

    async retryExport(errorRecord) {
        try {
            console.log('🔄 Retrying export...');
            
            // Get original export data
            const exportData = errorRecord.context.exportData;
            
            // Retry export with same data
            const retryResult = await this.simulateExport(exportData);
            
            return { success: retryResult.success, result: retryResult };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async exportBasicFormat(errorRecord) {
        try {
            console.log('📋 Exporting in basic format...');
            
            // Export in simplified JSON format
            const basicExport = {
                format: 'basic_json',
                data: errorRecord.context.exportData,
                timestamp: new Date().toISOString(),
                note: 'Exported in basic format due to error'
            };
            
            return { success: true, export: basicExport };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    // Device Detection Failure Handler
    async handleDeviceNotFound(errorRecord) {
        console.log('📱 Handling device not found...');
        
        this.showErrorNotification('Device Not Found', 
            'No Android devices detected. Please check USB debugging is enabled.');
    }

    async scanForDevices(errorRecord) {
        try {
            console.log('🔍 Scanning for devices...');
            
            // Simulate device scan
            const scanResult = await this.simulateDeviceScan();
            
            return { success: scanResult.devicesFound > 0, devices: scanResult.devices };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async showDeviceSetupGuide(errorRecord) {
        console.log('📖 Showing device setup guide...');
        
        // Show comprehensive setup instructions
        this.showSetupGuide();
        
        return { success: true, guide: 'shown' };
    }

    // Memory/Performance Error Handler
    async handleMemoryExceeded(errorRecord) {
        console.log('🧠 Handling memory exceeded...');
        
        this.showWarningNotification('Memory Warning', 
            'Memory usage is high. Optimizing performance...');
    }

    async freeMemoryResources(errorRecord) {
        try {
            console.log('🧹 Freeing memory resources...');
            
            // Clear caches
            this.clearCaches();
            
            // Reduce screenshot quality
            this.reduceScreenshotQuality();
            
            // Limit action history
            this.limitActionHistory();
            
            return { success: true, optimized: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async reduceQuality(errorRecord) {
        console.log('📉 Reducing quality settings...');
        
        // Lower screenshot resolution
        // Reduce action frequency
        // Simplify export format
        
        return { success: true, qualityReduced: true };
    }

    /**
     * Circuit Breaker Pattern Implementation
     */
    openCircuitBreaker(errorType) {
        const breakerData = {
            opened: Date.now(),
            cooldownTime: this.errorHandlers.get(errorType)?.cooldownTime || 5000
        };
        
        this.circuitBreakers.set(errorType, breakerData);
        console.log(`🔌 Circuit breaker opened for ${errorType} for ${breakerData.cooldownTime}ms`);
        
        // Auto-close after cooldown
        setTimeout(() => {
            this.closeCircuitBreaker(errorType);
        }, breakerData.cooldownTime);
    }

    closeCircuitBreaker(errorType) {
        this.circuitBreakers.delete(errorType);
        console.log(`🔌 Circuit breaker closed for ${errorType}`);
    }

    isCircuitBreakerOpen(errorType) {
        return this.circuitBreakers.has(errorType);
    }

    /**
     * Retry Management
     */
    getRetryCount(errorType) {
        return this.retryAttempts.get(errorType) || 0;
    }

    incrementRetryCount(errorType) {
        const current = this.getRetryCount(errorType);
        this.retryAttempts.set(errorType, current + 1);
    }

    resetRetryCount(errorType) {
        this.retryAttempts.delete(errorType);
    }

    /**
     * Error History Management
     */
    addToErrorHistory(errorRecord) {
        this.errorHistory.push(errorRecord);
        
        // Keep history within limits
        if (this.errorHistory.length > this.maxErrorHistory) {
            this.errorHistory.shift();
        }
    }

    getErrorHistory(errorType = null) {
        if (errorType) {
            return this.errorHistory.filter(error => error.type === errorType);
        }
        return [...this.errorHistory];
    }

    getErrorStatistics() {
        const stats = {
            total: this.errorHistory.length,
            byType: {},
            byTimePeriod: {
                lastHour: 0,
                last24Hours: 0,
                lastWeek: 0
            },
            recoveryRate: 0,
            fallbackRate: 0
        };

        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        const oneDay = 24 * oneHour;
        const oneWeek = 7 * oneDay;

        let recovered = 0;
        let fallbackUsed = 0;

        for (const error of this.errorHistory) {
            // Count by type
            stats.byType[error.type] = (stats.byType[error.type] || 0) + 1;
            
            // Count by time period
            const errorTime = new Date(error.timestamp).getTime();
            const timeDiff = now - errorTime;
            
            if (timeDiff <= oneHour) stats.byTimePeriod.lastHour++;
            if (timeDiff <= oneDay) stats.byTimePeriod.last24Hours++;
            if (timeDiff <= oneWeek) stats.byTimePeriod.lastWeek++;
            
            // Count recovery and fallback usage
            if (error.recovered) recovered++;
            if (error.fallbackUsed) fallbackUsed++;
        }

        if (this.errorHistory.length > 0) {
            stats.recoveryRate = Math.round((recovered / this.errorHistory.length) * 100);
            stats.fallbackRate = Math.round((fallbackUsed / this.errorHistory.length) * 100);
        }

        return stats;
    }

    /**
     * Utility Methods for Error Handling
     */
    async handleUnknownError(errorRecord) {
        console.error('❓ Unknown error type:', errorRecord.type);
        
        // Log for analysis
        this.logUnknownError(errorRecord);
        
        // Show generic error message
        this.showErrorNotification('Unknown Error', 
            `An unexpected error occurred: ${errorRecord.type}`);
        
        return { success: false, reason: 'unknown_error_type' };
    }

    pauseAllOperations() {
        console.log('⏸️ Pausing all operations...');
        // Implementation would pause recording, screenshot capture, etc.
    }

    resumeAllOperations() {
        console.log('▶️ Resuming all operations...');
        // Implementation would resume paused operations
    }

    showErrorNotification(title, message) {
        console.error(`🚨 ${title}: ${message}`);
        // In a real implementation, this would show UI notifications
    }

    showWarningNotification(title, message) {
        console.warn(`⚠️ ${title}: ${message}`);
    }

    showInfoNotification(title, message) {
        console.info(`ℹ️ ${title}: ${message}`);
    }

    showManualSetupInstructions() {
        console.log('📖 Showing manual setup instructions...');
        // Would show UI with setup instructions
    }

    showSetupGuide() {
        console.log('📚 Showing device setup guide...');
        // Would show comprehensive device setup guide
    }

    /**
     * Simulation Methods (for testing)
     */
    async simulateAdbRestart() {
        await this.sleep(2000);
        return { success: Math.random() > 0.3 }; // 70% success rate
    }

    async simulateDeviceDetection() {
        await this.sleep(1000);
        return { devices: Math.random() > 0.5 ? ['test_device'] : [] };
    }

    async simulateScreenshotCapture() {
        await this.sleep(500);
        return { 
            success: Math.random() > 0.2, // 80% success rate
            screenshot: { id: 'test_screenshot', path: '/tmp/test.png' }
        };
    }

    async simulateExport(data) {
        await this.sleep(1000);
        return { success: Math.random() > 0.1 }; // 90% success rate
    }

    async simulateDeviceScan() {
        await this.sleep(3000);
        return { 
            devicesFound: Math.random() > 0.4 ? 1 : 0,
            devices: Math.random() > 0.4 ? ['scanned_device'] : []
        };
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async saveToStorage(key, data) {
        // Mock storage implementation
        console.log(`💾 Saving to storage: ${key}`, data);
        return true;
    }

    clearCaches() {
        console.log('🧹 Clearing caches...');
    }

    reduceScreenshotQuality() {
        console.log('📉 Reducing screenshot quality...');
    }

    limitActionHistory() {
        console.log('📝 Limiting action history...');
    }

    logUnknownError(errorRecord) {
        console.log('📝 Logging unknown error for analysis:', errorRecord);
    }

    async stopCurrentRecording() {
        console.log('⏹️ Stopping current recording...');
    }

    async initializeRecordingEngine() {
        console.log('🎬 Initializing recording engine...');
    }

    async resumeRecording(context) {
        console.log('▶️ Resuming recording...');
        return { success: true };
    }
}

// Export for use in different environments
if (typeof window !== 'undefined') {
    window.ErrorRecoverySystem = ErrorRecoverySystem;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = ErrorRecoverySystem;
}